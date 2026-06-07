# 云汀智家服务端数据库架构设计

## 1. 结论

当前服务端不是“每种智能设备一个独立数据库”，也不是“小程序本地把设备写入一个大库”。

当前实现是：

```text
一个服务端 SQLite 数据库
  ├─ 用户、验证码、会话、微信身份表
  ├─ 统一设备台账表 device_registry
  ├─ 设备密钥表 device_keys
  ├─ 配网会话表 device_provision_sessions
  ├─ 防重放表 device_message_nonces
  ├─ 绑定事件与绑定失败风控表
  ├─ 设备指令表 device_commands
  └─ 管理员审计表 admin_audit_events
```

也就是说，当前是“一个数据库，多张业务表”。所有设备类型先进入统一设备台账 `device_registry`，通过 `device_type` / `type_code` 区分设备类型。用户和设备之间的当前绑定关系通过 `device_registry.owner_user_id -> users.id` 表达。

MVP 阶段暂不为每种设备单独建一个数据库，也不为浇水设备、灯控、插座分别创建完全独立的库。原因是：

1. 设备绑定、在线状态、密钥、防重放、配网会话、指令 ACK 等逻辑对所有智能设备都是通用的。
2. 统一设备台账便于按用户、设备号、设备类型、在线状态做查询。
3. 当前规模和阶段适合用 SQLite 单库多表，部署和备份简单。
4. 设备类型差异先放在 JSON 快照或后续“设备专项扩展表”中，避免过早拆分导致复杂度上升。

## 2. 当前数据库物理形态

当前数据库由 FastAPI 服务端使用 SQLite 文件保存。路径由环境变量 `YT_DATABASE_PATH` 控制，默认：

```text
./data/yunting.db
```

部署到服务器后，所有表都在这个 SQLite 文件中。服务端通过 `server/yt_smart_home_server/app/database.py` 初始化表结构，并在启动时执行兼容旧库的轻量迁移。

当前数据库适合 MVP、小规模联调、内部测试和早期试点。后续设备数量、心跳频率、控制记录和管理员查询压力增加后，应迁移到 PostgreSQL / MySQL / 云数据库。

## 3. 当前表结构总览

| 表名 | 作用 | 是否当前已实现 | 说明 |
| --- | --- | --- | --- |
| `users` | 用户主表 | 是 | 手机号用户，一个手机号对应一个用户 |
| `sms_codes` | 短信验证码 | 是 | 保存验证码 hash、场景、过期时间、尝试次数 |
| `sessions` | 登录会话 | 是 | 只保存 `sessionToken` hash，不保存明文 token |
| `auth_events` | 登录/验证码事件 | 是 | 记录登录、发码等身份相关事件 |
| `user_openids` | 微信 OpenID 绑定 | 是 | 一个用户可绑定微信身份 |
| `device_registry` | 统一设备台账和当前状态 | 是 | 所有设备类型共用的一张核心设备表 |
| `device_keys` | 设备 AES 密钥 | 是 | 保存设备号、`keyId`、开发/生产设备密钥副本 |
| `device_provision_sessions` | 配网临时会话 | 是 | 小程序配网、设备上云认证、最终绑定之间的桥梁 |
| `device_message_nonces` | 设备消息防重放 | 是 | 记录 `deviceNo + nonce`，防止 AES-CCM 消息重放 |
| `device_bind_events` | 绑定/解绑事件 | 是 | 记录绑定成功、解绑、失败等事件证据 |
| `device_bind_attempts` | 绑定尝试和风控 | 是 | 记录失败次数，用于手机号绑定失败锁定 |
| `device_commands` | 设备控制指令 | 是 | 记录云端生成的设备指令和 ACK 状态 |
| `admin_audit_events` | 管理员审计 | 是 | 记录管理员查询、禁用、恢复、解绑等操作 |

## 4. 核心关系模型

### 4.1 用户与设备绑定关系

当前绑定关系不单独建 `user_device_bindings` 表，而是直接保存在 `device_registry`：

```text
users.id  <--- device_registry.owner_user_id
```

含义：

- `owner_user_id = NULL`：设备未绑定。
- `owner_user_id = users.id` 且 `bind_status = 'bound'`：设备属于该用户。
- 小程序调用 `device.list` 时，服务端查询：

```sql
SELECT * FROM device_registry WHERE owner_user_id = ?
```

优点：MVP 简单直接，设备当前归属查询快。

限制：如果后续需要多成员共享同一设备、家庭空间、转让历史、不同角色权限，应新增独立关系表，例如：

```text
device_bindings
  id
  device_no
  user_id
  role          -- owner / member / admin
  status        -- active / removed
  bound_at
  unbound_at
```

当前暂不需要，因为目前目标是一台设备只绑定一个主用户。

### 4.2 统一设备台账 `device_registry`

`device_registry` 是当前设备域的核心表。它不是某一种设备的专用表，而是所有设备类型共用的统一设备主表。

关键字段：

| 字段 | 说明 |
| --- | --- |
| `device_no` | 设备号，主键，例如 `YT-AW-00000-A324` |
| `type_code` | 设备类型码，例如 `AW`、`ES`、`LC`、`SP`、`GW` |
| `device_type` | 设备类型英文，例如 `watering`、`sensor`、`light` |
| `type_label` | 设备类型中文名称 |
| `name` | 用户自定义设备名称或默认名称 |
| `status` | 生产/注册状态，当前主要为 `registered`、`disabled` |
| `bind_status` | 绑定状态，`unbound` / `bound` |
| `owner_user_id` | 当前绑定用户 ID，外键到 `users.id` |
| `online` | 当前是否在线，0/1 |
| `display_status` | 展示状态，例如 `在线`、`离线`、`浇水中` |
| `config_json` | 当前设备配置快照，MVP 阶段 JSON 保存 |
| `heartbeat_interval_ms` | 设备心跳周期，入网配置时下发给设备 |
| `last_heartbeat_at` | 最近一次 `telemetry.report` 时间 |
| `last_boot_at` | 最近一次 `device.boot` 时间 |
| `last_status_at` | 最近一次 `device.status` 时间 |
| `last_seen_at` | 最近一次能证明设备在线的消息时间 |
| `last_telemetry_at` | 最近一次遥测时间 |
| `telemetry_json` | 最近一份遥测快照 JSON |
| `created_at` / `updated_at` | 创建/更新时间 |

当前在线/离线判定：

```text
如果设备 online = 1，但当前时间 - last_seen_at >= heartbeat_interval_ms * 2，
则服务端在 device.list / device.getStatus 查询前把它更新为离线。

如果后续收到 telemetry.report、device.boot 或在线 device.status，则恢复在线。
如果收到离线 device.status / MQTT Last Will，则立即置离线。
```

### 4.3 设备安全密钥 `device_keys`

`device_keys` 和 `device_registry` 是一对一或未来一对多的关系：

```text
device_registry.device_no  <--- device_keys.device_no
```

当前字段：

| 字段 | 说明 |
| --- | --- |
| `device_no` | 设备号 |
| `key_id` | 密钥版本，当前可为 `k1` |
| `device_key_hex` | 16 字节 AES key 的十六进制表示；当前测试台账使用 eFuse 默认全 0 key，即 `00000000000000000000000000000000`；生产应改为加密保存或接 KMS 的一机一随机密钥副本 |
| `status` | `active` / `disabled` |
| `created_at` / `updated_at` | 时间 |

说明：

- 当前测试设备未烧录正式 eFuse key 时，硬件 AES key slot 默认为全 0；服务端测试台账必须使用同一把全 0 key，否则 AES-CCM tag 校验会失败。
- 服务端保存密钥副本用于 AES-128-CCM 认证解密。
- 正式生产环境不应让明文密钥散落在日志、配置、小程序或二维码中。
- 后续换钥时，`device_keys` 可以改为 `(device_no, key_id)` 联合主键，允许同一设备存在多个密钥版本。

### 4.4 配网会话 `device_provision_sessions`

`device_provision_sessions` 连接三件事：

```text
用户 users.id
设备 device_registry.device_no
设备真实上云认证 provision.result
```

它解决的问题是：小程序不能仅凭设备号完成绑定，必须等真实设备完成 Wi‑Fi 入网并通过 AES-CCM 上报 `provision.result`。

状态流转：

```text
pending
  -> ready_to_bind    设备 AES-CCM provision.result 成功
  -> failed           设备上报配网失败
  -> expired          超时
ready_to_bind
  -> bound            小程序最终 device.bind 成功
  -> expired          超过绑定窗口未绑定
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `provisionSessionId` |
| `device_no` | 当前配网设备号 |
| `user_id` | 发起配网的用户 |
| `status` | `pending`、`ready_to_bind`、`failed`、`expired`、`bound` |
| `expires_at` | 会话过期时间 |
| `ready_at` | 设备通过认证上线时间 |
| `bound_at` | 最终绑定时间 |
| `last_online_at` | 设备本次配网中最近认证上线时间 |
| `auth_verified` | 是否已通过 AES-CCM 认证 |
| `report_json` | 设备上报的 `provision.result` 明文 payload 快照 |
| `dev_bypass` | 调试绕过标记，正式不应依赖 |

### 4.5 防重放 `device_message_nonces`

设备安全消息使用 `YTS-SEC/1` AES-128-CCM。服务端必须防止同一条消息被重复提交。

`device_message_nonces` 保存：

| 字段 | 说明 |
| --- | --- |
| `device_no` | 设备号 |
| `nonce` | base64url 编码 nonce |
| `msg_type` | 消息类型 |
| `seq` | 序号 |
| `created_at` | 接收时间 |

主键：

```text
(device_no, nonce)
```

如果同一设备再次提交相同 nonce，服务端返回 `DEVICE_REPLAY_DETECTED`。

### 4.6 指令记录 `device_commands`

`device_commands` 是控制闭环证据链，不是设备当前状态主表。

当前字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 指令 ID，也作为设备 ACK 的 `cmdId` |
| `device_no` | 目标设备 |
| `user_id` | 发起用户 |
| `command_type` | 指令类型，例如 `watering.config.set`、`watering.manual.start`、`watering.manual.stop` |
| `payload_json` | 指令业务参数 |
| `status` | `queued`、`sent`、`received`、`executing`、`succeeded`、`failed`、`expired`、`delivery_timeout`、`execution_timeout`、`publish_failed` |
| `created_at` | 创建时间 |
| `sent_at` | 通过 HTTPS pull 返回给设备或 MQTTS 发布时间 |
| `received_at` | 设备 ACK `received` 时间 |
| `executing_at` | 设备 ACK `executing` 时间 |
| `ack_at` | 终态 ACK 或超时时间 |
| `expires_at` | 指令过期时间 |
| `failed_reason` | 失败原因 |
| `result_code` | 设备结果码 |
| `result_json` | 设备 ACK 原始结果 |

MVP 阶段设备通过 HTTPS `device.secureMessage msgType=command.pull` 拉取最多 1 条命令；设备执行后通过 `command.ack` 独立上报状态。

### 4.7 遥测与故障数据当前保存方式

当前 MVP 没有单独创建 `device_telemetry` 历史表，也没有单独创建 `device_errors` 历史表。

当前保存方式：

| 数据 | 当前保存位置 | 保存粒度 |
| --- | --- | --- |
| 最近在线状态 | `device_registry.online` | 当前值 |
| 最近心跳时间 | `device_registry.last_heartbeat_at` | 最近一次 |
| 最近 boot 时间 | `device_registry.last_boot_at` | 最近一次 |
| 最近 seen 时间 | `device_registry.last_seen_at` | 最近一次 |
| 最近遥测 payload | `device_registry.telemetry_json` | 最近一份快照 |
| 设备错误 `error.report` | 当前只 ACK，不入历史表 | 后续应扩展 |
| 控制指令与 ACK | `device_commands` | 指令级历史 |

这种设计适合当前小程序展示“在线/离线、最近状态”的需求，但不适合长期趋势分析、故障统计、传感器曲线、售后复盘。

后续应新增：

```text
device_telemetry_events
  id
  device_no
  msg_type
  report_type
  payload_json
  reported_at
  received_at

device_error_events
  id
  device_no
  code
  level
  module
  message
  payload_json
  reported_at
  received_at
```

或者在规模较大后把遥测写入时序数据库 / 日志系统。

## 5. 为什么不建议“每种设备一个数据库”

不建议这样设计：

```text
users.db
watering_devices.db
light_devices.db
socket_devices.db
sensor_devices.db
...
```

原因：

1. 设备号、绑定、在线、密钥、防重放、配网会话都是通用能力，拆库会导致同一套逻辑重复实现。
2. 用户查询“我的设备”时需要跨所有设备库查询，分页、排序、过滤和权限校验会复杂。
3. 管理员统计总设备数、在线率、绑定率也会跨库聚合，早期没有必要。
4. 后续新增设备类型时，如果每类设备都建库，迁移和备份策略会膨胀。

推荐方式：

```text
统一设备主表 device_registry
  + 通用事件/指令/安全表
  + 必要时按设备类型增加扩展表
```

## 6. 推荐的长期演进模型

当前 MVP 使用“统一设备表 + JSON 快照”。长期建议演进为“统一核心表 + 类型扩展表 + 事件历史表”。

### 6.1 通用核心表保持统一

这些表应长期保持通用，不按设备类型拆分：

| 表 | 原因 |
| --- | --- |
| `users` | 用户身份统一 |
| `sessions` | 登录态统一 |
| `device_registry` | 设备号、归属、在线状态、生产台账统一 |
| `device_keys` | 设备认证统一 |
| `device_provision_sessions` | 配网绑定流程统一 |
| `device_message_nonces` | 防重放统一 |
| `device_commands` | 指令证据链统一 |
| `admin_audit_events` | 管理员审计统一 |

### 6.2 设备类型差异用扩展表

当某类设备业务复杂时，再加扩展表。

示例：浇水设备：

```text
watering_device_configs
  device_no PRIMARY KEY
  mode
  demand_json
  schedule_json
  manual_json
  updated_at

watering_runtime_state
  device_no PRIMARY KEY
  pump_on
  soil_moisture_percent
  water_tank_level_percent
  remaining_seconds
  last_watering_at
  updated_at
```

示例：灯控设备：

```text
light_runtime_state
  device_no PRIMARY KEY
  power_on
  brightness
  color_temperature
  scene
  updated_at
```

示例：插座设备：

```text
socket_runtime_state
  device_no PRIMARY KEY
  power_on
  voltage_v
  current_a
  power_w
  energy_kwh
  updated_at
```

### 6.3 遥测和故障用事件表

通用历史数据建议按事件保存：

```text
device_telemetry_events
  id PRIMARY KEY
  device_no
  device_type
  report_type
  payload_json
  reported_at
  received_at

device_error_events
  id PRIMARY KEY
  device_no
  device_type
  code
  level
  module
  payload_json
  reported_at
  received_at
```

这样可以兼容不同设备类型的遥测字段，并保留完整历史。

### 6.4 用户与设备关系后续可拆表

当需要家庭共享、成员权限、多用户控制同一设备时，应从 `device_registry.owner_user_id` 演进到关系表：

```text
device_bindings
  id PRIMARY KEY
  device_no
  user_id
  role
  status
  bound_at
  unbound_at
```

届时 `device_registry.owner_user_id` 可保留为主拥有者缓存字段，也可以迁移掉。

## 7. 当前架构能否满足近期目标

可以满足当前里程碑：

1. 用户手机号验证码注册/登录：`users`、`sms_codes`、`sessions`。
2. BLE 配网和最终绑定：`device_registry`、`device_provision_sessions`。
3. 设备真实上云认证：`device_keys`、`device_message_nonces`、`device.secureMessage`。
4. 在线/离线展示：`device_registry.online`、`last_seen_at`、`heartbeat_interval_ms`。
5. 周期心跳快照：`device_registry.telemetry_json`、`last_heartbeat_at`。
6. 控制指令记录：`device_commands`。
7. 管理员查询和审计：`admin_audit_events`、绑定尝试/绑定事件表。

当前不足：

| 不足 | 当前影响 | 建议处理时机 |
| --- | --- | --- |
| 没有遥测历史表 | 只能看最近状态，不能看曲线和历史统计 | 真机心跳稳定后新增 |
| 没有设备错误历史表 | `error.report` 目前只确认接收，不便于售后长期追踪 | 真机错误码稳定后新增 |
| 浇水配置仍在 `config_json` | MVP 简单可用，但复杂规则难查询 | 做浇水设备专项控制协议时新增 `watering_*` 表 |
| 用户设备关系只有主拥有者 | 不支持家庭共享、多成员权限 | 需要家庭空间功能时新增 `device_bindings` |
| SQLite 写并发有限 | 大量设备心跳会有写入瓶颈 | 设备数量或心跳频率上来后迁移 PostgreSQL/MySQL |

## 8. 推荐给当前阶段的判断

当前阶段应继续采用：

```text
单 SQLite 数据库
+ 多张通用业务表
+ device_registry 统一设备台账
+ JSON 保存最近配置和最近遥测快照
```

不要现在就为每种设备创建独立数据库。

当开始做某一种具体设备的完整业务闭环时，例如浇水设备，再新增该设备类型的扩展表和专项协议。这样既保留当前系统简单性，又不会阻碍后续扩展。
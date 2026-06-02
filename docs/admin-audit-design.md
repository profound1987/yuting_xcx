# 管理员功能与审计系统设计规范

## 1. 文档目标

本文档定义“云汀智家”后台管理员功能、客服排障查询、用户与设备审计、设备控制证据链和管理操作规则。该模块面向客服、运营、售后、研发和管理员，用于回答用户问题、定位故障、统计经营状态和执行受控的管理操作。

本文重点解决：

- 客服如何查询某个手机号是否注册、什么时候注册、最近是否登录成功。
- 客服如何核对用户关于页展示的 `userId`、`OPENID` 是否与后台记录一致。
- 客服如何查询某个用户是否发起过设备绑定、绑定时间、绑定结果和失败原因。
- 客服如何查询某台设备是否已绑定、什么时候绑定、绑定在哪个用户上。
- 客服如何查询某台设备最近工作了几次、由谁触发、控制参数是什么、设备是否确认执行。
- 管理员如何查看用户数、设备数、绑定率、在线率、失败率等运营统计。
- 管理员如何安全地禁用用户、禁用设备、强制解绑设备，而不破坏售后证据链。
- 系统如何记录管理员自己的操作，避免后台操作没有审计记录。

管理员功能不是小程序普通用户能力。所有管理员接口必须有独立鉴权、权限分级、操作审计和最小必要信息展示。

## 2. 核心原则

### 2.1 审计数据优先写数据库

文件日志适合临时排障，例如查看 `logs/app.log` 中某个 `request_id` 的异常堆栈。客服和管理后台需要可查询、可分页、可过滤、可长期保留的数据，因此关键业务事件必须写入数据库。

必须入库的事件包括：

- 验证码发送、登录成功、登录失败、会话失效。
- 每一次设备绑定尝试，包括失败尝试。
- 每一次设备解绑、强制解绑、设备禁用、设备恢复。
- 每一次设备控制指令，包括保存配置、开始手动浇水、停止手动浇水。
- 设备真实执行事件，包括开始浇水、结束浇水、自动浇水、异常停止。
- 设备心跳、在线状态变化、关键传感器上报和告警。
- 管理员查看敏感数据、导出数据、修改用户或设备状态。

### 2.2 查询给客服，证据给售后

客服查询需要能快速回答用户：

- “你的手机号已经注册，注册时间是某时，最近一次登录成功是某时。”
- “你在某时尝试绑定过设备，服务器收到请求，结果是设备已被其他账号绑定。”
- “这台设备当前绑定在手机号 `138****8000`，绑定时间是某时。”
- “这台设备在某时收到手动浇水指令，参数是 6000 秒，触发账号是某手机号。”

售后证据链需要更严格：不仅要有用户请求，还要有服务器生成指令、下发时间、设备确认时间、设备真实开始/结束执行时间和当时传感器状态。MVP 阶段可以先证明“用户发起了某个控制请求，服务器已记录并模拟设备确认”；真实设备阶段必须增加设备侧回执和工作事件。

### 2.3 删除默认改为禁用或脱敏

真实产品不建议直接物理删除用户、设备、绑定记录和控制记录。否则一旦出现售后争议、误操作、投诉或安全问题，将无法还原事实。

默认策略：

| 操作对象 | 推荐管理操作 | 是否物理删除 | 原因 |
| --- | --- | --- | --- |
| 用户 | 禁用账号、撤销会话、手机号脱敏 | 默认不删除 | 保留注册、绑定、控制证据 |
| 设备 | 禁用设备、强制解绑、标记售后状态 | 默认不删除 | 保留生产台账和设备归属历史 |
| 绑定关系 | 解绑并保留绑定事件 | 不删除历史 | 需要追溯何时绑定、何时解绑 |
| 控制指令 | 标记撤销、失败或超时 | 不删除 | 需要证明用户或系统做过什么 |
| 测试数据 | 管理员二次确认后清理 | 允许 | 避免污染正式统计 |

## 3. 角色与权限

管理员后台至少分为以下角色：

| 角色 | 典型人员 | 权限范围 |
| --- | --- | --- |
| `support` | 客服 | 查询用户、设备、绑定尝试、设备工作记录；不能修改数据 |
| `operator` | 运营 | 查看统计、导出脱敏报表、处理普通售后状态 |
| `engineer` | 研发 | 查看技术日志、设备通信状态、失败原因、异常堆栈 |
| `admin` | 管理员 | 禁用用户、禁用设备、强制解绑、恢复状态 |
| `super_admin` | 超级管理员 | 创建管理员账号、分配权限、执行高风险清理 |

MVP 阶段可以先使用一个 `YT_ADMIN_TOKEN` 保护管理员 API。正式后台上线前必须替换为管理员账号、密码或企业微信登录，并支持角色权限和操作审计。

## 4. 客服排障用例

### 4.1 用户说“我注册不了”

客服询问手机号后，后台按手机号查询：

1. 用户是否存在。
2. 用户创建时间、账号状态、最近登录时间。
3. 最近验证码发送记录：是否发送成功、是否太频繁、是否过期。
4. 最近登录尝试：成功、验证码错误、验证码过期、账号禁用。
5. 当前是否有有效会话。
6. 当前手机号是否已经绑定微信 `OPENID`，以及最近一次看到该 `OPENID` 的时间。

客服可回复示例：

```text
我查到你的手机号 138****8000 已经注册，注册时间是 2026-06-01 20:31，最近一次登录成功是 2026-06-01 21:05。刚才验证码发送失败是因为 60 秒内重复发送，请一分钟后再试。
```

如果需要核对微信身份，客服可以让用户打开小程序“关于/账号信息”页面，读取页面中的 `userId` 和 `OPENID`，然后在后台查询手机号或 OpenID 是否匹配。客服不应要求用户提供验证码、`sessionToken` 或任何设备密钥。

### 4.2 用户说“我绑定设备一直失败”

客服询问手机号和设备号后，后台按手机号或设备号查询绑定尝试：

1. 服务器是否收到过 `device.bind` 请求。
2. 请求时间、手机号、用户 ID、输入的设备号、标准化设备号。
3. 返回给用户的业务码，例如 `DEVICE_NOT_BINDABLE`、`DEVICE_ALREADY_BOUND`、`SESSION_EXPIRED`。
4. 内部失败原因，例如 `invalid_format_or_crc`、`not_registered`、`bound_by_other`、`session_missing`。
5. 如果失败原因为已被绑定，显示当前设备绑定账号的脱敏手机号和绑定时间。

后台查询结果应类似：

```json
{
  "phone": "13800138000",
  "phoneMasked": "138****8000",
  "attempts": [
    {
      "createdAt": 1780320000000,
      "inputDeviceNo": "YT-AW-00032-7A39",
      "normalizedDeviceNo": "YT-AW-00032-7A39",
      "result": "failed",
      "code": "DEVICE_ALREADY_BOUND",
      "message": "设备已被绑定",
      "reason": "bound_by_other"
    }
  ]
}
```

对用户回复时不要泄露 CRC、salt、生产台账细节或其他用户完整手机号。客服只说用户可理解的信息，例如“这个设备号已经绑定到其他账号，请确认是否曾用家人手机号绑定”。

### 4.2.1 绑定失败风控与手机号锁定

为了降低恶意猜测设备号、批量试错和撞库式绑定，`device.bind` 必须按手机号记录并限制绑定失败次数。

默认规则：

| 规则项 | 默认值 | 说明 |
| --- | --- | --- |
| 统计窗口 | 24 小时 | 按手机号滚动统计最近 24 小时内的绑定失败次数 |
| 预警阈值 | 3 次 | 失败次数超过 3 次后，继续返回真实业务失败码，但提示用户继续失败会锁定 |
| 锁定阈值 | 10 次 | 失败次数达到 10 次后，下一次绑定请求开始直接拒绝 |
| 锁定时长 | 24 小时滚动窗口 | 锁定到最近 10 次失败中最早一次失败时间满 24 小时 |

计数范围：

- `DEVICE_NOT_BINDABLE`：设备号格式、CRC、未生产、未注册、测试台账外等失败。
- `DEVICE_ALREADY_BOUND`：设备已绑定到其他用户。
- `SESSION_MISSING`、`USER_DISABLED` 等当前手机号发起的绑定失败。

不计入失败次数：

- 绑定成功。
- 用户重复绑定自己已经拥有的设备且服务端返回成功。
- 锁定期间被拒绝的 `blocked` 请求。锁定请求要入库审计，但不能继续延长锁定时间。

失败次数超过 3 次但尚未锁定时，服务端返回原业务码，并在 `message` 和 `data.bindRisk` 中提示风险：

```json
{
  "success": false,
  "code": "DEVICE_NOT_BINDABLE",
  "message": "设备号不正确。当前手机号24小时内绑定失败已达到4次，超过10次将锁定24小时。",
  "data": {
    "bindRisk": {
      "failedCount24h": 4,
      "warningThreshold": 3,
      "lockThreshold": 10,
      "remainingBeforeLock": 6,
      "lockHours": 24,
      "locked": false,
      "lockedUntil": null,
      "lockedUntilText": ""
    }
  }
}
```

锁定期间，服务端直接返回：

```json
{
  "success": false,
  "code": "DEVICE_BIND_LOCKED",
  "message": "绑定失败次数过多，请在2026-06-03 10:20:00后再试",
  "data": {
    "bindRisk": {
      "failedCount24h": 10,
      "lockThreshold": 10,
      "lockHours": 24,
      "locked": true,
      "lockedUntil": 1780405200000,
      "lockedUntilText": "2026-06-03 10:20:00"
    }
  }
}
```

客服后台应能通过 `admin.user.findByPhone` 或 `admin.bindAttempts.search` 看到该手机号最近 24 小时的失败次数、失败原因和是否出现 `DEVICE_BIND_LOCKED`。客服对用户只说明“该手机号绑定失败次数过多，需要等到某时后再试”，不要提供 CRC、salt、真实设备台账或其他用户信息。

### 4.3 用户问“我的设备最近工作了几次，参数是什么”

客服按设备号查询设备工作记录：

1. 设备当前绑定账号、在线状态、最近同步时间。
2. 最近控制指令：保存配置、手动开始浇水、手动停止浇水。
3. 每次指令的触发用户、触发时间、参数、服务器下发时间、设备确认时间、状态。
4. 真实设备阶段还要查询 `device_work_events`：实际开始浇水、实际结束浇水、实际时长、触发来源、传感器状态。

MVP 阶段可以基于 `device_commands` 回答：

```text
这台设备最近 7 天收到 3 次手动浇水指令，分别是 2026-06-01 10:12 浇水 60 秒、2026-06-01 18:30 浇水 120 秒、2026-06-02 08:05 浇水 30 秒，均由绑定账号 138****8000 发起。
```

真实设备上线后，应以设备回执和工作事件为准：

```text
服务器在 10:12:03 收到用户手动浇水请求，10:12:04 下发指令，设备在 10:12:05 确认开始执行，10:13:05 上报结束，实际执行 60 秒。
```

### 4.4 用户说“水溢出来了，是不是系统问题”

后台需要展示完整时间线：

1. 用户或系统在什么时候触发浇水。
2. 触发来源是手动、定时、按湿度自动，还是管理员测试。
3. 当时的配置参数，例如浇水时长、湿度阈值、定时次数。
4. 服务器是否成功下发指令。
5. 设备是否确认收到指令。
6. 设备实际开始和结束时间。
7. 当时土壤湿度、水箱状态、电磁阀状态、异常告警。
8. 是否存在重复指令、网络重试、设备离线后补发等情况。

如果证据显示是用户手动操作，后台需要能导出一份只包含必要信息的售后说明，隐藏其他用户隐私和内部敏感字段。

## 5. 管理员功能清单

### 5.1 首页统计

| 指标 | 说明 |
| --- | --- |
| 用户总数 | `users` 总量 |
| 今日新增用户 | 当日 `createdAt` 在今天的用户数 |
| 设备总数 | `device_registry` 总量 |
| 已绑定设备数 | `bindStatus = bound` |
| 在线设备数 | `online = true` 或最近心跳未超时 |
| 今日绑定成功数 | 当日绑定成功事件数 |
| 今日绑定失败数 | 当日绑定失败尝试数 |
| 今日绑定锁定数 | 当日被 `DEVICE_BIND_LOCKED` 拒绝的请求数 |
| 今日设备控制数 | 当日 `device_commands` 数 |
| 失败指令数 | 状态为 `failed` 或 `timeout` 的指令数 |
| 设备类型分布 | 按 `AW`、`ES`、`LC`、`SP`、`GW` 统计总数、已绑定数、在线数 |

### 5.2 用户管理

功能：

- 按手机号查询用户。
- 查看用户基础信息、注册时间、最近登录时间、账号状态。
- 查看当前有效会话数量和最近活跃时间。
- 查看用户绑定的设备列表。
- 查看用户最近绑定尝试。
- 查看用户最近设备控制指令。
- 禁用或恢复用户。
- 撤销用户全部会话。

### 5.3 设备管理

功能：

- 按设备号查询设备。
- 查看设备类型、流水号、生产注册状态、绑定状态、在线状态。
- 查看当前绑定用户、绑定时间、解绑历史。
- 查看最近控制指令和参数。
- 查看最近工作事件和传感器上报。
- 禁用或恢复设备。
- 管理员强制解绑设备。

### 5.4 绑定排障

功能：

- 按手机号查绑定尝试。
- 按设备号查绑定尝试。
- 按失败原因统计绑定失败数量。
- 过滤时间范围、业务码、失败原因。
- 从一次绑定尝试跳转到用户详情和设备详情。

### 5.5 设备控制与工作记录

功能：

- 查询设备最近控制指令。
- 查询某用户最近控制指令。
- 查询某台设备最近实际工作记录。
- 区分用户手动操作、自动策略、管理员测试、系统重试。
- 显示参数、状态、失败原因、设备确认时间。

### 5.6 管理员操作审计

管理员每一次后台操作都必须写入 `admin_audit_events`：

- 谁操作：管理员 ID、角色、IP、User-Agent。
- 操作什么：用户、设备、会话、绑定关系、报表。
- 操作前后状态：关键字段变化。
- 操作结果：成功、失败、失败原因。
- 操作时间和 `request_id`。

查询敏感数据也应审计，例如按手机号查询用户、导出设备控制记录。

## 6. 数据模型设计

### 6.1 `device_bind_attempts` 绑定尝试表

该表记录每一次 `device.bind` 请求，不论成功或失败。

```json
{
  "id": "bind_attempt_xxx",
  "requestId": "debug-test-001",
  "phone": "13800138000",
  "phoneMasked": "138****8000",
  "userId": "user_xxx",
  "inputDeviceNo": "yt-aw-00032-7a39",
  "normalizedDeviceNo": "YT-AW-00032-7A39",
  "result": "failed",
  "code": "DEVICE_ALREADY_BOUND",
  "message": "设备已被绑定",
  "reason": "bound_by_other",
  "clientHost": "180.111.223.196",
  "userAgent": "MicroMessenger/...",
  "createdAt": 1780320000000
}
```

`result` 建议值：

| 值 | 说明 | 是否计入绑定失败风控 |
| --- | --- | --- |
| `success` | 绑定成功，或重复绑定自己已经拥有的设备 | 否 |
| `failed` | 绑定失败，例如设备号不正确、设备已被其他用户绑定 | 是 |
| `blocked` | 已被风控锁定，本次请求未进入真实绑定校验 | 否 |

索引：

- `(phone, createdAt DESC)`：按手机号查绑定失败。
- `(normalizedDeviceNo, createdAt DESC)`：按设备号查绑定历史。
- `(code, createdAt DESC)`：统计失败业务码。
- `(reason, createdAt DESC)`：统计内部原因。

### 6.2 `device_commands` 设备控制指令表

当前服务端已经有 `device_commands`，需要作为控制证据链的一部分继续增强。

```json
{
  "id": "cmd_xxx",
  "requestId": "debug-test-001",
  "deviceNo": "YT-AW-00000-A324",
  "userId": "user_xxx",
  "commandType": "watering.startManual",
  "source": "user",
  "payload": {
    "durationSeconds": 600
  },
  "status": "ack",
  "createdAt": 1780320000000,
  "sentAt": 1780320000100,
  "ackAt": 1780320000200,
  "failedReason": ""
}
```

状态建议：

| 状态 | 说明 |
| --- | --- |
| `pending` | 已创建，等待下发 |
| `sent` | 已下发到设备或 IoT 平台 |
| `ack` | 设备确认收到或 MVP 模拟确认 |
| `failed` | 下发失败或业务拒绝 |
| `timeout` | 超时未确认 |
| `cancelled` | 被用户或管理员取消 |

### 6.3 `device_work_events` 设备实际工作表

真实设备阶段必须新增该表，用于证明设备实际做过什么。`device_commands` 表证明“服务器发过什么指令”，`device_work_events` 证明“设备实际执行了什么”。

```json
{
  "id": "work_xxx",
  "deviceNo": "YT-AW-00000-A324",
  "userId": "user_xxx",
  "commandId": "cmd_xxx",
  "workType": "watering",
  "triggerSource": "manual",
  "plannedDurationSeconds": 600,
  "actualDurationSeconds": 598,
  "startedAt": 1780320000200,
  "endedAt": 1780320598200,
  "startTelemetry": {
    "soilMoisture": 28,
    "waterTank": "normal"
  },
  "endTelemetry": {
    "soilMoisture": 46,
    "waterTank": "normal"
  },
  "result": "success",
  "reason": ""
}
```

### 6.4 `device_telemetry` 设备上报表

用于查询通信状态和控制状态。

```json
{
  "id": "telemetry_xxx",
  "deviceNo": "YT-AW-00000-A324",
  "eventType": "heartbeat",
  "payload": {
    "soilMoisture": 35,
    "battery": 91,
    "valveStatus": "closed"
  },
  "reportedAt": 1780320000000,
  "receivedAt": 1780320000100
}
```

### 6.5 `admin_audit_events` 管理员审计表

```json
{
  "id": "admin_audit_xxx",
  "requestId": "debug-test-001",
  "adminId": "admin_xxx",
  "role": "support",
  "action": "admin.user.findByPhone",
  "targetType": "user",
  "targetId": "user_xxx",
  "result": "success",
  "reason": "",
  "detail": {
    "phoneMasked": "138****8000"
  },
  "clientHost": "1.2.3.4",
  "createdAt": 1780320000000
}
```

## 7. 管理员 API 设计

MVP 阶段继续使用统一 `/api` 入口，通过 `type` 区分管理员操作。管理员接口必须传入 `adminToken`，正式后台再升级为管理员会话。

### 7.1 查询类接口

| API type | 功能 |
| --- | --- |
| `admin.overview` | 查询用户、设备、绑定、控制等总览统计 |
| `admin.user.findByPhone` | 按手机号查询用户、注册时间、登录状态、绑定设备、绑定尝试 |
| `admin.user.findByOpenid` | 按 OpenID 反查绑定的业务用户 |
| `admin.device.findByNo` | 按设备号查询设备、绑定用户、绑定历史、控制记录 |
| `admin.bindAttempts.search` | 按手机号、设备号、结果、原因查询绑定尝试 |
| `admin.device.commands` | 查询某台设备或某个用户的控制指令历史 |
| `admin.audit.search` | 查询管理员操作审计 |

### 7.2 管理类接口

| API type | 功能 | 风险控制 |
| --- | --- | --- |
| `admin.user.disable` | 禁用用户并撤销会话 | 必须写管理员审计 |
| `admin.user.restore` | 恢复用户 | 必须写管理员审计 |
| `admin.device.disable` | 禁用设备 | 必须写管理员审计 |
| `admin.device.restore` | 恢复设备为可绑定或可使用状态 | 必须写管理员审计 |
| `admin.device.forceUnbind` | 管理员强制解绑设备 | 必须记录原绑定用户和原因 |

### 7.3 `admin.user.findByPhone` 返回示例

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "exists": true,
    "user": {
      "id": "user_xxx",
      "phoneMasked": "138****8000",
      "status": "active",
      "createdAt": 1780320000000,
      "lastLoginAt": 1780320300000
    },
    "sessionSummary": {
      "activeCount": 1,
      "lastSeenAt": 1780320600000
    },
    "devices": [],
    "wechatBindings": [
      {
        "openid": "openid_xxx",
        "unionid": "",
        "appid": "wx_appid_xxx",
        "source": "wechat_code",
        "status": "active",
        "createdAt": 1780320000000,
        "lastSeenAt": 1780320600000
      }
    ],
    "recentBindAttempts": [],
    "recentCommands": []
  }
}
```

### 7.3.1 `admin.user.findByOpenid` 返回示例

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "exists": true,
    "user": {
      "id": "user_xxx",
      "phoneMasked": "138****8000",
      "status": "active"
    },
    "wechatBinding": {
      "openid": "openid_xxx",
      "appid": "wx_appid_xxx",
      "source": "wechat_code",
      "status": "active"
    }
  }
}
```

### 7.4 `admin.device.findByNo` 返回示例

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "exists": true,
    "device": {
      "deviceNo": "YT-AW-00000-A324",
      "typeLabel": "智能浇水设备",
      "status": "registered",
      "bindStatus": "bound",
      "online": true,
      "ownerPhoneMasked": "138****8000",
      "boundAt": 1780320000000
    },
    "recentBindEvents": [],
    "recentBindAttempts": [],
    "recentCommands": []
  }
}
```

### 7.5 `admin.overview` 返回示例

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "metricScope": "real_user_bound_devices",
    "note": "默认统计排除了预置测试用户和测试台账；完整台账见 registrySummary，预置测试台账见 seedInventory。",
    "usersTotal": 120,
    "usersActive": 118,
    "devicesTotal": 240,
    "devicesBound": 240,
    "devicesOnline": 210,
    "devicesByType": [
      {
        "typeCode": "AW",
        "deviceType": "watering",
        "typeLabel": "智能浇水设备",
        "totalCount": 100,
        "boundCount": 60,
        "onlineCount": 55
      }
    ],
    "registrySummary": {
      "devicesTotal": 500,
      "devicesBound": 251,
      "devicesOnline": 375
    },
    "seedInventory": {
      "usersTotal": 2,
      "boundOnlineOwnerPhone": "11111111111",
      "boundOfflineOwnerPhone": "00000000000",
      "devicesTotal": 500,
      "devicesBound": 250,
      "devicesOnline": 375
    },
    "bindAttempts24h": 80,
    "bindFailures24h": 12,
    "bindBlocked24h": 2,
    "commands24h": 35,
    "commandFailures24h": 1
  }
}
```

说明：开发版服务端会预置 500 台测试设备台账和 2 个测试绑定用户，用于验证绑定、离线和已绑定场景。已绑定在线测试设备默认归属 `11111111111`，已绑定离线测试设备默认归属 `00000000000`。`admin.overview` 默认运营口径排除这些预置数据；如果需要核对完整 `device_registry` 表规模，查看 `data.registrySummary`；如果需要核对预置测试台账规模，查看 `data.seedInventory`。

按手机号查询用户时，如果返回：

```json
{
  "exists": false,
  "phoneMasked": "158****2680",
  "recentBindAttempts": []
}
```

表示服务端数据库中尚无该手机号对应的用户记录。常见原因是小程序仍在 `mock` 模式或本地演示登录模式，没有真正调用远程 `auth.sendCode` / `auth.loginByCode`；也可能是用户从未在远程后端完成登录或设备绑定。

常见问题对应字段：

| 问题 | 使用接口 | 读取字段 |
| --- | --- | --- |
| 目前绑定了多少台设备 | `admin.overview` | `data.devicesBound` |
| 目前有多少台设备在线 | `admin.overview` | `data.devicesOnline` |
| 每种设备分别有多少台 | `admin.overview` | `data.devicesByType[].totalCount` |
| 每种设备已绑定多少台 | `admin.overview` | `data.devicesByType[].boundCount` |
| 每种设备在线多少台 | `admin.overview` | `data.devicesByType[].onlineCount` |

## 8. 客服回复边界

后台可以展示内部原因，但客服对用户回复时必须遵守边界：

- 可以说“设备号不存在或不正确”，不要说 CRC 应该是多少。
- 可以说“设备已绑定到其他账号”，不要提供其他账号完整手机号。
- 可以说“服务器没有收到你的绑定请求”，引导用户检查网络和版本。
- 可以说“服务器收到请求，但会话已过期，请重新登录”。
- 可以说“设备在某时由你的账号发起手动浇水，参数为多少秒”。
- 可以要求用户提供“关于/账号信息”页面中的 `userId` 或 `OPENID` 用于核对，但不要要求用户提供验证码或登录 token。
- 不要把管理员 token、数据库 ID、salt、设备密钥、异常堆栈发给用户。

## 9. 当前 MVP 实现范围

当前 Python 服务端已经具备以下基础：

- `users`：用户基础信息、注册时间、最近登录时间。
- `sessions`：会话状态和最近活跃时间。
- `auth_events`：验证码发送和登录成功事件。
- `device_registry`：设备台账、绑定状态、在线状态、当前配置。
- `device_bind_events`：绑定和解绑成功、部分失败事件。
- `device_bind_attempts`：完整记录每一次绑定尝试，并支持超过 3 次预警、达到 10 次后 24 小时锁定。
- `device_commands`：保存配置、开始手动浇水、停止手动浇水指令。
- `admin_audit_events`：记录管理员查询和修改行为。
- `logs/app.log`：请求级日志和 API 调用日志。

本模块 MVP 已实现：

1. 管理员总览统计：用户数、设备数、绑定数、在线数、按设备类型统计。
2. 管理员查询接口：按手机号、设备号、绑定尝试、控制指令查询。
3. 管理员安全操作接口：禁用用户、恢复用户、禁用设备、恢复设备、强制解绑。
4. 绑定失败风控：超过 3 次预警，达到 10 次后按手机号锁定 24 小时。

真实产品阶段继续补充：

1. `device_work_events`：设备真实工作记录。
2. `device_telemetry`：心跳和传感器上报。
3. 管理员账号、角色权限、登录 MFA、数据导出审批。
4. 售后证据报告导出。
5. 告警系统，例如设备离线、水箱异常、连续浇水过长、异常重复指令。

## 10. 运维和统计建议

- 管理后台查询默认展示最近 30 天，长时间范围需要分页。
- 关键表按时间和查询字段建立索引，避免用户量上来后查询变慢。
- 控制指令、设备工作事件和遥测数据应设置冷热分层：近 90 天在线查询，历史数据归档。
- 统计报表使用单独任务预聚合，避免每次打开首页都扫描全表。
- 管理员导出报表必须脱敏并写审计记录。
- 正式环境建议把 SQLite 升级到 MySQL、PostgreSQL 或云数据库，并使用只读副本承载后台统计查询。

### 10.1 SQLite 容量边界

SQLite 适合 MVP、内测、单机部署和轻量生产试运行。它的优势是简单、稳定、无需独立数据库服务；限制是写入并发、在线备份、权限隔离和横向扩展能力较弱。

粗略建议：

| 场景 | SQLite 是否适合 | 说明 |
| --- | --- | --- |
| 100 - 5,000 台设备 | 适合 | 登录、绑定、少量控制记录没有问题 |
| 5,000 - 20,000 台设备 | 可短期使用 | 需要加好索引、控制遥测写入频率、定期归档 |
| 20,000 - 50,000 台设备 | 谨慎 | 如果设备频繁上报心跳和传感器数据，写入压力会明显增加 |
| 50,000 台以上 | 不建议 | 应升级到 MySQL、PostgreSQL 或云数据库，并拆分遥测/日志存储 |

真正限制通常不是设备台数本身，而是写入频率。例如 1 万台设备每 5 分钟上报一次心跳，约每分钟 2,000 次写入，SQLite 单机文件数据库会很吃力；如果只记录用户登录、绑定和少量控制指令，1 万台设备也可能运行良好。正式产品建议在真实硬件接入前完成数据库升级规划。
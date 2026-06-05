# 云汀设备云端通信协议设计

## 1. 文档目标

本文档定义“云汀智家”云端服务器与智能设备之间的通信协议，用于补齐小程序、云端服务器和智能设备之间的完整链路。

当前小程序已经通过 HTTPS 接入云端服务器，负责用户登录、设备配置、设备列表、浇水配置和手动控制等业务。设备配置必须先通过 BLE 把家庭 Wi‑Fi 信息发送给设备，设备连接云端并完成认证后，云端才允许最终绑定。后续真正控制智能设备时，还需要一套设备侧协议，让云端可以：

- 识别设备身份。
- 接收设备在线、离线、心跳和遥测状态。
- 向设备下发控制指令。
- 接收设备对指令的执行确认。
- 与现有 `device_registry`、`device_commands`、浇水配置和管理员审计能力对齐。

设备编号规范见 [device-numbering-design.md](device-numbering-design.md)。小程序与 HTTPS 服务端总体设计见 [system-design.md](system-design.md)。

## 2. 协议选择结论

建议正式环境使用：

```text
MQTTS = MQTT 3.1.1 over TLS 1.2
```

MQTT 明文只允许用于实验室、本地内网和临时调试，不应用于正式设备入网。

选择 MQTTS 的原因：

| 需求 | MQTTS 适配性 |
| --- | --- |
| 设备在家庭 Wi-Fi 后面，云端无法主动连入设备 | 设备主动连接 Broker，可穿透 NAT |
| 云端要实时下发浇水控制 | 设备订阅命令 Topic，云端发布命令 |
| 设备要周期上报心跳和状态 | 设备发布遥测 Topic |
| 云端要知道设备异常断线 | MQTT Last Will 能自动发布离线状态 |
| 小设备资源有限 | MQTT 包头小，Bouffalo SDK 已有 MQTT/MQTTS 示例 |
| 正式环境需要安全链路 | TLS 校验证书，避免明文设备密钥和控制指令泄露 |

不建议用纯 HTTPS 长轮询作为主设备协议，因为功耗、实时性和连接管理都不如 MQTT；WebSocket 可以实现，但设备侧和 Broker 生态不如 MQTT 简洁。mTLS 可以作为后续增强，但 MVP 阶段优先采用“服务端证书校验 + 每设备唯一账号密钥 + Topic ACL”。

## 3. 总体架构

```text
微信小程序
  -> HTTPS API: https://yutingsmarthome.xin/api
  -> FastAPI 业务服务
  -> MQTT Broker / 设备消息服务
  -> MQTTS: 8883
  -> BL616CL 智能节点
```

职责划分：

- 小程序：只调用 HTTPS API，不直接连接 MQTT Broker，不直接持有设备密钥。
- 云端业务服务：校验用户、设备归属和控制权限，生成设备指令，消费设备上报。
- MQTT Broker：负责设备长连接、Topic 路由、QoS、Last Will 和基础 ACL。
- 智能设备：主动连接 Broker，订阅自身命令 Topic，上报心跳、状态、遥测和指令 ACK。

MVP 阶段可以把 MQTT Broker 和 FastAPI 部署在同一台云服务器上；正式环境建议拆分 Broker、业务服务和数据库，并为设备消息消费服务设置独立进程。

## 4. 传输层规范

### 4.1 端口

| 环境 | 协议 | 端口 | 用途 |
| --- | --- | --- | --- |
| 正式 / 联调 | MQTTS | `8883` | 设备正式接入 |
| 本地实验 | MQTT | `1883` | 内网临时调试，不传真实密钥 |

### 4.2 TLS

正式环境要求：

- 使用 TLS 1.2 或更高版本。
- 设备校验 Broker 服务端证书。
- 设备证书根 CA 固化在固件或安全分区中。
- Broker 域名建议使用 `mqtt.yutingsmarthome.xin`，不要直接使用 IP 作为正式连接目标。
- 证书过期前要有 OTA 或双证书轮换方案。

MVP 阶段设备端程序预留 CA 证书占位，真实证书不得提交到公开仓库。

### 4.3 MQTT 参数

| 参数 | 建议值 |
| --- | --- |
| MQTT 版本 | 3.1.1 |
| Keep Alive | 60 秒 |
| Clean Session | `1` |
| QoS | 遥测 QoS 0，命令和 ACK 建议 QoS 1 |
| Retain | 在线状态 Topic 使用 Retain，普通遥测和命令不 Retain |
| Last Will | 发布 retained `offline` 状态 |

## 5. 设备身份与鉴权

### 5.1 设备编号

设备使用已有编号格式：

```text
YT-XX-NNNNN-CCCC
```

示例：

```text
YT-AW-00000-A324
```

设备编号只用于展示、绑定和路由，不是安全凭证。每台正式设备还必须有唯一设备密钥。

### 5.2 BLE 配网与最终绑定边界

小程序不能仅凭设备号直接绑定设备。正式设备配置流程如下：

1. 小程序调用 `device.prepareConfigure`，云端检查设备号、生产台账和绑定归属。
2. 设备进入配网模式后通过 BLE 广播，蓝牙名称必须以 `ytsh-` 开头。
3. 小程序连接 BLE 设备，先发送完整 `deviceNo`。
4. 设备使用本地烧录信息校验该 `deviceNo` 是否属于自己，校验失败时返回 `DEVICE_NO_MISMATCH` 或 `DEVICE_VERIFY_FAILED`。
5. 小程序确认手机当前 Wi‑Fi，并通过 BLE 发送 `ssid`、`password`、`deviceNo` 和配网会话信息。
6. 设备连接 Wi‑Fi 后主动连接 MQTTS Broker 或设备接入服务。
7. 云端根据设备密钥、设备会话、最近上线时间和配网会话确认该设备已经真实上云。
8. 小程序再调用 `device.bind`，云端完成最终用户归属写入。

设备端恢复出厂设置时必须清除 Wi‑Fi、云端会话、用户绑定缓存和临时配网状态，并重新打开 BLE 配网广播。解绑只清理云端归属，不代表设备端已经安全可转让；售后或用户必须同步执行设备端恢复出厂设置。

### 5.3 MQTT Client ID

格式：

```text
yt_<deviceNo>
```

示例：

```text
yt_YT-AW-00000-A324
```

如果 Broker 不允许 `-` 字符，可以替换为 `_`，但云端和设备端必须保持一致。

### 5.4 用户名和密码

MVP 建议：

| 字段 | 内容 |
| --- | --- |
| username | 设备号，例如 `YT-AW-00000-A324` |
| password | 每设备唯一密钥或由密钥换取的短期 Token |

正式设备密钥要求：

- 生产烧录时写入，不写入小程序和用户可见二维码。
- 每台设备唯一，禁止所有设备共用同一个密码。
- 服务端保存密钥哈希或加密密钥，不明文散落在日志中。
- Broker ACL 根据设备号限制 Topic 读写范围。

ACL 规则示例：

| 方向 | Topic | 权限 |
| --- | --- | --- |
| 设备发布 | `yt/v1/devices/{deviceNo}/telemetry` | 只允许本设备 |
| 设备发布 | `yt/v1/devices/{deviceNo}/event` | 只允许本设备 |
| 设备发布 | `yt/v1/devices/{deviceNo}/status` | 只允许本设备 |
| 设备发布 | `yt/v1/devices/{deviceNo}/command/ack` | 只允许本设备 |
| 设备订阅 | `yt/v1/devices/{deviceNo}/command` | 只允许本设备 |
| 云端发布 | `yt/v1/devices/{deviceNo}/command` | 只允许云端服务账号 |

## 6. Topic 设计

统一前缀：

```text
yt/v1/devices/{deviceNo}
```

| Topic | 方向 | Retain | 说明 |
| --- | --- | --- | --- |
| `yt/v1/devices/{deviceNo}/status` | 设备 -> 云端 | 是 | 在线/离线状态，含 Last Will |
| `yt/v1/devices/{deviceNo}/telemetry` | 设备 -> 云端 | 否 | 心跳、传感器和工作状态 |
| `yt/v1/devices/{deviceNo}/event` | 设备 -> 云端 | 否 | 启动、故障、浇水开始/结束等事件 |
| `yt/v1/devices/{deviceNo}/command` | 云端 -> 设备 | 否 | 控制指令下发 |
| `yt/v1/devices/{deviceNo}/command/ack` | 设备 -> 云端 | 否 | 指令执行确认 |
| `yt/v1/devices/{deviceNo}/config` | 设备 -> 云端 | 否 | 当前配置快照 |

## 7. 消息信封

所有业务消息使用 JSON。统一信封：

```json
{
  "protocol": "YTP/1",
  "msgId": "YT-AW-00000-A324-1",
  "deviceNo": "YT-AW-00000-A324",
  "type": "telemetry.report",
  "ts": 1710000000000,
  "seq": 1,
  "payload": {}
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `protocol` | string | 是 | 固定 `YTP/1` |
| `msgId` | string | 是 | 消息唯一 ID，设备上行可用 `deviceNo-seq` |
| `deviceNo` | string | 是 | 完整设备号 |
| `type` | string | 是 | 消息类型 |
| `ts` | number | 是 | 毫秒时间戳；无真实时间时可传设备启动后的相对毫秒 |
| `seq` | number | 否 | 设备侧递增序号 |
| `payload` | object | 是 | 业务数据 |

云端应按 `deviceNo + msgId` 做幂等处理，避免网络重发造成重复执行。

## 8. 在线状态

设备 MQTT CONNECT 时配置 Last Will：

Topic：

```text
yt/v1/devices/{deviceNo}/status
```

Will Payload：

```json
{
  "protocol": "YTP/1",
  "msgId": "will-YT-AW-00000-A324",
  "deviceNo": "YT-AW-00000-A324",
  "type": "device.status",
  "ts": 0,
  "payload": {
    "online": false,
    "reason": "mqtt_lost"
  }
}
```

设备连接成功后立即发布 retained 在线状态：

```json
{
  "protocol": "YTP/1",
  "msgId": "YT-AW-00000-A324-1",
  "deviceNo": "YT-AW-00000-A324",
  "type": "device.status",
  "ts": 1710000000000,
  "seq": 1,
  "payload": {
    "online": true,
    "reason": "connected",
    "fwVersion": "0.1.0",
    "deviceType": "watering"
  }
}
```

云端收到 retained offline 或超过心跳超时时，应把 `device_registry.online` 更新为 `0`，展示为“离线”。

## 9. 遥测与心跳

心跳建议每 30 秒上报一次；传感器变化明显时也可以立即上报。

Topic：

```text
yt/v1/devices/{deviceNo}/telemetry
```

示例：

```json
{
  "protocol": "YTP/1",
  "msgId": "YT-AW-00000-A324-12",
  "deviceNo": "YT-AW-00000-A324",
  "type": "telemetry.report",
  "ts": 1710000000000,
  "seq": 12,
  "payload": {
    "online": true,
    "uptimeMs": 360000,
    "wifiRssi": -55,
    "watering": {
      "mode": "demand",
      "pumpOn": false,
      "soilMoisture": 42,
      "remainingSeconds": 0,
      "lastWateringAt": 0
    }
  }
}
```

MVP 阶段如果还没有真实传感器，可以使用模拟湿度值和 GPIO 模拟水泵状态，但字段名应保持稳定。

## 10. 指令下发

云端只在完成用户会话校验、设备归属校验和业务参数校验后，才发布设备指令。

Topic：

```text
yt/v1/devices/{deviceNo}/command
```

### 10.1 保存浇水配置

```json
{
  "protocol": "YTP/1",
  "msgId": "cmd_abc001",
  "deviceNo": "YT-AW-00000-A324",
  "type": "watering.saveConfig",
  "ts": 1710000000000,
  "ttlSeconds": 60,
  "payload": {
    "mode": "demand",
    "demand": {
      "intervalHours": 4,
      "threshold": 35,
      "durationSeconds": 20
    },
    "schedule": {
      "intervalDays": 1,
      "times": 2,
      "durationSeconds": 30
    },
    "manual": {
      "durationSeconds": 10
    }
  }
}
```

### 10.2 手动开始浇水

```json
{
  "protocol": "YTP/1",
  "msgId": "cmd_abc002",
  "deviceNo": "YT-AW-00000-A324",
  "type": "watering.startManual",
  "ts": 1710000000000,
  "ttlSeconds": 30,
  "payload": {
    "durationSeconds": 10
  }
}
```

### 10.3 手动停止浇水

```json
{
  "protocol": "YTP/1",
  "msgId": "cmd_abc003",
  "deviceNo": "YT-AW-00000-A324",
  "type": "watering.stopManual",
  "ts": 1710000000000,
  "ttlSeconds": 30,
  "payload": {
    "reason": "user"
  }
}
```

## 11. 指令 ACK

设备收到指令后必须发布 ACK。ACK 分两类：

- `received`：已经收到并通过基础校验。
- `success` / `failed`：执行结果。

MVP 阶段可以只返回最终结果；正式环境建议先回 `received`，再回最终结果。

Topic：

```text
yt/v1/devices/{deviceNo}/command/ack
```

成功示例：

```json
{
  "protocol": "YTP/1",
  "msgId": "YT-AW-00000-A324-13",
  "deviceNo": "YT-AW-00000-A324",
  "type": "command.ack",
  "ts": 1710000001000,
  "seq": 13,
  "payload": {
    "cmdId": "cmd_abc002",
    "commandType": "watering.startManual",
    "status": "success",
    "code": "OK",
    "message": "manual watering started",
    "applied": true
  }
}
```

失败示例：

```json
{
  "protocol": "YTP/1",
  "msgId": "YT-AW-00000-A324-14",
  "deviceNo": "YT-AW-00000-A324",
  "type": "command.ack",
  "ts": 1710000002000,
  "seq": 14,
  "payload": {
    "cmdId": "cmd_abc002",
    "commandType": "watering.startManual",
    "status": "failed",
    "code": "INVALID_DURATION",
    "message": "durationSeconds must be 1..600",
    "applied": false
  }
}
```

云端收到 ACK 后更新 `device_commands.status`、`sent_at`、`ack_at` 和 `failed_reason`。

## 12. 错误码

| 错误码 | 含义 |
| --- | --- |
| `OK` | 成功 |
| `INVALID_PROTOCOL` | 协议版本不支持 |
| `INVALID_DEVICE` | 设备号不匹配 |
| `INVALID_JSON` | JSON 解析失败 |
| `INVALID_COMMAND` | 不支持的指令类型 |
| `INVALID_DURATION` | 浇水时长非法 |
| `INVALID_CONFIG` | 浇水配置非法 |
| `BUSY` | 设备忙，例如正在执行互斥动作 |
| `HARDWARE_ERROR` | 继电器、水泵、传感器等硬件异常 |
| `EXPIRED` | 指令超过 TTL |

## 13. 安全要求

- 小程序不能直连 MQTT Broker。
- 小程序不能保存设备密钥。
- 小程序不能仅凭设备号直接完成绑定，必须先完成 BLE 配网和设备云端认证。
- BLE 配网只传输临时 Wi‑Fi 凭据和配网会话信息，正式设备应尽量使用加密特征值或会话密钥降低近场窃听风险。
- 云端必须按用户与设备绑定关系校验控制权限。
- 设备密钥必须一机一密。
- Broker 必须配置 Topic ACL，防止设备订阅或发布其它设备 Topic。
- 正式环境必须使用 MQTTS。
- 服务端应记录控制指令、ACK、设备状态和管理员操作，形成售后排障证据链。
- 对同一设备的高频控制应限流，避免水泵被恶意或误操作频繁启动。

## 14. 设备端 MVP 实现范围

BL616CL 智能节点首版实现：

- 初始化 Wi-Fi、LwIP、FreeRTOS 和 Shell。
- 支持 BLE 配网模式，广播名称以 `ytsh-` 开头。
- 支持通过 BLE 接收并校验 `deviceNo`。
- 支持通过 BLE 接收 Wi‑Fi SSID、密码和配网会话信息。
- 支持通过 Shell 命令连接 Wi-Fi，作为实验室调试入口。
- 支持启动云端设备任务。
- 使用 MQTT/MQTTS 连接 Broker。
- 发布 retained 在线状态。
- 周期发布心跳和模拟浇水状态。
- 订阅 `command` Topic。
- 支持 `watering.saveConfig`、`watering.startManual`、`watering.stopManual`。
- 通过 GPIO 模拟水泵开关，未接硬件时只打印日志。
- 发布 `command.ack`。

首版暂不实现：

- 生产烧录密钥分区。
- BLE 配网加密握手和特征值权限强化。
- OTA 升级。
- 真实土壤湿度传感器驱动。
- 服务器端 MQTT 消费与发布模块。
- 设备端持久化保存配置。

## 15. 后续演进

建议按以下顺序演进：

1. 服务器部署 Mosquitto 或 EMQX，开放 MQTTS 8883。
2. 服务端新增设备消息服务，消费遥测与 ACK，发布控制指令。
3. 生产系统生成设备号、设备密钥和二维码。
4. 设备端接入真实 BLE + Wi‑Fi 配网、密钥存储和传感器驱动。
5. 接入 OTA，支持 CA 证书、Broker 地址和固件升级。
6. 根据设备规模从 SQLite 迁移到 PostgreSQL 或 MySQL，并增加遥测归档策略。

# MQTTS 设备云端通信落地方案

> 当前阶段目标：智能设备端正式通路切换到 MQTTS，服务器端保留 HTTPS `command.pull` 兜底，避免影响已有测试固件和业务逻辑调试。

## 1. 设计原则

1. 不推翻现有 `YTS-SEC/1 = AES-128-CCM` 安全信封。
2. MQTTS 只替换设备云端传输层；业务 `msgType`、命令状态机和 ACK 结构尽量复用现有 HTTPS 设计。
3. 首版只保留 3 个 Topic：`up`、`down`、`status`，避免 Topic 和 payload 过度膨胀。
4. HTTPS `device.secureMessage msgType=command.pull` 继续保留，用于旧测试固件、Broker 故障兜底和业务逻辑调试。
5. 设备处于 DTIM 低功耗保活状态时仍保持云端长连接；控制命令通过 MQTTS 实时下发，90 秒仅作为应用层心跳周期，不作为命令领取周期。

## 2. Broker 选型

首版使用 **Eclipse Mosquitto**：

- 开源、稳定、轻量。
- 支持 MQTT 3.1.1 / 5.0。
- 支持 TLS、用户名密码认证和 ACL。
- 对 2,000 台设备规模足够。
- 部署和排障简单，适合当前单机云服务器和硬件联调阶段。

后续如果需要可视化管理、规则引擎、集群、高级认证和更强可观测性，再迁移到 EMQX。

## 3. 当前域名与端口

当前可立即使用：

```text
yutingsmarthome.xin:8883
```

原因：

- `mqtt.yutingsmarthome.xin` 当前还没有 DNS 解析。
- 服务器已有 Let's Encrypt 证书：`/etc/letsencrypt/live/yutingsmarthome.xin/`。
- 设备端 TLS 校验证书时，首版应连接 `yutingsmarthome.xin`，后续添加 `mqtt.yutingsmarthome.xin` DNS 和证书后再切换。

后续推荐正式域名：

```text
mqtt.yutingsmarthome.xin:8883
```

## 4. MQTT 参数

| 参数 | 首版值 |
| --- | --- |
| 协议 | MQTT 3.1.1 |
| 传输 | TLS 1.2+ |
| 端口 | 8883 |
| Host | `yutingsmarthome.xin` |
| Client ID | `yt_{deviceNo}` |
| Username | `{deviceNo}` |
| Password | 由 HTTPS `provision.ack` / `bootstrap.ack` 的加密 `mqtt.password` 返回 |
| Clean Session | 1 |
| Keep Alive | 90 秒 |
| 应用心跳 | 90 秒，即 `heartbeatIntervalMs=90000` |
| TLS 校验 | 必须开启；设备端应使用 `MBEDTLS_SSL_VERIFY_REQUIRED` |
| CA | ISRG Root X1 |
| 普通心跳 QoS | 0 |
| 下行命令 QoS | 1 |
| ACK QoS | 1 |
| status QoS | 1 |
| down retain | false |
| up retain | false |
| status retain | true |

## 5. 设备联网流程

### 5.1 首次配网

1. 小程序通过 BLE 下发 Wi-Fi、`apiUrl`、`provisionSessionId`、`secureProtocol` 和 `heartbeatIntervalMs=90000`。
2. 设备连接 Wi-Fi 后，先通过 HTTPS `POST https://yutingsmarthome.xin/api` 上报 `type=device.secureMessage`，安全信封 `msgType=provision.result`。
3. 云端验证 `YTS-SEC/1` 后返回加密 `provision.ack`。
4. 设备解密 `provision.ack`，读取 `mqtt` 对象。
5. 设备使用 `mqtt.host`、`mqtt.port`、`mqtt.username`、`mqtt.password`、`mqtt.tls.caPem` 连接 MQTTS。
6. 设备订阅 `/down`，发布 retained online `device.status`，并可发布 `device.boot`。

### 5.2 断电重启 / 本地凭据丢失

1. 如果本地已持久化 `mqtt` 凭据且未过期，直接连接 MQTTS。
2. 如果没有本地 MQTT 凭据，设备通过 HTTPS `device.secureMessage` 上报 `msgType=bootstrap.request`。
3. 云端返回加密 `bootstrap.ack`，payload 内含新的 `mqtt` 对象。
4. 设备解密后连接 MQTTS。
5. 如果 MQTTS 暂不可用，设备可以恢复低频 HTTPS `command.pull` 兜底。

### 5.3 当前首版凭据机制

当前服务器已经支持在 `provision.ack` / `bootstrap.ack` 中返回 `mqtt` 对象。首版是 **固定 Broker 密码 + 设备号用户名 + Broker ACL**：

- `mqtt.username = deviceNo`
- `mqtt.password` 从云端服务器 `.env` 读取并通过 `YTS-SEC/1` 加密响应下发
- 密码不是 eFuse AES `deviceKey`
- 密码不会进入小程序、二维码、公开文档或日志
- Broker ACL 限制设备账号只能访问自己的 `up/down/status` Topic

后续量产再切换为短期 token 或 mTLS。

示例解密后 payload 结构：

```json
{
  "accepted": true,
  "serverTime": 1780000000000,
  "nextAction": "connect_mqtt",
  "heartbeatIntervalMs": 90000,
  "mqtt": {
    "enabled": true,
    "version": 1,
    "credentialMode": "fixed_broker_password_mvp",
    "host": "yutingsmarthome.xin",
    "port": 8883,
    "protocol": "mqtts",
    "mqttVersion": "3.1.1",
    "clientId": "yt_YT-AW-00000-A324",
    "username": "YT-AW-00000-A324",
    "password": "由云端加密下发，不写入文档",
    "expiresAt": null,
    "cleanSession": true,
    "keepAliveSeconds": 90,
    "heartbeatIntervalMs": 90000,
    "qos": { "down": 1, "ack": 1, "status": 1, "telemetry": 0 },
    "topics": {
      "up": "yt/v1/devices/YT-AW-00000-A324/up",
      "down": "yt/v1/devices/YT-AW-00000-A324/down",
      "status": "yt/v1/devices/YT-AW-00000-A324/status"
    },
    "tls": {
      "enabled": true,
      "verifyRequired": true,
      "serverName": "yutingsmarthome.xin",
      "caName": "ISRG Root X1",
      "caPem": "-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----"
    }
  }
}
```

## 6. Topic

统一前缀：

```text
yt/v1/devices/{deviceNo}
```

| Topic | 方向 | Retain | QoS | 用途 |
| --- | --- | --- | --- | --- |
| `yt/v1/devices/{deviceNo}/up` | 设备 -> 云端 | 否 | 0/1 | `device.boot`、`telemetry.report`、`command.ack`、`error.report` |
| `yt/v1/devices/{deviceNo}/down` | 云端 -> 设备 | 否 | 1 | 控制命令和配置命令 |
| `yt/v1/devices/{deviceNo}/status` | 设备 -> 云端 | 是 | 1 | `device.status` 在线/离线状态和 Last Will |

设备端首版只需要订阅：

```text
yt/v1/devices/{deviceNo}/down
```

## 7. MQTT payload

MQTT payload 直接发送现有 `YTS-SEC/1` 安全信封 JSON。

示例：

```json
{
  "v": 1,
  "alg": "AES-128-CCM",
  "deviceNo": "YT-AW-00000-A324",
  "keyId": "k1",
  "msgType": "watering.manual.start",
  "seq": 101,
  "ts": 1710000000000,
  "nonce": "base64url...",
  "ciphertext": "base64url...",
  "tag": "base64url..."
}
```

HTTPS 中 `device.secureMessage.data` 是安全信封；MQTTS 中 payload 就是这个安全信封本身。

## 8. 下行命令

云端向：

```text
yt/v1/devices/{deviceNo}/down
```

发布安全信封：

```text
msgType = watering.manual.start
```

解密后的 payload：

```json
{
  "cmdId": "cmd_xxx",
  "ttlSeconds": 20,
  "params": {
    "durationSeconds": 10
  }
}
```

配置命令：

```text
msgType = watering.config.set
```

解密后的 payload：

```json
{
  "cmdId": "cmd_xxx",
  "ttlSeconds": 60,
  "params": {
    "configVersion": 1,
    "configHash": "sha256...",
    "config": {}
  }
}
```

为兼容现有 HTTPS `command.pull.ack`，服务端内部仍保留 `device_commands.command_type`。设备端可以优先以安全信封外层 `msgType` 作为命令类型。

## 9. ACK

设备仍通过：

```text
yt/v1/devices/{deviceNo}/up
```

上报：

```text
msgType = command.ack
```

最小 ACK payload：

```json
{
  "cmdId": "cmd_xxx",
  "status": "received"
}
```

```json
{
  "cmdId": "cmd_xxx",
  "status": "executing"
}
```

```json
{
  "cmdId": "cmd_xxx",
  "status": "succeeded"
}
```

失败时：

```json
{
  "cmdId": "cmd_xxx",
  "status": "failed",
  "code": "PUMP_ERROR"
}
```

为了低功耗，成功 ACK 不要求携带大段 `message` 或 `result`。当前云端兼容设备端已有丰富 ACK，只要至少包含 `cmdId` 和 `status`，额外的 `commandType`、`code`、`message`、`state`、`result` 等字段会被保存到命令 `result_json`，不会导致拒绝。

手动浇水时序保持不变：收到 `watering.manual.start` 后可以先上报 `received` / `executing`；只有水泵实际停止后才上报最终 `succeeded`，不要收到命令后立即成功。

## 10. 状态和心跳

设备连接 Broker 后发布 retained 在线状态：

```text
Topic: yt/v1/devices/{deviceNo}/status
msgType: device.status
payload: { "online": true }
```

Last Will 发布 retained 离线状态：

```text
Topic: yt/v1/devices/{deviceNo}/status
msgType: device.status
payload: { "online": false }
```

Last Will payload 也必须是预先生成好的 `YTS-SEC/1` 加密安全信封。设备每次 MQTT CONNECT 前必须重新生成 Will payload，确保 `nonce`、`ts` 和 `seq` 不复用；云端会做 nonce 防重放，重复 Will nonce 会被判定为 `DEVICE_REPLAY_DETECTED`。

90 秒作为应用层心跳周期：

```text
heartbeatIntervalMs = 90000
```

普通心跳建议极简：

```json
{
  "online": true,
  "fwVersion": "0.1.0",
  "rssi": -55,
  "battery": 82
}
```

设备状态变化、故障或调试时再上报详细遥测。

## 11. HTTPS 兼容

保留现有 HTTPS：

```text
device.secureMessage msgType=command.pull
```

兼容规则：

1. MQTTS Worker 运行时，云端会优先把 `queued` 命令 publish 到 `down` Topic，并把命令置为 `sent`。
2. 旧设备继续用 HTTPS `command.pull` 时，服务端仍会返回 `queued` 或 `sent` 的未终态命令。
3. 因此 MQTTS 不会一刀切影响已有测试固件。
4. 如果 MQTT publish 失败，首版应尽量保留 `queued`，让 HTTPS pull 仍可兜底。

## 12. 云端组件

首版新增两个运行组件：

```text
Mosquitto Broker
  - 监听 8883
  - TLS
  - password_file
  - acl_file

MQTT Worker
  - 使用云端服务账号连接 Broker
  - 订阅 yt/v1/devices/+/up
  - 订阅 yt/v1/devices/+/status
  - 扫描 device_commands queued 命令并发布到 down
  - 收到上行安全信封后复用 device_secureMessage 解密和业务处理逻辑
```

FastAPI API 入口和小程序逻辑保持不变。

## 13. 首版测试链路

1. 部署 Mosquitto 8883。
2. 创建云端服务账号和一个测试设备账号。
3. 启动 MQTT Worker。
4. 启动模拟设备，订阅 `down`。
5. 小程序或 API 创建 `watering.manual.start` 命令。
6. Worker publish 到 `down`。
7. 模拟设备收到命令，依次上报 `received`、`executing`、`succeeded`。
8. 小程序通过 `device.getCommandStatus` 看到执行成功。

## 14. 后续迁移到 EMQX 的条件

满足以下任一条件时考虑从 Mosquitto 迁移到 EMQX：

- 需要 Broker Dashboard 管理设备连接。
- 需要可视化规则引擎或直接落库。
- 设备规模明显超过单机运维舒适区。
- 需要集群、高可用和更细粒度认证授权。
- 需要更强 MQTT 追踪和排障能力。

迁移时 Topic、payload、`YTS-SEC/1` 均不变，只替换 Broker 和认证授权实现。

## 15. 已验证结果与联调踩坑

### 15.1 已验证结果

截至首版部署完成，已验证：

- 公网 API：`https://yutingsmarthome.xin/api` 返回正常。
- Broker：`mosquitto.service` 运行中，监听 `0.0.0.0:8883`。
- Worker：`yt-mqtt-worker.service` 运行 `python3 -m app.mqtt_worker`。
- Broker 账号：测试台账 500 台设备已按 `username=deviceNo` 创建，ACL 使用 `%u` 限制每台设备只能访问自己的 `up/down/status` Topic。
- `device.prepareConfigure`：返回 `heartbeatIntervalMs=90000`。
- `provision.ack`：加密响应已返回 `mqtt` 对象，包含 `yutingsmarthome.xin:8883`、`tls.verifyRequired=true`、`caName=ISRG Root X1`、`caPem` 和加密下发的 MQTT 密码。
- `bootstrap.ack`：加密响应已返回同样的 `mqtt` 对象，设备本地凭据丢失时可重新获取。
- 模拟设备：`YT-AW-00000-A324` 已通过 `bootstrap.ack` 获取 MQTT 配置后连接 MQTTS，订阅 `/down` 并上报 `/up` ACK。
- 命令闭环：`queued -> sent -> received -> executing -> succeeded` 已跑通，验证命令 `cmd_FP-0-h6z_8BlHYoOd9Lw2w` 最终 `succeeded`。
- HTTPS `command.pull` 未删除，继续作为旧固件和 Broker 故障兜底。

### 15.2 联调踩坑清单

1. **域名**：`mqtt.yutingsmarthome.xin` 暂未配置 DNS，设备端首版连接 `yutingsmarthome.xin:8883`。
2. **证书权限**：Mosquitto 不应直接读取 root-only 的 Let’s Encrypt live 目录；当前使用 `/etc/mosquitto/certs/` 下的证书副本。
3. **证书续期**：证书续期后需要同步副本并重启 Mosquitto，后续应增加 Certbot deploy hook。
4. **Mosquitto 配置**：避免在 `conf.d` 中重复声明默认配置已有的 `persistence`、`persistence_location` 等全局项。
5. **设备号**：设备号有校验位，测试前必须从台账查询或由服务端函数生成；不能手写校验码。
6. **retained status**：错误设备号如果发布过 retained status，Worker 重启订阅后会收到旧消息并记录 `INVALID_DEVICE`，需要发布空 retained 消息清理。
7. **日志位置**：Worker 业务日志主要在后端 `logs/app.log`，`mqtt_worker.log` 可能为空。
8. **命令行 TLS**：普通用户无法读取 `/etc/mosquitto/certs/chain.pem` 时，`mosquitto_pub/sub` 可使用系统 CA `/etc/ssl/certs/ca-certificates.crt`。
9. **PowerShell 换行**：Windows here-string 可能给远端 bash 带入 `\r`，看到 `$'\r': command not found` 时先检查服务真实状态。
10. **测试手机号**：部分 seed 手机号不符合正式正则，公网 API 测试应使用合法测试手机号；底层闭环验证才可在测试库直接插入命令。

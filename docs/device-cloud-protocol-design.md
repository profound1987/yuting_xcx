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
| 云端要实时下发设备控制 | 设备订阅命令 Topic，云端发布命令 |
| 设备要周期上报心跳和状态 | 设备发布遥测 Topic |
| 云端要知道设备异常断线 | MQTT Last Will 能自动发布离线状态 |
| 小设备资源有限 | MQTT 包头小，Bouffalo SDK 已有 MQTT/MQTTS 示例 |
| 正式环境需要安全链路 | TLS 校验证书，避免明文设备密钥和控制指令泄露 |

不建议用纯 HTTPS 长轮询作为主设备协议，因为功耗、实时性和连接管理都不如 MQTT；WebSocket 可以实现，但设备侧和 Broker 生态不如 MQTT 简洁。mTLS 可以作为后续增强。MVP 阶段优先采用“服务端证书校验 + Topic ACL + YTS-SEC/1 AES-128-CCM 应用层安全消息”；设备 eFuse 中的 16 字节 AES key 只用于 AES-CCM，不能作为 MQTT 明文密码使用。

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

#### 5.2.1 当前代码实现状态

截至 2026-06-06，当前小程序和服务端已经改为“配网会话 + 设备认证上线 + 小程序轮询 + 最终绑定强校验”的结构，但设备端固件仍需要按本文档实现 AES-128-CCM 上报。

- 小程序通过 BLE 向设备写入两类 JSON，并通过 Notify 接收设备 Wi‑Fi 连接状态：
  - `verifyDeviceNo`：发送完整设备号，让设备校验是否属于自己。
  - `provisionWifi`：发送 `deviceNo`、`provisionSessionId`、`apiUrl`、`secureProtocol`、`heartbeatIntervalMs`、`ssid`、`password` 和时间戳。
  - `wifiStatus` / `provisionWifi.status`：设备通过 BLE Notify 返回 Wi‑Fi 扫描、连接成功或失败状态，供小程序决定是否继续轮询云端。
- 小程序当前 `waitCloudOnline()` 会轮询 `device.checkProvisionStatus`，只有返回 `DEVICE_READY_TO_BIND` 后才调用 `device.bind`。
- 服务端 `device.prepareConfigure` 会创建有 TTL 的 `provisionSessionId`。
- 服务端 `device.secureMessage` 已预留 AES-128-CCM 认证解密入口；当前 100 台测试台账设备的 `keyId` 固定为 `k1`，测试 AES key 与未烧录 eFuse 的设备默认值一致，固定为 16 字节全 0，即 `00000000000000000000000000000000`。正式环境必须替换为生产烧录的一机一随机密钥。
- 服务端 `device.bind` 已改为校验 `provisionSessionId` 对应的 `ready_to_bind` 配网会话，不再接受小程序自报 `provisioned: true` 作为绑定依据。
- 因此，设备端未实现 `device.secureMessage / provision.result` 前，真实设备会停留在“等待设备上线”或超时提示。

当前 BLE 写入和状态回传示例：

BLE Service / Characteristic：

| 名称 | UUID | 方向 | 说明 |
| --- | --- | --- | --- |
| Provision Service | `0000FFF0-0000-1000-8000-00805F9B34FB` | - | 配网服务 |
| Write Characteristic | `0000FFF1-0000-1000-8000-00805F9B34FB` | 小程序 -> 设备 | 小程序写入 `verifyDeviceNo`、`provisionWifi` |
| Notify Characteristic | `0000FFF2-0000-1000-8000-00805F9B34FB` | 设备 -> 小程序 | 设备返回 Wi‑Fi 连接状态 |

BLE payload 均为 UTF-8 JSON + `\n`，小程序写入时按 20 字节分片；设备 Notify 也建议按 JSON 行返回，便于小程序拼包解析。

小程序校验设备号：

```json
{
  "type": "verifyDeviceNo",
  "deviceNo": "YT-AW-00000-A324",
  "ts": 1710000000000
}
```

```json
{
  "type": "provisionWifi",
  "deviceNo": "YT-AW-00000-A324",
  "provisionSessionId": "ps_20260606_xxx",
  "apiUrl": "https://yutingsmarthome.xin/api",
  "secureProtocol": "YTS-SEC/1-AES-128-CCM",
  "heartbeatIntervalMs": 30000,
  "statusNotify": {
    "serviceUuid": "0000FFF0-0000-1000-8000-00805F9B34FB",
    "characteristicUuid": "0000FFF2-0000-1000-8000-00805F9B34FB",
    "format": "json-lines"
  },
  "ssid": "Home-WiFi",
  "password": "wifi-password",
  "ts": 1710000000000
}
```

设备 Wi‑Fi 连接状态 Notify 成功示例：

```json
{
  "type": "wifiStatus",
  "status": "connected",
  "code": "WIFI_CONNECTED",
  "message": "Wi-Fi connected",
  "wifiRssi": -55,
  "localIp": "192.168.1.24",
  "ts": 1710000000000
}
```

设备 Wi‑Fi 连接状态 Notify 失败示例：

```json
{
  "type": "wifiStatus",
  "status": "failed",
  "code": "WIFI_AUTH_FAILED",
  "message": "Wi-Fi password is incorrect",
  "ts": 1710000000000
}
```

BLE Notify 的 `code` 必须和本文档后续 `provision.result` 的 Wi‑Fi 错误码保持一致。设备扫描不到用户填写的 SSID 时必须返回 `WIFI_NOT_FOUND`，不要返回 `WIFI_TIMEOUT` 或泛化的 `WIFI_CONNECT_TIMEOUT`；只有设备已经开始连接目标 AP 但在超时时间内没有完成关联、鉴权或拿到 IP 时，才返回 `WIFI_TIMEOUT`。小程序会按 `WIFI_NOT_FOUND` 提示“未找到该 Wi‑Fi”，按 `WIFI_AUTH_FAILED` 提示密码错误，按 `WIFI_TIMEOUT` 提示连接超时。

小程序处理要求：

1. 小程序写入 `provisionWifi` 后，先等待 BLE Notify 返回 Wi‑Fi 连接状态。
2. 如果 `status=failed`，立即停止配网流程并提示 `code/message` 对应错误原因。
3. 如果 `status=connected`，把 Wi‑Fi 步骤标记为成功，然后开始轮询 `device.checkProvisionStatus`。
4. 如果超时未收到 Wi‑Fi 状态，提示“未收到设备 Wi‑Fi 连接结果”，用户可重新配网。
5. 即使 Wi‑Fi 已连接，小程序仍不能直接绑定；最终绑定仍以云端收到 AES-CCM `provision.result` 为准。

#### 5.2.2 推荐的入网首包设计

设备通过 BLE 获得 Wi‑Fi 后，必须主动向云端发送“入网结果”或“在线状态”，云端收到并完成设备认证解密后，才允许小程序最终绑定。

根据当前硬件约束，设备 eFuse 只能保存 16 字节密钥，并且 CPU 不能读取该密钥，只能由硬件 AES 单元使用。因此正式设备认证与数据保护统一采用：

```text
YTS-SEC/1 = AES-128-CCM 安全消息
```

基础要求：

- 当前测试阶段：如果测试固件尚未烧录正式 eFuse key，设备端硬件 AES 使用 eFuse 默认值，全 0 的 16 字节 key。服务端测试台账必须使用同一把测试 key：`00000000000000000000000000000000`，`keyId` 固定为 `k1`。该规则只允许用于测试设备和联调环境。
- 生产阶段：每台设备生产时生成 16 字节真随机 `deviceKey`。
- 生产阶段：`deviceKey` 写入芯片 key eFuse 或安全 key slot，CPU 不能读出。
- 服务端数据库按 `deviceNo` 保存同一把设备密钥的加密副本，例如 `deviceKeyEncrypted`。
- 设备端使用硬件 AES 完成 AES-128-CCM 加密和认证。
- 服务端根据 `deviceNo` 查出设备密钥，执行 AES-128-CCM 认证解密。
- 认证解密成功后，云端才认可该消息来自真实设备。

如果芯片 SDK 没有直接提供 CCM 接口，可以用硬件 `AES-CTR` 和 `AES-CBC`/`AES-ECB` 按 NIST SP 800-38C / RFC 3610 实现标准 AES-CCM。不得自定义 CBC-MAC 变体。

#### 5.2.3 AES-128-CCM 安全消息外层格式

设备上行和云端下行都使用同一种安全信封。外层字段明文传输，用作路由、查密钥和 AAD 认证；业务 payload 先序列化为 UTF-8 JSON 字节串，再用 AES-128-CCM 加密，结果放入 `ciphertext`。

HTTPS MVP 外层：

```json
{
  "type": "device.secureMessage",
  "data": {
    "v": 1,
    "alg": "AES-128-CCM",
    "deviceNo": "YT-AW-00000-A324",
    "keyId": "k1",
    "msgType": "provision.result",
    "seq": 1,
    "ts": 1710000000000,
    "nonce": "base64url(13字节nonce)",
    "ciphertext": "base64url(AES-CCM密文)",
    "tag": "base64url(16字节认证标签)"
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `v` | number | 是 | 安全协议版本，当前固定为 `1` |
| `alg` | string | 是 | 固定 `AES-128-CCM` |
| `deviceNo` | string | 是 | 完整设备号，用于服务端查找密钥 |
| `keyId` | string | 是 | 密钥版本，首版可固定为 `k1`，后续用于换钥 |
| `msgType` | string | 是 | 业务消息类型，例如 `provision.result`、`telemetry.report`、`command.ack` |
| `seq` | number | 是 | 同一方向递增序号，用于防重放 |
| `ts` | number | 是 | 设备时间戳或启动后相对毫秒；无 RTC 时主要用于日志 |
| `nonce` | string | 是 | base64url 编码的 13 字节 CCM nonce，同一 key 下绝不能重复 |
| `ciphertext` | string | 是 | base64url 编码的 AES-CCM 密文；解密后是 UTF-8 JSON payload 字节串，具体字段由 `msgType` 决定 |
| `tag` | string | 是 | base64url 编码的 16 字节 CCM tag |

`ciphertext` 的生成规则：

```text
payload_json = JSON.stringify(payload)
plaintext = UTF-8(payload_json)
(ciphertext, tag) = AES-128-CCM-Encrypt(key, nonce, plaintext, aad, tagLen=16)
```

其中 `payload_json` 是业务明文对象，不包含外层 `v`、`alg`、`deviceNo`、`keyId`、`msgType`、`seq`、`ts`、`nonce`、`ciphertext`、`tag` 字段。设备端建议输出无多余空格的 JSON；AES-CCM 不要求 JSON 字段排序，但测试向量和互通测试必须使用完全一致的明文字节串。

服务端响应也使用同样的 `data` 结构，但外层为普通 API 响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "",
  "data": {
    "v": 1,
    "alg": "AES-128-CCM",
    "deviceNo": "YT-AW-00000-A324",
    "keyId": "k1",
    "msgType": "provision.ack",
    "seq": 1,
    "ts": 1710000001000,
    "nonce": "base64url(13字节服务端nonce)",
    "ciphertext": "base64url(AES-CCM密文)",
    "tag": "base64url(16字节认证标签)"
  }
}
```

#### 5.2.4 AAD 规则

AES-CCM 的 AAD 使用固定 UTF-8 字符串，设备端和服务端必须完全一致。不要直接把 JSON 文本作为 AAD，避免字段顺序和空格差异。

固定 CCM 参数：

| 参数 | 值 |
| --- | --- |
| Key | 16 字节；测试阶段为 eFuse 默认全 0 key，生产阶段为设备 eFuse AES key |
| Nonce | 13 字节 |
| Tag | 16 字节 |
| Plaintext | UTF-8 JSON 字节串 |
| AAD | 下方固定字符串的 UTF-8 字节串 |
| `seq` 编码 | AAD 中使用十进制字符串；nonce 中使用 4 字节大端整数 |
| base64url | 使用 URL 安全 Base64，建议去掉末尾 `=` padding |

AAD 拼接规则：

```text
YTS-SEC/1
AES-128-CCM
{deviceNo}
{keyId}
{msgType}
{seq}
{ts}
{nonceBase64url}
```

示例：

```text
YTS-SEC/1
AES-128-CCM
YT-AW-00000-A324
k1
provision.result
1
1710000000000
AQABEiM0RVZneImaq7zN3g
```

这些明文字段一旦被篡改，AES-CCM tag 验证必须失败。

#### 5.2.5 设备端 CCM 实现固定参数

优先使用芯片 SDK 或可信密码库提供的标准 `AES-128-CCM`。如果必须基于硬件 `AES-CTR`、`AES-CBC` 或 `AES-ECB` 自行拼装 CCM，必须严格按标准流程实现，不能改字段、不能省略 AAD、不能把 CBC-MAC 当作自定义签名。

本协议固定参数：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `M` | 16 | tag 长度 16 字节 |
| `N` | 13 | nonce 长度 13 字节 |
| `L` | 2 | payload length 编码长度，`L = 15 - N` |
| 最大明文长度 | 65535 字节 | 首版业务消息远小于该值 |
| CBC-MAC B0 flags | `0x79` | AAD present + `M=16` + `L=2` |
| CTR flags | `0x01` | `L=2` |
| 字节序 | big-endian | length、counter 和 nonce 中的 `seq` 均用大端 |

CCM 加密流程摘要：

1. 将业务 payload 序列化为 UTF-8 JSON 字节串 `P`。为便于设备端和服务端排查，建议业务 JSON 使用固定字段名、无多余空格、UTF-8 编码；AES-CCM 本身不要求 JSON 字段排序，只要求解密方把解出的字节按同一业务 JSON 解析。
2. 按 5.2.4 构造 AAD 字节串 `A`。
3. 构造 `B0`：

   ```text
   B0 = 0x79 || nonce(13字节) || len(P)(2字节大端)
   ```

4. 构造 CBC-MAC 输入：

   ```text
   mac_input = B0 || encoded_aad_padded || P || payload_padding
   ```

   其中：

   - 当 `len(A) < 65280` 时，`encoded_aad = len(A)(2字节大端) || A`。
   - `encoded_aad_padded` 是把 `encoded_aad` 右侧补 `0x00` 到 16 字节边界。
   - `payload_padding` 是把 `P` 右侧补 `0x00` 到 16 字节边界。
   - padding 只参与 CBC-MAC，不属于明文，不加密，不传输。
   - 本协议 AAD 长度应始终小于 65280。
5. 计算 CBC-MAC。可用硬件 AES-ECB 逐块计算，也可用硬件 AES-CBC，IV 固定全 0，输入为上一步已手动补齐到 16 字节边界的数据：

   ```text
   X0 = 0^128
   Xi = AES-ENC(key, Xi-1 XOR block_i)
   T = MSB_16(Xn)
   ```

6. 构造 CTR 块：

   ```text
   A_i = 0x01 || nonce(13字节) || counter_i(2字节大端)
   ```

   其中 `counter_0 = 0`，`counter_1` 开始用于加密明文。计数器只允许最后 2 字节按大端递增，不允许进位修改 nonce。
7. 计算：

   ```text
   S0 = AES-ENC(key, A_0)
   S_i = AES-ENC(key, A_i), i >= 1
   ciphertext = P XOR (S1 || S2 || ...)
   tag = T XOR MSB_16(S0)
   ```

   `ciphertext` 长度必须等于 `len(P)`；最后一个密钥流块只取实际剩余明文长度。

如果硬件 `AES-CTR` 的计数器端序或进位范围无法确认，设备端应改用硬件 `AES-ECB` 手动加密 `A_i` 计数器块来生成 `S_i`，不要直接套用不确定的 CTR 外设模式。

CCM 解密流程必须先用相同 AAD、nonce 和 key 验证 tag。tag 验证失败时，设备端和服务端都必须丢弃明文，不得执行任何业务动作。

实现验收要求：

- 与 Python `cryptography.hazmat.primitives.ciphers.aead.AESCCM`、mbedTLS、TinyCrypt 或芯片 SDK AES-CCM 的输出互通。
- 使用 RFC 3610 / NIST SP 800-38C 标准测试向量验证 CBC-MAC、CTR 和 tag。
- 对同一 key + nonce 的重复加密必须作为严重错误处理。

固定互通测试向量如下，仅用于设备端开发验证，不是生产密钥：

| 项 | 值 |
| --- | --- |
| key hex | `000102030405060708090a0b0c0d0e0f` |
| nonce hex | `01112233445566778800000001` |
| nonce base64url | `AREiM0RVZneIAAAAAQ` |
| tag length | `16` |
| AAD length | `93` |
| plaintext length | `75` |

AAD：

```text
YTS-SEC/1
AES-128-CCM
YT-AW-00000-A324
k1
provision.result
1
1710000000000
AREiM0RVZneIAAAAAQ
```

Plaintext：

```json
{"provisionSessionId":"ps_test_001","result":"success","fwVersion":"0.1.0"}
```

期望输出：

```text
ciphertext hex = 1cbf6d2f6973ac9b59d4f4de17b5c145ac38e934d9d2454c819ed466e088ea6b6e028c3c2a06157fadeaefb7b67f8ff28715e79b8b493052b32bb4297ba811f71e4a01f3c499f7eab70457
tag hex        = c3442167f04fb911c0512eabe8b6dad7
ciphertext b64 = HL9tL2lzrJtZ1PTeF7XBRaw46TTZ0kVMgZ7UZuCI6mtuAow8KgYVf63q77e2f4_yhxXnm4tJMFKzK7Qpe6gR9x5KAfPEmffqtwRX
tag b64        = w0QhZ_BPuRHAUS6r6Lba1w
```

#### 5.2.6 Nonce 与防重放

CCM 要求同一设备密钥下 nonce 绝不能重复。首版统一使用 13 字节 nonce：

```text
nonce = direction(1字节) || bootRandom(8字节) || seq(4字节)
```

方向字节：

| 方向 | direction |
| --- | --- |
| 设备 -> 云端 | `0x01` |
| 云端 -> 设备 | `0x02` |

规则：

1. 设备每次启动生成 8 字节真随机 `bootRandom`。
2. 同一次启动内，设备上行 `seq` 从 `1` 开始单调递增。
3. 云端下行使用独立的服务端 `seq` 和方向字节 `0x02`。
4. 服务端保存设备最近使用过的 nonce，或保存 `bootRandom + maxSeq`，防止重放。
5. 同一个 `provisionSessionId` 只能使用一次。
6. 如果设备有可靠持久化计数器，可以改用 `direction(1字节) || persistentCounter(12字节)`，安全性更好。

如果设备没有 RTC，`ts` 不作为强安全判断，只用于日志；强防重放依赖 nonce、seq 和一次性 `provisionSessionId`。

#### 5.2.7 配网结果上报 `provision.result`

`provision.result` 是所有智能设备一致的通用入网结果协议。无论设备类型是浇水、灯控、插座、传感器还是网关，只要通过小程序 BLE 配网并需要云端确认真实设备上线，都必须按本节格式上报。

设备连上 Wi‑Fi 后，必须上报 `msgType = provision.result`。该消息的 `ciphertext` 解密后必须是 UTF-8 JSON object，用于告诉云端本次配网是否成功，以及设备当前固件、网络和能力信息。

成功上报明文 payload：

```json
{
  "provisionSessionId": "ps_20260606_xxx",
  "result": "success",
  "fwVersion": "0.1.0",
  "deviceType": "watering",
  "bootReason": "power_on",
  "uptimeMs": 12000,
  "network": {
    "wifiSsidHash": "sha256或留空",
    "wifiRssi": -55,
    "localIp": "192.168.1.24",
    "mac": "AA:BB:CC:DD:EE:FF"
  },
  "capabilities": {
    "schemaVersion": 1,
    "model": "YT-AW-BASIC-SM",
    "components": {
      "waterPump": { "present": true, "channels": 1 },
      "soilMoistureSensor": { "present": true, "valueType": "percent" },
      "waterLevelSensor": { "present": false },
      "localStorage": { "present": true, "persistentConfig": true }
    },
    "features": {
      "manualWatering": { "supported": true },
      "scheduleWatering": { "supported": true },
      "demandWatering": { "supported": true },
      "waterTankProtection": { "supported": false }
    }
  },
  "errors": []
}
```

失败上报明文 payload：

```json
{
  "provisionSessionId": "ps_20260606_xxx",
  "result": "failed",
  "code": "WIFI_AUTH_FAILED",
  "message": "Wi-Fi password is incorrect",
  "fwVersion": "0.1.0",
  "deviceType": "watering",
  "uptimeMs": 9000,
  "network": {
    "wifiRssi": -67,
    "mac": "AA:BB:CC:DD:EE:FF"
  },
  "errors": [
    {
      "code": "WIFI_AUTH_FAILED",
      "level": "error",
      "message": "Wi-Fi password is incorrect"
    }
  ]
}
```

`provision.result` 字段定义：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provisionSessionId` | string | 是 | 小程序通过 BLE 下发的配网会话 ID；必须原样回传 |
| `result` | string | 是 | `success` 或 `failed` |
| `code` | string | 失败时必填 | 失败错误码；成功时可省略或为 `OK` |
| `message` | string | 否 | 设备侧诊断文本，普通用户提示由小程序/云端映射，不直接展示敏感细节 |
| `fwVersion` | string | 建议 | 固件版本，例如 `0.1.0` |
| `deviceType` | string | 建议 | 设备类型，例如 `watering`；云端仍以生产台账为准 |
| `bootReason` | string | 否 | 本次启动原因，取值见 `device.boot` |
| `uptimeMs` | number | 否 | 设备启动后运行毫秒数 |
| `network` | object | 建议 | 网络诊断信息；不得包含 Wi‑Fi 密码 |
| `network.wifiSsidHash` | string | 否 | SSID 的摘要或留空；不要上报明文家庭 SSID，除非用户明确授权 |
| `network.wifiRssi` | number | 否 | Wi‑Fi RSSI，单位 dBm |
| `network.localIp` | string | 成功时建议 | 设备局域网 IP |
| `network.mac` | string | 建议 | 设备 MAC 地址，用于售后排查 |
| `capabilities` | object | 成功时必填 | 设备能力对象；用于小程序动态显示功能项和服务端校验配置，不应只是字符串数组 |
| `capabilities.schemaVersion` | number | 是 | 能力描述 schema 版本，当前建议 `1` |
| `capabilities.model` | string | 建议 | 设备型号或硬件版本标识，用于售后和模板匹配 |
| `capabilities.components` | object | 是 | 设备硬件/基础组件，例如水泵、土壤湿度传感器、水位传感器、本地存储 |
| `capabilities.features` | object | 是 | 产品功能开关和参数约束，例如手动浇水、定期浇水、按需浇水 |
| `errors` | object[] | 否 | 设备侧错误列表；成功时为空数组或省略 |

`result` 取值：

| 值 | 含义 | 服务端处理 |
| --- | --- | --- |
| `success` | Wi‑Fi 已连接，设备已能访问云端并完成本条 AES-CCM 认证上报 | 会话标记为 `ready_to_bind` |
| `failed` | 配网失败或设备无法完成后续步骤 | 会话标记为 `failed`，小程序提示重新配置 |

`code` 建议取值：

| 错误码 | 含义 | 小程序建议提示 |
| --- | --- | --- |
| `OK` | 成功 | 设备已上线 |
| `WIFI_AUTH_FAILED` | Wi‑Fi 密码错误 | Wi‑Fi 密码可能不正确 |
| `WIFI_NOT_FOUND` | 找不到目标 Wi‑Fi | 未找到该 Wi‑Fi，请确认设备在信号范围内 |
| `WIFI_TIMEOUT` | Wi‑Fi 连接超时 | Wi‑Fi 连接超时，请重试 |
| `DNS_FAILED` | DNS 解析失败 | 网络 DNS 异常，请检查路由器 |
| `CLOUD_CONNECT_FAILED` | 无法连接云端 | 设备无法连接云端，请检查网络 |
| `TLS_FAILED` | TLS 握手失败 | 设备安全连接失败 |
| `DEVICE_NO_MISMATCH` | BLE 下发设备号与本机烧录设备号不一致 | 设备号不匹配，请重新选择设备 |
| `INTERNAL_ERROR` | 设备内部错误 | 设备异常，请重试 |

设备用 AES-128-CCM 加密该 payload 后，发送 `device.secureMessage`。注意：Wi‑Fi 密码绝不能上报云端，Wi‑Fi SSID 也建议只上报摘要或不上传。

服务器处理要求：

1. 校验外层字段格式。
2. 根据 `deviceNo` 查询生产台账和设备密钥。
3. 根据 `keyId` 选择正确密钥版本。
4. 重建 AAD。
5. 使用 AES-128-CCM 认证解密 `ciphertext` 和 `tag`，得到 UTF-8 JSON payload。
6. 校验 payload 必须是 JSON object，且 `provisionSessionId`、`result` 等必填字段存在。
7. 认证失败则拒绝，不更新设备状态，不执行绑定相关操作。
8. 校验 `nonce` / `seq` 是否重放。
9. 校验 `provisionSessionId` 是否由 `device.prepareConfigure` 创建，且未过期、未使用、属于当前配置流程。
10. 如果 `result = failed`，记录失败 payload，把配网会话标记为 `failed`，并返回失败 ACK。
11. 如果 `result = success`，写入设备最近在线时间、固件版本、网络信息和配网结果。
12. 如果 payload 包含完整 `capabilities` 对象，服务端校验 `schemaVersion`、`components`、`features` 基础结构后保存到 `capabilities_json`，并把 `capability_state` 置为 `reported`。服务端可以自行计算内部摘要用于排障，但设备端不必上报 `capabilityHash`。
13. 服务端配置和控制校验必须优先使用该设备最新上报的能力快照；如果设备能力不支持某 feature，即使系统模板存在该 feature，也必须拒绝相关配置和命令。
14. 将该配网会话标记为 `ready_to_bind`。
15. 小程序随后调用 `device.bind` 时，云端必须校验该会话，而不是相信小程序传入的 `provisioned: true`。

服务端返回的 `provision.ack` 解密后 payload：

`provision.ack` 是所有智能设备一致的通用配网确认协议。设备必须对服务端响应执行 AES-128-CCM 认证解密，只有验证通过后才能相信云端给出的 `provisionState` 和 `nextAction`。

```json
{
  "accepted": true,
  "serverTime": 1710000001000,
  "provisionState": "ready_to_bind",
  "nextAction": "wait_bind",
  "heartbeatIntervalMs": 30000,
  "message": "设备已上线，可以绑定"
}
```

字段定义：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `accepted` | boolean | 是 | 云端是否接受本条 `provision.result` |
| `serverTime` | number | 是 | 云端毫秒时间戳，可用于设备校时参考 |
| `provisionState` | string | 是 | `ready_to_bind`、`failed`、`expired` 等 |
| `nextAction` | string | 是 | `wait_bind`、`retry_wifi`、`factory_reset_required` 等下一步建议 |
| `heartbeatIntervalMs` | number | 建议 | 云端要求设备入网后的心跳周期，单位 ms；应与 BLE `provisionWifi` 中下发值一致 |
| `message` | string | 否 | 云端诊断文本 |

如果失败，云端可以返回：

```json
{
  "accepted": false,
  "serverTime": 1710000001000,
  "provisionState": "failed",
  "nextAction": "retry_wifi",
  "heartbeatIntervalMs": 30000,
  "code": "WIFI_AUTH_FAILED",
  "message": "设备配网失败"
}
```

设备必须对服务端响应执行同样的 AES-128-CCM 认证解密，验证通过后才相信服务器响应。

#### 5.2.8 小程序查询配网状态与最终绑定

`device.prepareConfigure` 创建的是临时配网会话，必须有 TTL，不能长期占用绑定状态。推荐 TTL 为 10 分钟，当前小程序轮询等待设备上线的默认超时时间为 120 秒。

`device.prepareConfigure` 成功响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "设备可以配置",
  "data": {
    "deviceNo": "YT-AW-00000-A324",
    "provisionSessionId": "ps_20260606_xxx",
    "expiresAt": 1710000600000,
    "pollIntervalMs": 2000,
    "timeoutMs": 120000,
    "heartbeatIntervalMs": 30000,
    "wifiStatusTimeoutMs": 60000,
    "bleNamePrefix": "ytsh-"
  }
}
```

小程序通过 BLE 把 `provisionSessionId`、`apiUrl`、`secureProtocol`、`heartbeatIntervalMs` 和 Wi‑Fi 信息一并写给设备。`heartbeatIntervalMs` 是云端要求该设备入网后使用的心跳周期，设备后续 `telemetry.report` 应按此周期上报；云端也会按该周期计算离线超时。配网成功后，小程序不要直接绑定，而是轮询：

```text
POST /api type = device.checkProvisionStatus
```

请求：

```json
{
  "type": "device.checkProvisionStatus",
  "data": {
    "sessionToken": "用户登录态",
    "deviceNo": "YT-AW-00000-A324",
    "provisionSessionId": "ps_20260606_xxx"
  }
}
```

设备还未上云时返回：

```json
{
  "success": true,
  "code": "DEVICE_PROVISION_PENDING",
  "message": "正在等待设备上线",
  "data": {
    "online": false,
    "readyToBind": false,
    "provisionStatus": "pending"
  }
}
```

设备已通过 AES-128-CCM 认证上报 `provision.result` 后返回：

```json
{
  "success": true,
  "code": "DEVICE_READY_TO_BIND",
  "message": "设备已上线，可以绑定",
  "data": {
    "online": true,
    "readyToBind": true,
    "provisionStatus": "ready_to_bind",
    "lastOnlineAt": 1710000000000
  }
}
```

超时或会话过期时返回：

```json
{
  "success": false,
  "code": "DEVICE_PROVISION_TIMEOUT",
  "message": "设备未上线，请检查网络是否正常",
  "data": {
    "online": false,
    "readyToBind": false,
    "provisionStatus": "expired"
  }
}
```

只有 `device.checkProvisionStatus` 返回 `DEVICE_READY_TO_BIND` 后，小程序才调用 `device.bind`。`device.bind` 仍必须再次强校验：

1. 用户 `sessionToken` 有效。
2. `deviceNo` 存在且已注册。
3. 设备未被其他用户绑定。
4. `provisionSessionId` 属于当前用户和当前设备。
5. 配网会话未过期，状态为 `ready_to_bind`。
6. 设备最近一次认证上线时间足够新，例如 2 分钟内。
7. 设备 `provision.result` 已通过 AES-128-CCM tag 校验和 nonce/seq 防重放。

绑定成功后，配网会话标记为 `bound`，不允许再次使用。

临时会话清理规则：

- `pending` 且 `expiresAt < now`：标记为 `expired`。
- `ready_to_bind` 超过绑定窗口仍未绑定：标记为 `expired`，需要重新配网。
- 同一用户或同一设备创建配网会话应限流，避免恶意堆积。

#### 5.2.9 MQTTS 中的安全消息

正式 MQTTS 通信仍使用同一套 AES-128-CCM 安全信封。MQTTS 提供传输层加密，YTS-SEC/1 提供设备级应用层认证和端到端数据保护。

设备上行 Topic：

```text
yt/v1/devices/{deviceNo}/up
```

Payload：

```json
{
  "v": 1,
  "alg": "AES-128-CCM",
  "deviceNo": "YT-AW-00000-A324",
  "keyId": "k1",
  "msgType": "provision.result",
  "seq": 1,
  "ts": 1710000000000,
  "nonce": "base64url(13字节nonce)",
  "ciphertext": "base64url(AES-CCM密文)",
  "tag": "base64url(16字节认证标签)"
}
```

如果配网失败，设备可通过 BLE Notify 返回失败，也可在下次可联网时通过同一安全消息上报：

```json
{
  "provisionSessionId": "ps_20260606_xxx",
  "result": "failed",
  "code": "WIFI_AUTH_FAILED",
  "message": "Wi-Fi password is incorrect"
}
```

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

### 5.4 MQTT 登录凭据

`deviceKey` 是 eFuse 中的 AES-128-CCM 密钥，不是 MQTT 密码。由于 CPU 不能读取 `deviceKey`，也不能把它直接填入 MQTT CONNECT password。

推荐方案：

1. 设备先通过 HTTPS `device.secureMessage` 上报 `bootstrap.request` 或 `provision.result`。
2. 云端完成 AES-128-CCM 认证解密后，在加密响应 payload 中下发短期 MQTT 登录凭据。
3. 设备使用该短期凭据连接 MQTTS Broker。
4. Broker 通过 ACL 限制该凭据只能访问本设备 Topic。

短期凭据示例，即 `bootstrap.ack` 或 `provision.ack` 解密后的 payload：

```json
{
  "mqtt": {
    "host": "mqtt.yutingsmarthome.xin",
    "port": 8883,
    "clientId": "yt_YT-AW-00000-A324",
    "username": "YT-AW-00000-A324",
    "password": "短期BrokerToken",
    "expiresAt": 1710003600000
  }
}
```

MVP 如果暂时无法动态签发 Broker token，可以使用单独生产烧录的 `brokerPassword`，但必须满足：

- `brokerPassword` 不能等于 eFuse AES `deviceKey`。
- `brokerPassword` 不能写入小程序、二维码或用户可见位置。
- 服务器端只保存加密值或哈希校验值，不明文散落在日志中。
- Broker ACL 根据设备号限制 Topic 读写范围。
- 应尽快迁移到短期 token 或 mTLS。

ACL 规则示例：

| 方向 | Topic | 权限 |
| --- | --- | --- |
| 设备发布 | `yt/v1/devices/{deviceNo}/up` | 只允许本设备 |
| 设备发布 | `yt/v1/devices/{deviceNo}/status` | 只允许本设备 |
| 设备订阅 | `yt/v1/devices/{deviceNo}/down` | 只允许本设备 |
| 云端发布 | `yt/v1/devices/{deviceNo}/down` | 只允许云端服务账号 |
| 云端订阅 | `yt/v1/devices/{deviceNo}/up` | 只允许云端服务账号或消息消费服务 |
| 禁止 | `yt/v1/devices/+/+` 中其它设备 Topic | 设备账号不得跨设备访问 |

## 6. Topic 设计

统一前缀：

```text
yt/v1/devices/{deviceNo}
```

正式通信推荐使用统一上下行 Topic，业务类型由 AES-CCM 安全信封中的 `msgType` 区分：

| Topic | 方向 | Retain | 说明 |
| --- | --- | --- | --- |
| `yt/v1/devices/{deviceNo}/up` | 设备 -> 云端 | 否 | 上行安全消息，包含入网结果、心跳、遥测、事件、ACK |
| `yt/v1/devices/{deviceNo}/down` | 云端 -> 设备 | 否 | 下行安全消息，包含控制指令和配置下发 |
| `yt/v1/devices/{deviceNo}/status` | 设备 -> 云端 | 是 | 在线/离线状态，含 Last Will；payload 也应使用 YTS-SEC/1 |

历史上可按 `telemetry`、`event`、`command`、`command/ack` 拆分 Topic；首版为了简化 ACL 和设备端订阅，建议统一到 `up/down/status`。

## 7. 消息信封

正式线上消息使用 `YTS-SEC/1` AES-128-CCM 安全信封，格式见 5.2.3。旧的 `YTP/1` 普通 JSON 信封只能用于本地实验或未接入密钥前的调试日志，不得作为正式设备上云认证方案。

业务类型映射到安全信封的 `msgType`：

| 层级 | 业务 | 上下行 | `msgType` | MQTT Topic | 是否参与绑定 |
| --- | --- | --- | --- | --- | --- |
| 通用 | 配网成功/失败 | 上行 | `provision.result` | `yt/v1/devices/{deviceNo}/up` | 是 |
| 通用 | 配网确认 | 下行 | `provision.ack` | HTTPS 响应或 `yt/v1/devices/{deviceNo}/down` | 否 |
| 通用 | 设备启动/重连 | 上行 | `device.boot` | `yt/v1/devices/{deviceNo}/up` | 否 |
| 通用 | 在线/离线 | 上行 | `device.status` | `yt/v1/devices/{deviceNo}/status` | 否 |
| 通用 + 扩展 | 心跳/遥测 | 上行 | `telemetry.report` | `yt/v1/devices/{deviceNo}/up` | 否 |
| 通用 + 扩展 | 设备错误 | 上行 | `error.report` | `yt/v1/devices/{deviceNo}/up` | 否 |
| 通用 + 扩展 | 指令确认 | 上行 | `command.ack` | `yt/v1/devices/{deviceNo}/up` | 否 |
| 设备专项 | 控制指令 | 下行 | `{deviceType}.{command}` | `yt/v1/devices/{deviceNo}/down` | 否 |

通用消息适用于所有智能设备，设备端首版必须优先实现。`telemetry.report`、`error.report` 和 `command.ack` 的外层结构基本一致，但其中 `state`、`metrics`、`fault`、`commandType` 等业务字段可以按设备类型扩展。具体控制指令暂不在本文档定义，后续设计具体设备时再单独规划。

后续章节中的 JSON 示例均表示 AES-CCM 解密后的明文 `payload` 或业务对象；实际 MQTT/HTTPS 线上传输必须包在安全信封中。

当前详细程度：

| `msgType` | 当前定义程度 | 说明 |
| --- | --- | --- |
| `provision.result` | 通用，已详细定义 | 所有设备一致；字段表、成功/失败 payload、错误码、服务端处理和 `provision.ack` 已定义 |
| `provision.ack` | 通用，已详细定义 | 所有设备一致；作为服务端对 `provision.result` 的加密响应 payload |
| `device.boot` | 通用，已定义核心字段 | 所有设备一致；启动/重连原因、固件、网络信息 |
| `device.status` | 通用，已定义核心字段 | 所有设备一致；retained 在线/离线状态，主要用于在线展示和 Last Will |
| `telemetry.report` | 通用骨架 + 设备扩展，已定义 | 基础心跳字段所有设备一致；`state` / `metrics` 按设备类型扩展 |
| `error.report` | 通用骨架 + 设备扩展，已定义 | 错误级别、模块、错误码结构一致；具体故障原因按设备类型扩展 |
| `command.ack` | 通用骨架，已定义 | ACK 结构一致；具体 `commandType` 等控制命令按设备类型定义 |
| `{deviceType}.{command}` | 设备专项定义 | 浇水设备已在 `watering-control-sync-design.md` 中定义能力驱动配置、手动控制和命令状态机；其它设备后续补充 |

云端应按 `deviceNo + nonce` 做防重放，并按业务 payload 中的 `cmdId` / `eventId` 做幂等处理，避免网络重发造成重复执行。

## 8. 在线状态

设备 MQTT CONNECT 时配置 Last Will。

Topic：

```text
yt/v1/devices/{deviceNo}/status
```

Will 的 `msgType` 为 `device.status`，实际 payload 是预先用 AES-128-CCM 生成的 YTS-SEC/1 安全信封。解密后的明文 payload：

```json
{
  "online": false,
  "reason": "mqtt_lost"
}
```

设备连接成功后立即发布 retained 在线状态，`msgType` 同样为 `device.status`。解密后的明文 payload：

```json
{
  "online": true,
  "reason": "connected",
  "fwVersion": "0.1.0",
  "deviceType": "watering"
}
```

云端收到 retained offline 或连续 2 个心跳周期未收到 `telemetry.report` / `device.boot` / 在线 `device.status` 时，应把 `device_registry.online` 更新为 `0`，展示为“离线”。设备后续再次上报 `telemetry.report`、`device.boot` 或在线 `device.status` 后，云端应恢复为“在线”。

### 8.1 设备启动与重连 `device.boot`

`device.boot` 是所有智能设备一致的通用启动/重连协议。它只用于刷新在线状态、固件版本、网络诊断和启动原因，不承载具体设备业务状态，也不参与绑定。

设备每次断电重启、软件复位、Wi‑Fi 重连或 MQTT 重连后，应发送 `device.boot`。该消息用于刷新在线状态和诊断信息，不参与绑定。

安全信封中的 `msgType` 为 `device.boot`。解密后的明文 payload：

```json
{
  "bootReason": "power_on",
  "resetReason": "normal",
  "fwVersion": "0.1.0",
  "deviceType": "watering",
  "uptimeMs": 0,
  "network": {
    "wifiRssi": -58,
    "localIp": "192.168.1.24",
    "mac": "AA:BB:CC:DD:EE:FF"
  }
}
```

为简化设备端首版实现，`device.boot` 默认不要求携带 `capabilityVersion` 或 `capabilityHash`。如果固件升级、硬件检测结果变化或能力参数范围变化，设备应在本次 `device.boot` 中直接携带完整 `capabilities` 对象；云端收到完整能力后覆盖保存能力快照。

`bootReason` 建议值：

| 值 | 含义 |
| --- | --- |
| `power_on` | 断电后重新上电 |
| `software_reset` | 软件主动重启 |
| `watchdog_reset` | 看门狗复位 |
| `ota_reboot` | OTA 后重启 |
| `wifi_reconnect` | Wi‑Fi 断线后重连 |
| `mqtt_reconnect` | MQTT 重连 |

服务器收到 `device.boot` 后只更新 `online`、`lastOnlineAt`、固件版本和网络信息，不得把它当成 `ready_to_bind`。如果 payload 同时包含完整 `capabilities`，服务端按 `provision.result` 的能力保存规则更新 `capabilities_json` 和 `capability_state`。

### 8.2 MVP HTTPS 下行命令拉取 `command.pull`

正式环境推荐通过 MQTTS `down` Topic 下发命令；但在 MVP 阶段，如果 Broker、CA、短期 token 和 ACL 尚未全部就绪，设备可以先通过 HTTPS `device.secureMessage` 轮询拉取命令。该方案与 MQTTS 使用同一套 YTS-SEC/1 安全信封。

设备请求外层仍是 `POST /api type=device.secureMessage`，安全信封外层 `msgType` 固定为：

```text
command.pull
```

`command.pull` 解密后的明文 payload：

```json
{
  "maxCommands": 1,
  "supportedCommandTypes": [
    "watering.config.set",
    "watering.manual.start",
    "watering.manual.stop"
  ]
}
```

服务端响应使用 `direction=0x02` 的 nonce 单独加密整个响应 payload，安全信封 `msgType` 固定为：

```text
command.pull.ack
```

响应解密后的 payload 每次最多返回 1 条命令：

```json
{
  "serverTime": 1710000001000,
  "commands": [
    {
      "cmdId": "cmd_abc001",
      "commandType": "watering.config.set",
      "ttlSeconds": 60,
      "params": {
        "configVersion": 1,
        "configHash": "sha256(canonicalJson(config))",
        "config": {
          "schemaVersion": 1,
          "enabledFeatures": ["demandWatering"],
          "automationMode": "demandWatering",
          "features": {
            "demandWatering": {
              "checkIntervalHours": 4,
              "thresholdPercent": 35,
              "durationSeconds": 20
            }
          }
        }
      }
    }
  ]
}
```

没有命令时返回：

```json
{
  "serverTime": 1710000001000,
  "commands": []
}
```

MVP 规则：

1. `command.pull.ack` 加密整个 `commands` 数组；不要对数组中每条命令再单独套一层安全信封。
2. 每次最多返回 1 条命令，避免多命令 ACK、重试和顺序处理复杂化。
3. 服务端只返回 `supportedCommandTypes` 中设备声明支持的命令；设备未声明时，服务端按兼容模式处理。
4. 服务端把被返回的命令状态从 `queued` 更新为 `sent`。
5. 设备执行后必须单独上报 `command.ack`，`cmdId` 必须等于命令中的 `cmdId`。
6. 如果上一条命令已经进入 `received` 或 `executing` 且尚未终态，服务端下一次 `command.pull` 必须返回空数组，直到收到最终 ACK 或命令超时。
7. 服务端收到该命令最终 ACK 后，才会在下一次 `command.pull` 中返回后续命令。
8. 如果设备收到命令时已过 `ttlSeconds`，必须上报 `command.ack status=failed code=EXPIRED`。
9. 下行安全信封 AAD 中的 `msgType` 使用 `command.pull.ack`；命令具体类型放在解密后的 `commands[0].commandType`。

## 9. 遥测与心跳 `telemetry.report`

心跳周期由云端在 `device.prepareConfigure` 中通过 `heartbeatIntervalMs` 下发，并由小程序通过 BLE `provisionWifi` 转发给设备。默认建议每 30 秒上报一次；如果设备使用电池供电，可根据功耗策略调整为 60 - 300 秒。传感器变化明显、设备业务状态变化、故障发生或电池电量低时应立即额外上报。心跳报文的目标不是上传大量历史数据，而是让云端判断设备是否在线、网络是否稳定、电源是否正常、传感器和执行器是否健康。

Topic：

```text
yt/v1/devices/{deviceNo}/up
```

安全信封中的 `msgType` 为 `telemetry.report`。`telemetry.report` 分为通用基础字段和设备类型扩展字段：

- 通用基础字段：所有设备都应尽量保持一致，包括在线、运行时长、固件、网络、电源、电池和基础健康状态。
- 设备扩展字段：放在 `state`、`metrics`、`sensors` 中，字段名和含义按设备类型定义。例如浇水设备可以上报水泵、土壤湿度、水箱水位；灯控设备可以上报亮度、色温；插座设备可以上报功率、电流、电压。

解密后的明文 payload：

```json
{
  "reportId": "rpt_1710000000000_0001",
  "reportType": "periodic",
  "online": true,
  "uptimeMs": 360000,
  "fwVersion": "0.1.0",
  "deviceType": "watering",
  "deviceTime": 1710000000000,
  "network": {
    "wifiRssi": -55,
    "wifiQuality": 78,
    "localIp": "192.168.1.24",
    "mqttConnected": true,
    "mqttReconnectCount": 0,
    "cloudLatencyMs": 85
  },
  "power": {
    "powerSource": "dc",
    "batteryPercent": null,
    "batteryVoltageMv": null,
    "charging": false,
    "lowBattery": false
  },
  "health": {
    "status": "ok",
    "freeHeapBytes": 98304,
    "temperatureC": 36.5,
    "lastErrorCode": "",
    "watchdogResetCount": 0
  },
  "state": {
    "pumpOn": false,
    "automationMode": "demandWatering",
    "remainingSeconds": 0,
    "appliedConfigVersion": 2
  },
  "metrics": {
    "soilMoisturePercent": 42,
    "waterTankLevelPercent": null,
    "lastWateringAt": 1710000000000,
    "lastWateringDurationSeconds": 20
  },
  "sensors": {
    "soilMoistureRaw": 1870,
    "ambientTemperatureC": null,
    "ambientHumidityPercent": null
  }
}
```

心跳字段定义：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `reportId` | string | 建议 | 设备生成的遥测报文 ID，用于日志排查和幂等；可用时间戳加计数器 |
| `reportType` | string | 是 | `periodic`、`state_change`、`alarm`、`manual` |
| `online` | boolean | 是 | 设备认为自己当前在线；通常为 `true` |
| `uptimeMs` | number | 是 | 本次启动后运行毫秒数 |
| `fwVersion` | string | 建议 | 固件版本 |
| `deviceTime` | number | 否 | 设备本地毫秒时间戳；无 RTC 时可省略或用 0 |
| `network` | object | 是 | 通用网络状态 |
| `power` | object | 建议 | 通用电源/电池状态；市电或 DC 供电设备也应上报 `powerSource` |
| `health` | object | 建议 | 通用设备运行健康状态 |
| `state` | object | 建议 | 设备当前业务状态，按设备类型扩展 |
| `metrics` | object | 建议 | 设备业务指标，按设备类型扩展 |
| `sensors` | object | 建议 | 传感器读数，按设备类型扩展；没有的传感器填 `null` 或省略 |

`reportType` 取值：

| 值 | 含义 |
| --- | --- |
| `periodic` | 周期心跳 |
| `state_change` | 状态变化触发，例如执行器开/关、模式变化、联网重连 |
| `alarm` | 告警触发，例如低电量、传感器异常、执行器异常 |
| `manual` | 调试命令或设备按键触发 |

`network` 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `wifiRssi` | number | 建议 | Wi‑Fi RSSI，单位 dBm，例如 `-55` |
| `wifiQuality` | number | 否 | 0 - 100 的信号质量估算 |
| `localIp` | string | 否 | 局域网 IP |
| `mqttConnected` | boolean | MQTTS 模式建议 | MQTT 是否已连接 |
| `mqttReconnectCount` | number | 否 | 本次启动后的 MQTT 重连次数 |
| `cloudLatencyMs` | number | 否 | 最近一次云端 ping/ack 延迟 |

`power` 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `powerSource` | string | 是 | `battery`、`dc`、`usb`、`solar`、`unknown` |
| `batteryPercent` | number/null | 电池设备必填 | 电池电量 0 - 100；非电池设备填 `null` 或省略 |
| `batteryVoltageMv` | number/null | 电池设备建议 | 电池电压，单位 mV |
| `charging` | boolean | 否 | 是否正在充电 |
| `lowBattery` | boolean | 电池设备建议 | 是否低电量；云端可据此告警 |

对于智能浇水设备，如果是固定 DC 供电，可以这样上报：

```json
"power": {
  "powerSource": "dc",
  "batteryPercent": null,
  "batteryVoltageMv": null,
  "charging": false,
  "lowBattery": false
}
```

如果未来有电池版或太阳能版，必须上报 `batteryPercent` 和 `batteryVoltageMv`，低于阈值时同时发送 `reportType=alarm` 或 `error.report`。

`health` 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | string | 是 | `ok`、`warning`、`error` |
| `freeHeapBytes` | number | 否 | 剩余堆内存，便于排查内存泄漏 |
| `temperatureC` | number/null | 否 | MCU 或板载温度 |
| `lastErrorCode` | string | 否 | 最近一次错误码；无错误为空字符串 |
| `watchdogResetCount` | number | 否 | 本次或累计看门狗复位次数 |

`state` 和 `metrics` 是设备类型扩展区。通用云端可以只保存最近一份 JSON 快照，不强依赖内部字段；具体业务展示和控制闭环在对应设备专项协议中定义。

浇水设备扩展示例：

| 扩展区 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `state` | `automationMode` | string | 当前自动策略：`off`、`scheduleWatering`、`demandWatering`；仅表示设备当前运行策略，不表示小程序本地 tab |
| `state` | `pumpOn` | boolean | 水泵当前是否开启 |
| `state` | `remainingSeconds` | number | 当前浇水剩余秒数；未浇水为 0 |
| `state` | `appliedConfigVersion` | number | 设备当前已应用配置版本；未配置为 0 |
| `metrics` | `soilMoisturePercent` | number/null | 土壤湿度百分比，0 - 100；无传感器可为 `null`，不得伪造 |
| `metrics` | `waterTankLevelPercent` | number/null | 水箱水位百分比，0 - 100；无水位传感器可为 `null` |
| `metrics` | `lastWateringAt` | number | 最近一次浇水时间，毫秒时间戳；无 RTC 可为 0 |
| `metrics` | `lastWateringDurationSeconds` | number | 最近一次浇水持续秒数 |

其它设备扩展示例：

| 设备类型 | `state` 示例 | `metrics` 示例 |
| --- | --- | --- |
| 灯控 `light` | `powerOn`、`brightness`、`colorTemperature` | `switchCount`、`lastOnAt` |
| 插座 `socket` | `powerOn`、`relayState` | `voltageV`、`currentA`、`powerW`、`energyKwh` |
| 环境传感器 `sensor` | `sampling`、`alarmOn` | `temperatureC`、`humidityPercent`、`pm25` |
| 网关 `gateway` | `childOnlineCount`、`backhaulStatus` | `childTotalCount`、`uplinkLatencyMs` |

`sensors` 字段用于补充原始传感器读数，便于校准和售后排查。首版可以只包含设备已有的原始读数，没有的传感器不要伪造数值，应填 `null` 或省略。

云端处理要求：

1. 必须先通过 YTS-SEC/1 AES-128-CCM 验证并解密。
2. 更新设备 `online = true` 和最近在线时间。
3. 保存最近一份 telemetry 快照，供小程序展示和管理员排障。
4. 如果 `health.status != ok`、`power.lowBattery = true` 或 `reportType = alarm`，生成告警或等待后续 `error.report`。
5. 如果连续 2 个心跳周期未收到 `telemetry.report`、`device.boot` 或在线 `device.status`，云端必须判定设备离线；MQTT Last Will 的 retained offline 优先级更高。

MVP 阶段如果还没有真实传感器或执行器，可以使用模拟 `state` / `metrics` 快照做协议联调，但字段结构应保持稳定，不能频繁改通用协议字段。

### 9.1 设备错误上报 `error.report`

设备出现硬件故障、传感器异常、执行器异常或内部状态异常时，应发送 `error.report`。该消息用于告警和售后诊断，不参与绑定。

`error.report` 同样分为通用基础字段和设备类型扩展字段：

- 通用基础字段：`errorId`、`code`、`level`、`message`、`module`、`uptimeMs`、`deviceTime`。
- 设备扩展字段：放在 `fault`、`state`、`detail` 中，具体故障原因和上下文字段按设备类型定义。

解密后的明文 payload：

```json
{
  "errorId": "err_1710000000000_0001",
  "code": "ACTUATOR_ABNORMAL",
  "level": "error",
  "message": "actuator state abnormal",
  "module": "actuator",
  "uptimeMs": 520000,
  "deviceTime": 1710000000000,
  "fault": {
    "reason": "current_abnormal",
    "recoverable": true
  },
  "state": {},
  "detail": {}
}
```

字段定义：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `errorId` | string | 建议 | 设备生成的错误事件 ID，用于排查和幂等 |
| `code` | string | 是 | 错误码；通用大类稳定，设备专项错误码后续按设备定义 |
| `level` | string | 是 | `info`、`warning`、`error`、`critical` |
| `message` | string | 建议 | 面向日志的简短英文或拼音描述，不携带密钥、密码等敏感信息 |
| `module` | string | 建议 | `network`、`power`、`sensor`、`actuator`、`storage`、`security`、`firmware`、`unknown` |
| `uptimeMs` | number | 是 | 本次启动后运行毫秒数 |
| `deviceTime` | number | 否 | 设备本地毫秒时间戳；无 RTC 时可省略或用 0 |
| `fault` | object | 建议 | 故障原因扩展区，按设备类型定义 |
| `state` | object | 否 | 故障发生时的设备状态快照，按设备类型定义 |
| `detail` | object | 否 | 售后诊断细节，按设备类型定义 |

通用 `code` 大类建议：

| 错误码 | 含义 |
| --- | --- |
| `NETWORK_ERROR` | Wi‑Fi、DNS、MQTT、TLS 或云端连接异常 |
| `POWER_LOW` | 电池或供电异常 |
| `SENSOR_ABNORMAL` | 传感器读数缺失、越界或通信异常 |
| `ACTUATOR_ABNORMAL` | 执行器动作、反馈或电流等状态异常 |
| `SECURITY_ERROR` | 安全信封、nonce、认证或解密异常 |
| `FIRMWARE_ERROR` | 固件内部状态机、任务、内存或看门狗异常 |

具体设备可以在专项协议中定义更细的错误码，例如浇水设备可扩展水泵、水位、土壤湿度等故障原因；灯控设备可扩展亮度驱动、色温驱动等故障原因。

## 10. 设备专项控制指令

云端只在完成用户会话校验、设备归属校验和业务参数校验后，才允许向设备下发控制指令。下行消息必须使用 `direction=0x02` 的 AES-128-CCM nonce。

通用协议只规定控制指令的安全信封、统一命令骨架、ACK 规则和命名方式。具体设备的业务 payload 应在专项文档中定义。

当前已完成智能浇水设备专项控制与配置同步设计，详见：

- [`watering-control-sync-design.md`](./watering-control-sync-design.md)

| 设备类型 | 控制指令状态 | 专项文档内容 |
| --- | --- | --- |
| 浇水设备 `watering` | 已设计，待实现 | 设备能力上报、空配置首次体验、小程序按能力动态渲染、手动浇水、配置命令状态机、错误码、超时时间 |
| 灯控 `light` | 后续规划，不在本文定义 | 开关、亮度、色温、场景 |
| 插座 `socket` | 后续规划，不在本文定义 | 继电器开关、定时、功率保护 |
| 传感器 `sensor` | 后续规划，不在本文定义 | 采样周期、告警阈值 |
| 网关 `gateway` | 后续规划，不在本文定义 | 子设备发现、同步、转发 |

浇水设备当前建议的业务命令类型：

| commandType | 说明 |
| --- | --- |
| `watering.config.set` | 下发新的自动浇水配置 |
| `watering.manual.start` | 开始一次手动浇水 |
| `watering.manual.stop` | 停止当前浇水 |

所有具体控制指令应遵循统一骨架：

```json
{
  "cmdId": "cmd_abc001",
  "ttlSeconds": 60,
  "params": {}
}
```

字段要求：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `cmdId` | string | 是 | 云端生成的指令 ID，用于 ACK 幂等匹配 |
| `ttlSeconds` | number | 是 | 指令有效期，设备收到过期指令必须拒绝执行 |
| `params` | object | 是 | 具体设备专项参数 |

设备端实现浇水控制时，应以 `watering-control-sync-design.md` 为业务字段和状态机依据，以本文档的 `YTS-SEC/1` 为安全信封依据。

## 11. 指令 ACK 与状态查询

设备收到指令并通过 AES-128-CCM 认证解密后必须通过 `command.ack` 单独上报命令状态。HTTPS MVP 下，ACK 也通过 `POST /api type=device.secureMessage` 上报；MQTTS 阶段通过 `up` Topic 上报，安全信封完全一致。

ACK 状态取值：

| status | 含义 | 是否终态 | 服务端处理 |
| --- | --- | --- | --- |
| `received` | 设备已收到命令并通过基础校验 | 否 | `sent -> received`，记录 `received_at` |
| `executing` | 设备已开始执行命令 | 否 | `received/sent -> executing`，记录 `executing_at` |
| `succeeded` | 命令执行成功 | 是 | 记录 `ack_at`、`result_json`，配置命令更新 `appliedConfig` |
| `failed` | 命令执行失败 | 是 | 记录 `ack_at`、`result_code`、`failed_reason` |

兼容说明：设备若上报旧值 `success`，服务端按 `succeeded` 处理；设备若上报旧值 `ack`，服务端按 `received` 处理。

Topic：

```text
yt/v1/devices/{deviceNo}/up
```

安全信封中的 `msgType` 为 `command.ack`。

配置成功 ACK 解密后的明文 payload：

```json
{
  "cmdId": "cmd_abc001",
  "commandType": "watering.config.set",
  "status": "succeeded",
  "code": "OK",
  "message": "config applied",
  "applied": true,
  "appliedConfigVersion": 2,
  "appliedConfigHash": "sha256(canonicalJson(config))",
  "result": {
    "automationMode": "demandWatering"
  }
}
```

手动浇水成功 ACK 解密后的明文 payload：

```json
{
  "cmdId": "cmd_abc002",
  "commandType": "watering.manual.start",
  "status": "succeeded",
  "code": "OK",
  "message": "manual watering started",
  "applied": true,
  "result": {
    "durationSeconds": 10,
    "startedAt": 1710000001000
  }
}
```

失败 ACK 解密后的明文 payload：

```json
{
  "cmdId": "cmd_abc003",
  "commandType": "watering.manual.start",
  "status": "failed",
  "code": "BUSY",
  "message": "pump is already running",
  "applied": false,
  "result": {
    "pumpOn": true,
    "remainingSeconds": 12
  }
}
```

云端命令状态机：

| 云端状态 | 来源 | 含义 |
| --- | --- | --- |
| `queued` | 服务端 | 命令已创建，等待设备拉取或发布 |
| `sent` | 服务端 | 命令已通过 HTTPS pull 返回给设备，或已发布到 MQTTS down Topic |
| `received` | 设备 ACK | 设备确认收到并通过基础校验 |
| `executing` | 设备 ACK | 设备开始执行 |
| `succeeded` | 设备 ACK | 执行成功，终态 |
| `failed` | 设备 ACK | 执行失败，终态 |
| `delivery_timeout` | 服务端定时任务 | 已下发但超时未收到设备确认，终态 |
| `execution_timeout` | 服务端定时任务 | 已执行但超时未收到最终结果，终态 |
| `publish_failed` | 服务端 | MQTTS 发布失败，终态 |
| `expired` | 服务端或设备 | 命令超过 TTL 未执行，终态 |

小程序调用 `watering.saveConfig`、`watering.startManual`、`watering.stopManual` 成功，只表示服务端已接受并创建命令，不表示设备已执行。小程序必须调用 `device.getCommandStatus` 查询命令状态：

```json
{
  "type": "device.getCommandStatus",
  "data": {
    "sessionToken": "用户登录态",
    "deviceNo": "YT-AW-00000-A324",
    "commandId": "cmd_abc001"
  }
}
```

响应：

```json
{
  "success": true,
  "code": "OK",
  "data": {
    "command": {
      "id": "cmd_abc001",
      "deviceNo": "YT-AW-00000-A324",
      "commandType": "watering.config.set",
      "status": "succeeded",
      "statusText": "执行成功",
      "terminal": true,
      "createdAt": 1710000000000,
      "sentAt": 1710000001000,
      "ackAt": 1710000003000,
      "resultCode": "OK",
      "result": {}
    }
  }
}
```

云端收到 ACK 后更新 `device_commands.status`、`sent_at`、`received_at`、`executing_at`、`ack_at`、`result_code`、`result_json` 和 `failed_reason`。

## 12. 错误码

小程序和服务器之间的业务错误码必须稳定，设备端错误码和服务器内部诊断可以更细，但普通用户提示不能泄露密钥、生产台账或认证细节。

### 12.1 通用与登录

| 错误码 | 含义 | 小程序建议提示 |
| --- | --- | --- |
| `OK` | 成功 | 操作成功 |
| `INTERNAL_ERROR` | 服务器内部错误 | 服务器繁忙，请稍后重试 |
| `API_NOT_FOUND` | 接口不存在 | 当前版本暂不支持 |
| `SESSION_MISSING` | 未登录或未传登录态 | 请先登录 |
| `SESSION_EXPIRED` | 登录过期 | 登录已过期，请重新登录 |
| `SESSION_REVOKED` | 登录已注销 | 请重新登录 |
| `USER_DISABLED` | 账号不可用 | 账号不可用 |

### 12.2 设备号与绑定

| 错误码 | 含义 | 小程序建议提示 |
| --- | --- | --- |
| `DEVICE_NOT_BINDABLE` | 格式错误、CRC 错误、未生产或未注册 | 设备号不正确 |
| `DEVICE_NOT_FOUND` | 设备不存在 | 设备不存在 |
| `DEVICE_DISABLED` | 设备停用 | 设备暂不可用 |
| `DEVICE_ALREADY_BOUND` | 已被其他用户绑定 | 设备已被绑定 |
| `DEVICE_ALREADY_OWNED` | 已属于当前用户 | 该设备已经是你的设备 |
| `DEVICE_BIND_LOCKED` | 绑定失败过多，临时锁定 | 绑定失败次数过多，请稍后再试 |
| `DEVICE_BIND_CONFLICT` | 最终绑定时被其他用户抢先绑定 | 设备已被绑定 |
| `DEVICE_NOT_READY_TO_BIND` | 设备未完成认证上线 | 设备未上线，请检查网络 |
| `DEVICE_BIND_FAILED` | 绑定写库失败 | 绑定失败，请稍后重试 |

### 12.3 配网会话

| 错误码 | 含义 | 小程序建议提示 |
| --- | --- | --- |
| `PROVISION_SESSION_CREATED` | 配网会话已创建 | 可以开始配网 |
| `PROVISION_SESSION_NOT_FOUND` | 会话不存在 | 请重新配置设备 |
| `PROVISION_SESSION_EXPIRED` | 会话过期 | 配网超时，请重新配置 |
| `PROVISION_SESSION_MISMATCH` | 会话不属于当前用户或设备 | 请重新配置设备 |
| `DEVICE_PROVISION_PENDING` | 等待设备上线 | 正在等待设备上线 |
| `DEVICE_READY_TO_BIND` | 设备已上线且可绑定 | 可以绑定 |
| `DEVICE_PROVISION_TIMEOUT` | 设备未按时上线 | 设备未上线，请检查网络是否正常 |
| `DEVICE_PROVISION_REQUIRED` | 未完成配网认证就请求绑定 | 请先完成设备配置 |

### 12.4 设备安全消息

| 错误码 | 含义 | 小程序建议提示 |
| --- | --- | --- |
| `INVALID_PROTOCOL` | 协议版本不支持 | 设备协议版本不支持 |
| `INVALID_DEVICE` | 设备号不匹配或生产台账不存在 | 设备号不正确 |
| `INVALID_JSON` | JSON 解析失败 | 设备消息格式错误 |
| `INVALID_COMMAND` | 不支持的指令类型 | 指令不支持 |
| `DEVICE_AUTH_FAILED` | AES-128-CCM 认证解密失败，含 tag 校验失败 | 设备认证失败 |
| `DEVICE_REPLAY_DETECTED` | nonce、seq 或 `provisionSessionId` 重放 | 设备认证失败 |
| `DEVICE_KEY_NOT_FOUND` | 找不到设备密钥或 `keyId` 不支持 | 设备未注册或暂不可用 |
| `EXPIRED` | 指令超过 TTL | 指令已过期 |
| `BUSY` | 设备忙，例如正在执行互斥动作 | 设备忙，请稍后重试 |
| `HARDWARE_ERROR` | 继电器、水泵、传感器等硬件异常 | 设备硬件异常 |

## 13. 安全要求

- 小程序不能直连 MQTT Broker。
- 小程序不能保存设备密钥。
- 小程序不能仅凭设备号直接完成绑定，必须先完成 BLE 配网和设备云端 AES-128-CCM 认证。
- BLE 配网只传输临时 Wi‑Fi 凭据和配网会话信息，正式设备应尽量使用加密特征值或会话密钥降低近场窃听风险。
- 云端必须按用户与设备绑定关系校验控制权限。
- 设备 AES 密钥必须一机一密，长度固定 16 字节，生产写入 eFuse 或安全 key slot；测试阶段允许使用 eFuse 默认全 0 key，但只能用于测试设备和联调环境。
- 设备 CPU 不能读出 AES 密钥；设备端 CCM 实现只能通过硬件 AES 使用该密钥。
- `deviceKey` 只用于 YTS-SEC/1 AES-128-CCM，不得作为 MQTT password、二维码内容、日志字段或小程序参数。
- AES-CCM nonce 在同一密钥下绝不能重复，服务端必须做 nonce/seq 防重放。
- 服务端必须先通过 AES-128-CCM tag 校验和解密，才能接受设备上报、ACK 或配网结果。
- `device.bind` 必须检查服务端已确认的 `ready_to_bind` 配网会话，不能相信小程序传入的 `provisioned: true`。
- Broker 如启用必须配置 Topic ACL，防止设备订阅或发布其它设备 Topic。
- 正式环境如启用 MQTT，必须使用 MQTTS；MVP 阶段允许先用 HTTPS `device.secureMessage` 完成上报、拉取命令和 ACK。
- 服务端应记录控制指令、ACK、设备状态和管理员操作，形成售后排障证据链。
- 对同一设备的高频控制应限流，避免执行器被恶意或误操作频繁启动。

## 14. 设备端 MVP 实现范围

BL616CL 智能节点首版实现：

- 初始化 Wi-Fi、LwIP、FreeRTOS 和 Shell。
- 支持 BLE 配网模式，广播名称以 `ytsh-` 开头。
- 支持通过 BLE 接收并校验 `deviceNo`。
- 支持通过 BLE 接收 Wi‑Fi SSID、密码和配网会话信息。
- 支持通过 Shell 命令连接 Wi-Fi，作为实验室调试入口。
- 支持测试阶段使用 eFuse 默认全 0 的 16 字节 AES key；生产阶段必须烧录一机一随机 AES `deviceKey` 到 eFuse 或安全 key slot。
- 支持用硬件 AES 实现标准 AES-128-CCM，参数固定为 nonce 13 字节、tag 16 字节。
- 支持生成 `direction || bootRandom || seq` nonce，并保证同一启动内 seq 单调递增。
- 支持构造 5.2.4 定义的 AAD。
- 支持通过 HTTPS `device.secureMessage` 上报 `provision.result`，完成入网认证。
- 支持通过 HTTPS 或 MQTTS 上报 `device.boot`，用于断电重启、复位和重连诊断。
- 支持启动云端设备任务。
- HTTPS MVP 阶段使用 `device.secureMessage` 完成 `device.boot`、`telemetry.report`、`command.pull` 和 `command.ack`；如果同时启用 MQTT/MQTTS，MQTT 登录凭据不得使用 eFuse AES key 明文。
- 周期上报通用心跳，可在 `state` / `metrics` 中携带首版设备已有的模拟状态，payload 使用 YTS-SEC/1 安全信封。
- 支持通过 HTTPS `device.secureMessage` 发送 `command.pull`，拉取最多 1 条下行命令。
- 支持解密 `command.pull.ack` 响应，并执行 `watering.config.set`、`watering.manual.start`、`watering.manual.stop` 三类浇水命令。
- 支持通用 `command.ack` 骨架，payload 使用 YTS-SEC/1 安全信封，并至少上报最终状态 `succeeded` 或 `failed`。

首版暂不实现：

- BLE 配网加密握手和特征值权限强化。
- OTA 升级。
- MQTTS Broker 短期 token、设备 Topic ACL 和 CA 证书轮换；首版用 HTTPS `command.pull` 替代下行。
- 灯控、插座等其它设备专项控制协议。

## 15. 后续演进

建议按以下顺序演进：

1. 生产系统生成设备号、16 字节 AES `deviceKey`、`keyId` 和二维码。
2. 设备端完成 eFuse key slot 烧录、AES-128-CCM 标准互通测试和 nonce 防重放实现。
3. 服务端新增 `device.secureMessage`，根据 `deviceNo` + `keyId` 查密钥并做 AES-128-CCM 认证解密。
4. 服务端按 `device.secureMessage` 解密后的 `msgType=provision.result` 处理入网结果，把配网会话标记为 `ready_to_bind`。
5. 移除 `device.bind` 对小程序 `provisioned: true` 的信任，只接受服务端已认证的配网会话。
6. MVP 阶段先通过 HTTPS `command.pull` 完成下行；后续服务器部署 Mosquitto 或 EMQX，开放 MQTTS 8883。
7. 服务端新增 MQTTS 设备消息服务，消费遥测与 ACK，发布控制指令，并逐步替换 HTTPS 轮询下行。
8. 接入 OTA，支持 CA 证书、Broker 地址和固件升级。
9. 根据设备规模从 SQLite 迁移到 PostgreSQL 或 MySQL，并增加遥测归档策略。

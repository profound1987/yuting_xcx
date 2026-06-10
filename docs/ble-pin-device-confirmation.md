# BLE PIN 方案 B：给智能设备端的确认回复

更新时间：2026-06-09

本期 BLE 协议按“尽可能简单”原则确定如下。

## 1. 当前测试设备 PIN

当前测试向量使用：

```text
deviceNo = YT-AW-00000-A324
pin = 123456
```

该 PIN 作为协议测试向量固定输入，用于设备端校验算法是否一致。

测试向量：

```text
keyMaterial = YT-AW-00000-A324|123456|YUNTING-ZHIJIA-BLE-PIN-KEY-V1
SHA256(keyMaterial) = cb4defc2aa26e8286fcc69e6d8a58c36c207775550ce69cf84465e32ad6903ab
bleAesKey = cb4defc2aa26e8286fcc69e6d8a58c36
AES-CCM tag = b37950196d797f2ad41f4586825d668e
```

生产设备应使用随机 8 位 PIN，测试设备可先用 `123456` 对齐联调。

## 2. 是否兼容旧明文 BLE 命令？

本期正式联调不兼容旧明文命令：

```text
verifyDeviceNo
provisionWifi
control.command
```

正式流程只认：

```text
ble.hello              明文能力确认
provision.wifi         AES-CCM 加密下行
local.command          AES-CCM 加密下行
provision.wifi.status  明文 Notify
local.command.ack      明文 Notify
```

如果设备端为了调试想临时支持旧明文命令，可以放在固件开发开关里，但正式联调和出厂固件必须关闭。

## 3. ble.ready 是否明文 Notify？

是，`ble.ready` 是明文 Notify。

示例：

```json
{
  "type": "ble.ready",
  "proto": "YTS-BLE/1",
  "suite": "YTS-BLE-PIN-SHA256-AES128CCM-V1",
  "aead": "AES-128-CCM",
  "maxFrameBytes": 512
}
```

`ble.ready` 只表示设备支持协议，不表示 PIN 已验证。

真正的 PIN 验证发生在设备解密第一帧 AES-CCM 下行帧时：

```text
tag 校验成功 = PIN 正确 + 数据未被篡改
tag 校验失败 = PIN 错误或数据被篡改
```

## 4. Notify 是否也用加密外层字段？

本期不做加密 Notify。

所以设备上行 Notify 不使用：

```text
v/proto/msgType/seq/ts/nonce/ciphertext/tag
```

Notify 直接用明文 JSON 行即可。

Wi-Fi 成功：

```json
{
  "type": "provision.wifi.status",
  "status": "connected",
  "code": "OK",
  "message": "Wi-Fi connected"
}
```

Wi-Fi 失败：

```json
{
  "type": "provision.wifi.status",
  "status": "failed",
  "code": "WIFI_AUTH_FAILED",
  "message": "Wi-Fi password is incorrect"
}
```

本地控制 ACK：

```json
{
  "type": "local.command.ack",
  "cmdId": "ble_1710000000000_001",
  "commandType": "watering.manual.start",
  "status": "succeeded",
  "code": "OK",
  "message": "manual watering completed"
}
```

## 5. Notify 是否需要 12 字节 nonce？

不需要。

本期规则：

```text
小程序 -> 设备：AES-CCM 加密，需要 nonce
设备 -> 小程序 Notify：明文 JSON，不需要 nonce
```

所以设备端不需要生成上行 Notify nonce。

## 6. 小程序下行 AES-CCM nonce 怎么处理？

小程序下行加密帧会带：

```json
{
  "v": 1,
  "proto": "YTS-BLE/1",
  "msgType": "provision.wifi",
  "seq": 1,
  "ts": 1710000000000,
  "nonce": "hex(12B)",
  "ciphertext": "base64url(...)",
  "tag": "base64url(16B)"
}
```

设备端只需要：

1. 检查 `nonce` 是 12 字节。
2. 用它参与 AES-CCM 解密。
3. 在同一个 `bleAesKey` 下拒绝重复 `seq/nonce`。

设备端不需要解析 nonce 内部结构。

## 7. AAD 是否固定？

是，只用于小程序下行 AES-CCM。

AAD 固定为 canonical JSON，字段为：

```text
deviceNo
msgType
nonce
proto
seq
ts
```

字段按字典序输出，无多余空格，UTF-8 编码。

示例：

```json
{"deviceNo":"YT-AW-00000-A324","msgType":"provision.wifi","nonce":"000102030405060708090a0b","proto":"YTS-BLE/1","seq":1,"ts":1710000000000}
```

## 8. AES-CCM 还是 AES-ECB？

协议层必须是：

```text
AES-128-CCM
```

不要改成裸：

```text
AES-ECB
```

原因是 AES-ECB 没有 tag，无法判断 PIN 是否正确，也无法防止密文被篡改。

如果 MCU 只有 AES-ECB 单块硬件能力，可以用它作为底层 AES block primitive 来实现 CCM，但协议不能降级为裸 ECB。

## 9. watering.manual.start 的 BLE ACK 是否等浇水结束？

需要等命令执行完成以后再 ACK。

本期 BLE 本地控制 ACK 的含义是：

```text
设备已完成命令执行，并返回最终结果
```

所有 BLE 本地控制命令都必须在执行完成后返回终态 ACK；小程序收到终态 ACK 后才显示执行成功或失败，不再做下一次查询。

对于：

```text
watering.manual.start
```

设备应在 `durationSeconds` 对应的浇水动作结束后 Notify，并回显下行 `local.command` 里的 `cmdId`：

```json
{
  "type": "local.command.ack",
  "cmdId": "ble_1710000000000_001",
  "commandType": "watering.manual.start",
  "status": "succeeded",
  "code": "OK",
  "message": "manual watering completed"
}
```

如果执行失败、被中断或无法完成，应返回：

```json
{
  "type": "local.command.ack",
  "cmdId": "ble_1710000000000_001",
  "commandType": "watering.manual.start",
  "status": "failed",
  "code": "WATERING_INTERRUPTED",
  "message": "manual watering interrupted"
}
```

本期不要把 `accepted` / `executing` 当作最终 ACK 返回；如果设备端内部有“已接收/执行中”状态，可以自己记录，但给小程序的 `local.command.ack` 必须是最终 `succeeded` 或 `failed`。

设备后续恢复联网时仍可通过 `telemetry.report` 同步最新状态，但 BLE 本地控制结果必须由本次 `local.command.ack` 直接给出。

## 10. 本期是否实现 bleControlTicket？

本期暂不实现。

本期所有 BLE 配网和本地控制都只走 PIN 模式：

```text
bleAesKey = first16Bytes(SHA256(deviceNo + "|" + pin + "|" + fixedBleSalt))
```

固定 salt：

```text
YUNTING-ZHIJIA-BLE-PIN-KEY-V1
```

后续如果要增强离线控制授权，再单独扩展 `bleControlTicket`。本期设备端无需实现 ticket。

## 11. 设备端本期最小实现清单

设备端本期只需要实现以下内容：

1. 读取本机 `deviceNo` 和 PIN。
2. 固定内置 `fixedBleSalt = YUNTING-ZHIJIA-BLE-PIN-KEY-V1`。
3. 计算：

```text
bleAesKey = first16Bytes(SHA256(deviceNo + "|" + pin + "|" + fixedBleSalt))
```

4. 接收小程序明文 `ble.hello`，返回明文 `ble.ready`。
5. 接收小程序下行 AES-CCM 加密帧。
6. 用外层字段组 AAD：`deviceNo/msgType/nonce/proto/seq/ts`。
7. 用 `bleAesKey + nonce + AAD` 解密并校验 tag。
8. tag 校验失败时返回明文 Notify：

```json
{
  "type": "provision.wifi.status",
  "status": "failed",
  "code": "DEVICE_PIN_INVALID",
  "message": "device PIN invalid"
}
```

9. 解密 `provision.wifi` 后连接 Wi-Fi。
10. Wi-Fi 结果通过明文 Notify 返回 `provision.wifi.status`。
11. 解密 `local.command` 后执行本地低风险控制。
12. 命令执行完成后，通过明文 Notify 返回终态 `local.command.ack`（`succeeded` 或 `failed`），并回显下行 `cmdId`。
13. 暂不实现上行加密 Notify。
14. 暂不实现 `bleControlTicket`。
15. 暂不兼容旧明文 `verifyDeviceNo/provisionWifi/control.command`。

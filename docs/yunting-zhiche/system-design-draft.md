# 云汀智车智能车载 LED 显示设备设计初稿

更新时间：2026-06-16  
版本：v0.1 草案

## 1. 文档目标

本文是“云汀智车”车载 LED 显示设备的第一版系统设计初稿，重点先明确以下问题：

1. 设备**只有 BLE，没有 Wi‑Fi，不直接连接云端**。
2. 小程序名称和品牌为 **云汀智车**。
3. 设备绑定流程借鉴“云汀智家”智能浇水设备，但取消“设备连接云端并上报配网结果”这一步。
4. 设备编号、规格码、屏幕尺寸、生产台账和后续扩展方式需要先定清楚。
5. 标签不是预设枚举类型，用户可以在小程序上自定义标签名称和显示动画，再通过 BLE 写入设备。
6. BLE 协议必须支持几十 KB 到几百 KB 动画数据的稳定传输、断点续传、校验和应答。

本文先定义总体方案、设备命名与编号、设备配置流程、BLE 通信协议和大文件传输机制。小程序页面交互、UI、动画编辑器、Logo 细节后续单独设计。

## 2. 核心结论

### 2.1 设备通信边界

云汀智车 LED 设备本身不接入云端：

```text
云端服务器  <->  微信小程序  <->  BLE  <->  车载 LED 设备
          HTTPS             BLE GATT
```

职责边界：

| 模块 | 职责 |
| --- | --- |
| 云端服务器 | 用户登录、设备台账、设备绑定关系、售后审计、可选标签云端备份 |
| 微信小程序 | 用户交互、设备绑定、BLE 连接、动画编辑、动画数据传输、播放控制 |
| 车载 LED 设备 | BLE 通信、授权校验、标签/动画存储、LED 驱动、亮度控制、电源管理 |

设备不具备 Wi‑Fi，也不会主动连接 MQTT/HTTPS。因此云端不能通过“设备在线”判断绑定成功，必须改为“小程序通过 BLE 近场验证设备，然后把验证结果转交云端”的模式。

### 2.2 设备号高位编码 LED 规格

设备号建议使用：

```text
YT-SL-MNNNN-CCCC
```

其中：

- `SL` 表示 Smart LED / 智能 LED 显示设备。
- `M` 是 1 位十六进制 LED 规格码，范围 `0-F`，最多表达 16 种规格。
- `NNNN` 是该规格下的 4 位十六进制流水号，范围 `0000-FFFF`。
- `CCCC` 是带 salt 的 CRC32 短校验码。

这种方案可以接受，并且比用十进制高位更合理。因为 4 位十六进制流水号不是 1 万台，而是：

```text
0x0000 - 0xFFFF = 65,536 台 / 每个规格码
16 个规格码合计仍然是 1,048,576 台
```

因此采用：

```text
设备号 deviceNo：YT-SL-10000-XXXX
规格码 M：1
规格枚举：M=1 -> 32×16 RGB
能力 capabilities：由设备号规格码、生产台账和 BLE capability 共同确认
```

设计原则：

1. `deviceNo` 直接表达 LED 规格，便于生产、售后和用户识别。
2. 不再单独引入 `specCode` 字段，也不再引入 `modelCode` 字段。
3. 规格定义只通过设备号中的高位 `M` 做枚举。
4. 规格码一旦用于正式销售，不允许改变含义。
5. 如果未来 16 个规格不够，可以新增设备类型码或启用第二代编号规则。

## 3. 产品与品牌命名

### 3.1 小程序名称

```text
云汀智车
```

### 3.2 产品名称

建议正式产品名：

```text
云汀智车智能车载 LED 显示设备
```

短名称：

```text
云汀智车 LED 屏
```

### 3.3 设备类型码

建议新增设备类型码：

| 类型码 | 英文含义 | 中文名称 | 小程序内部类型 |
| --- | --- | --- | --- |
| `SL` | Smart LED Display | 车载 LED 显示设备 | `smart_led` |

> 说明：现有“云汀智家”已有 `LC` 表示智能灯控。车载 LED 显示设备不是普通灯控，建议单独使用 `SL`。

## 4. 设备编号与规格设计

### 4.1 设备号格式

沿用云汀设备编号体系，但对 `SL` 类型的 5 位流水号做产品内约定：

```text
YT-SL-MNNNN-CCCC
```

字段说明：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `YT` | `YT` | 云汀品牌前缀 |
| `SL` | `SL` | 车载 LED 显示设备类型码 |
| `M` | `1` | 1 位十六进制 LED 规格码，范围 `0-F` |
| `NNNN` | `0000` | 该规格下的 4 位十六进制流水号 |
| `CCCC` | `A1B2` | 带 salt 的 CRC32 短校验码 |

示例：

```text
YT-SL-10000-XXXX   M=1, serial=0000
YT-SL-10001-XXXX   M=1, serial=0001
YT-SL-2A2B3-XXXX   M=2, serial=A2B3
```

`CCCC` 仍按完整主体 `YT-SL-MNNNN` 参与 CRC32 计算，规格码 `M` 也是设备号主体的一部分。

### 4.2 LED 规格码枚举表

首版启用 `0-7` 共 8 种规格。规格码就是正式枚举，不再另设 `specCode` 字段或 `modelCode` 字段：

| 规格码 `M` | 规格定义 | 说明 |
| --- | --- | --- |
| `0` | 16×16 RGB | 启用 |
| `1` | 32×16 RGB | 启用 |
| `2` | 48×16 RGB | 启用 |
| `3` | 64×16 RGB | 启用 |
| `4` | 80×16 RGB | 启用 |
| `5` | 96×16 RGB | 启用 |
| `6` | 112×16 RGB | 启用 |
| `7` | 128×16 RGB | 启用 |
| `8` - `E` | 待定 | 留给后续规格 |
| `F` | 扩展 / 特殊批次 | 用于特殊项目或未来扩展 |

规则：

- 规格码 `M` 一旦用于正式销售，不允许改变含义。
- 小程序根据 `deviceNo` 的高位 `M` 判断屏幕分辨率、颜色能力、动画渲染模板和资源上限。
- 设备 BLE capability 必须返回与 `M` 一致的能力信息，供小程序二次确认。
- 云端生产台账只登记 `deviceNo`、规格码 `M` 及其枚举后的规格信息，不再登记 `modelCode`。
- 如果 `M=F`，必须在生产台账和本文档中登记明确用途，不能作为无限制自由规格。

### 4.3 设备规格信息来源

设备规格只来自规格码枚举：

```text
deviceNo = YT-SL-30000-5D76
M        = 3
规格     = 64×16 RGB
```

小程序、云端和设备端都必须使用同一份规格码枚举表。

推荐规格枚举字段：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `code` | `3` | 设备号高位规格码 |
| `width` | `64` | LED 矩阵宽度 |
| `height` | `16` | LED 矩阵高度 |
| `colorMode` | `RGB` | 颜色能力，例如 `MONO`、`DUAL`、`RGB` |
| `pixelFormat` | `RGB565` | 默认像素格式 |
| `maxAssetBytes` | `262144` | 单个动画资源上限 |
| `maxLabels` | `32` | 标签数量上限 |
| `description` | `64×16 RGB 标准款` | 展示和售后说明 |

### 4.4 设备铭牌与二维码内容

设备铭牌建议展示：

```text
产品：云汀智车 LED 屏
设备号：YT-SL-30000-5D76
规格：64×16 RGB
PIN：12345678
输入：DC 12V/24V
```

二维码建议使用 JSON：

```json
{
  "deviceNo": "YT-SL-30000-5D76",
  "pin": "52742481"
}
```

安全边界：

- `deviceNo` 用于识别设备，并可通过高位 `M` 推断 LED 规格。
- `pin` 用于 BLE 近场配置授权。
- 规格信息由 `deviceNo` 中的 `M` 枚举得到，不在二维码中单独携带规格字段。
- 二维码中不能包含设备主密钥、BLE owner key 或任何生产安全密钥。

### 4.5 后续扩展策略

采用 `MNNNN` 后，每个规格码容量为：

```text
0x0000 - 0xFFFF = 65,536 台
```

16 个规格码合计容量仍为：

```text
16 × 65,536 = 1,048,576 台
```

扩展策略：

1. 如果某个规格超过 65,536 台，可以从尚未启用的 `8-E` 中分配第二个规格码，但必须先更新统一规格表、服务器和固件，已发布规格码不得改义。
2. 如果 16 个规格不够，可以新增设备类型码，例如 `S2` 表示第二代车载 LED 显示设备。
3. 如果只是硬件小改版、Flash 容量变化或外壳变化，原则上应评估是否需要占用新规格码；若用户和小程序无需感知，可保持同一规格码，在生产台账内部记录批次号。
4. `F` 建议预留为扩展或特殊批次，避免首版就用满。

MVP 阶段建议先统一使用 `YT-SL-MNNNN-CCCC`，并只启用少量规格码。

## 5. 设备配置与绑定流程

### 5.1 重要差异

智能浇水设备的完整流程是：

```text
小程序登录 -> 扫码 -> BLE 配 Wi‑Fi -> 设备连接云端 -> 云端确认设备上线 -> 最终绑定
```

云汀智车 LED 设备没有 Wi‑Fi，所以流程改为：

```text
小程序登录 -> 扫码 -> 云端创建 BLE 绑定会话 -> 小程序连接 BLE -> 设备本地身份验证 -> 小程序转交验证结果给云端 -> 最终绑定
```

### 5.2 推荐正式绑定流程

```text
1. 用户登录云汀智车小程序。
2. 用户扫描设备二维码，得到 deviceNo 和 PIN。
3. 小程序从 deviceNo 解析规格码 `M`，并按规格枚举表得到屏幕尺寸和颜色能力。
4. 小程序调用云端 device.prepareBleBind。
5. 云端检查：设备号合法、已生产、未绑定、用户状态正常。
6. 云端返回 bindSessionId、challenge、过期时间。
7. 小程序扫描 BLE 广播并连接目标设备。
8. 小程序与设备使用 deviceNo + PIN 派生 BLE PIN key。
9. 小程序向设备发送 bind.challenge。
10. 设备返回 deviceLocalProof 和 capability。
11. 小程序把 deviceLocalProof 发送给云端 device.verifyBleProof。
12. 云端验证 proof 通过后，生成 bleOwnerKey 或 bleAccessKey。
13. 小程序通过 PIN 加密会话把 bleOwnerKey 写入设备。
14. 设备保存 bleOwnerKey，返回 bind.apply.ack。
15. 小程序调用 device.finishBleBind。
16. 云端写入设备绑定关系。
17. 后续控制不再使用 PIN，而使用 bleOwnerKey 建立 BLE 控制会话。
```

### 5.3 为什么需要 bleOwnerKey

如果设备长期只使用铭牌上的 PIN 控制，会有风险：

- PIN 可能被拍照、泄露或被二手流转。
- 设备已经被某个账号绑定后，其他人仍可能凭 PIN 直接控制 BLE。
- 设备没有云端连接，无法实时向服务器查询“当前用户是否有权限”。

因此建议：

| 阶段 | 使用密钥 | 说明 |
| --- | --- | --- |
| 出厂未绑定 | PIN 派生 key | 只用于首次绑定、恢复出厂后的重新绑定 |
| 已绑定 | bleOwnerKey | 用于日常播放、上传动画、删除标签、修改亮度 |
| 解绑/恢复出厂 | 清除 bleOwnerKey | 设备回到可绑定状态 |

小程序登录后，可以从云端获取当前用户拥有设备的 `bleOwnerKey` 加密副本或经会话保护的访问凭据。设备本身不连接云端，但小程序可以作为授权桥梁。

### 5.4 MVP 简化方案

如果第一版固件想降低复杂度，可以先做：

```text
deviceNo + PIN -> BLE 加密 -> 绑定成功
```

但正式上市版本建议加入 `bleOwnerKey`，否则 BLE-only 设备的权限边界偏弱。

## 6. 设备能力与配置模型

### 6.1 设备能力 capability

设备 BLE 连接后必须返回能力信息。能力信息必须和设备号高位规格码 `M` 对应的规格枚举一致，示例：

```json
{
  "type": "device.capability",
  "deviceNo": "YT-SL-10000-XXXX",
  "spec": {
    "code": "1",
    "width": 64,
    "height": 16,
    "colorMode": "RGB",
    "pixelFormat": "RGB565"
  },
  "fwVersion": "1.0.0",
  "hwVersion": "A1",
  "matrix": {
    "width": 64,
    "height": 16,
    "scan": "row-major",
    "origin": "left-top"
  },
  "color": {
    "mode": "RGB",
    "pixelFormat": "RGB565"
  },
  "storage": {
    "totalBytes": 1048576,
    "freeBytes": 786432,
    "maxAssetBytes": 262144,
    "maxLabels": 32
  },
  "ble": {
    "proto": "YTZC-BLE/1",
    "maxFrameBytes": 512,
    "preferredChunkBytes": 384,
    "ackWindowChunks": 8,
    "resumeSupported": true
  },
  "features": {
    "autoBrightness": true,
    "manualBrightness": true,
    "orientation": true,
    "compression": ["raw", "rle", "heatshrink"]
  }
}
```

### 6.2 设备配置项

设备配置不包含 Wi‑Fi，主要包括：

| 配置项 | 说明 |
| --- | --- |
| 设备名称 | 用户自定义，例如“后窗 LED 屏” |
| 屏幕方向 | 正装、倒装、左右镜像 |
| 亮度模式 | 自动亮度 / 手动亮度 |
| 白天亮度 | 例如 80% |
| 夜间亮度 | 例如 20% |
| 最大亮度限制 | 防止夜间刺眼 |
| 默认标签 | 上电后默认显示或默认空闲 |
| 空闲策略 | 熄屏、低亮待机、显示默认图案 |
| 标签列表 | 用户自定义标签及对应动画资源 |
| 存储清理策略 | 空间不足时是否允许删除未使用资源 |

### 6.3 标签模型

标签不预定义业务 type。用户在小程序里创建标签，设备只保存标签元数据和动画资源。

标签示例：

```json
{
  "labelId": "lbl_01HYABCDEFG123456",
  "name": "请让行",
  "assetId": "ast_01HYABCDEFG999999",
  "enabled": true,
  "sortOrder": 10,
  "play": {
    "loop": false,
    "repeat": 1,
    "defaultDurationMs": 5000
  },
  "createdAt": 1781539200000,
  "updatedAt": 1781539200000
}
```

说明：

- `name` 是用户在小程序里填写的标签名称。
- `labelId` 由小程序生成，建议使用 UUID/ULID，不使用固定枚举。
- `assetId` 指向一份动画数据。
- 小程序点击标签时，只发送通用播放命令 `label.play`，不发送“左转/右转/感谢”这种预定义业务 type。

播放命令示例：

```json
{
  "type": "label.play",
  "cmdId": "cmd_1781539200000_001",
  "labelId": "lbl_01HYABCDEFG123456",
  "mode": "restart"
}
```

停止命令示例：

```json
{
  "type": "label.stop",
  "cmdId": "cmd_1781539200000_002"
}
```

## 7. 动画资源格式

### 7.1 基本原则

设备不理解“左转”“感谢”“请让行”等业务语义。小程序负责把用户编辑的文字、图标、动画渲染成设备可播放的数据。

设备侧只关心：

- 分辨率是否匹配。
- 色彩格式是否支持。
- 帧率是否支持。
- 数据大小是否可存储。
- 校验是否通过。
- 播放参数是否有效。

### 7.2 动画资源 manifest

每份动画资源都有一个 manifest：

```json
{
  "assetId": "ast_01HYABCDEFG999999",
  "format": "YTAF/1",
  "name": "请让行动画",
  "matrix": {
    "width": 64,
    "height": 16
  },
  "pixelFormat": "RGB565",
  "frameCount": 48,
  "fps": 12,
  "durationMs": 4000,
  "encoding": "rle",
  "payloadBytes": 58320,
  "sha256": "hex-string",
  "createdBy": "miniprogram",
  "createdAt": 1781539200000
}
```

### 7.3 建议动画文件格式 `YTAF/1`

`YTAF/1` 表示 Yunting Animation Format v1。MVP 阶段可以先简单设计为：

```text
Header JSON 长度 + Header JSON + 二进制帧数据
```

Header JSON 包含：

| 字段 | 说明 |
| --- | --- |
| `format` | 固定 `YTAF/1` |
| `width` / `height` | 画布尺寸 |
| `pixelFormat` | `MONO1`、`RGB565`、`RGB888` 等 |
| `frameCount` | 帧数 |
| `fps` | 帧率 |
| `encoding` | `raw`、`rle`、`heatshrink` 等 |
| `frameTable` | 每帧偏移、长度、持续时间 |
| `payloadSha256` | 帧数据哈希 |

MVP 建议：

1. 第一阶段支持 `raw` 和 `rle`。
2. 如果 BLE 传输压力大，再加入轻量压缩，例如 heatshrink。
3. 文本、箭头、图标等编辑能力尽量放在小程序端实现，设备端只播放像素帧，降低固件复杂度。

## 8. BLE 协议总体设计

### 8.1 协议名称

建议云汀智车 BLE 协议名：

```text
YTZC-BLE/1
```

安全派生方案：

```text
YTZC-BLE-PIN/1       首次绑定 / 恢复出厂后的近场授权
YTZC-BLE-OWNER/1     已绑定后的日常控制授权
```

### 8.2 BLE GATT 服务

建议使用自定义 128-bit UUID。以下为草案占位，正式固件前需要固定：

| 名称 | UUID | 方向 | 说明 |
| --- | --- | --- | --- |
| YTZC LED Service | `xxxxxxxx-0000-1000-8000-00805f9b34fb` | - | 云汀智车 LED 服务 |
| Control Write | `xxxxxxxx-0001-1000-8000-00805f9b34fb` | 小程序 -> 设备 | 小 JSON 控制命令，加密 |
| Data Write | `xxxxxxxx-0002-1000-8000-00805f9b34fb` | 小程序 -> 设备 | 动画大数据分片，加密或带校验 |
| Notify | `xxxxxxxx-0003-1000-8000-00805f9b34fb` | 设备 -> 小程序 | ACK、进度、错误、能力信息 |

> 说明：也可以沿用现有 `FFF0/FFF1/FFF2` 的测试 UUID，但正式产品建议使用新的 128-bit UUID，避免和旧设备混淆。

### 8.3 BLE 广播名称

未绑定设备：

```text
ytzc-sl-XXXX
```

其中 `XXXX` 可使用设备号校验码或设备号后 4 位，便于用户识别。

已绑定设备：

```text
ytzc-sl-b-XXXX
```

或仍使用相同名称，但在 capability 中返回 `bindState=bound`。

### 8.4 小消息帧

控制类消息使用 JSON，外层经过 AES-CCM 加密。明文 payload 示例：

```json
{
  "type": "label.play",
  "cmdId": "cmd_1781539200000_001",
  "labelId": "lbl_01HYABCDEFG123456",
  "ts": 1781539200000
}
```

加密外层示例：

```json
{
  "v": 1,
  "proto": "YTZC-BLE/1",
  "sessionType": "owner",
  "msgType": "label.play",
  "seq": 101,
  "nonce": "hex(12B)",
  "ciphertext": "base64url(...) ",
  "tag": "base64url(16B)"
}
```

### 8.5 Key 派生

首次绑定 PIN key：

```text
fixedBleSalt = "YUNTING-ZHICHE-BLE-PIN-KEY-V1"
keyMaterial = deviceNo + "|" + pin + "|" + fixedBleSalt
pinKey = first16Bytes(SHA256(keyMaterial))
```

已绑定 owner key：

```text
ownerKey = 云端生成的 16 或 32 字节随机数
sessionKey = first16Bytes(SHA256(ownerKey + "|" + deviceNo + "|YTZC-BLE-OWNER-V1" + "|" + sessionNonce))
```

说明：

- PIN 只能用于首次绑定和恢复出厂。
- 日常控制、动画上传、删除标签、改亮度必须使用 owner session。
- 设备连续多次解密失败后应锁定 BLE 写入一段时间，例如 5 分钟。

## 9. 大动画数据 BLE 可靠传输协议

### 9.1 问题定义

用户自定义动画可能达到几十 KB 或几百 KB。BLE 单次写入受 MTU 限制，微信小程序端还会受到 iOS/Android 差异影响，因此不能简单“一次写完整 JSON”。必须支持：

- 分片传输。
- 每片校验。
- 窗口 ACK。
- 丢包重传。
- 断点续传。
- 最终 SHA-256 校验。
- 设备侧 staging 临时区，避免半包覆盖旧资源。
- 传输进度展示和失败重试。

### 9.2 传输阶段

大文件传输分为 6 个阶段：

```text
1. asset.prepare     准备传输，发送 manifest
2. asset.accept      设备确认容量、chunk 大小、transferId
3. asset.chunk       小程序发送分片
4. asset.ack         设备按窗口 ACK 已收到分片或缺失分片
5. asset.commit      小程序请求最终校验和提交
6. asset.commit.ack  设备校验 sha256 后原子替换资源
```

### 9.3 asset.prepare

小程序先发送 manifest：

```json
{
  "type": "asset.prepare",
  "assetId": "ast_01HYABCDEFG999999",
  "labelId": "lbl_01HYABCDEFG123456",
  "manifest": {
    "format": "YTAF/1",
    "width": 64,
    "height": 16,
    "pixelFormat": "RGB565",
    "frameCount": 48,
    "fps": 12,
    "encoding": "rle",
    "payloadBytes": 58320,
    "sha256": "hex-string"
  },
  "preferredChunkBytes": 384
}
```

设备检查：

- 分辨率是否匹配。
- 色彩格式是否支持。
- 单资源大小是否超限。
- 剩余 flash 是否足够。
- 标签数量是否超限。
- 是否已有同名资源需要覆盖。

返回：

```json
{
  "type": "asset.accept",
  "transferId": "tr_01HYABCDEFG888888",
  "assetId": "ast_01HYABCDEFG999999",
  "chunkBytes": 384,
  "chunksTotal": 152,
  "ackWindowChunks": 8,
  "resumeOffset": 0,
  "status": "accepted"
}
```

### 9.4 asset.chunk 二进制帧

动画数据分片建议走 `Data Write` 特征，使用二进制帧，减少 JSON/base64 开销。

草案帧结构：

```text
magic        2B   固定 0x59 0x43，表示 YC
version      1B   0x01
frameType    1B   0x10 = asset.chunk
flags        1B   bit0 encrypted, bit1 lastChunk
headerLen    1B   header 长度
seq          4B   小程序发送序号
transferNo   4B   transferId 的短编号，由设备 asset.accept 返回
chunkIndex   4B   分片序号，从 0 开始
payloadLen   2B   当前 payload 字节数
payload      NB   分片数据或加密后的分片数据
crc32        4B   对 header + payload 的 CRC32
```

MVP 如果二进制帧实现成本较高，也可以先用 JSON + base64，但几百 KB 传输效率会明显下降，不建议作为正式方案。

### 9.5 ACK 机制

设备不需要每片都 ACK，建议每 `ackWindowChunks` 片 ACK 一次。例如窗口为 8：

```json
{
  "type": "asset.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "receivedUntil": 63,
  "missing": [],
  "nextExpected": 64,
  "writtenBytes": 24576
}
```

如果缺片：

```json
{
  "type": "asset.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "receivedUntil": 71,
  "missing": [66, 69],
  "nextExpected": 72,
  "writtenBytes": 26880
}
```

小程序收到 `missing` 后优先重传缺失分片，再继续发送后续分片。

### 9.6 断点续传

如果 BLE 断开，小程序重新连接后发送：

```json
{
  "type": "asset.resume",
  "transferId": "tr_01HYABCDEFG888888",
  "assetId": "ast_01HYABCDEFG999999",
  "sha256": "hex-string"
}
```

设备返回：

```json
{
  "type": "asset.resume.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "status": "resumable",
  "receivedUntil": 95,
  "missing": [88, 91],
  "nextExpected": 96
}
```

若设备重启或 staging 区丢失：

```json
{
  "type": "asset.resume.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "status": "not_found",
  "message": "transfer staging not found"
}
```

小程序应重新从 `asset.prepare` 开始。

### 9.7 commit 与原子替换

全部分片发送完成后，小程序发送：

```json
{
  "type": "asset.commit",
  "transferId": "tr_01HYABCDEFG888888",
  "assetId": "ast_01HYABCDEFG999999",
  "sha256": "hex-string"
}
```

设备行为：

1. 停止接收该 transfer 的新分片。
2. 对 staging 文件计算 SHA-256。
3. 校验通过后写入资源表。
4. 如果是覆盖旧资源，先保留旧资源，确认新资源可读后再切换指针。
5. 返回 `asset.commit.ack`。

成功：

```json
{
  "type": "asset.commit.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "assetId": "ast_01HYABCDEFG999999",
  "status": "succeeded",
  "size": 58320
}
```

失败：

```json
{
  "type": "asset.commit.ack",
  "transferId": "tr_01HYABCDEFG888888",
  "assetId": "ast_01HYABCDEFG999999",
  "status": "failed",
  "code": "ASSET_SHA256_MISMATCH",
  "message": "asset checksum mismatch"
}
```

### 9.8 超时和重试建议

| 项目 | 建议值 |
| --- | --- |
| 单片大小 | 优先 384B，按 MTU 能力协商，可降到 128B/192B |
| ACK 窗口 | 4-16 片，默认 8 片 |
| 单窗口 ACK 超时 | 2-5 秒 |
| 单片重试次数 | 3 次 |
| 整体传输重试 | 允许用户手动继续/重试 |
| 传输中断保留 staging | 至少 10 分钟 |
| 最大单资源 | 由规格码 `M` 决定，64×16 MVP 建议 256KB |

### 9.9 传输进度

小程序进度不以“发送 API 调用成功”为准，而以设备 ACK 为准：

```text
进度 = 设备确认写入字节数 / payloadBytes
```

小程序页面应显示：

- 正在准备。
- 正在传输 35%。
- 正在校验。
- 写入成功。
- 传输中断，可继续。
- 空间不足/格式不支持/校验失败。

## 10. 标签写入与播放流程

### 10.1 新增或更新标签

```text
1. 用户在小程序编辑标签名称和动画。
2. 小程序根据设备 capability 渲染动画资源。
3. 小程序执行 asset.prepare / chunk / commit。
4. 资源写入成功后，小程序发送 label.upsert。
5. 设备保存 labelId、name、assetId、排序和播放参数。
6. 设备返回 label.upsert.ack。
```

`label.upsert` 示例：

```json
{
  "type": "label.upsert",
  "label": {
    "labelId": "lbl_01HYABCDEFG123456",
    "name": "请让行",
    "assetId": "ast_01HYABCDEFG999999",
    "sortOrder": 10,
    "play": {
      "loop": false,
      "repeat": 1,
      "defaultDurationMs": 5000
    }
  }
}
```

### 10.2 播放标签

小程序点击标签时：

```json
{
  "type": "label.play",
  "cmdId": "cmd_1781539200000_001",
  "labelId": "lbl_01HYABCDEFG123456"
}
```

设备返回：

```json
{
  "type": "label.play.ack",
  "cmdId": "cmd_1781539200000_001",
  "labelId": "lbl_01HYABCDEFG123456",
  "status": "succeeded"
}
```

如果标签不存在：

```json
{
  "type": "label.play.ack",
  "cmdId": "cmd_1781539200000_001",
  "labelId": "lbl_01HYABCDEFG123456",
  "status": "failed",
  "code": "LABEL_NOT_FOUND",
  "message": "label not found"
}
```

### 10.3 查询设备标签

小程序连接设备后可以查询设备内已有标签：

```json
{
  "type": "label.list",
  "cursor": "",
  "limit": 20
}
```

返回：

```json
{
  "type": "label.list.result",
  "labels": [
    {
      "labelId": "lbl_01HYABCDEFG123456",
      "name": "请让行",
      "assetId": "ast_01HYABCDEFG999999",
      "sortOrder": 10
    }
  ],
  "nextCursor": ""
}
```

## 11. 云端接口草案

设备不连接云端，但小程序仍需要云端完成用户和绑定管理。

建议新增接口类型：

| 接口 type | 说明 |
| --- | --- |
| `device.prepareBleBind` | 扫码后在共用服务器创建 BLE 绑定会话 |
| `device.verifyBleProof` | 小程序转交设备本地 proof，服务器验证 |
| `device.finishBleBind` | 设备写入 owner key 后在统一台账完成绑定 |
| `device.getBleCredential` | 已绑定用户获取 BLE 控制凭据（规划） |
| `device.updateAlias` | 修改设备名称（规划） |
| `device.saveLabelBackup` | 可选：备份标签 manifest 到云端（规划） |
| `device.listLabelBackups` | 可选：恢复标签列表（规划） |
| `device.recordControlEvent` | 可选：记录播放/上传/删除等操作审计（规划） |

与智能浇水设备的区别：

- 不需要 `device.checkProvisionStatus` 等待设备上云。
- 不需要 MQTT。
- 不需要 Wi‑Fi 配网。
- 不存在设备云端在线/离线状态，只有“小程序最近 BLE 连接时间”和“小程序上报的本地状态”。

## 12. 设备端存储建议

设备端建议划分：

```text
NVS / KV
  - deviceNo
  - ledSpecM
  - bindState
  - ownerKeyId
  - bleOwnerKey
  - deviceConfig
  - labelIndex

Flash Asset Area
  - staging 临时区
  - asset 文件区
  - asset 索引表
```

资源写入必须满足：

1. 先写 staging。
2. 校验通过后 commit。
3. commit 成功前不删除旧资源。
4. 掉电后能清理未完成 staging。
5. label 索引更新要有版本号或双备份，防止写一半掉电导致标签列表损坏。

## 13. 错误码草案

| code | 说明 |
| --- | --- |
| `OK` | 成功 |
| `DEVICE_NOT_BINDABLE` | 设备号不正确、未生产或不可绑定 |
| `DEVICE_ALREADY_BOUND` | 设备已被其他账号绑定 |
| `BLE_PIN_INVALID` | PIN 错误或 AES-CCM 解密失败 |
| `BLE_PIN_LOCKED` | PIN 错误过多，临时锁定 |
| `BLE_OWNER_AUTH_FAILED` | owner key 鉴权失败 |
| `CAPABILITY_NOT_MATCH` | 动画尺寸、颜色或格式不支持 |
| `ASSET_TOO_LARGE` | 动画资源过大 |
| `STORAGE_NOT_ENOUGH` | 设备存储空间不足 |
| `ASSET_CHUNK_CRC_FAILED` | 分片 CRC 校验失败 |
| `ASSET_SHA256_MISMATCH` | 最终 SHA-256 校验失败 |
| `TRANSFER_NOT_FOUND` | 断点续传找不到 staging |
| `TRANSFER_EXPIRED` | 传输会话已过期 |
| `LABEL_NOT_FOUND` | 标签不存在 |
| `LABEL_LIMIT_EXCEEDED` | 标签数量超过设备上限 |
| `DEVICE_BUSY` | 设备正在播放、写入或执行其他任务 |

## 14. MVP 开发建议

第一阶段建议优先实现：

1. `YT-SL-MNNNN-CCCC` 设备号和规格码枚举规则。
2. 共用服务器生产台账新增 `SL / smart_led` 类型。
3. 小程序扫码绑定入口，名称为“云汀智车”。
4. BLE 扫描、连接、capability 查询。
5. PIN 派生 key 和基本加密控制。
6. 标签模型：`labelId + name + assetId`。
7. 简单动画格式：64×16、RGB565、raw/rle。
8. 大文件分片传输：prepare/chunk/ack/commit。
9. 播放命令：`label.play`、`label.stop`。
10. 设备端 flash staging 和 sha256 校验。

第二阶段再做：

1. owner key 正式绑定权限体系。
2. 标签云端备份。
3. 多尺寸动画模板适配。
4. 自动亮度。
5. OTA 或有线升级方案。
6. 更复杂动画编辑器。
7. 售后审计后台。

## 15. 待确认问题

1. 首款硬件是否确定为 64×16？颜色是单色、双色还是 RGB？
2. MCU 和 flash 容量是多少？可用 asset 存储区能给多少？
3. LED 驱动是点阵屏模组、灯带矩阵，还是自研驱动板？
4. 是否有光敏传感器用于自动亮度？
5. 是否必须支持多手机控制同一设备？如果支持，需要云端分发 owner credential。
6. 是否需要二手转让流程？建议通过恢复出厂清除 owner key 后重新绑定。
7. 动画是否需要在设备端支持文字渲染，还是全部由小程序渲染成像素帧？MVP 建议小程序渲染。
8. 单个标签最大动画时长和最大资源大小需要根据 flash 和 BLE 速度实测确定。

# 设备类型与设备编号设计规范

## 1. 文档目标

本文档定义“云汀智家”设备类型、设备编号、手动输入绑定、扫码绑定和设备号校验规则。后续手机端、云端、生产烧录、二维码生成和售后管理都应使用同一套编号规范。

本文重点解决：

- 设备类型如何编码。
- 设备编号如何组成。
- 用户如何手动输入设备号。
- 用户如何扫描二维码获取设备号。
- 手机端和云端如何校验设备号是否合法。
- 带 salt 的 CRC32 校验码如何计算，并给出真实可验证示例。

## 2. 设备号总体格式

设备号使用固定格式：

```text
YT-XX-NNNNN-CCCC
```

字段含义：

| 字段 | 长度 | 示例 | 含义 |
| --- | --- | --- | --- |
| `YT` | 2 位 | `YT` | 品牌前缀，取“云汀”拼音首字母 |
| `XX` | 2 位 | `AW` | 设备类型码 |
| `NNNNN` | 5 位 | `00001` | 同类型设备流水编号，十六进制大写字符，左侧补零 |
| `CCCC` | 4 位 | `4BF5` | 带 salt 的 CRC32 短校验码，取完整 CRC32 的低 16 位 |

完整示例：

```text
YT-AW-00001-4BF5
```

含义：云汀智能浇水设备，类型码 `AW`，流水号 `00001`，带 salt 的 CRC32 短校验码 `4BF5`。

## 3. 设备类型码

设备类型码固定为 2 位大写英文字母。类型码一旦发布，不允许复用给其他设备类型。

| 类型码 | 英文含义 | 中文名称 | 小程序内部类型 |
| --- | --- | --- | --- |
| `AW` | Automatic Watering | 智能浇水设备 | `watering` |
| `ES` | Environmental Sensor | 环境传感器 | `sensor` |
| `LC` | Lighting Control | 智能灯控 | `light` |
| `SP` | Smart Plug | 智能插座 | `socket` |
| `GW` | Gateway | 智能网关 | `gateway` |

新增设备类型时，应先在本文档中登记类型码，再更新手机端、云端、生产系统和售后系统。

## 4. 流水编号规则

`NNNNN` 是同类型设备的生产流水编号，使用 5 位十六进制大写字符，范围为：

```text
00000 - FFFFF
```

规则：

- 同一个类型码下流水号必须唯一。
- 不同类型码可以使用相同流水号，例如 `YT-AW-00001-4BF5` 和 `YT-ES-00001-XXXX` 可以同时存在。
- 流水号固定 5 位，不足 5 位时左侧补 `0`。
- 流水号只允许 `0-9A-F`，手机端、云端和生产系统都应统一转为大写。
- `00000` 可用于开发和测试台账；正式销售批次是否使用 `00000` 应由生产系统单独控制。

### 4.1 Mock 测试设备段

本地 `mock` 模式暂时为 `AW`、`ES`、`LC`、`SP`、`GW` 五类设备各预置前 100 台测试设备。这里的“前 100 台”按十六进制解释，即 `00000` 到 `00063`，共 100 个流水号。

| 流水号范围 | 十进制数量 | Mock 状态 | 默认归属手机号 | 绑定行为 | 管理行为 |
| --- | --- | --- | --- | --- | --- |
| `00000` - `00031` | 50 台 | 已上线销售、未绑定、在线 | 无 | 允许测试人员使用真实手机号绑定 | 绑定后可编辑并保存配置 |
| `00032` - `0004A` | 25 台 | 已上线销售、已被其他账号绑定、在线 | `11111111111` | 拒绝绑定，手机端提示“设备已被绑定” | 当前账号不可管理 |
| `0004B` - `00063` | 25 台 | 已上线销售、已绑定、离线 | `00000000000` | 拒绝绑定，手机端提示“设备已被绑定” | 只读，不允许编辑和保存 |

说明：正式云端不应通过 `device.bind` 让用户绑定已属于他人的设备。开发版服务端会为 `00032` - `0004A` 建立默认已绑定在线用户 `11111111111`，为 `0004B` - `00063` 建立默认已绑定离线用户 `00000000000`，方便管理员按手机号或设备号查询测试台账。这两个手机号是系统测试号，不用于普通用户登录；真实环境中已绑定设备应通过 `device.list` 返回给设备所属用户。

可直接测试的 `AW` 设备号示例：

| 场景 | 完整设备号 |
| --- | --- |
| 未绑定在线起点 | `YT-AW-00000-A324` |
| 未绑定在线终点 | `YT-AW-00031-434A` |
| 已绑定在线起点 | `YT-AW-00032-7A39` |
| 已绑定在线终点 | `YT-AW-0004A-F86C` |
| 已绑定离线起点 | `YT-AW-0004B-C11F` |
| 已绑定离线终点 | `YT-AW-00063-8D68` |

## 5. 带 Salt 的 CRC32 校验码规则

### 5.1 校验目的

设备号末尾的 `CCCC` 用于发现用户手动输入错误、二维码内容损坏、流水号抄错等问题。

该校验码不是安全凭证，不能替代设备密钥或云端设备归属校验。客户端内嵌 salt 可以降低用户随意猜号的概率，但小程序前端代码可被分析，不能把它当作安全边界。正式防冒绑必须依赖云端设备台账、注册状态、绑定状态，以及设备通过 `YTS-SEC/1` AES-128-CCM 上报的 `provision.result` 认证结果。

### 5.2 被校验内容

参与 CRC32 计算的内容为设备号主体加版本 salt：

```text
YT-XX-NNNNN|SALT
```

示例：

```text
YT-AW-00001|YUNTING-ZHIJIA-DEVICE-CODE-V1
```

注意：

- 字母统一转为大写。
- 中间的连字符 `-` 参与计算。
- 主体与 salt 之间的竖线 `|` 参与计算。
- 末尾校验码 `CCCC` 不参与计算。

当前开发版 salt：

```text
YUNTING-ZHIJIA-DEVICE-CODE-V1
```

生产环境可按版本替换 salt。替换 salt 后，生产系统、云端校验、手机端校验和设备号示例必须同步更新。

### 5.3 CRC32 参数

使用标准 CRC-32/ISO-HDLC，也就是常见的 `zlib.crc32` 算法。

参数：

| 参数 | 值 |
| --- | --- |
| Width | 32 |
| Polynomial | `0x04C11DB7` |
| Reflected Polynomial | `0xEDB88320` |
| Initial Value | `0xFFFFFFFF` |
| RefIn | `true` |
| RefOut | `true` |
| XorOut | `0xFFFFFFFF` |
| 输入编码 | ASCII |
| 输出格式 | 8 位大写十六进制 |

### 5.4 短校验码取值

完整 CRC32 是 8 位十六进制。设备号为了简短，只展示低 16 位，也就是完整 CRC32 的最后 4 位。

```text
CHECK4 = CRC32(UPPER(YT-XX-NNNNN|SALT)).最后4位
```

示例：

```text
主体: YT-AW-00001
Salt: YUNTING-ZHIJIA-DEVICE-CODE-V1
参与计算: YT-AW-00001|YUNTING-ZHIJIA-DEVICE-CODE-V1
完整 CRC32: 25934BF5
短校验码: 4BF5
完整设备号: YT-AW-00001-4BF5
```

## 6. 真实可验证示例

以下示例使用本文档算法生成，可以用 Python `zlib.crc32` 或任意 CRC-32/ISO-HDLC 工具验证。

| 设备主体 | 完整 CRC32 | 短校验码 | 完整设备号 |
| --- | --- | --- | --- |
| `YT-AW-00001` | `25934BF5` | `4BF5` | `YT-AW-00001-4BF5` |
| `YT-ES-00027` | `0EE59FF2` | `9FF2` | `YT-ES-00027-9FF2` |
| `YT-LC-01234` | `FDA58832` | `8832` | `YT-LC-01234-8832` |
| `YT-SP-54321` | `D2AC9070` | `9070` | `YT-SP-54321-9070` |
| `YT-GW-00008` | `C79BE562` | `E562` | `YT-GW-00008-E562` |

Python 验证代码：

```python
import zlib

salt = "YUNTING-ZHIJIA-DEVICE-CODE-V1"
body = "YT-AW-00001"
payload = f"{body}|{salt}".upper().encode("ascii")
crc32_hex = f"{zlib.crc32(payload) & 0xffffffff:08X}"
check4 = crc32_hex[-4:]
device_no = f"{body}-{check4}"

print(crc32_hex)  # 25934BF5
print(check4)     # 4BF5
print(device_no)  # YT-AW-00001-4BF5
```

JavaScript 验证代码：

```js
function createCrc32Table() {
  const table = [];
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[index] = crc >>> 0;
  }
  return table;
}

function crc32(text) {
  const table = createCrc32Table();
  let crc = 0xffffffff;
  const input = text.toUpperCase();
  for (let index = 0; index < input.length; index += 1) {
    crc = table[(crc ^ input.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

const body = "YT-AW-00001";
const salt = "YUNTING-ZHIJIA-DEVICE-CODE-V1";
const crc32Hex = crc32(`${body}|${salt}`);
const check4 = crc32Hex.slice(4);
console.log(`${body}-${check4}`); // YT-AW-00001-4BF5
```

## 7. 手机端配置设备方式

用户看到的入口不再叫“绑定设备”，而是“配置设备”。配置设备包含读取设备号、校验设备归属、通过 BLE 给设备下发 Wi-Fi 信息、等待设备连接云端、最后由云端完成绑定。设备只有完成配网并成功连接云端后，才会出现在“我的设备”列表中。

### 7.1 手动输入设备号

用户可以在设备配置页面手动输入完整设备号。

手机端校验流程：

1. 去除首尾空格。
2. 将字母转为大写。
3. 使用正则校验格式：`^YT-[A-Z]{2}-[0-9A-F]{5}-[0-9A-F]{4}$`。
4. 解析类型码 `XX`。
5. 解析流水号 `NNNNN`。
6. 使用 `YT-XX-NNNNN|SALT` 重新计算 CRC32。
7. 取完整 CRC32 后 4 位，与输入的 `CCCC` 比对。
8. 校验通过后，根据类型码自动匹配设备类型。设备类型不需要用户手动选择。

校验失败时，手机端只提示“设备号不正确”。不要提示“CRC 错误”“校验码应为 XXXX”“类型码不支持”等细节，避免帮助攻击者反推校验规则。

### 7.2 扫描二维码

用户可以扫描设备机身、包装盒或说明书上的二维码获取设备号。

二维码内容推荐包含完整设备号和 PIN。PIN 是近场持有证明，不是设备密钥：

```json
{"deviceNo":"YT-AW-00001-4BF5","pin":"123456"}
```

也可以使用 URL，但 URL 中必须包含完整设备号和 PIN：

```text
https://iot.yunting.example/bind?deviceNo=YT-AW-00001-4BF5&pin=123456
```

手机端扫码后应从扫描结果中提取第一个匹配以下格式的设备号：

```text
YT-[A-Z]{2}-[0-9A-F]{5}-[0-9A-F]{4}
```

提取后仍必须执行完整带 salt 的 CRC32 校验，不能因为来自二维码就跳过校验。二维码内容校验失败时，同样只提示“设备号不正确”。PIN 不发送给云端，只在小程序和设备端本地用于 `YTS-BLE-PIN/1` 派生 BLE AES key；没有 PIN 时小程序不得进入 BLE 配网，PIN 错误时设备会因 AES-CCM tag 校验失败拒绝首个加密帧。

### 7.3 配置设备前的云端归属检查

手机端拿到合法设备号后，必须先请求云端检查设备是否可以进入配置流程。推荐新增只读接口：

```json
{
  "type": "device.prepareConfigure",
  "data": {
    "phone": "13800138000",
    "deviceNo": "YT-AW-00000-A324"
  }
}
```

云端检查结果：

| 场景 | 返回码 | 手机端处理 |
| --- | --- | --- |
| 设备号格式、CRC、类型、生产台账、注册状态不通过 | `DEVICE_NOT_BINDABLE` | 提示“设备号不正确”，结束配置流程 |
| 设备已绑定到其他用户 | `DEVICE_ALREADY_BOUND` | 提示“设备已被绑定，请联系管理员解绑”，结束配置流程 |
| 设备已绑定到当前用户 | `DEVICE_ALREADY_OWNED` | 提示“该设备已经是你的设备，可在设备管理中查看”，结束配置流程 |
| 设备已注册且未绑定 | `OK` | 允许进入 BLE 配网流程 |
| 当前账号异常或会话失效 | `SESSION_EXPIRED`/`USER_DISABLED` | 重新登录或提示联系服务方 |

该接口只判断“是否允许进入配置流程”，不能直接绑定设备，不能因为用户知道设备号就创建绑定关系。

### 7.4 BLE 配网流程

设备配置的目标是让真实设备连接家庭 Wi-Fi，并主动连接云端服务器。推荐流程如下：

1. 用户让设备进入配网模式：新设备开机后自动打开 BLE；旧设备需要长按按键或按说明恢复出厂设置后重新打开 BLE。
2. 小程序提示用户确认设备已进入配网模式。
3. 小程序初始化蓝牙模块并扫描附近 BLE 设备。
4. 只展示蓝牙名称以 `ytsh-` 开头的设备，表示 `YunTing Smart Home` 设备，例如 `ytsh-aw-00000`。
5. 用户选择一个 BLE 设备后，小程序连接该设备。
6. 小程序和设备通过 `YTS-BLE-PIN/1` 用设备号、PIN 和固定 BLE salt 派生 `YTS-BLE/1` 下行 AES-128-CCM key；PIN 参与 key 派生，但不发送给云端，也不直接出现在 BLE 明文中。
7. 设备使用本地烧录信息或设备安全区校验该设备号是否属于自己，并通过成功解密首个 AES-CCM 下行加密帧确认对方知道正确 PIN；设备 Notify 本期为明文 JSON 状态，不需要 nonce。
8. 设备号校验通过后，小程序检查手机当前 Wi-Fi 信息。
9. 如果手机没有连接 Wi-Fi，提示用户先连接 Wi-Fi。
10. 如果手机已连接 Wi-Fi，也必须让用户确认该 Wi-Fi 就是设备即将连接的网络。
11. 小程序要求用户输入 Wi-Fi 密码。
12. 小程序通过 `YTS-BLE/1` 加密 BLE 帧把 `ssid`、`password`、`deviceNo` 和必要的配网会话信息发送给设备；不得明文发送 PIN。
13. 设备尝试连接 Wi-Fi。
14. 设备连接云端服务器，完成设备认证，并上报在线状态。
15. 云端确认设备在线且处于可绑定状态后，小程序再调用 `device.bind` 完成最终绑定。
16. 小程序把绑定成功的设备加入当前账号设备列表。

设备类型由设备号类型码自动推导，不再由用户选择。设备名称仍由用户输入，是客户自己的显示名称；如果用户不输入，默认使用类型名称。

### 7.5 BLE 配网结果与错误码

BLE 配网过程中至少需要覆盖以下结果：

| 错误码 | 来源 | 用户提示 | 处理方式 |
| --- | --- | --- | --- |
| `BLE_NOT_AVAILABLE` | 手机 | 当前设备不支持或未开启蓝牙 | 引导用户开启蓝牙后重试 |
| `BLE_SCAN_TIMEOUT` | 手机 | 未发现可配置设备，请确认设备已进入配网模式 | 允许重新扫描 |
| `BLE_CONNECT_FAILED` | 手机/设备 | 蓝牙连接失败，请靠近设备后重试 | 允许重新连接 |
| `DEVICE_NO_MISMATCH` | 设备 | 设备号与当前设备不匹配 | 结束流程，避免误配 |
| `DEVICE_VERIFY_FAILED` | 设备 | 设备校验失败 | 结束流程，提示联系售后 |
| `WIFI_NOT_CONNECTED` | 手机 | 请先连接要给设备使用的 Wi-Fi | 暂停流程 |
| `WIFI_PASSWORD_REQUIRED` | 手机 | 请输入 Wi-Fi 密码 | 暂停流程 |
| `WIFI_SSID_NOT_FOUND` | 设备 | 设备未扫描到该 Wi-Fi，请检查路由器或网络名称 | 允许返回修改 Wi-Fi |
| `WIFI_AUTH_FAILED` | 设备 | Wi-Fi 连接失败，请检查密码 | 允许重新输入密码 |
| `WIFI_CONNECT_TIMEOUT` | 设备 | Wi-Fi 连接超时，请靠近路由器后重试 | 允许重试 |
| `CLOUD_CONNECT_FAILED` | 设备 | 设备无法连接云端服务器，请检查网络 | 允许重试 |
| `CLOUD_DEVICE_AUTH_FAILED` | 云端/设备 | 设备云端认证失败，请联系售后 | 结束流程 |
| `CLOUD_REPORT_TIMEOUT` | 小程序/云端 | 未收到设备上线确认，请稍后重试 | 允许查询或重试 |
| `PROVISION_TIMEOUT` | 小程序 | 配置超时，请重新配置 | 允许重试 |

只有设备已经连接 Wi-Fi、成功连接云端服务器、云端确认设备在线，并且 `device.bind` 返回成功，手机端才认为配置成功。不能因为 BLE 已经下发 Wi-Fi 就提前把设备标记为在线。

如果小程序已经扫描或连接到目标 BLE 设备，但 Wi-Fi 或云端认证失败，可以弹窗询问“是否先加入我的设备，下次再配网”。确认后调用 `device.addUnprovisioned`，设备进入 `provisionState=not_provisioned`，列表显示“未入网”，只显示重新“配网”入口和允许的 BLE 本地控制，不得显示为在线或离线。BLE 本地控制不走 MQTT，也不使用 MQTT Topic；它通过 `YTS-BLE/1` 加密 GATT 帧发送 `local.command`，业务字段复用云端命令的 `commandType/params/ttlSeconds`。

### 7.6 解绑后的设备处理

用户解绑设备时，小程序仍调用 `device.unbind` 清理云端归属。解绑成功后必须明确提示：

- 设备已从当前账号移除。
- 如果要让其他账号重新配置该设备，需要在设备端执行恢复出厂设置或长按进入配网模式。
- 设备端应清除本地 Wi-Fi、云端会话、用户绑定缓存和临时配网状态。

正式设备应在恢复出厂设置后重新打开 BLE，重新走完整配置流程。管理员强制解绑也应提醒售后或用户让设备恢复出厂设置，避免云端已解绑但设备仍保留旧 Wi-Fi 和旧会话。

## 8. 云端配置与绑定校验

手机端校验只用于减少用户输入错误。云端在 `device.prepareConfigure` 和最终 `device.bind` 时必须再次校验设备号。

云端 `device.prepareConfigure` 应执行：

1. 校验用户会话，得到当前 `userId`。
2. 标准化设备号，转大写。
3. 校验设备号格式和 CRC32 短校验码。
4. 根据类型码解析设备类型。
5. 查询设备生产台账或 `device_registry` 集合，确认设备已生产。
6. 确认设备已注册或已入库，状态允许配置。
7. 如果设备已绑定到其他用户，返回 `DEVICE_ALREADY_BOUND`。
8. 如果设备已绑定到当前用户，返回 `DEVICE_ALREADY_OWNED`。
9. 如果设备未绑定，返回允许配置，同时返回设备类型、类型名称、是否需要 BLE 配网等信息。

云端 `device.bind` 不再代表“用户知道设备号就可以绑定”，而是代表“设备已经完成配网并连接云端后提交最终绑定”。正式云端应执行：

1. 校验用户会话，得到当前 `userId`。
2. 标准化设备号，转大写。
3. 校验设备号格式和 CRC32 短校验码。
4. 根据类型码解析设备类型。
5. 查询设备生产台账或 `device_registry` 集合，确认设备已生产并已注册。
6. 确认设备未被其他用户绑定。
7. 校验设备端已经通过 BLE 配网并连接云端，例如最近一次设备上线时间、设备云端会话和配网会话 ID。
8. 校验设备通过 `YTS-SEC/1` AES-128-CCM 认证上报的 `provision.result`，证明上报来自真实设备，且配网会话状态为 `ready_to_bind`。
9. 绑定设备到当前 `userId`，保存用户输入的设备名称。
10. 创建绑定审计记录；浇水设备配置状态保持 `unconfigured`，不自动创建真实业务默认配置。
11. 返回绑定后的设备详情。

对手机端的错误返回需要区分用户可理解的业务状态，但不能泄露校验细节。设备号格式错误、CRC 错误、类型码错误、未生产、未注册、设备认证失败等情况，对普通用户统一返回：

```json
{
  "success": false,
  "code": "DEVICE_NOT_BINDABLE",
  "message": "设备号不正确",
  "data": null
}
```

设备已经被其他用户绑定时，返回：

```json
{
  "success": false,
  "code": "DEVICE_ALREADY_BOUND",
  "message": "设备已被绑定",
  "data": null
}
```

设备已经属于当前用户时，返回：

```json
{
  "success": false,
  "code": "DEVICE_ALREADY_OWNED",
  "message": "该设备已经是你的设备",
  "data": {
    "device": {}
  }
}
```

云端内部日志可以记录真实原因，例如 `CRC_MISMATCH`、`TYPE_NOT_SUPPORTED`、`NOT_PRODUCED`、`NOT_REGISTERED`、`BOUND_BY_OTHER_USER`、`DEVICE_NOT_ONLINE`、`PROVISION_SESSION_EXPIRED`、`AES_CCM_AUTH_FAILED`、`REPLAY_DETECTED`，但不要把 CRC 期望值、真实类型码列表、生产台账细节、密钥状态等直接返回给手机端。

只有设备号格式和 CRC32 校验通过，不代表设备一定属于当前用户。正式环境必须结合 BLE 近场连接、云端配网会话，以及设备 `YTS-SEC/1` AES-128-CCM 认证结果做所有权确认。

### 8.1 `device_registry` 生产台账建议

```json
{
  "_id": "registry_xxx",
  "deviceNo": "YT-AW-00001-4BF5",
  "typeCode": "AW",
  "serial": "00001",
  "keyId": "k1",
  "deviceKeyEncrypted": "encrypted_16byte_aes_key",
  "secureProtocol": "YTS-SEC/1-AES-128-CCM",
  "status": "registered",
  "bindStatus": "unbound",
  "online": true,
  "factoryBatch": "20260530-AW-01",
  "producedAt": 1780000000000,
  "registeredAt": 1780000000000,
  "ownerUserId": null,
  "boundAt": null
}
```

状态建议：

| 字段 | 可选值 | 说明 |
| --- | --- | --- |
| `status` | `produced` | 已生产但未入库注册，不允许用户绑定 |
| `status` | `registered` | 已入库注册，允许进入配置流程 |
| `status` | `disabled` | 设备停用，不允许配置或绑定 |
| `bindStatus` | `unbound` | 未绑定，可在归属检查通过后进入 BLE 配网 |
| `bindStatus` | `bound` | 已绑定 |
| `online` | `true` | 当前在线，允许配置同步和指令下发 |
| `online` | `false` | 当前离线，管理页只读，不允许保存配置或下发指令 |

用户配置设备时，云端 `device.prepareConfigure` 至少要求 `status = registered`，并根据 `bindStatus` 和 `ownerUserId` 判断是否允许进入 BLE 配网。最终 `device.bind` 至少要求设备已完成配网、已连接云端、云端认证通过、`bindStatus = unbound`。如果当前手机号对应的用户还不存在，云端应先创建用户，再执行最终绑定；只有用户创建成功、设备归属写入成功、绑定审计记录创建成功后，`device.bind` 才返回成功。浇水设备首次绑定后为未配置状态，由用户显式保存后再下发配置命令。

## 9. 设备管理与数据同步策略

设备详情页不能把“本地表单已修改”当作保存成功，也不能把“API 已接受命令”当作设备已执行。正式系统和 Mock 模式都应遵守以下规则：

1. 进入设备详情页时调用 `device.getStatus`，获取设备在线状态、能力、期望配置、已应用配置和最近同步时间。
2. 设备离线时，管理页进入只读状态，不允许切换浇水模式、编辑参数、保存配置或下发手动浇水指令。
3. 设备在线时，用户可以编辑参数，但点击保存后必须调用 `watering.saveConfig`。
4. `watering.saveConfig` 成功只表示云端已接受命令并返回 `commandId`；设备 ACK 成功后才显示“已同步”。
5. 手机端必须通过 `device.getCommandStatus` 查询命令状态，终态为 `succeeded` 后才更新本地“已同步”展示。
6. 如果设备离线、指令超时或设备拒绝配置，手机端不把本地表单内容记为已应用，只提示保存失败或设备离线。
7. 手动浇水同样必须先调用 `watering.startManual`，只有命令状态为 `succeeded` 或遥测显示 `pumpOn=true` 后，手机端才进入倒计时状态。
8. 手机端重新进入详情页时，以 `device.getStatus` 返回的 `desiredConfig`、`appliedConfig` 和 `configState` 为准。

Mock 模式会在本地模拟上述流程：在线设备保存成功后，参数写入 Mock 台账；离线设备返回失败，手机端保持只读。

## 10. 生产与二维码生成规范

生产系统生成设备号时应按以下顺序：

1. 选择设备类型码，例如 `AW`。
2. 获取该类型下新的 5 位流水号，例如 `00001`。
3. 组装主体：`YT-AW-00001`。
4. 拼接 salt 后计算完整 CRC32：`25934BF5`。
5. 取后 4 位：`4BF5`。
6. 生成完整设备号：`YT-AW-00001-4BF5`。
7. 写入生产台账。
8. 打印到设备铭牌、包装盒和二维码。

设备铭牌建议展示：

```text
设备号: YT-AW-00001-4BF5
```

其中设备号用于识别设备和进入配置流程，不是安全凭证。PIN 用于证明用户近场持有设备，必须有 PIN 才能进入 BLE 配网；生产台账登记设备号、PIN 和设备云端通信 AES 密钥 `deviceKey`，设备安全存储器保存 PIN。PIN 不得通过 BLE 明文发送，正式 BLE 配网和本地控制的小程序下行必须通过 `YTS-BLE-PIN/1` 用固定 BLE salt 派生 AES-128-CCM key，并通过 `YTS-BLE/1` 加密传输；设备上行 Notify 本期使用明文 JSON 状态，不携带敏感字段。用户实际持有设备的最终证明来自 BLE 近场配网，以及设备连接云端后使用 eFuse 16 字节 AES `deviceKey` 生成的 `YTS-SEC/1` AES-128-CCM 认证上报。二维码可以包含设备号和 PIN，但不应包含设备密钥。

## 11. 当前小程序实现状态

当前设备管理和配置流程已实现：

- 设备管理页入口从“绑定设备”改为“配置设备”。
- 手动输入设备号和设备 PIN。
- 扫描二维码读取设备号和 PIN；如果二维码缺少 PIN，需要用户手动输入设备标签上的 PIN。
- 设备号格式校验。
- 带 salt 的 CRC32 短校验码校验。
- 根据类型码自动识别设备类型，用户不再手动选择设备类型。
- 设备名称由用户输入，用作当前账号下的显示名称。
- 配置页调用 `device.prepareConfigure` 做云端设备号和归属检查；设备已绑定到他人时停止流程并提示联系管理员。
- 未绑定设备进入 BLE 配网流程，只展示蓝牙名称以 `ytsh-` 开头的设备。
- 小程序通过 `YTS-BLE/1` 用 PIN 派生本地 AES key，再在 AES-128-CCM 加密下行帧中发送 Wi‑Fi SSID 和密码；PIN 不发送给云端，也不直接作为 BLE 明文字段发送；设备 Notify 本期为明文 JSON 状态。
- 小程序等待设备连接云端后，调用 `device.bind` 完成最终绑定，并把返回设备写入本地设备列表。
- 如果 BLE 已扫描到设备但后续配网失败，小程序可调用 `device.addUnprovisioned` 先加入我的设备，设备状态显示“未入网”，列表仅对该状态显示“配网”按钮。
- 设备详情页在设备离线或未入网时，手动控制会优先尝试 BLE 通道，并用三步弹窗显示“扫描蓝牙设备、将数据发送给设备、最终结果”；BLE 控制不走 MQTT，使用 `YTS-BLE/1 local.command` 加密帧，业务语义复用云端 `watering.manual.start/stop` 等命令。
- Mock 模式下按 `00000` - `00063` 生成测试设备台账，并提供模拟 BLE 配网入口用于页面回归测试。
- 服务端测试台账中，`00032` - `0004A` 默认归属 `11111111111`，`0004B` - `00063` 默认归属 `00000000000`。
- Mock 模式下保存浇水配置、开始/停止手动浇水都会先模拟设备同步，成功后才写入本地缓存。
- 设备离线时，详情页进入只读状态，不能编辑参数、保存配置或下发浇水指令。
- 解除绑定前会提示用户设备端需要恢复出厂设置或重新进入配网模式；确认后调用 `device.unbind`，成功后才从当前账号设备列表移除。

当前小程序已切到 HTTPS 自建后端测试环境，API 入口为 `https://yutingsmarthome.xin/api`。根域名的 `/api` 由 Nginx 精确反向代理到 FastAPI，浏览器直接访问会返回 API 说明 JSON，小程序使用 `POST /api` 调用真实业务接口。服务端必须复用本文档规则再次校验设备号；当前正式流程已调整为 `device.prepareConfigure` 创建 `provisionSessionId`、小程序 BLE 下发该会话、设备通过 `device.secureMessage / provision.result` 完成 AES-128-CCM 认证上线、小程序轮询 `device.checkProvisionStatus`，最后 `device.bind` 只接受服务端已确认的 `ready_to_bind` 配网会话。当前小程序已通过统一 API 适配层调用 `device.prepareConfigure`、`device.checkProvisionStatus`、`device.bind`、`device.unbind`、`device.getStatus`、`watering.saveConfig`、`watering.startManual`、`watering.stopManual` 等接口；`mock` 模式仍保留，用于本地页面和流程回归测试。
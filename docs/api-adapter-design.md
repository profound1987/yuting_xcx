# 云汀智能家居小程序服务接入设计

## 1. 结论

微信小程序内不能内嵌一个真正监听端口的 HTTP/TCP 服务器。小程序运行在微信客户端沙箱中，只能作为客户端发起请求，例如 `wx.request`、`wx.cloud.callFunction`、扫码、蓝牙、局域网能力等，不能在手机里启动一个服务让别的端访问。

因此，推荐实现方式不是“内嵌服务器”，而是“内置 Mock API + 可切换服务适配层”：

- 原型阶段：小程序使用 `mock` 模式，接口在本地 JS 中返回模拟数据。
- 联调阶段：小程序使用 `http` 模式，请求开发机、测试服务器或内网穿透后的服务地址。
- 上线阶段：小程序使用 `http` 模式请求正式 HTTPS 域名，或使用 `cloud` 模式调用微信云函数。

当前测试环境已经切到 `http` 模式，实际请求地址为 `https://yutingsmarthome.xin/api`。根域名通过 Nginx 将 `/api` 精确反向代理到服务器本机 FastAPI 服务 `127.0.0.1:8000`，其余路径继续返回静态展示网站。

当前代码已提供统一配置入口：`miniprogram/config/api.js`。

当前排障期还保留两个仅限开发环境的临时 fallback：微信开发者工具可通过本机 SSH 隧道访问 `http://127.0.0.1:18000`；手机预览/开发版在明确关闭合法域名校验时，才可临时通过 `http://39.97.237.214:8000` 直连测试服务。它们只用于绕过当前 HTTPS TLS reset 问题，不能用于体验版、正式版或长期安全方案。

## 2. 为什么不能直接换 IP 上线

开发工具里可以临时使用 IP 或非正式域名联调，但正式版小程序请求后端时需要满足微信平台限制：

- 生产环境接口必须使用 HTTPS。
- 请求域名需要在微信公众平台的小程序后台配置为合法 request 域名。
- 正式版通常不应依赖裸 IP、临时端口、本机 `localhost` 或开发工具里的“忽略合法域名校验”。
- 如果后端服务部署在自己的服务器上，建议准备固定域名、有效 TLS 证书、反向代理和稳定的 API 路径。

所以“真正开发时更换 IP 地址”可以作为开发联调方式，但不适合作为上线方案。上线时应切换到正式 HTTPS 域名或云函数环境。

## 3. 推荐接口模式

### 3.1 `mock` 模式

用于无后端阶段。页面仍然调用统一 API 客户端，但实际返回本地模拟结果。当前 Mock 已内置测试设备台账，并会把设备参数、浇水配置、最近同步时间等数据保存到小程序本地缓存中。

适用场景：

- UI 原型。
- 业务流程验证。
- 演示设备绑定、登录、浇水配置、设备在线/离线、保存成功/失败等页面交互。

限制：

- 不能作为真实安全校验。
- 只能模拟设备是否生产、是否已绑定、是否在线，不能替代真实云端台账。
- 不能替代真实短信、真实设备状态和真实指令下发。

当前 Mock 测试设备规则：

| 类型码 | 流水号范围 | 场景 |
| --- | --- | --- |
| `AW`/`ES`/`LC`/`SP`/`GW` | `00000` - `00031` | 已上线销售、未绑定、在线，可进入配置流程 |
| `AW`/`ES`/`LC`/`SP`/`GW` | `00032` - `0004A` | 已上线销售、已被其他账号绑定、在线，配置前检查失败并提示“设备已被绑定” |
| `AW`/`ES`/`LC`/`SP`/`GW` | `0004B` - `00063` | 已上线销售、已绑定、离线，用于管理员和离线只读测试 |

`00000` - `00063` 是十六进制流水号范围，共 100 台。真实云端应通过 `device.list` 返回当前账号已绑定设备，不应允许用户绑定已属于他人的设备。

### 3.2 `http` 模式

用于自建服务器。小程序通过 `wx.request` 调用后端统一入口。

配置前归属检查请求格式：

```json
{
  "type": "device.prepareConfigure",
  "data": {
    "phone": "13800138000",
    "deviceNo": "YT-AW-00000-A324"
  }
}
```

设备完成 BLE 配网并连接云端后的最终绑定请求格式：

```json
{
  "type": "device.bind",
  "data": {
    "phone": "13800138000",
    "deviceNo": "YT-AW-00000-A324",
    "deviceName": "阳台自动浇水",
    "provisionSessionId": "ps_xxx"
  }
}
```

当前约定返回格式：

```json
{
  "success": true,
  "code": "OK",
  "message": "",
  "data": {
    "user": {
      "id": "user_xxx",
      "phone": "13800138000",
      "status": "active"
    },
    "device": {
      "deviceNo": "YT-AW-00000-A324",
      "type": "watering",
      "status": "在线",
      "online": true,
      "config": {}
    }
  }
}
```

开发联调时可以把 `baseUrl` 指向测试服务；上线时把 `baseUrl` 指向正式 HTTPS 域名。

### 3.3 `cloud` 模式

用于微信云开发。小程序通过 `wx.cloud.callFunction` 调用云函数。

适用场景：

- 希望减少自建服务器运维。
- 登录态要直接结合微信 `OPENID`。
- 设备、配置、会话数据主要放在云开发数据库中。

限制：

- 需要配置云开发环境 ID。
- 设备侧如果不在云开发生态内，仍需要额外的设备通信服务或 IoT 平台适配。

## 4. 当前代码切换方式

编辑 `miniprogram/config/api.js`：

```js
const API_CONFIG = {
  mode: "http",
  baseUrl: "https://yutingsmarthome.xin",
  useDebugHttp: false,
  debugHttpBaseUrl: "http://39.97.237.214:8000",
  debugHttpDevtoolsOnly: true,
  useDevtoolsTunnel: false,
  devtoolsBaseUrl: "http://127.0.0.1:18000",
  useDevelopHttpFallback: false,
  developBaseUrl: "http://39.97.237.214:8000",
  cloudFunctionName: "api",
  timeout: 10000,
};
```

模式说明：

- `mode: "mock"`：不请求远端，使用本地模拟接口。
- `mode: "http"`：默认请求 `${baseUrl}/api`。
- `useDebugHttp: true`：使用 `${debugHttpBaseUrl}/api` 做 HTTP 调试；当前 `debugHttpDevtoolsOnly=true`，只在微信开发者工具中生效，避免真机普通预览触发 `url not in domain list`。
- `useDevtoolsTunnel: true`：仅微信开发者工具环境请求 `${devtoolsBaseUrl}/api`，需要提前启动 SSH 隧道。
- `useDevelopHttpFallback: true`：仅手机预览/开发版请求 `${developBaseUrl}/api`，用于 HTTPS reset 排障期的临时联调。微信真机默认仍会校验 request 合法域名，所以只有在真机调试已关闭合法域名校验时才能开启。
- `mode: "cloud"`：调用 `cloudFunctionName` 指定的云函数。

页面代码只调用 `callApi(type, data)`，不直接关心当前是 Mock、HTTP 还是云函数。

当前真机测试必须同时满足：

- `baseUrl` 使用 `https://yutingsmarthome.xin`，最终请求为 `https://yutingsmarthome.xin/api`，不能使用裸 IP 或 HTTP。
- 微信公众平台的小程序后台已把 `https://yutingsmarthome.xin` 加入 request 合法域名。
- 服务器 Nginx 已配置有效 HTTPS 证书，并把根域名 `/api` 精确反向代理到 `127.0.0.1:8000/api`。
- 浏览器直接访问 `GET https://yutingsmarthome.xin/api` 会返回 API 说明 JSON；小程序业务请求必须使用 `POST /api` 和 `{ type, data }` 请求体。

如果手机预览/开发版仍出现 `request:fail net::ERR_CONNECTION_RESET`，可以临时开启 `useDevelopHttpFallback`。此时需要确保当前包是开发版，并在调试设置中允许开发阶段不校验合法域名和 HTTPS 证书限制；否则会出现 `url not in domain list:39.97.237.214`。体验版和正式版不能依赖这个开关。

## 5. 自建服务器建议

如果后续选择自建服务器，推荐最小后端模块如下：

| 模块 | 接口类型 | 职责 |
| --- | --- | --- |
| 鉴权 | `auth.sendCode` | 发送短信验证码，限制频率 |
| 鉴权 | `auth.loginByCode` | 校验验证码，创建登录会话 |
| 鉴权 | `auth.checkSession` | 校验并刷新会话 |
| 设备 | `device.prepareConfigure` | 配置设备前检查设备号、设备归属和是否允许进入配网，并创建临时配网会话 |
| 设备 | `device.checkProvisionStatus` | 小程序配网后轮询设备是否已通过云端认证上线 |
| 设备 | `device.bind` | 设备配网成功并连接云端后，凭 `provisionSessionId` 完成最终绑定到当前用户 |
| 设备 | `device.addUnprovisioned` | BLE 已扫描到设备但后续配网失败时，先加入“我的设备”并标记为 `not_provisioned/未入网` |
| 设备 | `device.unbind` | 当前用户解除设备绑定并清理该设备在当前账号下的数据 |
| 设备 | `device.list` | 查询当前用户设备列表 |
| 设备 | `device.getStatus` | 查询设备在线状态和传感器数据 |
| 设备通信 | `device.secureMessage` | 接收设备 `YTS-SEC/1` AES-128-CCM 安全消息，按 `msgType` 处理 `provision.result`、遥测、`command.pull`、`command.ack` |
| 设备通信 | `device.getCommandStatus` | 小程序查询云端命令状态 |
| 浇水 | `watering.saveConfig` | 保存期望配置并生成 `watering.config.set` 命令，返回 `COMMAND_ACCEPTED` 和 `commandId` |
| 浇水 | `watering.startManual` | 创建手动浇水命令，返回 `COMMAND_ACCEPTED` 和 `commandId` |
| 浇水 | `watering.stopManual` | 创建停止浇水命令，返回 `COMMAND_ACCEPTED` 和 `commandId` |

后端必须重新校验登录态、设备归属和设备号合法性，但不再接收或校验设备 PIN。客户端的 CRC32 校验只用于减少误输入，不能作为最终安全边界；BLE 广播名和设备号不是秘密，必须有设备标签或二维码中的 PIN 作为近场持有证明。配置设备时，手机端应先调用 `device.prepareConfigure` 判断设备是否未绑定且允许配网，并取得 `provisionSessionId`；随后小程序和设备端本地通过 `YTS-BLE/1` 用 `SHA256(deviceNo|PIN|固定 BLE salt)` 派生的 AES-128-CCM key 加密下行 BLE 帧，给设备下发 Wi-Fi 信息、设备号和 `provisionSessionId`，不得把 PIN 作为云端字段或 BLE 明文字段发送；设备上行 Notify 本期保持明文 JSON 状态，不需要 nonce/ciphertext/tag。设备连接云端并通过 AES-128-CCM 认证上报 `provision.result` 后，小程序再调用 `device.checkProvisionStatus` 轮询，只有返回 `DEVICE_READY_TO_BIND` 后才调用 `device.bind`。`device.bind` 必须在后端再次确认设备已经上云、配网会话有效且状态为 `ready_to_bind`、设备未被其他用户绑定，并成功写入设备归属和绑定审计记录后，才能返回成功；浇水设备不自动创建真实业务默认配置。若已经扫描到 BLE 设备但 Wi‑Fi 或云端认证失败，小程序可弹窗询问是否先加入“我的设备”，确认后调用 `device.addUnprovisioned`，设备显示为 `未入网`，不是在线或离线，后续只显示“配网”入口并允许 BLE 本地控制兜底。BLE 本地控制不走 MQTT 或 `command.pull`，而是通过 `YTS-BLE/1 local.command` 加密下行帧复用云端命令的 `commandType/params/ack` 业务语义；本期暂不实现 `bleControlTicket`。

`device.unbind` 必须要求当前用户拥有该设备。解除绑定前，手机端需要明确提示用户：解除绑定后，该设备的配置和本地数据会从当前账号删除。只有后端成功清理设备归属、配置、缓存状态和解绑审计记录后，手机端才从本地列表移除设备。

绑定失败提示策略：

| 场景 | 返回码 | 手机端提示 |
| --- | --- | --- |
| 格式错误、CRC 错误、类型错误、未生产、未注册、设备 AES-CCM 认证失败 | `DEVICE_NOT_BINDABLE` | 设备号不正确 |
| 设备已被其他用户绑定 | `DEVICE_ALREADY_BOUND` | 设备已被绑定 |

## 6. 设备配置同步策略

设备管理页采用“命令接受后轮询设备确认”的策略：

- 进入详情页时调用 `device.getStatus`，同步在线状态、设备能力、期望配置、已应用配置和最近同步时间。
- 设备离线时，手机端只展示当前缓存配置，不允许编辑参数、保存配置或下发手动浇水指令。
- 设备在线时，用户可以编辑配置；点击保存后调用 `watering.saveConfig`。
- `watering.saveConfig` 成功只表示服务端已创建命令并返回 `COMMAND_ACCEPTED` 和 `commandId`，不表示设备已执行。
- 手机端必须调用 `device.getCommandStatus` 轮询；命令 `succeeded` 后才展示“已同步”。
- 如果设备离线、指令超时或设备返回失败，服务端返回相应状态，手机端不把本地表单内容记为已应用。
- 手动浇水同理，只有 `watering.startManual` 对应命令 `succeeded` 或遥测 `pumpOn=true` 后，手机端才进入倒计时和“浇水中”状态。
- 手机端重新进入详情页时，以 `device.getStatus` 返回的 `desiredConfig`、`appliedConfig` 和 `configState` 为准。

## 7. 设备通信建议

手机小程序不应直接作为设备通信中枢。推荐链路为：

```text
小程序 -> HTTPS API/云函数 -> 业务服务 -> IoT 平台/MQTT/设备网关 -> 设备
```

设备状态回传链路为：

```text
设备 -> IoT 平台/MQTT/设备网关 -> 业务服务 -> 数据库/缓存 -> 小程序查询
```

这样可以保证用户权限、设备归属、指令审计、离线重试和状态缓存都由云端统一控制。

## 8. 开发环境建议

建议准备三个配置：

| 环境 | `mode` | `baseUrl`/云函数 | 用途 |
| --- | --- | --- | --- |
| 本地原型 | `mock` | 不使用 | 页面和流程开发 |
| 开发者工具联调 | `http` | `http://127.0.0.1:18000` | 通过 SSH 隧道排障，仅限本地调试 |
| 手机开发版联调 | `http` | `http://39.97.237.214:8000` | 仅用于真机调试且关闭合法域名校验时排障 |
| 联调测试 | `http` | `https://yutingsmarthome.xin` | 真机测试、后端联调，最终请求 `/api` |
| 正式发布 | `http` 或 `cloud` | 正式 HTTPS 域名或正式云环境 | 用户使用 |

如果使用自建服务器，推荐尽早用域名和 HTTPS 联调，而不是长期依赖 IP。这样可以更接近真实发布环境，也能提前发现微信合法域名、证书、跨环境配置等问题。

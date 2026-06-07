# 临时调试绕过与上线前修正清单

> 目的：当前为了真机 BLE 联调，需要临时绕开短信验证码和域名备案限制。本文档专门记录所有临时开关、风险和上线前必须修正的点，避免后续遗忘。

## 1. 当前临时状态

### 1.1 短信验证码临时绕过

文件：`miniprogram/config/api.js`

当前临时开启：

- `enableDevLoginBypass: true`
- `devLoginPhone: "13800138000"`
- `allowDevProvisionWithoutCloudCheck: true`

影响：

- 登录页会显示“调试登录”按钮。
- 点击后不请求 `auth.sendCode` / `auth.loginByCode`，直接写入本地 `yuntingSession`。
- 用于真机 BLE 联调，避免手机端因域名/备案/验证码链路问题卡在登录页。
- 使用调试登录态进入配置页时，如果 `device.prepareConfigure` 因网络或临时接口问题失败，小程序会允许继续 BLE 扫描；明确的设备号错误或已被绑定仍不放行。

上线前必须修正：

1. 把 `enableDevLoginBypass` 改回 `false`。
2. 把 `allowDevProvisionWithoutCloudCheck` 改回 `false`。
3. 确认登录页不再展示“调试登录”按钮。
4. 删除或保留但禁用所有 `devBypass` 相关逻辑。
5. 重新验证真实短信验证码登录流程。
6. 重新验证 `device.prepareConfigure` 必须成功后才能进入 BLE 配网。

风险：

- 如果误带到体验版或正式版，任何人可能绕过短信验证码进入小程序原型流程。
- 调试登录态不是真实服务端会话，不应用于正式业务验权。

## 2. 域名、备案与 IP fallback 问题

### 2.1 当前域名问题

当前 API 正式入口：

```text
https://yutingsmarthome.xin/api
```

当前策略：

- 小程序 `baseUrl` 使用根域名 `https://yutingsmarthome.xin`，最终请求地址为 `https://yutingsmarthome.xin/api`。
- Nginx 在根域名上将 `location = /api` 精确反向代理到 `http://127.0.0.1:8000/api`，并为该响应添加 `Cache-Control: no-store`。
- 根域名其他路径继续返回静态展示网站，不影响 `https://yutingsmarthome.xin/` 首页。
- 浏览器直接访问 `GET https://yutingsmarthome.xin/api` 会返回 API 说明 JSON；小程序业务请求使用 `POST /api` 和 `{ type, data }`。

历史问题：

- API 子域名 `https://api.yutingsmarthome.xin` 在模拟器可用，但手机真机曾出现 `request:fail net::ERR_CONNECTION_RESET`。
- 裸 IP `http://39.97.237.214:8000/api` 在普通预览/开发版会被微信合法域名规则拦截：`url not in domain list:39.97.237.214`。
- `http://api.yutingsmarthome.xin:8000/health` 曾返回阿里云 `Non-compliance ICP Filing`。
- 根因高度疑似域名备案/接入/阿里云侧拦截或微信真机 TLS 兼容问题，而不是 FastAPI 后端服务本身。

已验证：

- `http://39.97.237.214:8000/health` 可访问。
- `https://api.yutingsmarthome.xin/health` 可访问，但手机真机曾 TLS reset。
- 服务器本机通过 SNI 访问 `https://yutingsmarthome.xin/api` 可命中 FastAPI 并返回 API 说明 JSON。
- 带时间戳访问 `https://yutingsmarthome.xin/api?...` 已返回 API 说明 JSON，说明根域名 `/api` 代理已生效。
- 2026-06-05 再次验证：微信后台合法域名生效后，手机 `wx.request` 仍报 `request:fail net::ERR_CONNECTION_RESET`；本地 Windows `curl` 访问 `https://yutingsmarthome.xin/api` 也会 reset，但浏览器和服务器本机 SNI 访问正常。该现象说明失败发生在 Nginx 业务日志之前，更像公网接入、备案合规、云侧安全策略或客户端 TLS 指纹兼容问题。
- 证书链检查：`yutingsmarthome.xin` 证书由 Let's Encrypt 签发，SAN 包含 `DNS:yutingsmarthome.xin` 和 `DNS:www.yutingsmarthome.xin`，证书本身未发现域名不匹配问题。
- 2026-06-05 22:17 复测：本地 `curl.exe https://yutingsmarthome.xin/api` 已返回 200；`scripts/diagnose_https.py` 最新报告 `aliyun-https-report-latest.json` 显示 DNS、TCP、TLS1.2、TLS1.3、`GET /api`、`POST /api` 全部通过。当前需要重新验证手机微信 `wx.request` 是否也恢复。

### 2.2 当前 IP fallback

文件：`miniprogram/config/api.js`

当前默认关闭：

- `useDevelopHttpFallback: false`
- `developBaseUrl: "http://39.97.237.214:8000"`

文件：`miniprogram/services/apiClient.js`

当前行为：

- 开发者工具/模拟器走 `baseUrl: "https://yutingsmarthome.xin"`，最终请求 `https://yutingsmarthome.xin/api`。
- 手机普通预览/开发版默认也走 `baseUrl: "https://yutingsmarthome.xin"`，避免裸 IP 被微信合法域名规则拦截。
- 裸 IP `http://39.97.237.214:8000` 只能用于“真机调试 + 已关闭域名校验”的场景；普通预览会报 `url not in domain list:39.97.237.214`。
- 2026-06-05 验证：模拟器通过 API 子域名可以正常发送验证码；手机真机访问 API 子域名曾报 `request:fail net::ERR_CONNECTION_RESET`，因此改用根域名 `/api` 路径代理。
- 登录请求失败时会在弹窗中展示最近一次请求地址，便于确认实际走的是根域名、子域名还是 IP。

上线前必须修正：

1. 保持 `useDevelopHttpFallback` 为 `false`。
2. 确认 `baseUrl` 使用 `https://yutingsmarthome.xin`。
3. 确认微信公众平台小程序后台已配置 request 合法域名：`https://yutingsmarthome.xin`。
4. 确认 Nginx 根域名 `location = /api` 反向代理到 FastAPI，且 `GET /api` 返回 API 说明 JSON、`POST /api` 返回业务响应。
5. 删除或禁用裸 IP 调试说明，避免测试包误依赖 HTTP。
6. 体验版和正式版必须只使用 HTTPS 合法域名，不能使用裸 IP 或 HTTP。

注意：

- 普通扫码预览可能仍会强制校验合法域名，裸 IP 会报 `url not in domain list`。
- 真机 BLE 联调如必须使用裸 IP，应使用微信开发者工具的“真机调试”，并在“详情 → 本地设置”中勾选“不校验合法域名、web-view 域名、TLS 版本以及 HTTPS 证书”。
- 如果必须普通预览，只能使用已配置到小程序后台的 HTTPS 合法域名。
- 若根域名 HTTPS 在手机 `wx.request` 中仍 reset，应优先联系阿里云确认备案接入、云防火墙/安全策略、非浏览器客户端访问 HTTPS 是否被拦截；短期 BLE 联调继续使用调试登录绕过短信验证码。

## 3. BLE 配网临时实现问题

文件：`miniprogram/pages/configure/index.js`

当前实现：

- 扫描蓝牙名称以 `ytsh-` 开头的 BLE 设备。
- 2026-06-05 针对真机“系统能看到 ytsh 设备但小程序列表为空”的问题，已增强扫描逻辑：
  - `allowDuplicatesKey` 改为 `true`，避免第一次广播没有设备名时漏掉后续 scan response。
  - 设备名同时读取 `name`、`localName` 和广播包 `advertisData` 中的 Complete/Shortened Local Name。
  - 增加 `wx.getBluetoothDevices` 轮询兜底，避免 `onBluetoothDeviceFound` 事件漏报。
- 2026-06-05 根据真机体验反馈，已移除页面上的 BLE 扫描调试面板；扫描到设备后弹出蓝牙设备选择框，选择设备后再弹出 Wi‑Fi 配网对话框，避免用户需要下拉页面寻找下一步操作。
- 连接后写入设备号和 Wi-Fi 配网 JSON。
- BLE 写入已按 UTF-8 和 20 字节分片处理。
- 当前使用占位 UUID：
  - Service：`0000FFF0-0000-1000-8000-00805F9B34FB`
  - Write：`0000FFF1-0000-1000-8000-00805F9B34FB`

后续必须修正：

1. 根据真实设备固件确认 BLE Service UUID、Write Characteristic UUID、Notify Characteristic UUID。
2. 增加 Notify/Indicate 监听，读取设备端明确返回：
   - 设备号校验成功/失败。
   - Wi-Fi 连接成功/失败。
   - 云端连接成功/失败。
3. 当前 `waitCloudOnline()` 只是延迟后进入最终绑定，正式环境必须改为轮询云端设备上线状态或等待设备上报。
4. Wi-Fi 密码通过 BLE 明文传输，正式设备应增加会话密钥、临时配网 token 或特征值加密。
5. iOS/Android 获取当前 Wi-Fi SSID 的权限和兼容性需要真机验证。
6. 配网失败时需要支持重新扫描、重新输入 Wi-Fi 密码和取消流程。

## 4. 设备绑定安全临时实现问题

文件：`server/yt_smart_home_server/app/services.py`

当前已做：

- 新增 `device.prepareConfigure`，用于配置前检查设备号、生产台账和绑定归属，并创建有 TTL 的 `provisionSessionId`。
- 新增 `device.checkProvisionStatus`，小程序配网后轮询设备是否已经认证上线。
- 新增 `device.secureMessage` 服务端入口，按 `YTS-SEC/1` AES-128-CCM 安全信封接收设备上报；当前测试台账与测试固件 eFuse 默认值对齐，使用 16 字节全 0 AES key，正式环境必须替换为生产烧录的一机一随机密钥。
- `device.bind` 已改为要求 `provisionSessionId` 对应的配网会话为 `ready_to_bind`，不再接受小程序自报 `provisioned: true` 作为绑定依据。
- 已部署到测试服务器 `/home/yunting/yt_smart_home_server` 后需要按 [服务器部署 Runbook](server-deployment-runbook.md) 重新验证：
  - `device.prepareConfigure` 对未绑定设备返回 OK 和 `provisionSessionId`。
  - 未完成 `device.secureMessage / provision.result` 的设备，`device.checkProvisionStatus` 会保持 pending 或超时。
  - 旧的直接 `device.bind` 会被拒绝。

当前临时点：

- 设备端尚未实现 AES-128-CCM `device.secureMessage`，因此真实设备上云确认仍需设备固件配合。

正式环境必须修正：

1. 设备端实现 `device.secureMessage / provision.result`、`device.boot`、`telemetry.report`、`command.ack` 等标准消息类型。
2. 设备连接云端后，必须使用 `YTS-SEC/1` AES-128-CCM 安全消息证明真实设备在线：
   - 每台设备生产烧录 16 字节 AES `deviceKey` 到 eFuse 或安全 key slot。
   - 设备 CPU 不能读出 `deviceKey`，只能通过硬件 AES 使用。
   - 服务端按 `deviceNo` + `keyId` 查询加密保存的 `deviceKeyEncrypted`。
   - 服务端必须通过 AES-128-CCM tag 校验和解密后，才接受 `provision.result`、`device.boot`、遥测和 ACK。
3. 正式生产环境必须把测试台账的全 0 `device_key_hex` 替换为生产烧录密钥的加密副本。
4. 绑定成功后写入审计日志，包括用户、设备号、配网会话、设备上线时间和来源。
5. 解绑后必须提示用户在设备端恢复出厂设置；管理员强制解绑也要进入售后流程。

正式协议文档：`docs/device-cloud-protocol-design.md` 已确定使用 AES-128-CCM，设备端实现必须与标准 AES-CCM 库互通，不能实现自定义 CBC-MAC/CTR 变体。

## 5. ICP/网站相关遗留问题

已做：

- 已部署根域名备案静态网站到 `/var/www/yunting-homepage`。
- Nginx root site `yunting-homepage` 处理：
  - `yutingsmarthome.xin`
  - `www.yutingsmarthome.xin`
- API 子域名站点独立，不应受根站点影响。

2026-06-05 最新测试结论：

- `http://yutingsmarthome.xin/` 返回 200，网站页面可用。
- `http://www.yutingsmarthome.xin/` 返回 200，www 页面可用。
- 曾出现 `https://yutingsmarthome.xin/` 返回 `{"detail":"Not Found"}`，原因是首页站点当时只监听 80，没有配置 443；HTTPS 请求落到了默认 API 443 站点，被转发到 FastAPI。
- 已使用 Certbot 为 `yutingsmarthome.xin` 和 `www.yutingsmarthome.xin` 签发并部署证书，Nginx 首页站点已监听 443。
- 用户浏览器反馈 `https://yutingsmarthome.xin/` 已可正常访问，说明公网 443 对主域名已基本可用。
- 服务器本机 SNI 访问 `https://yutingsmarthome.xin/` 和 `https://www.yutingsmarthome.xin/` 已返回静态首页，不再是 FastAPI `Not Found`。
- 服务器本机使用 SNI 访问 `https://api.yutingsmarthome.xin/health` 可返回 200，说明 Nginx API 子域名站点和证书配置在服务器本机链路正常。
- 当前从本地公网使用域名 SNI 访问 `https://api.yutingsmarthome.xin/health` 曾在 TLS 握手阶段 `Connection reset`。
- 当前从本地公网直连 `https://39.97.237.214/health` 并手动指定 `Host: api.yutingsmarthome.xin` 可返回 200，说明服务器 443、Nginx 和 FastAPI 后端本身可用。
- `http://api.yutingsmarthome.xin:8000/health` 可返回 200，FastAPI 后端本身可用。
- 2026-06-05 已把 API 暂时挂到主域名路径 `https://yutingsmarthome.xin/api`，Nginx 对主域名 `location = /api` 反向代理到 FastAPI，其余路径继续 serving 静态网站。

当前判断：

- 根网站 HTTP/HTTPS 已经可用于“新办网站审核”。
- 服务器公网 443 端口本身可用，因为主域名 HTTPS 已能访问，直连 IP 443 也能返回 API 健康检查。
- `api.yutingsmarthome.xin` 的 DNS、证书和 Nginx 本机 SNI 分流都正常，但公网按 `api.yutingsmarthome.xin` 这个主机名访问曾 reset。
- 更可能是备案/接入/云侧安全策略尚未放行 `api` 子域名，或小程序后台/云平台审核只放行了主域名和 www，未覆盖 API 子域名。
- 当前小程序 API 已改为 `https://yutingsmarthome.xin/api`，正式联调优先验证主域名 `/api`。

待确认：

1. 阿里云备案/接入是否完成并放行。
2. `www.yutingsmarthome.xin` 是否已添加 DNS A 记录。
3. `api.yutingsmarthome.xin` HTTPS 是否还会 reset，作为后续是否恢复 API 子域名的参考。
4. 微信公众平台 request 合法域名是否已添加 `https://yutingsmarthome.xin`。
5. 备案完成后删除或关闭所有 HTTP/IP fallback。

## 6. 上线前总检查

上线、体验版或对外测试前必须逐项确认：

- [ ] `enableDevLoginBypass` 为 `false`。
- [ ] `allowDevProvisionWithoutCloudCheck` 为 `false`。
- [ ] 登录页不显示调试登录按钮。
- [ ] `useDevelopHttpFallback` 为 `false`。
- [ ] 不再依赖 `http://39.97.237.214:8000`。
- [ ] `baseUrl` 为 `https://yutingsmarthome.xin`。
- [ ] 小程序后台 request 合法域名已配置并生效：`https://yutingsmarthome.xin`。
- [ ] Nginx 根域名 `location = /api` 代理生效，`GET /api` 返回说明 JSON，`POST /api` 返回业务响应。
- [ ] 真实短信验证码发送和登录可用。
- [ ] BLE UUID 和设备固件协议一致。
- [ ] Wi-Fi 配网结果来自设备 Notify 或云端真实状态。
- [ ] 生产系统已为每台设备生成唯一 16 字节 AES `deviceKey` 和 `keyId`。
- [ ] 设备端已把 `deviceKey` 烧录到 eFuse 或安全 key slot，CPU 不可读。
- [ ] 服务端已加密保存 `deviceKeyEncrypted`，日志中不输出明文密钥。
- [ ] 设备端 AES-128-CCM 实现已通过标准库互通测试，nonce 13 字节、tag 16 字节、AAD 规则一致。
- [ ] 服务端 `device.secureMessage` 已完成 AES-128-CCM tag 校验、解密和 nonce/seq 防重放。
- [ ] 小程序配网后通过 `device.checkProvisionStatus` 轮询，只有 `DEVICE_READY_TO_BIND` 后才调用 `device.bind`。
- [ ] 云端只有在收到并验证 `provision.result` 后才把配网会话标记为 `ready_to_bind`。
- [ ] `device.bind` 不再接受小程序自报的 `provisioned: true` 作为依据，必须校验 `provisionSessionId`。
- [ ] 解绑流程已明确要求设备端恢复出厂设置。
- [ ] 管理员审计可查询配置、绑定、解绑和失败原因。

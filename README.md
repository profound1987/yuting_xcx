# 云汀智能家居小程序

这是一个面向智能家居设备管理的小程序原型，当前已接入 HTTPS 自建后端、真实手机号短信验证码登录、设备绑定、设备列表管理，以及自动浇水系统的三种浇水模式配置。

## 已实现功能

- 手机号 + 验证码登录：当前通过 `https://api.yutingsmarthome.xin/api` 调用服务端，并使用阿里云号码认证服务发送真实短信验证码。
- 多设备绑定：支持绑定自动浇水系统、环境传感器、智能灯控、智能插座等类型。
- 用户设备隔离：设备数据按登录手机号分别保存在本地缓存中。
- 自动浇水系统管理：支持按需浇水、定期浇水、手动浇水三种模式。
- 按需浇水配置：可设置土壤湿度传感器检测周期、湿度阈值、每次浇水秒数。
- 定期浇水配置：可设置每隔几天浇几次水、每次浇水秒数。
- 手动浇水控制：可设置浇水秒数并启动倒计时控制。

## 当前测试环境

```text
小程序 -> https://api.yutingsmarthome.xin/api -> Nginx -> FastAPI(127.0.0.1:8000) -> SQLite
```

- 小程序 API 模式：`http`。
- API 域名：`https://api.yutingsmarthome.xin`。
- 本地开发者工具 HTTP 调试：当前 `useDebugHttp=true` 且 `debugHttpDevtoolsOnly=true`，开发者工具会请求 `http://39.97.237.214:8000/api`，用于绕过本机 HTTPS reset；真机普通预览、体验版和正式版仍使用 HTTPS 域名。
- 当前开发版临时 fallback：微信开发者工具可走 `http://127.0.0.1:18000` SSH 隧道；手机预览/开发版只有在真机调试已关闭合法域名校验时，才可临时开启 `http://39.97.237.214:8000`，用于绕过当前 HTTPS TLS reset 排障；体验版和正式版仍应使用 HTTPS 域名。
- 真实短信：`YT_SMS_PROVIDER=aliyun_dypns`，当前测试服务器 `YT_ENABLE_DEV_SMS=false`。
- 微信公众平台需要配置 request 合法域名：`https://api.yutingsmarthome.xin`。

## 页面结构

- `miniprogram/pages/index/index`：手机号验证码登录页。
- `miniprogram/pages/devices/index`：设备绑定和设备列表页。
- `miniprogram/pages/device/index`：设备详情和自动浇水配置页。
- `miniprogram/config/api.js`：统一配置接口模式和服务地址，支持 `mock`、`http`、`cloud`。
- `miniprogram/services/apiClient.js`：统一 API 调用适配层，页面不直接依赖某一种后端实现。
- `server/yt_smart_home_server`：Python FastAPI 服务端，实现登录、设备绑定、设备状态和浇水配置接口。
- `tools/admin_client/yunting_admin_ui.py`：本地 Python 管理员 UI，调用远程 `admin.*` 接口查询用户、设备、绑定失败、控制记录和审计。

## 系统设计

- [docs/system-design.md](docs/system-design.md)：定义登录态判断、验证码会话策略、云端模块、数据模型和业务逻辑。
- [docs/login-module-design.md](docs/login-module-design.md)：细化登录模块的手机端逻辑、云端账户管理、会话生命周期和接口规范。
- [docs/device-numbering-design.md](docs/device-numbering-design.md)：定义设备类型码、设备编号格式、扫码绑定和带 salt 的 CRC32 校验规则。
- [docs/api-adapter-design.md](docs/api-adapter-design.md)：定义小程序无法内嵌服务器时的 Mock/HTTP/云函数接口切换方案。
- [docs/aliyun-sms-integration.md](docs/aliyun-sms-integration.md)：说明阿里云短信验证码开通、配置和服务端对接方式。

## 本地管理员工具

管理员查询可以直接运行本地 Python UI，不需要登录服务器：

```powershell
python .\tools\admin_client\yunting_admin_ui.py
```

使用说明见 [tools/admin_client/README.md](tools/admin_client/README.md)。

## 后续接入建议

- 将后端 Uvicorn 进程纳入 systemd 管理，并让业务服务只监听 `127.0.0.1:8000`。
- HTTPS reset 问题稳定解决后，关闭开发版 HTTP fallback 和服务器公网 `8000` 端口，只保留 Nginx 的 `80/443` 作为公网入口。
- 将设备和浇水接口逐步改为基于 `sessionToken` 的统一鉴权。
- 将“开始浇水”“保存设置”等操作对接设备通信协议或 IoT 平台接口。


# 云汀智能家居小程序

这是一个面向智能家居设备管理的小程序原型，当前已实现手机号验证码登录、设备绑定、设备列表管理，以及自动浇水系统的三种浇水模式配置。

## 已实现功能

- 手机号 + 验证码登录：当前使用演示验证码弹窗，输入弹窗验证码即可进入系统。
- 多设备绑定：支持绑定自动浇水系统、环境传感器、智能灯控、智能插座等类型。
- 用户设备隔离：设备数据按登录手机号分别保存在本地缓存中。
- 自动浇水系统管理：支持按需浇水、定期浇水、手动浇水三种模式。
- 按需浇水配置：可设置土壤湿度传感器检测周期、湿度阈值、每次浇水秒数。
- 定期浇水配置：可设置每隔几天浇几次水、每次浇水秒数。
- 手动浇水控制：可设置浇水秒数并启动倒计时控制。

## 页面结构

- `miniprogram/pages/index/index`：手机号验证码登录页。
- `miniprogram/pages/devices/index`：设备绑定和设备列表页。
- `miniprogram/pages/device/index`：设备详情和自动浇水配置页。
- `miniprogram/config/api.js`：统一配置接口模式和服务地址，支持 `mock`、`http`、`cloud`。
- `miniprogram/services/apiClient.js`：统一 API 调用适配层，页面不直接依赖某一种后端实现。

## 系统设计

- [docs/system-design.md](docs/system-design.md)：定义登录态判断、验证码会话策略、云端模块、数据模型和业务逻辑。
- [docs/login-module-design.md](docs/login-module-design.md)：细化登录模块的手机端逻辑、云端账户管理、会话生命周期和接口规范。
- [docs/device-numbering-design.md](docs/device-numbering-design.md)：定义设备类型码、设备编号格式、扫码绑定和带 salt 的 CRC32 校验规则。
- [docs/api-adapter-design.md](docs/api-adapter-design.md)：定义小程序无法内嵌服务器时的 Mock/HTTP/云函数接口切换方案。

## 后续接入建议

- 将验证码发送和校验替换为真实短信服务或云函数接口。
- 将本地缓存中的设备列表和配置迁移到云开发数据库。
- 将“开始浇水”“保存设置”等操作对接设备通信协议或 IoT 平台接口。


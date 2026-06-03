# 云汀本地管理员工具

这是一个本地运行的 Python Tkinter 桌面工具，用来调用远程服务端的 `admin.*` 管理接口。它不需要登录服务器，也不会把管理员密钥写入本地文件。

## 启动

在项目根目录执行：

```powershell
python .\tools\admin_client\yunting_admin_ui.py
```

默认服务器地址是：

```text
https://api.yutingsmarthome.xin
```

打开后填写 `YT_ADMIN_TOKEN` 对应的管理员密钥即可查询。密钥在服务端部署目录的 `.env` 文件中，由 `YT_ADMIN_TOKEN=` 配置。

如果本机访问 HTTPS 出现 `WinError 10054`、`Connection reset by peer` 等 TLS 握手重置问题，可以改用 SSH 隧道模式。先保持以下命令窗口运行：

```powershell
ssh -N -L 18000:127.0.0.1:8000 -i C:\Users\THINK\.ssh\yunting_dev_ed25519 yunting@39.97.237.214
```

然后把管理员工具里的服务器地址改为：

```text
http://127.0.0.1:18000
```

这种方式通过 SSH 加密访问服务器本机后端，管理员密钥不会通过公网明文传输。

## 支持功能

- 总览统计：用户数、设备数、绑定数、未绑定数、在线数、离线数、24 小时内绑定失败和控制指令统计。
- 设备列表筛选：在总览页按设备类型码、绑定状态和在线状态列出设备，例如只看 `AW` 智能浇水设备下的 `unbound` 在线设备。
- 用户查询：按手机号查询用户、登录会话、绑定设备、绑定失败记录、控制记录；按 OpenID 反查用户。
- 设备查询：按设备号查询设备状态、绑定用户、绑定历史、控制记录和手动浇水汇总。
- 绑定失败排障：按手机号、设备号、结果、错误码、原因、时间范围查询失败记录。
- 控制记录：按手机号、设备号、指令类型、状态、时间范围查询设备控制指令。
- 管理操作：禁用/恢复用户、禁用/恢复设备、强制解绑设备；这些操作都会先弹出确认框。
- 管理审计：查询 `admin_audit_events` 记录。
- 高级调用：手动输入任意 `admin.*` type 和 JSON data。

## 结果说明

按手机号查询用户时，`exists: false` 表示远程服务端数据库里没有这个手机号的用户记录。通常是因为该手机号还没有通过远程后端完成真实短信登录、绑定或资料查询；如果小程序切回 `mock` 模式，本地数据也不会写入远程服务端。

总览统计默认展示真实用户绑定口径。服务端开发版会预置 500 台测试设备台账和 2 个测试绑定用户，用来模拟“未绑定在线、已被他人绑定、已绑定离线”等测试场景；这些数据不会算进默认 `usersTotal`、`devicesBound`、`devicesOnline`，需要核对时看返回结果里的 `registrySummary` 和 `seedInventory`。

已绑定在线测试设备默认归属 `11111111111`，已绑定离线测试设备默认归属 `00000000000`。这两个是系统测试号，可以在管理员工具里按手机号查询，但不用于普通小程序登录。

## 可选环境变量

如果不想每次手动填默认值，可以在启动前设置：

```powershell
$env:YT_ADMIN_BASE_URL = "https://api.yutingsmarthome.xin"
$env:YT_ADMIN_TOKEN = "你的管理员密钥"
$env:YT_ADMIN_TIMEOUT = "12"
python .\tools\admin_client\yunting_admin_ui.py
```

密钥只会读取到输入框中，程序不会持久化保存。
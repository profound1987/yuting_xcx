# 阿里云 HTTPS Connection Reset 诊断说明

## 1. 现象

域名：

```text
https://yutingsmarthome.xin/api
```

浏览器访问可以正常返回页面或 API JSON，但微信小程序 `wx.request` 访问时出现：

```text
request:fail net::ERR_CONNECTION_RESET
```

本地命令行客户端访问同一域名也可复现 TLS 握手阶段被 reset。

当前状态：

- 2026-06-05：已将该问题提交阿里云工单，等待阿里云排查公网 HTTPS 接入层、备案接入、安全策略或 TLS 指纹兼容问题。
- 在工单处理完成前，小程序调试优先继续推进 BLE 配网链路；登录和云端检查仍保留临时调试绕过开关。

## 2. 诊断脚本

脚本位置：

```text
scripts/diagnose_https.py
```

运行方式：

```bash
python scripts/diagnose_https.py --output aliyun-https-report.json
```

指定固定 IP 并继续使用域名作为 SNI/Host：

```bash
python scripts/diagnose_https.py --host yutingsmarthome.xin --ip 39.97.237.214 --output aliyun-https-report.json
```

脚本只使用 Python 标准库，不依赖第三方包。

## 3. 脚本检查内容

- DNS 解析。
- TCP 443 连接。
- TLS 默认握手。
- TLS 1.2 握手。
- TLS 1.3 握手。
- `GET /`。
- `GET /api`。
- `POST /api`。

POST 请求使用的是：

```json
{"type":"auth.checkSession","data":{"sessionToken":"diagnostic-invalid-session"}}
```

该请求不会发送短信，不会产生短信费用，仅用于验证 `POST /api` 是否能到达后端。

## 4. 当前本地复现结果摘要

在本地 Windows 环境中运行脚本，结果为：

```text
[OK] DNS resolve yutingsmarthome.xin
[OK] TCP connect 39.97.237.214:443
[FAIL] TLS handshake default via 39.97.237.214:443
    ConnectionResetError: [WinError 10054] 远程主机强迫关闭了一个现有的连接。
[FAIL] TLS handshake TLSv1.2 via 39.97.237.214:443
    ConnectionResetError: [WinError 10054] 远程主机强迫关闭了一个现有的连接。
[FAIL] TLS handshake TLSv1.3 via 39.97.237.214:443
    ConnectionResetError: [WinError 10054] 远程主机强迫关闭了一个现有的连接。
```

该结果说明：

- DNS 正常。
- TCP 443 能连通。
- 连接在 TLS 握手阶段被远端重置。
- 请求尚未进入 HTTP 应用层，因此 Nginx/FastAPI 业务日志可能不会出现对应 `POST /api` 记录。

## 5. 提交阿里云工单时可附带描述

```text
域名 yutingsmarthome.xin 已解析到 39.97.237.214，HTTPS 证书由 Let's Encrypt 签发，证书 SAN 包含 yutingsmarthome.xin 和 www.yutingsmarthome.xin。

浏览器访问 https://yutingsmarthome.xin/ 和 https://yutingsmarthome.xin/api 可正常返回，但微信小程序 wx.request 访问 https://yutingsmarthome.xin/api 报 request:fail net::ERR_CONNECTION_RESET。

使用 Python 标准库脚本从本地测试：DNS 解析正常，TCP 443 连接成功，但 TLS 默认握手、TLS1.2 握手、TLS1.3 握手均被远端 reset，错误为 ConnectionResetError / WinError 10054。

服务器本机使用 SNI 访问 https://yutingsmarthome.xin/api 可以命中 Nginx 并反向代理到 FastAPI。因此怀疑公网接入层、备案接入状态、云安全策略、防护策略或非浏览器客户端 TLS 指纹策略导致连接在到达 Nginx 前被重置。

请协助排查 39.97.237.214 / yutingsmarthome.xin 在公网 HTTPS 443 上是否存在针对非浏览器客户端、微信小程序请求、curl/Python TLS 客户端的连接重置策略，或备案/接入/安全防护层限制。
```

# 云汀智能家居服务端

这是“云汀智家”小程序的 Python 服务端 MVP，实现统一 `/api` 入口，与小程序 `apiClient` 的 `{ type, data }` 调用格式一致。

## 技术栈

- Python 3.10+
- FastAPI
- SQLite
- Uvicorn

## 本地运行

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

统一接口：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"device.bind","data":{"phone":"13800138000","deviceNo":"YT-AW-00000-A324","deviceName":"阳台浇水"}}'
```

## 当前测试部署

当前测试服务器部署在 `/home/yunting/yt_smart_home_server`，公网 API 入口为：

```text
https://api.yutingsmarthome.xin
```

请求链路：

```text
微信小程序 / 管理员工具
  -> https://api.yutingsmarthome.xin/api
  -> Nginx 443/80
  -> http://127.0.0.1:8000
  -> FastAPI / SQLite
```

Nginx 负责 HTTPS 证书、HTTP 到 HTTPS 跳转和反向代理。FastAPI/Uvicorn 当前运行在 `8000` 端口；正式测试稳定后，建议让 Uvicorn 只监听 `127.0.0.1:8000`，并在安全组关闭公网 `8000` 端口，只保留 `80/443`。

公网健康检查：

```bash
curl https://api.yutingsmarthome.xin/health
```

公网统一接口示例：

```bash
curl -X POST https://api.yutingsmarthome.xin/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"auth.checkSession","data":{}}'
```

证书由 Certbot/Let's Encrypt 签发，证书文件位于 `/etc/letsencrypt/live/api.yutingsmarthome.xin/`，Nginx 站点配置位于 `/etc/nginx/sites-available/yunting-api`。

## 已实现接口

- `auth.sendCode`
- `auth.loginByCode`
- `auth.checkSession`
- `auth.logout`
- `auth.bindWechat`
- `user.getProfile`
- `device.bind`
- `device.unbind`
- `device.list`
- `device.getStatus`
- `watering.saveConfig`
- `watering.startManual`
- `watering.stopManual`
- `admin.overview`
- `admin.user.findByPhone`
- `admin.user.findByOpenid`
- `admin.device.findByNo`
- `admin.bindAttempts.search`
- `admin.device.commands`
- `admin.user.disable`
- `admin.user.restore`
- `admin.device.disable`
- `admin.device.restore`
- `admin.device.forceUnbind`
- `admin.audit.search`

## 开发说明

当前已接入阿里云验证码服务。`YT_ENABLE_DEV_SMS=true` 时，`auth.sendCode` 会返回 `devCode`，方便本地联调；当前测试服务器设置 `YT_ENABLE_DEV_SMS=false`，会发送真实短信。

阿里云验证码配置项：

```bash
YT_ENABLE_DEV_SMS=false
YT_SMS_PROVIDER=aliyun_dypns
YT_SMS_TIMEOUT_SECONDS=10
YT_ALIYUN_SMS_ACCESS_KEY_ID=
YT_ALIYUN_SMS_ACCESS_KEY_SECRET=
YT_ALIYUN_SMS_SIGN_NAME=速通互联验证码
YT_ALIYUN_SMS_TEMPLATE_CODE=100001
YT_ALIYUN_SMS_TEMPLATE_CODE_KEY=code
YT_ALIYUN_SMS_TEMPLATE_EXTRA_PARAMS={"min":"5"}
YT_ALIYUN_SMS_ENDPOINT=dypnsapi.aliyuncs.com
YT_ALIYUN_SMS_REGION_ID=cn-hangzhou
```

`YT_SMS_PROVIDER=aliyun_dypns` 对接阿里云号码认证服务 `Dypnsapi.SendSmsVerifyCode`，模板码可以是控制台测试接口中的 `100001`。如果使用传统短信服务 `Dysmsapi.SendSms`，则将 `YT_SMS_PROVIDER` 改为 `aliyun`，`YT_ALIYUN_SMS_ENDPOINT` 改为 `dysmsapi.aliyuncs.com`，模板码使用 `SMS_...` 格式。

真实的 `YT_ALIYUN_SMS_ACCESS_KEY_ID` 和 `YT_ALIYUN_SMS_ACCESS_KEY_SECRET` 只放在服务器部署目录 `/home/yunting/yt_smart_home_server/.env` 中；仓库里的 `.env.example` 只保留空占位。不要把真实 AccessKey 写入小程序、文档、日志或管理员工具。如果凭据曾经泄露，应在阿里云 RAM 控制台禁用旧 AccessKey、生成新 AccessKey，更新服务器 `.env` 后重启服务。

开通和配置步骤见 [docs/aliyun-sms-integration.md](../../docs/aliyun-sms-integration.md)。

当前自建 HTTP 服务无法直接获取微信 `OPENID`，必须由小程序调用 `wx.login()` 获取一次性 `code`，服务端配置 `YT_WECHAT_APP_ID` 和 `YT_WECHAT_APP_SECRET` 后通过微信 `jscode2session` 换取真实 OpenID。服务端不会信任前端直接传入的 `openid`。

```bash
YT_WECHAT_APP_ID=
YT_WECHAT_APP_SECRET=
```

设备台账会在首次启动时写入 `AW`、`ES`、`LC`、`SP`、`GW` 各 `00000` 到 `00063` 的测试设备，规则与小程序 Mock 保持一致。

## 管理员查询

管理员接口默认使用同一个 `/api` 入口，正式产品应替换为独立管理员登录和角色权限。MVP 阶段需要在 `.env` 中配置：

```bash
YT_ADMIN_TOKEN=replace-with-a-long-random-admin-token
YT_BIND_FAILURE_WARNING_THRESHOLD=3
YT_BIND_FAILURE_LOCK_THRESHOLD=10
YT_BIND_FAILURE_LOCK_HOURS=24
```

如果要在本地用图形界面查询，可以从项目根目录运行 [tools/admin_client/yunting_admin_ui.py](../../tools/admin_client/yunting_admin_ui.py)：

```powershell
python .\tools\admin_client\yunting_admin_ui.py
```

查询目前总共绑定了多少台设备、多少台在线、各设备类型分别有多少：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.overview","data":{"adminToken":"YOUR_TOKEN"}}'
```

重点字段：

- `data.metricScope`：当前总览口径，默认是 `real_user_bound_devices`，排除预置测试用户和测试台账。
- `data.usersTotal`：真实用户数，不包含服务端预置的测试绑定用户。
- `data.devicesBound`：真实用户已绑定设备数。
- `data.devicesOnline`：真实用户已绑定设备中的在线设备数。
- `data.devicesByType`：按设备类型统计真实用户绑定设备，每项包含 `typeCode`、`typeLabel`、`totalCount`、`boundCount`、`onlineCount`。
- `data.registrySummary`：完整 `device_registry` 台账统计，包含开发版预置测试设备。
- `data.seedInventory`：开发版预置测试台账统计。

开发版会预置 500 台测试设备和 2 个测试绑定用户，用于验证绑定、离线和已绑定场景。已绑定在线测试设备默认归属 `11111111111`，已绑定离线测试设备默认归属 `00000000000`。如果总览里看到完整台账是 500 台，这是测试台账，不等同于真实运营设备数。

按手机号查询用户注册、登录、设备、绑定尝试和最近控制记录：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.user.findByPhone","data":{"adminToken":"YOUR_TOKEN","phone":"13800138000","limit":20}}'
```

按用户在“关于/账号信息”页面提供的 OpenID 反查用户：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.user.findByOpenid","data":{"adminToken":"YOUR_TOKEN","openid":"openid_xxx"}}'
```

按手机号或设备号查询绑定失败原因：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.bindAttempts.search","data":{"adminToken":"YOUR_TOKEN","phone":"13800138000","limit":50}}'
```

按设备号查询设备状态、绑定用户、绑定历史和最近控制记录：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.device.findByNo","data":{"adminToken":"YOUR_TOKEN","deviceNo":"YT-AW-00000-A324","limit":20}}'
```

查询某台设备最近的控制指令和手动浇水参数：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.device.commands","data":{"adminToken":"YOUR_TOKEN","deviceNo":"YT-AW-00000-A324","limit":50}}'
```

管理员查询和管理操作会写入 `admin_audit_events`，设备绑定尝试会写入 `device_bind_attempts`。普通日志只用于排查请求链路，客服查询应优先使用管理员接口。

## 绑定失败风控

`device.bind` 会按手机号统计最近 24 小时内的绑定失败次数：

- 失败超过 3 次：仍返回真实业务失败码，但 `message` 会提示继续失败将锁定。
- 失败达到 10 次：后续绑定请求在 24 小时窗口内返回 `DEVICE_BIND_LOCKED`。
- 锁定期间的请求会记录为 `blocked`，不继续延长锁定时间。

被锁定时返回示例：

```json
{
  "success": false,
  "code": "DEVICE_BIND_LOCKED",
  "message": "绑定失败次数过多，请在2026-06-03 10:20:00后再试",
  "data": {
    "bindRisk": {
      "failedCount24h": 10,
      "lockThreshold": 10,
      "lockHours": 24,
      "locked": true,
      "lockedUntilText": "2026-06-03 10:20:00"
    }
  }
}
```

客服排查某个手机号是否被锁定或为什么绑定失败，优先使用：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"admin.bindAttempts.search","data":{"adminToken":"YOUR_TOKEN","phone":"13800138000","limit":50}}'
```

## SQLite 容量建议

SQLite 适合 MVP、内测、单机部署和轻量生产试运行。只记录用户、绑定和少量控制指令时，几千到一两万台设备通常可以支撑；如果设备频繁上报心跳、传感器和工作事件，瓶颈会先出现在写入并发和数据库文件增长上。

粗略建议：100 - 5,000 台设备适合；5,000 - 20,000 台设备可短期使用但要加索引和归档；20,000 台以上要谨慎；50,000 台以上建议升级到 MySQL、PostgreSQL 或云数据库。

## 日志查看

开发模式下服务使用两个日志文件：

- `logs/server.log`：Uvicorn 启动日志、HTTP access log、进程错误。
- `logs/app.log`：应用日志，记录每次 `/api` 的 `type`、返回码、耗时、异常堆栈和请求 ID。

常用命令：

```bash
cd /home/yunting/yt_smart_home_server
tail -f logs/server.log
tail -f logs/app.log
tail -n 100 logs/app.log
grep 'DEVICE_ALREADY_BOUND' logs/app.log
grep 'api_error' logs/app.log
```

每个 HTTP 响应都会带 `X-Request-Id`，后续如果小程序把这个 ID 也打印出来，就可以按请求 ID 在 `logs/app.log` 中定位单次请求。
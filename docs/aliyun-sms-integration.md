# 阿里云短信验证码接入说明

本文说明“云汀智家”如何开通阿里云验证码服务，并把服务端 `auth.sendCode` 从开发验证码切换为真实短信验证码。

## 1. 阿里云控制台开通

1. 登录阿里云控制台，开通“号码认证服务”或“短信服务”。
2. 进入对应控制台，申请短信签名。
   - 建议签名：`云汀智家` 或与小程序/营业执照一致的品牌名。
   - 签名审核通常需要提交应用、网站、营业执照或其他资质证明。
3. 申请验证码短信模板。
   - 模板变量名必须包含 `${code}`，因为服务端默认发送 `{"code":"123456"}`。
   - 示例模板：`验证码${code}，您正在登录云汀智家，5分钟内有效，请勿泄露。`
  - 如果使用号码认证服务 `Dypnsapi.SendSmsVerifyCode`，模板码可能是 `100001` 这类数值。
  - 如果使用传统短信服务 `Dysmsapi.SendSms`，审核通过后会得到类似 `SMS_123456789` 的模板 Code。
4. 创建 RAM 用户并生成 AccessKey。
   - 不建议使用主账号 AccessKey。
  - MVP 阶段可给 RAM 用户授权验证码发送权限；正式上线建议收敛为最小权限策略。号码认证服务使用 `dypns:SendSmsVerifyCode`，传统短信服务使用 `dysms:SendSms`。
5. 确认服务器可以访问公网 HTTPS，号码认证服务至少需要能访问 `https://dypnsapi.aliyuncs.com`，传统短信服务至少需要能访问 `https://dysmsapi.aliyuncs.com`。

## 2. 服务端配置

服务端支持两种阿里云接口：

- `YT_SMS_PROVIDER=aliyun_dypns`：号码认证服务 `Dypnsapi.SendSmsVerifyCode`，适配 API Explorer 生成的 `SendSmsVerifyCodeRequest` 示例。
- `YT_SMS_PROVIDER=aliyun`：传统短信服务 `Dysmsapi.SendSms`，适配 `SMS_...` 模板 Code。

代码支持开发验证码模式，但当前测试服务器已经切到真实短信模式，`YT_ENABLE_DEV_SMS=false`。

在服务器 `/home/yunting/yt_smart_home_server/.env` 中配置：

```bash
YT_ENABLE_DEV_SMS=false
YT_SMS_PROVIDER=aliyun_dypns
YT_SMS_TIMEOUT_SECONDS=10
YT_ALIYUN_SMS_ACCESS_KEY_ID=你的RAM用户AccessKeyId
YT_ALIYUN_SMS_ACCESS_KEY_SECRET=你的RAM用户AccessKeySecret
YT_ALIYUN_SMS_SIGN_NAME=速通互联验证码
YT_ALIYUN_SMS_TEMPLATE_CODE=100001
YT_ALIYUN_SMS_TEMPLATE_CODE_KEY=code
YT_ALIYUN_SMS_TEMPLATE_EXTRA_PARAMS={"min":"5"}
YT_ALIYUN_SMS_ENDPOINT=dypnsapi.aliyuncs.com
YT_ALIYUN_SMS_REGION_ID=cn-hangzhou
```

### 2.1 RAM AccessKey 存放位置

当前用于发送短信的 RAM 用户 AccessKey 只应放在服务端运行目录的 `.env` 文件中：

```text
/home/yunting/yt_smart_home_server/.env
```

服务端启动时会从当前工作目录读取 `.env`，并通过以下环境变量加载短信凭据：

```bash
YT_ALIYUN_SMS_ACCESS_KEY_ID=真实AccessKeyId
YT_ALIYUN_SMS_ACCESS_KEY_SECRET=真实AccessKeySecret
```

仓库中的 `server/yt_smart_home_server/.env.example` 只保留空占位，不能填写真实值；`server/yt_smart_home_server/.gitignore` 已忽略 `.env`，避免误提交。

文档中只记录变量名、文件路径和处理规则，不记录真实 AccessKeyId 或 AccessKeySecret。如果真实凭据已经出现在 Git、聊天记录、截图、日志或工单中，应在阿里云 RAM 控制台立即禁用并重新生成一组新 AccessKey，然后更新服务器 `.env` 并重启服务。

建议处理：

- 保持 RAM 用户最小权限，只允许发送验证码所需的接口权限。
- 不把 AccessKey 写入小程序代码、前端配置、README、设计文档、日志或管理员工具。
- 服务器上将 `.env` 权限限制为部署用户可读写，例如 `chmod 600 /home/yunting/yt_smart_home_server/.env`。
- 后续切换 systemd 时，在 service 中设置 `WorkingDirectory=/home/yunting/yt_smart_home_server`，确保服务仍能读取正确的 `.env`。

如果改用传统短信服务 `Dysmsapi.SendSms`，配置改为：

```bash
YT_SMS_PROVIDER=aliyun
YT_ALIYUN_SMS_TEMPLATE_CODE=SMS_审核通过后的模板Code
YT_ALIYUN_SMS_ENDPOINT=dysmsapi.aliyuncs.com
```

如果模板除 `${code}` 外还有其他变量，例如 `${min}`，需要通过 `YT_ALIYUN_SMS_TEMPLATE_EXTRA_PARAMS` 补充：

```bash
YT_ALIYUN_SMS_TEMPLATE_EXTRA_PARAMS={"min":"5"}
```

配置后重启服务：

```bash
cd /home/yunting/yt_smart_home_server
python3 -m py_compile app/settings.py app/sms.py app/services.py
pkill -f 'python3 -m uvicorn app.main:app'
nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 >> logs/server.log 2>&1 &
curl http://127.0.0.1:8000/health
```

当前测试环境公网入口为 Nginx HTTPS 反向代理：

```text
https://yutingsmarthome.xin/api -> http://127.0.0.1:8000/api
```

小程序真机测试必须在微信公众平台配置 request 合法域名：

```text
https://yutingsmarthome.xin
```

## 3. 验证发送

发送验证码：

```bash
curl -X POST http://127.0.0.1:8000/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"auth.sendCode","data":{"phone":"13800138000","scene":"login"}}'
```

公网 HTTPS 验证：

```bash
curl -X POST https://yutingsmarthome.xin/api \
  -H 'Content-Type: application/json' \
  -d '{"type":"auth.sendCode","data":{"phone":"13800138000","scene":"login"}}'
```

注意：该请求会发送真实短信并产生短信费用，测试时不要反复调用。

生产模式下响应不会返回 `devCode`：

```json
{
  "success": true,
  "code": "OK",
  "message": "验证码已发送",
  "data": {
    "cooldownSeconds": 60
  }
}
```

如果配置缺失，会返回：

```json
{
  "success": false,
  "code": "SMS_NOT_CONFIGURED",
  "message": "短信服务未配置"
}
```

## 4. 当前服务端规则

- 同一个手机号同一场景 60 秒内不能重复发送。
- 验证码有效期 5 分钟。
- 登录验证码最多尝试 5 次，超过后当前验证码作废。
- `YT_ENABLE_DEV_SMS=true` 时不会调用阿里云，会返回 `.env` 中的 `YT_DEV_SMS_CODE`，用于开发联调。

## 5. 上线建议

- AccessKey 只放在服务器 `.env`，不要写入小程序前端或仓库。
- 给 RAM 用户配置最小权限，不使用主账号 AccessKey。
- 为 `auth.sendCode` 增加更完整的风控：IP 限流、设备指纹、图形验证码、黑名单和每日发送上限。
- 监控阿里云短信发送失败码，重点关注签名未审核、模板变量不匹配、余额不足和业务限流。
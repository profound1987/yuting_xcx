# 2026-09-03 Smart LED 绑定随机数防呆部署记录

## 1. 问题与结论

同一台 Smart LED 在原账号解绑后，另一台手机添加设备时报错：

```text
cloud binding authorization is invalid for this connection
```

生产服务器最近的 BLE 绑定会话表明：成功会话均携带 22 字符的 `deviceNonce`，报错手机连续创建的会话中 `deviceNonce` 为空。根因是第二台手机运行了旧版或缓存版小程序，没有把 `device.hello.ack` 返回的本次连接随机数上传云端。服务器未生成重绑定授权，设备按安全规则拒绝了无授权请求。

设备端的校验行为正确。本次没有降低 PIN、云端所有权或 HMAC 授权的安全要求，也没有修改 Smart LED 固件。

## 2. 修改内容

修改文件：

```text
app/services.py
```

`device.prepareBleBind` 现在对 `claim` 和 `recover` 两种模式都强制要求有效的 22 字符 `deviceNonce`：

- 参数格式错误时返回 `DEVICE_NONCE_INVALID`。
- 参数缺失时返回 `DEVICE_NONCE_REQUIRED`，提示用户更新小程序并重新连接设备。
- 只有取得有效随机数后才创建使用生产 `deviceKey` 签名的 `rebindAuthorization`。

该修改不改变数据库结构，不修改设备归属，不影响智家设备配网和日常通信接口。

## 3. 测试与备份

部署前本地验证：

- `python -m unittest discover -s tests -p "test_*.py"`：通过。
- `python -m py_compile app/services.py app/database.py app/main.py`：通过。
- 回归测试覆盖旧客户端缺少随机数时被拒绝，以及账号 A 解绑后账号 B 使用新随机数完整完成 `claim` 绑定。

生产备份目录：

```text
/home/yunting/yt_smart_home_server/backup_20260903_130542_device_nonce_guard
```

备份包含部署前 Python 代码、`requirements.txt`、`README.md` 和 SQLite 一致性备份。

## 4. 部署结果

- 部署日期：2026-09-03（Asia/Shanghai）
- 公网入口：`https://yutingsmarthome.xin/api`
- 新 Uvicorn PID：`317229`
- 线上 `app/services.py` SHA-256：`25877c7c5cda2a369234f0785dedad12f2ae9c900903027cf3155b67170744e5`
- 线上与本地文件摘要一致。
- Uvicorn 日志未发现 `ERROR` 或 `Traceback`。
- SQLite `PRAGMA integrity_check`：`ok`。
- 设备总数：540，其中 `smart_home` 500 台、`smart_car` 40 台；已绑定设备仍为 254 台。
- `mosquitto.service` 与 `yt-mqtt-worker.service` 均保持 `active`。

公网验证结果：

- `GET /api` 返回 HTTP 200。
- 未登录调用 `device.prepareBleBind` 返回 `SESSION_MISSING`，说明 BLE 路由正常。
- 使用错误管理员令牌调用 `admin.users.search` 返回 `ADMIN_FORBIDDEN`，说明原有接口未受影响。
- 线上代码已确认包含新的 `DEVICE_NONCE_REQUIRED` 防呆分支。

## 5. 客户端要求

云端防呆只能把旧客户端的失败原因提前并明确地提示出来，不能让不具备安全授权流程的旧版小程序继续绑定设备。第二台手机必须使用包含 `deviceNonce` 和 `rebindAuthorization` 流程的最新体验版或正式版：

1. 删除微信中缓存的旧小程序，或从小程序右上角重新进入最新版本。
2. 测试人员应扫码进入最新体验版，不能误用较早的正式版。
3. 如果面向普通用户测试，需要在微信公众平台上传、审核并发布当前小程序版本。
4. 更新后重新扫描设备二维码并连接，云端将签发新的 `claim` 授权。

## 6. 回滚依据

如果线上出现与本次校验有关的异常，先保存当前日志，再从第 3 节备份目录恢复 `app/services.py`，按 [服务器部署 Runbook](server-deployment-runbook.md) 重启 Uvicorn。数据库结构和业务数据未被本次部署修改，通常无需回滚数据库。

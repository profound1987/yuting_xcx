# 2026-08-03 Smart LED 安全重绑定云端部署记录

## 1. 部署目标

本次部署补齐 Smart LED 删除后重新绑定、同一所有者异常恢复绑定，以及离线设备可从小程序本地设备列表删除的云端支持。

安全边界保持不变：

- 正确的设备号和 PIN 只用于查找生产台账并启动绑定，不直接转移设备所有权。
- 未绑定设备允许进入 `claim` 模式。
- 已绑定设备仅允许原云端所有者进入 `recover` 模式。
- 其他账号不能凭设备号和 PIN 抢绑仍属于原所有者的设备。
- 云端使用生产台账中的 `deviceKey` 对设备随机数、绑定会话、challenge、目标用户、绑定模式和过期时间计算 HMAC-SHA256 授权；设备端校验授权后才接受绑定或恢复绑定。
- `device.prepareBleBind`、`device.verifyBleProof`、`device.finishBleBind` 均要求有效的 `sessionToken`。

## 2. 部署范围

线上目录：`/home/yunting/yt_smart_home_server`

本次更新文件：

- `README.md`
- `app/database.py`
- `app/services.py`

数据库采用增量迁移，`device_ble_bind_sessions` 新增：

- `device_nonce`
- `bind_mode`
- `authorization_version`
- `authorization_signature`

没有删除、改名既有表和字段，也没有修改设备归属数据。智家与智车继续共用统一账号、设备台账和服务入口。

## 3. 线上备份与部署目录

部署前备份：

```text
/home/yunting/yt_smart_home_server/backup_20260803_095836_ble_rebind_v1
```

上传暂存目录：

```text
/home/yunting/yt_smart_home_server/deploy_20260803_095836_ble_rebind_v1
```

备份包含应用代码、`requirements.txt`、`README.md`、`server.pid` 和 SQLite 一致性备份。备份数据库 `PRAGMA integrity_check=ok`，设备总数为 540。

## 4. 部署结果

- 部署日期：2026-08-03（Asia/Shanghai）
- 公网入口：`https://yutingsmarthome.xin/api`
- 新 Uvicorn PID：`220278`
- SQLite 完整性：`ok`
- 设备总数：540
- 已绑定设备：254
- `smart_home`：500
- `smart_car`：40
- `mosquitto.service`：`active`
- `yt-mqtt-worker.service`：`active`
- Uvicorn 日志：未发现 `ERROR` 或 `Traceback`

线上文件 SHA-256 与本地部署版本一致：

```text
README.md       8f91d746c8a3f0391e83db77f63b57c5014ebdcdcd049df37a63565eaa73ab9d
app/database.py a4fac0adde0cf2fdae2be809b2ff754b95622ca3072c402f2f0f43889793540d
app/services.py 06537ef6d48401329980514b64918a55c7520284c3d4f98776eedaabb5a4ef5b
```

## 5. 已执行验证

- 暂存代码和线上代码均通过 Python 语法编译检查。
- 数据库迁移后确认四个新字段存在，原有 540 台设备及 254 条归属关系保持不变。
- 公网 `GET /api` 返回 HTTP 200。
- 原智家 `device.checkProvisionStatus` 接口仍可访问，并按预期返回不存在的测试会话错误。
- 新 BLE 接口在缺少登录态时返回 `SESSION_MISSING`。
- 使用临时有效用户会话对一台未绑定 SL 执行真实 `device.prepareBleBind`，成功返回 `claim` 模式和 43 字符授权签名。
- 验证结束后，临时用户、登录会话和 BLE 绑定会话均已清理；没有执行 `finishBleBind`，没有改变设备归属。
- MQTT Broker 和 MQTT Worker 未重启，部署后均保持正常运行。

## 6. 客户端与固件联调约束

云端已经先行部署。测试时必须同时使用包含本轮安全重绑定逻辑的智车小程序开发版和 Smart LED 固件 `0.8.0`：

1. 小程序连接设备后读取本次连接的 `deviceNonce`。
2. 小程序携带 `sessionToken`、设备号、PIN 和 `deviceNonce` 请求 `device.prepareBleBind`。
3. 小程序把云端返回的授权字段发送给设备。
4. 设备验证 HMAC 授权、随机数、目标用户、模式和有效期后，才写入或替换 Owner。

旧固件不能验证新授权；旧小程序也不会提交完整的新绑定参数，因此不要混用新旧版本做最终验收。

## 7. 回滚依据

若线上出现与本次变更相关且无法现场修复的问题，先保留当前故障数据库与日志，再从第 3 节备份目录恢复应用文件和 SQLite，按 [服务器部署 Runbook](server-deployment-runbook.md) 重启 Uvicorn 并复核公网 API、智家配网接口、设备数量和数据库完整性。禁止直接覆盖唯一备份。

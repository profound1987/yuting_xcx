# 服务器部署 Runbook

> 适用范围：云汀智家测试服务器上的 FastAPI 后端部署、重启、验证和回滚。当前服务器使用 `nohup + server.pid` 运行 Uvicorn，尚未接入 systemd。设备 MQTTS 首版部署和协议落地见 [MQTTS 设备云端通信落地方案](mqtts-rollout-plan.md)。

## 1. 当前部署信息

- 服务器：`39.97.237.214`
- SSH 用户：`yunting`
- SSH key：`C:\Users\THINK\.ssh\yunting_dev_ed25519`
- 后端目录：`/home/yunting/yt_smart_home_server`
- 运行端口：`0.0.0.0:8000`
- 公网 API：`https://yutingsmarthome.xin/api`
- MQTTS 首版 Broker：`yutingsmarthome.xin:8883`（当前 `mqtt.yutingsmarthome.xin` 尚未配置 DNS）
- 反向代理：Nginx 根域名 `location = /api` -> `http://127.0.0.1:8000/api`
- 进程方式：`nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &`
- MQTTS Broker 服务：`mosquitto.service`
- MQTT Worker 服务：`yt-mqtt-worker.service`，运行 `python3 -m app.mqtt_worker`
- PID 文件：`/home/yunting/yt_smart_home_server/server.pid`
- 日志文件：`/home/yunting/yt_smart_home_server/uvicorn.log`
- 数据库目录：`/home/yunting/yt_smart_home_server/data/`
- 环境变量文件：`/home/yunting/yt_smart_home_server/.env`

当前远端 `.venv` 存在，但历史部署实际使用的是系统 `python3` 加用户级包路径。因此部署时默认使用：

```bash
python3 -m pip install --user -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

后续应迁移为 systemd 服务，并让 Uvicorn 只监听 `127.0.0.1:8000`。

## 2. 部署前注意事项

1. 不要覆盖远端 `.env`，里面有短信、微信和管理员密钥。
2. 不要覆盖或删除远端 `data/`，里面有 SQLite 业务数据。
3. 不要把真实 `YT_ADMIN_TOKEN`、短信 AccessKey、微信 AppSecret 写入仓库、文档、日志或聊天记录。
4. 部署前必须先备份远端后端代码文件。
5. 新增 Python 依赖时必须执行 `python3 -m pip install --user -r requirements.txt`。
6. 修改数据库 schema 后必须执行 `init_db()`；当前 schema 使用 `CREATE TABLE IF NOT EXISTS`，不会删除旧数据。
7. 部署后必须验证公网 `GET /api` 和关键 `POST /api` 接口。
8. 如果本地 PowerShell 找不到 `ssh` 或 `scp`，使用完整路径：

```powershell
C:\Windows\System32\OpenSSH\ssh.exe
C:\Windows\System32\OpenSSH\scp.exe
```

## 3. 部署文件范围

常规后端部署只上传这些文件：

```text
server/yt_smart_home_server/requirements.txt
server/yt_smart_home_server/README.md
server/yt_smart_home_server/app/*.py
```

如果只改了部分文件，也可以只上传对应文件。例如本次 AES-CCM 与管理员用户列表部署上传了：

```text
requirements.txt
README.md
app/database.py
app/services.py
```

不要上传：

```text
.env
data/
logs/
uvicorn.log
server.pid
backup_*/
```

## 4. 标准部署步骤

以下命令在 Windows PowerShell 中执行。

### 4.1 备份远端代码

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" yunting@39.97.237.214 '
set -e
cd /home/yunting/yt_smart_home_server
backup_dir="backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$backup_dir/app"
cp requirements.txt README.md "$backup_dir/"
cp app/*.py "$backup_dir/app/"
echo "BACKUP=$backup_dir"
'
```

记下输出的 `BACKUP=backup_YYYYMMDD_HHMMSS`，回滚时会用到。

### 4.2 上传本地文件

```powershell
& "C:\Windows\System32\OpenSSH\scp.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" `
  "d:\workspace\微信小程序\server\yt_smart_home_server\requirements.txt" `
  "d:\workspace\微信小程序\server\yt_smart_home_server\README.md" `
  yunting@39.97.237.214:/home/yunting/yt_smart_home_server/

& "C:\Windows\System32\OpenSSH\scp.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" `
  "d:\workspace\微信小程序\server\yt_smart_home_server\app\database.py" `
  "d:\workspace\微信小程序\server\yt_smart_home_server\app\services.py" `
  yunting@39.97.237.214:/home/yunting/yt_smart_home_server/app/
```

如上传全部 `app/*.py`，先确认本地没有临时文件或未验证文件。

### 4.3 安装依赖、初始化数据库并重启

```powershell
@'
set -e
cd /home/yunting/yt_smart_home_server

python3 -m pip install --user -r requirements.txt
python3 -m py_compile app/database.py app/services.py app/main.py

python3 - <<'PYCODE'
from app.database import init_db
from app.services import ensure_seed_data, HANDLERS
init_db()
ensure_seed_data()
print('db ok')
print('has admin.users.search:', 'admin.users.search' in HANDLERS)
PYCODE

if [ -f server.pid ]; then
  old_pid=$(cat server.pid || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" || true
    sleep 2
  fi
fi

for pid in $(ps -ef | awk '/uvicorn app\.main:app/ && !/awk/ {print $2}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 2

nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
echo $! > server.pid
sleep 3
cat server.pid
ps -ef | grep 'uvicorn app.main:app' | grep -v grep || true
tail -n 50 uvicorn.log
'@ | & "C:\Windows\System32\OpenSSH\ssh.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" yunting@39.97.237.214 'bash -s'
```

期望输出包含：

```text
db ok
Started server process [...]
Application startup complete.
Uvicorn running on http://0.0.0.0:8000
```

如果是管理员用户列表版本，还应看到：

```text
has admin.users.search: True
```

## 5. 部署后验证

### 5.1 公网 GET /api

```powershell
curl.exe -i https://yutingsmarthome.xin/api
```

期望返回 HTTP 200，响应体包含：

```json
{"service":"yt_smart_home_server","message":"Yunting Smart Home API endpoint. Use POST /api with JSON body."}
```

### 5.2 验证新管理员接口已加载

不要在命令里写真实管理员密钥。用错误 token 验证接口存在即可：

```powershell
curl.exe -sS -X POST https://yutingsmarthome.xin/api `
  -H "Content-Type: application/json" `
  -d '{"type":"admin.users.search","data":{"adminToken":"invalid-token-for-deploy-check","limit":1}}'
```

期望返回：

```json
{"success":false,"code":"ADMIN_FORBIDDEN","message":"无管理员权限","data":null}
```

如果返回 `API_NOT_FOUND`，说明 Uvicorn 还在运行旧代码，需重新执行重启步骤。

### 5.3 验证配网状态接口

```powershell
curl.exe -sS -X POST https://yutingsmarthome.xin/api `
  -H "Content-Type: application/json" `
  -d '{"type":"device.checkProvisionStatus","data":{"phone":"13800000000","deviceNo":"YT-AW-00001-4BF5","provisionSessionId":"missing"}}'
```

期望返回 `PROVISION_SESSION_NOT_FOUND`，说明接口存在且业务逻辑生效。

### 5.4 验证 prepareConfigure 创建配网会话

```powershell
curl.exe -sS -X POST https://yutingsmarthome.xin/api `
  -H "Content-Type: application/json" `
  -d '{"type":"device.prepareConfigure","data":{"phone":"13800008888","deviceNo":"YT-AW-00003-9A57"}}'
```

期望 `success=true`，且 `data.provisionSessionId` 有值。注意：该命令会在测试库里创建或更新该手机号用户，仅用于测试环境；测试设备号必须从台账中选择当前未绑定设备，不要手写校验码；方案 B 中服务端不再接收或校验设备 PIN。

## 6. MQTTS 运维验证

### 6.1 服务状态

```bash
sudo systemctl status mosquitto --no-pager
sudo systemctl status yt-mqtt-worker --no-pager
ss -ltnp | grep -E ':(8000|8883)'
ps -ef | grep -E 'uvicorn app.main:app|python3 -m app.mqtt_worker|python3 mqtt_sim_device.py' | grep -v grep
```

当前首版 MQTTS 组件：

- Broker：`mosquitto.service`，监听 `0.0.0.0:8883`。
- Worker：`yt-mqtt-worker.service`，运行 `/usr/bin/python3 -m app.mqtt_worker`。
- 模拟设备：测试阶段可运行 `/home/yunting/yt_smart_home_server/mqtt_sim_device.py`。

### 6.2 Worker 启停

```bash
sudo systemctl restart yt-mqtt-worker
sudo systemctl stop yt-mqtt-worker
sudo systemctl start yt-mqtt-worker
sudo journalctl -u yt-mqtt-worker -n 100 --no-pager
```

Worker 日志主要仍会进入后端 `logs/app.log`，可用：

```bash
cd /home/yunting/yt_smart_home_server
grep -R "mqtt_down\|mqtt_up\|mqtt_connected" -n logs | tail -n 100
```

### 6.3 Mosquitto 配置文件

远端关键文件：

```text
/etc/mosquitto/conf.d/yunting-mqtts.conf
/etc/mosquitto/yunting_passwordfile
/etc/mosquitto/yunting_aclfile
/etc/mosquitto/certs/chain.pem
/etc/mosquitto/certs/fullchain.pem
/etc/mosquitto/certs/privkey.pem
/etc/systemd/system/yt-mqtt-worker.service
```

仓库内模板：

```text
server/yt_smart_home_server/deploy/mosquitto/yunting-mqtts.conf.example
server/yt_smart_home_server/deploy/mosquitto/aclfile.example
server/yt_smart_home_server/deploy/mosquitto/yt-mqtt-worker.service
```

注意：MQTT 密码和真实证书不得提交到仓库或写入文档。

### 6.4 证书同步注意事项

Mosquitto 当前使用复制到 `/etc/mosquitto/certs/` 的 Let’s Encrypt 证书副本。证书续期后，需要同步 `chain.pem`、`fullchain.pem`、`privkey.pem`，并保持：

```bash
sudo chown root:mosquitto /etc/mosquitto/certs/*.pem
sudo chmod 0640 /etc/mosquitto/certs/*.pem
sudo systemctl restart mosquitto
sudo systemctl restart yt-mqtt-worker
```

后续建议增加 Certbot deploy hook 自动同步证书。

### 6.5 MQTTS 闭环验证

测试设备号：`YT-AW-00032-7A39`，设备端首版联调设备号：`YT-AW-00000-A324`。测试凭据保存在远端环境文件中，不要泄露到聊天、日志或文档。

当前服务器会在 `provision.ack` / `bootstrap.ack` 的加密 payload 中返回 `mqtt` 对象。远端 `.env` 必须配置：

```text
YT_MQTT_ENABLED=true
YT_MQTT_HOST=yutingsmarthome.xin
YT_MQTT_PORT=8883
YT_MQTT_TLS=true
YT_MQTT_DEVICE_PASSWORD=<只放服务器，不写入文档>
YT_MQTT_KEEPALIVE_SECONDS=90
```

设备端必须启用 TLS 证书校验；云端下发 `mqtt.tls.verifyRequired=true` 和 `mqtt.tls.caName=ISRG Root X1`，不得把“跳过证书校验”作为正式联调方案。

闭环验证目标：

1. Worker 发布 `queued` 命令到设备 `/down` Topic。
2. 模拟设备收到下行后发布 `command.ack`。
3. `device_commands.status` 最终变为 `succeeded`，并写入 `sent_at`、`received_at`、`executing_at`、`ack_at`。
4. HTTPS `device.secureMessage msgType=bootstrap.request` 返回加密 `bootstrap.ack`，解密后包含 `mqtt.enabled=true`、`mqtt.host=yutingsmarthome.xin`、`mqtt.port=8883`、`heartbeatIntervalMs=90000`。
5. `device.prepareConfigure`、`provision.ack` 和 `bootstrap.ack` 的 `heartbeatIntervalMs` 均应为 `90000`。

远端验证脚本：

```bash
cd /home/yunting/yt_smart_home_server
python3 provision_ack_validation.py --device-no YT-AW-00001-4BF5 --phone 13800009997
python3 mqtt_cloud_validation.py --server-root /home/yunting/yt_smart_home_server --device-no YT-AW-00000-A324 --timeout-seconds 25
```

期望输出包含：

```text
PROVISION_ACK success=True ... heartbeat=90000 ... mqttEnabled=True ... tlsVerify=True ... caName=ISRG Root X1 ... passwordPresent=True ... caPemPresent=True
BOOTSTRAP_OK heartbeat=90000 mqttEnabled=True host=yutingsmarthome.xin port=8883 tlsVerify=True caName=ISRG Root X1 passwordPresent=True
COMMAND_STATUS {... 'status': 'succeeded' ...}
```

HTTPS `command.pull` 机制继续保留，不因启用 MQTTS 而删除。

## 7. 回滚步骤

如果部署后公网接口异常，先找到本次备份目录，例如：

```text
backup_20260606_193847
```

执行：

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" yunting@39.97.237.214 '
set -e
cd /home/yunting/yt_smart_home_server
backup_dir="backup_20260606_193847"
cp "$backup_dir/requirements.txt" ./requirements.txt
cp "$backup_dir/README.md" ./README.md
cp "$backup_dir/app/"*.py ./app/
python3 -m py_compile app/database.py app/services.py app/main.py
if [ -f server.pid ]; then
  old_pid=$(cat server.pid || true)
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" || true
    sleep 2
  fi
fi
for pid in $(ps -ef | awk '/uvicorn app\.main:app/ && !/awk/ {print $2}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 2
nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
echo $! > server.pid
sleep 3
tail -n 50 uvicorn.log
'
```

回滚后再次执行“部署后验证”。

## 8. 常见问题

### 8.1 上传成功但接口仍是 API_NOT_FOUND

原因通常是旧 Uvicorn 进程没停掉。处理：

1. SSH 到服务器。
2. 执行 `ps -ef | grep 'uvicorn app.main:app' | grep -v grep`。
3. 停掉所有旧进程。
4. 重新用 `nohup python3 -m uvicorn ...` 启动。
5. 再验证 `admin.users.search` 是否返回 `ADMIN_FORBIDDEN` 而不是 `API_NOT_FOUND`。

### 8.2 `.venv/bin/python` 没有 pip

当前远端 `.venv` 历史上不是完整运行环境。本阶段直接使用系统 `python3` 和 `--user` 包安装。后续建议重建虚拟环境或迁移 systemd。

### 8.3 cryptography 未安装

`device.secureMessage` 依赖 `cryptography.hazmat.primitives.ciphers.aead.AESCCM`。如果未安装，服务端会返回 `CRYPTO_NOT_CONFIGURED`。处理：

```bash
cd /home/yunting/yt_smart_home_server
python3 -m pip install --user -r requirements.txt
python3 - <<'PY'
import cryptography
print(cryptography.__version__)
PY
```

### 8.4 终端 SSH 命令无输出或找不到 ssh

优先使用完整路径：

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" yunting@39.97.237.214 "echo ok"
```

### 8.5 管理员密钥验证

不要把真实 `YT_ADMIN_TOKEN` 写在命令、文档或日志里。部署验证只需要错误 token 返回 `ADMIN_FORBIDDEN`。真正查询用户时，在本地管理员工具界面输入真实 token。

### 8.6 MQTTS 子域名未解析

现象：设备端或命令行客户端连接 `mqtt.yutingsmarthome.xin:8883` 失败，DNS 查询无结果。

排查：

```bash
getent hosts mqtt.yutingsmarthome.xin || true
getent hosts yutingsmarthome.xin || true
```

处理：当前首版统一连接 `yutingsmarthome.xin:8883`。等 `mqtt.yutingsmarthome.xin` DNS、证书和 Broker 配置都完成后，再通知设备端切换。

### 8.7 Mosquitto 启动失败：重复 persistence 配置

现象：`systemctl status mosquitto` 显示配置错误，日志含 `Duplicate persistence_location value in configuration` 或类似重复项提示。

原因：Ubuntu/Debian 默认 `/etc/mosquitto/mosquitto.conf` 已经包含部分全局配置，`conf.d/*.conf` 中再次配置 `persistence`、`persistence_location`、`log_dest`、`log_type` 可能导致重复。

处理：MQTTS 业务配置文件只保留 listener/TLS/认证/ACL 等必要项，避免重复声明全局项。参考仓库模板：

```text
server/yt_smart_home_server/deploy/mosquitto/yunting-mqtts.conf.example
```

### 8.8 Mosquitto 无法读取 Let’s Encrypt 证书

现象：Mosquitto 启动失败，日志出现证书或私钥 `Permission denied`。

原因：`/etc/letsencrypt/live/...` 和 `/etc/letsencrypt/archive/...` 通常为 root 限制权限，Mosquitto 运行用户无法直接读取。

处理：将证书副本同步到 `/etc/mosquitto/certs/`，并授权给 `mosquitto` 组读取：

```bash
sudo mkdir -p /etc/mosquitto/certs
sudo cp /etc/letsencrypt/live/yutingsmarthome.xin/chain.pem /etc/mosquitto/certs/chain.pem
sudo cp /etc/letsencrypt/live/yutingsmarthome.xin/fullchain.pem /etc/mosquitto/certs/fullchain.pem
sudo cp /etc/letsencrypt/live/yutingsmarthome.xin/privkey.pem /etc/mosquitto/certs/privkey.pem
sudo chown root:mosquitto /etc/mosquitto/certs/*.pem
sudo chmod 0640 /etc/mosquitto/certs/*.pem
sudo systemctl restart mosquitto
```

证书续期后也要重新同步，后续应增加 Certbot deploy hook。

### 8.9 `mosquitto_pub` TLS CA 文件选择

现象：普通用户执行 `mosquitto_pub --cafile /etc/mosquitto/certs/chain.pem ...` 报 `Problem setting TLS options: File not found`。

原因：该文件对普通用户不可读，虽然 Mosquitto 服务本身可通过 `mosquitto` 组读取。

处理：命令行临时测试可以使用系统 CA，不要直接引用 `/etc/mosquitto/certs/chain.pem`：

```bash
mosquitto_pub -h yutingsmarthome.xin -p 8883 \
  --cafile /etc/ssl/certs/ca-certificates.crt \
  -u "$YT_MQTT_USERNAME" -P "$YT_MQTT_PASSWORD" \
  -t 'yt/v1/devices/YT-AW-00032-7A39/status' -r -n
```

上面命令会清理 retained status，仅用于明确需要清理 retained 消息的场景；普通连通性测试不要向业务 Topic 发送未加密 payload。不要把真实用户名和密码写入文档或聊天记录。

### 8.10 Worker 日志不一定在 `mqtt_worker.log`

现象：`mqtt_worker.log` 为空，但 Worker 进程正常，命令也能下发。

原因：Worker 复用后端 logging 配置，业务日志主要写入 `logs/app.log`；`mqtt_worker.log` 只接收 stdout/stderr。

排查：

```bash
cd /home/yunting/yt_smart_home_server
grep -R "mqtt_connected\|mqtt_down\|mqtt_up" -n logs | tail -n 100
sudo journalctl -u yt-mqtt-worker -n 100 --no-pager
```

### 8.11 测试设备号不能手写校验码

现象：Worker 收到 MQTT 上行，但日志显示 `INVALID_DEVICE`，命令一直 `queued` 或最终 `expired`。

原因：设备号带校验位，手写如 `YT-AW-00032-8E80` 这类错误设备号不会匹配台账；本次真实测试设备号为 `YT-AW-00032-7A39`。

处理：测试前必须从数据库台账查询，或使用服务端 `create_device_no('AW', '00032')` 生成，不要手写校验码。

### 8.12 错误 retained status 会在 Worker 重启后重放

现象：Worker 重启后又看到旧错误设备号的 `INVALID_DEVICE` 日志。

原因：MQTT `status` Topic 使用 retained 消息。旧模拟设备如果曾用错误设备号发布 retained status，Broker 会在 Worker 重新订阅时重放。

处理：用同一 Topic 发布空 retained 消息清理。清理时注意 ACL 是否允许该账号写入对应 `status` Topic，且命令行 TLS 可使用系统 CA。清理后重启 Worker 复核日志。

### 8.13 PowerShell here-string 可能带入 CR 字符

现象：远端 bash 命令出现 `$'\r': command not found`，或 `tail` 文件名显示异常。

原因：Windows PowerShell here-string 传到远端时可能携带 CRLF 中的 `\r`。

处理：优先把远端脚本写得短一些；必要时在远端使用 `bash -s` 并避免在命令末尾混入不可见字符。看到该错误时，先判断实际服务状态，不要误判为服务失败。

### 8.14 Seed 手机号不一定符合正式校验

现象：用历史种子手机号通过公网 API 创建测试命令失败。

原因：部分 seed 用户手机号仅用于本地种子数据，不一定符合正式手机号正则。

处理：公网 API 测试使用合法测试手机号；设备命令闭环底层验证可直接在测试库中创建 `device_commands` 记录，但不要在生产环境随意写库。

## 9. 后续改进

1. 使用 systemd 管理 Uvicorn，替代 `nohup + server.pid`。
2. Uvicorn 改为监听 `127.0.0.1:8000`。
3. 安全组关闭公网 `8000`，只保留 `80/443`。
4. 建立自动化部署脚本，固定备份、上传、迁移、重启、验证步骤。
5. 对 SQLite 增加定期备份；上线前评估是否迁移 MySQL/PostgreSQL。
6. 将管理员接口迁移到独立后台登录与角色权限，不再仅依赖单个 `YT_ADMIN_TOKEN`。

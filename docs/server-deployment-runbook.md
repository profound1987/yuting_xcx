# 服务器部署 Runbook

> 适用范围：云汀智家测试服务器上的 FastAPI 后端部署、重启、验证和回滚。当前服务器使用 `nohup + server.pid` 运行 Uvicorn，尚未接入 systemd。

## 1. 当前部署信息

- 服务器：`39.97.237.214`
- SSH 用户：`yunting`
- SSH key：`C:\Users\THINK\.ssh\yunting_dev_ed25519`
- 后端目录：`/home/yunting/yt_smart_home_server`
- 运行端口：`0.0.0.0:8000`
- 公网 API：`https://yutingsmarthome.xin/api`
- 反向代理：Nginx 根域名 `location = /api` -> `http://127.0.0.1:8000/api`
- 进程方式：`nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &`
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
  -d '{"type":"device.checkProvisionStatus","data":{"phone":"13800000000","deviceNo":"YT-AW-00000-A324","provisionSessionId":"missing"}}'
```

期望返回 `PROVISION_SESSION_NOT_FOUND`，说明接口存在且业务逻辑生效。

### 5.4 验证 prepareConfigure 创建配网会话

```powershell
curl.exe -sS -X POST https://yutingsmarthome.xin/api `
  -H "Content-Type: application/json" `
  -d '{"type":"device.prepareConfigure","data":{"phone":"13800008888","deviceNo":"YT-AW-00000-A324"}}'
```

期望 `success=true`，且 `data.provisionSessionId` 有值。注意：该命令会在测试库里创建或更新该手机号用户，仅用于测试环境。

## 6. 回滚步骤

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

## 7. 常见问题

### 7.1 上传成功但接口仍是 API_NOT_FOUND

原因通常是旧 Uvicorn 进程没停掉。处理：

1. SSH 到服务器。
2. 执行 `ps -ef | grep 'uvicorn app.main:app' | grep -v grep`。
3. 停掉所有旧进程。
4. 重新用 `nohup python3 -m uvicorn ...` 启动。
5. 再验证 `admin.users.search` 是否返回 `ADMIN_FORBIDDEN` 而不是 `API_NOT_FOUND`。

### 7.2 `.venv/bin/python` 没有 pip

当前远端 `.venv` 历史上不是完整运行环境。本阶段直接使用系统 `python3` 和 `--user` 包安装。后续建议重建虚拟环境或迁移 systemd。

### 7.3 cryptography 未安装

`device.secureMessage` 依赖 `cryptography.hazmat.primitives.ciphers.aead.AESCCM`。如果未安装，服务端会返回 `CRYPTO_NOT_CONFIGURED`。处理：

```bash
cd /home/yunting/yt_smart_home_server
python3 -m pip install --user -r requirements.txt
python3 - <<'PY'
import cryptography
print(cryptography.__version__)
PY
```

### 7.4 终端 SSH 命令无输出或找不到 ssh

优先使用完整路径：

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -i "C:\Users\THINK\.ssh\yunting_dev_ed25519" yunting@39.97.237.214 "echo ok"
```

### 7.5 管理员密钥验证

不要把真实 `YT_ADMIN_TOKEN` 写在命令、文档或日志里。部署验证只需要错误 token 返回 `ADMIN_FORBIDDEN`。真正查询用户时，在本地管理员工具界面输入真实 token。

## 8. 后续改进

1. 使用 systemd 管理 Uvicorn，替代 `nohup + server.pid`。
2. Uvicorn 改为监听 `127.0.0.1:8000`。
3. 安全组关闭公网 `8000`，只保留 `80/443`。
4. 建立自动化部署脚本，固定备份、上传、迁移、重启、验证步骤。
5. 对 SQLite 增加定期备份；上线前评估是否迁移 MySQL/PostgreSQL。
6. 将管理员接口迁移到独立后台登录与角色权限，不再仅依赖单个 `YT_ADMIN_TOKEN`。

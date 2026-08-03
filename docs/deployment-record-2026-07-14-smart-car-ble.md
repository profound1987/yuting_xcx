# 2026-07-14 云汀智车 BLE 接入与统一账号部署记录

## 1. 记录目的

本文记录云汀设备服务器从“仅支持云汀智家”扩展为同时支持云汀智车 Smart LED 的实际变更、部署结果和后续约束，避免未来新增 Smart Speaker、云汀智人等产品时重复建设或误改既有智家协议。

## 2. 类型码与产品族结论

- 云汀智家现有类型：`AW / ES / LC / SP / GW`。
- 云汀智车 Smart LED：类型码固定为 `SL`。
- 云汀智车 Smart Speaker：建议使用 `SS`，当前仅规划保留，尚未实现。
- 类型码在整个云汀设备平台内全局唯一，发布后不得改义或复用。
- 产品族使用 `device_registry.product_family` 区分，目前为 `smart_home` 和 `smart_car`。
- 接入方式使用 `device_registry.onboarding_mode` 区分，智家现有设备为 `ble_wifi`，智车 SL 为 `ble_only`。

## 3. 服务器变更

服务器目录：`微信小程序/server/yt_smart_home_server`。

### 3.1 数据库

在不删除、不改名原字段和原表的前提下完成增量迁移：

- `device_registry` 新增 `product_family`、`onboarding_mode`。
- 新增 `device_factory_credentials`，保存 PIN、生产批次、硬件版本和测试标记。
- 新增 `device_ble_bind_sessions`，保存 5 分钟 BLE challenge/proof 会话。
- 新增 `device_owner_keys`，保存当前所有者 BLE 凭据及状态。

### 3.2 通用 BLE 绑定接口

统一 `/api` 新增：

- `device.prepareBleBind`
- `device.verifyBleProof`
- `device.finishBleBind`

接口使用现有云汀用户会话、`device_registry`、`device_keys`、绑定事件和管理员能力，没有创建独立的“智车用户表”或“智车设备服务器”。

### 3.3 测试生产台账

40 台保留 SL 测试设备已幂等写入线上 SQLite：

- `M=0-7`，每个规格的流水号为 `0000-0004`。
- 规格宽度依次为 `16 / 32 / 48 / 64 / 80 / 96 / 112 / 128`，高度均为 `16`。
- PIN 与测试设备号定义在 `app/test_device_catalog.py`。
- 测试密钥为 `first16Bytes(SHA256("YUNTING-ZHICHE-TEST-DEVICE-KEY-V1|" + deviceNo))`。
- 确定性密钥只允许用于这 40 台保留测试设备；正式设备必须使用逐台随机生产密钥。

## 4. 统一账号与登录

云汀智家和云汀智车共用以下接口：

- `auth.sendCode`
- `auth.loginByCode`
- `auth.checkSession`
- `auth.logout`

首次使用手机号和正确验证码登录时，`auth.loginByCode` 会通过 `ensure_user()` 自动创建用户，因此“注册”和“登录”不需要两个页面。两端统一使用本地存储键 `yuntingSession`，核心身份以服务器签发的 `sessionToken` 为准。

智车小程序的页面规则：

1. 启动先进入手机号登录页。
2. 已有本地会话时调用 `auth.checkSession`，服务端确认有效后进入设备列表。
3. 未登录、会话过期、会话撤销或账号停用时回到登录页。
4. 设备列表、添加设备、设备管理和灯效编辑均有登录门禁。
5. 本地设备信息、owner key、当前设备和灯效缓存按 `userId` 隔离，切换手机号不会互相读取。

## 5. 线上部署记录

- 部署时间：2026-07-14（Asia/Shanghai）。
- 公网入口：`https://yutingsmarthome.xin/api`。
- 部署前代码和 SQLite 在线备份：

```text
/home/yunting/yt_smart_home_server/backup_20260714_132235_multi_product_ble
```

- 部署后设备统计：

```text
AW=100, ES=100, GW=100, LC=100, SP=100, SL=40
smart_home=500, smart_car=40, total=540
```

- `device_factory_credentials` 中 SL 测试记录：40。
- `device_keys` 中 SL 有效密钥：40。
- 40 个测试 PIN 均唯一。
- SQLite `PRAGMA integrity_check`：`ok`。

## 6. 已执行验证

- 原 500 台智家数据库迁移后完整保留。
- 原 `device.prepareConfigure` 智家入口仍正常执行登录校验。
- 公网 `GET /api` 返回 HTTP 200。
- 公网完成一次 SL `prepare → proof → finish → device.list → unbind` 全流程。
- 回归用 SL 已在验证结束后恢复为未绑定。
- 新 Uvicorn 进程启动正常，部署后日志没有 `ERROR` 或 `Traceback`。
- 智车项目 Node 单元测试和运行时 JavaScript 语法检查通过。

## 7. 当前边界与后续事项

- 智车硬件没有 Wi-Fi；账号、生产台账、challenge、设备归属在云端，日常显示控制和资源传输仍是手机到设备的 BLE 通信，不是设备直连云端。
- owner key 当前会保存在服务器和完成绑定的手机本地，并按用户隔离。要支持同一账号在新手机自动恢复 BLE 控制，需要后续设计 `device.getBleCredential` 或重新授权流程，不能直接把 PIN 放到云端响应中。
- 新增 `SS / Smart Speaker` 时必须补充服务器设备类型、接入方式、capability 校验、生产台账和客户端 GATT 注册；不能复制一套用户或绑定数据库。
- 所有后续服务器部署继续遵循 [server-deployment-runbook.md](server-deployment-runbook.md)，修改 schema 前必须同时备份代码和 SQLite。

## 8. 回滚依据

如发现本次数据库或 BLE 绑定接口影响既有业务，使用第 5 节备份恢复代码与 SQLite，再按 Runbook 重启并验证 `GET /api`、`device.prepareConfigure` 和原智家设备通信。回滚前需先保留故障现场数据库与日志，不得直接覆盖唯一副本。

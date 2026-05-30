# 登录模块设计规范

## 1. 文档目标

本文档定义“云汀智能家居”登录模块的手机端和云端设计规范。后续开发手机端页面、云函数、云数据库和接口时，应以本文档作为登录模块的业务标准。

本文重点回答：

- 新用户打开小程序时，登录流程如何走。
- 云端如何管理用户账号。
- 用户登录成功后，再次打开小程序为什么可以免登录。
- 免登录时，手机端依靠什么和云端交互。
- 用户长时间未登录后，再次手机号验证登录时，云端应创建新用户还是复用旧用户。

## 2. 规范用语

- 必须：强制要求，手机端和云端都要遵守。
- 应该：推荐要求，除非有明确理由，否则按此实现。
- 可以：可选能力，后续版本可逐步实现。

## 3. 登录模块边界

登录模块分为手机端和云端两部分。

### 3.1 手机端职责

手机端负责：

- 展示登录页。
- 收集手机号和验证码。
- 调用云端发送验证码接口。
- 调用云端验证码登录接口。
- 保存云端返回的本地会话信息。
- 小程序再次打开时，根据本地会话决定先进入登录页还是业务页。
- 进入业务页后调用云端校验会话。
- 所有需要登录的接口都携带会话令牌。

手机端不负责：

- 生成验证码。
- 判断验证码是否正确。
- 决定用户是否真实拥有账号。
- 判断设备归属权限。
- 只凭本地缓存永久认定用户已登录。

### 3.2 云端职责

云端负责：

- 生成并发送短信验证码。
- 管理验证码有效期、发送频率、错误次数和使用状态。
- 根据手机号查找或创建用户账号。
- 绑定微信小程序 `OPENID` 与业务用户。
- 创建、校验、刷新和注销登录会话。
- 对所有业务接口做统一鉴权。
- 维护账号状态，例如正常、禁用、注销中、已删除。

云端必须作为登录态和账号归属的最终裁决方。

## 4. 核心身份定义

### 4.1 业务用户 `userId`

`userId` 是系统内部稳定的用户主键。设备、浇水配置、订单、售后等业务数据都应该绑定 `userId`，不要直接绑定手机号。

原因是手机号可能换绑，微信 `OPENID` 也可能变化，但业务用户需要保持稳定。

### 4.2 手机号 `phone`

手机号是当前版本的主要登录凭证。用户能通过短信验证码证明自己当前拥有该手机号。

云端必须保证同一时刻一个有效手机号只对应一个有效业务用户。数据库层面应该为手机号建立唯一约束或通过事务保证唯一性。

### 4.3 微信 `OPENID`

`OPENID` 是微信小程序下的用户身份，由云函数通过 `cloud.getWXContext()` 获取。

手机端不得传入 `openid` 作为可信身份。云端也不得信任手机端传入的 `openid`。

`OPENID` 的作用：

- 辅助确认当前请求来自哪个微信用户。
- 让会话令牌只能在创建它的微信身份下使用。
- 支持用户再次打开小程序时校验本地会话是否属于当前微信用户。

### 4.4 会话令牌 `sessionToken`

`sessionToken` 是云端登录成功后发给手机端的长期登录凭据。

手机端再次打开小程序时，依靠本地保存的 `sessionToken` 与云端交互。云端校验通过后，用户可以免输入手机号和验证码。

安全要求：

- `sessionToken` 必须由云端生成，必须足够随机。
- 云端数据库只保存 `sessionToken` 的哈希值，不保存明文。
- 手机端保存明文 `sessionToken`，并在请求云函数时携带。
- 云端必须同时校验 `sessionToken`、当前 `OPENID`、用户状态和会话状态。

## 5. 手机端本地会话设计

手机端登录成功后，在本地缓存保存 `authSession`。

```json
{
  "userId": "user_xxx",
  "sessionToken": "random_token_from_server",
  "phoneMasked": "138****8000",
  "expiresAt": 1712592000000,
  "maxExpiresAt": 1717776000000,
  "loginAt": 1710000000000
}
```

手机端必须保存：

- `sessionToken`：后续请求云端的登录凭据。
- `expiresAt`：本地快速判断会话是否过期。
- `userId`：仅用于展示和日志，不作为权限判断依据。
- `phoneMasked`：用于页面展示，不保存完整手机号。

手机端不得保存：

- 短信验证码。
- 验证码校验结果。
- 设备控制密钥。
- 任何可替代云端权限校验的敏感信息。

## 6. 小程序启动逻辑

### 6.1 新用户首次打开

新用户本地没有 `authSession`。手机端必须展示登录页。

流程：

1. 小程序启动。
2. 手机端读取 `wx.getStorageSync('authSession')`。
3. 读取不到会话。
4. 进入登录页。
5. 用户输入手机号。
6. 用户点击获取验证码。
7. 手机端调用 `auth.sendCode`。
8. 用户输入验证码。
9. 手机端调用 `auth.loginByCode`。
10. 云端登录成功后返回 `authSession`。
11. 手机端保存 `authSession`。
12. 手机端跳转设备管理页。

### 6.2 已登录用户再次打开

用户之前登录成功，本地存在 `authSession`。

手机端流程：

1. 小程序启动。
2. 读取本地 `authSession`。
3. 如果没有本地会话，进入登录页。
4. 如果本地 `expiresAt` 已过期，清除本地会话，进入登录页。
5. 如果本地 `expiresAt` 未过期，可以先进入业务页或展示启动加载态。
6. 手机端立即调用 `auth.checkSession`。
7. 云端校验成功，返回最新用户信息和新的 `expiresAt`。
8. 手机端更新本地 `authSession`，继续使用业务页。
9. 云端校验失败，手机端清除本地会话并回到登录页。

结论：未过期的本地 `authSession` 让用户免输入手机号和验证码，但最终仍以云端 `auth.checkSession` 的结果为准。

### 6.3 已登录用户调用业务接口

所有需要登录的业务接口都必须携带 `sessionToken`。

请求示例：

```json
{
  "sessionToken": "random_token_from_server",
  "data": {
    "deviceId": "device_xxx"
  }
}
```

云端处理顺序：

1. 通过 `cloud.getWXContext()` 获取当前 `OPENID`。
2. 计算 `sessionToken` 哈希。
3. 查询 `sessions` 集合。
4. 校验会话存在、未过期、未注销。
5. 校验会话中的 `openid` 等于当前 `OPENID`。
6. 查询用户状态是否正常。
7. 将 `userId` 注入业务上下文。
8. 后续业务模块只能使用云端鉴权得到的 `userId` 判断权限。

## 7. 云端账户管理规则

### 7.1 账号创建规则

用户第一次使用手机号验证码登录时，云端按手机号查找 `users` 表。

如果手机号不存在：

1. 创建新的 `user`。
2. 生成新的 `userId`。
3. 记录手机号、脱敏手机号、账号状态、创建时间。
4. 绑定当前 `OPENID`。
5. 创建新的登录会话。

如果手机号已存在：

1. 不创建新用户。
2. 复用已有 `userId`。
3. 更新 `lastLoginAt`。
4. 如当前 `OPENID` 尚未绑定该用户，则新增或更新 `OPENID` 绑定关系。
5. 创建新的登录会话。

核心规则：同一手机号再次登录，默认使用旧用户，不创建新用户。

### 7.2 长时间未登录后的规则

用户长时间未登录时，之前的 `sessionToken` 会过期。再次打开小程序时，手机端需要重新进入手机号验证码登录。

云端处理规则：

| 账号状态 | 手机号是否存在 | 云端处理 |
| --- | --- | --- |
| 正常 `active` | 存在 | 复用旧用户，创建新会话 |
| 长期未登录 `inactive` | 存在 | 复用旧用户，更新为正常状态，创建新会话 |
| 禁用 `disabled` | 存在 | 拒绝登录，提示联系服务方 |
| 注销冷静期 `pending_delete` | 存在 | 可恢复账号或要求用户确认后恢复 |
| 已硬删除 `deleted` | 不存在有效记录 | 创建新用户 |
| 从未注册 | 不存在 | 创建新用户 |

标准策略：只要手机号对应的有效用户仍存在，就必须复用旧 `userId`。只有旧账号已经被硬删除，才创建新用户。

### 7.3 为什么长时间未登录仍复用旧用户

设备绑定关系、浇水配置、历史记录和售后信息都绑定在 `userId` 上。如果用户只是会话过期，重新手机号验证后创建新用户，会导致用户看不到原来的设备和配置。

因此：会话过期不等于账号失效。会话过期只要求重新验证手机号；验证成功后应回到旧账号。

### 7.4 手机号被重新分配的风险

手机号可能被运营商回收后分配给新人。生产系统需要考虑这个风险。

推荐策略：

- 账号长时间未登录超过 365 天，且本次登录的 `OPENID` 从未绑定过该账号时，标记为高风险登录。
- 高风险登录可以要求额外验证，例如设备绑定码、历史设备确认、人工客服确认。
- 在只有短信验证码一种验证方式的 MVP 阶段，手机号验证通过后仍复用旧用户，但关键操作可以要求重新验证设备绑定码。

## 8. 微信 `OPENID` 绑定规则

### 8.1 同一手机号，同一 `OPENID`

这是最常见情况。

处理规则：复用用户，刷新最后登录时间，创建新会话。

### 8.2 同一手机号，新的 `OPENID`

用户可能换了微信号、换了小程序主体环境，或在另一个微信账号中登录同一手机号。

处理规则：

- 手机号验证码通过后，云端复用该手机号对应的旧用户。
- 将新的 `OPENID` 绑定到该用户。
- 可以保留旧 `OPENID` 绑定，也可以根据安全策略限制绑定数量。
- 应记录登录事件，便于审计。

### 8.3 同一 `OPENID`，新的手机号

用户可能换手机号，也可能想切换账号。

推荐 MVP 规则：一个 `OPENID` 同一时刻只允许绑定一个主用户。

当同一 `OPENID` 使用新手机号登录时：

1. 云端先验证新手机号验证码。
2. 如果新手机号没有用户，则创建新用户。
3. 如果新手机号已有用户，则切换到该用户。
4. 将当前 `OPENID` 绑定到新用户。
5. 注销当前 `OPENID` 在旧用户下的所有会话。
6. 手机端清除旧本地会话并保存新会话。

这样可以支持用户换手机号或切换账号，同时避免一个 `OPENID` 同时持有多个活跃业务身份。

## 9. 云端数据模型

### 9.1 `users` 用户表

```json
{
  "_id": "user_xxx",
  "phone": "13800138000",
  "phoneMasked": "138****8000",
  "status": "active",
  "createdAt": 1710000000000,
  "updatedAt": 1710000000000,
  "lastLoginAt": 1710000000000,
  "inactiveAt": null,
  "deletedAt": null
}
```

字段规则：

- `phone` 必须唯一。
- `status` 可选值：`active`、`inactive`、`disabled`、`pending_delete`、`deleted`。
- 业务表必须关联 `userId`，不要直接关联手机号。

### 9.2 `user_openids` 微信身份绑定表

```json
{
  "_id": "openid_bind_xxx",
  "userId": "user_xxx",
  "openid": "openid_xxx",
  "status": "active",
  "createdAt": 1710000000000,
  "lastLoginAt": 1710000000000,
  "unboundAt": null
}
```

字段规则：

- `openid` 应该唯一指向一个活跃用户。
- 如果允许一个用户绑定多个微信身份，则同一 `userId` 可以有多条 `active` 记录。
- 如果 `OPENID` 切换到另一个用户，旧绑定必须标记为 `unbound`。

### 9.3 `sms_codes` 验证码表

```json
{
  "_id": "sms_xxx",
  "phone": "13800138000",
  "openid": "openid_xxx",
  "scene": "login",
  "codeHash": "hash_value",
  "status": "pending",
  "attempts": 0,
  "expiresAt": 1710000300000,
  "createdAt": 1710000000000,
  "usedAt": null
}
```

字段规则：

- 云端只保存验证码哈希。
- 验证码有效期建议 5 分钟。
- 验证码使用成功后必须标记为 `used`。
- 验证码错误次数超过限制后必须标记为 `blocked` 或 `expired`。

### 9.4 `sessions` 会话表

```json
{
  "_id": "session_xxx",
  "userId": "user_xxx",
  "openid": "openid_xxx",
  "tokenHash": "hash_value",
  "status": "active",
  "createdAt": 1710000000000,
  "expiresAt": 1712592000000,
  "maxExpiresAt": 1717776000000,
  "lastSeenAt": 1710000000000,
  "revokedAt": null
}
```

字段规则：

- 云端保存 `tokenHash`，不保存明文 `sessionToken`。
- `expiresAt` 是当前会话过期时间。
- `maxExpiresAt` 是最长生命周期，到期后必须重新手机号验证码登录。
- `status` 可选值：`active`、`expired`、`revoked`、`risk_locked`。

### 9.5 `auth_events` 登录审计表

```json
{
  "_id": "event_xxx",
  "userId": "user_xxx",
  "openid": "openid_xxx",
  "phoneMasked": "138****8000",
  "eventType": "login_success",
  "result": "success",
  "reason": "",
  "createdAt": 1710000000000
}
```

用途：记录验证码发送、登录成功、登录失败、会话过期、退出登录、风险拦截等事件。

## 10. 云端接口规范

### 10.1 `auth.sendCode`

功能：发送登录验证码。

请求：

```json
{
  "phone": "13800138000",
  "scene": "login"
}
```

云端逻辑：

1. 获取当前 `OPENID`。
2. 校验手机号格式。
3. 校验发送频率。
4. 生成验证码。
5. 保存验证码哈希、过期时间、状态。
6. 调用短信服务商。
7. 返回冷却时间。

响应：

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

### 10.2 `auth.loginByCode`

功能：手机号验证码登录。

请求：

```json
{
  "phone": "13800138000",
  "code": "123456"
}
```

云端逻辑：

1. 获取当前 `OPENID`。
2. 校验手机号和验证码格式。
3. 查询最近一条可用验证码。
4. 校验验证码哈希、过期时间、使用状态、错误次数。
5. 验证通过后将验证码标记为 `used`。
6. 按手机号查找用户。
7. 手机号不存在则创建新用户。
8. 手机号存在则复用旧用户。
9. 绑定或更新当前 `OPENID`。
10. 注销当前 `OPENID` 旧的活跃会话。
11. 创建新的会话。
12. 返回 `authSession`。

响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "登录成功",
  "data": {
    "authSession": {
      "userId": "user_xxx",
      "sessionToken": "random_token_from_server",
      "phoneMasked": "138****8000",
      "expiresAt": 1712592000000,
      "maxExpiresAt": 1717776000000,
      "loginAt": 1710000000000
    }
  }
}
```

### 10.3 `auth.checkSession`

功能：校验并刷新会话。

请求：

```json
{
  "sessionToken": "random_token_from_server"
}
```

云端逻辑：

1. 获取当前 `OPENID`。
2. 查询 `tokenHash` 对应的会话。
3. 校验会话状态为 `active`。
4. 校验当前时间小于 `expiresAt`。
5. 校验当前时间小于 `maxExpiresAt`。
6. 校验会话 `openid` 等于当前 `OPENID`。
7. 查询用户状态为 `active` 或允许恢复的 `inactive`。
8. 更新 `lastSeenAt`。
9. 如未超过 `maxExpiresAt`，刷新 `expiresAt`。
10. 返回最新会话和用户信息。

响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "会话有效",
  "data": {
    "authSession": {
      "userId": "user_xxx",
      "sessionToken": "same_or_rotated_token",
      "phoneMasked": "138****8000",
      "expiresAt": 1712592000000,
      "maxExpiresAt": 1717776000000
    }
  }
}
```

### 10.4 `auth.logout`

功能：退出登录。

请求：

```json
{
  "sessionToken": "random_token_from_server"
}
```

云端逻辑：

1. 获取当前 `OPENID`。
2. 查询并校验会话。
3. 将会话状态改为 `revoked`。
4. 记录退出登录事件。

手机端逻辑：无论云端调用成功或失败，都应该清除本地 `authSession` 并回到登录页。

## 11. 会话生命周期策略

推荐默认值：

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 验证码有效期 | 5 分钟 | 超时必须重新获取 |
| 验证码重发间隔 | 60 秒 | 手机端倒计时，云端强制限制 |
| 单验证码错误次数 | 5 次 | 超过后验证码作废 |
| 会话有效期 `expiresAt` | 30 天 | 未过期可免登录 |
| 会话最长生命周期 `maxExpiresAt` | 90 天 | 到期必须重新短信登录 |
| 长期未登录标记 | 180 天 | 可标记为 `inactive` |
| 高风险长期未登录 | 365 天 | 新 `OPENID` 登录时需要额外关注 |

会话刷新规则：

- 用户每次打开小程序并通过 `auth.checkSession` 后，可以刷新 `expiresAt`。
- 刷新后的 `expiresAt` 不得超过 `maxExpiresAt`。
- 超过 `maxExpiresAt` 后，用户必须重新获取短信验证码登录。

## 12. 错误码规范

| 错误码 | 含义 | 手机端处理 |
| --- | --- | --- |
| `INVALID_PHONE` | 手机号格式错误 | 提示用户修改手机号 |
| `SMS_TOO_FREQUENT` | 验证码发送太频繁 | 显示倒计时 |
| `SMS_DAILY_LIMIT` | 当天验证码次数过多 | 提示稍后再试 |
| `CODE_INVALID` | 验证码错误 | 提示重新输入 |
| `CODE_EXPIRED` | 验证码过期 | 提示重新获取 |
| `USER_DISABLED` | 账号被禁用 | 提示联系服务方 |
| `SESSION_MISSING` | 未传会话 | 跳转登录页 |
| `SESSION_EXPIRED` | 会话已过期 | 清除本地会话并跳转登录页 |
| `SESSION_REVOKED` | 会话已注销 | 清除本地会话并跳转登录页 |
| `SESSION_OPENID_MISMATCH` | 会话和当前微信身份不匹配 | 清除本地会话并跳转登录页 |
| `RISK_LOGIN_BLOCKED` | 风险登录被拦截 | 展示安全验证提示 |

## 13. 手机端页面规范

### 13.1 登录页

登录页必须包含：

- 手机号输入框。
- 获取验证码按钮。
- 验证码输入框。
- 登录按钮。

交互规则：

- 手机号不合法时不能发送验证码。
- 获取验证码后，按钮进入倒计时。
- 登录按钮调用 `auth.loginByCode`，不能在本地判断验证码正确。
- 登录成功后保存 `authSession` 并进入设备管理页。

### 13.2 启动页或路由守卫

手机端应该封装统一鉴权方法，例如：

```js
function requireAuth() {
  const authSession = wx.getStorageSync("authSession");
  if (!authSession || authSession.expiresAt <= Date.now()) {
    wx.removeStorageSync("authSession");
    wx.redirectTo({ url: "/pages/index/index" });
    return false;
  }
  return true;
}
```

注意：这个方法只做本地快速判断，进入业务页后仍必须调用云端 `auth.checkSession`。

### 13.3 云端调用封装

手机端应该封装统一云函数请求方法，自动附带 `sessionToken`。

```js
function callApi(type, data) {
  const authSession = wx.getStorageSync("authSession");
  return wx.cloud.callFunction({
    name: "api",
    data: {
      type,
      sessionToken: authSession && authSession.sessionToken,
      data,
    },
  });
}
```

遇到 `SESSION_EXPIRED`、`SESSION_REVOKED`、`SESSION_OPENID_MISMATCH` 时，统一清除本地会话并跳转登录页。

## 14. 云端实现规范

### 14.1 鉴权中间层

云端所有业务接口应该先经过统一鉴权方法。

鉴权方法输入：

- 当前云函数事件 `event`。
- 当前微信上下文 `wxContext`。

鉴权方法输出：

- `userId`。
- `openid`。
- `sessionId`。
- 用户状态。

后续设备、浇水、用户资料接口只能使用鉴权方法输出的 `userId`，不能使用前端传入的 `userId`。

### 14.2 事务要求

以下操作应该使用事务或等价的原子操作：

- 验证码校验成功后标记为已使用。
- 查找或创建用户。
- 绑定 `OPENID`。
- 注销旧会话并创建新会话。

目的：避免用户重复点击、网络重试或并发登录导致重复用户、重复会话或验证码重复使用。

### 14.3 唯一性要求

云端必须保证：

- 一个有效手机号只对应一个有效用户。
- 一个活跃 `OPENID` 只绑定一个当前用户。
- 一个 `sessionToken` 只对应一个会话。

## 15. 典型场景结论

### 15.1 新用户登录

手机号不存在，验证码正确：云端创建新用户、绑定当前 `OPENID`、创建会话。

### 15.2 老用户短期内再次打开

本地会话未过期：手机端携带 `sessionToken` 调用 `auth.checkSession`，云端校验通过后免登录。

### 15.3 老用户 3 个月后再次打开

本地会话可能已超过最长生命周期：手机端进入登录页，用户重新获取验证码。云端按手机号找到旧用户，复用旧 `userId`，创建设备仍然可见的新会话。

### 15.4 用户清理了小程序缓存

本地 `authSession` 丢失：手机端进入登录页。用户重新手机号验证码登录后，云端复用手机号对应的旧用户。

### 15.5 用户换微信但手机号不变

验证码正确：云端复用手机号对应的旧用户，并绑定新的 `OPENID`。是否保留旧 `OPENID` 由安全策略决定。

### 15.6 用户换手机号

当前版本建议按新手机号登录到新账号或已有账号。后续如要支持“换绑手机号”，应单独设计手机号换绑流程，要求旧手机号或已登录会话 + 新手机号验证码共同确认。

## 16. 当前原型改造要求

当前小程序原型使用本地演示验证码和本地缓存登录态。进入云端版本时，需要按以下顺序改造：

1. 手机端登录页保留现有交互，但验证码发送改为调用 `auth.sendCode`。
2. 手机端登录按钮改为调用 `auth.loginByCode`。
3. 手机端本地存储从当前演示结构改为 `authSession` 标准结构。
4. 新增手机端统一 `requireAuth` 和 `callApi` 封装。
5. 云端新增 `users`、`user_openids`、`sms_codes`、`sessions`、`auth_events` 集合。
6. 云端新增统一鉴权中间层。
7. 设备和浇水接口全部改为通过云端鉴权后的 `userId` 查询数据。

完成以上改造后，登录模块即可作为后续设备管理、浇水控制、用户资料等模块的统一身份基础。
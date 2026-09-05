# 移动端（Android / HarmonyOS）API 接入说明

本文档写给后续开发的 Android 与 HarmonyOS 客户端。所有接口事实均来自 `server/http/api.js`、`server/http/api-v2.js`、`server/modules/notifications/routes.js`、`server/domain/tasks.js` 与 `auth.js`，改动代码后如与此处不一致，以代码为准并请同步本文档。

> **新端接入前必读**：新开发的 Android / HarmonyOS 客户端请**统一走第 1 节之前的说明 + 文末《v2 统一接口》**（`/api/v2/*`）。v2 是专门为移动端整理的规范层：成功一律 `{data:…}`、分页 page 从 1 起、时间为 ISO8601 UTC，避免 v1 各接口的历史差异。下方第 1~8 节描述 v1 业务语义（任务状态机、字段含义、权限范围等），与 v2 一致，可对照阅读；SSE 实时通道仍只有 v1 入口。

## 0. 接入基线

- 服务地址：开发环境局域网 `http://<服务器IP>:3000`；生产必须 HTTPS（`docker-compose.yml` + `compose.https.yaml` 的 Caddy，见 `docs/deployment/browser-push-https.md`）。
- 请求/响应均为 `application/json; charset=utf-8`；图片上传用 `multipart/form-data`。
- 会话有效期 **30 天**（服务端存 session，token 不透明）；退出登录请调 `/api/logout` 使会话失效。

## 1. 认证

### 登录

```
POST /api/login
Body: {"username":"www","password":"******"}
```

成功 `200`：

```json
{
  "token": "a5f9…（64位以上随机串）",
  "user": {
    "id": "ec672791-…",
    "username": "www",
    "role": "courier",          // admin | cs | courier
    "courierId": "6cb95c7a-…",  // 取件员档案ID，courier 角色才有意义
    "name": "王师傅",
    "createdAt": "2026-…"
  }
}
```

失败 `401 {"error":"用户名或密码错误"}`。

之后所有请求（登录、健康检查、SSE 票据接口除外）带：

```
Authorization: Bearer <token>
```

统一错误响应：非 2xx 时 body 为 `{"error":"人类可读信息"}`，部分接口额外带 `code`。客户端解析失败体时以 `error` 字段为准。`401` = 登录失效（清除本地 token 回登录页）。

### 其他账号接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me` | 当前用户信息（同登录响应里的 `user`） |
| POST | `/api/logout` | 注销当前会话，`200 {"ok":true}` |
| POST | `/api/password` | 改密码，Body `{"oldPassword","newPassword"}`（新密码≥6位） |

### 角色与数据范围（重要）

- `admin`：全部数据与后台管理接口。
- `cs`（客服）：全部业务数据 + 派单/改单类操作。
- `courier`（取件员）：只能看到/操作**绑定到自己 `courierId`** 的任务；派单推送也只发给绑定了该取件员档案的用户账号。

## 2. 取件任务（移动端核心）

任务状态机：`pending`(待取) → `in_progress`(取件中) → `completed`(已完成)；`pending/in_progress` 均可 `cancelled`(已取消)。已完成不可取消、已取消不可恢复；完成前必须先 start。中文标签 `statusLabel`：待取/取件中/已完成/已取消。

### 我负责的任务（取件员专用，推荐）

```
GET /api/worker/tasks?status=in_progress
```

- `status` 可选：`pending` / `in_progress` / `completed` / `cancelled`，缺省返回全部。
- 响应为**数组直出（无包装）**：`[{task…}, …]`，按创建时间倒序，无分页（取件员任务量小）。
- 客户端可用「拉取列表 + 本地刷新」，配合推送/SSE 触发增量刷新。

### 任务详情

```
GET /api/tasks/:id
```

响应为 task 对象直出，结构（截取主要字段）：

```json
{
  "id": "…",
  "taskNo": "QJ20260905-AB12CD",
  "businessOrderNo": "",
  "customerId": "…",
  "customerName": "某某货代",
  "address": "上海市…",
  "contact": "张先生",
  "phone": "138…",
  "areaName": "静安区",
  "taskType": "normal",          // normal | rush
  "status": "pending",
  "statusLabel": "待取",
  "defaultWorkerId": "6cb95c7a-…",
  "dispatchCsName": "客服甲",
  "scheduledTime": "",            // 预约取件时间
  "rushShipTime": "",             // 加急截件时间
  "rushReason": "",
  "pickupNote": "",               // 取件备注（给取件员看）
  "volume": 0, "dimensions": "",
  "amountReceivable": 0, "amountPayable": 0, "settled": "未结算",
  "createdAt": "2026-09-05 09:24:48",
  "items": [
    {
      "id": "…", "waybillNo": "SF123…", "goodsName": "纸箱",
      "pieces": 2, "finalWeight": 12.5, "matchStatus": "pending"
    }
  ],
  "photos": [ { "id": "…", "type": "pickup", "filePath": "/uploads/xxx.jpg", "createdAt": "…" } ],
  "exceptions": [ { "id": "…", "type": "…", "description": "…", "resolved": false, "resolution": "" } ]
}
```

注意：接口返回的 `photos[].filePath` 是**相对路径**，展示时拼服务器根地址：`<baseUrl> + filePath`；`pickup_photos` 落盘在服务器 `data/uploads/`，由 `/uploads` 静态目录提供（无鉴权，URL 为不可猜测 UUID，适合直接给 IMG 加载）。

### 任务动作

全部返回 `200` + 更新后的任务对象（`taskDetail` 直出，含 photos/exceptions），失败 `400 {"error":…}`：

| 动作 | 端点 | 请求体 |
| --- | --- | --- |
| 开始取件 | `POST /api/tasks/:id/start` | `{"note":"可选"}` |
| 完成取件 | `POST /api/tasks/:id/complete` | `{"note":"可选"}` |
| 取消 | `POST /api/tasks/:id/cancel` | `{"note":"可选"}` |
| 邀请协助 | `POST /api/tasks/:id/assist` | 主取件员或客服/管理员；`{"workerId":"被邀取件员档案ID"}`。成功后返回 `201`+任务（`workers[]` 含 `role:"assist"`、`assistWorkerIds[]`）；协助人随后可查看/操作该任务并计入其“协助次数” |
| 转单给他人 | `POST /api/tasks/:id/transfer` | 主取件员或客服/管理员；`{"workerId":"目标取件员档案ID"}`（目标必须存在；空串=收回） |
| 再次取件（复制新单） | `POST /api/tasks/:id/again` | 客服/管理员；无需 body，返回 `201` + 新任务 |
| 添加面单/货物 | `POST /api/tasks/:id/items` | `{"waybillNo":"…","goodsName":"…","pieces":1}`（返回 `201`+任务） |
| 上报异常 | `POST /api/tasks/:id/exceptions` | `{"type":"…","description":"…"}`（返回 `201`+任务） |
| 改派 | `POST /api/tasks/:id/reassign` | 客服/管理员；`{"workerId":"…"}`，返回任务 |

`workerId` 一律指**取件员档案 ID**（取件员列表接口 `/api/couriers` 返回的 `id`），不是用户账号 id。

### 上传取件照片

```
POST /api/tasks/:id/photos
Content-Type: multipart/form-data
字段：任意字段名均可（服务端 imageUpload.any()），建议 photo；可一次多张
限制：单张 ≤ 10MB，仅 image/jpeg|png|gif|webp|heic|heif
```

成功 `201` + 更新后的任务对象（`photos` 数组含新图）。字段名随意是历史行为，新客户端请固定用 `photo` 以便将来收紧。

### 客服/管理员的全部任务列表

`GET /api/tasks?status=&workerId=&customerId=&keyword=&page=0&size=20` → `{"list":[…],"total":N,"page":0,"size":20}`（**page 从 0 开始**，与通知分页不同，见下）。`courier` 角色调用该接口时服务端强制只看自己的任务，移动端取件员请直接用 `/api/worker/tasks`。

## 3. 通知中心（站内消息）

统一前缀 `/api/v1`，响应统一 `{"data":…}` 包装。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/notifications?page=1&pageSize=20&unread=1&type=pickupTask.assigned` | 列表，**page 从 1 开始**；返回 `{"data":{"items":[…],"total":N,"page":1,"pageSize":20}}` |
| GET | `/api/v1/notifications/unread-count` | `{"data":N}` 未读数 |
| POST | `/api/v1/notifications/:id/read` | 标记已读 |
| POST | `/api/v1/notifications/read-all` | 全部已读 |

通知对象：

```json
{
  "id": "…",
  "type": "pickupTask.assigned",   // 业务类型见下
  "title": "新的取件任务",
  "body": "某某货代 · 上海市…",
  "data": { "resourceType": "pickupTask", "resourceId": "任务id", "route": "/tasks/任务id" },
  "priority": "high",               // low | normal | high
  "read": false,
  "createdAt": "2026-09-05T01:24:48.000Z"   // ISO8601 UTC
}
```

业务通知 `type` 一览：`pickupTask.assigned`（派单给取件员）、`pickupTask.statusChanged`（任务状态更新）、`pickupTask.overdue`（任务加急）、`pickupTask.exception`（异常上报/已处理）、`system.test`（推送测试）。客户端收到带 `data.resourceType='pickupTask'` 的通知可直接跳任务详情页（`data.resourceId`）。

## 4. 设备推送注册（华为 Push Kit，Android 与鸿蒙通用）

服务端只对接华为 Push Kit 一个厂商通道；**Android（HMS Push）与 HarmonyOS（Push Kit）的 token 都上报到同一个接口**，`platform` 字段区分：

```
POST /api/v1/notification-subscriptions
Body: {
  "channel": "vendor_push",
  "providerCode": "huawei",
  "platform": "android",            // android | harmonyos
  "token": "<厂商SDK获取的设备token>",
  "deviceLabel": "Huawei P60",      // 可选，≤100字
  "appVersion": "1.0.0"             // 可选，≤50字
}
```

成功 `201`：

```json
{ "data": { "id": "订阅id", "channel": "vendor_push", "providerCode": "huawei", "platform": "android", "status": "active", … } }
```

客户端规则：

1. **每次登录成功后都重新注册**；先 `DELETE /api/v1/notification-subscriptions/:id`（用本地保存的上次订阅 id）再 POST，避免服务端积累失效 token。
2. 服务端按 `provider_code + token 指纹` 去重；同一用户多设备多订阅都保留。
3. 退出登录：`DELETE /api/v1/notification-subscriptions/:id`。
4. 查询自己的设备：`GET /api/v1/notification-subscriptions` → `{"data":[…]}`。
5. 给自己发测试：`POST /api/v1/notification-subscriptions/:id/test`（服务端生成 `system.test` 走真实投递队列，只发给自己）。

服务端侧触发逻辑：派单/状态变化 → 写给「接收人 user + 该用户的 active 订阅」→ dispatcher 调华为 `push-api.cloud.huawei.com/v3/{projectId}/messages:send`。投递状态可在管理端「通知投递」查看。客户端**不要**用“是否收到厂商回调”判断服务端是否成功，以业务接口数据为准；App 冷启动后以拉取任务列表/通知为准。

Android 侧还需：AGC 开启 Push Kit、客户端 `HuaweiPush.getToken()`、Android 13+ 通知权限运行时申请。HarmonyOS 侧：`pushService.getToken()` + `notificationManager.requestEnableNotification()`。完整端到端配置见 `docs/deployment/huawei-harmony-push.md`。

## 5. 实时事件（SSE）

移动端建议用**服务端推送（第 4 节）做“有通知横幅”的提醒**，用 SSE 做 App 前台时的即时刷新。两种连接方式：

1. 票据方式（推荐，避免把 token 放 URL）：
   - `POST /api/v1/events/tickets`（带 Bearer）→ `{"data":{"ticket":"…","expiresInSeconds":30}}`
   - 立即 `GET /api/v1/events?ticket=<ticket>` 建立 SSE（票据一次性，30 秒内消费）
2. 直接 Bearer：`GET /api/v1/events`（请求头带 Authorization）。

旧兼容入口 `GET /api/events?token=…`（URL 携带会话 token）已标记 Deprecation，新客户端不要使用。

SSE 事件（`data:` 行，JSON）：
- `{"type":"notification.created","data":{"notification":{…同第3节对象…}}}`：发给当前登录用户的通知（含站内 + 将推送的业务通知）。收到后刷新未读数与列表。
- 全量广播事件（所有在线端都收到）：`record.created / record.updated / record.deleted / task.created / task.status / couriers.updated / customers.updated / areas.updated` 等，用于刷新看板/列表。
- 心跳：每 25 秒 `:ping` 注释行；断线重连建议 3 秒（`retry: 3000`）。

## 6. 其他常用业务接口（按角色）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/couriers` | 登录用户 | 取件员档案列表 |
| GET | `/api/areas` | 登录用户 | 区域列表（数组直出） |
| GET | `/api/customers?search=` | 登录用户 | 客户档案（**数组直出**；`search` 按名称/电话/老编号模糊查，不带则全量） |
| GET | `/api/customers/:id` | 登录用户 | 客户详情含地址 |
| POST | `/api/customers` / PUT `/api/customers/:id` | 客服+ | 新建/编辑客户 |
| GET | `/api/records?courierId=&start=&end=&status=&keyword=&customerId=&unassigned=1` | 登录用户 | 历史取件记录（**数组直出**）；`courier` 自动限定自己；`unassigned=1` 查看未认领单；行含 `customerName/customerPhone` |
| GET | `/api/stats?mode=today|week|month&…` | 登录用户 | 统计 |
| GET | `/api/dashboard/me` | courier | 我的待取/进行中/已完成/件数 |
| GET | `/api/billing`、`/api/commission` | 客服+/登录用户 | 结算/提成 |
| POST | `/api/machine/weigh` | 过机设备 | 头 `X-Machine-Key: <密钥>`；Body `{"orderNo"或"trackingNo","weight","dimensions"或length/width/height}` → `{"ok":true,"record":…}`；未配置密钥时 `503` |
| GET | `/api/health` | 匿名 | 健康检查 `{"status":"ok"}` |

管理员专属（移动端一般不涉及）：`/api/users`、`/api/employees`、`/api/logs`、`/api/backup`、`/api/import*`、`/api/export.xlsx`、`/api/v1/admin/push-providers`、`/api/v1/admin/notification-deliveries`。

## 7. 已知约定差异（仅影响 v1/历史接口；v2 已统一，新端无需理会）

以下差异是 v1 的历史遗留。**使用 v2 的客户端只需遵守第 9 节的四条约定**，这些坑自动规避：

1. **响应包装不统一**（历史原因）：
   - 老业务接口：`/api/login`、`/api/me`、`/api/worker/tasks`、`/api/tasks/:id`、`/api/areas` 等直接返回对象/数组；
   - 通知/推送类 `/api/v1/*`：统一 `{"data":…}` 包装；
   - 错误统一 `{"error":…}`（+可选 `code`），错误不受 `data` 包装影响。
   - 只接 v1 时建议：先判断 HTTP 状态码，非 2xx 一律取 `error`；2xx 再按各接口文档取字段。
2. **分页起点不一致**：`/api/tasks` 用 `page=0` 起始、`size` 字段；`/api/v1/notifications` 用 `page=1` 起始、`pageSize` 字段。v2 全部 page=1 起、统一 `pageSize`。
3. **时间格式不统一**：v1 任务 `createdAt` 为 UTC 文本 `"YYYY-MM-DD HH:mm:ss"`；客户/记录/取件员多存北京时间（SQLite `datetime('now','+8 hours')`）同格式文本；通知为 ISO8601 UTC（`…Z`）。v2 全部输出 ISO8601 UTC（`…Z`）。展示层建议：解析为本地时间统一格式化，涉及“今天/本周”统计以服务端返回为准，不要自己用手机时区算边界。
4. **分页上限**：`size/pageSize` 最大 100~200，超出会被服务端截断（v2 上限 100）。
5. **字符编码**：请求体中文直接 UTF-8；Android `URLEncoder` 用 `UTF-8`；HarmonyOS `encodeURIComponent` 默认 UTF-8。

## 8. 推荐的最小移动端封装（伪代码约定）

> 本节以 v1 直出结构示例；**v2 客户端在 2xx 时取 `body.data` 即可**（列表再取 `items/total/page/pageSize`），401/错误结构完全一致。

```
baseUrl = 服务器地址（可配置/可切换，生产强制 https）
api(path, {method, body, query, formData})：
  1) 附加 Authorization: Bearer <token>（/api/login、/api/health 除外）
  2) 超时：普通请求 15s，上传 30s，SSE 不设读超时
  3) 响应：2xx → 返回 JSON；否则抛出 ApiError(status, body.error)
  4) 401 → 清 token → 跳登录
deviceToken 注册时机：登录成功 → 厂商 SDK token 就绪后 → 注册/替换订阅
数据刷新策略：前台时任务列表 = SSE 事件触发增量拉取；后台/杀进程 = 厂商推送横幅
```

Android 与鸿蒙端的 token 获取、通知权限、AGC 配置见 `docs/deployment/huawei-harmony-push.md` 第 1~2 节。

## 9. v2 统一接口（Android / HarmonyOS 新端首选）

实现：`server/http/api-v2.js`，与 v1 同进程同库，登录会话互通（v1/v2 的 token 可混用）。

### 9.1 四条铁律（v2 全接口遵守）

1. 成功响应一律 `{"data": …}`；列表一律 `{"data":{"items":[…],"total":N,"page":P,"pageSize":S}}`；看板/对账/提成等汇总接口也套 `data`，内部结构见各小节。
2. 分页：`page` 从 **1** 起；`pageSize` 默认 **20**、上限 **100**（超出截断）；取件员/区域等主数据建议显式传 `pageSize=100`。
3. 错误响应一律 `{"error":"信息","code"?:…}` + 恰当 HTTP 状态码；错误体**不套** `data`。
4. 时间字段（任务、货品、照片、异常、通知、历史记录）一律 **ISO8601 UTC**（`2026-09-05T01:47:38.000Z`）；客户端直接 `new Date(...)` 解析即可，不要自行假设 +8。

鉴权方式与 v1 相同：`Authorization: Bearer <token>`，401 = 登录失效。

### 9.2 认证与会话（替代 v1 /api/login）

| 方法 | 路径 | Body | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v2/auth/login` | `{"username","password"}` | 成功 `{data:{token,user}}`；`user` 含 `role/courierId/name`，结构与 v1 登录一致 |
| GET | `/api/v2/me` | - | `{data:{user}}` 当前用户 |
| POST | `/api/v2/logout` | - | `{data:{ok:true}}` |
| POST | `/api/v2/password` | `{"oldPassword","newPassword"}` | 新密码 ≥6 位 |

角色与数据范围同第 1 节（courier 只能看/操作绑定自己的任务；被邀请为“协助取件员”后，可查看并操作该任务、在任务列表中出现，完成的任务计入其“协助次数”，不占用其主取件统计）。

### 9.3 任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v2/tasks?page=&pageSize=&status=&customerId=&keyword=&workerId=` | 分页列表（courier 自动只看自己） |
| POST | `/api/v2/tasks` | 创建（客服+），Body 同 v1 语义 + 可选 `customerId`/`addressId` 自动带出客户信息 |
| GET | `/api/v2/tasks/:id` | 详情，含 `items/photos/exceptions/workers/mainCsName/addressPointName` |
| PUT | `/api/v2/tasks/:id` | 改单（客服+）：`taskType/scheduledKind/scheduledTime/rushShipTime/rushReason/pickupNote/internalNote` |
| POST | `/api/v2/tasks/:id/start` `/complete` `/cancel` | 状态流转，Body 可选 `{"note"}` |
| POST | `/api/v2/tasks/:id/items` | 补录货品：`{"entryMethod","waybillNo","goodsName","pieces","finalWeight","weightSource"}` |
| POST | `/api/v2/tasks/:id/photos` | 上传照片（`multipart/form-data`，任意图片字段，可多张） |
| POST | `/api/v2/tasks/:id/exceptions` | 上报异常 `{"type","description"}` |
| POST | `/api/v2/tasks/:id/assist` | 邀请协助（主取件员或客服+）`{"workerId"}`，返回 `201` |
| POST | `/api/v2/tasks/:id/transfer` | 转派（主取件员或客服+）`{"workerId"}`（目标必须存在；空串=收回） |
| POST | `/api/v2/tasks/:id/reassign` | 改派（客服+）`{"workerId"}` |
| POST | `/api/v2/tasks/:id/again` | 一键再来一单（客服+） |
| POST | `/api/v2/exceptions/:id/resolve` | 处理异常（客服+）`{"resolution"}` → `{data:{exception}}` |

任务动作成功返回更新后的完整任务 `{data:{task}}`；`photos[].filePath` 仍为相对路径，展示时拼 `<baseUrl>`。

### 9.4 客户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v2/customers?search=&page=&pageSize=` | 分页检索（全部角色可读） |
| GET | `/api/v2/customers/:id` | 详情，含 `addresses[]` 与 `mainCsName` |
| POST | `/api/v2/customers` | 新建（客服+），Body：`name`(必填) `contact/contactName` `phone/contactPhone` `address` `note/remark` `legacyCustomerId` `importantNote` |
| PUT | `/api/v2/customers/:id` | 编辑（客服+），支持部分字段，另可传 `mainCsId`；省略字段保持原值 |

v2 客户列表字段：`id/customerNo/name/contact/phone/address/note/status/legacyCustomerId/importantNote/mainCsId/addressCount`。

### 9.5 基础资料 / 看板 / 历史记录 / 对账

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v2/couriers?page=&pageSize=` | 客服+ | 取件员档案（主数据量小，拉取用 `pageSize=100`） |
| POST | `/api/v2/couriers` | 管理员 | 新增 `{"name","region","commissionRate"}` |
| PUT | `/api/v2/couriers/:id` | 管理员 | 编辑（支持部分字段） |
| DELETE | `/api/v2/couriers/:id` | 管理员 | 删除 |
| GET | `/api/v2/areas?page=&pageSize=` | 登录用户 | 区域与默认取件员/备用取件员 |
| GET | `/api/v2/dashboard/me` | 取件员 | 我的待取/进行中/已完成/件数 |
| GET | `/api/v2/dashboard/board?range=today\|yesterday\|week\|month` | 客服+ | 汇总看板（件数/重量/客户数等） |
| GET | `/api/v2/dashboard/attention` | 客服+ | 待关注项计数：加急临期/超时未取/未匹配运单/无运单/未处理异常 |
| GET | `/api/v2/records?page=&pageSize=&courierId=&start=&end=&status=&keyword=&customerId=&unassigned=1` | 登录用户 | 历史取件记录；取件员自动只看自己，`unassigned=1` 可看待认领单；行含 `customerName/customerPhone`，时间已转 ISO8601 |
| GET | `/api/v2/billing?start=&end=&customerId=` | 客服+ | 对账汇总 `{data:{byCustomer,total}}` |
| GET | `/api/v2/commission?start=&end=` | 登录用户 | 提成（取件员只看自己，客服+看全员）`{data:{rows,total}}` |

说明：`/records`、`/billing`、`/commission` 为运营台账（旧记录表）口径；任务/看板汇总与 `/api/v2/dashboard/*`、`/api/v2/tasks`（新任务模型）是两套独立统计，注意区分。

### 9.6 站内通知与推送设备

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v2/notifications?page=&pageSize=&unread=1&type=` | 分页列表（v2 已统一 page=1 起） |
| GET | `/api/v2/notifications/unread-count` | `{data:{count}}` |
| POST | `/api/v2/notifications/:id/read` | 标记已读 |
| POST | `/api/v2/notifications/read-all` | 全部已读 |
| GET | `/api/v2/push/devices` | 本账号推送设备列表（华为 Android/鸿蒙共用） |
| POST | `/api/v2/push/devices` | 注册/替换设备：`{"providerCode":"huawei","platform":"harmonyos"|"android","token","deviceLabel","appVersion"}`；token 即华为 Push Kit 获取的 token |
| POST | `/api/v2/push/devices/:id/test` | 发测试推送（`202`，异步出结果） |
| DELETE | `/api/v2/push/devices/:id` | 注销设备（退出登录/换机时调用） |
| GET | `/api/v2/notification-preferences` | 通知偏好列表（每项 `type/channel/enabled/quietStart/quietEnd`） |
| PUT | `/api/v2/notification-preferences` | 写偏好：`{"type","channel","enabled","quietStart","quietEnd"}`，`type` 形如 `pickupTask.statusChanged`，`channel` 为 `in_app/web_push/vendor_push` |

通知对象字段与第 3 节一致（`id/type/title/body/data/read/readAt/createdAt/…`），时间已是 ISO8601 UTC。

### 9.7 与 v1 的差异速查

| 事项 | v1（历史） | v2（新端用这个） |
| --- | --- | --- |
| 成功响应 | 部分直出、部分 `{data}` | 一律 `{data}` |
| 列表 | 数组直出或 `page=0` | `{items,total,page,pageSize}`，page=1 |
| 任务时间 | `"YYYY-MM-DD HH:mm:ss"` UTC 文本 | ISO8601 UTC `…Z` |
| 登录 | `/api/login` | `/api/v2/auth/login`（同 token） |
| 任务/客户/通知/取件员/区域/台账 | 见第 2/4/6 节及 v1 直出结构 | 见上表（全部 `{data}` 包装） |

**SSE 实时通道仍用 v1**：`POST /api/v1/events/tickets` + `GET /api/v1/events`（v2 暂未提供 SSE 入口，其余全部业务请求走 v2）。

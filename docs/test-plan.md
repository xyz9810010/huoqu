# Huoqu 全面测试方案

覆盖三层：后端（Node.js + SQLite）、网页端（Vue3 + Element Plus）、鸿蒙端（ArkTS）。

## 一、测试基线

| 层 | 自动化 | 运行方式 |
|---|---|---|
| 后端 | 27 个测试文件 / 158 用例 | `npm test`（本地）或 `npm run test:container`（Docker） |
| 网页端 | 3 个 Playwright E2E 脚本 | `node e2e/web.e2e.js` 等（自动拉起隔离服务） |
| 鸿蒙端 | 4 个设备测试脚本 | DevEco / hvigor test，需真机或模拟器 |
| 脚本检查 | check-source-artifacts / compose / smoke / audit | `npm run check:*` / `npm run audit:*` |

---

## 二、后端测试

**运行**：`npm test`（本地）、`npm run test:container`（Docker，与线上环境一致，推荐）。

**覆盖矩阵**：
- 认证/会话：登录、限速、单点登录（cs/courier 互踢）、登录时间限制、会话过期。
- 加密/密钥：字段加密（客户/地址/快照/备注）、备份加密、主密钥自动生成、`*_FILE` 读取、推送凭据加密。
- 任务域：创建/派单/转派/协助/开始/完成/取消/改单（加急、指定时间通知内容）、状态流转。
- 通知域：business-publisher（取消通知取件员、变更带具体内容）、dispatcher、config、retention、去重、失效订阅。
- 推送供应商：huawei-provider、web-push-provider、push-key、push-sw。
- 实时：SSE tickets、realtime-events、Web Push。
- API 集成：api、api-v2、full-acceptance、assist-workflow。
- 数据：迁移、备份、重复审计、时间口径、归档保护。

---

## 三、网页端测试

**E2E（Playwright）**：
- `node e2e/web.e2e.js` — 页面可达性/登录/路由守卫巡检。
- `node e2e/journeys.e2e.js` — 真实 Chromium 多角色闭环。
- `node e2e/edge.e2e.js` — 边界用例。

**手动功能清单**：
- 登录/退出、401 自动跳登录、单点登录提示。
- 任务列表：筛选、搜索、无限滚动、吸顶 tab、左右滑切换。
- 派单：客户搜索（拼音/电话）、选地址、加急/指定时间、取件员推荐。
- 客户管理、看板、通知中心、消息设置（音量）、推送供应商、员工管理（登录时间限制）、区域、日志。
- 快捷键 `X/Q/K/S/?` + 帮助弹窗（地址跳转、账号密码复制）。
- 实时：SSE 刷新 + 站内弹窗 + 提示音。
- Web Push：开启/关闭/测试/失效重登记。
- 响应式：桌面 + 手机浏览器（取件员「新增订单」页）。

---

## 四、鸿蒙端测试

**自动化设备测试**：NativeIntentRegression、TaskDetailCounts、TaskItemEditing、WorkerCreateOrder。

**手动清单**：
- 服务器配置、登录、单点互踢。
- 任务列表：时间范围、状态 tab 左右滑、下拉刷新、心跳延迟。
- 取件员自助下单、派单、取件流程（开始/完成/取消/拍照）、拨号/导航。
- 通知中心、我的数据、设置。
- 华为 Push 专项：token 注册、前台/后台接收、点击跳转、横幅/声音（自分类权益）。
- SSE：实时刷新、断线重连、连接状态。

---

## 五、端到端联调（跨端闭环）

1. 客服网页派单 → 取件员鸿蒙端收到（华为 Push + SSE）。
2. 取件员开始/完成 → 客服网页实时看到状态。
3. 客服取消任务 → 取件员收到取消通知。
4. 任务变更（加急/指定时间）→ 通知带具体内容。
5. 三通道一致性：站内通知 + Web Push + 华为 Push。

---

## 六、专项/安全回归

- 加密链路：字段加密、备份加密 + restore-data.js 恢复。
- 登录时间限制、登录限速、单点登录。
- 数据备份/恢复、重复审计、源产物检查、compose 配置校验。

---

## 七、建议执行顺序

1. 后端：`npm run test:container`。
2. 网页端：Playwright E2E。
3. 鸿蒙端：真机回归。
4. 联调 + 安全专项。

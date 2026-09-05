# 货代取件系统完整测试方案 · 执行报告（2026-09-05）

执行方式：AI 全自动推演（真实运行取证）+ 人工复核清单。测试对象为本仓库工作树
（提交线 `1786c04` 之后的修复增量，见文末变更清单），覆盖方案要求的
业务功能/前后端交互/安全/Docker 容器/并发压力/浏览器兼容/异常恢复七大类。

## 0. 结论摘要

- 全量自动化回归 **137/137 通过**（原 124 + 新增 `tests/full-acceptance.test.js` 13 条）。
- 浏览器 E2E 三套全部 ok：`web.e2e.js`（逐页巡检）、`journeys.e2e.js`（业务旅程）、
  **新增** `edge.e2e.js`（404/断网恢复/派单防重复/XSS 渲染）。
- Docker 专项：`scripts/smoke-container.sh` ok（重启持久化 + 完整性）；
  **新增** `scripts/container-acceptance.sh` 7 组容器边界场景全部 ok。
- 本轮真实修复 4 个缺陷 + 1 个安全面收口（见第 2 节清单，均带回归用例）。
- 遗留待产品/架构决策 4 项（见第 3 节），均为中低风险，不阻断上线。

## 1. 执行证据（可重复运行）

| 验证项 | 命令 / 产物 | 结果 |
| --- | --- | --- |
| 单元/接口回归（含新增 13 条验收） | `npm test` | 137/137 pass |
| 前端构建（vue-tsc + vite） | `npm run web:build` | ok |
| Web 逐页巡检 | `docker run … hq-e2e-img node e2e/web.e2e.js` | e2e-web=ok |
| 业务旅程（派单→取件→拍照→完成→通知→过机匹配） | `node e2e/journeys.e2e.js`（服务端需 `MACHINE_API_KEY`） | journeys-e2e=ok |
| 浏览器边缘场景（新增） | `node e2e/edge.e2e.js` | edge-e2e passed=true |
| 容器重启持久化 / 完整性 | `npm run smoke:container` | auth/restart-persistence/integrity 均 ok |
| 容器边界矩阵（新增） | `IMAGE=huoqu:final-20260905 bash scripts/container-acceptance.sh` | container-acceptance=ok（7 组） |

浏览器 E2E 的起法与依赖（Playwright 模块/浏览器缓存、Docker 运行器）见
`docs/operations/e2e-web.md`；服务容器统一使用隔离临时库（`DB_PATH=/tmp/hq-e2e.db`），
全程不触碰生产数据。

## 2. Bug 风险清单（等级 / 场景 / 后果 / 修复）

| 风险等级 | 场景描述 | 产生后果 | 修复方案 | 状态 |
| --- | --- | --- | --- | --- |
| 中 | 创建任务/记录时传负数件数、负数或非有限重量（`-3`/`1e999`/`Infinity`），或任务体积为负 | 负重量/非法数值入库，看板统计、匹配中心、导出出现脏数据；`1e999` 序列化后字段变 null | 域层与 v1/v2 入口统一校验：物理量（件数/重量/体积）非负且有限，超限返回 400 + 中文提示；0 保留“未称重”语义；负数金额保留（冲账） | ✅ 已修复（`server/domain/tasks.js`、`api.js`、`api-v2.js`，回归用例 2 条） |
| 中 | 客户端（尤其未来安卓/鸿蒙原生端）双击、断网重试重复提交建单；Web 端回车+点击同帧双发 | 重复订单/重复任务与重复通知 | 服务端支持 `X-Idempotency-Key`/`Idempotency-Key`：同用户同键 10 分钟窗口回放首次成功响应（v1/v2 建任务、v1 建记录）；Web `submit()` 增加 `saving` 防重入 | ✅ 已修复（新增 `server/http/idempotency.js` + `Dispatch.vue`，回归 3 处断言） |
| 中（安全） | 未捕获异常（未来 bug、SQLite 错误）会经统一错误处理把 `err.message`（可能含 SQL/路径）回传给客户端 | 内部结构/路径泄露，攻击面变大 | 兜底错误处理只回友好文案并保留状态码，细节仅进服务端日志；`LIMIT_FILE_SIZE` 保留图片专属提示 | ✅ 已修复（`server.js`，畸形输入用例覆盖无堆栈/无内部路径） |
| 低（UX） | 访问不存在的路由（如手输错地址、历史链接失效） | Layout 主区空白、无任何指引，观感像崩溃 | 新增路由 catch-all + `NotFound.vue`（提示 + 返回首页按钮） | ✅ 已修复（`router.ts` + 新视图，edge e2e 断言） |
| 低 | 前端 `submit()` 无 `saving` 重入保护（按钮 loading 挡住大多数点击，但同帧二次触发可绕过） | 偶发重复建单 | 函数首行 `if (saving.value) return` | ✅ 已修复（`Dispatch.vue`，edge e2e 强制双发只产生 1 次创建请求） |
| 低（契约） | v1 旧通道 `/api/notifications/unread-count` 返回裸数字，与 v1/v2 包装契约不同构 | 新端误按对象解析会踩坑 | 新端一律走 v2 `/api/v2/notifications/unread-count`；旧通道保留不动，避免破坏存量 Web 之外依赖 | 📌 记录在案，不动 |
| 中（需产品决策） | 新任务模型 `business_order_no` 无唯一约束（legacy `records.order_no` 有部分唯一索引） | 同业务单号可重复建单（双端并发/重复导入） | 不建议直接加唯一索引（同单再次取件是合法业务）。推荐：① 客户端幂等键（本轮已支持）② 运维稽核 SQL 报表 ③ 若确需唯一，加“进行中任务”部分唯一索引并先评审再次取件流程 | 📌 backlog P3（产品决策） |
| 低-中 | 双数据源并存：新任务模型 + 旧 `records`（迁移保留回滚源），接口/看板/查单需双写双读 | 口径漂移、维护成本 | 长期收敛为任务模型单数据源；本轮查单/认领/改派已做并集兜底 | 📌 既有架构 backlog，持续跟踪 |
| 低 | 文本字段无长度上限（20MB JSON 内 30 万字符可入库；UI textarea 未设 maxlength） | 极端输入撑大页面/导出 | UI 层对备注类字段设 maxlength + 服务端可选长度上限（产品定文案上限） | 📌 优化项 |
| 优化 | 前端 axios 全局 `timeout: 20000` | 弱网时“创建类”请求最坏 20s 才提示失败，体感卡 | 分场景超时：普通 10s、上传 60s；失败文案区分“网络不可用/服务超时” | 📌 优化项 |
| 优化 | 登录限速参数硬编码（15 分钟窗口 8 次） | 高并发环境误伤或需调参时改代码 | 环境变量化（`LOGIN_THROTTLE_*`） | 📌 优化项 |
| 未覆盖（真机） | 华为推送真实设备端到端弹窗（AGC 签名/bundleName 授权） | 服务端已 mock 验证，真机行为未证实 | 需要真机 + 已签名 App 联调（见 `docs/api/mobile-integration.md`） | 📌 backlog P1（人工复核） |

## 3. 优先级修复清单

**P0/P1（致命/高）**：本轮未发现致命或高风险缺陷。
**P2（已全部修复）**：负数/非法数值入库；创建幂等（服务端 + Web 防重入）；404 兜底页；
错误响应信息收敛（安全面）。
**P3（待产品/架构决策）**：
1. `business_order_no` 去重策略（先上幂等键 + 稽核报表，再评审唯一索引）；
2. 双数据源单模型收敛节奏；
3. 文本长度上限与分场景超时；
4. 多实例扩容前评估 SQLite 单文件写放大（建议迁移 PostgreSQL，见容器报告第 7 项）。
**人工复核（真机/人工）**：HarmonyOS 真机推送弹窗、真实扫码过机回传、弱网真机操作、
多浏览器手工视检（详见第 5 节清单）。

## 4. 可复用测试用例（自动化锚点）

方案各章节 → 自动化落点：

| 方案模块 | 覆盖场景 | 自动化锚点 |
| --- | --- | --- |
| 业务黑盒 | 下单/派单/接单/完成/取消/改单/异常/协助/查单/通知全链路 | `tests/api.test.js`、`api-v2.test.js`、`tasks.test.js`、`assist-workflow.test.js`、`e2e/journeys.e2e.js` |
| 前后端交互 | 畸形 JSON/非对象 body/超长/emoji/特殊字符；重复提交；并发抢单/改派/状态竞争 | `tests/full-acceptance.test.js`（新增 13 条）、`hardening.test.js` |
| 安全 | 角色越权矩阵、令牌篡改、SQL/通配符注入探测、XSS 存储渲染、登录限速 429、错误信息不泄漏 | `hardening.test.js`、`bootstrap-security.test.js`、`full-acceptance.test.js`、`e2e/edge.e2e.js` |
| Docker 容器 | 启动/健康/重启持久化/完整性/错误 env/只读卷/资源限制/日志脱敏/双实例卷边界 | `scripts/smoke-container.sh`、`scripts/container-acceptance.sh` |
| 并发压力 | 60×60 并发批量建单不丢不重、分页无缺口；并发改派最终唯一 | `tests/full-acceptance.test.js` 第 6 组 |
| UI 兼容 | 逐页渲染/样式/图表/控制台；404 兜底；断网→恢复；派单双击防重 | `e2e/web.e2e.js`、`e2e/journeys.e2e.js`、`e2e/edge.e2e.js` |
| 异常恢复 | 断网提示不卡死、恢复后刷新同步；中间态任务防卡死（状态机） | `e2e/edge.e2e.js`、`tests/tasks.test.js`、`hardening.test.js` |

人工复核自测清单（建议发布前人工过一遍，预期值已列）：
1. 鸿蒙真机注册推送 → 派单给该账号 → 锁屏/前台两种状态均弹通知；失败时设置页给出可读原因。
2. 真实过机设备回传重量 → 匹配中心自动带出最终重量（容器版旅程已用接口级等价覆盖）。
3. 弱网（DevTools 3G）下完成“下单→接单”，等待≤10s 应出现失败提示，不允许无限 loading。
4. Chrome / Edge / 手机浏览器各打开 Dashboard、派单、任务详情比对布局与弹层。
5. 双人同时认领同一“待认领”订单，只能一人成功且另一方看到已分配提示。

## 5. Docker 容器专项检查报告

镜像：`huoqu:final-20260905`（由本仓库 Dockerfile 构建，多阶段：native 依赖 → 测试层 → web 构建 → runtime）。
数据卷/端口全部隔离（`/tmp` 或 `mktemp` 卷），未触碰生产容器与数据。

| 检查项 | 操作 | 结果 |
| --- | --- | --- |
| 镜像启动 / 健康 / 前端可达 | `docker run -d` 默认配置 → `/api/health` + `/` 返回 SPA 入口 | ✅ |
| 重启持久化 | `docker compose restart` 后旧账号可登录（数据未丢） | ✅（smoke-container） |
| 数据库完整性 | 重启后 `PRAGMA integrity_check` | ✅ ok |
| 错误 DB 路径 | DB 目录被文件占位（ENOTDIR）→ 容器退出 code=1，日志给出明确错误 | ✅ 不静默运行 |
| 推送开启但缺主密钥 | 服务保持 healthy；登记华为设备返回 `503 + PUSH_MASTER_KEY_MISSING`（中文提示可配置） | ✅ |
| 资源限制 | `--cpus=0.2 --memory=96m` 下登录 + 建单闭环成功 | ✅ 不写脏数据 |
| 日志脱敏 | 32 字节主密钥与会话 token 均不出现在 `docker logs` | ✅ |
| 只读数据卷 | `/app/data:ro` → 容器明确退出，错误提示可读 | ✅ |
| 双容器共享 SQLite 卷 | WAL 下双实例可同时启动、A 写入 B 可读 | ✅（规模扩容前需架构评审，见 P3-4） |

限制与建议：
- 单文件 SQLite + WAL 适合当前单实例；横向扩容（多副本写）需换独立库（PostgreSQL）或按实例分库。
- `docker compose down` 不会删数据卷；生产升级流程保持“备份 → 构建/部署 → integrity 检查 → 观察日志”，与既有 runbook 一致。

## 6. 本轮变更清单

- 服务端：`server/http/idempotency.js`（新增）、`server/domain/tasks.js`、`server/http/api.js`、
  `server/http/api-v2.js`、`server.js`
- 前端：`web/src/views/NotFound.vue`（新增）、`web/src/router.ts`、`web/src/views/Dispatch.vue`
- 测试：`tests/full-acceptance.test.js`（新增 13 条）、`e2e/edge.e2e.js`（新增浏览器边缘巡检）
- 运维：`scripts/container-acceptance.sh`（新增容器边界矩阵）
- 文档：本文档、`docs/operations/audit-2026-09-05.md`、`docs/operations/e2e-web.md`

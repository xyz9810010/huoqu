# 🚚 Huoqu · 货代取件运营平台

面向货代公司的取件业务管理与统计系统。支持**多角色账号**（管理员 / 客服派单员 / 取件员）、按取件员登记派单，并按 **每日 / 每周 / 每月 / 每年** 统计每个取件员的**取件量、订单数、客户数**，附带**客户档案管理（联系人/电话/地址）**、**货物明细（品名/重量/体积/面单号）**、**订单状态流转与轨迹查单**、**财务对账（应收/应付/结算）**、**扫码查单**、**趋势分析**与 **Excel 导入导出**。

- **后端**：Node.js + Express + REST API
- **数据库**：SQLite（文件型、零配置、可靠持久化）
- **鉴权**：账号密码登录 + 会话 Token，管理员 / 客服 / 取件员三角色数据隔离
- **前端**：`web/` Vue 3 + Element Plus 单页应用（构建后由同一 Node 服务托管，无外部 CDN 依赖，NAS 内网可离线使用）
- **部署**：支持 Docker 一键部署或直接 `node` 运行，适配群晖 / 威联通 / 极空间 / UNAS 等 NAS

本项目边界仅包含 Node.js 服务端和 Vue Web 管理端。Android、HarmonyOS 客户端及历史参考资料已移至同级的 `huidaiqujian-detached-20260903` 归档目录，不参与本项目构建或部署。

---

## 🔐 登录账号

首次部署前必须设置至少 12 位的 `INITIAL_ADMIN_PASSWORD`，系统随后创建初始管理员：

| 用户名 | 初始密码 | 角色 |
|--------|---------|------|
| `admin` | `INITIAL_ADMIN_PASSWORD` 的值 | 管理员 |

> ⚠️ 密码只从环境变量读取，不会写入日志或源码。首次登录后建议在系统内换成长期密码。

### 角色权限
| 功能 | 管理员 | 客服（派单员） | 取件员 |
|------|:---:|:---:|:---:|
| 统计看板 / 趋势分析 | ✅ | ✅（全员） | ✅（仅看自己） |
| 取件登记 / 派件 | ✅ | ✅（派件，可派给任意取件员） | ✅（自动归属自己） |
| 客户管理 | ✅ | ✅（可增改） | ✅（可新增/只读） |
| 财务对账 | ✅ | ✅ | ❌ |
| 提成工资 | ✅ | ❌ | ❌ |
| 客服派单量统计 | ✅ | ✅ | ❌ |
| 取件员管理 | ✅ | ❌ | ❌ |
| 用户管理（开通账号） | ✅ | ❌ | ❌ |
| 记录报表 / 导出 Excel | ✅ | ✅（可删自己派的单） | ✅（仅看/删自己） |
| Excel 导入 | ✅ | ❌ | ❌ |
| 数据备份 / 恢复 | ✅ | ❌ | ❌ |

> 💡 客服（派单员）用于「客服接单后给取件员派单」的场景：能看到全部取件员与全员工作量、为任意取件员登记派单、查看/导出记录，但无用户管理、取件员管理、备份恢复等管理员权限。每条记录会自动记录「派单人」，便于统计每位客服的派单量。

> 🔒 **订单权限回收**：取件员只能操作自己名下「进行中（待取/已取）」的订单（拍照留底、改状态、删除）；订单一旦「已完成/已取消」，取件员的编辑权限自动回收，仅管理员/客服可再修改。

---

## 一、快速部署（推荐：Docker）

### docker-compose
```bash
export INITIAL_ADMIN_PASSWORD='<至少12位的初始密码>'
export PUSH_CONFIG_MASTER_KEY="$(npm run --silent push:key)"
docker compose up -d
docker compose ps
# 访问 http://<你的NAS的IP>:3000
```

`docker compose ps` 中服务应显示为 `healthy`。如需完整验证，可运行 `npm run smoke:container`；该命令使用独立临时数据库和端口，不会访问正式 `./data`。

### 纯 docker
```bash
docker build -t huoqu .
docker run -d --name huoqu -p 3000:3000 \
  -v $(pwd)/data:/app/data --restart unless-stopped huoqu
```

> 数据库存放在 `/app/data/app.db`，通过 volume 映射到宿主机 `./data`，**重装/升级容器数据不丢，记得备份 data 目录**。

---

## 二、部署（无 Docker，直接 Node）

直接运行需 Node.js 24 LTS。生产部署推荐使用 Docker，以避免宿主机原生模块和平台差异：
```bash
npm install
node server.js        # 或 npm start
```
可配置环境变量：`PORT`（默认3000）、`DB_PATH`（数据库路径，默认 ./data/app.db）。首次部署必须配置 `INITIAL_ADMIN_PASSWORD`；启用消息推送必须配置 `PUSH_CONFIG_MASTER_KEY`；启用过机设备接口必须配置 `MACHINE_API_KEY`。

### 测试与备份

```bash
# 在一次性 Linux 容器中运行全部测试，不挂载正式数据库
npm run test:container

# 验证源码、Compose 配置和真实容器启动/登录/重启
npm run check:artifacts
npm run check:compose
npm run smoke:container

# 在线一致性备份到 ./backups/<时间戳>/
docker compose exec -T huoqu npm run backup -- "$(date -u +%Y%m%dT%H%M%SZ)"
```

不要使用宿主机遗留的 `node_modules` 判断测试结果；本项目包含原生 SQLite 模块，跨 Windows/Linux 复制会导致二进制格式错误。恢复备份前必须对候选数据库执行 `sqlite3 -readonly <备份数据库> 'PRAGMA integrity_check;'` 并确认结果为 `ok`。详细步骤见 `docs/operations/baseline-runbook.md`。


---

## 部署进阶

### 🔔 统一消息推送

站内通知、浏览器 Web Push 和华为 Push Kit 共用通知中心与持久化投递队列。先配置 `PUSH_CONFIG_MASTER_KEY`，再由管理员进入“消息推送”，选择适配器并依次执行“保存配置 → 连接测试 → 启用”。私钥加密存储且不会由 API 回传。

华为通道填写 Project ID 与 AGC 服务账号 JSON；浏览器通道填写 VAPID 联系地址、公钥和私钥。后续新增厂商时只需安装对应服务端适配器，后台表单会读取适配器字段定义自动生成，无需修改业务模块。浏览器系统通知的 HTTPS 部署见 `docs/deployment/browser-push-https.md`。

### ⚖️ 过机设备对接（重量 / 尺寸自动回传）

公司过机设备称重 / 量方后，调用以下接口把数据写回对应订单：

```http
POST /api/machine/weigh
X-Machine-Key: <密钥>

{ "orderNo": "订单号", "weight": 12.5, "dimensions": "40×30×20" }
```

| 字段 | 说明 |
|------|------|
| `orderNo` | 订单号（与 `trackingNo` 二选一，优先按订单号匹配） |
| `trackingNo` | 面单号 / 运单号（订单号未命中时按面单号匹配） |
| `weight` | 重量（kg，数字） |
| `dimensions` | 尺寸字符串（如 `40×30×20`，单位 cm） |
| `length` / `width` / `height` | 也可分开传三边，服务端自动拼成 `长×宽×高` |

- 鉴权头 `X-Machine-Key` 的值由环境变量 `MACHINE_API_KEY` 控制；未配置时接口返回 `503`，不会以空密钥运行。
- 命中订单后写入 `weight` 与 `dimensions` 并实时广播；未命中返回 `404`。
- 未对接过机设备时，可在登记 / 编辑页面**手动填写重量与尺寸**。

---

## 三、功能清单

| 模块 | 功能 |
|------|------|
| 📊 统计看板 | 今日/本周/本月/今年/自定义 统计；各取件员件数柱状对比、明细表、状态分布、客服派单量 |
| 📈 趋势分析 | 近30天件数/客户数折线、近13周、近12月趋势（离线上描 SVG 图） |
| ➕ 取件登记 | 日期/取件员/客户/订单号/面单号/品名/重量/体积/件数/状态/应收/应付/结算/区域/备注，批量连续录入，自动带出区域与今日负荷 |
| 🏢 客户管理 | 客户档案（名称/联系人/电话/地址），派单时**模糊搜索**选择（输名称/联系人/电话片段即可）或快速建档；客户列表支持按名称/联系人/电话搜索 |
| 📦 货物明细 | 品名、重量、体积、面单号/运单号，记录列表完整展示 |
| 🔄 订单状态 | 待取 / 已取 / 已完成 / 已取消，记录列表内一键流转，看板按状态汇总，全程留轨迹 |
| 📡 轨迹查单 | 客户在登录页输入订单号/面单号，或「手机号 + 姓氏」即可自助查询状态与时间线（免登录，姓名脱敏） |
| 📷 扫码查单 | 摄像头扫码识别面单号/订单号（内置 html5-qrcode，支持 iPhone Safari / 安卓 / 微信），自动定位订单 |
| 🖼 图片留底 | 派单员上传货物图、取件员上传取件图，记录列表缩略图展示，图片存于 `data/uploads` |
| 🔔 实时推送 | SSE 无感刷新 + 系统通知：派单 / 状态变更 / 图片上传即时到达，无需手动刷新 |
| 🔄 认领 / 改派 | 取件员可认领「未分配」订单，客服/管理员可改派取件员；取件员端有「待处理」角标与一键状态按钮 |
| 💰 财务对账 | 应收/应付/结算状态，按客户对账汇总，导出对账 Excel |
| 🔖 订单号 | 选填，非空时唯一防重复录入，支持按订单号/面单号/品名搜索 |
| 👥 取件员 | 增删改，维护负责区域与提成单价；派单时按姓名/区域模糊搜索选择 |
| 💵 提成工资 | 按取件员计件提成（件数 × 单价），按时间段汇总，导出提成 Excel（管理员） |
| 🗂 记录报表 | 按取件员/客户/状态/日期/关键字筛选，删除，**Excel导出(.xlsx)**、**Excel批量导入**、导入模板下载 |
| 👤 用户管理 | 为取件员/客服开通登录账号，重置密码，删除账号（管理员） |
| 🔐 安全 | 登录鉴权、角色数据隔离、修改密码、JSON备份/恢复 |

**统计口径**：取件件数 = 该时间段取件总量；订单数 = 记录条数；客户数 = 去重客户数。

---

## 四、REST API（Base URL：`http://<host>:3000`）

除 `/api/login`、`/api/health` 外，所有接口需请求头 `Authorization: Bearer <token>`。

### 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 登录 `{username,password}` → 返回 `{token,user}` |
| POST | `/api/logout` | 注销 |
| GET | `/api/me` | 当前登录用户信息 |
| POST | `/api/password` | 修改密码 `{oldPassword,newPassword}` |
| GET | `/api/events?token=<会话Token>` | 实时推送（SSE），记录/客户/取件员变更时广播事件 |

### 用户管理（管理员）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users` | 用户列表 |
| POST | `/api/users` | 新增用户 `{username,password,role,courierId,name}`（role：`admin`/`cs`/`courier`） |
| DELETE | `/api/users/:id` | 删除用户 |
| POST | `/api/users/:id/reset` | 重置密码 `{password}` |

### 取件员（管理员）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/couriers` | 取件员列表 |
| POST | `/api/couriers` | 新增 `{name,region,commissionRate}` |
| PUT | `/api/couriers/:id` | 编辑（含 `commissionRate` 提成单价） |
| DELETE | `/api/couriers/:id` | 删除 |

### 客户管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/customers` | 客户列表（所有角色可读） |
| POST | `/api/customers` | 新增 `{name,contact,phone,address,note}`（所有角色；取件员自助登记时可快速建档） |
| PUT | `/api/customers/:id` | 编辑（管理员/客服） |
| DELETE | `/api/customers/:id` | 删除（仅管理员） |

### 取件记录
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/records?courierId=&customerId=&status=&start=&end=&keyword=` | 查询（取件员强制只看自己；keyword 匹配客户名/订单号/面单号/品名） |
| POST | `/api/records` | 新增 `{date,courierId,customer,customerId,pieces,address,goods,weight,volume,trackingNo,amountReceivable,amountPayable,settled,region,note,status,orderNo}`（orderNo 非空时唯一；**件数必填**，派单角色**取件地址必填**） |
| PUT | `/api/records/:id/status` | 改状态 `{status,note}`（取件员仅自己名下的进行中订单、客服仅自己派发的单，自动留轨迹） |
| PUT | `/api/records/:id` | 补录取件信息 `{pieces,trackingNo}`（件数必填、面单号选填，可手动/扫码/拍照；不改财务/结算/状态/客户/取件员，权限同上） |
| PUT | `/api/records/:id/settle` | 改结算状态 `{settled}`（管理员/客服） |
| DELETE | `/api/records/:id` | 删除 |
| POST | `/api/records/:id/images` | 上传图片 `multipart: images(多文件) + type(goods/pickup)`，权限同记录编辑 |
| PUT | `/api/records/:id/courier` | 改派/认领取件员 `{courierId}`（管理员任意、客服仅自己派发的单、取件员仅认领未分配订单给自己） |

### 对账 / 轨迹 / 提成
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/billing?start=&end=&customerId=` | 按客户对账汇总 + 总额（管理员/客服） |
| GET | `/api/commission?start=&end=` | 各取件员提成（件数×单价）+ 总额（仅管理员） |
| GET | `/api/track?q=<订单号/面单号>` 或 `?phone=<手机号>&surname=<姓氏>` | 客户自助查单（**免登录**），返回状态+时间线，客户姓名脱敏 |

### 统计 / 趋势
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats?range=today\|week\|month\|year\|custom&start=&end=` | 统计总览+各取件员明细 |
| GET | `/api/trend?period=daily\|weekly\|monthly&days=\|weeks=\|months=` | 趋势序列（件数/客户数） |

### 备份 / Excel
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/backup` | 全量 JSON 备份 |
| POST | `/api/import` | JSON 导入 `{couriers:[],records:[]}` |
| GET | `/api/export.xlsx` | 导出 Excel（取件记录+按取件员统计两个 sheet） |
| GET | `/api/import.template.xlsx` | 下载导入模板 |
| POST | `/api/import.file` | 上传 Excel/CSV 批量导入（multipart `file`），取件员按列名自动匹配/创建 |
| GET | `/api/health` | 健康检查 |

**Excel 导入列名**：`日期`、`取件员`（可空，按姓名自动匹配或新建）、`客户名称`、`订单号`（可空，重复则跳过）、`面单号`、`品名`、`重量kg`、`体积m3`、`件数`、`状态`（待取/已取/已完成/已取消，默认待取）、`应收`、`应付`、`结算`（已结算/未结算）、`区域`、`备注`。日期支持 `2026-08-14` / `2026/8/14` / Excel 日期。

---

## 五、目录结构
```
huoqu/
├── server.js          # 后端服务 + REST API + 鉴权
├── db.js              # SQLite 初始化
├── auth.js            # 密码哈希 / 会话 / 登录
├── package.json
├── Dockerfile
├── docker-compose.yml
├── web/               # Vue 3 + Element Plus 网页端（npm run web:build 构建）
├── server/            # 领域服务 / 迁移 / 通知推送等后端模块
├── tests/             # 自动化测试（npm test）
├── scripts/            # 源码边界、Compose、容器冒烟和备份脚本
├── deploy/             # 反向代理与部署配置
├── public/             # web/dist 不存在时的静态页面回退
├── data/               # 数据库文件（持久化）+ uploads/ 图片目录（备份时请一并备份）
└── backups/            # 在线备份输出（不纳入镜像）
```

# Huidaiqujian 项目边界剥离设计

## 目标

将 `/home/wujiaoxi/projects/huidaiqujian` 收敛为单一的 Node.js/Express 后端与 Vue Web 前端项目。Android、HarmonyOS、移动端编译产物、旧源码包、UI 审核材料、历史实施过程文件和可再生成的依赖缓存移动到同级归档目录，同时保持当前生产容器、数据库、上传文件、备份、直接 Node 启动和 Docker 构建能力不受影响。

## 已确认的边界

核心项目负责以下内容：

- Node.js 24 + Express REST API 与 SSE 服务。
- SQLite 数据、上传文件和在线备份。
- Vue 3 Web 前端源码、静态构建产物与旧静态页面回退。
- Docker/Compose 部署、HTTPS 反向代理配置、运维脚本与自动化测试。

核心项目不再包含以下内容：

- Android 客户端源码、Gradle 缓存和 APK 构建产物。
- HarmonyOS 客户端源码、签名配置、AGC 配置和 HAP/APP 构建产物。
- 旧参考源码压缩包、UI 对照截图和一次性图片测试脚本。
- 已完成的 Superpowers 规格、计划与结果档案。
- 宿主机 `node_modules`、Web `node_modules` 和根目录运行日志。

## 剥离方式

创建同级目录：

`/home/wujiaoxi/projects/huidaiqujian-detached-20260903`

目录权限设置为 `0700`，因为 HarmonyOS 目录包含 AGC 配置，可能含有凭据。目标目录必须事先不存在；若存在则停止，不覆盖任何内容。

所有内容通过同一文件系统内的移动操作剥离，不永久删除。归档结构如下：

```text
huidaiqujian-detached-20260903/
├── mobile/
│   ├── android/
│   ├── harmony/
│   ├── harmony-builds/
│   │   ├── _h3/
│   │   ├── _h4/
│   │   └── _h5/
│   └── _imgtest.js
├── references/
│   ├── archives/
│   ├── audit-ui/
│   └── design-qa.md
├── history/
│   └── superpowers/
├── generated/
│   ├── root-node_modules/
│   ├── web-node_modules/
│   ├── server.log
│   └── server.err.log
└── MANIFEST.md
```

`MANIFEST.md` 记录原路径、归档路径、移动原因和恢复方法，但不记录任何密码、令牌或配置文件内容。

## 保留内容

以下内容不得移动或删除：

- `.env`、`.env.example`。
- `data/`、`backups/`。
- `server.js`、`server/`、`db.js`、`auth.js`。
- `web/src/`、`web/public/`、`web/dist/` 及 Web 包清单。
- `public/`。服务端在 `web/dist/index.html` 不存在时使用它作为回退页面。
- `Dockerfile`、Compose 文件、`deploy/`、`scripts/`、`tests/`。
- `README.md`、`CONTEXT.md`、`docs/deployment/`、`docs/operations/`、本规格。
- `tsconfig.base.json`。Dockerfile 的 Web 构建阶段依赖它。

## 源码与文档调整

剥离后执行以下小范围调整：

1. 更新 `README.md`，明确仓库边界仅为 Web/Node，并给出保留后的目录树。
2. 精简 `.dockerignore` 中只针对已剥离目录的条目，同时继续忽略依赖、数据、日志、构建产物和备份。
3. 精简 `.gitignore` 中 HarmonyOS 专用规则；保留通用移动端构建残留模式，防止 `_h*`、日志和依赖缓存重新进入项目。
4. 扩展 `scripts/check-source-artifacts.js`，若根目录再次出现 `android`、`harmony`、`_h3`、`_h4`、`_h5`、`archives` 或 `audit-ui`，检查必须失败。
5. 为新增的项目边界检查补充自动化测试，先证明旧目录会触发失败，再完成检查规则。

服务端路由、数据库结构、API、前端业务逻辑和部署端口均不改变。

## 执行顺序与失败处理

1. 记录移动前清单、文件数量和大小。
2. 确认归档目标不存在并创建权限为 `0700` 的目录结构。
3. 按类别逐项移动；每项移动后核对源路径消失且目标路径存在。
4. 写入归档清单。
5. 更新文档和忽略规则。
6. 先增加失败的边界检查测试，再修改检查脚本使测试通过。
7. 运行完整验证。

任何移动步骤失败时立即停止，不继续后续类别。已移动内容保持在归档目录，并可按照 `MANIFEST.md` 逐项移回原路径。不得使用递归删除、覆盖移动或清理孤立 Docker 容器的命令。

## 验证标准

整理完成必须同时满足：

- 项目根目录不存在已列出的移动端和归档目录。
- 归档清单中的每个源项都能在目标位置找到。
- `scripts/check-source-artifacts.js` 能阻止移动端目录再次混入。
- `npm run check:artifacts` 通过。
- `npm run check:compose` 通过。
- `docker build --tag huidaiqujian-scope-check .` 通过；使用 Dockerfile 的 `web-build` 阶段在容器内安装依赖并构建，不向项目重新写入 `node_modules`。
- `npm run test:container` 的 73 项测试全部通过。
- 正式 `huoqu` 容器仍为 `healthy`。
- `GET http://127.0.0.1:3000/api/health` 返回 `200` 和 `status: ok`。
- 正式 SQLite 数据库只读 `PRAGMA integrity_check` 返回 `ok`。

## 回滚

停止后续编辑，按照归档 `MANIFEST.md` 将各项从同级目录移动回原路径。由于生产容器未挂载源代码、Android 或 HarmonyOS 目录，文件剥离本身无需停止生产容器。`data/` 和 `backups/` 始终留在原位，不参与回滚。

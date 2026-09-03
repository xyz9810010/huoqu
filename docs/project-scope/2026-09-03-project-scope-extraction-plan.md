# Huidaiqujian 项目边界剥离实施计划

状态：已执行完成（2026-09-03 UTC）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

将 `/home/wujiaoxi/projects/huidaiqujian` 收敛为 Node.js/Express 后端与 Vue Web 前端；把 Android、HarmonyOS、旧资料、审核材料、历史规格和宿主机依赖缓存安全移动到同级归档目录，并以自动检查和容器验证证明运行能力未受影响。

## Architecture

- 生产项目根目录只保留 Web/Node、数据、部署、脚本和测试所需内容。
- 同级归档目录 `/home/wujiaoxi/projects/huidaiqujian-detached-20260903` 权限为 `0700`，按 `mobile/`、`references/`、`history/`、`generated/` 分类保存移动内容。
- 归档采用同文件系统 `mv`，不删除、不覆盖；`MANIFEST.md` 记录原路径、目标路径、原因和回滚方法，不写入密钥值。
- `scripts/check-source-artifacts.js` 提供可测试的 `findForbidden(root)`，检查 Web 生成残留及项目根目录不应重新出现的移动端目录。
- 服务端路由、数据库、前端业务逻辑、Docker 运行时和部署端口保持不变。

## Tech Stack

Node.js 24、Express、Vue 3、SQLite、Docker Compose、Node built-in test runner、Bash。

## Reference

设计规格：[2026-09-03-project-scope-extraction-design.md](./2026-09-03-project-scope-extraction-design.md)

## Global Constraints

- 不运行 `rm -rf`、递归删除、覆盖移动或清理孤立 Docker 容器。
- 归档目标若已存在，立即停止并报告；不得合并或覆盖其中内容。
- 移动按单项执行；每项都验证源路径消失、目标路径存在，失败时停止后续移动。
- `.env`、`data/`、`backups/`、`public/`、`web/dist/` 和运行时代码不得移动。
- 没有 Git 元数据，不创建提交；所有变更通过工作区文件和验证结果交付。

## Task 1: 建立可回滚归档并移动已确认的非项目内容

**Files:** `/home/wujiaoxi/projects/huidaiqujian-detached-20260903/`（新建）、根目录待移动条目

- [ ] 记录移动前清单、条目数量与大小：用 `find` 列出候选项，用 `du -sh` 记录总量，并将记录保存在归档目录的操作日志中（不包含文件内容或秘密值）。
- [ ] 确认 `/home/wujiaoxi/projects/huidaiqujian-detached-20260903` 不存在；若存在则停止，不覆盖。
- [ ] 创建归档目录树并设置 `chmod 700`：`mobile/android`、`mobile/harmony`、`mobile/harmony-builds`、`references`、`history`、`generated`。
- [ ] 按映射逐项移动并逐项核验：
  - `android/` → `mobile/android/`
  - `harmony/` → `mobile/harmony/`
  - `_h3/`、`_h4/`、`_h5/` → `mobile/harmony-builds/`
  - `_imgtest.js` → `mobile/_imgtest.js`
  - `archives/`、`audit-ui/`、`design-qa.md` → `references/`
  - `docs/superpowers/` → `history/superpowers/`
  - 根 `node_modules/`、`web/node_modules/` → `generated/root-node_modules/`、`generated/web-node_modules/`
  - `server.log`、`server.err.log` → `generated/`
- [ ] 写入 `MANIFEST.md`，包含每个源项、目标项、移动原因、移动前后核验状态和逐项回滚命令；不得写入 `.env` 或 AGC 配置的值。

## Task 2: 先为项目边界检查补充失败测试

**Files:** `tests/source-artifacts.test.js`

- [ ] 使用 `node:test`、`assert/strict`、`fs`、`os`、`path` 创建临时 fixture；fixture 一组含 `web/src/App.js` 与根 `harmony/`，另一组只含合法 Web 源码。
- [ ] 从 `scripts/check-source-artifacts.js` 引入 `findForbidden`，断言含 `harmony/` 的 fixture 返回该路径，干净 fixture 返回空数组；同时覆盖 `.js`、`.js.map`、`web/tsconfig.tsbuildinfo` 的既有规则。
- [ ] 运行 `node --test tests/source-artifacts.test.js`，在检查器尚未导出新 API 时记录预期失败，再进入实现任务。

## Task 3: 扩展边界检查器并保持 CLI 行为

**Files:** `scripts/check-source-artifacts.js`

- [ ] 保留现有对 `web/src` 中生成的 `.js`、`.js.map` 和 `web/tsconfig.tsbuildinfo` 的检查。
- [ ] 增加根目录禁止项：`android`、`harmony`、`_h3`、`_h4`、`_h5`、`archives`、`audit-ui`；只检查这些目录是否存在，不扫描归档目录。
- [ ] 实现并导出 `findForbidden(root)`；对缺失的 `web/src` 或 `web/tsconfig.tsbuildinfo` 安全处理，CLI 继续输出清晰错误并以退出码 1 失败、无违规时退出码 0。
- [ ] 运行 `node --test tests/source-artifacts.test.js` 与 `npm run check:artifacts`，确认新增测试和现有检查均通过。

## Task 4: 更新项目说明和忽略规则

**Files:** `README.md`, `.dockerignore`, `.gitignore`

- [ ] 在 README 中明确项目仅包含 Node/Web，更新目录树、启动方式和验证命令；移除对已剥离 Android/HarmonyOS 源码的操作说明。
- [ ] 精简 `.dockerignore` 中已不存在的专属目录条目，同时保留依赖、数据、备份、日志和构建残留的通用忽略规则。
- [ ] 精简 `.gitignore` 中 HarmonyOS 专用规则，保留通用移动端构建残留、`_h*`、日志与依赖缓存规则，防止目录回流。
- [ ] 使用 `rg` 检查 README、忽略文件和脚本中没有指向已移动目录的失效路径（边界检查规则本身除外）。

## Task 5: 完整验证与运行态回归

**Files:** 无新增文件；读取归档清单、Docker 和 SQLite 状态

- [ ] 验证根目录不存在所有移动源项，归档中每个目标项存在，`MANIFEST.md` 可用于反向移动。
- [ ] 运行 `npm run check:artifacts` 和 `npm run check:compose`。
- [ ] 运行 `docker build --tag huidaiqujian-scope-check .`；构建必须在 `web-build` 阶段容器内安装依赖，不把 `node_modules` 写回项目。
- [ ] 运行 `npm run test:container`，确认 73 项测试全部通过。
- [ ] 检查正式 `huoqu` 容器为 `healthy`，请求 `GET http://127.0.0.1:3000/api/health` 返回 HTTP 200 且 `status: ok`。
- [ ] 在正式容器内只读执行 SQLite `PRAGMA integrity_check`，确认返回 `ok`；不修改 `data/` 或 `backups/`。
- [ ] 汇总移动清单、验证命令及结果；若任何验证失败，报告具体失败点，不宣称完成。

## Rollback

停止后续编辑，依据归档 `MANIFEST.md` 的逐项命令，将目标路径移回原路径；仅在确认原路径不存在时移动。归档目录保留到用户确认无误后再另行处理。

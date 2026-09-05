# Web 浏览器端到端巡检（e2e-web / journeys）

在真实 Chromium 中登录、种数据、渲染图表并逐页巡检，捕捉三类构建后才会暴露的问题：

- element-plus 按需引入导致的组件解析失败 / 样式缺失（主按钮实色、主题变量、message/message-box/overlay 样式）
- echarts 懒加载后看板图表是否真实画出 canvas
- 各路由页的控制台错误、未捕获异常、失败请求

## 覆盖范围

- 登录 `admin`（自动拉起隔离服务时密码为 `e2e-strong-password`，独立临时 DB，不碰生产数据）
- 种 1 个任务 + 1 个客户，进入 `/dashboard` 切到“图表”模式断言 `canvas>0`
- 样式事实断言：`--el-color-primary` = `#3370ff`、`.el-button--primary` 实色背景、`.el-card` 圆角、message/message-box/overlay CSS 存在
- 巡检页面：`/customers /dispatch /tasks /match-center /areas /employees /logs /notifications /notification-settings /push-providers /tasks/:id`
- 截图输出（默认系统临时目录，可用 `E2E_SCREENSHOT_DIR` 覆盖）：`dashboard-chart.png`、`dashboard-table.png`

## 业务旅程巡检（e2e/journeys.e2e.js）

`npm run test:e2e:journeys` 按真实岗位操作顺序跑完整业务闭环：
客服登录 → UI 派单 → 取件员移动端开始取件 → 拍照上传 → 完成取件 →
客服收到站内通知并一键已读 → 过机设备上报重量 → 匹配中心补票号自动带出最终重量 →
越级路由守卫（取件员/客服/匿名）→ 错误密码体验 → 消息设置页渲染。
两种巡检脚本可在同一条 CI 命令序列中依次执行（见下方 workflow）。

## 本机运行

前置：服务端依赖 `npm ci`；一个可用的 Playwright 模块与 Chromium 浏览器。

```bash
# 1) playwright 已装为本项目/全局依赖，且浏览器已安装（npx playwright install chromium）时：
npm run test:e2e:web
# 或全量业务旅程
npm run test:e2e:journeys

# 2) 或通过 PLAYWRIGHT_MODULE 指向 npx 缓存里的模块：
PLAYWRIGHT_MODULE=/home/<user>/.npm/_npx/<hash>/node_modules/playwright \
  PLAYWRIGHT_BROWSERS_PATH=/home/<user>/.cache/ms-playwright \
  npm run test:e2e:web
```

脚本默认自己拉起隔离服务（临时 DB + 随机端口），结束后自动回收；也可对接已运行的服务：

```bash
BASE_URL=http://127.0.0.1:3999 npm run test:e2e:web   # 该服务需已有 admin/e2e-strong-password
```

## Docker 运行（与宿主机 Playwright 缓存复用）

`better-sqlite3` 是原生模块：宿主 `node_modules` 不能直接在容器里加载，
所以服务端也用 Docker 起（`huoqu` 镜像内的原生依赖与容器 glibc 匹配）。

```bash
# 1) 浏览器运行器（Chromium + 系统库）
docker build -t hq-e2e-img -f e2e/Dockerfile.e2e .

# 2) 被测服务（复用生产镜像，隔离端口/临时库，不碰正式数据）
#    注意：journeys 旅程含“过机设备上报重量→匹配中心”环节，服务端必须配置 MACHINE_API_KEY，
#    且与 e2e/journeys.e2e.js 内固定值一致（e2e-machine-key），否则该环节会 503。
docker run -d --name hq-e2e-server --network host \
  -e PORT=3999 -e DB_PATH=/tmp/hq-e2e.db \
  -e INITIAL_ADMIN_PASSWORD=e2e-strong-password -e DISABLE_PUSH=1 \
  -e MACHINE_API_KEY=e2e-machine-key \
  huoqu node server.js

# 3) 巡检（BASE_URL 指向上面已起的服务）
docker run --rm --network host \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e PLAYWRIGHT_MODULE=/pw/node_modules/playwright \
  -e BASE_URL=http://127.0.0.1:3999 \
  -e E2E_SCREENSHOT_DIR=/tmp/hq-e2e-shots \
  -v /home/<user>/.cache/ms-playwright:/ms-playwright \
  -v /home/<user>/.npm/_npx/<hash>/node_modules:/pw/node_modules \
  -v "$PWD/e2e":/e2e -w /e2e \
  -v /tmp:/tmp \
  hq-e2e-img node e2e/web.e2e.js

# 收尾
docker rm -f hq-e2e-server
```

> `--network host` 是必须的：浏览器容器要访问同一网络命名空间里的被测服务端口。
> 自启动模式（不带 `BASE_URL`）只能在宿主机或原生依赖匹配的容器内使用，否则
> `better-sqlite3` 会报 `ERR_DLOPEN_FAILED`。
> Playwright 版本需与浏览器缓存（`chromium-*` 目录）匹配，版本漂移时重新 `npx playwright install chromium` 或换 npx 缓存即可。

## CI

GitHub Actions 中 `web-e2e` job 使用 `mcr.microsoft.com/playwright:v1.49.1-jammy`
官方镜像（自带 Chromium 与系统库），失败/成功都会上传 `e2e-screenshots` 构件便于核对截图。

## 退出码

- `0`：全部通过，末尾输出 `e2e-web=ok`
- `1`：发现问题（清单打印在 `PROBLEMS:` 后）
- `2`：运行器自身故障（浏览器启动失败、服务未就绪等）

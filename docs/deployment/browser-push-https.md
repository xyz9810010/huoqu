# 浏览器系统通知 HTTPS 部署

浏览器 Web Push、Service Worker 和通知权限在生产环境中都要求安全上下文。除浏览器特别认可的本机地址外，必须使用受信任的 HTTPS 访问系统；直接打开 `http://NAS-IP:3000` 只能使用站内通知和 SSE，不能开启浏览器系统通知。

## 方案一：Compose 自带 Caddy

适合已有公网域名且域名已经解析到部署主机的环境。先在 `.env` 中设置：

```dotenv
CARGO_HTTPS_DOMAIN=pickup.example.com
PUSH_CONFIG_MASTER_KEY=<使用 npm run push:key 生成的密钥>
```

启动：

```bash
docker compose -f docker-compose.yml -f compose.https.yaml up -d --build --wait
```

Caddy 会自动申请和续期证书，并将 HTTPS 请求反向代理到应用容器。`flush_interval -1` 确保 SSE 事件立即刷新而不被缓冲。80/443 端口可用 `CARGO_HTTPS_HTTP_PORT`、`CARGO_HTTPS_PORT` 覆盖。

## 方案二：使用 NAS 自带反向代理

在群晖、威联通或已有网关中把 `https://你的域名` 转发到 `http://127.0.0.1:3000`，并满足以下条件：

- 使用浏览器信任的证书；局域网自签证书必须导入每台终端的系统信任库。
- 转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto: https` 和客户端地址头。
- 关闭 SSE 路径 `/api/v1/events` 的响应缓冲，读取超时建议至少 1 小时。
- 不需要开启 WebSocket；实时消息使用 SSE。
- 页面、API、Service Worker 必须保持同源，避免额外的 CORS 和权限问题。

## 首次配置

1. 运行 `npm run push:key`，把输出写入部署环境的 `PUSH_CONFIG_MASTER_KEY`，不要提交到源码。
2. 登录管理员后台的“消息推送”。
3. 为“浏览器 Web Push”填写 VAPID 联系地址、公钥和私钥，依次执行“保存配置”“连接测试”“启用”。VAPID 密钥可由常用 Web Push 工具生成，联系地址推荐 `mailto:管理员邮箱`。
4. 用户进入“通知中心 → 消息设置”，点击“开启系统通知”。权限请求只会由这次明确点击触发。
5. 在浏览器控制台确认 `window.isSecureContext === true`，并用页面中的“发送测试通知”验证后台消息。

## 验证与排障

```bash
PUSH_SMOKE_BASE_URL=https://pickup.example.com \
PUSH_SMOKE_USERNAME=<管理员用户名> \
PUSH_SMOKE_PASSWORD=<管理员密码> \
PUSH_SMOKE_REQUIRE_PROVIDER=1 \
npm run smoke:browser-push
```

脚本不会输出登录令牌。若页面显示“当前地址不是 HTTPS”，优先检查证书是否受信任、是否被浏览器以 IP 地址打开，以及反向代理是否混入了 HTTP 资源。用户曾拒绝通知时，需要在浏览器的网站权限中重新允许。

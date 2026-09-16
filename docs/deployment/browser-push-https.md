# 浏览器系统通知 / 摄像头 HTTPS 部署

浏览器的 **Web Push、Service Worker、通知权限**，以及**摄像头（`getUserMedia`）**，
都要求安全上下文。除浏览器特别认可的本机地址（localhost）外，必须使用受信任的 HTTPS 访问；
直接打开 `http://NAS-IP:3000` 时 `navigator.mediaDevices` **根本不存在** —— 页内实时扫码
（对准自动识别）不可能工作，只能退化为"调起系统相机拍照识别"。

> 实测：`http://192.168.5.83:3000` 下 `isSecureContext === false`、`navigator.mediaDevices === undefined`；
> 同一应用经 `https://<域名>` 访问则为 `isSecureContext === true`，摄像头可用。

## 方案一：已有公网域名（推荐）

用真实域名 + 受信任证书，**用户端没有任何证书警告**。先在 `.env` 中设置：

```dotenv
CARGO_HTTPS_SITE=pickup.example.com
CARGO_HTTPS_PORT=443
# 留空 = Caddy 自动申请 Let's Encrypt 证书
CARGO_TLS=
PUSH_CONFIG_MASTER_KEY=<使用 npm run push:key 生成的密钥>
```

启动：

```bash
docker compose -f docker-compose.yml -f compose.https.yaml up -d --build --wait
```

Caddy 会自动申请和续期证书，并将 HTTPS 请求反向代理到应用容器。
`flush_interval -1` 确保 SSE 事件立即刷新而不被缓冲。

## 方案二：只有内网、且拿不到 ACME 证书

若服务器**访问不到** `acme-v02.api.letsencrypt.org` / `acme.zerossl.com`
（实测某些网络环境如此），或 80/443 已被其它服务占用，则用**自签证书 + 非标准端口**：

```bash
# 1) 生成自签证书（默认 10 年，落在 secrets/tls/，该目录已在 .gitignore 中）
bash scripts/gen-self-signed-cert.sh 192.168.5.83 3650

# 2) 启动反代
export CARGO_HTTPS_SITE='https://:3443'
export CARGO_TLS='tls /tls/cert.pem /tls/key.pem'
export CARGO_HTTPS_PORT=3443
docker compose -f docker-compose.yml -f compose.https.yaml up -d huoqu-proxy
```

代价：自签证书不被设备信任，**每台终端首次访问需手动点一次"继续访问"**
（安卓 Chrome：高级 → 继续前往；iOS Safari：显示详细信息 → 访问此网站）。
若希望没有提示，需要把证书/CA 导入每台终端的系统信任库。

### ⚠ 用 IP 访问时，站点地址不能带主机名

必须写 `https://:3443`，**不要**写 `https://192.168.5.83:3443`。

原因：按 RFC 6066，SNI 只能是主机名，**浏览器对 IP 字面量地址不发送 SNI**。
若站点块限定了主机名，Caddy 在收到"无 SNI"的握手时选不出证书，
直接回 `TLS alert internal error`，浏览器侧表现为 `ERR_SSL_PROTOCOL_ERROR`。
实测对照：`SNI=192.168.5.83` 成功（Node/curl 会发送），`SNI=未发送` 失败（浏览器走这条）。

## 方案三：使用 NAS 自带反向代理

在群晖、威联通或已有网关中把 `https://你的域名` 转发到 `http://127.0.0.1:3000`，并满足以下条件：

- 使用浏览器信任的证书；局域网自签证书必须导入每台终端的系统信任库。
- 转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto: https` 和客户端地址头。
- 关闭 SSE 路径 `/api/v1/events` 的响应缓冲，读取超时建议至少 1 小时。
- 不需要开启 WebSocket；实时消息使用 SSE。
- 页面、API、Service Worker 必须保持同源，避免额外的 CORS 和权限问题。

验证代理没破坏实时通道（首字节应在毫秒级返回，而不是等超时）：

```bash
DOMAIN_BASE=https://qj.example.com PROD_PASS=<管理员密码> node .ui-review/verify-domain-sse.mjs
```


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

脚本不会输出登录令牌。若页面显示"当前地址不是 HTTPS"，优先检查证书是否受信任、是否被浏览器以 IP 地址打开，以及反向代理是否混入了 HTTP 资源。用户曾拒绝通知时，需要在浏览器的网站权限中重新允许。

## 当前生产入口

| 入口 | 证书 | 摄像头（实时扫码） | 用途 |
| --- | --- | --- | --- |
| `https://qj.9810010.xyz:1666` | Let's Encrypt（受信任） | ✅ 可用 | **推荐**，手机端用这个 |
| `https://192.168.5.83:3443` | 自签（需点一次继续） | ✅ 可用 | 内网备用，公网通道不可用时仍可用 |
| `http://192.168.5.83:3000` | 无 | ❌ 不可用（只提供拍照扫码） | 内网旧入口，保留兼容 |

如不需要内网备用入口，可移除自签反代（不影响主入口）：

```bash
cd /path/to/huidaiqujian
CARGO_HTTPS_SITE='https://:3443' CARGO_TLS='tls /tls/cert.pem /tls/key.pem' CARGO_HTTPS_PORT=3443 \
  docker compose -f docker-compose.yml -f compose.https.yaml rm -sf huoqu-proxy
```


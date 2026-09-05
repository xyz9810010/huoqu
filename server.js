// Huoqu · 货代取件运营平台 - 后端服务（成熟版：登录鉴权 / 角色权限 / 趋势分析 / Excel导入导出）
const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const auth = require('./auth');
const { createRequestLogger } = require('./server/http/request-logger');
const { createSseTicketStore } = require('./server/modules/notifications/sse-tickets');
const { createNotificationRepository } = require('./server/modules/notifications/repository');
const { createNotificationService } = require('./server/modules/notifications/service');
const { createSecretBox } = require('./server/modules/notifications/secret-box');
const { createSubscriptionStore } = require('./server/modules/notifications/subscriptions');
const { createPreferenceStore } = require('./server/modules/notifications/preferences');
const { createProviderConfigStore } = require('./server/modules/notifications/provider-configs');
const { createProviderRegistry } = require('./server/modules/notifications/provider-registry');
const { createDispatcher } = require('./server/modules/notifications/dispatcher');
const { createNotificationRetention } = require('./server/modules/notifications/retention');
const { createHuaweiProvider } = require('./server/modules/notifications/providers/huawei');
const { createWebPushProvider } = require('./server/modules/notifications/providers/web-push');
const { mountApiRoutes } = require('./server/http/api');
const { mountApiV2Routes } = require('./server/http/api-v2');
const { createBusinessNotificationPublisher } = require('./server/modules/notifications/business-publisher');
const { createTaskModule } = require('./server/domain/tasks');
const sseTickets = createSseTicketStore(db);

const app = express();
app.use(express.json({ limit: '20mb' }));

// 请求日志统一隐藏会话票据、访问令牌和 API 密钥。
app.use(createRequestLogger());

// 基础安全响应头：防 MIME 嗅探、防点击劫持、不向外部页面泄漏来源地址。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const PORT = process.env.PORT || 3000;
// 图片上传目录（数据卷内）；上传处理集中在 server/http/api.js
const uploadsDir = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// ---------- 实时推送（SSE，无感接收） ----------
const sseClients = new Set();
function broadcast(event) {
  const msg = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const c of sseClients) { try { c.res.write(msg); } catch (e) {} }
}
function broadcastToUser(userId, event) {
  const msg = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const c of sseClients) {
    if (c.userId !== userId) continue;
    try { c.res.write(msg); } catch (e) {}
  }
}
const notificationRepository = createNotificationRepository(db);
const notificationService = createNotificationService({
  repository: notificationRepository,
  realtime: { publishToUser: broadcastToUser }
});
const businessNotificationPublisher = createBusinessNotificationPublisher(db, notificationService);
const tasks = createTaskModule(db, { publisher: businessNotificationPublisher });
const pushSecretBox = createSecretBox(process.env.PUSH_CONFIG_MASTER_KEY || '');
const subscriptionStore = createSubscriptionStore(db, pushSecretBox);
const preferenceStore = createPreferenceStore(db);
const providerConfigStore = createProviderConfigStore(db, pushSecretBox);
const providerRegistry = createProviderRegistry([
  createWebPushProvider(),
  createHuaweiProvider()
]);
const notificationDispatcher = createDispatcher({
  db,
  registry: providerRegistry,
  providerConfigs: providerConfigStore,
  subscriptions: subscriptionStore
});
// 通知/投递/失效订阅保留策略（默认 180/90/30 天，可环境变量覆盖，见 retention.js）
const notificationRetention = createNotificationRetention(db);
if (pushSecretBox.available) subscriptionStore.migrateLegacyTokens();
const MACHINE_API_KEY = process.env.MACHINE_API_KEY || '';

// 统一注册全部 API 路由（server/http/api.js）
mountApiRoutes(app, {
  db,
  auth,
  tasks,
  businessNotificationPublisher,
  notificationService,
  notificationRepository,
  subscriptionStore,
  preferenceStore,
  providerConfigStore,
  providerRegistry,
  sseTickets,
  sseClients,
  broadcast,
  uploadsDir,
  machineApiKey: MACHINE_API_KEY
});

// 面向 Android / HarmonyOS 新客户端的统一 v2 API（server/http/api-v2.js）
mountApiV2Routes(app, {
  db,
  auth,
  tasks,
  notificationService,
  notificationRepository,
  subscriptionStore,
  preferenceStore,
  providerRegistry,
  broadcast,
  uploadsDir
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// 静态资源
app.use('/uploads', express.static(uploadsDir));
const webDist = path.join(__dirname, 'web', 'dist');
const legacyPublic = path.join(__dirname, 'public');
const webRoot = fs.existsSync(path.join(webDist, 'index.html')) ? webDist : legacyPublic;
app.use(express.static(webRoot));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  const indexFile = path.join(webRoot, 'index.html');
  if (!fs.existsSync(indexFile)) return next();
  res.sendFile(indexFile);
});

// 统一错误处理（如 multer 文件类型错误）
app.use((err, req, res, next) => {
  const msg = (err && err.code === 'LIMIT_FILE_SIZE')
    ? '图片过大，请重新拍摄或压缩后再上传'
    : ((err && err.message) || '请求处理失败');
  res.status(400).json({ error: msg });
});

// 启动
auth.pruneSessions();
// 运行期定期清理过期会话（启动清理之外的长尾防护，轻量无阻塞）。
setInterval(() => { try { auth.pruneSessions(); } catch (e) {} }, 6 * 3600 * 1000).unref();
notificationRetention.start();
const adminBootstrap = auth.ensureAdmin();
const httpServer = app.listen(PORT, () => {
  if (process.env.DISABLE_PUSH !== '1') notificationDispatcher.start();
  console.log('Huoqu · 货代取件运营平台已启动（成熟版）');
  console.log('数据库：' + (process.env.DB_PATH || path.join(__dirname, 'data', 'app.db')));
  console.log('访问地址：http://localhost:' + PORT);
  if (adminBootstrap.created) console.log('请使用 INITIAL_ADMIN_PASSWORD 登录并立即设置长期密码');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  notificationRetention.stop();
  await notificationDispatcher.stop();
  httpServer.close(() => {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

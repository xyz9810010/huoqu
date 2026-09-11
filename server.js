// Huoqu · 货代取件运营平台 - 后端服务（成熟版：登录鉴权 / 角色权限 / 趋势分析 / Excel导入导出）
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');

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
const { createAuditLogger } = require('./server/operations/audit');
const { bjText } = require('./server/time');
const sseTickets = createSseTicketStore(db);
const auditLog = createAuditLogger(db, () => bjText());

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
// 解析推送主密钥：文件 → 环境变量 → 未配置则自动生成并持久化到数据目录（与数据库同卷，随库持久化）
function resolvePushMasterKey() {
  const file = process.env.PUSH_CONFIG_MASTER_KEY_FILE;
  if (file) {
    try { const v = fs.readFileSync(file, 'utf8').trim(); if (v) return v; } catch (e) { console.error('[secret] PUSH_CONFIG_MASTER_KEY_FILE 读取失败: ' + e.message); }
  }
  if (process.env.PUSH_CONFIG_MASTER_KEY) return process.env.PUSH_CONFIG_MASTER_KEY;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const keyPath = path.join(dataDir, 'push-master.key');
  try {
    if (fs.existsSync(keyPath)) {
      const v = fs.readFileSync(keyPath, 'utf8').trim();
      if (v) return v;
    }
    const key = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    console.log('[secret] 已自动生成推送主密钥并持久化到 ' + keyPath);
    return key;
  } catch (e) {
    console.error('[secret] 推送主密钥自动生成/读取失败：' + (e && e.message ? e.message : e));
    return '';
  }
}
const pushSecretBox = createSecretBox(resolvePushMasterKey());
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

// 初次部署自动生成浏览器 Web Push VAPID 密钥（免手动配置，幂等）
async function autoProvisionWebPush() {
  if (!pushSecretBox.available) return;
  try {
    if (providerConfigStore.getDecrypted('web_push')) return;
    const adapter = providerRegistry.get('web_push');
    if (!adapter) return;
    const { generateVAPIDKeys } = require('web-push');
    const keys = generateVAPIDKeys();
    providerConfigStore.save('web_push', {
      vapidSubject: process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:notifications@localhost',
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
    }, adapter.credentialSchema);
    const validation = await adapter.validateConfig(providerConfigStore.getDecrypted('web_push'));
    providerConfigStore.recordHealth('web_push', validation);
    if (validation.ok) {
      providerConfigStore.setEnabled('web_push', true);
      console.log('[push] 已自动生成并启用浏览器 Web Push');
    } else {
      console.warn('[push] 浏览器 Web Push 自动配置未通过校验：', validation.code || validation.message || '');
    }
  } catch (e) {
    console.error('[push] Web Push 自动配置失败：', e && e.message ? e.message : e);
  }
}
autoProvisionWebPush();

// 初次部署从环境变量配置华为 Push Kit（HUAWEI_PUSH_PROJECT_ID + HUAWEI_PUSH_SERVICE_ACCOUNT[_FILE]），幂等
async function autoProvisionHuawei() {
  if (!pushSecretBox.available) return;
  try {
    if (providerConfigStore.getDecrypted('huawei')) return;
    const adapter = providerRegistry.get('huawei');
    if (!adapter) return;
    const projectId = String(process.env.HUAWEI_PUSH_PROJECT_ID || '').trim();
    let serviceAccount = String(process.env.HUAWEI_PUSH_SERVICE_ACCOUNT || '').trim();
    const saFile = process.env.HUAWEI_PUSH_SERVICE_ACCOUNT_FILE;
    if (saFile) {
      try { const v = fs.readFileSync(saFile, 'utf8').trim(); if (v) serviceAccount = v; } catch (e) { console.error('[push] HUAWEI_PUSH_SERVICE_ACCOUNT_FILE 读取失败: ' + e.message); }
    }
    if (!projectId || !serviceAccount) return; // 未配置环境变量，跳过（可继续在页面手动配置）
    providerConfigStore.save('huawei', { projectId: projectId, serviceAccount: serviceAccount }, adapter.credentialSchema);
    const validation = await adapter.validateConfig(providerConfigStore.getDecrypted('huawei'));
    providerConfigStore.recordHealth('huawei', validation);
    if (validation.ok) {
      providerConfigStore.setEnabled('huawei', true);
      console.log('[push] 已从环境变量配置并启用华为 Push Kit');
    } else {
      console.warn('[push] 华为 Push Kit 自动配置未通过校验：', validation.code || validation.message || '');
    }
  } catch (e) {
    console.error('[push] 华为 Push Kit 自动配置失败：', e && e.message ? e.message : e);
  }
}
autoProvisionHuawei();
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
  audit: auditLog,
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

// 统一错误处理（如 multer 文件类型错误）：细节只进服务端日志，
// 客户端只拿到友好文案，避免把数据库/内部实现细节随错误回传。
app.use((err, req, res, next) => {
  if (err) {
    if (err.type === 'entity.parse.failed') console.warn('[http] 请求体解析失败', req.method, req.originalUrl);
    else console.error('[http] 请求处理异常', req.method, req.originalUrl, err.message || err);
  }
  const msg = (err && err.code === 'LIMIT_FILE_SIZE')
    ? '图片过大，请重新拍摄或压缩后再上传'
    : '请求处理失败，请稍后重试';
  const status = (err && (err.status || err.statusCode)) || 400;
  res.status(status).json({ error: msg });
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

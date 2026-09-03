const defaultWebPush = require('web-push');

function safeRoute(value) {
  const route = String(value || '');
  return route.startsWith('/') && !route.startsWith('//') && !route.includes('://') ? route : '/notifications';
}

function createWebPushProvider(options = {}) {
  const webpush = options.webpush || defaultWebPush;

  function buildPayload(message) {
    const resourceId = String((message.data && message.data.resourceId) || '');
    return {
      notificationId: String(message.id),
      type: String(message.type),
      title: String(message.title || 'Huoqu'),
      body: String(message.body || '你有一条新消息'),
      route: safeRoute(message.data && message.data.route),
      tag: `${message.type}:${resourceId || message.id}`.slice(0, 64)
    };
  }

  async function validateConfig(config) {
    if (!config || !config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
      return { ok: false, code: 'WEB_PUSH_CONFIG_INCOMPLETE' };
    }
    try {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
      return { ok: true };
    } catch {
      return { ok: false, code: 'WEB_PUSH_VAPID_INVALID' };
    }
  }

  function normalizeError(error) {
    const statusCode = Number(error && (error.statusCode || error.status) || 0);
    if (statusCode === 404 || statusCode === 410) return { status: 'invalid_target', code: 'WEB_PUSH_ENDPOINT_GONE' };
    if (statusCode === 429 || statusCode >= 500 || !statusCode) {
      return { status: 'retryable', code: statusCode ? `WEB_PUSH_HTTP_${statusCode}` : 'WEB_PUSH_NETWORK_ERROR' };
    }
    return { status: 'failed', code: `WEB_PUSH_HTTP_${statusCode}` };
  }

  return {
    code: 'web_push',
    displayName: '浏览器 Web Push',
    platforms: ['web'],
    capabilities: { batch: false, background: true },
    credentialSchema: [
      { key: 'vapidSubject', label: 'VAPID 联系地址', secret: false, required: true, control: 'text' },
      { key: 'vapidPublicKey', label: 'VAPID 公钥', secret: false, required: true, control: 'textarea' },
      { key: 'vapidPrivateKey', label: 'VAPID 私钥', secret: true, required: true, control: 'password' }
    ],
    buildPayload,
    validateConfig,
    async healthCheck(config) {
      return validateConfig(config);
    },
    normalizeError,
    async send(message, targets, config) {
      const validation = await validateConfig(config);
      if (!validation.ok) return targets.map(target => ({ targetId: target.id, status: 'failed', code: validation.code }));
      const payload = JSON.stringify(buildPayload(message));
      if (Buffer.byteLength(payload, 'utf8') > 3_500) {
        return targets.map(target => ({ targetId: target.id, status: 'failed', code: 'WEB_PUSH_PAYLOAD_TOO_LARGE' }));
      }
      const defaultTtl = 24 * 60 * 60;
      const ttl = message.expiresAt
        ? Math.max(0, Math.min(defaultTtl, Math.floor((Date.parse(message.expiresAt) - Date.now()) / 1000)))
        : defaultTtl;
      const results = [];
      for (const target of targets) {
        try {
          const response = await webpush.sendNotification(target.secret, payload, {
            TTL: ttl,
            urgency: message.priority === 'high' ? 'high' : (message.priority === 'low' ? 'low' : 'normal'),
            topic: `${message.type}:${message.id}`.slice(0, 32)
          });
          const providerMessageId = response && response.headers && typeof response.headers.get === 'function'
            ? String(response.headers.get('location') || '') : '';
          results.push({ targetId: target.id, status: 'sent', providerMessageId });
        } catch (error) {
          const normalized = normalizeError(error);
          results.push({ targetId: target.id, status: normalized.status, code: normalized.code });
        }
      }
      return results;
    }
  };
}

module.exports = { createWebPushProvider, safeRoute };

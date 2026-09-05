const { randomUUID } = require('node:crypto');

function mountNotificationRoutes(app, dependencies) {
  const {
    requireAuth, requireAdmin, registry, subscriptions, preferences,
    providerConfigs, notificationService, db, audit = () => {}
  } = dependencies;

  function adapterOr404(req, res) {
    const adapter = registry.get(String(req.params.code || ''));
    if (!adapter) res.status(404).json({ error: '推送供应商未安装' });
    return adapter;
  }

  function validateWebSubscription(subscription) {
    const endpoint = String(subscription && subscription.endpoint || '');
    const p256dh = String(subscription && subscription.keys && subscription.keys.p256dh || '');
    const auth = String(subscription && subscription.keys && subscription.keys.auth || '');
    if (!endpoint.startsWith('https://') || endpoint.length > 2_048 || !p256dh || !auth) {
      throw new Error('浏览器推送订阅格式不正确');
    }
    if (p256dh.length > 4_096 || auth.length > 4_096) throw new Error('浏览器推送订阅密钥过长');
    return { endpoint, keys: { p256dh, auth } };
  }

  app.get('/api/v1/notification-subscriptions', requireAuth, (req, res) => {
    res.json({ data: subscriptions.listForUser(req.user.id) });
  });

  app.post('/api/v1/notification-subscriptions', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const channel = String(body.channel || '');
      const providerCode = channel === 'web_push' ? 'web_push' : String(body.providerCode || '');
      if (!registry.get(providerCode)) return res.status(400).json({ error: '推送供应商不可用' });
      let secret;
      if (channel === 'web_push') {
        secret = validateWebSubscription(body.subscription);
      } else if (channel === 'vendor_push') {
        const token = String(body.token || '').trim();
        if (!token || token.length > 8_192) return res.status(400).json({ error: '设备 token 不正确' });
        secret = { token };
      } else {
        return res.status(400).json({ error: '推送通道不正确' });
      }
      const item = subscriptions.register({
        userId: req.user.id,
        channel,
        providerCode,
        platform: String(body.platform || ''),
        deviceLabel: String(body.deviceLabel || '').slice(0, 100),
        appVersion: String(body.appVersion || '').slice(0, 50),
        role: req.user.role,
        courierId: req.user.courier_id || '',
        secret
      });
      res.status(201).json({ data: item });
    } catch (error) {
      const status = error && error.code === 'PUSH_MASTER_KEY_MISSING' ? 503 : 400;
      res.status(status).json({ error: error.message || '登记推送订阅失败', code: error.code || '' });
    }
  });

  app.delete('/api/v1/notification-subscriptions/:id', requireAuth, (req, res) => {
    const result = subscriptions.remove(req.user.id, req.params.id);
    if (!result.changes) return res.status(404).json({ error: '设备订阅不存在' });
    res.json({ data: { ok: true } });
  });

  app.post('/api/v1/notification-subscriptions/:id/test', requireAuth, (req, res) => {
    const target = subscriptions.getDecrypted(req.params.id);
    if (!target || target.userId !== req.user.id) return res.status(404).json({ error: '设备订阅不存在' });
    const notification = notificationService.publish({
      recipientUserId: req.user.id,
      type: 'system.test',
      title: '推送测试',
      body: '消息推送配置正常',
      data: { route: '/notifications' },
      priority: 'normal',
      dedupeKey: `push-test:${req.user.id}:${randomUUID()}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    });
    res.status(202).json({ data: { notificationId: notification.id } });
  });

  app.get('/api/v1/notification-preferences', requireAuth, (req, res) => {
    res.json({ data: preferences.listForUser(req.user.id) });
  });

  app.put('/api/v1/notification-preferences', requireAuth, (req, res) => {
    const body = req.body || {};
    const type = String(body.type || '');
    const channel = String(body.channel || '');
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/i.test(type)) return res.status(400).json({ error: '通知类型不正确' });
    if (!['in_app', 'web_push', 'vendor_push'].includes(channel)) return res.status(400).json({ error: '通知通道不正确' });
    preferences.set(req.user.id, type, channel, body.enabled !== false, {
      start: body.quietStart,
      end: body.quietEnd
    });
    res.json({ data: preferences.listForUser(req.user.id) });
  });

  app.get('/api/v1/notification-providers/web-push/public-key', requireAuth, (req, res) => {
    const active = providerConfigs.getActive('web_push');
    if (!active) return res.status(503).json({ error: '浏览器系统通知尚未配置' });
    res.json({ data: { publicKey: active.credentials.vapidPublicKey } });
  });

  app.get('/api/v1/admin/push-providers', requireAuth, requireAdmin, (req, res) => {
    const data = registry.list().map(provider => ({
      ...provider,
      ...providerConfigs.publicView(provider.code, provider.credentialSchema)
    }));
    res.json({ data });
  });

  app.put('/api/v1/admin/push-providers/:code', requireAuth, requireAdmin, async (req, res) => {
    const adapter = adapterOr404(req, res);
    if (!adapter) return;
    try {
      const credentials = (req.body && req.body.credentials) || {};
      providerConfigs.save(adapter.code, credentials, adapter.credentialSchema);
      const allowedKeys = new Set(adapter.credentialSchema.map(field => field.key));
      const changedKeys = Object.keys(credentials).filter(key => allowedKeys.has(key)).sort();
      audit(req.user, '保存推送供应商配置', 'push_provider', adapter.code, `字段：${changedKeys.join(',')}`);
      const validation = await adapter.validateConfig(providerConfigs.getDecrypted(adapter.code));
      if (!validation.ok) {
        providerConfigs.recordHealth(adapter.code, validation);
        return res.status(400).json({
          error: validation.message || '供应商配置校验失败',
          code: validation.code || 'PROVIDER_CONFIG_INVALID'
        });
      }
      res.json({ data: providerConfigs.publicView(adapter.code, adapter.credentialSchema) });
    } catch (error) {
      const status = error && error.code === 'PUSH_MASTER_KEY_MISSING' ? 503 : 400;
      res.status(status).json({ error: error.message || '保存供应商配置失败', code: error.code || '' });
    }
  });

  app.post('/api/v1/admin/push-providers/:code/test', requireAuth, requireAdmin, async (req, res) => {
    const adapter = adapterOr404(req, res);
    if (!adapter) return;
    try {
      const config = providerConfigs.getDecrypted(adapter.code);
      if (!config) return res.status(400).json({ error: '供应商尚未配置' });
      const result = await adapter.healthCheck(config);
      providerConfigs.recordHealth(adapter.code, result);
      audit(req.user, '测试推送供应商配置', 'push_provider', adapter.code, `结果：${result.ok ? 'healthy' : (result.code || 'unhealthy')}`);
      const view = providerConfigs.publicView(adapter.code, adapter.credentialSchema);
      if (!result.ok) {
        return res.status(400).json({
          error: result.message || '供应商连接测试失败',
          code: result.code || '',
          data: view
        });
      }
      res.json({ data: view });
    } catch (error) {
      res.status(400).json({ error: '供应商连接测试失败', code: error.code || 'PROVIDER_TEST_FAILED' });
    }
  });

  app.post('/api/v1/admin/push-providers/:code/enable', requireAuth, requireAdmin, (req, res) => {
    const adapter = adapterOr404(req, res);
    if (!adapter) return;
    try {
      const enabled = Boolean(req.body && req.body.enabled);
      const result = providerConfigs.setEnabled(adapter.code, enabled);
      audit(req.user, enabled ? '启用推送供应商' : '停用推送供应商', 'push_provider', adapter.code);
      res.json({ data: result });
    } catch (error) {
      res.status(400).json({ error: error.message || '切换供应商状态失败' });
    }
  });

  app.get('/api/v1/admin/notification-deliveries', requireAuth, requireAdmin, (req, res) => {
    const status = String(req.query.status || 'failed');
    const rows = db.prepare(`SELECT id,notification_id AS notificationId,channel,provider_code AS providerCode,
      status,attempt_count AS attemptCount,last_error_code AS lastErrorCode,created_at AS createdAt
      FROM notification_deliveries WHERE status=? ORDER BY created_at DESC LIMIT 200`).all(status);
    res.json({ data: rows });
  });

  app.post('/api/v1/admin/notification-deliveries/:id/retry', requireAuth, requireAdmin, (req, res) => {
    const result = db.prepare(`UPDATE notification_deliveries SET status='pending',next_attempt_at=?,locked_at=''
      WHERE id=? AND status IN ('failed','expired')`).run(new Date().toISOString(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: '失败投递不存在' });
    res.json({ data: { ok: true } });
  });
}

module.exports = { mountNotificationRoutes };

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebPushProvider } = require('../server/modules/notifications/providers/web-push');

const CONFIG = {
  vapidSubject: 'mailto:ops@example.com',
  vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtKJEhT7E0iW3oR4xJiwZRWp7T7PcR6jI_bzqR5-UfD6Wpc6sl6Z1L-hh9JgW8cI0xw',
  vapidPrivateKey: 'zN_j3Q2r7V_km0n4Gm-HnCJlP5qL8uTnSv_wo7ZBq8Q'
};

test('Web Push payload exposes only safe routing metadata', () => {
  const provider = createWebPushProvider({ webpush: { setVapidDetails() {}, sendNotification: async () => {} } });
  const payload = provider.buildPayload({
    id: 'n1', type: 'pickupTask.assigned', title: '新任务', body: '请及时处理',
    data: { resourceId: 'task-1', route: '/tasks/task-1', phone: '13800000000', address: '敏感地址' }
  });
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'notificationId', 'route', 'tag', 'title', 'type']);
  assert.equal(payload.route, '/tasks/task-1');
  assert.doesNotMatch(JSON.stringify(payload), /13800000000|敏感地址|phone|address/);
});

test('Web Push maps expired endpoints to invalid targets', async () => {
  const provider = createWebPushProvider({
    webpush: {
      setVapidDetails() {},
      async sendNotification() {
        const error = new Error('gone');
        error.statusCode = 410;
        throw error;
      }
    }
  });
  const results = await provider.send(
    { id: 'n1', type: 'system.test', title: '测试', body: '', data: {}, priority: 'normal' },
    [{ id: 's1', secret: { endpoint: 'https://push.example/1', keys: { p256dh: 'key', auth: 'auth' } } }],
    CONFIG
  );
  assert.deepEqual(results, [{ targetId: 's1', status: 'invalid_target', code: 'WEB_PUSH_ENDPOINT_GONE' }]);
});

test('Web Push sends a compact encrypted payload with TTL and topic', async () => {
  let captured = null;
  const provider = createWebPushProvider({
    webpush: {
      setVapidDetails(subject, publicKey, privateKey) {
        captured = { subject, publicKey, privateKey };
      },
      async sendNotification(subscription, payload, options) {
        captured = { ...captured, subscription, payload: JSON.parse(payload), options };
        return { statusCode: 201 };
      }
    }
  });
  const results = await provider.send(
    { id: 'n1', type: 'system.test', title: '测试', body: '正文', data: {}, priority: 'high' },
    [{ id: 's1', secret: { endpoint: 'https://push.example/1', keys: { p256dh: 'key', auth: 'auth' } } }],
    CONFIG
  );
  assert.equal(captured.subject, CONFIG.vapidSubject);
  assert.equal(captured.options.urgency, 'high');
  assert.equal(captured.options.topic, 'system.test:n1');
  assert.ok(captured.options.TTL > 0);
  assert.deepEqual(results, [{ targetId: 's1', status: 'sent', providerMessageId: '' }]);
});

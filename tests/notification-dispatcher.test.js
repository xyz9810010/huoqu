const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createSecretBox } = require('../server/modules/notifications/secret-box');
const { createSubscriptionStore } = require('../server/modules/notifications/subscriptions');
const { createProviderConfigStore } = require('../server/modules/notifications/provider-configs');
const { createProviderRegistry } = require('../server/modules/notifications/provider-registry');
const { createDispatcher } = require('../server/modules/notifications/dispatcher');

const KEY = Buffer.alloc(32, 8).toString('base64');

function fixture(send) {
  const db = new Database(':memory:');
  migrate(db);
  const secretBox = createSecretBox(KEY);
  let id = 0;
  const nowValue = '2026-09-02T10:00:00.000Z';
  const subscriptions = createSubscriptionStore(db, secretBox, { id: () => `sub-${++id}`, now: () => nowValue });
  const subscription = subscriptions.register({
    userId: 'u1', channel: 'vendor_push', providerCode: 'fake', platform: 'test',
    secret: { token: 'device-token' }
  });
  const configs = createProviderConfigStore(db, secretBox, { now: () => nowValue });
  const schema = [{ key: 'appId', required: true, secret: false }];
  configs.save('fake', { appId: 'app-1' }, schema);
  configs.recordHealth('fake', { ok: true });
  configs.setEnabled('fake', true);
  const registry = createProviderRegistry([{
    code: 'fake', displayName: 'Fake', platforms: ['test'], credentialSchema: schema,
    validateConfig: async () => ({ ok: true }), healthCheck: async () => ({ ok: true }),
    normalizeError: error => ({ status: 'retryable', code: error.code || 'TEMPORARY' }),
    send
  }]);
  db.prepare(`INSERT INTO notifications
    (id,user_id,notification_type,title,body,data,is_read,priority,dedupe_key,expires_at,read_at,created_at)
    VALUES ('n1','u1','system.test','测试','正文','{}',0,'normal','','','','2026-09-02T09:59:00.000Z')`).run();
  db.prepare(`INSERT INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,next_attempt_at,created_at)
    VALUES ('d1','n1',?,'vendor_push','fake','pending',?,?)`).run(subscription.id, nowValue, nowValue);
  const dispatcher = createDispatcher({
    db, registry, providerConfigs: configs, subscriptions,
    now: () => Date.parse(nowValue), random: () => 0.5
  });
  return { db, subscriptions, subscription, dispatcher };
}

test('dispatcher reschedules a temporary provider result with attempt metadata', async () => {
  const { db, dispatcher } = fixture(async (message, targets) => [{ targetId: targets[0].id, status: 'retryable', code: 'RATE_LIMITED' }]);
  assert.equal(await dispatcher.runOnce(), true);
  const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE id=?').get('d1');
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attempt_count, 1);
  assert.equal(delivery.last_error_code, 'RATE_LIMITED');
  assert.equal(delivery.next_attempt_at, '2026-09-02T10:00:30.000Z');
  db.close();
});

test('dispatcher invalidates a rejected device and permanently fails its delivery', async () => {
  const { db, subscriptions, subscription, dispatcher } = fixture(async (message, targets) => [
    { targetId: targets[0].id, status: 'invalid_target', code: 'TOKEN_INVALID' }
  ]);
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(db.prepare('SELECT status FROM notification_deliveries WHERE id=?').get('d1').status, 'failed');
  assert.equal(subscriptions.listForUser('u1')[0].status, 'invalid');
  assert.equal(subscriptions.getDecrypted(subscription.id).status, 'invalid');
  db.close();
});

test('dispatcher marks an expired notification without invoking its provider', async () => {
  const { db, dispatcher } = fixture(async () => { throw new Error('provider must not be called'); });
  db.prepare('UPDATE notifications SET expires_at=? WHERE id=?')
    .run('2026-09-02T09:59:59.000Z', 'n1');
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(db.prepare('SELECT status FROM notification_deliveries WHERE id=?').get('d1').status, 'expired');
  db.close();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createSecretBox } = require('../server/modules/notifications/secret-box');
const { createSubscriptionStore } = require('../server/modules/notifications/subscriptions');
const { createPreferenceStore } = require('../server/modules/notifications/preferences');
const { createProviderConfigStore } = require('../server/modules/notifications/provider-configs');

const KEY = Buffer.alloc(32, 7).toString('base64');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE push_tokens (
    token TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT DEFAULT '',courier_id TEXT DEFAULT '',created_at TEXT DEFAULT ''
  )`);
  migrate(db);
  const secretBox = createSecretBox(KEY);
  let id = 0;
  const subscriptions = createSubscriptionStore(db, secretBox, {
    id: () => `subscription-${++id}`,
    now: () => '2026-09-02T10:00:00.000Z'
  });
  return { db, secretBox, subscriptions };
}

test('secret box round-trips without exposing plaintext and rejects missing key writes', () => {
  const box = createSecretBox(KEY);
  const encrypted = box.seal({ appSecret: 'top-secret' });
  assert.doesNotMatch(encrypted, /top-secret/);
  assert.deepEqual(box.open(encrypted), { appSecret: 'top-secret' });

  const unavailable = createSecretBox('');
  assert.equal(unavailable.available, false);
  assert.throws(() => unavailable.seal({ value: 'x' }), error => error.code === 'PUSH_MASTER_KEY_MISSING');
});

test('subscription store encrypts Web Push data and enforces user ownership', () => {
  const { db, subscriptions } = fixture();
  const item = subscriptions.register({
    userId: 'u1', channel: 'web_push', providerCode: 'web_push', platform: 'web',
    deviceLabel: 'Chrome', secret: {
      endpoint: 'https://push.example/subscription-secret',
      keys: { p256dh: 'public-key', auth: 'auth-secret' }
    }
  });

  const stored = db.prepare('SELECT secret_encrypted FROM notification_subscriptions WHERE id=?').get(item.id);
  assert.doesNotMatch(stored.secret_encrypted, /subscription-secret|auth-secret/);
  assert.equal(JSON.stringify(subscriptions.listForUser('u1')).includes('subscription-secret'), false);
  assert.equal(subscriptions.remove('u2', item.id).changes, 0);
  assert.equal(subscriptions.remove('u1', item.id).changes, 1);
  db.close();
});

test('legacy Huawei tokens migrate once into encrypted unified subscriptions', () => {
  const { db, subscriptions } = fixture();
  db.prepare('INSERT INTO push_tokens VALUES (?,?,?,?,?)')
    .run('huawei-token-secret', 'u1', 'courier', 'courier-1', '2026-09-01 10:00:00');

  assert.equal(subscriptions.migrateLegacyTokens(), 1);
  assert.equal(subscriptions.migrateLegacyTokens(), 0);
  const rows = subscriptions.listForUser('u1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerCode, 'huawei');
  assert.deepEqual(subscriptions.getDecrypted(rows[0].id).secret, { token: 'huawei-token-secret' });
  assert.doesNotMatch(db.prepare('SELECT secret_encrypted FROM notification_subscriptions').get().secret_encrypted, /huawei-token-secret/);
  db.close();
});

test('provider cleanup removes only the current users matching subscriptions', () => {
  const { db, subscriptions } = fixture();
  subscriptions.register({ userId: 'u1', channel: 'vendor_push', providerCode: 'huawei', secret: { token: 'u1-huawei' } });
  subscriptions.register({ userId: 'u1', channel: 'web_push', providerCode: 'web_push', secret: { endpoint: 'https://push.example/u1-web' } });
  subscriptions.register({ userId: 'u2', channel: 'vendor_push', providerCode: 'huawei', secret: { token: 'u2-huawei' } });

  assert.equal(subscriptions.removeProviderForUser('u1', 'huawei').changes, 1);
  assert.deepEqual(subscriptions.listForUser('u1').map(item => item.providerCode), ['web_push']);
  assert.deepEqual(subscriptions.listForUser('u2').map(item => item.providerCode), ['huawei']);
  db.close();
});

test('provider config masks secrets and enables only the tested configuration version', () => {
  const { db, secretBox } = fixture();
  const configs = createProviderConfigStore(db, secretBox, { now: () => '2026-09-02T10:00:00.000Z' });
  const schema = [
    { key: 'projectId', secret: false, required: true },
    { key: 'appSecret', secret: true, required: true }
  ];

  configs.save('huawei', { projectId: 'project-1', appSecret: 'secret-1' }, schema);
  const view = configs.publicView('huawei', schema);
  assert.equal(view.fields.projectId.value, 'project-1');
  assert.deepEqual(view.fields.appSecret, { configured: true, masked: '••••••' });
  assert.throws(() => configs.setEnabled('huawei', true), /连接测试/);
  configs.recordHealth('huawei', { ok: true });
  assert.equal(configs.setEnabled('huawei', true).enabled, true);
  db.close();
});

test('notification preferences default enabled and persist channel overrides', () => {
  const { db } = fixture();
  const preferences = createPreferenceStore(db, { now: () => '2026-09-02T10:00:00.000Z' });
  assert.equal(preferences.isEnabled('u1', 'pickupTask.assigned', 'web_push'), true);
  preferences.set('u1', 'pickupTask.assigned', 'web_push', false);
  assert.equal(preferences.isEnabled('u1', 'pickupTask.assigned', 'web_push'), false);
  assert.equal(preferences.listForUser('u1')[0].enabled, false);
  db.close();
});

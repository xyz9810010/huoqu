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

test('vendor_push 每用户同供应商只保留最新设备：新登记自动作废旧登记', () => {
  const { db, subscriptions } = fixture();
  const oldDevice = subscriptions.register({
    userId: 'u1', channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
    deviceLabel: '旧手机', appVersion: '1.0.0', secret: { token: 'token-old' }
  });
  assert.equal(oldDevice.status, 'active');
  const newDevice = subscriptions.register({
    userId: 'u1', channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
    deviceLabel: '新手机', appVersion: '1.0.0', secret: { token: 'token-new' }
  });
  assert.equal(newDevice.status, 'active');
  const statusOf = id => db.prepare('SELECT status,invalidated_at FROM notification_subscriptions WHERE id=?').get(id);
  assert.equal(statusOf(oldDevice.id).status, 'invalid');
  assert.ok(statusOf(oldDevice.id).invalidated_at, '旧登记应记录作废时间');
  assert.equal(statusOf(newDevice.id).status, 'active');
  const activeHuawei = db.prepare(`SELECT COUNT(*) AS count FROM notification_subscriptions
    WHERE channel='vendor_push' AND provider_code='huawei' AND user_id='u1' AND status='active'`).get();
  assert.equal(activeHuawei.count, 1);
  db.close();
});

test('vendor_push 被取代设备的待发投递立即失败，不进入无谓重试', () => {
  const { db, subscriptions } = fixture();
  const oldDevice = subscriptions.register({
    userId: 'u1', channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
    deviceLabel: '旧手机', secret: { token: 'token-pending' }
  });
  db.prepare(`INSERT INTO notifications
    (id,user_id,notification_type,title,body,data,is_read,priority,dedupe_key,expires_at,read_at,created_at)
    VALUES ('n-supersede','u1','pickupTask.assigned','新任务','正文','{}',0,'normal','','','','2026-09-02T09:59:00.000Z')`).run();
  db.prepare(`INSERT INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,next_attempt_at,created_at)
    VALUES ('d-supersede','n-supersede',?,'vendor_push','huawei','pending','2026-09-02T10:00:00.000Z','2026-09-02T09:59:00.000Z')`).run(oldDevice.id);
  subscriptions.register({
    userId: 'u1', channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
    deviceLabel: '新手机', secret: { token: 'token-current' }
  });
  const delivery = db.prepare(`SELECT status,last_error_code FROM notification_deliveries WHERE id='d-supersede'`).get();
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.last_error_code, 'TARGET_SUPERSEDED');
  db.close();
});

test('migrate 启动去重：同用户同供应商仅保留最新 active 的 vendor_push 设备', () => {
  const { db, subscriptions } = fixture();
  const insert = db.prepare(`INSERT INTO notification_subscriptions
    (id,user_id,channel,provider_code,secret_encrypted,target_fingerprint,platform,device_label,app_version,role,courier_id,status,last_seen_at,invalidated_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('s-old', 'u1', 'vendor_push', 'huawei', 'enc', 'fp-old', 'harmonyos', '旧', '1.0.0', 'courier', 'c1', 'active', '', '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  insert.run('s-mid', 'u1', 'vendor_push', 'huawei', 'enc', 'fp-mid', 'harmonyos', '中', '1.0.0', 'courier', 'c1', 'active', '', '', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
  insert.run('s-new', 'u1', 'vendor_push', 'huawei', 'enc', 'fp-new', 'harmonyos', '新', '1.0.0', 'courier', 'c1', 'active', '', '', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
  insert.run('s-web', 'u1', 'web_push', 'web_push', 'enc', 'fp-web', 'web', 'Chrome', '', 'cs', '', 'active', '', '', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
  migrate(db);
  const activeVendor = db.prepare(`SELECT id FROM notification_subscriptions
    WHERE channel='vendor_push' AND status='active' ORDER BY id`).all();
  assert.deepEqual(activeVendor.map(row => row.id), ['s-new']);
  assert.equal(db.prepare(`SELECT status FROM notification_subscriptions WHERE id='s-web'`).get().status, 'active');
  assert.equal(db.prepare(`SELECT status FROM notification_subscriptions WHERE id='s-old'`).get().status, 'invalid');
  assert.equal(db.prepare(`SELECT status FROM notification_subscriptions WHERE id='s-mid'`).get().status, 'invalid');
  assert.ok(subscriptions.listForUser('u1').every(item => item.channel !== 'vendor_push' || item.status !== 'active' || item.id === 's-new'));
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

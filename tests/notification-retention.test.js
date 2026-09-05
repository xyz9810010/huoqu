// 通知/投递/失效订阅保留策略：只清“终态 + 超期”，未读通知与重试中投递不动。
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createNotificationRetention } = require('../server/modules/notifications/retention');

function seededDatabase() {
  const db = new Database(':memory:');
  migrate(db);
  const insertNotification = db.prepare(`INSERT INTO notifications
    (id,user_id,notification_type,title,body,data,is_read,priority,dedupe_key,expires_at,read_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertDelivery = db.prepare(`INSERT INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,attempt_count,next_attempt_at,provider_message_id,last_error_code,last_error_message,sent_at,delivered_at,locked_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertSubscription = db.prepare(`INSERT INTO notification_subscriptions
    (id,user_id,channel,provider_code,secret_encrypted,target_fingerprint,platform,device_label,app_version,role,courier_id,status,last_seen_at,invalidated_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const notification = (id, isRead, readAt, createdAt) => {
    insertNotification.run(id, 'u-1', 'pickupTask.statusChanged', '标题', '内容', '{}', isRead, 'normal', '', '', readAt, createdAt);
    return id;
  };
  const delivery = (id, notificationId, status, createdAt) => {
    insertDelivery.run(id, notificationId, 'sub-' + id, 'vendor_push', 'huawei', status, 0, '', '', '', '', '', '', '', createdAt);
    return id;
  };
  const subscription = (id, status, invalidatedAt, createdAt) => {
    insertSubscription.run(id, 'u-1', 'vendor_push', 'huawei', 'enc', id + '-fp', 'harmonyos', '设备', '1.0.0', 'courier', '', status, '', invalidatedAt, createdAt, createdAt);
    return id;
  };
  return { db, notification, delivery, subscription };
}

test('retention purges only terminal deliveries older than the keep window', () => {
  const { db, notification, delivery } = seededDatabase();
  const n = notification('n-old', 0, '', '2026-01-01T00:00:00.000Z');
  delivery('d-sent-old', n, 'sent', '2026-01-02T00:00:00.000Z');
  delivery('d-failed-old', n, 'failed', '2026-01-03T00:00:00.000Z');
  delivery('d-expired-old', n, 'expired', '2026-01-04T00:00:00.000Z');
  delivery('d-pending-old', n, 'pending', '2026-01-05T00:00:00.000Z');
  delivery('d-processing-old', n, 'processing', '2026-01-06T00:00:00.000Z');
  const recent = notification('n-recent', 0, '', '2026-08-01T00:00:00.000Z');
  delivery('d-sent-recent', recent, 'sent', '2026-08-02T00:00:00.000Z');

  const retention = createNotificationRetention(db, {
    notificationKeepDays: 180, deliveryKeepDays: 90, invalidSubscriptionKeepDays: 30,
    now: () => '2026-09-05T00:00:00.000Z'
  });
  const result = retention.run();

  assert.equal(result.deliveries, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get().n, 3);
  for (const id of ['d-pending-old', 'd-processing-old', 'd-sent-recent']) {
    assert.equal(db.prepare('SELECT 1 FROM notification_deliveries WHERE id=?').get(id) !== undefined, true, id);
  }
  for (const id of ['d-sent-old', 'd-failed-old', 'd-expired-old']) {
    assert.equal(db.prepare('SELECT 1 FROM notification_deliveries WHERE id=?').get(id), undefined, id);
  }
  db.close();
});

test('retention purges read notifications older than the keep window but never unread ones', () => {
  const { db, notification } = seededDatabase();
  const n1 = notification('n-read-old', 1, '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  notification('n-read-old-norow', 1, '', '2026-02-02T00:00:00.000Z');
  notification('n-unread-old', 0, '', '2026-01-03T00:00:00.000Z');
  notification('n-read-recent', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  // 级联：被清通知的投递一并删除
  notification('n-cascade', 1, '2026-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
  db.prepare(`INSERT INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,attempt_count,next_attempt_at,created_at)
    VALUES ('d-cascade','n-cascade','','in_app','in_app','sent',0,'','2026-01-04T00:00:00.000Z')`).run();

  const retention = createNotificationRetention(db, {
    notificationKeepDays: 180, deliveryKeepDays: 90, invalidSubscriptionKeepDays: 30,
    now: () => '2026-09-05T00:00:00.000Z'
  });
  const result = retention.run();

  assert.equal(result.notifications, 3);
  for (const id of ['n-read-old', 'n-read-old-norow', 'n-cascade']) {
    assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id), undefined, id);
  }
  for (const id of ['n-read-old', n1, 'n-read-old-norow', 'n-cascade']) {
    assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id), undefined, '已读超期应被清理: ' + id);
  }
  for (const id of ['n-unread-old', 'n-read-recent']) {
    assert.ok(db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id), id);
  }
  assert.equal(db.prepare('SELECT 1 FROM notification_deliveries WHERE id=?').get('d-cascade'), undefined);
  db.close();
});

test('retention purges invalid subscriptions after the keep window, keeps recent and active', () => {
  const { db, subscription } = seededDatabase();
  subscription('sub-invalid-old', 'invalid', '2026-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  subscription('sub-invalid-recent', 'invalid', '2026-08-20T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  subscription('sub-active-old', 'active', '', '2026-01-01T00:00:00.000Z');

  const retention = createNotificationRetention(db, {
    notificationKeepDays: 180, deliveryKeepDays: 90, invalidSubscriptionKeepDays: 30,
    now: () => '2026-09-05T00:00:00.000Z'
  });
  const result = retention.run();

  assert.equal(result.subscriptions, 1);
  assert.equal(db.prepare('SELECT 1 FROM notification_subscriptions WHERE id=?').get('sub-invalid-old'), undefined);
  for (const id of ['sub-invalid-recent', 'sub-active-old']) {
    assert.ok(db.prepare('SELECT 1 FROM notification_subscriptions WHERE id=?').get(id), id);
  }
  db.close();
});

test('retention start runs once immediately and stop clears the timer', () => {
  const { db, notification } = seededDatabase();
  notification('n-read-old', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const retention = createNotificationRetention(db, {
    notificationKeepDays: 0, deliveryKeepDays: 0, invalidSubscriptionKeepDays: 0,
    intervalMs: 3600_000, now: () => '2026-09-05T00:00:00.000Z'
  });
  assert.equal(retention.start(), true);
  assert.equal(retention.start(), false, '重复 start 不应叠加定时器');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'start 应立即执行一次清理');
  retention.stop();
  retention.stop();
  db.close();
});

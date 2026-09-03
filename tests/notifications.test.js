const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createNotificationRepository } = require('../server/modules/notifications/repository');
const { createNotificationService } = require('../server/modules/notifications/service');

function fixture() {
  const db = new Database(':memory:');
  migrate(db);
  const repository = createNotificationRepository(db, {
    id: (() => { let n = 0; return () => `notification-${++n}`; })(),
    now: () => '2026-09-02T10:00:00.000Z'
  });
  const realtimeEvents = [];
  const service = createNotificationService({
    repository,
    realtime: { publishToUser: (userId, event) => realtimeEvents.push({ userId, event }) }
  });
  return { db, repository, service, realtimeEvents };
}

test('canonical notification publish is idempotent and creates one in-app delivery', () => {
  const { db, service, realtimeEvents } = fixture();
  const input = {
    recipientUserId: 'u1',
    type: 'pickupTask.assigned',
    title: '新的取件任务',
    body: '请及时处理',
    data: { resourceType: 'pickupTask', resourceId: 'task-1', route: '/tasks/task-1' },
    priority: 'high',
    dedupeKey: 'task:task-1:assigned:u1'
  };

  const first = service.publish(input);
  const second = service.publish(input);

  assert.equal(second.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get().count, 1);
  assert.equal(realtimeEvents.length, 1);
  assert.deepEqual(realtimeEvents[0], {
    userId: 'u1',
    event: {
      version: 1,
      type: 'notification.created',
      data: {
        notification: {
          id: first.id,
          type: 'pickupTask.assigned',
          title: '新的取件任务',
          body: '请及时处理',
          data: { resourceType: 'pickupTask', resourceId: 'task-1', route: '/tasks/task-1' },
          priority: 'high',
          createdAt: '2026-09-02T10:00:00.000Z'
        }
      }
    }
  });
  db.close();
});

test('notification service rejects unsafe routes and unsupported priorities', () => {
  const { db, service } = fixture();
  const base = { recipientUserId: 'u1', type: 'pickupTask.assigned', title: '测试' };

  assert.throws(() => service.publish({ ...base, data: { route: 'https://evil.example' } }), /站内相对路径/);
  assert.throws(() => service.publish({ ...base, priority: 'critical' }), /通知优先级/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 0);
  db.close();
});

test('read operations enforce ownership and set a read timestamp', () => {
  const { db, service, repository } = fixture();
  const notification = service.publish({ recipientUserId: 'u1', type: 'system.test', title: '测试通知' });

  assert.equal(repository.markRead('u2', notification.id).changes, 0);
  assert.equal(repository.markRead('u1', notification.id).changes, 1);
  const row = repository.findById(notification.id);
  assert.equal(row.read, true);
  assert.equal(row.readAt, '2026-09-02T10:00:00.000Z');
  db.close();
});

test('notification listing supports unread filter and stable pagination', () => {
  const { db, service } = fixture();
  service.publish({ recipientUserId: 'u1', type: 'system.test', title: '第一条', dedupeKey: 'one' });
  const second = service.publish({ recipientUserId: 'u1', type: 'system.test', title: '第二条', dedupeKey: 'two' });
  service.markRead('u1', second.id);

  const unread = service.listForUser('u1', { unread: true, page: 1, pageSize: 10 });
  assert.equal(unread.total, 1);
  assert.equal(unread.items[0].title, '第一条');
  assert.equal(service.unreadCount('u1'), 1);
  db.close();
});

test('publishing fans out to active subscriptions while respecting channel preferences', () => {
  const { db, service } = fixture();
  const insertSubscription = db.prepare(`INSERT INTO notification_subscriptions
    (id,user_id,channel,provider_code,secret_encrypted,target_fingerprint,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`);
  insertSubscription.run('s-web', 'u1', 'web_push', 'web_push', 'encrypted', 'fp-web', '2026-09-02', '2026-09-02');
  insertSubscription.run('s-huawei', 'u1', 'vendor_push', 'huawei', 'encrypted', 'fp-huawei', '2026-09-02', '2026-09-02');
  db.prepare(`INSERT INTO notification_preferences
    (user_id,notification_type,channel,enabled,updated_at) VALUES (?,?,?,?,?)`)
    .run('u1', 'pickupTask.assigned', 'vendor_push', 0, '2026-09-02');

  const notification = service.publish({
    recipientUserId: 'u1', type: 'pickupTask.assigned', title: '新任务', dedupeKey: 'fanout-1'
  });
  const deliveries = db.prepare(`SELECT channel,provider_code,status FROM notification_deliveries
    WHERE notification_id=? ORDER BY channel`).all(notification.id);
  assert.deepEqual(deliveries, [
    { channel: 'in_app', provider_code: 'in_app', status: 'sent' },
    { channel: 'web_push', provider_code: 'web_push', status: 'pending' }
  ]);
  db.close();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createNotificationRepository } = require('../server/modules/notifications/repository');
const { createNotificationService } = require('../server/modules/notifications/service');
const { createBusinessNotificationPublisher } = require('../server/modules/notifications/business-publisher');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, courier_id TEXT, status TEXT NOT NULL DEFAULT 'active'
  )`);
  migrate(db);
  const notifications = createNotificationService({
    repository: createNotificationRepository(db), realtime: { publishToUser() {} }
  });
  return { db, publisher: createBusinessNotificationPublisher(db, notifications) };
}

test('legacy record assignment enters the same canonical notification outbox', () => {
  const { db, publisher } = fixture();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('worker-user', 'courier-1', 'active');

  publisher.recordAssigned({ id: 'record-1', courierId: 'courier-1', customer: '兼容客户' }, { name: '客服' }, 'record-create-1');

  const notification = db.prepare('SELECT * FROM notifications').get();
  assert.equal(notification.user_id, 'worker-user');
  assert.equal(notification.notification_type, 'pickupTask.assigned');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE status='sent'").get().count, 1);
  db.close();
});

test('legacy record status update notifies its dispatcher without provider-specific calls', () => {
  const { db, publisher } = fixture();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('dispatch-user', null, 'active');

  publisher.recordStatusChanged({
    id: 'record-2', customer: '状态客户', status: '已完成', dispatcherId: 'dispatch-user'
  }, { id: 'worker-user' }, 'record-status-1');

  const notification = db.prepare('SELECT * FROM notifications').get();
  assert.equal(notification.user_id, 'dispatch-user');
  assert.equal(notification.notification_type, 'pickupTask.statusChanged');
  assert.equal(JSON.parse(notification.data).status, '已完成');
  db.close();
});

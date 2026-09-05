const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const { createTaskModule } = require('../server/domain/tasks');
const { createNotificationRepository } = require('../server/modules/notifications/repository');
const { createNotificationService } = require('../server/modules/notifications/service');
const { createBusinessNotificationPublisher } = require('../server/modules/notifications/business-publisher');

function taskModule() {
  const db = new Database(':memory:');
  migrate(db);
  return { db, tasks: createTaskModule(db) };
}

function taskModuleWithNotifications() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, courier_id TEXT, status TEXT NOT NULL DEFAULT 'active'
  )`);
  migrate(db);
  const repository = createNotificationRepository(db);
  const notifications = createNotificationService({ repository, realtime: { publishToUser() {} } });
  const publisher = createBusinessNotificationPublisher(db, notifications);
  return { db, tasks: createTaskModule(db, { publisher }), repository };
}

test('createTask creates a pending task with multiple cargo items in one transaction', () => {
  const { db, tasks } = taskModule();

  const task = tasks.createTask({
    customerId: 'customer-1',
    customerName: '义乌星河贸易',
    address: '江东街道 88 号',
    taskType: 'rush',
    rushShipTime: '2026-09-02 15:00:00',
    defaultWorkerId: 'courier-1',
    items: [
      { waybillNo: 'WB-101', pieces: 2, goodsName: '服装' },
      { waybillNo: 'WB-102', pieces: 1, goodsName: '配件' }
    ]
  }, { id: 'user-cs', name: '客服张三' });

  assert.match(task.taskNo, /^QJ\d{8}-[A-F0-9]{6}$/);
  assert.equal(task.status, 'pending');
  assert.equal(task.items.length, 2);
  assert.equal(task.items[1].waybillNo, 'WB-102');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(task.id).count, 1);
  db.close();
});

test('transitionTask enforces the pending to in-progress to completed lifecycle', () => {
  const { db, tasks } = taskModule();
  const actor = { id: 'courier-user', name: '取件员王五' };
  const task = tasks.createTask({ customerName: '测试客户', address: '测试地址', items: [] }, actor);

  assert.throws(() => tasks.transitionTask(task.id, 'completed', actor), /必须先开始取件/);
  assert.equal(tasks.transitionTask(task.id, 'in_progress', actor).status, 'in_progress');
  assert.equal(tasks.transitionTask(task.id, 'completed', actor).status, 'completed');
  assert.throws(() => tasks.transitionTask(task.id, 'in_progress', actor), /不能从已完成变更为取件中/);
  db.close();
});

test('transitionTask allows cancellation before completion but never after completion', () => {
  const { db, tasks } = taskModule();
  const actor = { id: 'user-cs', name: '客服张三' };
  const pending = tasks.createTask({ customerName: '客户甲', address: '地址甲', items: [] }, actor);
  assert.equal(tasks.transitionTask(pending.id, 'cancelled', actor).status, 'cancelled');

  const completed = tasks.createTask({ customerName: '客户乙', address: '地址乙', items: [] }, actor);
  tasks.transitionTask(completed.id, 'in_progress', actor);
  tasks.transitionTask(completed.id, 'completed', actor);
  assert.throws(() => tasks.transitionTask(completed.id, 'cancelled', actor), /已完成任务不能取消/);
  db.close();
});

test('creating an assigned task publishes one canonical notification to the worker account', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('worker-user', 'courier-1', 'active');

  const task = tasks.createTask({
    customerName: '通知客户', address: '通知地址', defaultWorkerId: 'courier-1', items: []
  }, { id: 'staff-user', name: '客服' });

  const notification = db.prepare('SELECT * FROM notifications WHERE user_id=?').get('worker-user');
  assert.equal(notification.notification_type, 'pickupTask.assigned');
  assert.equal(JSON.parse(notification.data).resourceId, task.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
  db.close();
});

test('assignTask updates ownership and uses the event id as an idempotency boundary', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('worker-user', 'courier-2', 'active');
  const task = tasks.createTask({ customerName: '改派客户', address: '改派地址', items: [] });

  tasks.assignTask(task.id, 'courier-2', { id: 'staff-user', name: '客服', eventId: 'assign-event-1' });
  tasks.assignTask(task.id, 'courier-2', { id: 'staff-user', name: '客服', eventId: 'assign-event-1' });

  assert.equal(tasks.getTask(task.id).defaultWorkerId, 'courier-2');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE notification_type='pickupTask.assigned'").get().count, 1);
  db.close();
});

test('task status changes notify the dispatch owner through the canonical service', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('dispatch-user', null, 'active');
  const task = tasks.createTask({ customerName: '状态客户', address: '状态地址', items: [] }, {
    id: 'dispatch-user', name: '客服'
  });

  tasks.transitionTask(task.id, 'in_progress', { id: 'worker-user', name: '取件员', eventId: 'status-event-1' });

  const notification = db.prepare("SELECT * FROM notifications WHERE notification_type='pickupTask.statusChanged'").get();
  assert.equal(notification.user_id, 'dispatch-user');
  assert.equal(JSON.parse(notification.data).status, 'in_progress');
  db.close();
});

test('successive status transitions use distinct generated idempotency keys', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('dispatch-user', null, 'active');
  const task = tasks.createTask({ customerName: '连续状态客户', address: '连续状态地址', items: [] }, {
    id: 'dispatch-user', name: '客服'
  });

  tasks.transitionTask(task.id, 'in_progress', { id: 'worker-user', name: '取件员' });
  tasks.transitionTask(task.id, 'completed', { id: 'worker-user', name: '取件员' });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE notification_type='pickupTask.statusChanged'").get().count, 2);
  db.close();
});

test('making a task urgent creates a high-priority worker notification', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('worker-user', 'courier-rush', 'active');
  const task = tasks.createTask({
    customerName: '加急客户', address: '加急地址', defaultWorkerId: 'courier-rush', items: []
  });

  tasks.updateTask(task.id, { taskType: 'rush', rushReason: '临近截单', eventId: 'rush-event-1' }, { id: 'staff-user', name: '客服' });

  const notification = db.prepare("SELECT * FROM notifications WHERE notification_type='pickupTask.overdue'").get();
  assert.equal(notification.user_id, 'worker-user');
  assert.equal(notification.priority, 'high');
  db.close();
});

test('worker exception report notifies the task dispatch owner', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('dispatch-user', null, 'active');
  const task = tasks.createTask({ customerName: '异常客户', address: '异常地址', items: [] }, {
    id: 'dispatch-user', name: '客服'
  });

  tasks.reportException(task.id, { type: 'address', description: '地址无法定位', eventId: 'exception-event-1' }, {
    id: 'worker-user', name: '取件员'
  });

  const notification = db.prepare("SELECT * FROM notifications WHERE notification_type='pickupTask.exception'").get();
  assert.equal(notification.user_id, 'dispatch-user');
  assert.match(notification.body, /地址无法定位/);
  db.close();
});

test('resolving an exception notifies the assigned worker', () => {
  const { db, tasks } = taskModuleWithNotifications();
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('dispatch-user', null, 'active');
  db.prepare('INSERT INTO users (id,courier_id,status) VALUES (?,?,?)').run('worker-user', 'courier-1', 'active');
  const task = tasks.createTask({
    customerName: '异常处理客户', address: '异常处理地址', defaultWorkerId: 'courier-1', items: []
  }, { id: 'dispatch-user', name: '客服' });
  const exception = tasks.reportException(task.id, {
    type: 'address', description: '地址错误', eventId: 'exception-report-1'
  }, { id: 'worker-user', name: '取件员' });

  tasks.resolveException(exception.id, '已联系客户修正', {
    id: 'dispatch-user', name: '客服', eventId: 'exception-resolve-1'
  });

  const notification = db.prepare("SELECT * FROM notifications WHERE user_id='worker-user' AND body LIKE '%已处理%'").get();
  assert.equal(notification.notification_type, 'pickupTask.exception');
  db.close();
});

test('countTasks and listTasks support SQL-level pagination with a stable order', () => {
  const { db, tasks } = taskModule();
  for (let i = 0; i < 5; i += 1) {
    tasks.createTask({ customerName: `分页客户${i}`, address: `地址${i}`, items: [] }, { id: 'u1', name: '客服' });
  }
  assert.equal(tasks.countTasks({}), 5);
  assert.equal(tasks.countTasks({ status: 'pending' }), 5);
  assert.equal(tasks.countTasks({ status: 'completed' }), 0);

  const full = tasks.listTasks({});
  assert.equal(full.length, 5);
  const pages = [
    tasks.listTasks({}, { limit: 2, offset: 0 }),
    tasks.listTasks({}, { limit: 2, offset: 2 }),
    tasks.listTasks({}, { limit: 2, offset: 4 })
  ];
  assert.deepEqual(
    pages.map(page => page.map(task => task.id)).flat(),
    full.map(task => task.id)
  );
  assert.equal(pages[0].length, 2);
  assert.equal(pages[1].length, 2);
  assert.equal(pages[2].length, 1);
  db.close();
});

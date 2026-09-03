const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');

function legacyDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      courier_id TEXT,
      customer TEXT NOT NULL,
      pieces INTEGER NOT NULL DEFAULT 1,
      region TEXT DEFAULT '',
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '待取',
      order_no TEXT DEFAULT '',
      customer_id TEXT DEFAULT '',
      address TEXT DEFAULT '',
      goods TEXT DEFAULT '',
      weight REAL DEFAULT 0,
      volume REAL DEFAULT 0,
      tracking_no TEXT DEFAULT '',
      amount_receivable REAL DEFAULT 0,
      amount_payable REAL DEFAULT 0,
      settled TEXT DEFAULT '未结算',
      dispatcher_id TEXT DEFAULT '',
      dispatcher_name TEXT DEFAULT '',
      goods_images TEXT DEFAULT '',
      pickup_images TEXT DEFAULT '',
      pickup_phone TEXT DEFAULT '',
      appointment_time TEXT DEFAULT '',
      dimensions TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
    CREATE TABLE record_status_log (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT DEFAULT '',
      user_name TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
  `);
  db.prepare(`INSERT INTO records (
    id,date,courier_id,customer,pieces,region,note,status,order_no,customer_id,address,
    goods,weight,volume,tracking_no,amount_receivable,amount_payable,settled,
    dispatcher_id,dispatcher_name,goods_images,pickup_images,pickup_phone,
    appointment_time,dimensions,completed_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'rec-1', '2026-08-16', 'courier-1', '义乌星河贸易', 3, '江东', '门卫处取件', '已完成',
    'PO-001', 'customer-1', '江东街道 88 号', '服装', 12.5, 0.08, 'WB-001', 100, 30,
    '已结算', 'user-cs', '客服张三', '["goods-a.jpg"]', '["pickup-a.jpg"]', '13800000000',
    '2026-08-16 10:30:00', '50×30×20cm', '2026-08-16 11:15:00', '2026-08-16 09:00:00'
  );
  db.prepare('INSERT INTO record_status_log VALUES (?,?,?,?,?,?)').run(
    'log-1', 'rec-1', '已完成', '现场确认', '取件员王五', '2026-08-16 11:15:00'
  );
  return db;
}

test('migrate maps each legacy record to one task and one cargo item without changing the source row', () => {
  const db = legacyDatabase();

  migrate(db);

  const task = db.prepare('SELECT * FROM pickup_tasks WHERE id = ?').get('rec-1');
  assert.equal(task.business_order_no, 'PO-001');
  assert.equal(task.customer_name_snap, '义乌星河贸易');
  assert.equal(task.status, 'completed');
  assert.equal(task.task_type, 'scheduled');
  assert.equal(task.scheduled_time, '2026-08-16 10:30:00');
  assert.equal(task.default_worker_id, 'courier-1');
  assert.equal(task.amount_receivable, 100);

  const item = db.prepare('SELECT * FROM pickup_items WHERE task_id = ?').get('rec-1');
  assert.equal(item.waybill_no, 'WB-001');
  assert.equal(item.pieces, 3);
  assert.equal(item.final_weight, 12.5);
  assert.equal(item.goods_name, '服装');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pickup_photos WHERE task_id = ?').get('rec-1').count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get('rec-1').count, 1);
  assert.equal(db.prepare('SELECT customer FROM records WHERE id = ?').get('rec-1').customer, '义乌星河贸易');
  db.close();
});

test('migrate is idempotent and does not duplicate migrated children', () => {
  const db = legacyDatabase();

  migrate(db);
  migrate(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pickup_tasks').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pickup_items').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pickup_photos').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 1);
  db.close();
});

test('migrate skips orphaned legacy status logs whose record was already deleted', () => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO record_status_log VALUES (?,?,?,?,?,?)').run(
    'orphan-log', 'missing-record', '已取消', '历史孤儿日志', '系统', '2026-08-15 08:00:00'
  );

  assert.doesNotThrow(() => migrate(db));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE id=?').get('orphan-log').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pickup_tasks').get().count, 1);
  db.close();
});

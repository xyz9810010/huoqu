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

test('migrate backfills courier name snapshots on pre-snapshot schema and removes orphan area assignments', () => {
  const db = new Database(':memory:');
  // 旧版任务模型：pickup_tasks/pickup_items/task_assistants 尚无 *_name_snap 列
  db.exec(`
    CREATE TABLE couriers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT DEFAULT '', commission_rate REAL DEFAULT 0
    );
    CREATE TABLE pickup_tasks (
      id TEXT PRIMARY KEY, task_no TEXT NOT NULL UNIQUE, customer_id TEXT DEFAULT '',
      customer_name_snap TEXT DEFAULT '', default_worker_id TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      dispatch_at TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT DEFAULT '', amount_receivable REAL DEFAULT 0, amount_payable REAL DEFAULT 0
    );
    CREATE TABLE pickup_items (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT DEFAULT '', entry_method TEXT DEFAULT '',
      waybill_no TEXT DEFAULT '', goods_name TEXT DEFAULT '', pieces INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
      final_weight REAL DEFAULT 0, weight_source TEXT DEFAULT '', match_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE task_assistants (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, added_by TEXT DEFAULT '',
      created_at TEXT NOT NULL, UNIQUE(task_id, worker_id)
    );
    CREATE TABLE areas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE area_workers (
      area_id TEXT NOT NULL, worker_id TEXT NOT NULL, worker_role TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY(area_id, worker_id, worker_role)
    );
  `);
  db.prepare('INSERT INTO couriers VALUES (?,?,?,?)').run('c-1', '快照甲', '江东', 3);
  db.prepare('INSERT INTO couriers VALUES (?,?,?,?)').run('c-2', '快照乙', '稠城', 2);
  db.prepare(`INSERT INTO pickup_tasks (id,task_no,customer_id,customer_name_snap,default_worker_id,status,created_at,updated_at)
    VALUES ('t-1','QJ20260901-AAAA01','cust-1','历史客户','c-1','completed','2026-09-01 01:00:00','2026-09-01 02:00:00')`).run();
  db.prepare(`INSERT INTO pickup_items (id,task_id,worker_id,goods_name,created_at,updated_at)
    VALUES ('i-1','t-1','c-2','纸箱','2026-09-01 01:05:00','2026-09-01 01:05:00')`).run();
  db.prepare(`INSERT INTO task_assistants (id,task_id,worker_id,created_at) VALUES ('a-1','t-1','c-2','2026-09-01 01:03:00')`).run();
  // 旧版本删除取件员档案时遗留的区域悬空指派
  db.prepare("INSERT INTO areas (id,name) VALUES ('ar-1','江东区')").run();
  db.prepare("INSERT INTO area_workers VALUES ('ar-1','c-2','default')").run();
  db.prepare("INSERT INTO area_workers VALUES ('ar-1','gone-courier','backup')").run();
  db.prepare("INSERT INTO task_assistants (id,task_id,worker_id,created_at) VALUES ('a-2','t-1','gone-courier','2026-09-01 01:04:00')").run();

  migrate(db);

  const task = db.prepare('SELECT * FROM pickup_tasks WHERE id=?').get('t-1');
  assert.equal(task.default_worker_name_snap, '快照甲');
  assert.equal(db.prepare('SELECT worker_name_snap FROM pickup_items WHERE id=?').get('i-1').worker_name_snap, '快照乙');
  assert.equal(db.prepare('SELECT worker_name_snap FROM task_assistants WHERE id=?').get('a-1').worker_name_snap, '快照乙');
  // 已不存在的档案无从回填，保持空（路由层在删除时会先固化，属历史遗留数据）
  assert.equal(db.prepare('SELECT worker_name_snap FROM task_assistants WHERE id=?').get('a-2').worker_name_snap, '');
  // 悬空区域指派被清理，有效指派保留
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM area_workers WHERE worker_id=?').get('gone-courier').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM area_workers WHERE worker_id=?').get('c-2').n, 1);

  migrate(db);
  // 幂等：快照不覆盖既有值、不重复处理
  assert.equal(db.prepare('SELECT default_worker_name_snap FROM pickup_tasks WHERE id=?').get('t-1').default_worker_name_snap, '快照甲');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM area_workers').get().n, 1);
  db.close();
});

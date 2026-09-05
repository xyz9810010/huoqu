const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrate } = require('../server/migrations');
const time = require('../server/time');

const TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ---------- time.js 口径 ----------
test('utcText produces UTC space text while bjText is Beijing wall clock', () => {
  const fixed = new Date('2026-09-04T16:30:00.000Z');
  assert.equal(time.utcText(fixed), '2026-09-04 16:30:00');
  assert.equal(time.bjText(fixed), '2026-09-05 00:30:00');
  assert.match(time.utcText(), TEXT_RE);
});

test('utcTextToBjText crosses day/month boundaries and leaves non-time text untouched', () => {
  assert.equal(time.utcTextToBjText('2026-09-04 16:30:00'), '2026-09-05 00:30:00');
  assert.equal(time.utcTextToBjText('2026-09-04 23:30:00'), '2026-09-05 07:30:00');
  assert.equal(time.utcTextToBjText('2026-08-31 20:00:00'), '2026-09-01 04:00:00');
  assert.equal(time.bjTextToUtcText('2026-09-05 00:30:00'), '2026-09-04 16:30:00');
  assert.equal(time.utcTextToBjText(''), '');
  assert.equal(time.utcTextToBjText('not-a-time'), 'not-a-time');
  assert.equal(time.utcTextToBjText('2026-09-04T16:30:00.000Z'), '2026-09-04T16:30:00.000Z');
  assert.equal(time.shiftText('2026-09-05 00:30:00', -8), '2026-09-04 16:30:00');
});

// ---------- 迁移：混存库统一为 UTC ----------
function mixedDatabase() {
  const db = new Database(':memory:');
  // 预置 legacy 源表（北京时间文本自洽）
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, courier_id TEXT, customer TEXT NOT NULL,
      pieces INTEGER NOT NULL DEFAULT 1, region TEXT DEFAULT '', note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '待取', order_no TEXT DEFAULT '', customer_id TEXT DEFAULT '',
      address TEXT DEFAULT '', goods TEXT DEFAULT '', weight REAL DEFAULT 0, volume REAL DEFAULT 0,
      tracking_no TEXT DEFAULT '', amount_receivable REAL DEFAULT 0, amount_payable REAL DEFAULT 0,
      settled TEXT DEFAULT '未结算', dispatcher_id TEXT DEFAULT '', dispatcher_name TEXT DEFAULT '',
      goods_images TEXT DEFAULT '', pickup_images TEXT DEFAULT '', pickup_phone TEXT DEFAULT '',
      appointment_time TEXT DEFAULT '', dimensions TEXT DEFAULT '', completed_at TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
    CREATE TABLE record_status_log (
      id TEXT PRIMARY KEY, record_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT DEFAULT '',
      user_name TEXT DEFAULT '', created_at TEXT DEFAULT ''
    );
  `);
  db.prepare(`INSERT INTO records VALUES
    ('rec-1','2026-08-16','courier-1','义乌星河贸易',3,'江东','门卫处取件','已完成','PO-001',
     'customer-1','江东街道 88 号','服装',12.5,0.08,'WB-001',100,30,'已结算','user-cs','客服张三',
     '["goods-a.jpg"]','["pickup-a.jpg"]','13800000000','2026-08-16 10:30:00','50×30×20cm',
     '2026-08-16 11:15:00','2026-08-16 09:00:00')`).run();
  db.prepare('INSERT INTO record_status_log VALUES (?,?,?,?,?,?)').run(
    'log-1', 'rec-1', '已完成', '现场确认', '取件员王五', '2026-08-16 11:15:00'
  );
  migrate(db); // 先建 schema + 导入 legacy（北京文本）

  // 现代任务（UTC 文本，正确）
  db.prepare(`INSERT INTO pickup_tasks
    (id,task_no,customer_name_snap,address_snap,status,created_at,updated_at,dispatch_at,completed_at)
    VALUES ('task-u1','QJ20260904-AAAAAA','现代客户','义乌甲', 'completed','2026-09-04 05:00:00','2026-09-04 05:00:00','2026-09-04 05:00:00','2026-09-04 14:00:00')`).run();
  db.prepare(`INSERT INTO pickup_tasks
    (id,task_no,customer_name_snap,address_snap,status,created_at,updated_at,dispatch_at,completed_at)
    VALUES ('task-u2','QJ20260904-BBBBBB','现代客户2','义乌乙', 'pending','2026-09-04 16:36:49','2026-09-04 16:36:49','2026-09-04 16:36:49','')`).run();
  // v1 补录错写：北京时间文本（真实 UTC 应为 2026-09-05 00:37:07 - 8h = 前日 16:37:07）
  db.prepare(`INSERT INTO pickup_items
    (id,task_id,worker_id,entry_method,waybill_no,goods_name,pieces,sort_order,created_at,updated_at)
    VALUES ('item-bj1','task-u2','','scan','WB-BJ-1','补录货',1,0,'2026-09-05 00:37:07','2026-09-05 00:37:07')`).run();
  db.prepare(`INSERT INTO task_events
    (id,task_id,event_type,note,actor_id,actor_name,created_at)
    VALUES ('ev-bj1','task-u2','item_added','WB-BJ-1','u1','补录员','2026-09-05 00:37:07')`).run();
  db.prepare(`INSERT INTO pickup_photos
    (id,task_id,photo_type,filename,uploaded_by,created_at)
    VALUES ('photo-bj1','task-u2','pickup','bj.jpg','u1','2026-09-05 00:37:10')`).run();
  // 正常 UTC 现代事件（任务创建 9 小时后状态变更，不应被误判）
  db.prepare(`INSERT INTO task_events
    (id,task_id,event_type,note,actor_id,actor_name,created_at)
    VALUES ('ev-utc9h','task-u1','status_changed','','u1','系统','2026-09-04 14:00:00')`).run();
  return db;
}

test('migrate converts legacy Beijing rows and one-time fixes modern v1 offset rows', () => {
  const db = mixedDatabase();
  // mixedDatabase 首次 migrate 时现代错行尚未插入；此处重置 v5 门控后重跑，
  // 模拟「升级前库内已存在错行」的真实场景
  db.prepare('DELETE FROM schema_migrations WHERE version=5').run();
  migrate(db);
  const task = db.prepare('SELECT created_at,completed_at FROM pickup_tasks WHERE id=?').get('rec-1');
  assert.equal(task.created_at, '2026-08-16 01:00:00'); // 09:00 北京 -> UTC
  assert.equal(task.completed_at, '2026-08-16 03:15:00'); // 11:15 北京 -> UTC

  const item = db.prepare('SELECT created_at FROM pickup_items WHERE id=?').get('item-bj1');
  assert.equal(item.created_at, '2026-09-04 16:37:07'); // 00:37:07 次日北京 -> UTC 当日
  const event = db.prepare('SELECT created_at FROM task_events WHERE id=?').get('ev-bj1');
  assert.equal(event.created_at, '2026-09-04 16:37:07');
  const photo = db.prepare('SELECT created_at FROM pickup_photos WHERE id=?').get('photo-bj1');
  assert.equal(photo.created_at, '2026-09-04 16:37:10');
  // 正常 UTC 事件保持原样（9.14h 的 status_changed 不是 item_added 错行）
  const healthy = db.prepare('SELECT created_at FROM task_events WHERE id=?').get('ev-utc9h');
  assert.equal(healthy.created_at, '2026-09-04 14:00:00');
  // legacy 照片/事件一并对齐为 UTC
  const legacyPhoto = db.prepare(`SELECT created_at FROM pickup_photos WHERE id LIKE 'legacy:goods:%'`).get();
  assert.equal(legacyPhoto.created_at, '2026-08-16 01:00:00');
  const legacyEvent = db.prepare('SELECT created_at FROM task_events WHERE id=?').get('log-1');
  assert.equal(legacyEvent.created_at, '2026-08-16 03:15:00');
  // records 源数据保持原样
  assert.equal(db.prepare('SELECT created_at FROM records WHERE id=?').get('rec-1').created_at, '2026-08-16 09:00:00');
  db.close();
});

test('time unify migration is idempotent and its heuristic fix runs only once', () => {
  const db = mixedDatabase();
  const snapshot = () => ['pickup_tasks', 'pickup_items', 'task_events', 'pickup_photos']
    .map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).join('|');
  migrate(db);
  const once = snapshot();
  migrate(db);
  migrate(db);
  assert.equal(snapshot(), once, 'second runs do not alter task-domain timestamps');

  // 门控：v1 错写修正只执行一次——migrate 后再出现 8h 偏移的新行不会被启发式再改
  db.prepare(`INSERT INTO pickup_items
    (id,task_id,worker_id,entry_method,waybill_no,goods_name,pieces,sort_order,created_at,updated_at)
    VALUES ('item-late','task-u2','','scan','WB-LATE','晚到货',1,0,'2026-09-06 03:00:00','2026-09-06 03:00:00')`).run();
  migrate(db);
  assert.equal(db.prepare('SELECT created_at FROM pickup_items WHERE id=?').get('item-late').created_at, '2026-09-06 03:00:00');
  db.close();
});

test('dashboard day filtering shifts UTC task times to Beijing dates at the day boundary', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pickup_tasks (created_at TEXT)`);
  // 北京 2026-09-05 00:30 == UTC 2026-09-04 16:30（跨天边界内仍属北京 9-05）
  db.prepare('INSERT INTO pickup_tasks VALUES (?)').run('2026-09-04 16:30:00');
  const shifted = db.prepare(`SELECT COUNT(*) n FROM pickup_tasks WHERE date(created_at,'+8 hours')>='2026-09-05'`).get().n;
  const legacySlice = db.prepare(`SELECT COUNT(*) n FROM pickup_tasks WHERE substr(created_at,1,10)>='2026-09-05'`).get().n;
  assert.equal(shifted, 1, 'UTC 前日 16:30 必须计入北京次日');
  assert.equal(legacySlice, 0, '旧 substr 截断会把它漏出北京次日');
  db.close();
});

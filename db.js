// 数据库初始化（better-sqlite3）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
// 确保数据库所在目录存在（直接 node server.js 运行时 data 目录可能尚未创建）
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS couriers (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  region   TEXT DEFAULT '',
  commission_rate REAL DEFAULT 0       -- 计件提成单价（元/件）
);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,          -- yyyy-mm-dd
  courier_id TEXT,
  customer   TEXT NOT NULL,
  pieces     INTEGER NOT NULL DEFAULT 1,
  region     TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT '待取',  -- 待取 | 已取 | 已完成 | 已取消
  order_no       TEXT DEFAULT '',               -- 订单号（非空时唯一，防重复录入）
  customer_id    TEXT DEFAULT '',               -- 关联客户档案 customers.id
  address        TEXT DEFAULT '',               -- 取件地址
  goods          TEXT DEFAULT '',               -- 货物品名
  weight         REAL DEFAULT 0,                -- 重量(kg)
  volume         REAL DEFAULT 0,                -- 体积(m³)
  tracking_no    TEXT DEFAULT '',               -- 面单号/运单号
  amount_receivable REAL DEFAULT 0,             -- 应收金额
  amount_payable    REAL DEFAULT 0,             -- 应付金额
  settled        TEXT DEFAULT '未结算',          -- 结算状态：未结算 | 已结算
  dispatcher_id   TEXT DEFAULT '',   -- 派单人（客服/管理员）用户 id
  dispatcher_name TEXT DEFAULT '',   -- 派单人显示名（冗余存储，用户删除后仍可追溯）
  goods_images  TEXT DEFAULT '',   -- 货物图片（派单员上传，JSON 数组文件名）
  pickup_images TEXT DEFAULT '',   -- 取件图片（取件员上传，JSON 数组文件名）
  pickup_phone  TEXT DEFAULT '',   -- 取件联系电话（客服派单时填写，可与客户电话不同）
  appointment_time TEXT DEFAULT '',  -- 预约取件时间（精确到秒）
  dimensions       TEXT DEFAULT '',  -- 货物尺寸（过机获取，如 50×30×20cm）
  completed_at     TEXT DEFAULT '',  -- 订单完成时间（精确到秒）
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_records_date   ON records(date);
CREATE INDEX IF NOT EXISTS idx_records_courier ON records(courier_id);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  address    TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS record_status_log (
  id         TEXT PRIMARY KEY,
  record_id  TEXT NOT NULL,
  status     TEXT NOT NULL,
  note       TEXT DEFAULT '',
  user_name  TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_statuslog_record ON record_status_log(record_id);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'courier',  -- admin | courier
  courier_id    TEXT,                             -- 取件员账号绑定的取件员
  name          TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now','+8 hours'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT DEFAULT '',
  courier_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
`);

// 迁移：为旧版本数据库补齐新增字段
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('records', 'dispatcher_id', "TEXT DEFAULT ''");
ensureColumn('records', 'dispatcher_name', "TEXT DEFAULT ''");
ensureColumn('records', 'goods_images', "TEXT DEFAULT ''");
ensureColumn('records', 'pickup_images', "TEXT DEFAULT ''");
ensureColumn('records', 'status', "TEXT NOT NULL DEFAULT '待取'");
ensureColumn('records', 'order_no', "TEXT DEFAULT ''");
ensureColumn('records', 'customer_id', "TEXT DEFAULT ''");
ensureColumn('records', 'address', "TEXT DEFAULT ''");
ensureColumn('records', 'goods', "TEXT DEFAULT ''");
ensureColumn('records', 'weight', "REAL DEFAULT 0");
ensureColumn('records', 'volume', "REAL DEFAULT 0");
ensureColumn('records', 'tracking_no', "TEXT DEFAULT ''");
ensureColumn('records', 'amount_receivable', "REAL DEFAULT 0");
ensureColumn('records', 'amount_payable', "REAL DEFAULT 0");
ensureColumn('records', 'settled', "TEXT DEFAULT '未结算'");
ensureColumn('records', 'pickup_phone', "TEXT DEFAULT ''");
ensureColumn('records', 'appointment_time', "TEXT DEFAULT ''");
ensureColumn('records', 'dimensions', "TEXT DEFAULT ''");
ensureColumn('records', 'completed_at', "TEXT DEFAULT ''");
ensureColumn('couriers', 'commission_rate', "REAL DEFAULT 0");

// 新增列补齐后再建索引（旧库升级时先补列，避免引用尚不存在的列）
// 非空订单号唯一（部分唯一索引），从数据库层兜底防重复录入
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_records_order_no ON records(order_no) WHERE order_no <> '';");
db.exec("CREATE INDEX IF NOT EXISTS idx_records_tracking_no ON records(tracking_no);");
db.exec("CREATE INDEX IF NOT EXISTS idx_records_customer ON records(customer_id);");

// 统一任务模型：先添加新表并从旧 records 幂等迁移，旧表保留为回滚源。
require('./server/migrations').migrate(db);

module.exports = db;

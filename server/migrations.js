const crypto = require('node:crypto');

const STATUS_MAP = {
  '待取': 'pending',
  '已取': 'in_progress',
  '已完成': 'completed',
  '已取消': 'cancelled',
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled'
};

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table)) return;
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function taskNumber(record) {
  const day = String(record.date || record.created_at || '').replace(/\D/g, '').slice(0, 8) || '00000000';
  const suffix = crypto.createHash('sha1').update(String(record.id)).digest('hex').slice(0, 6).toUpperCase();
  return `QJ${day}-${suffix}`;
}

function parseImages(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pickup_tasks (
      id TEXT PRIMARY KEY,
      task_no TEXT NOT NULL UNIQUE,
      business_order_no TEXT DEFAULT '',
      customer_id TEXT DEFAULT '',
      customer_name_snap TEXT NOT NULL,
      address_snap TEXT DEFAULT '',
      contact_snap TEXT DEFAULT '',
      phone_snap TEXT DEFAULT '',
      area_name_snap TEXT DEFAULT '',
      main_cs_id TEXT DEFAULT '',
      dispatch_cs_id TEXT DEFAULT '',
      dispatch_cs_name TEXT DEFAULT '',
      default_worker_id TEXT DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'normal',
      scheduled_kind TEXT DEFAULT '',
      scheduled_time TEXT DEFAULT '',
      rush_ship_time TEXT DEFAULT '',
      rush_reason TEXT DEFAULT '',
      dispatch_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      pickup_note TEXT DEFAULT '',
      internal_note TEXT DEFAULT '',
      volume REAL DEFAULT 0,
      dimensions TEXT DEFAULT '',
      amount_receivable REAL DEFAULT 0,
      amount_payable REAL DEFAULT 0,
      settled TEXT DEFAULT '未结算',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pickup_tasks_status ON pickup_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_pickup_tasks_customer ON pickup_tasks(customer_id);
    CREATE INDEX IF NOT EXISTS idx_pickup_tasks_worker ON pickup_tasks(default_worker_id);
    CREATE INDEX IF NOT EXISTS idx_pickup_tasks_created ON pickup_tasks(created_at);

    CREATE TABLE IF NOT EXISTS pickup_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worker_id TEXT DEFAULT '',
      entry_method TEXT NOT NULL DEFAULT 'manual',
      waybill_no TEXT DEFAULT '',
      goods_name TEXT DEFAULT '',
      pieces INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      final_weight REAL DEFAULT 0,
      weight_source TEXT DEFAULT '',
      match_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(task_id) REFERENCES pickup_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pickup_items_task ON pickup_items(task_id);
    CREATE INDEX IF NOT EXISTS idx_pickup_items_waybill ON pickup_items(waybill_no);

    CREATE TABLE IF NOT EXISTS pickup_photos (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      item_id TEXT DEFAULT '',
      photo_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      uploaded_by TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(task_id) REFERENCES pickup_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pickup_photos_task ON pickup_photos(task_id);

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT DEFAULT '',
      to_status TEXT DEFAULT '',
      note TEXT DEFAULT '',
      actor_id TEXT DEFAULT '',
      actor_name TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(task_id) REFERENCES pickup_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

    CREATE TABLE IF NOT EXISTS task_assistants (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      added_by TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, worker_id),
      FOREIGN KEY(task_id) REFERENCES pickup_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_assistants_task ON task_assistants(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_assistants_worker ON task_assistants(worker_id);

    CREATE TABLE IF NOT EXISTS task_exceptions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      reporter_id TEXT DEFAULT '',
      exception_type TEXT NOT NULL,
      description TEXT DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by TEXT DEFAULT '',
      resolution TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT DEFAULT '',
      FOREIGN KEY(task_id) REFERENCES pickup_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS waybill_weights (
      waybill_no TEXT PRIMARY KEY,
      customer_id TEXT DEFAULT '',
      final_weight REAL DEFAULT 0,
      ship_date TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      data TEXT DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL,
      provider_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      provider_message_id TEXT DEFAULT '',
      last_error_code TEXT DEFAULT '',
      last_error_message TEXT DEFAULT '',
      sent_at TEXT DEFAULT '',
      delivered_at TEXT DEFAULT '',
      locked_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      UNIQUE(notification_id, subscription_id, channel, provider_code)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
      ON notification_deliveries(status,next_attempt_at);

    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      provider_code TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      target_fingerprint TEXT NOT NULL,
      platform TEXT DEFAULT '',
      device_label TEXT DEFAULT '',
      app_version TEXT DEFAULT '',
      role TEXT DEFAULT '',
      courier_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT DEFAULT '',
      invalidated_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider_code,target_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_user
      ON notification_subscriptions(user_id,status);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      quiet_start TEXT DEFAULT '',
      quiet_end TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,notification_type,channel)
    );

    CREATE TABLE IF NOT EXISTS push_provider_configs (
      provider_code TEXT PRIMARY KEY,
      credentials_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_version INTEGER NOT NULL DEFAULT 1,
      tested_version INTEGER NOT NULL DEFAULT 0,
      health_status TEXT NOT NULL DEFAULT 'untested',
      last_tested_at TEXT DEFAULT '',
      last_error_code TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT '',
      user_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      code TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS area_workers (
      area_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      worker_role TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY(area_id, worker_id, worker_role),
      FOREIGN KEY(area_id) REFERENCES areas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      address TEXT NOT NULL,
      contact_name TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      area_id TEXT DEFAULT '',
      is_common INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      remark TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
  `);

  ensureColumn(db, 'users', 'phone', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'employee_no', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'customers', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'customers', 'legacy_customer_id', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'important_note', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'main_cs_id', "TEXT DEFAULT ''");
  ensureColumn(db, 'notifications', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, 'notifications', 'dedupe_key', "TEXT DEFAULT ''");
  ensureColumn(db, 'notifications', 'expires_at', "TEXT DEFAULT ''");
  ensureColumn(db, 'notifications', 'read_at', "TEXT DEFAULT ''");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(user_id,dedupe_key) WHERE dedupe_key <> ''`);
  db.prepare(`INSERT OR IGNORE INTO schema_migrations (version,applied_at)
    VALUES (4,datetime('now'))`).run();

  // Preserve each legacy customer's single address as its first reusable point.
  if (tableExists(db, 'customers')) {
    db.exec(`INSERT OR IGNORE INTO customer_addresses
      (id,customer_id,name,address,contact_name,contact_phone,is_common,is_active,remark,created_at)
      SELECT 'legacy-address:' || id,id,'默认地址',address,contact,phone,1,1,note,COALESCE(created_at,datetime('now','+8 hours'))
      FROM customers WHERE TRIM(COALESCE(address,'')) <> ''`);
  }
}

function migrateLegacyRecords(db) {
  if (!tableExists(db, 'records')) return;
  const insertTask = db.prepare(`INSERT OR IGNORE INTO pickup_tasks (
    id,task_no,business_order_no,customer_id,customer_name_snap,address_snap,phone_snap,
    area_name_snap,dispatch_cs_id,dispatch_cs_name,default_worker_id,task_type,scheduled_kind,
    scheduled_time,dispatch_at,completed_at,status,pickup_note,volume,dimensions,
    amount_receivable,amount_payable,settled,created_at,updated_at
  ) VALUES (
    @id,@task_no,@business_order_no,@customer_id,@customer_name_snap,@address_snap,@phone_snap,
    @area_name_snap,@dispatch_cs_id,@dispatch_cs_name,@default_worker_id,@task_type,@scheduled_kind,
    @scheduled_time,@dispatch_at,@completed_at,@status,@pickup_note,@volume,@dimensions,
    @amount_receivable,@amount_payable,@settled,@created_at,@updated_at
  )`);
  const insertItem = db.prepare(`INSERT OR IGNORE INTO pickup_items (
    id,task_id,worker_id,entry_method,waybill_no,goods_name,pieces,sort_order,final_weight,weight_source,match_status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertPhoto = db.prepare(`INSERT OR IGNORE INTO pickup_photos
    (id,task_id,item_id,photo_type,filename,created_at) VALUES (?,?,?,?,?,?)`);

  for (const row of db.prepare('SELECT * FROM records').all()) {
    const createdAt = row.created_at || `${row.date} 00:00:00`;
    const scheduled = row.appointment_time || '';
    insertTask.run({
      id: row.id,
      task_no: taskNumber(row),
      business_order_no: row.order_no || '',
      customer_id: row.customer_id || '',
      customer_name_snap: row.customer,
      address_snap: row.address || '',
      phone_snap: row.pickup_phone || '',
      area_name_snap: row.region || '',
      dispatch_cs_id: row.dispatcher_id || '',
      dispatch_cs_name: row.dispatcher_name || '',
      default_worker_id: row.courier_id || '',
      task_type: scheduled ? 'scheduled' : 'normal',
      scheduled_kind: scheduled ? 'around' : '',
      scheduled_time: scheduled,
      dispatch_at: createdAt,
      completed_at: row.completed_at || '',
      status: STATUS_MAP[row.status] || 'pending',
      pickup_note: row.note || '',
      volume: Number(row.volume || 0),
      dimensions: row.dimensions || '',
      amount_receivable: Number(row.amount_receivable || 0),
      amount_payable: Number(row.amount_payable || 0),
      settled: row.settled || '未结算',
      created_at: createdAt,
      updated_at: row.completed_at || createdAt
    });

    if (row.goods || row.tracking_no || row.weight || row.pieces) {
      insertItem.run(
        `legacy-item:${row.id}`, row.id, row.courier_id || '', row.tracking_no ? 'scan' : 'manual',
        row.tracking_no || '', row.goods || '', Number(row.pieces || 1), 0, Number(row.weight || 0),
        row.weight ? 'legacy' : '', row.weight ? 'matched' : (row.tracking_no ? 'pending' : 'no_waybill'),
        createdAt, row.completed_at || createdAt
      );
    }

    const itemId = `legacy-item:${row.id}`;
    for (const [index, filename] of parseImages(row.goods_images).entries()) {
      insertPhoto.run(`legacy:goods:${row.id}:${index}`, row.id, itemId, 'goods', filename, createdAt);
    }
    for (const [index, filename] of parseImages(row.pickup_images).entries()) {
      insertPhoto.run(`legacy:pickup:${row.id}:${index}`, row.id, itemId, 'pickup', filename, row.completed_at || createdAt);
    }
  }

  if (tableExists(db, 'record_status_log')) {
    const insertEvent = db.prepare(`INSERT OR IGNORE INTO task_events
      (id,task_id,event_type,to_status,note,actor_name,created_at) VALUES (?,?,?,?,?,?,?)`);
    const taskExists = db.prepare('SELECT 1 FROM pickup_tasks WHERE id = ?');
    for (const log of db.prepare('SELECT * FROM record_status_log').all()) {
      // Historical databases can retain audit rows after the associated record
      // was removed. They are useful in the legacy table, but cannot become a
      // task event without violating the canonical task foreign key.
      if (!taskExists.get(log.record_id)) continue;
      insertEvent.run(log.id, log.record_id, 'status_changed', STATUS_MAP[log.status] || '', log.note || '', log.user_name || '', log.created_at || '');
    }
  }
}


// 时间口径统一（2026-09-05，P1）：
// 任务域机器时刻（pickup_tasks/pickup_items/task_events/pickup_photos 等）统一为
// UTC 空格文本。历史数据含两类错源：
//   1) records / record_status_log 迁移导入的 legacy 行：源表为北京时间文本。
//      这里每次启动按源表幂等对齐为 UTC（以源值为准，不依赖行现值，天然可重复）。
//   2) 任务模型上线后 v1 接口补录明细/照片时曾按北京时间写入的少数现代行：
//      属于一次性数据修正，用 schema_migrations version=5 门控，只执行一次，
//      避免将来把真正的 UTC 行误判（启发式只适用于当前存量数据）。
// 录入型计划时刻 scheduled_time/rush_ship_time 保持北京时间钟面文本，不参与转换。
function migrateTaskTimestamps(db) {
  const hasVersion = (v) => Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(v));

  const taskSrcCreated = "(SELECT r.created_at FROM records r WHERE r.id=pickup_tasks.id)";
  const taskSrcCompleted = "(SELECT r.completed_at FROM records r WHERE r.id=pickup_tasks.id)";
  const taskSrcUpdated = "(SELECT CASE WHEN r.completed_at IS NOT NULL AND r.completed_at<>'' THEN r.completed_at ELSE r.created_at END FROM records r WHERE r.id=pickup_tasks.id)";

  const hasLegacyRecords = tableExists(db, 'records');
  const hasLegacyLogs = tableExists(db, 'record_status_log');
  if (hasLegacyRecords) {
    // 1) legacy 任务行：由 records（北京时间文本）幂等对齐为 UTC
    db.prepare(`UPDATE pickup_tasks SET
      created_at = COALESCE(datetime(${taskSrcCreated}, '-8 hours'), pickup_tasks.created_at),
      dispatch_at = COALESCE(datetime(${taskSrcCreated}, '-8 hours'), pickup_tasks.dispatch_at),
      completed_at = CASE WHEN COALESCE(${taskSrcCompleted},'')='' THEN pickup_tasks.completed_at
        ELSE COALESCE(datetime(${taskSrcCompleted}, '-8 hours'), pickup_tasks.completed_at) END,
      updated_at = COALESCE(datetime(${taskSrcUpdated}, '-8 hours'), pickup_tasks.updated_at)
    WHERE id IN (SELECT id FROM records)`).run();

  }
  // 2) legacy 明细行（id = legacy-item:<records.id>）
  if (hasLegacyRecords) db.prepare(`UPDATE pickup_items SET
      created_at = COALESCE(datetime((SELECT r.created_at FROM records r WHERE r.id=substr(pickup_items.id,13)), '-8 hours'), pickup_items.created_at),
      updated_at = COALESCE(datetime((SELECT CASE WHEN r.completed_at IS NOT NULL AND r.completed_at<>'' THEN r.completed_at ELSE r.created_at END FROM records r WHERE r.id=substr(pickup_items.id,13)), '-8 hours'), pickup_items.updated_at)
    WHERE id LIKE 'legacy-item:%'`).run();
  // 3) legacy 照片行：货品照片对齐任务 created_at；取件照片对齐任务 completed_at/created_at
  if (hasLegacyRecords) {
    db.prepare(`UPDATE pickup_photos SET created_at = COALESCE(
        (SELECT t.created_at FROM pickup_tasks t WHERE t.id=pickup_photos.task_id), pickup_photos.created_at)
      WHERE id LIKE 'legacy:goods:%'`).run();
    db.prepare(`UPDATE pickup_photos SET created_at = COALESCE(
        (SELECT CASE WHEN t.completed_at IS NOT NULL AND t.completed_at<>'' THEN t.completed_at ELSE t.created_at END
         FROM pickup_tasks t WHERE t.id=pickup_photos.task_id), pickup_photos.created_at)
      WHERE id LIKE 'legacy:pickup:%'`).run();
  }
  // 4) legacy 事件行：由 record_status_log（北京时间文本）幂等对齐为 UTC
  if (hasLegacyLogs) {
    db.prepare(`UPDATE task_events SET created_at = COALESCE(
        datetime((SELECT created_at FROM record_status_log WHERE id=task_events.id), '-8 hours'),
        task_events.created_at)
      WHERE id IN (SELECT id FROM record_status_log)`).run();
  }

  // 5) 一次性修正：任务模型上线初期 v1 补录明细/照片产生的北京时间错写行。
  //    判定：created_at 比同任务 created_at 晚约 8~12 小时（真实北京文本的固有 +8 特征）。
  if (!hasVersion(5)) {
    const legacyLogExclusion = hasLegacyLogs ? "AND id NOT IN (SELECT id FROM record_status_log) " : "";
    // 先修事件（依赖尚未修正的明细行做同刻配对），再修明细，最后修照片
    db.prepare(`UPDATE task_events SET created_at = datetime(created_at, '-8 hours')
      WHERE event_type='item_added' AND created_at<>'' ${legacyLogExclusion}
        AND (julianday(created_at)-julianday((SELECT t.created_at FROM pickup_tasks t WHERE t.id=task_events.task_id)))*24 BETWEEN 7.9 AND 12.1
        AND EXISTS (SELECT 1 FROM pickup_items i
          WHERE i.task_id=task_events.task_id AND i.created_at=task_events.created_at)`).run();
    db.prepare(`UPDATE pickup_items SET
        created_at = datetime(created_at, '-8 hours'),
        updated_at = CASE
          WHEN updated_at IS NULL OR updated_at='' THEN ''
          WHEN updated_at = created_at THEN datetime(created_at, '-8 hours')
          ELSE COALESCE(datetime(updated_at, '-8 hours'), updated_at) END
      WHERE id NOT LIKE 'legacy-item:%' AND created_at<>''
        AND (julianday(created_at)-julianday((SELECT t.created_at FROM pickup_tasks t WHERE t.id=pickup_items.task_id)))*24 BETWEEN 7.9 AND 12.1`).run();
    db.prepare(`UPDATE pickup_photos SET created_at = datetime(created_at, '-8 hours')
      WHERE id NOT LIKE 'legacy:%' AND created_at<>''
        AND (julianday(created_at)-julianday((SELECT t.created_at FROM pickup_tasks t WHERE t.id=pickup_photos.task_id)))*24 BETWEEN 7.9 AND 12.5`).run();
    db.prepare("INSERT INTO schema_migrations (version,applied_at) VALUES (5,datetime('now'))").run();
  }
}

function migrate(db) {
  const migration = db.transaction(() => {
    db.pragma('foreign_keys = ON');
    createSchema(db);
    migrateLegacyRecords(db);
    migrateTaskTimestamps(db);
  });
  migration();
  return db;
}

module.exports = { migrate, STATUS_MAP };

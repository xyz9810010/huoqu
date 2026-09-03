const { randomUUID } = require('node:crypto');

function safeJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    recipientUserId: row.user_id,
    type: row.notification_type,
    title: row.title,
    body: row.body || '',
    data: safeJson(row.data),
    priority: row.priority || 'normal',
    dedupeKey: row.dedupe_key || '',
    expiresAt: row.expires_at || '',
    read: Boolean(row.is_read),
    readAt: row.read_at || '',
    createdAt: row.created_at
  };
}

function createNotificationRepository(db, options = {}) {
  const createId = options.id || randomUUID;
  const now = options.now || (() => new Date().toISOString());
  const findDedupeStatement = db.prepare(`SELECT * FROM notifications
    WHERE user_id=? AND dedupe_key=? LIMIT 1`);
  const findIdStatement = db.prepare('SELECT * FROM notifications WHERE id=?');
  const insertNotification = db.prepare(`INSERT INTO notifications
    (id,user_id,notification_type,title,body,data,is_read,priority,dedupe_key,expires_at,read_at,created_at)
    VALUES (?,?,?,?,?,?,0,?,?,?,?,?)`);
  const insertDelivery = db.prepare(`INSERT INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,next_attempt_at,sent_at,created_at)
    VALUES (?,?,?,'in_app','in_app','sent',?,?,?)`);
  const enabledSubscriptions = db.prepare(`SELECT s.id,s.channel,s.provider_code
    FROM notification_subscriptions s
    LEFT JOIN notification_preferences p
      ON p.user_id=s.user_id AND p.notification_type=? AND p.channel=s.channel
    WHERE s.user_id=? AND s.status='active' AND COALESCE(p.enabled,1)=1`);
  const insertPendingDelivery = db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (id,notification_id,subscription_id,channel,provider_code,status,next_attempt_at,created_at)
    VALUES (?,?,?,?,?,'pending',?,?)`);

  const insertTransaction = db.transaction(input => {
    const createdAt = now();
    const id = createId();
    insertNotification.run(
      id,
      input.recipientUserId,
      input.type,
      input.title,
      input.body || '',
      JSON.stringify(input.data || {}),
      input.priority || 'normal',
      input.dedupeKey || '',
      input.expiresAt || '',
      '',
      createdAt
    );
    insertDelivery.run(createId(), id, '', createdAt, createdAt, createdAt);
    for (const subscription of enabledSubscriptions.all(input.type, input.recipientUserId)) {
      insertPendingDelivery.run(
        createId(), id, subscription.id, subscription.channel,
        subscription.provider_code, createdAt, createdAt
      );
    }
    return rowNotification(findIdStatement.get(id));
  });

  function findByDedupe(userId, dedupeKey) {
    if (!dedupeKey) return null;
    return rowNotification(findDedupeStatement.get(userId, dedupeKey));
  }

  function insert(input) {
    try {
      return insertTransaction(input);
    } catch (error) {
      if (input.dedupeKey && error && String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const existing = findByDedupe(input.recipientUserId, input.dedupeKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  function listForUser(userId, query = {}) {
    const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize || '20', 10) || 20));
    const conditions = ['user_id=?'];
    const params = [userId];
    if (query.unread === true || query.unread === 'true' || query.unread === '1') conditions.push('is_read=0');
    if (query.type) {
      conditions.push('notification_type=?');
      params.push(String(query.type));
    }
    const where = conditions.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE ${where}`).get(...params).count;
    const rows = db.prepare(`SELECT * FROM notifications WHERE ${where}
      ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map(rowNotification), total, page, pageSize };
  }

  return {
    insert,
    findByDedupe,
    findById(id) {
      return rowNotification(findIdStatement.get(id));
    },
    listForUser,
    unreadCount(userId) {
      return db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0').get(userId).count;
    },
    markRead(userId, id) {
      return db.prepare(`UPDATE notifications SET is_read=1,read_at=?
        WHERE id=? AND user_id=? AND is_read=0`).run(now(), id, userId);
    },
    markAllRead(userId) {
      return db.prepare(`UPDATE notifications SET is_read=1,read_at=?
        WHERE user_id=? AND is_read=0`).run(now(), userId);
    }
  };
}

module.exports = { createNotificationRepository, rowNotification };

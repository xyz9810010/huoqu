const { createHash, randomUUID } = require('node:crypto');

function fingerprint(secret) {
  const target = String((secret && (secret.endpoint || secret.token)) || '').trim();
  if (!target) throw new Error('推送订阅缺少 endpoint 或 token');
  return createHash('sha256').update(target).digest('hex');
}

function publicSubscription(row) {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    providerCode: row.provider_code,
    platform: row.platform || '',
    deviceLabel: row.device_label || '',
    appVersion: row.app_version || '',
    status: row.status,
    lastSeenAt: row.last_seen_at || '',
    createdAt: row.created_at
  };
}

function createSubscriptionStore(db, secretBox, options = {}) {
  const createId = options.id || randomUUID;
  const now = options.now || (() => new Date().toISOString());
  const findById = db.prepare('SELECT * FROM notification_subscriptions WHERE id=?');
  const findByTarget = db.prepare(`SELECT * FROM notification_subscriptions
    WHERE provider_code=? AND target_fingerprint=?`);
  const upsert = db.prepare(`INSERT INTO notification_subscriptions
    (id,user_id,channel,provider_code,secret_encrypted,target_fingerprint,platform,device_label,app_version,role,courier_id,status,last_seen_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
    ON CONFLICT(provider_code,target_fingerprint) DO UPDATE SET
      user_id=excluded.user_id,channel=excluded.channel,secret_encrypted=excluded.secret_encrypted,
      platform=excluded.platform,device_label=excluded.device_label,app_version=excluded.app_version,
      role=excluded.role,courier_id=excluded.courier_id,status='active',invalidated_at='',
      last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`);
  const activeVendorForUser = db.prepare(`SELECT id FROM notification_subscriptions
    WHERE channel='vendor_push' AND status='active' AND user_id=? AND provider_code=? AND id<>?`);
  const supersedeActive = db.prepare(`UPDATE notification_subscriptions
    SET status='invalid', invalidated_at=?, updated_at=? WHERE id=?`);
  const failSupersededDeliveries = db.prepare(`UPDATE notification_deliveries
    SET status='failed', locked_at='', next_attempt_at='', last_error_code='TARGET_SUPERSEDED', last_error_message=''
    WHERE subscription_id=? AND status IN ('pending','processing')`);

  function register(input) {
    const userId = String(input.userId || '').trim();
    const channel = String(input.channel || '').trim();
    const providerCode = String(input.providerCode || '').trim();
    if (!userId || !channel || !providerCode) throw new Error('推送订阅信息不完整');
    const targetFingerprint = fingerprint(input.secret);
    const timestamp = now();
    upsert.run(
      createId(), userId, channel, providerCode, secretBox.seal(input.secret), targetFingerprint,
      String(input.platform || ''), String(input.deviceLabel || ''), String(input.appVersion || ''),
      String(input.role || ''), String(input.courierId || ''), timestamp, timestamp, timestamp
    );
    const registered = findByTarget.get(providerCode, targetFingerprint);
    if (channel === 'vendor_push') {
      // 手机推送按“一个用户一台工作手机”策略：新登记取代该用户同供应商的旧登记，
      // 避免旧 token 残留导致一次派单在鸿蒙/安卓端收到重复推送。
      for (const stale of activeVendorForUser.all(userId, providerCode, registered.id)) {
        supersedeActive.run(timestamp, timestamp, stale.id);
        failSupersededDeliveries.run(stale.id);
      }
    }
    return publicSubscription(registered);
  }

  function tableExists(table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }

  return {
    register,
    listForUser(userId) {
      return db.prepare(`SELECT * FROM notification_subscriptions WHERE user_id=?
        ORDER BY updated_at DESC`).all(userId).map(publicSubscription);
    },
    getDecrypted(id) {
      const row = findById.get(id);
      return row ? { ...publicSubscription(row), secret: secretBox.open(row.secret_encrypted) } : null;
    },
    remove(userId, id) {
      return db.prepare('DELETE FROM notification_subscriptions WHERE id=? AND user_id=?').run(id, userId);
    },
    removeProviderForUser(userId, providerCode) {
      return db.prepare('DELETE FROM notification_subscriptions WHERE user_id=? AND provider_code=?')
        .run(userId, providerCode);
    },
    invalidate(id) {
      const timestamp = now();
      return db.prepare(`UPDATE notification_subscriptions
        SET status='invalid',invalidated_at=?,updated_at=? WHERE id=?`).run(timestamp, timestamp, id);
    },
    migrateLegacyTokens() {
      if (!tableExists('push_tokens')) return 0;
      let inserted = 0;
      for (const row of db.prepare('SELECT * FROM push_tokens').all()) {
        const targetFingerprint = fingerprint({ token: row.token });
        if (findByTarget.get('huawei', targetFingerprint)) continue;
        register({
          userId: row.user_id,
          channel: 'vendor_push',
          providerCode: 'huawei',
          platform: 'harmonyos',
          deviceLabel: 'HarmonyOS 设备',
          role: row.role || '',
          courierId: row.courier_id || '',
          secret: { token: row.token }
        });
        inserted += 1;
      }
      return inserted;
    }
  };
}

module.exports = { createSubscriptionStore, publicSubscription };

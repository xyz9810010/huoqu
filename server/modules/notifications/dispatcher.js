const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

function createDispatcher(options) {
  const { db, registry, providerConfigs, subscriptions } = options;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const pollMs = options.pollMs || 1_000;
  let timer = null;
  let activeRun = null;

  const claim = db.transaction(currentIso => {
    const row = db.prepare(`SELECT d.*,n.user_id,n.notification_type,n.title,n.body,n.data,
      n.priority,n.expires_at,n.created_at AS notification_created_at
      FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.status='pending' AND d.channel<>'in_app' AND d.next_attempt_at<=?
      ORDER BY d.next_attempt_at,d.created_at LIMIT 1`).get(currentIso);
    if (!row) return null;
    const updated = db.prepare(`UPDATE notification_deliveries SET status='processing',locked_at=?
      WHERE id=? AND status='pending'`).run(currentIso, row.id);
    return updated.changes === 1 ? row : null;
  });

  function finish(id, fields) {
    db.prepare(`UPDATE notification_deliveries SET status=@status,attempt_count=@attemptCount,
      next_attempt_at=@nextAttemptAt,provider_message_id=@providerMessageId,
      last_error_code=@lastErrorCode,last_error_message='',sent_at=@sentAt,locked_at=''
      WHERE id=@id`).run({
        id,
        status: fields.status,
        attemptCount: fields.attemptCount,
        nextAttemptAt: fields.nextAttemptAt || '',
        providerMessageId: fields.providerMessageId || '',
        lastErrorCode: fields.lastErrorCode || '',
        sentAt: fields.sentAt || ''
      });
  }

  function retry(row, code) {
    const attemptCount = row.attempt_count + 1;
    if (attemptCount >= RETRY_DELAYS_MS.length) {
      finish(row.id, { status: 'failed', attemptCount, lastErrorCode: code });
      return;
    }
    const base = RETRY_DELAYS_MS[attemptCount - 1];
    const jittered = Math.round(base * (0.9 + random() * 0.2));
    finish(row.id, {
      status: 'pending', attemptCount, lastErrorCode: code,
      nextAttemptAt: new Date(now() + jittered).toISOString()
    });
  }

  async function runOnce() {
    const row = claim(new Date(now()).toISOString());
    if (!row) return false;
    if (row.expires_at && Date.parse(row.expires_at) <= now()) {
      finish(row.id, { status: 'expired', attemptCount: row.attempt_count });
      return true;
    }
    const adapter = registry.get(row.provider_code);
    const activeConfig = providerConfigs.getActive(row.provider_code);
    const target = subscriptions.getDecrypted(row.subscription_id);
    if (!adapter || !activeConfig || !target || target.status !== 'active') {
      retry(row, !adapter ? 'PROVIDER_NOT_INSTALLED' : (!activeConfig ? 'PROVIDER_NOT_ACTIVE' : 'TARGET_NOT_ACTIVE'));
      return true;
    }
    const message = {
      id: row.notification_id,
      type: row.notification_type,
      title: row.title,
      body: row.body || '',
      data: (() => { try { return JSON.parse(row.data || '{}'); } catch { return {}; } })(),
      priority: row.priority || 'normal',
      expiresAt: row.expires_at || '',
      createdAt: row.notification_created_at
    };
    try {
      const results = await adapter.send(message, [target], activeConfig.credentials);
      const result = Array.isArray(results) ? results[0] : null;
      const attemptCount = row.attempt_count + 1;
      if (result && result.status === 'sent') {
        finish(row.id, {
          status: 'sent', attemptCount, providerMessageId: result.providerMessageId,
          sentAt: new Date(now()).toISOString()
        });
      } else if (result && result.status === 'invalid_target') {
        subscriptions.invalidate(row.subscription_id);
        finish(row.id, { status: 'failed', attemptCount, lastErrorCode: result.code || 'TARGET_INVALID' });
      } else if (result && result.status === 'retryable') {
        retry(row, result.code || 'PROVIDER_TEMPORARY');
      } else {
        finish(row.id, { status: 'failed', attemptCount, lastErrorCode: (result && result.code) || 'PROVIDER_REJECTED' });
      }
    } catch (error) {
      const normalized = adapter.normalizeError(error) || {};
      if (normalized.status === 'invalid_target') {
        subscriptions.invalidate(row.subscription_id);
        finish(row.id, { status: 'failed', attemptCount: row.attempt_count + 1, lastErrorCode: normalized.code || 'TARGET_INVALID' });
      } else if (normalized.status === 'retryable') {
        retry(row, normalized.code || 'PROVIDER_TEMPORARY');
      } else {
        finish(row.id, { status: 'failed', attemptCount: row.attempt_count + 1, lastErrorCode: normalized.code || 'PROVIDER_ERROR' });
      }
    }
    return true;
  }

  function recoverStale() {
    const stale = new Date(now() - 10 * 60_000).toISOString();
    db.prepare(`UPDATE notification_deliveries SET status='pending',locked_at=''
      WHERE status='processing' AND locked_at<?`).run(stale);
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      recoverStale();
      timer = setInterval(() => {
        if (activeRun) return;
        activeRun = runOnce().finally(() => { activeRun = null; });
      }, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (activeRun) await activeRun;
    }
  };
}

module.exports = { createDispatcher, RETRY_DELAYS_MS };

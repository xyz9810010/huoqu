function createPreferenceStore(db, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const find = db.prepare(`SELECT * FROM notification_preferences
    WHERE user_id=? AND notification_type=? AND channel=?`);
  return {
    isEnabled(userId, type, channel) {
      const row = find.get(userId, type, channel);
      return row ? Boolean(row.enabled) : true;
    },
    set(userId, type, channel, enabled, quiet = {}) {
      db.prepare(`INSERT INTO notification_preferences
        (user_id,notification_type,channel,enabled,quiet_start,quiet_end,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id,notification_type,channel) DO UPDATE SET
          enabled=excluded.enabled,quiet_start=excluded.quiet_start,
          quiet_end=excluded.quiet_end,updated_at=excluded.updated_at`).run(
            userId, type, channel, enabled ? 1 : 0,
            String(quiet.start || ''), String(quiet.end || ''), now()
          );
      return this.isEnabled(userId, type, channel);
    },
    listForUser(userId) {
      return db.prepare(`SELECT notification_type AS type,channel,enabled,quiet_start AS quietStart,
        quiet_end AS quietEnd,updated_at AS updatedAt FROM notification_preferences
        WHERE user_id=? ORDER BY notification_type,channel`).all(userId)
        .map(row => ({ ...row, enabled: Boolean(row.enabled) }));
    }
  };
}

module.exports = { createPreferenceStore };

const { createHash, randomBytes } = require('node:crypto');

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function createSseTicketStore(db, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs || 30_000;

  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_sse_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_sse_tickets_expiry
      ON notification_sse_tickets(expires_at_ms);
  `);

  const insert = db.prepare(`INSERT INTO notification_sse_tickets
    (ticket_hash,user_id,session_hash,expires_at_ms,created_at_ms)
    VALUES (?,?,?,?,?)`);
  const findTicket = db.prepare(`SELECT * FROM notification_sse_tickets
    WHERE ticket_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>=?`);
  const consumeTicket = db.prepare(`UPDATE notification_sse_tickets SET consumed_at_ms=?
    WHERE ticket_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>=?`);
  const activeSessions = db.prepare('SELECT token FROM sessions WHERE user_id=? AND expires_at>?');
  const findSession = db.prepare('SELECT user_id,expires_at FROM sessions WHERE token=?');
  const prune = db.prepare('DELETE FROM notification_sse_tickets WHERE expires_at_ms<?');

  function issue(session) {
    const current = now();
    const row = findSession.get(session.token);
    if (!row || row.user_id !== session.userId || Date.parse(row.expires_at) <= current) {
      throw new Error('会话与用户不匹配或已过期');
    }
    prune.run(current);
    const ticket = randomBytes(32).toString('base64url');
    insert.run(digest(ticket), session.userId, digest(session.token), current + ttlMs, current);
    return ticket;
  }

  const consumeTransaction = db.transaction(ticket => {
    const current = now();
    const ticketHash = digest(ticket);
    const row = findTicket.get(ticketHash, current);
    if (!row) return null;
    const sessionIsActive = activeSessions
      .all(row.user_id, new Date(current).toISOString())
      .some(session => digest(session.token) === row.session_hash);
    if (!sessionIsActive) return null;
    const updated = consumeTicket.run(current, ticketHash, current);
    return updated.changes === 1 ? { userId: row.user_id } : null;
  });

  return {
    issue,
    consume(ticket) {
      if (!ticket || String(ticket).length > 256) return null;
      return consumeTransaction(String(ticket));
    }
  };
}

module.exports = { createSseTicketStore };

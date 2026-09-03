const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createSseTicketStore } = require('../server/modules/notifications/sse-tickets');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)')
    .run('session-a', 'u1', '2026-09-03T06:00:00.000Z');
  let now = Date.parse('2026-09-02T06:00:00.000Z');
  const store = createSseTicketStore(db, { now: () => now, ttlMs: 30_000 });
  return { db, store, advance: ms => { now += ms; } };
}

test('SSE ticket is random, stored only as a digest, and single-use', () => {
  const { db, store } = fixture();
  const ticket = store.issue({ token: 'session-a', userId: 'u1' });

  assert.equal(typeof ticket, 'string');
  assert.ok(ticket.length >= 32);
  const row = db.prepare('SELECT ticket_hash FROM notification_sse_tickets').get();
  assert.notEqual(row.ticket_hash, ticket);
  assert.equal(store.consume(ticket).userId, 'u1');
  assert.equal(store.consume(ticket), null);
  db.close();
});

test('SSE ticket expires and cannot outlive its login session', () => {
  const first = fixture();
  const expiredTicket = first.store.issue({ token: 'session-a', userId: 'u1' });
  first.advance(30_001);
  assert.equal(first.store.consume(expiredTicket), null);
  first.db.close();

  const second = fixture();
  const revokedTicket = second.store.issue({ token: 'session-a', userId: 'u1' });
  second.db.prepare('DELETE FROM sessions WHERE token=?').run('session-a');
  assert.equal(second.store.consume(revokedTicket), null);
  second.db.close();
});

test('SSE ticket issuance rejects a mismatched session owner', () => {
  const { db, store } = fixture();
  assert.throws(
    () => store.issue({ token: 'session-a', userId: 'u2' }),
    /会话与用户不匹配/
  );
  db.close();
});

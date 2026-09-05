// 认证与密码工具（使用 Node 内置 crypto，无外部安全依赖）
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const db = require('./db');

// ---------- 密码哈希 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function createSalt() { return crypto.randomBytes(16).toString('hex'); }

// ---------- 登录限速（按 用户名+来源IP 记账，内存态，无外部依赖） ----------
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const loginFailures = new Map();

function loginFailureKey(username, ip) {
  return String(username || '').trim().toLowerCase() + '|' + String(ip || '').replace('::ffff:', '');
}

function pruneLoginFailures() {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) loginFailures.delete(key);
  }
}

function loginBlockedSeconds(username, ip) {
  const entry = loginFailures.get(loginFailureKey(username, ip));
  if (!entry) return 0;
  const elapsed = Date.now() - entry.firstAt;
  if (elapsed > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(loginFailureKey(username, ip));
    return 0;
  }
  if (entry.count < MAX_LOGIN_FAILURES) return 0;
  return Math.max(1, Math.ceil((LOGIN_FAILURE_WINDOW_MS - elapsed) / 1000));
}

function noteLoginFailure(username, ip) {
  const key = loginFailureKey(username, ip);
  const entry = loginFailures.get(key);
  const now = Date.now();
  if (!entry || now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
    loginFailures.set(key, entry);
  }
  if (loginFailures.size > 2000) pruneLoginFailures();
  return loginBlockedSeconds(username, ip);
}

function clearLoginFailures(username, ip) {
  loginFailures.delete(loginFailureKey(username, ip));
}

// ---------- 会话 ----------
const SESSION_TTL_DAYS = 30;
function createSession(userId) {
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000)
    .toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires);
  return token;
}
function findSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return user || null;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// ---------- 用户 ----------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role,
    courierId: u.courier_id || null, name: u.name || '',
    createdAt: u.created_at || ''
  };
}
function ensureAdmin() {
  const admin = db.prepare('SELECT * FROM users WHERE role = ? LIMIT 1').get('admin');
  if (!admin) {
    const initialPassword = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    if (initialPassword.length < 12) {
      const error = new Error('首次部署必须设置至少12位的 INITIAL_ADMIN_PASSWORD');
      error.code = 'INITIAL_ADMIN_PASSWORD_REQUIRED';
      throw error;
    }
    const salt = createSalt();
    db.prepare(`INSERT INTO users (id, username, password_hash, salt, role, name)
      VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), 'admin', hashPassword(initialPassword, salt), salt, 'admin', '系统管理员');
    console.log('已创建初始管理员账号：admin（密码来自安全环境配置）');
    return { created: true };
  }
  return { created: false };
}
function verifyLogin(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u) return null;
  const hash = hashPassword(password, u.salt);
  if (hash !== u.password_hash) return null;
  return u;
}

module.exports = {
  hashPassword, createSalt, createSession, findSession, destroySession,
  pruneSessions, publicUser, ensureAdmin, verifyLogin,
  loginBlockedSeconds, noteLoginFailure, clearLoginFailures,
  LOGIN_FAILURE_WINDOW_MS, MAX_LOGIN_FAILURES
};

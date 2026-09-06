// 登录时间限制：按角色（cs/courier）限制允许登录的星期与时间段，管理员可编辑。
const db = require('../../db');

const pad = (n) => (n < 10 ? '0' + n : '' + n);

// 北京时间（UTC+8）星期与时分
function beijingClock(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();                 // 0=周日..6=周六
  const weekday = day === 0 ? 7 : day;        // 1=周一..7=周日
  const hhmm = pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes());
  return { weekday, hhmm };
}

function getRestriction(role) {
  const row = db.prepare('SELECT * FROM login_restrictions WHERE role=?').get(role);
  if (!row) return null;
  return {
    role: row.role,
    weekdays: row.weekdays || '',
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    enabled: Boolean(row.enabled)
  };
}

// 判断角色当前是否允许登录
function checkLoginAllowed(role, now = new Date()) {
  const restriction = getRestriction(role);
  if (!restriction || !restriction.enabled) {
    return { allowed: true, reason: '' };
  }
  const { weekday, hhmm } = beijingClock(now);
  const days = restriction.weekdays.split(',').map(s => s.trim()).filter(Boolean);
  if (days.length > 0 && !days.includes(String(weekday))) {
    return { allowed: false, reason: '当前不在允许登录的日期（休息日不可登录）' };
  }
  if (restriction.startTime || restriction.endTime) {
    const start = restriction.startTime || '00:00';
    const end = restriction.endTime || '23:59';
    if (hhmm < start || hhmm >= end) {
      return { allowed: false, reason: '当前不在允许登录的时间段（' + start + '~' + end + '）' };
    }
  }
  return { allowed: true, reason: '' };
}

function listRestrictions() {
  const rows = db.prepare('SELECT * FROM login_restrictions ORDER BY role').all();
  return rows.map(row => ({
    role: row.role,
    weekdays: row.weekdays || '',
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    enabled: Boolean(row.enabled)
  }));
}

function saveRestriction(role, input) {
  const weekdays = String(input.weekdays || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
  const startTime = String(input.startTime || '').trim();
  const endTime = String(input.endTime || '').trim();
  const enabled = input.enabled ? 1 : 0;
  db.prepare(`INSERT INTO login_restrictions (role,weekdays,start_time,end_time,enabled) VALUES (?,?,?,?,?)
    ON CONFLICT(role) DO UPDATE SET weekdays=excluded.weekdays,start_time=excluded.start_time,
    end_time=excluded.end_time,enabled=excluded.enabled`)
    .run(role, weekdays, startTime, endTime, enabled);
  return getRestriction(role);
}

module.exports = { checkLoginAllowed, listRestrictions, saveRestriction, getRestriction };

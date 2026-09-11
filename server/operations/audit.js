const { randomUUID } = require('node:crypto');

/**
 * 操作日志：v1/v2 共用同一张 operation_logs 表与北京时间口径。
 *
 * 时间来源由调用方注入（v1 用 server/time.js 的 nowStr，v2 用自己的北京时间格式化），
 * 保证同一条日志在两条路由下格式一致，便于运营按天检索。
 */
function createAuditLogger(db, now) {
  const insert = db.prepare(`INSERT INTO operation_logs (id,user_id,user_name,action,target_type,target_id,detail,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  return function logOperation(user, action, targetType = '', targetId = '', detail = '') {
    insert.run(
      randomUUID(),
      user?.id || '',
      user?.name || user?.username || '',
      action,
      targetType,
      targetId,
      detail,
      now()
    );
  };
}

module.exports = { createAuditLogger };

// 通知/投递/失效订阅保留策略（P2）：
//   1. 已读通知保留 N 天后清理（未读不做清理，避免误删未读角标数据）；
//   2. 终态投递记录（sent/failed/expired）保留 M 天后清理，重试中的 pending/processing 不清理；
//   3. 失效订阅（服务端已确认目标不可达并 invalid 化）保留 K 天后清理，客户端“删旧建新”后旧行自然过期。
// 默认 180/90/30 天，可用环境变量覆盖；服务启动先跑一次，随后每 24 小时跑一次。
const MS_DAY = 24 * 3600 * 1000;

function envDays(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function createNotificationRetention(db, options = {}) {
  const notificationKeepDays = options.notificationKeepDays !== undefined
    ? options.notificationKeepDays : envDays('NOTIFICATION_RETENTION_DAYS', 180);
  const deliveryKeepDays = options.deliveryKeepDays !== undefined
    ? options.deliveryKeepDays : envDays('NOTIFICATION_DELIVERY_RETENTION_DAYS', 90);
  const invalidSubscriptionKeepDays = options.invalidSubscriptionKeepDays !== undefined
    ? options.invalidSubscriptionKeepDays : envDays('NOTIFICATION_SUBSCRIPTION_RETENTION_DAYS', 30);
  const intervalMs = options.intervalMs !== undefined
    ? options.intervalMs : (envDays('NOTIFICATION_RETENTION_INTERVAL_HOURS', 24) * 3600 * 1000);
  const now = options.now || (() => new Date().toISOString());
  let timer = null;

  function run() {
    const current = now();
    const cutoff = daysAgo => {
      const date = new Date(Date.parse(current) - daysAgo * MS_DAY);
      return date.toISOString();
    };
    return db.transaction(() => {
      const notifications = db.prepare(
        `DELETE FROM notifications WHERE is_read=1
         AND COALESCE(NULLIF(read_at,''),created_at) < ?`).run(cutoff(notificationKeepDays)).changes;
      const deliveries = db.prepare(
        `DELETE FROM notification_deliveries WHERE status IN ('sent','failed','expired')
         AND created_at < ?`).run(cutoff(deliveryKeepDays)).changes;
      const subscriptions = db.prepare(
        `DELETE FROM notification_subscriptions WHERE status='invalid'
         AND invalidated_at<>'' AND invalidated_at < ?`).run(cutoff(invalidSubscriptionKeepDays)).changes;
      return { notifications, deliveries, subscriptions };
    })();
  }

  function start() {
    if (timer) return false;
    try { run(); } catch (error) { /* 启动清理失败不阻塞服务 */ }
    timer = setInterval(() => {
      try { run(); } catch (_) { /* 周期清理失败静默，等待下一轮 */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { run, start, stop };
}

module.exports = { createNotificationRetention };

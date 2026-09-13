// 看板聚合查询（v1 与 v2 共用）。
//
// 这些查询在 v1 里是逐人查询的写法，v2 早期又抄了一份；两处一旦不同就会出现
// "同一块看板两个端数字不一样"。集中到这里后，两端只可能一致。
'use strict';

const fc = require('../security/field-crypto');

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

/** 取件员排行：任务数/客户数/件数/重量/协助/待取（按 default_worker 聚合） */
function dashboardWorkers(db) {
  const taskAgg = db.prepare(`SELECT default_worker_id AS cid,
      COUNT(*) AS taskCount,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completedCount,
      SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS activeCount
    FROM pickup_tasks WHERE default_worker_id<>'' GROUP BY default_worker_id`).all();
  // customer_name_snap 已加密：客户数按取件员内存解密去重
  const custByWorker = new Map();
  for (const r of db.prepare(`SELECT default_worker_id AS cid, customer_id, customer_name_snap FROM pickup_tasks WHERE default_worker_id<>''`).all()) {
    if (!custByWorker.has(r.cid)) custByWorker.set(r.cid, new Set());
    custByWorker.get(r.cid).add((r.customer_id || '') + '|' + fc.decryptField(r.customer_name_snap));
  }
  const itemAgg = db.prepare(`SELECT t.default_worker_id AS cid,
      COALESCE(SUM(i.pieces),0) AS pieces, COALESCE(SUM(i.final_weight),0) AS weight
    FROM pickup_items i JOIN pickup_tasks t ON t.id=i.task_id
    WHERE t.default_worker_id<>'' GROUP BY t.default_worker_id`).all();
  const assistAgg = db.prepare(`SELECT a.worker_id AS cid, COUNT(DISTINCT t.id) AS n
    FROM task_assistants a JOIN pickup_tasks t ON t.id=a.task_id
    WHERE t.status='completed' GROUP BY a.worker_id`).all();
  const taskMap = new Map(taskAgg.map(row => [row.cid, row]));
  const itemMap = new Map(itemAgg.map(row => [row.cid, row]));
  const assistMap = new Map(assistAgg.map(row => [row.cid, row.n]));
  return db.prepare('SELECT * FROM couriers ORDER BY name').all().map(worker => {
    const tasks = taskMap.get(worker.id) || {};
    const items = itemMap.get(worker.id) || {};
    return {
      id: worker.id,
      name: worker.name,
      pickupCount: Number(tasks.completedCount || 0),
      customerCount: (custByWorker.get(worker.id) || new Set()).size,
      pieces: Number(items.pieces || 0),
      weight: num(items.weight || 0),
      assistCount: assistMap.get(worker.id) || 0,
      pending: Number(tasks.activeCount || 0)
    };
  });
}

/** 客服数据：负责客户数 / 派单任务数 */
function dashboardCs(db) {
  const users = db.prepare("SELECT * FROM users WHERE role='cs' ORDER BY name").all();
  return users.map(user => {
    const taskRows = db.prepare('SELECT * FROM pickup_tasks WHERE dispatch_cs_id=?').all(user.id);
    return {
      id: user.id,
      name: user.name || user.username,
      customerCount: new Set(taskRows.map(r => r.customer_id)).size,
      shipCustomerCount: 0,
      taskCount: taskRows.length,
      weight: 0
    };
  });
}

/** 客户排行：按任务数取前 20 */
function dashboardCustomers(db) {
  const custRows = db.prepare('SELECT customer_id, customer_name_snap FROM pickup_tasks').all();
  const agg = new Map();
  for (const r of custRows) {
    const name = fc.decryptField(r.customer_name_snap);
    const key = r.customer_id + '|' + name;
    if (!agg.has(key)) agg.set(key, { id: r.customer_id, name, taskCount: 0 });
    agg.get(key).taskCount += 1;
  }
  return [...agg.values()]
    .sort((a, b) => b.taskCount - a.taskCount)
    .slice(0, 20)
    .map(row => ({ ...row, weight: 0 }));
}

/** 近 N 天出货重量趋势（默认 30 天，按创建时间 +8 小时归日） */
function dashboardTrends(db, days = 30) {
  const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
  const weight = db.prepare(`SELECT date(t.created_at,'+8 hours') AS date,
      ROUND(COALESCE(SUM(i.final_weight),0),2) AS weight
    FROM pickup_tasks t LEFT JOIN pickup_items i ON i.task_id=t.id
    GROUP BY date(t.created_at,'+8 hours') ORDER BY date DESC LIMIT ?`).all(safeDays).reverse();
  return { weight };
}

module.exports = { dashboardWorkers, dashboardCs, dashboardCustomers, dashboardTrends };

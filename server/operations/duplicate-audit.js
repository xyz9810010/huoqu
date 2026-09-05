// 重复单据稽核（只读）：供运维排查“同业务单号 / 同面单号 / 同秒孪生任务”。
// 背景：新任务模型 business_order_no 未设唯一约束（再次取件是合法业务），
// 客户端幂等键已上线；本模块用于在数据层发现漏网重复，辅助人工处置。
'use strict';

function auditDuplicates(db) {
  const findings = [];

  const orderGroups = db.prepare(`
    SELECT business_order_no AS orderNo, COUNT(*) AS taskCount,
           SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS activeCount
    FROM pickup_tasks
    WHERE business_order_no <> ''
    GROUP BY business_order_no
    HAVING COUNT(*) > 1
    ORDER BY activeCount DESC, taskCount DESC`).all();

  for (const group of orderGroups) {
    const tasks = db.prepare(`
      SELECT id, task_no, status, customer_name_snap AS customerName,
             default_worker_name_snap AS workerName, created_at AS createdAt
      FROM pickup_tasks WHERE business_order_no = ?
      ORDER BY created_at, id`).all(group.orderNo);
    findings.push({
      kind: 'duplicate_business_order_no',
      key: group.orderNo,
      severity: group.activeCount > 0 ? 'high' : 'medium',
      count: group.taskCount,
      activeCount: Number(group.activeCount || 0),
      detail: tasks.map(row => ({
        id: row.id, taskNo: row.task_no, status: row.status,
        customerName: row.customerName, workerName: row.workerName, createdAt: row.createdAt
      }))
    });
  }

  const waybillGroups = db.prepare(`
    SELECT i.waybill_no AS waybillNo, COUNT(DISTINCT i.task_id) AS taskCount,
           SUM(CASE WHEN t.status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS activeCount
    FROM pickup_items i
    JOIN pickup_tasks t ON t.id = i.task_id
    WHERE i.waybill_no <> ''
    GROUP BY i.waybill_no
    HAVING COUNT(DISTINCT i.task_id) > 1
    ORDER BY activeCount DESC, taskCount DESC`).all();

  for (const group of waybillGroups) {
    const items = db.prepare(`
      SELECT i.task_id AS taskId, t.task_no AS taskNo, t.status, i.goods_name AS goodsName,
             i.pieces, i.created_at AS createdAt
      FROM pickup_items i JOIN pickup_tasks t ON t.id = i.task_id
      WHERE i.waybill_no = ?
      ORDER BY i.created_at, i.id`).all(group.waybillNo);
    findings.push({
      kind: 'duplicate_waybill_no',
      key: group.waybillNo,
      severity: group.activeCount > 0 ? 'high' : 'medium',
      count: Number(group.taskCount),
      activeCount: Number(group.activeCount || 0),
      detail: items.map(row => ({
        taskId: row.taskId, taskNo: row.taskNo, status: row.status,
        goodsName: row.goodsName, pieces: row.pieces, createdAt: row.createdAt
      }))
    });
  }

  // 孪生任务：同一客户+同一地址在“同一秒”创建两条，多半是客户端双击/重试未带幂等键
  const twinGroups = db.prepare(`
    SELECT customer_id AS customerId, customer_name_snap AS customerName,
           address_snap AS address, created_at AS createdAt,
           COUNT(*) AS taskCount,
           SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS activeCount
    FROM pickup_tasks
    WHERE customer_name_snap <> ''
    GROUP BY customer_id, customer_name_snap, address_snap, created_at
    HAVING COUNT(*) > 1
    ORDER BY activeCount DESC, taskCount DESC, createdAt DESC`).all();

  for (const group of twinGroups) {
    const tasks = db.prepare(`
      SELECT id, task_no, status, business_order_no AS orderNo, customer_name_snap AS customerName,
             default_worker_name_snap AS workerName, created_at AS createdAt
      FROM pickup_tasks
      WHERE customer_id = ? AND customer_name_snap = ? AND address_snap = ? AND created_at = ?
      ORDER BY id`).all(group.customerId, group.customerName, group.address, group.createdAt);
    findings.push({
      kind: 'twin_tasks_same_second',
      key: `${group.customerName} | ${group.address} | ${group.createdAt}`,
      severity: group.activeCount > 0 ? 'medium' : 'low',
      count: group.taskCount,
      activeCount: Number(group.activeCount || 0),
      detail: tasks.map(row => ({
        id: row.id, taskNo: row.task_no, status: row.status,
        orderNo: row.orderNo, customerName: row.customerName,
        workerName: row.workerName, createdAt: row.createdAt
      }))
    });
  }

  return findings;
}

function renderText(findings) {
  if (!findings.length) return '未发现重复：business_order_no / waybill_no / 同秒孪生任务均唯一。';
  const lines = [];
  for (const finding of findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.kind} key=${finding.key} ` +
      `共 ${finding.count} 条（进行中 ${finding.activeCount}）`);
    for (const row of finding.detail) {
      const label = row.taskNo || row.taskId;
      lines.push(`  - ${label} status=${row.status} customer=${row.customerName || row.goodsName || ''} ` +
        `worker=${row.workerName || ''} createdAt=${row.createdAt || ''} orderNo=${row.orderNo || ''}`);
    }
  }
  return lines.join('\n');
}

module.exports = { auditDuplicates, renderText };

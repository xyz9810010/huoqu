// 重复单据稽核（只读）：供运维排查“同业务单号 / 同面单号 / 同秒孪生任务”。
// 背景：新任务模型 business_order_no 未设唯一约束（再次取件是合法业务），
// 客户端幂等键已上线；本模块用于在数据层发现漏网重复，辅助人工处置。
'use strict';
const fc = require('../security/field-crypto');

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
        customerName: fc.decryptField(row.customerName), workerName: row.workerName, createdAt: row.createdAt
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
  // customer_name_snap/address_snap 已加密：改为内存解密后分组
  const twinRows = db.prepare(`
    SELECT id, task_no, status, business_order_no, customer_id, customer_name_snap, address_snap,
           default_worker_name_snap, created_at
    FROM pickup_tasks WHERE customer_name_snap <> '' ORDER BY created_at DESC, id`).all();
  const twinMap = new Map();
  for (const row of twinRows) {
    const name = fc.decryptField(row.customer_name_snap);
    const addr = fc.decryptField(row.address_snap);
    const key = `${row.customer_id}|${name}|${addr}|${row.created_at}`;
    if (!twinMap.has(key)) twinMap.set(key, { customerName: name, address: addr, createdAt: row.created_at, taskCount: 0, activeCount: 0, tasks: [] });
    const g = twinMap.get(key);
    g.taskCount++;
    if (row.status === 'pending' || row.status === 'in_progress') g.activeCount++;
    g.tasks.push(row);
  }
  for (const g of twinMap.values()) {
    if (g.taskCount <= 1) continue;
    findings.push({
      kind: 'twin_tasks_same_second',
      key: `${g.customerName} | ${g.address} | ${g.createdAt}`,
      severity: g.activeCount > 0 ? 'medium' : 'low',
      count: g.taskCount,
      activeCount: g.activeCount,
      detail: g.tasks.map(row => ({
        id: row.id, taskNo: row.task_no, status: row.status,
        orderNo: row.business_order_no, customerName: fc.decryptField(row.customer_name_snap),
        workerName: row.default_worker_name_snap, createdAt: row.created_at
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

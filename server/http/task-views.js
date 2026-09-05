// v1/v2 共享的任务视图 helper（收敛镜像实现，避免双规范层漂移）。
// 职责边界：只做“数据富化 + 权限判定”，时间字段的本地化/ISO 转换仍由各层负责
// （v1 localizeTaskForWeb → 北京钟面文本；v2 isoTask → ISO8601 UTC）。
function taskVisibleTo(user, task) {
  if (user.role === 'admin' || user.role === 'cs') return true;
  return Boolean(user.courier_id && (
    task.defaultWorkerId === user.courier_id ||
    (Array.isArray(task.assistWorkerIds) && task.assistWorkerIds.includes(user.courier_id))
  ));
}

function enrichTaskDetail(db, tasks, taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return null;
  const courierName = db.prepare('SELECT name FROM couriers WHERE id=?');
  const userRow = db.prepare('SELECT name FROM users WHERE id=?');
  const worker = task.defaultWorkerId ? courierName.get(task.defaultWorkerId) : null;
  const mainCs = task.mainCsId ? userRow.get(task.mainCsId) : null;
  task.defaultWorkerName = task.defaultWorkerName || (worker ? worker.name : '');
  task.mainCsName = mainCs ? mainCs.name : '';
  task.addressPointName = task.areaName || '默认地址';
  task.items = task.items.map(item => {
    const itemWorker = item.workerId ? courierName.get(item.workerId) : null;
    // 快照优先、现查兜底；同名回退兼容旧行为（明细归属非主取件员且档案已删的历史行显示主取件员名）
    return Object.assign(item, { workerName: item.workerNameSnap || (itemWorker ? itemWorker.name : '') || task.defaultWorkerName });
  });
  task.photos = db.prepare('SELECT * FROM pickup_photos WHERE task_id=? ORDER BY created_at,id').all(taskId).map(photo => ({
    id: photo.id, type: photo.photo_type, filename: photo.filename, filePath: '/uploads/' + photo.filename, createdAt: photo.created_at
  }));
  task.exceptions = db.prepare('SELECT * FROM task_exceptions WHERE task_id=? ORDER BY created_at DESC').all(taskId).map(row => ({
    id: row.id, type: row.exception_type, description: row.description, resolved: Boolean(row.resolved),
    resolution: row.resolution, createdAt: row.created_at, resolvedAt: row.resolved_at
  }));
  task.workers = [];
  if (task.defaultWorkerId) task.workers.push({ userId: task.defaultWorkerId, name: task.defaultWorkerName, role: 'primary' });
  for (const assistantId of task.assistWorkerIds || []) {
    const assistant = courierName.get(assistantId);
    const assistantName = task.assistWorkerNames[assistantId] || (assistant ? assistant.name : '');
    if (assistantName) task.workers.push({ userId: assistantId, name: assistantName, role: 'assist' });
  }
  return task;
}

function courierActiveTaskCount(db, courierId) {
  // 主取件员、协助名单或明细归属在任一进行中任务中，都视为档案被占用
  return db.prepare(`SELECT COUNT(*) AS n FROM pickup_tasks WHERE status IN ('pending','in_progress')
    AND (default_worker_id=? OR id IN (SELECT task_id FROM task_assistants WHERE worker_id=?)
      OR id IN (SELECT task_id FROM pickup_items WHERE worker_id=?))`)
    .get(courierId, courierId, courierId).n;
}

function workerStatsWindow(db, courierId, start, end) {
  // 主取件完成口径：completed_at/updated_at 存 UTC，按 '+8 hours' 归北京日与窗口比较
  const counts = db.prepare(`SELECT COUNT(*) AS pickupCount,
      COUNT(DISTINCT t.customer_id || '|' || t.customer_name_snap) AS customerCount
    FROM pickup_tasks t WHERE t.status='completed' AND t.default_worker_id=?
      AND date(COALESCE(NULLIF(t.completed_at,''),t.updated_at),'+8 hours') BETWEEN ? AND ?`).get(courierId, start, end);
  const sums = db.prepare(`SELECT COALESCE(SUM(i.pieces),0) AS pieces,
      COALESCE(SUM(CASE WHEN i.match_status='matched' THEN i.final_weight ELSE 0 END),0) AS matchedWeight
    FROM pickup_tasks t JOIN pickup_items i ON i.task_id=t.id
    WHERE t.status='completed' AND t.default_worker_id=? AND date(COALESCE(NULLIF(t.completed_at,''),t.updated_at),'+8 hours') BETWEEN ? AND ?`)
    .get(courierId, start, end);
  return {
    pickupCount: counts.pickupCount, customerCount: counts.customerCount,
    pieces: sums.pieces, matchedWeight: Math.round(sums.matchedWeight * 100) / 100
  };
}

module.exports = { taskVisibleTo, enrichTaskDetail, courierActiveTaskCount, workerStatsWindow };

const crypto = require('node:crypto');
const { utcText, bjDateStamp } = require('../time');

const STATUS_LABELS = {
  pending: '待取',
  in_progress: '取件中',
  completed: '已完成',
  cancelled: '已取消'
};

// 任务域机器时刻：统一 UTC 空格文本（与 time.js 口径一致，勿改北京时区）
function now() {
  return utcText();
}

function id() {
  return crypto.randomUUID();
}

function taskNo() {
  const day = bjDateStamp(); // 任务号日期面向业务，按北京时间日生成
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  return `QJ${day}-${suffix}`;
}

function itemFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    entryMethod: row.entry_method,
    waybillNo: row.waybill_no,
    goodsName: row.goods_name,
    pieces: row.pieces,
    sortOrder: row.sort_order,
    finalWeight: row.final_weight,
    weightSource: row.weight_source,
    matchStatus: row.match_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function taskFromRow(db, row) {
  if (!row) return null;
  return {
    id: row.id,
    taskNo: row.task_no,
    businessOrderNo: row.business_order_no,
    customerId: row.customer_id,
    customerName: row.customer_name_snap,
    address: row.address_snap,
    contact: row.contact_snap,
    phone: row.phone_snap,
    areaName: row.area_name_snap,
    mainCsId: row.main_cs_id,
    dispatchCsId: row.dispatch_cs_id,
    dispatchCsName: row.dispatch_cs_name,
    defaultWorkerId: row.default_worker_id,
    taskType: row.task_type,
    scheduledKind: row.scheduled_kind,
    scheduledTime: row.scheduled_time,
    rushShipTime: row.rush_ship_time,
    rushReason: row.rush_reason,
    dispatchAt: row.dispatch_at,
    completedAt: row.completed_at,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    pickupNote: row.pickup_note,
    internalNote: row.internal_note,
    volume: row.volume,
    dimensions: row.dimensions,
    amountReceivable: row.amount_receivable,
    amountPayable: row.amount_payable,
    settled: row.settled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: db.prepare('SELECT * FROM pickup_items WHERE task_id = ? ORDER BY sort_order, created_at, id').all(row.id).map(itemFromRow),
    assistWorkerIds: db.prepare('SELECT worker_id FROM task_assistants WHERE task_id = ? ORDER BY created_at, id').all(row.id).map(row => row.worker_id)
  };
}

function createTaskModule(db, options = {}) {
  const publisher = Object.assign({
    taskAssigned() {}, taskStatusChanged() {}, taskUrgent() {}, taskException() {}, taskExceptionResolved() {}, taskAssistInvited() {}
  }, options.publisher || {});
  const insertTask = db.prepare(`INSERT INTO pickup_tasks (
    id,task_no,business_order_no,customer_id,customer_name_snap,address_snap,contact_snap,phone_snap,
    area_name_snap,main_cs_id,dispatch_cs_id,dispatch_cs_name,default_worker_id,task_type,scheduled_kind,
    scheduled_time,rush_ship_time,rush_reason,dispatch_at,status,pickup_note,internal_note,volume,dimensions,
    amount_receivable,amount_payable,settled,created_at,updated_at
  ) VALUES (
    @id,@taskNo,@businessOrderNo,@customerId,@customerName,@address,@contact,@phone,@areaName,@mainCsId,
    @dispatchCsId,@dispatchCsName,@defaultWorkerId,@taskType,@scheduledKind,@scheduledTime,@rushShipTime,
    @rushReason,@dispatchAt,'pending',@pickupNote,@internalNote,@volume,@dimensions,@amountReceivable,
    @amountPayable,@settled,@createdAt,@updatedAt
  )`);
  const insertItem = db.prepare(`INSERT INTO pickup_items (
    id,task_id,worker_id,entry_method,waybill_no,goods_name,pieces,sort_order,final_weight,weight_source,match_status,created_at,updated_at
  ) VALUES (@id,@taskId,@workerId,@entryMethod,@waybillNo,@goodsName,@pieces,@sortOrder,@finalWeight,@weightSource,@matchStatus,@createdAt,@updatedAt)`);
  const insertEvent = db.prepare(`INSERT INTO task_events
    (id,task_id,event_type,from_status,to_status,note,actor_id,actor_name,created_at)
    VALUES (@id,@taskId,@eventType,@fromStatus,@toStatus,@note,@actorId,@actorName,@createdAt)`);
  const insertAssistant = db.prepare(`INSERT INTO task_assistants (id,task_id,worker_id,added_by,created_at)
    VALUES (@id,@taskId,@workerId,@addedBy,@createdAt)`);
  const hasCouriers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='couriers'").get());
  const workerExists = hasCouriers ? db.prepare('SELECT id FROM couriers WHERE id=?') : null;
  const isAssistant = db.prepare('SELECT 1 FROM task_assistants WHERE task_id=? AND worker_id=?');

  function getTask(taskId) {
    return taskFromRow(db, db.prepare('SELECT * FROM pickup_tasks WHERE id = ?').get(taskId));
  }

  function createTask(input, actor = {}) {
    if (!input.customerName || !String(input.customerName).trim()) throw new Error('客户名称不能为空');
    if (!input.address || !String(input.address).trim()) throw new Error('取件地址不能为空');
    const createdAt = now();
    const taskId = id();
    const createdEventId = input.eventId || id();
    const transaction = db.transaction(() => {
      insertTask.run({
        id: taskId,
        taskNo: taskNo(),
        businessOrderNo: input.businessOrderNo || '',
        customerId: input.customerId || '',
        customerName: String(input.customerName).trim(),
        address: String(input.address).trim(),
        contact: input.contact || '',
        phone: input.phone || '',
        areaName: input.areaName || '',
        mainCsId: input.mainCsId || '',
        dispatchCsId: actor.id || input.dispatchCsId || '',
        dispatchCsName: actor.name || input.dispatchCsName || '',
        defaultWorkerId: input.defaultWorkerId || '',
        taskType: input.taskType || 'normal',
        scheduledKind: input.scheduledKind || '',
        scheduledTime: input.scheduledTime || '',
        rushShipTime: input.rushShipTime || '',
        rushReason: input.rushReason || '',
        dispatchAt: input.dispatchAt || createdAt,
        pickupNote: input.pickupNote || '',
        internalNote: input.internalNote || '',
        volume: Number(input.volume || 0),
        dimensions: input.dimensions || '',
        amountReceivable: Number(input.amountReceivable || 0),
        amountPayable: Number(input.amountPayable || 0),
        settled: input.settled || '未结算',
        createdAt,
        updatedAt: createdAt
      });
      for (const [sortOrder, item] of (input.items || []).entries()) {
        insertItem.run({
          id: id(), taskId, workerId: item.workerId || input.defaultWorkerId || '',
          entryMethod: item.entryMethod || (item.waybillNo ? 'scan' : 'manual'),
          waybillNo: item.waybillNo || '', goodsName: item.goodsName || '', pieces: Number(item.pieces || 1), sortOrder,
          finalWeight: Number(item.finalWeight || 0), weightSource: item.weightSource || '',
          matchStatus: item.matchStatus || (item.waybillNo ? 'pending' : 'no_waybill'), createdAt, updatedAt: createdAt
        });
      }
      insertEvent.run({
        id: createdEventId, taskId, eventType: 'created', fromStatus: '', toStatus: 'pending', note: '',
        actorId: actor.id || '', actorName: actor.name || '', createdAt
      });
      publisher.taskAssigned(getTask(taskId), createdEventId);
    });
    transaction();
    return getTask(taskId);
  }

  function assignTask(taskId, workerId, actor = {}) {
    const task = getTask(taskId);
    if (!task) throw new Error('取件任务不存在');
    if (task.defaultWorkerId === workerId) return task;
    const changedAt = now();
    const eventId = actor.eventId || id();
    const transaction = db.transaction(() => {
      db.prepare('UPDATE pickup_tasks SET default_worker_id=?,updated_at=? WHERE id=?').run(workerId || '', changedAt, taskId);
      insertEvent.run({
        id: eventId, taskId, eventType: 'assigned', fromStatus: '', toStatus: '',
        note: `${task.defaultWorkerId || ''}->${workerId || ''}`,
        actorId: actor.id || '', actorName: actor.name || '', createdAt: changedAt
      });
      publisher.taskAssigned(getTask(taskId), eventId);
    });
    transaction();
    return getTask(taskId);
  }

  function transitionTask(taskId, nextStatus, actor = {}, note = '') {
    const task = getTask(taskId);
    if (!task) throw new Error('取件任务不存在');
    if (!STATUS_LABELS[nextStatus]) throw new Error('无效的任务状态');
    if (task.status === 'completed' && nextStatus === 'cancelled') throw new Error('已完成任务不能取消');
    if (task.status === 'completed' && nextStatus !== 'completed') {
      throw new Error(`不能从已完成变更为${STATUS_LABELS[nextStatus]}`);
    }
    if (task.status === 'cancelled' && nextStatus !== 'cancelled') throw new Error('已取消任务不能恢复');
    if (nextStatus === 'completed' && task.status !== 'in_progress') throw new Error('必须先开始取件才能完成任务');
    const allowed = {
      pending: new Set(['in_progress', 'cancelled']),
      in_progress: new Set(['completed', 'cancelled']),
      completed: new Set(['completed']),
      cancelled: new Set(['cancelled'])
    };
    if (!allowed[task.status].has(nextStatus)) throw new Error(`不能从${STATUS_LABELS[task.status]}变更为${STATUS_LABELS[nextStatus]}`);
    if (task.status === nextStatus) return task;
    const changedAt = now();
    const eventId = actor.eventId || id();
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE pickup_tasks SET status=?, completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
        updated_at=? WHERE id=?`).run(nextStatus, nextStatus, changedAt, changedAt, taskId);
      insertEvent.run({
        id: eventId, taskId, eventType: 'status_changed', fromStatus: task.status, toStatus: nextStatus, note,
        actorId: actor.id || '', actorName: actor.name || '', createdAt: changedAt
      });
      publisher.taskStatusChanged(getTask(taskId), task.status, actor, eventId);
    });
    transaction();
    return getTask(taskId);
  }

  function assistTask(taskId, workerId, actor = {}) {
    const task = getTask(taskId);
    if (!task) throw new Error('取件任务不存在');
    const worker = String(workerId || '').trim();
    if (!worker) throw new Error('请选择协助取件员');
    if (!workerExists || !workerExists.get(worker)) throw new Error('协助取件员不存在');
    if (task.status === 'completed' || task.status === 'cancelled') throw new Error('已完成或已取消任务不能再邀请协助');
    if (task.defaultWorkerId === worker) throw new Error('主取件员无需邀请协助');
    if (isAssistant.get(taskId, worker)) throw new Error('该取件员已在协助名单');
    const changedAt = now();
    const eventId = actor.eventId || id();
    const transaction = db.transaction(() => {
      insertAssistant.run({ id: eventId, taskId, workerId: worker, addedBy: actor.id || '', createdAt: changedAt });
      insertEvent.run({
        id: eventId, taskId, eventType: 'assist_added', fromStatus: '', toStatus: '',
        note: `${task.defaultWorkerId || ''}->${worker}`, actorId: actor.id || '', actorName: actor.name || '', createdAt: changedAt
      });
      publisher.taskAssistInvited(getTask(taskId), worker, eventId);
    });
    transaction();
    return getTask(taskId);
  }

  function updateTask(taskId, input = {}, actor = {}) {
    const task = getTask(taskId);
    if (!task) throw new Error('取件任务不存在');
    const changedAt = now();
    const eventId = input.eventId || actor.eventId || id();
    const next = {
      taskType: input.taskType ?? task.taskType,
      scheduledKind: input.scheduledKind ?? task.scheduledKind,
      scheduledTime: input.scheduledTime ?? task.scheduledTime,
      rushShipTime: input.rushShipTime ?? task.rushShipTime,
      rushReason: input.rushReason ?? task.rushReason,
      pickupNote: input.pickupNote ?? task.pickupNote,
      internalNote: input.internalNote ?? task.internalNote
    };
    const urgentChanged = next.taskType === 'rush' && (
      task.taskType !== 'rush' || next.rushShipTime !== task.rushShipTime || next.rushReason !== task.rushReason
    );
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE pickup_tasks SET task_type=?,scheduled_kind=?,scheduled_time=?,rush_ship_time=?,rush_reason=?,
        pickup_note=?,internal_note=?,updated_at=? WHERE id=?`).run(
          next.taskType, next.scheduledKind, next.scheduledTime, next.rushShipTime, next.rushReason,
          next.pickupNote, next.internalNote, changedAt, taskId
        );
      insertEvent.run({
        id: eventId, taskId, eventType: 'updated', fromStatus: task.status, toStatus: task.status,
        note: urgentChanged ? 'rush' : '', actorId: actor.id || '', actorName: actor.name || '', createdAt: changedAt
      });
      if (urgentChanged) publisher.taskUrgent(getTask(taskId), eventId);
    });
    transaction();
    return getTask(taskId);
  }

  function reportException(taskId, input = {}, actor = {}) {
    const task = getTask(taskId);
    if (!task) throw new Error('取件任务不存在');
    const type = String(input.type || '').trim();
    if (!type) throw new Error('请选择异常类型');
    const eventId = input.eventId || actor.eventId || id();
    const createdAt = now();
    const exception = {
      id: eventId,
      type,
      description: String(input.description || '')
    };
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO task_exceptions (id,task_id,reporter_id,exception_type,description,created_at)
        VALUES (?,?,?,?,?,?)`).run(exception.id, taskId, actor.id || '', exception.type, exception.description, createdAt);
      publisher.taskException(task, exception, actor, eventId);
    });
    transaction();
    return exception;
  }

  function resolveException(exceptionId, resolution, actor = {}) {
    const row = db.prepare('SELECT * FROM task_exceptions WHERE id=?').get(exceptionId);
    if (!row) throw new Error('异常不存在');
    const task = getTask(row.task_id);
    if (!task) throw new Error('取件任务不存在');
    if (row.resolved) return {
      id: row.id, taskId: row.task_id, type: row.exception_type, description: row.description,
      reporterId: row.reporter_id, resolved: true, resolution: row.resolution, resolvedAt: row.resolved_at
    };
    const resolvedAt = now();
    const eventId = actor.eventId || id();
    let result;
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE task_exceptions SET resolved=1,resolved_by=?,resolution=?,resolved_at=? WHERE id=?`)
        .run(actor.id || '', String(resolution || ''), resolvedAt, exceptionId);
      insertEvent.run({
        id: eventId, taskId: task.id, eventType: 'exception_resolved', fromStatus: task.status, toStatus: task.status,
        note: String(resolution || ''), actorId: actor.id || '', actorName: actor.name || '', createdAt: resolvedAt
      });
      result = {
        id: row.id, taskId: row.task_id, type: row.exception_type, description: row.description,
        reporterId: row.reporter_id, resolved: true, resolution: String(resolution || ''), resolvedAt
      };
      publisher.taskExceptionResolved(task, result, actor, eventId);
    });
    transaction();
    return result;
  }

  function taskWhere(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
    if (filters.workerId) {
      clauses.push('(default_worker_id = ? OR id IN (SELECT task_id FROM task_assistants WHERE worker_id = ?))');
      params.push(filters.workerId, filters.workerId);
    }
    if (filters.customerId) { clauses.push('customer_id = ?'); params.push(filters.customerId); }
    if (filters.keyword) {
      clauses.push('(task_no LIKE ? OR business_order_no LIKE ? OR customer_name_snap LIKE ? OR address_snap LIKE ?)');
      const q = `%${filters.keyword}%`;
      params.push(q, q, q, q);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return { where, params };
  }

  function countTasks(filters = {}) {
    const { where, params } = taskWhere(filters);
    return db.prepare(`SELECT COUNT(*) AS count FROM pickup_tasks ${where}`).get(...params).count;
  }

  function listTasks(filters = {}, options = {}) {
    const { where, params } = taskWhere(filters);
    let sql = `SELECT * FROM pickup_tasks ${where} ORDER BY created_at DESC, id DESC`;
    const bound = [...params];
    if (options.limit) { sql += ' LIMIT ?'; bound.push(Number(options.limit)); }
    if (options.offset) { sql += ' OFFSET ?'; bound.push(Number(options.offset)); }
    return db.prepare(sql).all(...bound).map(row => taskFromRow(db, row));
  }

  return { createTask, getTask, countTasks, listTasks, transitionTask, assignTask, updateTask, assistTask, reportException, resolveException };
}

module.exports = { createTaskModule, STATUS_LABELS };

function createBusinessNotificationPublisher(db, notifications) {
  const hasUsers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get());
  const userColumns = hasUsers ? new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name)) : new Set();
  const workerUser = hasUsers
    ? db.prepare(`SELECT id FROM users WHERE courier_id=?${userColumns.has('status') ? " AND status='active'" : ''} ORDER BY id LIMIT 1`)
    : null;
  const activeUser = hasUsers
    ? db.prepare(`SELECT id FROM users WHERE id=?${userColumns.has('status') ? " AND status='active'" : ''} LIMIT 1`)
    : null;

  function taskData(task, extra = {}) {
    return {
      resourceType: 'pickupTask',
      resourceId: task.id,
      route: `/tasks/${encodeURIComponent(task.id)}`,
      ...extra
    };
  }

  function publishToUsers(userIds, eventId, build) {
    const results = [];
    for (const userId of new Set(userIds.filter(Boolean))) {
      if (activeUser && !activeUser.get(userId)) continue;
      results.push(notifications.publish({ ...build(userId), recipientUserId: userId, dedupeKey: `${eventId}:${userId}` }));
    }
    return results;
  }

  function taskAssigned(task, eventId) {
    if (!task || !task.defaultWorkerId || !workerUser) return null;
    const recipient = workerUser.get(task.defaultWorkerId);
    if (!recipient) return null;
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.assigned',
      title: '新的取件任务',
      body: `${task.customerName} · ${task.address}`.slice(0, 500),
      data: taskData(task),
      priority: task.taskType === 'rush' ? 'high' : 'normal',
      dedupeKey: `${eventId}:${recipient.id}`
    });
  }

  function taskAssistInvited(task, workerId, eventId) {
    if (!task || !workerId || !workerUser) return null;
    const recipient = workerUser.get(workerId);
    if (!recipient) return null;
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.assistInvited',
      title: '协助取件邀请',
      body: `${task.customerName} · ${task.address}`.slice(0, 500),
      data: taskData(task, { assistWorkerId: workerId }),
      priority: task.taskType === 'rush' ? 'high' : 'normal',
      dedupeKey: `${eventId}:${recipient.id}`
    });
  }

  function taskStatusChanged(task, previousStatus, actor, eventId) {
    const actorId = actor && actor.id;
    return publishToUsers([task.dispatchCsId, task.mainCsId].filter(userId => userId !== actorId), eventId, () => ({
      type: 'pickupTask.statusChanged',
      title: '取件任务状态更新',
      body: `${task.customerName}：${task.statusLabel}`.slice(0, 500),
      data: taskData(task, { status: task.status, previousStatus }),
      priority: task.status === 'cancelled' ? 'high' : 'normal'
    }));
  }

  function taskUrgent(task, eventId) {
    if (!task.defaultWorkerId || !workerUser) return null;
    const recipient = workerUser.get(task.defaultWorkerId);
    if (!recipient) return null;
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.overdue',
      title: '取件任务已加急',
      body: `${task.customerName}${task.rushReason ? ` · ${task.rushReason}` : ''}`.slice(0, 500),
      data: taskData(task, { rushShipTime: task.rushShipTime || '' }),
      priority: 'high',
      dedupeKey: `${eventId}:${recipient.id}`
    });
  }

  function taskException(task, exception, actor, eventId) {
    const actorId = actor && actor.id;
    const recipients = [task.dispatchCsId, task.mainCsId].filter(userId => userId && userId !== actorId);
    if (task.defaultWorkerId && workerUser) {
      const worker = workerUser.get(task.defaultWorkerId);
      if (worker && worker.id !== actorId) recipients.push(worker.id);
    }
    return publishToUsers(recipients, eventId, () => ({
      type: 'pickupTask.exception',
      title: '取件任务异常',
      body: `${task.customerName} · ${exception.description || exception.type}`.slice(0, 500),
      data: taskData(task, { exceptionId: exception.id, exceptionType: exception.type }),
      priority: 'high'
    }));
  }

  function taskExceptionResolved(task, exception, actor, eventId) {
    const recipients = [];
    if (task.defaultWorkerId && workerUser) {
      const worker = workerUser.get(task.defaultWorkerId);
      if (worker && (!actor || worker.id !== actor.id)) recipients.push(worker.id);
    }
    if (exception.reporterId && (!actor || exception.reporterId !== actor.id)) recipients.push(exception.reporterId);
    return publishToUsers(recipients, eventId, () => ({
      type: 'pickupTask.exception',
      title: '任务异常已处理',
      body: `${task.customerName} · 已处理：${exception.resolution || '请查看详情'}`.slice(0, 500),
      data: taskData(task, { exceptionId: exception.id, resolved: true }),
      priority: 'normal'
    }));
  }

  function recordAssigned(record, actor, eventId) {
    if (!record || !record.courierId || !workerUser) return null;
    const recipient = workerUser.get(record.courierId);
    if (!recipient) return null;
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.assigned',
      title: '新的取件订单',
      body: `${actor && actor.name ? actor.name : '客服'} 派了新单：${record.customer || ''}`.slice(0, 500),
      data: {
        resourceType: 'legacyRecord', resourceId: record.id, route: '/notifications'
      },
      priority: 'normal',
      dedupeKey: `${eventId}:${recipient.id}`
    });
  }

  function recordStatusChanged(record, actor, eventId) {
    if (!record || !record.dispatcherId || (actor && actor.id === record.dispatcherId)) return null;
    if (activeUser && !activeUser.get(record.dispatcherId)) return null;
    return notifications.publish({
      recipientUserId: record.dispatcherId,
      type: 'pickupTask.statusChanged',
      title: '订单状态更新',
      body: `${record.customer || '订单'} 已更新为「${record.status || ''}」`.slice(0, 500),
      data: {
        resourceType: 'legacyRecord', resourceId: record.id, route: '/notifications', status: record.status || ''
      },
      priority: record.status === '已取消' ? 'high' : 'normal',
      dedupeKey: `${eventId}:${record.dispatcherId}`
    });
  }

  return {
    taskAssigned, taskStatusChanged, taskUrgent, taskException, taskExceptionResolved, taskAssistInvited,
    recordAssigned, recordStatusChanged
  };
}

module.exports = { createBusinessNotificationPublisher };

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

  // 计划时刻钟面文本 "YYYY-MM-DDTHH:mm:ss" → "MM-DD HH:mm"
  function fmtClockTime(value) {
    const s = String(value || '').replace('T', ' ').trim();
    return s.length >= 16 ? s.slice(5, 16) : s;
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
    const parts = [`${task.customerName} · ${task.address}`];
    let title = '新的取件任务';
    if (task.taskType === 'rush') {
      title = '新的取件任务（加急）';
      if (task.rushShipTime) parts.push('赶 ' + fmtClockTime(task.rushShipTime) + ' 出货');
      if (task.rushReason) parts.push('原因：' + task.rushReason);
      if (parts.length === 1) parts.push('请尽快取件');
    } else if (task.taskType === 'scheduled' && task.scheduledTime) {
      title = '新的取件任务（指定时间）';
      const kind = task.scheduledKind === 'before' ? '前取' : task.scheduledKind === 'after' ? '后取' : task.scheduledKind === 'around' ? '左右取' : '';
      parts.push('指定时间 ' + fmtClockTime(task.scheduledTime) + (kind ? ' ' + kind : ''));
    }
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.assigned',
      title,
      body: parts.join(' · ').slice(0, 500),
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
    // 客服只在「完成」和「取消/删除」时收到通知；开始取件等中间状态不打扰客服
    if (task.status !== 'completed' && task.status !== 'cancelled') return [];
    const actorId = actor && actor.id;
    const recipients = [task.dispatchCsId, task.mainCsId].filter(userId => userId && userId !== actorId);
    // 取消时同时通知取件员
    if (task.status === 'cancelled' && task.defaultWorkerId && workerUser) {
      const worker = workerUser.get(task.defaultWorkerId);
      if (worker && worker.id !== actorId) recipients.push(worker.id);
    }
    return publishToUsers(recipients, eventId, () => ({
      type: 'pickupTask.statusChanged',
      title: task.status === 'completed' ? '取件任务已完成' : '取件任务已取消',
      body: `${task.customerName}：${task.statusLabel}`.slice(0, 500),
      data: taskData(task, { status: task.status, previousStatus }),
      priority: task.status === 'cancelled' ? 'high' : 'normal'
    }));
  }

  // 取件员自助建单时通知客户的负责客服
  function taskCreatedForCs(task, actor, eventId) {
    if (!task || !task.mainCsId) return null;
    const actorId = actor && actor.id;
    return publishToUsers([task.mainCsId, task.dispatchCsId].filter(userId => userId && userId !== actorId), eventId, () => ({
      type: 'pickupTask.created',
      title: '新增取件订单',
      body: `${task.customerName} · ${task.address}`.slice(0, 500),
      data: taskData(task),
      priority: 'normal'
    }));
  }

  function taskUrgent(task, eventId) {
    if (!task.defaultWorkerId || !workerUser) return null;
    const recipient = workerUser.get(task.defaultWorkerId);
    if (!recipient) return null;
    const parts = [task.customerName];
    if (task.rushShipTime) parts.push('赶 ' + fmtClockTime(task.rushShipTime) + ' 出货');
    if (task.rushReason) parts.push('原因：' + task.rushReason);
    if (parts.length === 1) parts.push('请尽快取件');
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.overdue',
      title: '取件任务已加急',
      body: parts.join(' · ').slice(0, 500),
      data: taskData(task, { rushShipTime: task.rushShipTime || '' }),
      priority: 'high',
      dedupeKey: `${eventId}:${recipient.id}`
    });
  }

  function taskScheduled(task, eventId) {
    if (!task.defaultWorkerId || !workerUser) return null;
    const recipient = workerUser.get(task.defaultWorkerId);
    if (!recipient) return null;
    const kind = task.scheduledKind === 'before' ? '前取' : task.scheduledKind === 'after' ? '后取' : task.scheduledKind === 'around' ? '左右取' : '';
    return notifications.publish({
      recipientUserId: recipient.id,
      type: 'pickupTask.scheduled',
      title: '取件任务已指定时间',
      body: (`${task.customerName} · 指定时间 ${fmtClockTime(task.scheduledTime)}${kind ? ' ' + kind : ''}`).slice(0, 500),
      data: taskData(task, { scheduledTime: task.scheduledTime || '' }),
      priority: 'normal',
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
    taskAssigned, taskStatusChanged, taskCreatedForCs, taskUrgent, taskException, taskExceptionResolved, taskAssistInvited,
    recordAssigned, recordStatusChanged, taskScheduled
  };
}

module.exports = { createBusinessNotificationPublisher };

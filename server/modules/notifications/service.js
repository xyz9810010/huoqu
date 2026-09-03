const PRIORITIES = new Set(['low', 'normal', 'high']);
const TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/i;

function validateInput(input) {
  const recipientUserId = String(input.recipientUserId || '').trim();
  const type = String(input.type || '').trim();
  const title = String(input.title || '').trim();
  const body = String(input.body || '');
  const priority = String(input.priority || 'normal');
  const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {};
  const route = data.route == null ? '' : String(data.route);

  if (!recipientUserId) throw new Error('通知接收人不能为空');
  if (!TYPE_PATTERN.test(type)) throw new Error('通知类型格式不正确');
  if (!title || title.length > 120) throw new Error('通知标题长度不正确');
  if (body.length > 500) throw new Error('通知正文不能超过500字');
  if (!PRIORITIES.has(priority)) throw new Error('通知优先级不正确');
  if (route && (!route.startsWith('/') || route.startsWith('//') || route.includes('://'))) {
    throw new Error('通知跳转地址必须是站内相对路径');
  }
  const dedupeKey = String(input.dedupeKey || '');
  if (dedupeKey.length > 200) throw new Error('通知幂等键过长');
  return {
    recipientUserId,
    type,
    title,
    body,
    data,
    priority,
    dedupeKey,
    expiresAt: String(input.expiresAt || '')
  };
}

function createNotificationService({ repository, realtime }) {
  const events = realtime || { publishToUser() {} };
  return {
    publish(rawInput) {
      const input = validateInput(rawInput || {});
      const existing = input.dedupeKey && repository.findByDedupe(input.recipientUserId, input.dedupeKey);
      if (existing) return existing;
      const notification = repository.insert(input);
      events.publishToUser(input.recipientUserId, {
        version: 1,
        type: 'notification.created',
        data: {
          notification: {
            id: notification.id,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            data: notification.data,
            priority: notification.priority,
            createdAt: notification.createdAt
          }
        }
      });
      return notification;
    },
    listForUser: (userId, query) => repository.listForUser(userId, query),
    unreadCount: userId => repository.unreadCount(userId),
    markRead: (userId, id) => repository.markRead(userId, id),
    markAllRead: userId => repository.markAllRead(userId)
  };
}

module.exports = { createNotificationService, validateInput };

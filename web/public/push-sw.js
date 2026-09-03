function safeRelativeRoute(value) {
  const route = String(value || '');
  return route.startsWith('/') && !route.startsWith('//') && !route.includes('://')
    ? route
    : '/notifications';
}

function safePayload(data) {
  try {
    const value = data && typeof data.json === 'function' ? data.json() : {};
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const data = safePayload(event.data);
    const notificationId = String(data.notificationId || '');
    const route = safeRelativeRoute(data.route);
    const title = String(data.title || 'Huoqu');
    const body = String(data.body || '你有一条新消息');
    const routeTaskId = route.startsWith('/tasks/') ? decodeURIComponent(route.slice('/tasks/'.length)) : '';
    const notification = {
      id: notificationId,
      type: String(data.type || 'system.message'),
      title,
      body,
      data: {
        route,
        resourceType: String(data.resourceType || (routeTaskId ? 'pickupTask' : '')),
        resourceId: String(data.resourceId || routeTaskId)
      },
      priority: String(data.priority || 'normal'),
      createdAt: String(data.createdAt || '')
    };
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = windows.find(client => client.focused);
    if (focused && typeof focused.postMessage === 'function') {
      focused.postMessage({ version: 1, type: 'notification.created', data: { notification } });
      return;
    }
    await self.registration.showNotification(title, {
      body,
      tag: String(data.tag || notificationId || 'huoqu-notification'),
      renotify: true,
      vibrate: [180, 80, 180],
      data: {
        route,
        notificationId
      }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const route = safeRelativeRoute(event.notification.data && event.notification.data.route);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      try {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (typeof client.focus === 'function') await client.focus();
        if (typeof client.navigate === 'function') await client.navigate(route);
        return;
      } catch {
        // 继续寻找可用窗口。
      }
    }
    await self.clients.openWindow(route);
  })());
});

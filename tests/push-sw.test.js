const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function workerFixture(windowClients = []) {
  const listeners = {};
  const notifications = [];
  const opened = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'push-sw.js'), 'utf8');
  const self = {
    location: { origin: 'https://cargo.example' },
    addEventListener(type, handler) { listeners[type] = handler; },
    registration: {
      async showNotification(title, options) { notifications.push({ title, options }); }
    },
    clients: {
      async matchAll() { return windowClients; },
      async openWindow(route) { opened.push(route); }
    }
  };
  vm.runInNewContext(source, { self, URL, console });
  return { listeners, notifications, opened };
}

test('service worker shows safe notification data and rejects external click routes', async () => {
  const { listeners, notifications } = workerFixture();
  let pending;
  listeners.push({
    data: { json: () => ({
      notificationId: 'n1', type: 'system.test', title: '测试', body: '正文',
      tag: 'system.test:n1', route: 'https://evil.example/phish'
    }) },
    waitUntil(value) { pending = value; }
  });
  await pending;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, '测试');
  assert.equal(notifications[0].options.data.route, '/notifications');
  assert.equal(notifications[0].options.tag, 'system.test:n1');
});

test('notification click opens a controlled relative route', async () => {
  const { listeners, opened } = workerFixture();
  let pending;
  let closed = false;
  listeners.notificationclick({
    notification: { data: { route: '/tasks/task-1' }, close() { closed = true; } },
    waitUntil(value) { pending = value; }
  });
  await pending;

  assert.equal(closed, true);
  assert.deepEqual(opened, ['/tasks/task-1']);
});

test('service worker forwards a push to the focused page instead of showing a duplicate system notification', async () => {
  const messages = [];
  const focusedClient = {
    focused: true,
    postMessage(message) { messages.push(message); }
  };
  const { listeners, notifications } = workerFixture([focusedClient]);
  let pending;
  listeners.push({
    data: { json: () => ({
      notificationId: 'n2', type: 'pickupTask.assigned', title: '新任务', body: '客户 · 地址',
      route: '/tasks/t2'
    }) },
    waitUntil(value) { pending = value; }
  });
  await pending;

  assert.equal(notifications.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'notification.created');
  assert.equal(messages[0].data.notification.id, 'n2');
  assert.equal(messages[0].data.notification.data.resourceId, 't2');
});

test('service worker still shows a system notification when the page is visible but not focused', async () => {
  const messages = [];
  const unfocusedClient = {
    focused: false,
    visibilityState: 'visible',
    postMessage(message) { messages.push(message); }
  };
  const { listeners, notifications } = workerFixture([unfocusedClient]);
  let pending;
  listeners.push({
    data: { json: () => ({
      notificationId: 'n3', type: 'pickupTask.assigned', title: '新任务', body: '客户 · 地址',
      route: '/tasks/t3'
    }) },
    waitUntil(value) { pending = value; }
  });
  await pending;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, '新任务');
  assert.equal(messages.length, 0);
});

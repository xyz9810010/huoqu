const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpush = require('web-push');
const Database = require('better-sqlite3');

const TIME_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const port = 34000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-api-'));
let child;
let token;
let adminToken;
let adminUser;

async function request(method, url, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(baseUrl + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'app.db'),
      DISABLE_PUSH: '1',
      INITIAL_ADMIN_PASSWORD: 'test-admin-strong-password',
      PUSH_CONFIG_MASTER_KEY: Buffer.alloc(32, 9).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let lastError;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const login = await request('POST', '/api/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(login.status, 200, lastError?.message);
  token = login.data.token;
  adminToken = token;
  adminUser = login.data.user;
});

test.after(async () => {
  if (child && !child.killed) {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
  }
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (i === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

test('task API creates and lists one task with multiple cargo items', async () => {
  const created = await request('POST', '/api/tasks', {
    customerName: '接口测试客户',
    address: '义乌市江东街道',
    taskType: 'scheduled',
    scheduledTime: '2026-09-02 10:00:00',
    items: [
      { waybillNo: 'API-WB-1', pieces: 2, goodsName: '服装' },
      { waybillNo: 'API-WB-2', pieces: 1, goodsName: '配件' }
    ]
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.items.length, 2);

  const listed = await request('GET', '/api/tasks?keyword=接口测试客户');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.total, 1);
  assert.equal(listed.data.list[0].taskNo, created.data.taskNo);
});

test('v1 task times render as Beijing wall-clock text while storage keeps UTC text', async () => {
  const created = await request('POST', '/api/tasks', {
    customerName: '时间口径客户',
    address: '义乌市江东街道',
    taskType: 'scheduled',
    scheduledTime: '2026-09-02 10:00:00',
    items: []
  });
  assert.equal(created.status, 201);
  assert.match(created.data.createdAt, TIME_TEXT_RE);
  assert.equal(created.data.scheduledTime, '2026-09-02 10:00:00', '录入型计划时刻保持原样');
  const detail = await request('GET', `/api/tasks/${created.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.createdAt, created.data.createdAt);

  const db = new Database(path.join(tempDir, 'app.db'), { readonly: true });
  const stored = db.prepare('SELECT created_at FROM pickup_tasks WHERE id=?').get(created.data.id).created_at;
  db.close();
  assert.match(stored, TIME_TEXT_RE);
  const diffHours = (Date.parse(detail.data.createdAt.replace(' ', 'T') + 'Z')
    - Date.parse(stored.replace(' ', 'T') + 'Z')) / 3600000;
  assert.equal(diffHours, 8, 'v1 输出应为存储 UTC + 8 小时（北京钟面）');
});

test('dashboard day filter attributes Beijing-midnight tasks to the Beijing day', async () => {
  token = adminToken;
  const createOne = async name => {
    const created = await request('POST', '/api/tasks', { customerName: name, address: '边界地址', items: [] });
    assert.equal(created.status, 201);
    return created.data.id;
  };
  const board = async range => (await request('GET', `/api/dashboard/board?range=${range}`)).data;
  const count = body => body.pendingCount + body.pickupCount;
  const midNight = await createOne('边界凌晨客户');
  const lateNight = await createOne('边界深夜客户');
  const bT = count(await board('today'));
  const bY = count(await board('yesterday'));

  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const yDay = new Date(bjNow.getTime() - 86400000).toISOString().slice(0, 10);
  const db = new Database(path.join(tempDir, 'app.db'));
  // A：北京今天 00:30 == UTC 昨日 16:30（文本日期在昨天，必须在看板算进今天）
  // B：北京昨天 23:59 == UTC 昨日 15:59（文本日期在昨天，应算进昨天）
  db.prepare('UPDATE pickup_tasks SET created_at=? WHERE id=?').run(`${yDay} 16:30:00`, midNight);
  db.prepare('UPDATE pickup_tasks SET created_at=? WHERE id=?').run(`${yDay} 15:59:00`, lateNight);
  db.close();

  const afterT = count(await board('today'));
  const afterY = count(await board('yesterday'));
  // B 从今天移出（today -1）；A 北京今日 00:30 仍属 today。
  // yesterday 端点按「北京日 >= 昨日」过滤（含今天），两任务均未离开该窗口，计数不变。
  // 若按 UTC 文本日期直接截断（旧缺陷），A 会因文本日期在昨天而被漏出 today。
  assert.equal(afterT, bT - 1, '北京今日 00:30 的任务必须计入 today');
  assert.equal(afterY, bY, '北京昨日 23:59 的任务保持在北京日期窗口内');
});

test('task API rejects completion before pickup starts and then completes through valid transitions', async () => {
  const created = await request('POST', '/api/tasks', {
    customerName: '状态测试客户', address: '义乌市稠城街道', items: []
  });
  const invalid = await request('PUT', `/api/tasks/${created.data.id}/status`, { status: 'completed' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /必须先开始取件/);

  const started = await request('PUT', `/api/tasks/${created.data.id}/status`, { status: 'in_progress' });
  assert.equal(started.status, 200);
  assert.equal(started.data.status, 'in_progress');

  const completed = await request('PUT', `/api/tasks/${created.data.id}/status`, { status: 'completed' });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, 'completed');
});

test('courier task listing is limited to the courier bound to the current account', async () => {
  const courier = await request('POST', '/api/couriers', { name: '接口取件员', region: '江东', commissionRate: 3 });
  const username = `worker_${Date.now()}`;
  const user = await request('POST', '/api/users', {
    username, password: 'worker123', role: 'courier', courierId: courier.data.id, name: '接口取件员'
  });
  assert.equal(user.status, 200);
  await request('POST', '/api/tasks', {
    customerName: '分配给取件员', address: '地址甲', defaultWorkerId: courier.data.id, items: []
  });
  await request('POST', '/api/tasks', {
    customerName: '未分配给取件员', address: '地址乙', items: []
  });

  const workerLogin = await request('POST', '/api/login', { username, password: 'worker123' }, false);
  token = workerLogin.data.token;
  const tasks = await request('GET', '/api/tasks');
  assert.equal(tasks.status, 200);
  assert.equal(tasks.data.list.every(task => task.defaultWorkerId === courier.data.id), true);
  token = adminToken;
});

test('dashboard and attention endpoints summarize the canonical task model', async () => {
  token = adminToken;
  const board = await request('GET', '/api/dashboard/board?range=month');
  assert.equal(board.status, 200);
  assert.equal(typeof board.data.pendingCount, 'number');
  assert.equal(typeof board.data.pickupCount, 'number');
  assert.equal(typeof board.data.pieces, 'number');

  const attention = await request('GET', '/api/dashboard/attention');
  assert.equal(attention.status, 200);
  assert.equal(typeof attention.data.unmatchedWaybill, 'number');
  assert.equal(typeof attention.data.noWaybill, 'number');
  assert.equal(typeof attention.data.unresolvedException, 'number');
});

test('machine integration is unavailable when no server-side key is configured', async () => {
  const response = await request('POST', '/api/machine/weigh', { orderNo: 'missing', weight: 1 }, false);
  assert.equal(response.status, 503);
  assert.equal(response.data.code, 'MACHINE_API_KEY_MISSING');
});

test('task detail workflow adds an item, starts, reports an exception, resolves it and completes', async () => {
  token = adminToken;
  const created = await request('POST', '/api/tasks', {
    customerName: '详情流程客户', address: '详情流程地址', items: []
  });
  const item = await request('POST', `/api/tasks/${created.data.id}/items`, {
    entryMethod: 'manual', waybillNo: 'FLOW-WB-1', pieces: 2, goodsName: '样品'
  });
  assert.equal(item.status, 201);
  assert.equal(item.data.items.length, 1);

  const started = await request('POST', `/api/tasks/${created.data.id}/start`);
  assert.equal(started.data.status, 'in_progress');

  const exception = await request('POST', `/api/tasks/${created.data.id}/exceptions`, {
    type: '地址异常', description: '门牌号不清晰'
  });
  assert.equal(exception.status, 201);
  const exceptionId = exception.data.exceptions[0].id;

  const resolved = await request('POST', `/api/exceptions/${exceptionId}/resolve`, {
    resolution: '已电话确认', action: 'resume'
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.resolved, true);

  const completed = await request('POST', `/api/tasks/${created.data.id}/complete`);
  assert.equal(completed.data.status, 'completed');
});

test('match center returns unmatched cargo and applies synced final weight by waybill', async () => {
  token = adminToken;
  const created = await request('POST', '/api/tasks', {
    customerName: '重量匹配客户', address: '重量匹配地址',
    items: [{ entryMethod: 'manual', waybillNo: '', pieces: 1 }]
  });
  const center = await request('GET', '/api/sync/match-center');
  assert.equal(center.status, 200);
  const pending = center.data.find(item => item.taskId === created.data.id);
  assert.ok(pending);

  const matched = await request('POST', `/api/sync/match/${pending.id}`, { waybillNo: 'MATCH-WB-1' });
  assert.equal(matched.status, 200);
  assert.equal(typeof matched.data.matched, 'boolean');
});

test('notifications expose list, unread count and read-all behavior', async () => {
  token = adminToken;
  const list = await request('GET', '/api/notifications');
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.data), true);
  const unread = await request('GET', '/api/notifications/unread-count');
  assert.equal(unread.status, 200);
  assert.equal(typeof unread.data, 'number');
  const readAll = await request('POST', '/api/notifications/read-all');
  assert.equal(readAll.status, 200);
  assert.equal(readAll.data.ok, true);
});

test('notification v1 API returns paginated data and protects read ownership', async () => {
  token = adminToken;
  const list = await request('GET', '/api/v1/notifications?page=1&pageSize=10');
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.data.data.items), true);
  assert.equal(list.data.data.page, 1);
  assert.equal(list.data.data.pageSize, 10);
  assert.equal(typeof list.data.data.total, 'number');

  const unread = await request('GET', '/api/v1/notifications/unread-count');
  assert.equal(unread.status, 200);
  assert.equal(typeof unread.data.data.count, 'number');

  const missing = await request('POST', '/api/v1/notifications/not-owned/read');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, '通知不存在');
});

test('unified push APIs bind subscriptions to auth and configure Web Push with masked secrets', async () => {
  token = adminToken;
  const subscription = await request('POST', '/api/v1/notification-subscriptions', {
    userId: 'forged-user',
    channel: 'web_push',
    providerCode: 'web_push',
    platform: 'web',
    deviceLabel: 'API Chrome',
    subscription: {
      endpoint: 'https://push.example/api-test',
      keys: { p256dh: 'public-key', auth: 'auth-secret' }
    }
  });
  assert.equal(subscription.status, 201);
  assert.equal(subscription.data.data.userId, adminUser.id);
  assert.equal(JSON.stringify(subscription.data).includes('api-test'), false);
  assert.equal(JSON.stringify(subscription.data).includes('auth-secret'), false);

  const listed = await request('GET', '/api/v1/notification-subscriptions');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.data.length, 1);

  const preferences = await request('PUT', '/api/v1/notification-preferences', {
    type: 'pickupTask.assigned', channel: 'web_push', enabled: false
  });
  assert.equal(preferences.status, 200);
  assert.equal(preferences.data.data[0].enabled, false);

  const providers = await request('GET', '/api/v1/admin/push-providers');
  assert.equal(providers.status, 200);
  assert.equal(providers.data.data.some(provider => provider.code === 'web_push'), true);

  const vapid = webpush.generateVAPIDKeys();
  const configured = await request('PUT', '/api/v1/admin/push-providers/web_push', {
    credentials: {
      vapidSubject: 'mailto:ops@example.com',
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey
    }
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.data.data.fields.vapidPrivateKey, { configured: true, masked: '••••••' });
  assert.equal(JSON.stringify(configured.data).includes(vapid.privateKey), false);

  const tested = await request('POST', '/api/v1/admin/push-providers/web_push/test');
  assert.equal(tested.status, 200);
  assert.equal(tested.data.data.healthStatus, 'healthy');
  const enabled = await request('POST', '/api/v1/admin/push-providers/web_push/enable', { enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.data.enabled, true);

  const auditLogs = await request('GET', '/api/logs?size=200');
  assert.equal(auditLogs.status, 200);
  const providerAudits = auditLogs.data.list.filter(item => item.targetType === 'push_provider' && item.targetId === 'web_push');
  assert.deepEqual(
    new Set(providerAudits.map(item => item.action)),
    new Set(['保存推送供应商配置', '测试推送供应商配置', '启用推送供应商'])
  );
  const savedAudit = providerAudits.find(item => item.action === '保存推送供应商配置');
  assert.match(savedAudit.detail, /vapidPrivateKey/);
  assert.match(savedAudit.detail, /vapidPublicKey/);
  assert.match(savedAudit.detail, /vapidSubject/);
  assert.equal(JSON.stringify(providerAudits).includes(vapid.privateKey), false);

  const publicKey = await request('GET', '/api/v1/notification-providers/web-push/public-key');
  assert.equal(publicKey.status, 200);
  assert.equal(publicKey.data.data.publicKey, vapid.publicKey);
});

test('legacy Huawei registration routes delegate to the encrypted unified subscription store', async () => {
  token = adminToken;
  const registered = await request('POST', '/api/push/register', { token: 'legacy-route-huawei-token' });
  assert.equal(registered.status, 200);
  assert.equal(typeof registered.data.subscriptionId, 'string');

  const listed = await request('GET', '/api/v1/notification-subscriptions');
  assert.equal(listed.data.data.some(item => item.providerCode === 'huawei'), true);

  const unregistered = await request('POST', '/api/push/unregister');
  assert.equal(unregistered.status, 200);
  const after = await request('GET', '/api/v1/notification-subscriptions');
  assert.equal(after.data.data.some(item => item.providerCode === 'huawei'), false);
});

test('SSE v1 ticket is authenticated and can establish only one stream', async () => {
  token = adminToken;
  const issued = await request('POST', '/api/v1/events/tickets');
  assert.equal(issued.status, 201);
  assert.equal(typeof issued.data.data.ticket, 'string');

  const ticket = issued.data.data.ticket;
  const stream = await fetch(`${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  await stream.body.cancel();

  const reused = await fetch(`${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(reused.status, 401);
  assert.deepEqual(await reused.json(), { error: '推送连接凭证无效或已过期' });
});

test('SSE v1 accepts Authorization header without a query session token', async () => {
  token = adminToken;
  const stream = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  await stream.body.cancel();
});

test('v1 records list pages in SQL when page/size are requested and stays array otherwise', async () => {
  token = adminToken;
  for (let i = 0; i < 3; i += 1) {
    const created = await request('POST', '/api/records', {
      date: '2026-09-04', customer: `分页台账客户${i}`, pieces: 1,
      address: '义乌市分页地址', orderNo: `V1-PAGE-${i}`
    });
    assert.equal(created.status, 200, JSON.stringify(created.data).slice(0, 200));
  }

  const paged = await request('GET', '/api/records?page=0&size=2');
  assert.equal(paged.status, 200);
  assert.ok(Array.isArray(paged.data.list));
  assert.equal(paged.data.list.length, 2);
  assert.ok(paged.data.total >= 3);
  assert.equal(paged.data.page, 0);
  assert.equal(paged.data.size, 2);

  const secondPage = await request('GET', '/api/records?page=1&size=2');
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.data.page, 1);
  assert.equal(secondPage.data.list.length, secondPage.data.total - 2);

  const legacy = await request('GET', '/api/records');
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.data));
  assert.ok(legacy.data.length >= 3);
});

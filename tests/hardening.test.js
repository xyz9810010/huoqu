// 技术层加固回归：角色越权矩阵、畸形/注入输入、并发状态竞争、无效资源引用。
// 目标是验证任何“换个人/换个参数/并发点两下”的路径都不会越权、崩 500 或产生脏数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 39000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-harden-'));
let child;
let adminToken;
let workerToken;
let csToken;
let courierId;
let taskId;

async function request(method, url, body, authToken, headers = {}) {
  if (authToken === undefined) authToken = adminToken;
  const response = await fetch(baseUrl + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
  if (data && typeof data === 'object' && 'data' in data && Object.keys(data).length === 1) {
    data = data.data;
  }
  return { status: response.status, data, text };
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'app.db'),
      DISABLE_PUSH: '1',
      MACHINE_API_KEY: 'harden-machine-key',
      INITIAL_ADMIN_PASSWORD: 'test-admin-strong-password',
      PUSH_CONFIG_MASTER_KEY: Buffer.alloc(32, 9).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) break;
    } catch (_) { /* 未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const login = await request('POST', '/api/login', { username: 'admin', password: 'test-admin-strong-password' }, null);
  assert.equal(login.status, 200, login.text.slice(0, 200));
  adminToken = login.data.token;

  const courier = await request('POST', '/api/couriers', { name: '加固取件员', region: '加固区', commissionRate: 0.8 }, adminToken);
  courierId = courier.data.id;
  const workerUser = await request('POST', '/api/users', {
    username: 'harden_worker', password: 'harden-worker-123', role: 'courier', courierId, name: '加固取件员'
  }, adminToken);
  assert.equal(workerUser.status, 200);
  const csUser = await request('POST', '/api/users', {
    username: 'harden_cs', password: 'harden-cs-12345', role: 'cs', name: '加固客服'
  }, adminToken);
  assert.equal(csUser.status, 200);
  const workerLogin = await request('POST', '/api/v2/auth/login', { username: 'harden_worker', password: 'harden-worker-123' }, null);
  workerToken = workerLogin.data.token;
  const csLogin = await request('POST', '/api/v2/auth/login', { username: 'harden_cs', password: 'harden-cs-12345' }, null);
  csToken = csLogin.data.token;
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
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; } catch (_) {
      if (i === 9) throw _;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

test('角色越权矩阵：取件员/客服触达管理面一律 403', async () => {
  const workerOnly = [
    ['GET', '/api/users'], ['GET', '/api/employees'], ['GET', '/api/logs'],
    ['GET', '/api/v2/couriers'], ['GET', '/api/v2/dashboard/board'],
    ['POST', '/api/v2/tasks', { customerName: '不应成功', address: 'x' }],
    ['POST', '/api/v2/customers', { name: '不应成功' }]
  ];
  for (const [method, url, body] of workerOnly) {
    const res = await request(method, url, body, workerToken);
    assert.ok(res.status === 403, `取件员 ${method} ${url} 应为 403，实际 ${res.status}`);
  }
  const csOnly = [
    ['GET', '/api/users'], ['GET', '/api/employees'], ['GET', '/api/logs'],
    ['POST', '/api/v2/couriers', { name: 'x' }]
  ];
  for (const [method, url, body] of csOnly) {
    const res = await request(method, url, body, csToken);
    assert.ok(res.status === 403, `客服 ${method} ${url} 应为 403，实际 ${res.status}`);
  }
});

test('畸形与注入输入不产生 500 / 不越权泄露', async () => {
  const probes = [
    ['GET', '/api/v2/tasks?page=abc&pageSize=-5'],
    ['GET', '/api/v2/tasks?page=1e9&pageSize=NaN'],
    ['GET', '/api/v2/records?keyword=' + encodeURIComponent("' OR 1=1 --")],
    ['GET', '/api/v2/customers?search=' + encodeURIComponent('%25 OR 1=1 --')],
    ['GET', '/api/v2/tasks/not-a-uuid'],
    ['GET', '/api/v2/customers/not-a-uuid'],
    ['DELETE', '/api/v2/couriers/not-a-uuid'],
    ['GET', '/api/v2/notifications?page=-3&pageSize=0']
  ];
  for (const [method, url] of probes) {
    const res = await request(method, url);
    assert.ok(res.status < 500, `${method} ${url} 不应 500，实际 ${res.status}`);
  }
  const malformed = await request('POST', '/api/v2/tasks', null);
  assert.ok(malformed.status === 400 || malformed.status === 401, '空 body 建任务应被拒绝');
  const xssName = '<img src=x onerror=window.__pwn=1>星河</img>';
  const created = await request('POST', '/api/v2/tasks', { customerName: xssName, address: 'x', items: [] });
  assert.equal(created.status, 201);
  const detail = await request('GET', `/api/v2/tasks/${created.data.task.id}`);
  assert.equal(detail.data.task.customerName, xssName, '存储应保留原样，渲染层负责转义');
});

test('无效资源引用与越权访问他人通知返回 4xx 而非 500', async () => {
  const notFound = await request('GET', '/api/v2/tasks/00000000-0000-0000-0000-000000000000');
  assert.equal(notFound.status, 404);
  const create = await request('POST', '/api/v2/tasks', { customerName: '越权客户', address: 'x', items: [] });
  taskId = create.data.task.id;
  const worker = await request('POST', '/api/v2/tasks', { customerName: '越权客户2', address: 'x', defaultWorkerId: courierId, items: [] });
  const othersTask = worker.data.task.id;

  // 取件员看不到/操作不了分配给别人的任务
  const peep = await request('GET', `/api/v2/tasks/${othersTask}`, undefined, workerToken);
  assert.equal(peep.status, 200, '取件员应能看自己的任务');
  const peek = await request('GET', `/api/v2/tasks/${taskId}`, undefined, workerToken);
  assert.equal(peek.status, 403, '取件员查看他人任务应 403');
  const startOther = await request('POST', `/api/v2/tasks/${taskId}/start`, {}, workerToken);
  assert.equal(startOther.status, 403, '取件员开始他人任务应 403');

  // 通知所有权隔离（v1 与 v2）
  const notifications = await request('GET', '/api/v1/notifications?page=1&pageSize=1');
  const first = notifications.data.items[0];
  if (first) {
    const byWorker = await request('POST', `/api/v1/notifications/${first.id}/read`, {}, workerToken);
    assert.equal(byWorker.status, 404);
    const v2ByWorker = await request('POST', `/api/v2/notifications/${first.id}/read`, {}, workerToken);
    assert.equal(v2ByWorker.status, 404);
  }
});

test('并发状态竞争：重复 start/complete 只有一个生效且不产生脏状态', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: '并发客户', address: 'x', defaultWorkerId: courierId,
    items: [{ waybillNo: '', pieces: 1 }]
  });
  const id = created.data.task.id;
  const results = await Promise.all([
    request('POST', `/api/v2/tasks/${id}/start`, {}),
    request('POST', `/api/v2/tasks/${id}/start`, {})
  ]);
  const statuses = results.map(r => r.status).sort();
  assert.equal(statuses[0], 200, '至少一次 start 成功');
  const detail1 = await request('GET', `/api/v2/tasks/${id}`);
  assert.equal(detail1.data.task.status, 'in_progress');

  const completes = await Promise.all([
    request('POST', `/api/v2/tasks/${id}/complete`, {}),
    request('POST', `/api/v2/tasks/${id}/complete`, {})
  ]);
  const okCompletes = completes.filter(r => r.status === 200);
  assert.equal(okCompletes.length, 1, '并发完成只允许一个成功');
  const detail2 = await request('GET', `/api/v2/tasks/${id}`);
  assert.equal(detail2.data.task.status, 'completed');
  const timeline = detail2.data.task.events || [];
  const completesInTimeline = timeline.filter(e => e.eventType === 'status' && String(e.note || '').includes('completed') || e.eventType === 'completed');
  assert.ok(completesInTimeline.length <= 1, '完成事件只应记录一次');
});

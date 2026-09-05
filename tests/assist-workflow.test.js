// 协助取件闭环回归：邀请持久化、协助人可见/可操作、越权封堵、统计口径、登录限速与安全头。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 38000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-assist-'));
let child;
let adminToken;
let csToken;
let workerAToken;
let workerBToken;
let workerCToken;
let courierA;
let courierB;
let courierC;
let taskId;

async function request(method, url, body, authToken, extraHeaders = {}) {
  const response = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: response.status, data, text };
}

async function login(username, password) {
  const res = await request('POST', '/api/v2/auth/login', { username, password }, null);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.data.data.token;
}

async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('服务未在预期时间内就绪');
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'app.db'),
      DISABLE_PUSH: '1',
      MACHINE_API_KEY: 'assist-machine-key',
      INITIAL_ADMIN_PASSWORD: 'test-admin-strong-password',
      PUSH_CONFIG_MASTER_KEY: Buffer.alloc(32, 9).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitHealthy();
  adminToken = await login('admin', 'test-admin-strong-password');

  const mkCourier = async (name) => {
    const res = await request('POST', '/api/couriers', { name }, adminToken);
    assert.equal(res.status, 200, res.text);
    return res.data.id;
  };
  courierA = await mkCourier('协助甲（主）');
  courierB = await mkCourier('协助乙（帮手）');
  courierC = await mkCourier('协助丙（无关）');
  const mkUser = async (username, courierId) => {
    const res = await request('POST', '/api/users', { username, password: username + '-pwd-123', role: 'courier', courierId, name: courierId }, adminToken);
    assert.equal(res.status, 200, res.text);
  };
  await mkUser('assist_worker_a', courierA);
  await mkUser('assist_worker_b', courierB);
  await mkUser('assist_worker_c', courierC);
  const csRes = await request('POST', '/api/users', { username: 'assist_cs', password: 'assist-cs-12345', role: 'cs', name: '协助客服' }, adminToken);
  assert.equal(csRes.status, 200, csRes.text);

  workerAToken = await login('assist_worker_a', 'assist_worker_a-pwd-123');
  workerBToken = await login('assist_worker_b', 'assist_worker_b-pwd-123');
  workerCToken = await login('assist_worker_c', 'assist_worker_c-pwd-123');
  csToken = await login('assist_cs', 'assist-cs-12345');
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

test('客服派单给甲 → 甲邀请乙协助 → 乙可见可操作且收到站内通知', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: '协助测试客户',
    address: '义乌市稠城街道',
    contact: '联系人', phone: '13800000000',
    defaultWorkerId: courierA,
    items: [{ waybillNo: 'ASSIST-WB-1', pieces: 1, goodsName: '样品' }]
  }, csToken);
  assert.equal(created.status, 201, created.text);
  taskId = created.data.data.task.id;

  const before = await request('GET', `/api/v2/tasks/${taskId}`, undefined, workerBToken);
  assert.equal(before.status, 403);

  const invited = await request('POST', `/api/tasks/${taskId}/assist`, { workerId: courierB }, workerAToken);
  assert.equal(invited.status, 201, invited.text);
  assert.deepEqual(invited.data.assistWorkerIds, [courierB]);
  assert.deepEqual(invited.data.workers.map(w => w.role).sort(), ['assist', 'primary']);

  const detailB = await request('GET', `/api/tasks/${taskId}`, undefined, workerBToken);
  assert.equal(detailB.status, 200);
  assert.equal(detailB.data.workers.find(w => w.userId === courierB).role, 'assist');

  const listB = await request('GET', '/api/worker/tasks', undefined, workerBToken);
  assert.equal(listB.data.some(task => task.id === taskId), true);

  const notificationsB = await request('GET', '/api/notifications', undefined, workerBToken);
  const inviteNote = notificationsB.data.find(note => note.type === 'pickupTask.assistInvited');
  assert.ok(inviteNote, '乙应收到协助邀请站内通知');
  assert.match(String(inviteNote.body), /协助测试客户/);
});

test('无关取件员丙不可读不可邀请；重复邀请与无效目标被拒', async () => {
  const detailC = await request('GET', `/api/tasks/${taskId}`, undefined, workerCToken);
  assert.equal(detailC.status, 403);
  const assistC = await request('POST', `/api/tasks/${taskId}/assist`, { workerId: courierC }, workerCToken);
  assert.equal(assistC.status, 403);

  const duplicate = await request('POST', `/api/v2/tasks/${taskId}/assist`, { workerId: courierB }, workerAToken);
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.data.error, /已在协助名单/);

  const badWorker = await request('POST', `/api/tasks/${taskId}/assist`, { workerId: 'no-such-worker' }, csToken);
  assert.equal(badWorker.status, 400);
  assert.match(badWorker.data.error, /不存在/);

  const emptyWorker = await request('POST', `/api/v2/tasks/${taskId}/assist`, {}, csToken);
  assert.equal(emptyWorker.status, 400);
});

test('协助人可按生命周期操作（甲开始、乙完成），完成后计数入乙的协助次数', async () => {
  await request('POST', `/api/tasks/${taskId}/start`, undefined, workerAToken);
  const started = await request('GET', `/api/tasks/${taskId}`, undefined, workerBToken);
  assert.equal(started.status, 200);

  const addItem = await request('POST', `/api/tasks/${taskId}/items`, { waybillNo: 'ASSIST-WB-2', pieces: 2, goodsName: '追加' }, workerBToken);
  assert.equal(addItem.status, 201, addItem.text);

  const completed = await request('POST', `/api/tasks/${taskId}/complete`, undefined, workerBToken);
  assert.equal(completed.status, 200, completed.text);

  const again = await request('POST', `/api/v2/tasks/${taskId}/assist`, { workerId: courierC }, workerAToken);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /已完成/);

  const statsB = await request('GET', '/api/dashboard/me', undefined, workerBToken);
  assert.equal(statsB.status, 200);
  assert.equal(statsB.data.assistCount, 1);
  assert.equal(typeof statsB.data.today.pickupCount, 'number');
  assert.equal(typeof statsB.data.month.matchedWeight, 'number');
  assert.equal(statsB.data.today.pickupCount, 0, '乙非主取件员，取件次数不因协助增加');

  // v2 与 v1 同构：同一完成口径与协助次数
  const statsV2 = await request('GET', '/api/v2/dashboard/me', undefined, workerBToken);
  assert.equal(statsV2.status, 200, statsV2.text);
  assert.equal(statsV2.data.data.assistCount, 1);
  assert.equal(statsV2.data.data.today.pickupCount, 0, 'v2 取件次数同样不因协助增加');
  assert.equal(statsV2.data.data.today.pieces, statsB.data.today.pieces);
  assert.equal(statsV2.data.data.month.pickupCount, statsB.data.month.pickupCount);
});

test('转派目标校验与协助人转派限制', async () => {
  const task = await request('POST', '/api/v2/tasks', {
    customerName: '转派校验客户', address: '义乌市北苑街道', defaultWorkerId: courierA
  }, csToken);
  const transferTaskId = task.data.data.task.id;
  const badTarget = await request('POST', `/api/tasks/${transferTaskId}/transfer`, { workerId: 'no-such-worker' }, workerAToken);
  assert.equal(badTarget.status, 400);
  assert.match(badTarget.data.error, /取件员不存在/);

  const assistantTransfer = await request('POST', `/api/tasks/${transferTaskId}/transfer`, { workerId: courierB }, workerBToken);
  assert.equal(assistantTransfer.status, 403);

  const okTransfer = await request('POST', `/api/tasks/${transferTaskId}/transfer`, { workerId: courierB }, workerAToken);
  assert.equal(okTransfer.status, 200, okTransfer.text);
  assert.equal(okTransfer.data.defaultWorkerId, courierB);
});

test('登录连续失败触发限速（429），成功登录清空计数', async () => {
  const uniqueUser = 'throttle_probe';
  let status = 200;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const res = await request('POST', '/api/login', { username: uniqueUser, password: 'wrong-password' }, null);
    status = res.status;
  }
  assert.equal(status, 429);
  const blocked = await request('POST', '/api/v2/auth/login', { username: uniqueUser, password: 'still-wrong' }, null);
  assert.equal(blocked.status, 429);

  const login = await request('POST', '/api/login', { username: 'assist_cs', password: 'assist-cs-12345' }, null);
  assert.equal(login.status, 200);
});

test('基础安全响应头存在', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('客户自助查单覆盖新任务模型（业务订单号/面单号/任务号/手机+姓氏）', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: '查单客户甲', address: '义乌市福田街道', phone: '13900001111',
    businessOrderNo: 'AUDIT-TRACK-1', defaultWorkerId: courierA,
    items: [{ waybillNo: 'AUDIT-WB-TRACK', pieces: 3, goodsName: '查单货' }]
  }, csToken);
  assert.equal(created.status, 201, created.text);
  const task = created.data.data.task;

  for (const query of ['AUDIT-TRACK-1', 'AUDIT-WB-TRACK', task.taskNo]) {
    const res = await request('GET', `/api/track?q=${encodeURIComponent(query)}`, undefined, null);
    assert.equal(res.status, 200, query + ':' + res.text);
    assert.equal(res.data.status, '待取');
    assert.ok(res.data.timeline.length >= 1);
  }

  const miss = await request('GET', '/api/track?q=NO-SUCH-ORDER-404', undefined, null);
  assert.equal(miss.status, 404);

  const byPhone = await request('GET', '/api/track?phone=13900001111&surname=查', undefined, null);
  assert.equal(byPhone.status, 200, byPhone.text);
  const wrongSurname = await request('GET', '/api/track?phone=13900001111&surname=王', undefined, null);
  assert.equal(wrongSurname.status, 404);
});

// 删除保护与姓名快照回归：进行中任务/协助/绑定账号/客户引用时的删除拦截；
// 档案删除与改名后，历史任务/明细/协助上的姓名通过快照保持可追溯（v1/v2 同口径）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 38000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-archive-'));
let child;
let adminToken;

async function request(method, url, body, authToken) {
  const response = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {})
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

let courierSeq = 0;
async function mkCourier(name) {
  const res = await request('POST', '/api/couriers', { name }, adminToken);
  assert.equal(res.status, 200, res.text);
  return res.data.id;
}
async function mkUser(username, courierId) {
  const res = await request('POST', '/api/users', {
    username, password: username + '-pwd-123', role: 'courier', courierId, name: courierId
  }, adminToken);
  assert.equal(res.status, 200, res.text);
  return res.data.id;
}
async function mkCustomer(name) {
  const res = await request('POST', '/api/customers', { name, address: '义乌市稠城街道 ' + name }, adminToken);
  assert.equal(res.status, 200, res.text);
  return res.data.id;
}
async function mkTask(customerId, defaultWorkerId, itemWorkers = []) {
  const res = await request('POST', '/api/tasks', {
    customerId, address: '义乌市稠城街道测试路', contact: '档案测试联系人', phone: '13800000000',
    defaultWorkerId,
    items: itemWorkers.map((workerId, index) => ({ goodsName: '纸箱' + index, pieces: 1, workerId }))
  }, adminToken);
  assert.equal(res.status, 201, res.text);
  return res.data.id;
}
async function finishTask(taskId) {
  const started = await request('POST', `/api/tasks/${taskId}/start`, {}, adminToken);
  assert.equal(started.status, 200, started.text);
  const completed = await request('POST', `/api/tasks/${taskId}/complete`, {}, adminToken);
  assert.equal(completed.status, 200, completed.text);
}
const workerNames = (task) => (task.workers || []).map(worker => `${worker.role}:${worker.name}`);

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'app.db'),
      DISABLE_PUSH: '1',
      MACHINE_API_KEY: 'archive-machine-key',
      INITIAL_ADMIN_PASSWORD: 'test-admin-strong-password',
      PUSH_CONFIG_MASTER_KEY: Buffer.alloc(32, 9).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitHealthy();
  adminToken = await login('admin', 'test-admin-strong-password');
});

test.after(() => {
  if (child) child.kill();
});

test('进行中任务（主/协助/明细归属）阻止删除档案，任务结束后删除保留全部姓名', async () => {
  const courierA = await mkCourier('快照甲');
  const courierB = await mkCourier('快照乙');
  const customer = await mkCustomer('快照客户A');
  const taskId = await mkTask(customer, courierA, [courierB]);

  // 主取件员有进行中任务 → v1/v2 均拒绝
  const v1Blocked = await request('DELETE', `/api/couriers/${courierA}`, undefined, adminToken);
  assert.equal(v1Blocked.status, 400);
  assert.match(v1Blocked.data.error, /进行中的任务/);
  const v2Blocked = await request('DELETE', `/api/v2/couriers/${courierA}`, undefined, adminToken);
  assert.equal(v2Blocked.status, 400);
  assert.match(v2Blocked.data.error, /进行中的任务/);

  // 明细归属取件员有进行中任务 → 拒绝
  const v1ItemBlocked = await request('DELETE', `/api/couriers/${courierB}`, undefined, adminToken);
  assert.equal(v1ItemBlocked.status, 400);
  assert.match(v1ItemBlocked.data.error, /进行中的任务/);

  // 客户有进行中任务 → 拒绝删除；完成后再删
  const customerBlocked = await request('DELETE', `/api/customers/${customer}`, undefined, adminToken);
  assert.equal(customerBlocked.status, 400);
  assert.match(customerBlocked.data.error, /进行中的任务/);

  await finishTask(taskId);
  // dashboard/workers 聚合口径（原逐人查询语义）：主取件完成 1 单、件数/客户数一致
  const workers = await request('GET', '/api/dashboard/workers', undefined, adminToken);
  assert.equal(workers.status, 200, workers.text);
  const rowA = workers.data.find(row => row.id === courierA);
  const rowB = workers.data.find(row => row.id === courierB);
  assert.ok(rowA && rowB, '聚合看板应包含两位取件员');
  assert.equal(rowA.pickupCount, 1);
  assert.equal(rowA.pieces, 1);
  assert.equal(rowA.customerCount, 1);
  assert.equal(rowA.pending, 0);
  assert.equal(rowB.pickupCount, 0, '明细归属不计入默认取件员的取件数');
  for (const key of ['pickupCount', 'customerCount', 'pieces', 'weight', 'assistCount', 'pending']) {
    assert.equal(typeof rowA[key], 'number', key);
  }
  const customerRemoved = await request('DELETE', `/api/customers/${customer}`, undefined, adminToken);
  assert.equal(customerRemoved.status, 200, customerRemoved.text);

  const deletedA = await request('DELETE', `/api/couriers/${courierA}`, undefined, adminToken);
  assert.equal(deletedA.status, 200, deletedA.text);
  const deletedB = await request('DELETE', `/api/v2/couriers/${courierB}`, undefined, adminToken);
  assert.equal(deletedB.status, 200, deletedB.text);

  // 档案删除后：v1/v2 详情仍能显示主取件员与明细归属取件员的姓名快照
  const v1Detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.equal(v1Detail.status, 200);
  assert.equal(v1Detail.data.defaultWorkerName, '快照甲');
  assert.equal(v1Detail.data.items[0].workerName, '快照乙');
  assert.equal(v1Detail.data.customerName, '快照客户A');
  const v2Detail = await request('GET', `/api/v2/tasks/${taskId}`, undefined, adminToken);
  assert.equal(v2Detail.status, 200, v2Detail.text);
  assert.ok(v2Detail && v2Detail.data && v2Detail.data.data.task, v2Detail.text);
  assert.equal(v2Detail.data.data.task.defaultWorkerName, '快照甲');
});

test('协助关系阻止删除；任务结束后协助人姓名由快照保留', async () => {
  const primary = await mkCourier('协助主快照');
  const assist = await mkCourier('协助快照帮');
  const customer = await mkCustomer('协助快照客户');
  const taskId = await mkTask(customer, primary);
  const invite = await request('POST', `/api/tasks/${taskId}/assist`, { workerId: assist }, adminToken);
  assert.equal(invite.status, 201, invite.text);

  const blocked = await request('DELETE', `/api/v2/couriers/${assist}`, undefined, adminToken);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /进行中的任务/);

  await finishTask(taskId);
  const deleted = await request('DELETE', `/api/couriers/${assist}`, undefined, adminToken);
  assert.equal(deleted.status, 200, deleted.text);

  const v1Detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.deepEqual(workerNames(v1Detail.data).filter(name => name.startsWith('assist:')), ['assist:协助快照帮']);
  const v2Detail = await request('GET', `/api/v2/tasks/${taskId}`, undefined, adminToken);
  assert.equal(v2Detail.status, 200, v2Detail.text);
  assert.ok(v2Detail && v2Detail.data && v2Detail.data.data.task, v2Detail.text);
  assert.deepEqual(workerNames(v2Detail.data.data.task).filter(name => name.startsWith('assist:')), ['assist:协助快照帮']);
});

test('绑定登录账号时禁止删除档案，解绑后放行', async () => {
  const courier = await mkCourier('绑定快照');
  const userId = await mkUser(`bound_worker_${courierSeq++}`, courier);
  const customer = await mkCustomer('绑定快照客户');
  const taskId = await mkTask(customer, courier);
  await finishTask(taskId);

  const blocked = await request('DELETE', `/api/couriers/${courier}`, undefined, adminToken);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /绑定着登录账号/);

  const userRemoved = await request('DELETE', `/api/users/${userId}`, undefined, adminToken);
  assert.equal(userRemoved.status, 200, userRemoved.text);
  const deleted = await request('DELETE', `/api/couriers/${courier}`, undefined, adminToken);
  assert.equal(deleted.status, 200, deleted.text);
  const detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.equal(detail.data.defaultWorkerName, '绑定快照');
});

test('档案改名后快照同步，删除后详情展示新名', async () => {
  const courier = await mkCourier('改名旧名');
  const customer = await mkCustomer('改名快照客户');
  const taskId = await mkTask(customer, courier);
  const assist = await mkCourier('改名帮');
  await request('POST', `/api/tasks/${taskId}/assist`, { workerId: assist }, adminToken);

  const renamed = await request('PUT', `/api/v2/couriers/${courier}`, { name: '改名新名' }, adminToken);
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.data.data.courier.name, '改名新名');
  const v1Renamed = await request('PUT', `/api/couriers/${assist}`, { name: '改名帮新' }, adminToken);
  assert.equal(v1Renamed.status, 200, v1Renamed.text);

  await finishTask(taskId);
  await request('DELETE', `/api/couriers/${courier}`, undefined, adminToken);
  await request('DELETE', `/api/couriers/${assist}`, undefined, adminToken);

  const detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.equal(detail.data.defaultWorkerName, '改名新名');
  assert.deepEqual(workerNames(detail.data).filter(name => name.startsWith('assist:')), ['assist:改名帮新']);
  const v2Detail = await request('GET', `/api/v2/tasks/${taskId}`, undefined, adminToken);
  assert.equal(v2Detail.status, 200, v2Detail.text);
  assert.ok(v2Detail && v2Detail.data && v2Detail.data.data.task, v2Detail.text);
  assert.equal(v2Detail.data.data.task.defaultWorkerName, '改名新名');
});

test('转派/改派后默认取件员姓名快照随目标更新', async () => {
  const first = await mkCourier('转派甲');
  const second = await mkCourier('转派乙');
  const customer = await mkCustomer('转派快照客户');
  const taskId = await mkTask(customer, first);

  const transferred = await request('POST', `/api/tasks/${taskId}/transfer`, { workerId: second }, adminToken);
  assert.equal(transferred.status, 200, transferred.text);
  assert.equal(transferred.data.defaultWorkerName, '转派乙');

  const v2Detail = await request('GET', `/api/v2/tasks/${taskId}`, undefined, adminToken);
  assert.equal(v2Detail.status, 200, v2Detail.text);
  assert.ok(v2Detail && v2Detail.data && v2Detail.data.data.task, v2Detail.text);
  assert.equal(v2Detail.data.data.task.defaultWorkerName, '转派乙');

  await finishTask(taskId);
  const deleted = await request('DELETE', `/api/couriers/${first}`, undefined, adminToken);
  assert.equal(deleted.status, 200, deleted.text);
  const detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.equal(detail.data.defaultWorkerName, '转派乙');
});

test('补录明细的归属取件员删除后，明细仍显示其姓名快照', async () => {
  const courier = await mkCourier('补录快照');
  const courierUser = await mkUser(`item_worker_${courierSeq++}`, courier);
  const customer = await mkCustomer('补录快照客户');
  const taskId = await mkTask(customer, courier);
  const workerToken = await login(`item_worker_${courierSeq - 1}`, `item_worker_${courierSeq - 1}-pwd-123`);

  // 取件员本人补录一票：归属该取件员并落姓名快照
  const added = await request('POST', `/api/tasks/${taskId}/items`, { goodsName: '补录箱', pieces: 1 }, workerToken);
  assert.equal(added.status, 201, added.text);
  assert.equal(added.data.items.length, 1, added.text);
  assert.equal(added.data.items[0].workerName, '补录快照');

  await finishTask(taskId);
  const userRemoved = await request('DELETE', `/api/users/${courierUser}`, undefined, adminToken);
  assert.equal(userRemoved.status, 200, userRemoved.text);
  const deleted = await request('DELETE', `/api/couriers/${courier}`, undefined, adminToken);
  assert.equal(deleted.status, 200, deleted.text);

  const detail = await request('GET', `/api/tasks/${taskId}`, undefined, adminToken);
  assert.equal(detail.data.items.length, 1, detail.text);
  assert.equal(detail.data.items[0].workerName, '补录快照');
});

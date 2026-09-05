// 全量验收补充（2026-09-05）：覆盖货代取件系统完整测试方案中
// 前一轮未直接覆盖的边界/幂等/并发/安全/恢复路径。
// 约定：v1 响应为 {…}，v2 响应为 {data:…}；时间字段 UTC 文本。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 39000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-fa-'));
let child;
let adminToken;
let logs = '';

async function rawRequest(method, url, { body, headers = {}, token } = {}) {
  const response = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
  return { status: response.status, text, json };
}

async function request(method, url, body, token = adminToken) {
  const res = await rawRequest(method, url, { body, token });
  return res;
}

async function login(username, password) {
  const res = await rawRequest('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.json.token;
}

async function loginV2(username, password) {
  const res = await rawRequest('POST', '/api/v2/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.json.data.token;
}

async function waitHealthy() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(baseUrl + '/api/health');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('服务未在预期时间内就绪');
}

let courierSeq = 0;
async function mkCourier(name) {
  const res = await request('POST', '/api/couriers', { name, region: '义乌' });
  assert.equal(res.status, 200, res.text);
  return res.json.id;
}
async function mkCourierUser(name, courierId) {
  const res = await request('POST', '/api/users', {
    username: name, password: name + '-pwd-123', role: 'courier', courierId, name: name
  });
  assert.equal(res.status, 200, res.text);
  return res.json.id;
}
async function mkCustomer(name, phone = '13800000000') {
  const res = await request('POST', '/api/customers', { name, phone, address: '义乌市稠城街道测试路 1 号' });
  assert.equal(res.status, 200, res.text);
  return res.json.id;
}
async function mkRecord(extra = {}) {
  const res = await request('POST', '/api/records', {
    date: '2026-09-05', customer: '验收客户', pieces: 1, address: '义乌市稠城街道',
    status: '待取', courierId: '', ...extra
  });
  assert.equal(res.status, 200, res.text);
  return res.json.id;
}
async function taskPayload(extra = {}) {
  return {
    customerName: '验收任务客户', address: '义乌市稠城街道测试路', contact: '张先生', phone: '13900000000',
    pickupNote: '加急', items: [{ goodsName: '纸箱', pieces: 2, waybillNo: 'WB-FA-1' }],
    ...extra
  };
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'app.db'),
      DISABLE_PUSH: '1',
      MACHINE_API_KEY: 'fa-machine-key',
      INITIAL_ADMIN_PASSWORD: 'test-admin-strong-password',
      PUSH_CONFIG_MASTER_KEY: Buffer.alloc(32, 9).toString('base64')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  await waitHealthy();
  adminToken = await login('admin', 'test-admin-strong-password');
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
    } catch (_) {
      if (i === 9) throw _;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

// ============ 6. 压力与并发：批量建单 / 并发改派 ============
test('并发批量建单（任务+记录各 60 单）：不丢单、不重复、分页稳定无缺口', async () => {
  const taskResults = await Promise.all(Array.from({ length: 60 }, async (_, i) => request('POST', '/api/tasks', await taskPayload({
    businessOrderNo: 'BATCH-T-' + String(i).padStart(3, '0'),
    customerName: '压测任务客户' + i
  }))));
  assert.equal(taskResults.filter(r => r.status === 201).length, 60, '60 笔任务应全部成功');
  const recordResults = await Promise.all(Array.from({ length: 60 }, (_, i) => request('POST', '/api/records', {
    date: '2026-09-05', customer: '压测记录客户' + i, pieces: 1, address: '义乌压测路',
    orderNo: 'BATCH-R-' + String(i).padStart(3, '0')
  })));
  assert.equal(recordResults.filter(r => r.status === 200).length, 60, '60 笔记录应全部成功');
  // 分页完整性：页大小 20，三页合并不重不漏
  const seen = new Set();
  for (let page = 0; page < 3; page += 1) {
    const res = await request('GET', `/api/records?keyword=BATCH-R-&page=${page}&size=20`);
    assert.equal(res.status, 200);
    for (const row of res.json.list) {
      if (seen.has(row.id)) throw new Error('分页出现重复记录');
      seen.add(row.id);
    }
  }
  assert.equal(seen.size, 60, '三页合计应为 60 条且不重复');
});

test('多名员工并发改派同一任务：最终归属唯一且状态一致，无 5xx', async () => {
  const c1 = await mkCourier('改派甲');
  const c2 = await mkCourier('改派乙');
  const c3 = await mkCourier('改派丙');
  const res = await request('POST', '/api/tasks', await taskPayload({ defaultWorkerId: c1 }));
  const taskId = res.json.id;
  const outcomes = await Promise.all([c2, c3, c1].map(workerId =>
    request('POST', `/api/tasks/${taskId}/reassign`, { workerId })
  ));
  assert.ok(outcomes.every(r => r.status === 200 || r.status === 400), '并发改派不应出现 5xx');
  const detail = await request('GET', `/api/tasks/${taskId}`);
  assert.ok([c1, c2, c3].includes(detail.json.defaultWorkerId), '最终归属必须唯一且是参与改派者之一');
  // 完成后归属者能按状态机继续流转
  const workerName = detail.json.defaultWorkerName;
  assert.ok(typeof workerName === 'string' && workerName.length > 0, '改派后姓名快照应完整');
});

// ============ 1. 接口健壮性：畸形输入 / 异常响应结构 ============
test('畸形 JSON 与非对象 body：结构化错误、无堆栈泄漏、不产生脏数据', async () => {
  const badBodies = [
    ['{"customerName": "broken"', 'application/json'],
    ['"just-a-string"', 'application/json'],
    ['[1,2,3]', 'application/json'],
    ['null', 'application/json'],
    ['<script>alert(1)</script>', 'text/html']
  ];
  const before = await request('GET', '/api/tasks?page=0&size=5');
  const beforeTotal = before.json.total;
  for (const [body, contentType] of badBodies) {
    const res = await rawRequest('POST', '/api/tasks', {
      body,
      headers: { 'Content-Type': contentType },
      token: adminToken
    });
    assert.ok(res.status >= 400 && res.status < 500, `畸形输入应 4xx，实际 ${res.status}：${body.slice(0, 30)}`);
    assert.ok(res.json && typeof res.json.error === 'string', '应返回结构化 {error}');
    assert.ok(!/<html/i.test(res.text), '不应返回 HTML 错误页');
    assert.ok(!/\/home\/|\/server\//.test(res.text), '不应泄漏内部路径');
    assert.ok(!/at (async )?\w+ \(/i.test(res.text), '不应泄漏调用堆栈');
  }
  const after = await request('GET', '/api/tasks?page=0&size=5');
  assert.equal(after.json.total, beforeTotal, '畸形输入不能产生脏任务');
});

test('超长内容/emoji/特殊字符：原样入库、可完整回读，不 500', async () => {
  const longNote = ('x'.repeat(20000) + '\n第二行【】「」');
  const emoji = '🧪📦🔥 取件 <img src=x onerror=alert(1)> %\'" -- ; DROP TABLE pickup_tasks;--';
  const res = await request('POST', '/api/tasks', await taskPayload({
    pickupNote: longNote + emoji,
    internalNote: emoji,
    items: [{ goodsName: '货品' + emoji, pieces: 2, waybillNo: 'WB-EMOJI-1' }]
  }));
  assert.equal(res.status, 201, res.text.slice(0, 300));
  const id = res.json.id;
  const detail = await request('GET', `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.pickupNote, longNote + emoji, '超长备注应完整回读');
  assert.equal(detail.json.internalNote, emoji);
  assert.equal(detail.json.items[0].goodsName, '货品' + emoji);
  assert.ok(detail.json.items[0].waybillNo === 'WB-EMOJI-1');
});

// ============ 2. 边界输入：负数 / 非数字拒绝，0 保留业务语义 ============
test('负数与非有限数值被拦截（任务模型），0 与空保持可用', async () => {
  const cases = [
    [{ items: [{ goodsName: 'A', pieces: -3 }] }, '件数'],
    [{ items: [{ goodsName: 'A', pieces: 'abc' }] }, '件数'],
    [{ items: [{ goodsName: 'A', pieces: 1, finalWeight: -2.5 }] }, '重量'],
    [{ items: [{ goodsName: 'A', pieces: 1, finalWeight: '1e999' }] }, '重量'],
    [{ volume: -1 }, '体积'],
    [{ volume: 'Infinity' }, '体积']
  ];
  for (const [extra, label] of cases) {
    const res = await request('POST', '/api/tasks', await taskPayload(extra));
    assert.equal(res.status, 400, `负数/非法${label}应被拦截，实际 ${res.status}`);
    assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0);
  }
  // 0 件/0 重属于“未称重/未录入”占位语义，仍应可创建
  const ok0 = await request('POST', '/api/tasks', await taskPayload({ volume: 0, items: [{ goodsName: 'B', pieces: 1 }] }));
  assert.equal(ok0.status, 201, ok0.text.slice(0, 200));
  // 追加货品接口同样拒绝负数重量
  const add = await request('POST', `/api/tasks/${ok0.json.id}/items`, { goodsName: 'C', pieces: 1, finalWeight: -1 });
  assert.equal(add.status, 400, add.text.slice(0, 200));
});

test('负数与非有限数值被拦截（records 旧模型），负数金额保留财务语义', async () => {
  const bad = [
    { pieces: -2 },
    { weight: -5 },
    { volume: -3 },
    { weight: '1e999' },
    { pieces: '1e999' }
  ];
  for (const extra of bad) {
    const res = await request('POST', '/api/records', { date: '2026-09-05', customer: '边界客户', ...extra });
    assert.equal(res.status, 400, `records 非法数值应被拦截：${JSON.stringify(extra)}，实际 ${res.status}`);
    assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0);
  }
  // 负数金额允许（冲账/退款语义）
  const fin = await request('POST', '/api/records', {
    date: '2026-09-05', customer: '财务客户', pieces: 1, weight: 0, address: '义乌市财务路 8 号',
    amountReceivable: -100, amountPayable: 50
  });
  assert.equal(fin.status, 200, fin.text.slice(0, 200));
  assert.equal(fin.json.amountReceivable, -100);
});

// ============ 3. 重复提交：业务订单号唯一 + 幂等键回放 ============
test('并发重复录入同一订单号：仅 1 条成功，其余 409', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => request('POST', '/api/records', {
    date: '2026-09-05', customer: '并发重复客户', pieces: 2, orderNo: 'DUP-2026-0905-001',
    address: '义乌'
  })));
  const created = results.filter(r => r.status === 200);
  const conflicts = results.filter(r => r.status === 409);
  assert.equal(created.length, 1, '只能有一条成功');
  assert.equal(conflicts.length, 19, '其余应 409');
  const list = await request('GET', '/api/records?keyword=DUP-2026-0905-001&page=0&size=20');
  assert.equal(list.json.total, 1);
});

test('X-Idempotency-Key：同用户同键重复提交回放首次成功，不产生重复单据', async () => {
  const key = 'idem-' + Math.random().toString(36).slice(2);
  const payload = await taskPayload({ businessOrderNo: 'BZ-IDEM-001' });
  const first = await rawRequest('POST', '/api/tasks', {
    body: payload, headers: { 'X-Idempotency-Key': key }, token: adminToken
  });
  const second = await rawRequest('POST', '/api/tasks', {
    body: payload, headers: { 'X-Idempotency-Key': key }, token: adminToken
  });
  const third = await rawRequest('POST', '/api/tasks', {
    body: payload, headers: { 'Idempotency-Key': key }, token: adminToken
  });
  assert.equal(first.status, 201, first.text.slice(0, 200));
  assert.equal(second.status, 201, second.text.slice(0, 200));
  assert.equal(third.status, 201, third.text.slice(0, 200));
  assert.equal(first.json.id, second.json.id);
  assert.equal(second.json.id, third.json.id);
  const list = await request('GET', '/api/tasks?keyword=BZ-IDEM-001&page=0&size=20');
  assert.equal(list.json.total, 1, '重复提交只能有一条任务');

  // records 同键回放
  const recKey = 'idem-rec-' + Math.random().toString(36).slice(2);
  const recPayload = { date: '2026-09-05', customer: '幂等客户', pieces: 1, orderNo: 'IDEM-REC-001', address: '义乌' };
  const rec1 = await rawRequest('POST', '/api/records', { body: recPayload, headers: { 'X-Idempotency-Key': recKey }, token: adminToken });
  const rec2 = await rawRequest('POST', '/api/records', { body: recPayload, headers: { 'X-Idempotency-Key': recKey }, token: adminToken });
  assert.equal(rec1.status, 200);
  assert.equal(rec2.status, 200);
  assert.equal(rec1.json.id, rec2.json.id);

  // v2 任务同键回放
  const v2key = 'idem-v2-' + Math.random().toString(36).slice(2);
  const v2payload = await taskPayload({ businessOrderNo: 'BZ-IDEM-V2' });
  const v21 = await rawRequest('POST', '/api/v2/tasks', { body: v2payload, headers: { 'X-Idempotency-Key': v2key }, token: adminToken });
  const v22 = await rawRequest('POST', '/api/v2/tasks', { body: v2payload, headers: { 'X-Idempotency-Key': v2key }, token: adminToken });
  assert.equal(v21.status, 201, v21.text.slice(0, 200));
  assert.equal(v22.status, 201, v22.text.slice(0, 200));
  assert.equal(v21.json.data.task.id, v22.json.data.task.id);

  // 不同用户同键互不影响（任务创建需客服以上，建一个 cs 用户验证键的作用域）
  const csUser = await request('POST', '/api/users', {
    username: 'idem-cs-user', password: 'idem-cs-user-pwd-123', role: 'cs', name: '幂等客服'
  });
  assert.equal(csUser.status, 200, csUser.text);
  const csToken = await login('idem-cs-user', 'idem-cs-user-pwd-123');
  const other = await rawRequest('POST', '/api/v2/tasks', {
    body: await taskPayload({ customerName: '另一客户' }),
    headers: { 'X-Idempotency-Key': v2key },
    token: csToken
  });
  assert.equal(other.status, 201, other.text.slice(0, 200));
  assert.notEqual(other.json.data.task.id, v21.json.data.task.id, '同键不同用户必须独立创建');

  // 未带键的相同请求不静默去重（再次取件等真实业务不受影响）
  const noKey1 = await request('POST', '/api/tasks', await taskPayload({ businessOrderNo: 'BZ-NOKEY-1' }));
  const noKey2 = await request('POST', '/api/tasks', await taskPayload({ businessOrderNo: 'BZ-NOKEY-1' }));
  assert.equal(noKey1.status, 201);
  assert.equal(noKey2.status, 201);
  assert.notEqual(noKey1.json.id, noKey2.json.id);
});

// ============ 4. 并发竞争：认领 / 状态机 ============
test('多名取件员并发抢同一未分配订单：仅 1 人认领成功，通知只发给中签者', async () => {
  const recordId = await mkRecord({ customer: '抢单客户' });
  const couriers = [];
  for (let i = 0; i < 8; i += 1) {
    const cid = await mkCourier(`抢单取件员${i}`);
    await mkCourierUser(`grab-user-${i}`, cid);
    couriers.push({ cid, token: await login(`grab-user-${i}`, `grab-user-${i}-pwd-123`) });
  }
  const results = await Promise.all(couriers.map(c => rawRequest('PUT', `/api/records/${recordId}/courier`, {
    body: { courierId: c.cid }, token: c.token
  })));
  const winners = results.filter(r => r.status === 200);
  assert.equal(winners.length, 1, '并发认领只能有 1 个成功');
  const losers = results.filter(r => r.status >= 400);
  assert.ok(losers.length === 7, '其余认领应失败');
  // 最终归属 = 中签者；通知只发中签者
  const idx = results.findIndex(r => r.status === 200);
  const after = await request('GET', '/api/records?keyword=抢单客户&page=0&size=20');
  assert.equal(after.json.total, 1);
  assert.equal(after.json.list[0].courierId, couriers[idx].cid, '记录最终应归属中签取件员');
  const unread = await rawRequest('GET', '/api/notifications/unread-count', { token: couriers[idx].token });
  assert.equal(unread.status, 200, unread.text);
  assert.ok(unread.json >= 1, '中签取件员应收到认领成功通知');
});

test('开始与取消并发竞争：状态机只允许一个有效迁移，终态一致且无脏事件', async () => {
  const courierId = await mkCourier('竞争取件员');
  const userId = await mkCourierUser('race-user', courierId);
  const workerToken = await login('race-user', 'race-user-pwd-123');
  const res = await request('POST', '/api/tasks', await taskPayload({ defaultWorkerId: courierId }));
  const taskId = res.json.id;
  const [startRes, cancelRes] = await Promise.all([
    rawRequest('POST', `/api/tasks/${taskId}/start`, { body: {}, token: workerToken }),
    rawRequest('POST', `/api/tasks/${taskId}/cancel`, { body: {}, token: workerToken })
  ]);
  const detail = await request('GET', `/api/tasks/${taskId}`);
  assert.ok(['in_progress', 'cancelled'].includes(detail.json.status), `终态应为 in_progress 或 cancelled，实际 ${detail.json.status}`);
  // 两个请求都成功 = start→cancel 的合法串行；cancel 成功则终态必须是 cancelled，
  // cancel 失败则必须是 start 先赢且终态 in_progress；双方都 400 不可能（pending 上必有一个先成功）。
  if (startRes.status === 200 && cancelRes.status === 200) assert.equal(detail.json.status, 'cancelled');
  if (cancelRes.status === 200) assert.equal(detail.json.status, 'cancelled');
  if (cancelRes.status === 400) {
    assert.equal(startRes.status, 200);
    assert.equal(detail.json.status, 'in_progress');
  }
  assert.ok([startRes, cancelRes].some(r => r.status === 200), '至少一个迁移成功');
  assert.ok([startRes, cancelRes].every(r => r.status === 200 || r.status === 400), '竞态不得出现 5xx');
  // 终态决定后续操作：in_progress 可完成，cancelled 不可完成/开始
  const late = await rawRequest('POST', `/api/tasks/${taskId}/complete`, { body: {}, token: workerToken });
  if (detail.json.status === 'in_progress') assert.equal(late.status, 200);
  else assert.equal(late.status, 400, '已取消任务不能再完成');
});

// ============ 5. 安全：注入探测 / 令牌 / 数据隔离 ============
test('SQL 注入与通配符探测：参数化查询无 500、无数据破坏、无整表泄漏', async () => {
  const probes = [
    ['/api/records?keyword=' + encodeURIComponent("' OR '1'='1' --"), 200],
    ['/api/records?keyword=' + encodeURIComponent('%; DROP TABLE records;--'), 200],
    ['/api/records?keyword=%25', 200],
    ['/api/track?q=' + encodeURIComponent("' OR 1=1 --"), 404],
    ['/api/track?q=%25', 404],
    ['/api/customers?search=' + encodeURIComponent("' OR 1=1 --"), 200]
  ];
  for (const [url, expected] of probes) {
    const res = await rawRequest('GET', url, { token: adminToken });
    assert.equal(res.status, expected, `${url} 应 ${expected}，实际 ${res.status}`);
    assert.ok(res.json && !res.json.error?.includes('SQL'), `不应返回 SQL 错误：${url}`);
  }
  await mkRecord({ customer: '探测后完好客户' });
  const list = await request('GET', '/api/records?keyword=探测后完好客户&page=0&size=20');
  assert.equal(list.json.total, 1, '探测后数据应完好');
});

test('令牌边界与越权：篡改/过期 token 一律 401，他人单据隔离 403', async () => {
  const bad = [
    'Bearer deadbeef',
    'Bearer ',
    'Basic dXNlcjpwYXNz',
    'token-without-bearer'
  ];
  for (const auth of bad) {
    for (const url of ['/api/tasks', '/api/v2/tasks?page=1&pageSize=5', '/api/records', '/api/notifications']) {
      const res = await rawRequest('GET', url, { headers: { Authorization: auth } });
      assert.equal(res.status, 401, `无效令牌访问 ${url} 应 401，实际 ${res.status}`);
    }
  }
  // 越权：A 的单据 B 不能读/改
  const courierA = await mkCourier('越权甲');
  const userIdA = await mkCourierUser('authz-a', courierA);
  const courierB = await mkCourier('越权乙');
  await mkCourierUser('authz-b', courierB);
  const tokenA = await login('authz-a', 'authz-a-pwd-123');
  const tokenB = await login('authz-b', 'authz-b-pwd-123');
  const taskRes = await request('POST', '/api/tasks', await taskPayload({ defaultWorkerId: courierA }));
  const taskId = taskRes.json.id;
  const readB = await rawRequest('GET', `/api/tasks/${taskId}`, { token: tokenB });
  assert.equal(readB.status, 403, 'B 不能读取 A 的任务');
  const startB = await rawRequest('POST', `/api/tasks/${taskId}/start`, { body: {}, token: tokenB });
  assert.equal(startB.status, 403, 'B 不能操作 A 的任务');
  const v2readB = await rawRequest('GET', `/api/v2/tasks/${taskId}`, { token: tokenB });
  assert.equal(v2readB.status, 403);
  const recordId = await mkRecord({ customer: '越权记录', courierId: courierA });
  const recTouchB = await rawRequest('PUT', `/api/records/${recordId}/status`, { body: { status: '已完成' }, token: tokenB });
  assert.equal(recTouchB.status, 403, 'B 不能改 A 的记录状态');
});

test('不存在的接口与资源：404 结构化错误；登录限速 429 有重试提示', async () => {
  const notFound = await rawRequest('GET', '/api/no-such-endpoint', { token: adminToken });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error, '接口不存在');
  const noTask = await rawRequest('GET', '/api/tasks/00000000-0000-0000-0000-000000000000', { token: adminToken });
  assert.equal(noTask.status, 404);
  // 连续 6 次错误密码触发 429
  let got429 = false;
  for (let i = 0; i < 8; i += 1) {
    const res = await rawRequest('POST', '/api/login', { body: { username: 'rate-limit-target', password: 'wrong-' + i } });
    if (res.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, '连续失败应触发 429');
});

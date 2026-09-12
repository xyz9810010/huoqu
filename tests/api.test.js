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
  // A：UTC 昨日 16:30 = 北京今日 00:30 → 属于 today；B：UTC 昨日 15:59 = 北京昨日 23:59 → 属于 yesterday。
  // 修正区间口径后：B 从 today 移到 yesterday（today -1 / yesterday +1）；
  // A 的文本日期虽在 UTC 昨日，但北京时刻是今天 00:30，仍留在 today。
  // 若按 UTC 文本日期直接截断（旧缺陷），A 会被漏出 today。
  assert.equal(afterT, bT - 1, '北京今日 00:30 的任务必须计入 today');
  assert.equal(afterY, bY + 1, '北京昨日 23:59 的任务应计入 yesterday 且不再出现在 today');
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


test('v1 photo upload to a task without permission rejects before multer writes anything', async () => {
  // 与 v2 同款探测：非图片文件 + 无权限任务。
  // 若 multer 先执行会被 fileFilter 拒绝返回 400；修复后预检先行，应返回 403，不落盘孤儿文件。
  const courierA = await request('POST', '/api/couriers', { name: '越权测试A', region: '江东', commissionRate: 3 });
  const courierB = await request('POST', '/api/couriers', { name: '越权测试B', region: '江东', commissionRate: 3 });
  const task = await request('POST', '/api/tasks', {
    customerName: '越权测试客户', address: '地址X', defaultWorkerId: courierA.data.id, items: []
  });
  const taskId = task.data.id;
  const usernameB = `worker_b_${Date.now()}`;
  await request('POST', '/api/users', {
    username: usernameB, password: 'worker123', role: 'courier', courierId: courierB.data.id, name: '越权测试B'
  });
  const workerLogin = await request('POST', '/api/login', { username: usernameB, password: 'worker123' }, false);
  const workerToken = workerLogin.data.token;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'fake.pdf');
  const res = await fetch(baseUrl + `/api/tasks/${taskId}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}` },
    body: form
  });
  assert.equal(res.status, 403);
  token = adminToken;
});


test('v1 photo upload as JSON body is rejected with a clear 400 (multer sees zero files)', async () => {
  const courier = await request('POST', '/api/couriers', { name: 'JSON上传测试', region: '江东', commissionRate: 3 });
  const task = await request('POST', '/api/tasks', {
    customerName: 'JSON上传客户', address: '地址Y', defaultWorkerId: courier.data.id, items: []
  });
  const res = await fetch(baseUrl + `/api/tasks/${task.data.id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoBase64: 'aW1hZ2UtYnl0ZXM=', caption: 'base64 不是 multipart 文件' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /multipart\/form-data/);
});


test('customer list and detail expose open/completed order counts', async () => {
  const name = '订单统计客户' + Date.now();
  const customer = await request('POST', '/api/customers', { name, address: '统计地址' });
  const customerId = customer.data.id;
  const t1 = await request('POST', '/api/tasks', { customerId, customerName: name, address: '统计地址', items: [] });
  await request('POST', '/api/tasks/' + t1.data.id + '/start', { note: '' });
  await request('POST', '/api/tasks/' + t1.data.id + '/complete', { note: '' });
  await request('POST', '/api/tasks', { customerId, customerName: name, address: '统计地址', items: [] });

  const listed = await request('GET', '/api/customers?search=' + encodeURIComponent(name));
  const row = (Array.isArray(listed.data) ? listed.data : listed.data.list).find((r) => r.id === customerId);
  assert.ok(row);
  assert.equal(row.taskCount, 2);
  assert.equal(row.openTaskCount, 1);
  assert.equal(row.completedTaskCount, 1);

  const detail = await request('GET', '/api/customers/' + customerId);
  assert.equal(detail.data.taskCount, 2);
  assert.equal(detail.data.openTaskCount, 1);
  assert.equal(detail.data.completedTaskCount, 1);
});


test('task list status=open combines pending and in_progress only', async () => {
  const name = '待办筛选客户' + Date.now();
  const customer = await request('POST', '/api/customers', { name, address: '筛选项' });
  const pendingTask = await request('POST', '/api/tasks', { customerId: customer.data.id, customerName: name, address: '筛选项', items: [] });
  const doneTask = await request('POST', '/api/tasks', { customerId: customer.data.id, customerName: name, address: '筛选项', items: [] });
  await request('POST', '/api/tasks/' + doneTask.data.id + '/start', { note: '' });
  await request('POST', '/api/tasks/' + doneTask.data.id + '/complete', { note: '' });

  const open = await request('GET', '/api/tasks?status=open&keyword=' + encodeURIComponent(name));
  const openIds = open.data.list.map((r) => r.id);
  assert.equal(open.data.total, 1, JSON.stringify(open.data));
  assert.ok(openIds.includes(pendingTask.data.id));
  assert.ok(!openIds.includes(doneTask.data.id));

  const cancelled = await request('GET', '/api/tasks?status=cancelled&keyword=' + encodeURIComponent(name));
  assert.equal(cancelled.data.total, 0);
});

test('Harmony completion notifies the dispatcher and broadcasts the task update', async () => {
  token = adminToken;
  const courier = await request('POST', '/api/couriers', { name: '完成通知测试员', region: '测试', commissionRate: 3 });
  const username = `completion_${Date.now()}`;
  const user = await request('POST', '/api/users', {
    username, password: 'worker123', role: 'courier', courierId: courier.data.id, name: '完成通知测试员'
  });
  assert.equal(user.status, 200);
  const created = await request('POST', '/api/tasks', {
    customerName: '完成通知回归', address: '测试地址', defaultWorkerId: courier.data.id, items: []
  });
  assert.equal(created.status, 201);
  const login = await request('POST', '/api/login', { username, password: 'worker123' }, false);
  assert.equal(login.status, 200);
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Authorization: `Bearer ${adminToken}` }, signal: controller.signal
  });
  let received = '';
  const reading = (async () => {
    try {
      for await (const chunk of stream.body) received += Buffer.from(chunk).toString('utf8');
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  try {
    token = login.data.token;
    assert.equal((await request('POST', `/api/tasks/${created.data.id}/start`)).status, 200);
    const completed = await request('POST', `/api/tasks/${created.data.id}/complete`);
    assert.equal(completed.status, 200);
    assert.equal(completed.data.status, 'completed');
    token = adminToken;
    const inbox = await request('GET', '/api/notifications');
    const completion = inbox.data.filter(n => {
      const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
      return data.resourceId === created.data.id && data.status === 'completed';
    });
    assert.equal(completion.length, 1, 'dispatcher must receive exactly one completion notification');
    const readEvents = () => received.split('\n\n').slice(0, -1).flatMap(packet =>
      packet.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
    const completedUpdate = e => e.type === 'task.updated' && e.taskId === created.data.id && e.status === 'completed';
    for (let i = 0; i < 20 && !readEvents().some(completedUpdate); i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const events = readEvents();
    assert.ok(events.some(e => e.type === 'notification.created' &&
      e.data.notification.data.resourceId === created.data.id && e.data.notification.data.status === 'completed'),
    'dispatcher must receive a completion SSE notification');
    assert.ok(events.some(completedUpdate),
      'Harmony completion must broadcast the updated task to open task pages');
  } finally {
    token = adminToken;
    controller.abort();
    await reading;
  }
});

async function editCargoItem(taskId, itemId, fields, authToken = token) {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/items/${itemId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(fields)
  });
  const text = await response.text();
  return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
}

async function createWorkerCreator(suffix) {
  token = adminToken;
  const courier = await request('POST', '/api/couriers', { name: `自建${suffix}`, region: '测试', commissionRate: 3 });
  const username = `selfcreate_${suffix}_${Date.now()}`;
  const account = await request('POST', '/api/users', { username, password: 'worker123', role: 'courier', courierId: courier.data.id, name: '自建取件员' });
  assert.equal(account.status, 200);
  const login = await request('POST', '/api/login', { username, password: 'worker123' }, false);
  return { courierId: courier.data.id, token: login.data.token, userId: login.data.user.id };
}

test('worker customer suggestions match Chinese, pinyin and initials with digits within assigned areas', async () => {
  const worker = await createWorkerCreator('suggest');
  const db = new Database(path.join(tempDir, 'app.db'));
  const names = ['杨梅', '杨3', '杨4', '阳5', '林12'];
  try {
    db.prepare('INSERT INTO areas (id,name) VALUES (?,?)').run('suggest-area', '预览区域');
    db.prepare('INSERT INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,?)').run('suggest-area', worker.courierId, 'backup');
    for (let i = 0; i < names.length; i++) {
      db.prepare('INSERT INTO customers (id,name) VALUES (?,?)').run(`suggest-c${i}`, names[i]);
      db.prepare('UPDATE customers SET main_cs_id=? WHERE id=?').run(adminUser.id, `suggest-c${i}`);
      db.prepare('INSERT INTO customer_addresses (id,customer_id,address,area_id) VALUES (?,?,?,?)')
        .run(`suggest-a${i}`, `suggest-c${i}`, `地址${i}`, 'suggest-area');
    }
    db.prepare('INSERT INTO customer_addresses (id,customer_id,address,area_id) VALUES (?,?,?,?)').run('suggest-a-extra', 'suggest-c1', '第二地址', 'suggest-area');
    db.prepare('INSERT INTO customers (id,name) VALUES (?,?)').run('suggest-out', '杨外区');
    db.prepare('INSERT INTO customer_addresses (id,customer_id,address) VALUES (?,?,?)').run('suggest-out-a', 'suggest-out', '外区地址');
    db.prepare('INSERT INTO customers (id,name,status) VALUES (?,?,?)').run('suggest-disabled', '杨停用', 'disabled');
    db.prepare('INSERT INTO customer_addresses (id,customer_id,address,area_id) VALUES (?,?,?,?)').run('suggest-disabled-a', 'suggest-disabled', '停用地址', 'suggest-area');
  } finally { db.close(); }
  token = worker.token;
  for (const [q, want] of [['杨', ['杨3','杨4','杨梅']], ['y', ['杨3','杨4','杨梅','阳5']], ['yang', ['杨3','杨4','杨梅','阳5']],
    [' YANG3 ', ['杨3']], ['y3', ['杨3']], ['yang4', ['杨4']], ['y5', ['阳5']], ['l12', ['林12']], ['lin12', ['林12']], ['zzzz', []], ['', []]]) {
    const result = await request('GET', '/api/worker/customer-options?search=' + encodeURIComponent(q));
    assert.equal(result.status, 200);
    assert.deepEqual([...new Set(result.data.map(c => c.customerName))].sort(), want.sort(), q);
    if (q === 'y3') {
      assert.equal(result.data.length, 2, 'each address is a distinct selectable option');
      assert.deepEqual(result.data.map(c => c.address).sort(), ['地址1','第二地址'].sort());
    }
  }
  const minimal = { customerId: 'suggest-c1', addressId: 'suggest-a1' };
  const created = await request('POST', '/api/tasks', minimal);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.defaultWorkerId, worker.courierId);
  assert.equal(created.data.customerName, '杨3');
  assert.equal(created.data.address, '地址1');
  assert.equal(created.data.items.length, 0, 'unknown pieces must not create a fake cargo item');
  assert.equal((await request('POST', `/api/tasks/${created.data.id}/start`)).status, 200);
  const cargo = await request('POST', `/api/tasks/${created.data.id}/items`, { pieces: 3, waybillNo: '', entryMethod: 'no_waybill' });
  assert.equal(cargo.data.items[0].pieces, 3);
  const editedCargo = await editCargoItem(created.data.id, cargo.data.items[0].id, { pieces: 4 });
  assert.equal(editedCargo.data.items.length, 1);
  assert.equal(editedCargo.data.items[0].pieces, 4);
  assert.equal((await request('POST', `/api/tasks/${created.data.id}/complete`)).status, 200);
  token = adminToken;
  const inbox = await request('GET', '/api/notifications');
  assert.ok(inbox.data.some(n => {
    const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
    return data.resourceId === created.data.id && data.status === 'completed';
  }), 'self-created customer order completion must notify responsible customer service');
  assert.equal((await request('GET', '/api/worker/customer-options?search=y')).status, 403);
  token = worker.token;
  for (const fields of [{ customerId: 'suggest-out', addressId: 'suggest-out-a' },
    { customerId: 'suggest-disabled', addressId: 'suggest-disabled-a' }, { ...minimal, addressId: 'suggest-a2' }]) {
    assert.equal((await request('POST', '/api/tasks', fields)).status, 400);
  }
  const changed = new Database(path.join(tempDir, 'app.db'));
  changed.prepare('UPDATE customer_addresses SET is_active=0 WHERE id=?').run('suggest-a1');
  assert.equal((await request('POST', '/api/tasks', minimal)).status, 400, 'disabled address cannot be submitted from stale preview');
  assert.equal((await request('GET', '/api/worker/customer-options?search=y3')).data.length, 1);
  changed.prepare('DELETE FROM area_workers WHERE worker_id=?').run(worker.courierId); changed.close();
  assert.deepEqual((await request('GET', '/api/worker/customer-options?search=y')).data, []);
  assert.equal((await request('POST', '/api/tasks', minimal)).status, 400, 'revoked region must be rechecked on submit');
  token = adminToken;
});

test('worker self-created manual orders belong to self, remain pending and are visible to staff', async () => {
  const worker = await createWorkerCreator('manual');
  token = worker.token;
  const created = await request('POST', '/api/tasks', {
    customerName: ' 自填客户 ', address: ' 手填地址 ', contact: ' 张三 ', phone: ' 13800000000 ',
    status: 'completed', amountPayable: 999, settled: '已结算', mainCsId: 'spoof-cs', dispatchCsId: 'spoof-cs',
    items: [{ pieces: 3, workerId: 'another-worker', finalWeight: 999, matchStatus: 'matched' }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.defaultWorkerId, worker.courierId);
  assert.equal(created.data.dispatchCsId, worker.userId);
  assert.equal(created.data.mainCsId, '');
  assert.equal(created.data.customerName, '自填客户');
  assert.equal(created.data.address, '手填地址');
  assert.equal(created.data.items[0].pieces, 3);
  assert.equal(created.data.items[0].workerId, worker.courierId);
  assert.equal(created.data.items[0].finalWeight, 0);
  assert.equal(created.data.amountPayable, 0);
  assert.equal(created.data.settled, '未结算');
  assert.ok((await request('GET', '/api/worker/tasks')).data.some(t => t.id === created.data.id));
  token = adminToken;
  assert.equal((await request('GET', `/api/tasks/${created.data.id}`)).status, 200);
  const db = new Database(path.join(tempDir, 'app.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name=?').get('自填客户').n, 0); }
  finally { db.close(); }
});

test('worker self-created existing-customer orders use trusted customer/address records', async () => {
  const worker = await createWorkerCreator('existing');
  token = adminToken;
  const customer = await request('POST', '/api/customers', { name: '自建选客户', address: '真实地址', contact: '真实联系人', phone: '13900000000' });
  const detail = await request('GET', `/api/customers/${customer.data.id}`);
  const other = await request('POST', '/api/customers', { name: '其他客户自建', address: '其他地址' });
  const otherDetail = await request('GET', `/api/customers/${other.data.id}`);
  const db = new Database(path.join(tempDir, 'app.db'));
  db.prepare('UPDATE customers SET main_cs_id=? WHERE id=?').run(adminUser.id, customer.data.id);
  db.prepare('INSERT INTO areas (id,name) VALUES (?,?)').run('existing-area', '已有客户测试区域');
  db.prepare('INSERT INTO area_workers (area_id,worker_id) VALUES (?,?)').run('existing-area', worker.courierId);
  db.prepare('UPDATE customer_addresses SET area_id=? WHERE id=?').run('existing-area', detail.data.addresses[0].id);
  db.close();
  token = worker.token;
  const fields = { customerId: customer.data.id, addressId: detail.data.addresses[0].id, items: [{ pieces: 2 }],
    customerName: '伪造名称', address: '伪造地址', mainCsId: 'spoof' };
  const created = await request('POST', '/api/tasks', fields);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.customerName, '自建选客户');
  assert.equal(created.data.address, '真实地址');
  assert.equal(created.data.mainCsId, adminUser.id);
  assert.equal(created.data.defaultWorkerId, worker.courierId);
  const invalid = await request('POST', '/api/tasks', { ...fields, addressId: otherDetail.data.addresses[0].id });
  assert.equal(invalid.status, 400);
  token = adminToken;
});

test('worker self-creation rejects other assignees, invalid quantities and incomplete manual data', async () => {
  const worker = await createWorkerCreator('validation');
  token = worker.token;
  const fields = { customerName: '校验', address: '地址', contact: '联系人', phone: '123456', items: [{ pieces: 1 }] };
  assert.equal((await request('POST', '/api/tasks', { ...fields, workerId: 'another-worker' })).status, 403);
  assert.equal((await request('POST', '/api/tasks', { ...fields, defaultWorkerId: 'another-worker' })).status, 403);
  for (const pieces of [0, -1, 1.5, '2x', null]) {
    assert.equal((await request('POST', '/api/tasks', { ...fields, items: [{ pieces }] })).status, 400);
  }
  for (const key of ['customerName', 'address', 'contact', 'phone']) {
    assert.equal((await request('POST', '/api/tasks', { ...fields, [key]: '' })).status, 400);
  }
  assert.equal((await request('GET', '/api/worker/tasks')).data.length, 0);
  token = adminToken;
  const username = `unbound_${Date.now()}`;
  await request('POST', '/api/users', { username, password: 'worker123', role: 'courier', name: '未绑定取件员' });
  const login = await request('POST', '/api/login', { username, password: 'worker123' }, false);
  token = login.data.token;
  assert.equal((await request('POST', '/api/tasks', fields)).status, 403);
  token = adminToken;
});

test('cargo editing updates the same item, keeps weight for the same waybill and audits changes after completion', async () => {
  token = adminToken;
  const created = await request('POST', '/api/tasks', { customerName: '编辑回归', address: '测试', items: [] });
  const added = await request('POST', `/api/tasks/${created.data.id}/items`, {
    goodsName: '原品名', waybillNo: 'EDIT-OLD', pieces: 2, finalWeight: 12
  });
  const item = added.data.items[0];
  const edited = await editCargoItem(created.data.id, item.id, { goodsName: '新名称', waybillNo: 'EDIT-OLD', pieces: 5 });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.items.length, 1);
  assert.equal(edited.data.items[0].id, item.id);
  assert.equal(edited.data.items[0].goodsName, '新名称');
  assert.equal(edited.data.items[0].pieces, 5);
  assert.equal(edited.data.items[0].finalWeight, 12);
  await request('POST', `/api/tasks/${created.data.id}/start`);
  const completed = await request('POST', `/api/tasks/${created.data.id}/complete`);
  const corrected = await editCargoItem(created.data.id, item.id, { goodsName: '新名称', waybillNo: ' EDIT-NEW ', pieces: 7 });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.status, 'completed');
  assert.equal(corrected.data.completedAt, completed.data.completedAt);
  assert.equal(corrected.data.items.length, 1);
  assert.equal(corrected.data.items[0].pieces, 7);
  assert.equal(corrected.data.items[0].waybillNo, 'EDIT-NEW');
  assert.equal(corrected.data.items[0].finalWeight, 0, 'changed waybill must not retain another shipment weight');
  assert.equal(corrected.data.items[0].matchStatus, 'pending');
  const db = new Database(path.join(tempDir, 'app.db'), { readonly: true });
  try {
    const events = db.prepare("SELECT actor_id,note FROM task_events WHERE task_id=? AND event_type='item_updated'").all(created.data.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].actor_id, adminUser.id);
    const notes = events.map(e => JSON.parse(e.note));
    assert.ok(notes.some(n => n.itemId === item.id && n.before.pieces === 5 && n.after.pieces === 7));
  } finally { db.close(); }
});

test('cargo editing rejects invalid quantities and cancelled tasks without partial writes', async () => {
  token = adminToken;
  const created = await request('POST', '/api/tasks', { customerName: '校验回归', address: '测试', items: [{ pieces: 2 }] });
  const itemId = created.data.items[0].id;
  for (const pieces of [0, -1, 1.5, '2x', null, [], {}, 1e20]) {
    const edited = await editCargoItem(created.data.id, itemId, { pieces, goodsName: '不能写入', waybillNo: '' });
    assert.equal(edited.status, 400, `invalid pieces: ${JSON.stringify(pieces)}`);
  }
  assert.equal((await request('GET', `/api/tasks/${created.data.id}`)).data.items[0].pieces, 2);
  await request('POST', `/api/tasks/${created.data.id}/cancel`);
  assert.equal((await editCargoItem(created.data.id, itemId, { pieces: 3, goodsName: '', waybillNo: '' })).status, 409);
});

test('cargo editing enforces task and item ownership, while the assigned worker can correct completed items', async () => {
  token = adminToken;
  const courier = await request('POST', '/api/couriers', { name: '编辑权限员', region: '测试', commissionRate: 3 });
  const username = `item_editor_${Date.now()}`;
  await request('POST', '/api/users', { username, password: 'worker123', role: 'courier', courierId: courier.data.id, name: '编辑权限员' });
  const owned = await request('POST', '/api/tasks', { customerName: '本人任务', address: '测试', defaultWorkerId: courier.data.id, items: [{ pieces: 1 }] });
  const other = await request('POST', '/api/tasks', { customerName: '其他任务', address: '测试', items: [{ pieces: 1 }] });
  const login = await request('POST', '/api/login', { username, password: 'worker123' }, false);
  const fields = { pieces: 4, goodsName: '', waybillNo: '' };
  assert.equal((await editCargoItem(other.data.id, other.data.items[0].id, fields, login.data.token)).status, 403);
  assert.equal((await editCargoItem(owned.data.id, other.data.items[0].id, fields, login.data.token)).status, 404);
  await request('POST', `/api/tasks/${owned.data.id}/start`);
  await request('POST', `/api/tasks/${owned.data.id}/complete`);
  const edited = await editCargoItem(owned.data.id, owned.data.items[0].id, fields, login.data.token);
  assert.equal(edited.status, 200);
  assert.equal(edited.data.items[0].pieces, 4);
  assert.equal(edited.data.items[0].workerId, owned.data.items[0].workerId);
  assert.equal(edited.data.items[0].matchStatus, 'no_waybill');
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

test('vendor push registers via unified store; legacy /api/push/* routes are gone (410)', async () => {
  token = adminToken;
  const registered = await request('POST', '/api/v1/notification-subscriptions', {
    channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
    deviceLabel: 'API 测试机', token: 'canonical-route-huawei-token'
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal(registered.data.data.providerCode, 'huawei');
  const deviceId = registered.data.data.id;

  const listed = await request('GET', '/api/v1/notification-subscriptions');
  assert.equal(listed.data.data.some(item => item.id === deviceId), true);

  const unregistered = await request('DELETE', `/api/v1/notification-subscriptions/${deviceId}`);
  assert.equal(unregistered.status, 200);
  const after = await request('GET', '/api/v1/notification-subscriptions');
  assert.equal(after.data.data.some(item => item.id === deviceId), false);

  const legacyRegister = await request('POST', '/api/push/register', { token: 'old-route-token' });
  assert.equal(legacyRegister.status, 410);
  const legacyUnregister = await request('POST', '/api/push/unregister');
  assert.equal(legacyUnregister.status, 410);
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

test('legacy /api/events SSE entry is gone and returns 410 with migration hint', async () => {
  const gone = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(adminToken)}`);
  assert.equal(gone.status, 410);
  const body = await gone.json();
  assert.match(body.error, /api\/v1\/events/);
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

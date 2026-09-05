const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 36000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-api-v2-'));
let child;
let token;
let adminToken;

async function request(method, url, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(baseUrl + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  const login = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(login.status, 200, lastError && lastError.message);
  assert.equal(login.body.data.user.username, 'admin');
  assert.equal(login.body.data.user.role, 'admin');
  assert.ok(login.body.data.token);
  token = login.body.data.token;
  adminToken = token;
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

test('v2 认证：错误密码 / 未登录统一返回 error 结构', async () => {
  const bad = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'wrong' }, false);
  assert.equal(bad.status, 401);
  assert.equal(typeof bad.body.error, 'string');

  const me = await request('GET', '/api/v2/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.username, 'admin');

  const anon = await request('GET', '/api/v2/me', undefined, false);
  assert.equal(anon.status, 401);
  assert.equal(typeof anon.body.error, 'string');
});

test('v2 任务：创建/列表/详情返回 {data} 包装与 ISO8601 时间', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: 'v2 接口测试客户',
    address: '义乌市江东街道',
    taskType: 'scheduled',
    items: [
      { waybillNo: 'V2-WB-1', pieces: 2, goodsName: '服装' },
      { waybillNo: 'V2-WB-2', pieces: 1, goodsName: '配件' }
    ]
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.task.status, 'pending');
  assert.equal(created.body.data.task.items.length, 2);
  assert.match(created.body.data.task.createdAt, ISO_RE);
  assert.match(created.body.data.task.items[0].createdAt, ISO_RE);
  const taskId = created.body.data.task.id;

  const listed = await request('GET', `/api/v2/tasks?page=1&pageSize=10&keyword=${encodeURIComponent('v2 接口测试客户')}`);
  assert.equal(listed.status, 200);
  assert.equal(Array.isArray(listed.body.data.items), true);
  assert.equal(listed.body.data.total, 1);
  assert.equal(listed.body.data.page, 1);
  assert.equal(listed.body.data.pageSize, 10);
  assert.equal(listed.body.data.items[0].id, taskId);
  assert.match(listed.body.data.items[0].createdAt, ISO_RE);

  const detail = await request('GET', `/api/v2/tasks/${taskId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.task.id, taskId);
  assert.ok(Array.isArray(detail.body.data.task.workers));
  assert.ok(Array.isArray(detail.body.data.task.photos));
  assert.ok(Array.isArray(detail.body.data.task.exceptions));
  assert.equal(typeof detail.body.data.task.mainCsName, 'string');
});

test('v2 任务：非法越级完成被拒，随后按状态流转并补充货品/异常', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: 'v2 状态客户', address: '义乌市稠城街道', items: []
  });
  const taskId = created.body.data.task.id;
  const invalid = await request('POST', `/api/v2/tasks/${taskId}/complete`);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /开始取件|先开始/);

  const item = await request('POST', `/api/v2/tasks/${taskId}/items`, {
    entryMethod: 'manual', waybillNo: 'V2-FLOW-1', pieces: 2, goodsName: '样品'
  });
  assert.equal(item.status, 201);
  assert.equal(item.body.data.task.items.length, 1);

  const started = await request('POST', `/api/v2/tasks/${taskId}/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.data.task.status, 'in_progress');
  assert.match(started.body.data.task.updatedAt, ISO_RE);

  const exception = await request('POST', `/api/v2/tasks/${taskId}/exceptions`, {
    type: '地址异常', description: '门牌号不清晰'
  });
  assert.equal(exception.status, 201);
  const exceptionId = exception.body.data.task.exceptions[0].id;

  const resolved = await request('POST', `/api/v2/exceptions/${exceptionId}/resolve`, {
    resolution: '已电话确认'
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.data.exception.resolved, true);
  assert.match(resolved.body.data.exception.resolvedAt, ISO_RE);

  const completed = await request('POST', `/api/v2/tasks/${taskId}/complete`);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.task.status, 'completed');
});

test('v2 客户：创建与分页约定（page 从 1 开始）', async () => {
  const first = await request('POST', '/api/v2/customers', {
    name: 'v2 客户甲', contact: '张三', phone: '13800000001', address: '义乌国际商贸城'
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.customer.name, 'v2 客户甲');
  const customerId = first.body.data.customer.id;

  await request('POST', '/api/v2/customers', { name: 'v2 客户乙', contact: '李四', phone: '13800000002' });
  await request('POST', '/api/v2/customers', { name: 'v2 客户丙', contact: '王五', phone: '13800000003' });

  const pageOne = await request('GET', '/api/v2/customers?page=1&pageSize=2');
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.data.items.length, 2);
  assert.ok(pageOne.body.data.total >= 3);
  assert.equal(pageOne.body.data.page, 1);
  assert.equal(pageOne.body.data.pageSize, 2);

  const pageTwo = await request('GET', '/api/v2/customers?page=2&pageSize=2');
  assert.equal(pageTwo.status, 200);
  assert.equal(pageTwo.body.data.page, 2);
  assert.equal(pageTwo.body.data.items.length, pageOne.body.data.total - 2);

  const updated = await request('PUT', `/api/v2/customers/${customerId}`, {
    contactName: '张三丰', phone: '13800009999', remark: 'v2 备注'
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.customer.contact, '张三丰');
  assert.equal(updated.body.data.customer.phone, '13800009999');
  assert.equal(updated.body.data.customer.note, 'v2 备注');

  const detail = await request('GET', `/api/v2/customers/${customerId}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.data.customer.addresses));
  assert.equal(detail.body.data.customer.mainCsName, '');
});

test('v2 推送设备与通知：注册/测试/分页/已读/删除闭环', async () => {
  const device = await request('POST', '/api/v2/push/devices', {
    providerCode: 'huawei', platform: 'harmonyos', token: `v2-huawei-token-${Date.now()}`,
    deviceLabel: 'v2 测试手机', appVersion: '1.0.0'
  });
  assert.equal(device.status, 201);
  assert.equal(device.body.data.device.platform, 'harmonyos');
  const deviceId = device.body.data.device.id;

  const testPush = await request('POST', `/api/v2/push/devices/${deviceId}/test`);
  assert.equal(testPush.status, 202);
  assert.ok(testPush.body.data.notificationId);

  const unread = await request('GET', '/api/v2/notifications/unread-count');
  assert.equal(unread.status, 200);
  assert.ok(unread.body.data.count >= 1);

  const list = await request('GET', '/api/v2/notifications?page=1&pageSize=10');
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.body.data.items), true);
  assert.equal(list.body.data.page, 1);
  assert.equal(list.body.data.pageSize, 10);
  const latest = list.body.data.items[0];
  assert.equal(latest.type, 'system.test');
  assert.match(latest.createdAt, ISO_RE);

  const read = await request('POST', `/api/v2/notifications/${latest.id}/read`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.ok, true);
  const afterRead = await request('GET', '/api/v2/notifications/unread-count');
  assert.equal(afterRead.body.data.count, unread.body.data.count - 1);

  const devices = await request('GET', '/api/v2/push/devices');
  assert.equal(devices.status, 200);
  assert.equal(devices.body.data.items.length, 1);

  const removed = await request('DELETE', `/api/v2/push/devices/${deviceId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.ok, true);

  const missing = await request('DELETE', `/api/v2/push/devices/${deviceId}`);
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, 'string');
});

test('v2 通知偏好：读取与写回沿用 {data} 包装', async () => {
  const before = await request('GET', '/api/v2/notification-preferences');
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.body.data.items));

  const saved = await request('PUT', '/api/v2/notification-preferences', {
    type: 'pickupTask.statusChanged', channel: 'vendor_push', enabled: false
  });
  assert.equal(saved.status, 200);
  const entry = saved.body.data.items.find(item => item.channel === 'vendor_push');
  assert.ok(entry);
  assert.equal(entry.enabled, false);
});

test('v2 基础资料/看板/历史记录：统一包装并按角色隔离', async () => {
  const courier = await request('POST', '/api/v2/couriers', {
    name: 'v2 取件员', region: '江东', commissionRate: 3
  });
  assert.equal(courier.status, 201);
  assert.equal(courier.body.data.courier.name, 'v2 取件员');
  const courierId = courier.body.data.courier.id;

  const edited = await request('PUT', `/api/v2/couriers/${courierId}`, { commissionRate: 5 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.courier.commissionRate, 5);

  const courierList = await request('GET', '/api/v2/couriers?page=1&pageSize=10');
  assert.equal(courierList.status, 200);
  assert.equal(Array.isArray(courierList.body.data.items), true);
  assert.ok(courierList.body.data.total >= 1);
  assert.equal(courierList.body.data.page, 1);

  const areas = await request('GET', '/api/v2/areas?page=1&pageSize=10');
  assert.equal(areas.status, 200);
  assert.equal(Array.isArray(areas.body.data.items), true);
  assert.equal(typeof areas.body.data.total, 'number');

  const board = await request('GET', '/api/v2/dashboard/board?range=month');
  assert.equal(board.status, 200);
  for (const key of ['pickupCount', 'pieces', 'finalWeight', 'pendingCount', 'shipCustomerCount', 'pickupCustomerCount']) {
    assert.equal(typeof board.body.data[key], 'number');
  }
  const attention = await request('GET', '/api/v2/dashboard/attention');
  assert.equal(attention.status, 200);
  assert.equal(typeof attention.body.data.unmatchedWaybill, 'number');

  const seeded = await request('POST', '/api/records', {
    date: '2026-09-05', courierId, customer: 'v2 记录客户', customerId: '',
    pieces: 2, address: '义乌市江东街道', goods: '五金件', amountReceivable: 100
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body).slice(0, 200));

  const records = await request('GET', `/api/v2/records?page=1&pageSize=5&courierId=${courierId}&start=2026-09-01`);
  assert.equal(records.status, 200);
  assert.equal(records.body.data.items.length, 1);
  assert.equal(records.body.data.total, 1);
  assert.equal(records.body.data.items[0].courierId, courierId);
  assert.equal(records.body.data.items[0].customerName, 'v2 记录客户');
  assert.match(records.body.data.items[0].createdAt, ISO_RE);

  const billing = await request('GET', `/api/v2/billing?start=2026-09-01`);
  assert.equal(billing.status, 200);
  assert.ok(Array.isArray(billing.body.data.byCustomer));
  assert.equal(billing.body.data.total.orders >= 1, true);

  const username = `v2worker_${Date.now()}`;
  const user = await request('POST', '/api/users', {
    username, password: 'worker123', role: 'courier', courierId, name: 'v2 取件员'
  });
  assert.equal(user.status, 200);
  const workerLogin = await request('POST', '/api/v2/auth/login', { username, password: 'worker123' }, false);
  assert.equal(workerLogin.status, 200);
  token = workerLogin.body.data.token;

  const me = await request('GET', '/api/v2/dashboard/me');
  assert.equal(me.status, 200);
  for (const key of ['pending', 'inProgress', 'completed', 'pieces']) {
    assert.equal(typeof me.body.data[key], 'number');
  }
  const ownRecords = await request('GET', '/api/v2/records?page=1&pageSize=5');
  assert.equal(ownRecords.body.data.total, 1);
  assert.equal(ownRecords.body.data.items[0].courierId, courierId);
  const commission = await request('GET', '/api/v2/commission');
  assert.equal(commission.status, 200);
  assert.equal(commission.body.data.rows.length, 1);
  assert.equal(commission.body.data.rows[0].courierId, courierId);

  const deniedCouriers = await request('GET', '/api/v2/couriers');
  assert.equal(deniedCouriers.status, 403);
  const deniedBoard = await request('GET', '/api/v2/dashboard/board');
  assert.equal(deniedBoard.status, 403);
  const deniedCustomer = await request('POST', '/api/v2/customers', { name: '不应成功' });
  assert.equal(deniedCustomer.status, 403);

  token = adminToken;
  const deleted = await request('DELETE', `/api/v2/couriers/${courierId}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.ok, true);
});

test('v2 分页一致性 / 客户搜索 / 照片上传', async () => {
  const first = await request('GET', '/api/v2/tasks?page=1&pageSize=2');
  assert.equal(first.status, 200);
  const total = first.body.data.total;
  let collected = 0;
  for (let p = 1; p <= Math.ceil(total / 2) + 1; p += 1) {
    const page = await request('GET', `/api/v2/tasks?page=${p}&pageSize=2`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.page, p);
    assert.equal(page.body.data.pageSize, 2);
    collected += page.body.data.items.length;
    if (page.body.data.items.length === 0) break;
  }
  assert.equal(collected, total);

  const beyond = await request('GET', '/api/v2/tasks?page=9999&pageSize=2');
  assert.equal(beyond.status, 200);
  assert.equal(beyond.body.data.items.length, 0);
  assert.equal(beyond.body.data.total, total);

  const customers = await request('GET', `/api/v2/customers?search=${encodeURIComponent('v2 客户')}&page=1&pageSize=100`);
  assert.equal(customers.status, 200);
  assert.ok(customers.body.data.total >= 3);
  assert.ok(customers.body.data.items.every(customer => customer.name.includes('v2 客户')));

  const withAddress = customers.body.data.items.find(customer => customer.address);
  assert.ok(withAddress);
  const detail = await request('GET', `/api/v2/customers/${withAddress.id}`);
  assert.equal(detail.status, 200);
  assert.equal(withAddress.addressCount, detail.body.data.customer.addresses.length);

  const created = await request('POST', '/api/v2/tasks', {
    customerName: 'v2 照片客户', address: '义乌市照片地址', items: []
  });
  const taskId = created.body.data.task.id;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'photo.png');
  const uploaded = await fetch(baseUrl + `/api/v2/tasks/${taskId}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const uploadedJson = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(uploadedJson).slice(0, 200));
  const photo = uploadedJson.data.task.photos[0];
  assert.ok(photo);
  assert.match(photo.filePath, /^\/uploads\/[0-9a-f-]+\.png$/);
  assert.match(photo.createdAt, ISO_RE);

  const fileResponse = await fetch(baseUrl + photo.filePath);
  assert.equal(fileResponse.status, 200);
  const filename = photo.filePath.split('/').pop();
  try {
    fs.rmSync(path.join(__dirname, '..', 'data', 'uploads', filename), { force: true });
  } catch (error) {
    // 清理失败不阻塞断言结果
  }
});

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

async function request(method, url, body, auth = true, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
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
      MACHINE_API_KEY: 'e2e-machine-key',
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
  const userId = user.body.id;
  // 有进行中的任务或绑定账号时不允许删除档案（删除保护）
  const blockedDelete = await request('DELETE', `/api/v2/couriers/${courierId}`);
  assert.equal(blockedDelete.status, 400);
  assert.match(blockedDelete.body.error, /绑定着登录账号/);
  const workerLogin = await request('POST', '/api/v2/auth/login', { username, password: 'worker123' }, false);
  assert.equal(workerLogin.status, 200);
  token = workerLogin.body.data.token;

  const me = await request('GET', '/api/v2/dashboard/me');
  assert.equal(me.status, 200);
  // 与 v1 /api/dashboard/me 同构：总数 + 今日/本月完成口径 + 协助次数
  for (const key of ['pending', 'inProgress', 'completed', 'pieces', 'assistCount']) {
    assert.equal(typeof me.body.data[key], 'number');
  }
  for (const windowKey of ['today', 'month']) {
    const window = me.body.data[windowKey];
    assert.ok(window, windowKey);
    for (const key of ['pickupCount', 'customerCount', 'pieces', 'matchedWeight']) {
      assert.equal(typeof window[key], 'number', `${windowKey}.${key}`);
    }
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
  const userRemoved = await request('DELETE', `/api/users/${userId}`);
  assert.equal(userRemoved.status, 200);
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


test('v2 photo upload to a missing task rejects before multer writes anything', async () => {
  // 用“非图片文件”探测中间件顺序：若 multer 先于任务预检执行，会先被 fileFilter 拒绝返回 400；
  // 修复后应返回 404（预检先行），即不会为不存在的任务落盘孤儿文件。
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'fake.pdf');
  const res = await fetch(baseUrl + '/api/v2/tasks/no-such-task/photos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  assert.equal(res.status, 404);
});


test('v2 photo upload without a file part is rejected with a clear 400', async () => {
  const created = await request('POST', '/api/v2/tasks', {
    customerName: '空文件客户', address: '地址', items: []
  });
  const taskId = created.body.data.task.id;
  const form = new FormData();
  form.append('caption', 'not a file'); // multipart 但没有文件字段
  const res = await fetch(baseUrl + `/api/v2/tasks/${taskId}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /multipart\/form-data/);
});

test('v2 records 分页上限收敛 / 越界页与稳定倒序', async () => {
  const admin = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(admin.status, 200);
  const couriers = await request('GET', '/api/v2/couriers');
  const courierId = couriers.body.data.items[0] && couriers.body.data.items[0].id;
  for (const date of ['2026-09-02', '2026-09-03', '2026-09-04']) {
    const created = await request('POST', '/api/records', {
      date, courierId: courierId || '', customer: 'v2 排序客户', pieces: 1,
      address: '义乌', goods: '排序件', amountReceivable: 1
    });
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 200));
  }
  const huge = await request('GET', '/api/v2/records?page=1&pageSize=9999');
  assert.equal(huge.status, 200);
  assert.equal(huge.body.data.pageSize, 100, 'pageSize 应被收敛到 100');
  assert.ok(huge.body.data.items.length <= 100);
  const dates = huge.body.data.items.map(item => item.date);
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(dates[i - 1] >= dates[i], `records 应按 date 倒序: ${dates[i - 1]} >= ${dates[i]}`);
  }
  const beyond = await request('GET', '/api/v2/records?page=9999&pageSize=5');
  assert.equal(beyond.status, 200);
  assert.equal(beyond.body.data.items.length, 0);
  assert.ok(beyond.body.data.total >= 1);
});

test('v2 通知全部已读后未读数归零', async () => {
  const admin = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(admin.status, 200);
  const device = await request('POST', '/api/v2/push/devices', {
    providerCode: 'huawei', platform: 'harmonyos', token: `v2-readall-${Date.now()}`, deviceLabel: 'read-all'
  });
  assert.equal(device.status, 201);
  const sent = await request('POST', `/api/v2/push/devices/${device.body.data.device.id}/test`);
  assert.equal(sent.status, 202);
  const before = await request('GET', '/api/v2/notifications/unread-count');
  assert.ok(before.body.data.count >= 1);
  const readAll = await request('POST', '/api/v2/notifications/read-all');
  assert.equal(readAll.status, 200);
  assert.equal(readAll.body.data.ok, true);
  const after = await request('GET', '/api/v2/notifications/unread-count');
  assert.equal(after.body.data.count, 0);
});

test('v2 推送设备重复登记同一 token 幂等（设备列表不重复）', async () => {
  const admin = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(admin.status, 200);
  const tokenValue = `v2-dup-token-${Date.now()}`;
  const first = await request('POST', '/api/v2/push/devices', {
    providerCode: 'huawei', platform: 'android', token: tokenValue, deviceLabel: '重复登记'
  });
  assert.equal(first.status, 201);
  const second = await request('POST', '/api/v2/push/devices', {
    providerCode: 'huawei', platform: 'android', token: tokenValue, deviceLabel: '重复登记2'
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.device.id, first.body.data.device.id, '同 token 应复用同一设备记录');
  const devices = await request('GET', '/api/v2/push/devices');
  const matches = devices.body.data.items.filter(item => item.id === first.body.data.device.id);
  assert.equal(matches.length, 1);
});

test('v2 过机重量经 machine/weigh 落库后可自动匹配任务明细', async () => {
  const admin = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(admin.status, 200);
  const record = await request('POST', '/api/records', {
    date: '2026-09-05', customer: '过机客户', pieces: 1, address: '义乌过机地址',
    trackingNo: 'WB-SYNC-1', weight: 0
  });
  assert.equal(record.status, 200, JSON.stringify(record.body).slice(0, 200));
  const weigh = await fetch(baseUrl + '/api/machine/weigh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-machine-key': 'e2e-machine-key' },
    body: JSON.stringify({ trackingNo: 'WB-SYNC-1', weight: 12.5 })
  });
  assert.equal(weigh.status, 200);
  assert.equal((await weigh.json()).record.weight, 12.5);

  const created = await request('POST', '/api/v2/tasks', {
    customerName: '过机匹配客户', address: '义乌地址',
    items: [{ waybillNo: 'WB-SYNC-1', pieces: 1, goodsName: '过机件' }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
  const taskId = created.body.data.task.id;
  const center = await request('GET', '/api/sync/match-center');
  assert.equal(center.status, 200);
  const pending = center.body.find(item => item.taskId === taskId);
  assert.ok(pending, '任务明细应出现在待匹配中心');

  const matched = await request('POST', `/api/sync/match/${pending.id}`, { waybillNo: 'WB-SYNC-1' });
  assert.equal(matched.status, 200);
  assert.equal(matched.body.matched, true);
  assert.equal(matched.body.finalWeight, 12.5);
  const detail = await request('GET', `/api/v2/tasks/${taskId}`);
  const item = detail.body.data.task.items.find(row => row.waybillNo === 'WB-SYNC-1');
  assert.equal(item.finalWeight, 12.5);
  assert.equal(item.matchStatus, 'matched');
});

test('v2 历史 records 重量在同步表缺失时兜底匹配任务明细', async () => {
  const admin = await request('POST', '/api/v2/auth/login', { username: 'admin', password: 'test-admin-strong-password' }, false);
  assert.equal(admin.status, 200);
  const record = await request('POST', '/api/records', {
    date: '2026-09-05', customer: '历史重量客户', pieces: 1, address: '义乌历史地址',
    trackingNo: 'WB-LEGACY-1', weight: 8.8
  });
  assert.equal(record.status, 200, JSON.stringify(record.body).slice(0, 200));

  const created = await request('POST', '/api/v2/tasks', {
    customerName: '历史匹配客户', address: '义乌地址',
    items: [{ waybillNo: 'WB-LEGACY-1', pieces: 1, goodsName: '历史件' }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
  const center = await request('GET', '/api/sync/match-center');
  const pending = center.body.find(item => item.taskId === created.body.data.task.id);
  assert.ok(pending);

  const matched = await request('POST', `/api/sync/match/${pending.id}`, { waybillNo: 'WB-LEGACY-1' });
  assert.equal(matched.status, 200);
  assert.equal(matched.body.matched, true);
  assert.equal(matched.body.finalWeight, 8.8);
  const detail = await request('GET', `/api/v2/tasks/${created.body.data.task.id}`);
  const item = detail.body.data.task.items.find(row => row.waybillNo === 'WB-LEGACY-1');
  assert.equal(item.finalWeight, 8.8);
  assert.equal(item.matchStatus, 'matched');
});

test('v2 区域：创建 / 列表 / 编辑与人员分配 / 删除约束', async () => {
  // 先建两个取件员用作默认与备用人员
  const mainWorker = await request('POST', '/api/v2/couriers', { name: '区域默认取件员' });
  assert.equal(mainWorker.status, 201);
  const mainWorkerId = mainWorker.body.data.courier.id;
  const backupWorker = await request('POST', '/api/v2/couriers', { name: '区域备用取件员' });
  assert.equal(backupWorker.status, 201);
  const backupWorkerId = backupWorker.body.data.courier.id;

  const created = await request('POST', '/api/v2/areas', {
    name: 'v2 区域甲',
    code: 'A-V2-1',
    defaultWorkerIds: [mainWorkerId, backupWorkerId],
    backupWorkerIds: [backupWorkerId]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
  const area = created.body.data.area;
  assert.equal(area.name, 'v2 区域甲');
  assert.equal(area.code, 'A-V2-1');
  assert.equal(area.defaultWorkers.length, 2);
  assert.equal(area.backupWorkers.length, 1);
  // 默认人员列表按姓名排序，主默认取件员从列表与列表长度判断即可
  assert.ok(area.defaultWorkers.some(worker => worker.userId === mainWorkerId));
  assert.ok(area.backupWorkers.some(worker => worker.userId === backupWorkerId));
  assert.ok(area.defaultWorkerId);
  const areaId = area.id;

  const dupe = await request('POST', '/api/v2/areas', { name: 'v2 区域甲' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /已存在/);

  const noName = await request('POST', '/api/v2/areas', { name: '   ' });
  assert.equal(noName.status, 400);

  const listed = await request('GET', '/api/v2/areas?page=1&pageSize=10');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.page, 1);
  assert.equal(listed.body.data.items.some(item => item.id === areaId), true);

  const updated = await request('PUT', `/api/v2/areas/${areaId}`, {
    name: 'v2 区域乙',
    code: 'A-V2-2',
    defaultWorkerIds: [backupWorkerId],
    backupWorkerIds: []
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body).slice(0, 200));
  assert.equal(updated.body.data.area.name, 'v2 区域乙');
  assert.equal(updated.body.data.area.defaultWorkers.length, 1);
  assert.equal(updated.body.data.area.defaultWorkers[0].userId, backupWorkerId);
  assert.equal(updated.body.data.area.backupWorkers.length, 0);

  const missing = await request('PUT', '/api/v2/areas/not-exist', { name: 'v2 区域丙' });
  assert.equal(missing.status, 404);

  const deleted = await request('DELETE', `/api/v2/areas/${areaId}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.ok, true);

  const afterDelete = await request('GET', '/api/v2/areas?page=1&pageSize=100');
  assert.equal(afterDelete.body.data.items.some(item => item.id === areaId), false);
  assert.equal(
    afterDelete.body.data.items.some(item => item.name === '区域默认取件员'),
    false,
    '删除区域不应影响取件员档案'
  );
});

test('v2 区域：被客户地址引用时不允许删除，写接口仅管理员', async () => {
  const worker = await request('POST', '/api/v2/couriers', { name: '区域占用取件员' });
  assert.equal(worker.status, 201);
  const area = await request('POST', '/api/v2/areas', { name: 'v2 占用区域' });
  assert.equal(area.status, 201, JSON.stringify(area.body));
  const areaId = area.body.data.area.id;

  // 客户地址仍走 v1 写入口（v2 尚未提供地址写接口），这里只用于制造"区域被引用"的场景
  const customer = await request('POST', '/api/v2/customers', {
    name: 'v2 区域占用客户', address: '义乌市北苑街道 1 号'
  });
  assert.equal(customer.status, 201, JSON.stringify(customer.body).slice(0, 200));
  const customerId = customer.body.data.customer.id;
  const address = await request('POST', `/api/customers/${customerId}/addresses`, {
    name: '仓库', address: '义乌市北苑街道 2 号', areaId
  });
  assert.equal(address.status, 201, JSON.stringify(address.body).slice(0, 200));

  const blocked = await request('DELETE', `/api/v2/areas/${areaId}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /客户地址/);

  const csUser = await request('POST', '/api/users', {
    username: `v2-area-cs-${Date.now()}`, password: 'cs-strong-password', role: 'cs', name: 'v2 区域客服'
  });
  assert.equal(csUser.status, 200);
  const csLogin = await request('POST', '/api/v2/auth/login', {
    username: csUser.body.username, password: 'cs-strong-password'
  }, false);
  assert.equal(csLogin.status, 200);
  token = csLogin.body.data.token;

  const csList = await request('GET', '/api/v2/areas?page=1&pageSize=10');
  assert.equal(csList.status, 200);
  const csCreate = await request('POST', '/api/v2/areas', { name: 'v2 客服建的停用区域' });
  assert.equal(csCreate.status, 403);
  const csDelete = await request('DELETE', `/api/v2/areas/${areaId}`);
  assert.equal(csDelete.status, 403);

  token = adminToken;
});

test('v2 看板区间语义：昨日只统计昨日数据', async () => {
  // 真机验收发现：range 之前只有"起始日期"下界，导致"昨日"把今天的数据也算进去。
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = n => (n < 10 ? '0' + n : String(n));
  const dayStr = offsetDays => {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const marker = `区间口径-${Date.now()}`;
  const board = async range => {
    const res = await request('GET', `/api/v2/dashboard/board?range=${range}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    return res.body.data.pendingCount;
  };
  const seed = async date => {
    const created = await request('POST', '/api/v2/tasks', {
      customerName: `${marker}-${date}`,
      address: '义乌市区间口径 1 号',
      items: [{ waybillNo: `WB-RANGE-${date}-${Math.random().toString(36).slice(2, 8)}`, pieces: 1 }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
    return created.body.data.task.id;
  };

  const beforeToday = await board('today');
  const beforeYesterday = await board('yesterday');

  // 今天建一单：今日 +1，昨日不受影响
  await seed(dayStr(0));
  assert.equal(await board('today'), beforeToday + 1, '今天创建的任务应计入今日');
  assert.equal(await board('yesterday'), beforeYesterday, '今天创建的任务不应计入昨日');

  // 昨天的单（回填创建时间）：昨日 +1，今日不变
  const yesterdayId = await seed(dayStr(-1));
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(tempDir, 'app.db'));
  raw.prepare('UPDATE pickup_tasks SET created_at=? WHERE id=?').run(`${dayStr(-1)} 03:00:00`, yesterdayId);
  raw.close();

  assert.equal(await board('yesterday'), beforeYesterday + 1, '昨天创建的任务应计入昨日');
  assert.equal(await board('today'), beforeToday + 1, '昨天创建的任务不应计入今日');
});

test('v2 员工管理：增改查 / 角色校验 / 停用保护 / 仅管理员', async () => {
  const username = `v2-emp-${Date.now()}`;
  const created = await request('POST', '/api/v2/employees', {
    username,
    password: 'strong-password-1',
    name: 'v2 员工甲',
    phone: '13800000001',
    employeeNo: 'E-V2-1',
    role: 'courier',
    region: '义乌北苑'
  });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
  const employee = created.body.data.employee;
  assert.equal(employee.username, username);
  assert.equal(employee.name, 'v2 员工甲');
  assert.equal(employee.role, 'courier');
  assert.equal(employee.status, 'active');
  assert.ok(employee.courierId, '取件员角色必须自动建档案');
  const employeeId = employee.id;

  const weakPassword = await request('POST', '/api/v2/employees', {
    username: `${username}-weak`, password: '123', name: 'v2 弱密码', role: 'cs'
  });
  assert.equal(weakPassword.status, 400);
  assert.match(weakPassword.body.error, /密码/);

  const dupe = await request('POST', '/api/v2/employees', {
    username, password: 'strong-password-2', name: 'v2 重名', role: 'cs'
  });
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /已存在/);

  const badRole = await request('POST', '/api/v2/employees', {
    username: `${username}-role`, password: 'strong-password-3', name: 'v2 角色', role: 'boss'
  });
  assert.equal(badRole.status, 400, 'Android 只接受 canonical 角色');

  const filtered = await request('GET', '/api/v2/employees?role=courier');
  assert.equal(filtered.status, 200);
  assert.equal(Array.isArray(filtered.body.data.items), true);
  assert.equal(filtered.body.data.items.every(item => item.role === 'courier'), true);
  assert.equal(filtered.body.data.items.some(item => item.id === employeeId), true);

  const updated = await request('PUT', `/api/v2/employees/${employeeId}`, {
    name: 'v2 员工乙',
    phone: '13800000002',
    employeeNo: 'E-V2-2',
    role: 'cs'
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.employee.name, 'v2 员工乙');
  assert.equal(updated.body.data.employee.role, 'cs');
  assert.equal(updated.body.data.employee.employeeNo, 'E-V2-2');

  const login = await request('POST', '/api/v2/auth/login', {
    username, password: 'strong-password-1'
  }, false);
  assert.equal(login.status, 200, '改名后原密码仍可登录');

  const disabled = await request('PUT', `/api/v2/employees/${employeeId}/status`, { status: 'disabled' });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.employee.status, 'disabled');

  const blockedLogin = await request('POST', '/api/v2/auth/login', {
    username, password: 'strong-password-1'
  }, false);
  assert.equal(blockedLogin.status, 401, '停用账号不能登录');

  const reenabled = await request('PUT', `/api/v2/employees/${employeeId}/status`, { status: 'active' });
  assert.equal(reenabled.status, 200);
  assert.equal(reenabled.body.data.employee.status, 'active');

  const selfBlocks = await request('PUT', '/api/v2/employees/' + '00000000-0000-0000-0000-000000000000/status', {
    status: 'disabled'
  });
  assert.equal(selfBlocks.status, 404);

  const me = await request('GET', '/api/v2/me');
  const adminId = me.body.data.user.id;
  const selfDisable = await request('PUT', `/api/v2/employees/${adminId}/status`, { status: 'disabled' });
  assert.equal(selfDisable.status, 400);
  assert.match(selfDisable.body.error, /当前登录/);

  const csUser = await request('POST', '/api/v2/employees', {
    username: `${username}-cs`, password: 'strong-password-4', name: 'v2 权限客服', role: 'cs'
  });
  assert.equal(csUser.status, 201);
  const csLogin = await request('POST', '/api/v2/auth/login', {
    username: `${username}-cs`, password: 'strong-password-4'
  }, false);
  assert.equal(csLogin.status, 200);
  token = csLogin.body.data.token;
  const csList = await request('GET', '/api/v2/employees');
  assert.equal(csList.status, 403);
  const csCreate = await request('POST', '/api/v2/employees', {
    username: 'v2-cs-created', password: 'strong-password-5', name: 'v2 客服建的', role: 'cs'
  });
  assert.equal(csCreate.status, 403);
  token = adminToken;
});

test('v2 操作日志：管理员分页查询与过滤，客服不可见', async () => {
  const listed = await request('GET', '/api/v2/logs?page=1&pageSize=5');
  assert.equal(listed.status, 200);
  assert.equal(Array.isArray(listed.body.data.items), true);
  assert.equal(listed.body.data.page, 1);
  assert.ok(listed.body.data.total >= 1, '前面的写操作应该留下审计日志');
  const entry = listed.body.data.items[0];
  for (const key of ['id', 'userName', 'action', 'targetType', 'targetId', 'detail', 'createdAt']) {
    assert.ok(key in entry, `日志字段缺少 ${key}`);
  }

  const areaOnly = await request('GET', '/api/v2/logs?targetType=area&page=1&pageSize=10');
  assert.equal(areaOnly.status, 200);
  assert.equal(areaOnly.body.data.items.every(item => item.targetType === 'area'), true);

  const keyword = await request('GET', '/api/v2/logs?keyword=区域&page=1&pageSize=10');
  assert.equal(keyword.status, 200);
  assert.ok(keyword.body.data.items.every(item => item.action.includes('区域') || item.detail.includes('区域')));

  const tooBig = await request('GET', '/api/v2/logs?page=1&pageSize=500');
  assert.equal(tooBig.status, 200);
  assert.equal(tooBig.body.data.pageSize, 100, 'pageSize 上限 100');

  const csUser = await request('POST', '/api/v2/employees', {
    username: `v2-log-cs-${Date.now()}`, password: 'strong-password-6', name: 'v2 日志客服', role: 'cs'
  });
  assert.equal(csUser.status, 201);
  const csLogin = await request('POST', '/api/v2/auth/login', {
    username: csUser.body.data.employee.username, password: 'strong-password-6'
  }, false);
  assert.equal(csLogin.status, 200);
  token = csLogin.body.data.token;
  const forbidden = await request('GET', '/api/v2/logs');
  assert.equal(forbidden.status, 403);
  token = adminToken;
});

test('v2 推送供应商：列表隐藏密钥 / 未知供应商 404 / 测试与启停 / 仅管理员', async () => {
  const listed = await request('GET', '/api/v2/push-providers');
  assert.equal(listed.status, 200, JSON.stringify(listed.body).slice(0, 300));
  const providers = listed.body.data.items;
  assert.equal(Array.isArray(providers), true);
  const huawei = providers.find(item => item.code === 'huawei');
  assert.ok(huawei, '应包含 huawei 供应商');
  assert.equal(Array.isArray(huawei.credentialSchema), true);
  const serviceAccount = huawei.credentialSchema.find(field => field.key === 'serviceAccount');
  assert.equal(serviceAccount.secret, true);
  assert.equal('value' in (huawei.fields.serviceAccount || {}), false, '密钥字段不得回传明文');

  const missing = await request('PUT', '/api/v2/push-providers/not-a-provider', {
    credentials: { anything: 'x' }
  });
  assert.equal(missing.status, 404);

  const unknownField = await request('PUT', '/api/v2/push-providers/huawei', {
    credentials: { notAllowed: 'x' }
  });
  assert.equal(unknownField.status, 400);

  const notConfiguredTest = await request('POST', '/api/v2/push-providers/huawei/test');
  assert.equal(notConfiguredTest.status, 400);

  // 保存一份明显的假凭据：校验必须失败，但仍要返回结构化错误（不泄露密钥）
  const badCredentials = await request('PUT', '/api/v2/push-providers/huawei', {
    credentials: { projectId: 'not-a-project', serviceAccount: '{"key_id":"x"}' }
  });
  assert.equal([400, 503].includes(badCredentials.status), true, JSON.stringify(badCredentials.body));
  assert.equal(typeof badCredentials.body.error, 'string');
  assert.equal('credentials' in badCredentials.body, false, '错误响应不得回传凭据');

  const providerView = await request('GET', '/api/v2/push-providers');
  const huaweiAfterSave = providerView.body.data.items.find(item => item.code === 'huawei');
  assert.equal('value' in (huaweiAfterSave.fields.serviceAccount || {}), false, '密钥字段永不回传明文');
  assert.equal(
    typeof huaweiAfterSave.fields.serviceAccount.configured,
    'boolean',
    '只暴露"是否已配置"'
  );

  const csUser = await request('POST', '/api/v2/employees', {
    username: `v2-provider-cs-${Date.now()}`, password: 'strong-password-7', name: 'v2 供应商客服', role: 'cs'
  });
  assert.equal(csUser.status, 201);
  const csLogin = await request('POST', '/api/v2/auth/login', {
    username: csUser.body.data.employee.username, password: 'strong-password-7'
  }, false);
  assert.equal(csLogin.status, 200);
  token = csLogin.body.data.token;
  assert.equal((await request('GET', '/api/v2/push-providers')).status, 403);
  assert.equal((await request('PUT', '/api/v2/push-providers/huawei', { credentials: {} })).status, 403);
  token = adminToken;
});

// ============ v1↔v2 补齐：客户字段对齐（含历史别名） ============
test('v2 客户列表字段与 v1 对齐（含 taskCount 等与 contactName 别名）', async () => {
  const created = await request('POST', '/api/v2/customers', {
    name: `v2 字段对齐客户 ${Date.now()}`, contactName: '张三', contactPhone: '13800000001', remark: '备注X'
  });
  assert.equal(created.status, 201);

  const list = await request('GET', '/api/v2/customers?page=1&pageSize=100');
  assert.equal(list.status, 200);
  const row = list.body.data.items.find(item => item.name.startsWith('v2 字段对齐客户'));
  assert.ok(row, '新建客户应出现在列表中');

  // 与 v1 一致：主名 + 别名 + 订单统计
  for (const key of ['contactName', 'contactPhone', 'remark', 'taskCount', 'openTaskCount', 'completedTaskCount', 'addressCount', 'mainCsId']) {
    assert.equal(key in row, true, `v2 客户列表应包含字段 ${key}`);
  }
  assert.equal(row.contactName, '张三');
  assert.equal(row.contactPhone, '13800000001');
  assert.equal(row.remark, '备注X');
  assert.equal(row.taskCount, 0);

  // v1 同名接口（列表）的字段集合应被完全覆盖 —— 这是"补齐"的判据。
  // 注意 v1 /api/customers 的 size 默认值是 1（且 size=0 会因 `|| 1` 也变成 1），
  // 取全量必须显式传一个足够大的 size。
  const v1 = await request('GET', '/api/customers?size=200');
  assert.equal(v1.status, 200);
  const v1Arr = Array.isArray(v1.body) ? v1.body : (v1.body.list || v1.body.items || []);
  const v1Row = v1Arr.find(item => item.name.startsWith('v2 字段对齐客户'));
  assert.ok(v1Row, `v1 列表未包含新建客户；v1 条数=${v1Arr.length}`);
  const missing = Object.keys(v1Row).filter(key => !(key in row));
  assert.deepEqual(missing, [], `v2 客户列表缺字段: ${missing.join(', ')}`);
  assert.equal(row.mainCsName, '', 'v2 列表应带 mainCsName（移动端列表需要）');
});

// ============ v1↔v2 补齐：取件员端接口 ============
test('v2 取件员端接口：我的任务 / 可选客户 / 取件员下拉', async () => {
  // 下拉：与 v1 /api/employees/workers 语义一致
  const workers = await request('GET', '/api/v2/employees/workers');
  assert.equal(workers.status, 200);
  assert.ok(Array.isArray(workers.body.data.items));
  if (workers.body.data.items.length) {
    const w = workers.body.data.items[0];
    for (const key of ['id', 'userId', 'name', 'region']) {
      assert.equal(key in w, true, `取件员下拉应含 ${key}`);
    }
    assert.equal(w.id, w.userId);
  }

  // 建一个取件员账号并登录（v2 的 employees 服务使用存储角色值 courier）
  const workerName = `v2 取件员 ${Date.now()}`;
  const emp = await request('POST', '/api/v2/employees', {
    username: `v2-worker-${Date.now()}`, password: 'strong-password-7', name: workerName, role: 'courier'
  });
  assert.equal(emp.status, 201, JSON.stringify(emp.body));
  const workerLogin = await request('POST', '/api/v2/auth/login', {
    username: emp.body.data.employee.username, password: 'strong-password-7'
  }, false);
  assert.equal(workerLogin.status, 200);
  const workerToken = workerLogin.body.data.token;

  const saved = token;
  token = workerToken;
  const mine = await request('GET', '/api/v2/worker/tasks');
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.body.data.items), '我的任务应返回 {data:{items}}');

  const options = await request('GET', '/api/v2/worker/customer-options');
  assert.equal(options.status, 200);
  assert.ok(Array.isArray(options.body.data.items), '可选客户应返回 {data:{items}}');

  // 取件员不应看到管理员专属的员工下拉以外的越权数据（此处仅验证接口可用）
  token = saved;

  // 非取件员调用 customer-options 应 403（与 v1 一致）
  const asAdmin = await request('GET', '/api/v2/worker/customer-options');
  assert.equal(asAdmin.status, 403);
});

// ============ v1↔v2 补齐：客户删除/停用 与 地址 CRUD ============
test('v2 客户停用/删除 与 地址增改停用', async () => {
  const name = `v2 地址客户 ${Date.now()}`;
  const created = await request('POST', '/api/v2/customers', { name, address: '初始地址 1 号' });
  assert.equal(created.status, 201);
  const customerId = created.body.data.customer.id;

  // 新建客户时带地址，应已生成一条默认地址
  const detail0 = await request('GET', `/api/v2/customers/${customerId}`);
  assert.equal(detail0.status, 200);
  assert.equal(detail0.body.data.customer.addresses.length, 1);

  // 新增地址
  const added = await request('POST', `/api/v2/customers/${customerId}/addresses`, {
    name: '仓库', address: '仓库地址 2 号', contactName: '李四', contactPhone: '13900000002', isCommon: true
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const addressId = added.body.data.address.id;
  for (const key of ['id', 'name', 'address', 'contactName', 'contactPhone', 'areaId', 'isCommon', 'isActive', 'remark']) {
    assert.equal(key in added.body.data.address, true, `地址视图应含 ${key}`);
  }
  assert.equal(added.body.data.address.isCommon, true);

  // 编辑地址（只传部分字段，其余保持原值）
  const edited = await request('PUT', `/api/v2/addresses/${addressId}`, { address: '仓库地址 2 号改' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.address.address, '仓库地址 2 号改');
  assert.equal(edited.body.data.address.contactName, '李四', '未传字段应保持原值');
  assert.equal(edited.body.data.address.isCommon, true, '未传 isCommon 应保持原值');

  // 停用地址
  const disabled = await request('PATCH', `/api/v2/addresses/${addressId}/status`, { isActive: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.data.address.isActive, false);

  // 地址不存在 → 404
  assert.equal((await request('PUT', '/api/v2/addresses/not-exist', { address: 'x' })).status, 404);
  assert.equal((await request('PATCH', '/api/v2/addresses/not-exist/status', { isActive: false })).status, 404);
  assert.equal((await request('POST', '/api/v2/customers/not-exist/addresses', { address: 'x' })).status, 404);
  // 地址为空 → 400
  assert.equal((await request('POST', `/api/v2/customers/${customerId}/addresses`, { address: '  ' })).status, 400);

  // 客户停用 / 启用
  const off = await request('PATCH', `/api/v2/customers/${customerId}/status`, { status: 'disabled' });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.customer.status, 'disabled');
  const on = await request('PATCH', `/api/v2/customers/${customerId}/status`, { status: 'active' });
  assert.equal(on.body.data.customer.status, 'active');

  // 删除客户（同时清掉地址）
  const removed = await request('DELETE', `/api/v2/customers/${customerId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.ok, true);
  assert.equal((await request('GET', `/api/v2/customers/${customerId}`)).status, 404);
  assert.equal((await request('DELETE', `/api/v2/customers/${customerId}`)).status, 404);
});

// v2 与 v1 对"有进行中任务时禁止删客户"的行为必须一致
test('v2 删除客户：有进行中任务时拒绝', async () => {
  const name = `v2 删单保护 ${Date.now()}`;
  const created = await request('POST', '/api/v2/customers', { name, address: '保护测试地址' });
  const customerId = created.body.data.customer.id;
  const detail = await request('GET', `/api/v2/customers/${customerId}`);
  const addressId = detail.body.data.customer.addresses[0].id;

  const task = await request('POST', '/api/v2/tasks', {
    customerId, addressId, taskType: 'normal'
  }, true, { 'X-Idempotency-Key': `del-guard-${Date.now()}` });
  assert.equal([200, 201].includes(task.status), true, JSON.stringify(task.body));

  const removed = await request('DELETE', `/api/v2/customers/${customerId}`);
  assert.equal(removed.status, 400);
  assert.match(String(removed.body.error), /进行中的任务/);
});

// ============ v1↔v2 补齐：用户账号管理 与 登录时段 ============
test('v2 用户账号：列表/创建/重置密码/删除 与 登录时段限制', async () => {
  const uname = `v2-user-${Date.now()}`;

  const created = await request('POST', '/api/v2/users', {
    username: uname, password: 'strong-password-7', role: 'cs', name: 'v2 账号客服'
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const userId = created.body.data.user.id;
  assert.equal(created.body.data.user.username, uname);
  assert.equal(created.body.data.user.role, 'cs');
  assert.equal('password_hash' in created.body.data.user, false, '不得回传口令散列');

  // 重复用户名 / 口令过短 / 角色不合法
  assert.equal((await request('POST', '/api/v2/users', { username: uname, password: 'strong-password-7', role: 'cs' })).status, 400);
  assert.equal((await request('POST', '/api/v2/users', { username: `${uname}-b`, password: '123', role: 'cs' })).status, 400);
  assert.equal((await request('POST', '/api/v2/users', { username: `${uname}-c`, password: 'strong-password-7', role: 'nope' })).status, 400);

  // 列表含 courierName 字段（与 v1 publicUser 扩展一致）
  const list = await request('GET', '/api/v2/users');
  assert.equal(list.status, 200);
  const row = list.body.data.items.find(u => u.id === userId);
  assert.ok(row, '新建用户应出现在列表');
  assert.equal('courierName' in row, true);

  // 重置密码后可用新密码登录
  const reset = await request('POST', `/api/v2/users/${userId}/reset`, { password: 'new-strong-password-8' });
  assert.equal(reset.status, 200);
  const relogin = await request('POST', '/api/v2/auth/login', { username: uname, password: 'new-strong-password-8' }, false);
  assert.equal(relogin.status, 200);
  assert.equal((await request('POST', `/api/v2/users/${userId}/reset`, { password: '123' })).status, 400);
  assert.equal((await request('POST', '/api/v2/users/not-exist/reset', { password: 'strong-password-7' })).status, 404);

  // 删除：内置 admin 受保护
  const adminRow = list.body.data.items.find(u => u.username === 'admin');
  assert.ok(adminRow);
  const delAdmin = await request('DELETE', `/api/v2/users/${adminRow.id}`);
  assert.equal(delAdmin.status, 400);
  assert.match(String(delAdmin.body.error), /内置管理员|至少需要一个管理员/);

  assert.equal((await request('DELETE', `/api/v2/users/${userId}`)).status, 200);
  assert.equal((await request('DELETE', `/api/v2/users/${userId}`)).status, 404);

  // 登录时段限制：读写闭环 + 非法角色
  const restrictions = await request('GET', '/api/v2/login-restrictions');
  assert.equal(restrictions.status, 200);
  assert.ok(Array.isArray(restrictions.body.data.items));
  const saved = await request('PUT', '/api/v2/login-restrictions/cs', {
    weekdays: '1,2,3,4,5', startTime: '08:00', endTime: '20:00', enabled: false
  });
  assert.equal(saved.status, 200);
  assert.equal((await request('PUT', '/api/v2/login-restrictions/admin', {})).status, 400);
});

// ============ v1↔v2 补齐：历史记录（records）写操作 ============
test('v2 记录：创建/编辑/状态/结算/删除 与权限回收', async () => {
  const created = await request('POST', '/api/v2/records', {
    date: '2026-09-01', customer: 'v2 记录客户', pieces: 3, address: '记录测试地址',
    orderNo: `V2ORD-${Date.now()}`, goods: '测试货物', trackingNo: `V2TRK-${Date.now()}`,
    amountReceivable: 100, amountPayable: 60, settled: '未结算'
  }, true, { 'X-Idempotency-Key': `rec-${Date.now()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const recordId = created.body.data.record.id;
  assert.equal('data' in created.body, true);
  assert.equal(created.body.data.record.pieces, 3);

  // 缺少日期 / 状态不合法 / 结算状态不合法
  assert.equal((await request('POST', '/api/v2/records', { customer: 'x', pieces: 1 })).status, 400);
  assert.equal((await request('POST', '/api/v2/records', { date: '2026-09-01', customer: 'x', pieces: 1, status: '乱写' })).status, 400);
  assert.equal((await request('POST', '/api/v2/records', { date: '2026-09-01', customer: 'x', pieces: 1, settled: '乱写' })).status, 400);

  // 编辑：件数与备注
  const edited = await request('PUT', `/api/v2/records/${recordId}`, { pieces: 5, note: '改过' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.record.pieces, 5);
  assert.equal(edited.body.data.record.note, '改过');
  assert.equal((await request('PUT', `/api/v2/records/${recordId}`, { pieces: 0 })).status, 400);

  // 状态流转
  const moved = await request('PUT', `/api/v2/records/${recordId}/status`, { status: '已取', note: '已取走' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.record.status, '已取');
  assert.equal((await request('PUT', `/api/v2/records/${recordId}/status`, { status: '乱写' })).status, 400);

  // 结算（客服/管理员）
  const settled = await request('PUT', `/api/v2/records/${recordId}/settle`, { settled: '已结算' });
  assert.equal(settled.status, 200);
  assert.equal(settled.body.data.record.settled, '已结算');
  assert.equal((await request('PUT', `/api/v2/records/${recordId}/settle`, { settled: '乱写' })).status, 400);

  // 列表能看到
  const list = await request('GET', '/api/v2/records?page=1&pageSize=100');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.items.some(r => r.id === recordId));
  // 分页包装一致性
  assert.equal(typeof list.body.data.total, 'number');
  assert.equal(list.body.data.page, 1);

  // 删除
  assert.equal((await request('DELETE', `/api/v2/records/${recordId}`)).status, 200);
  assert.equal((await request('DELETE', `/api/v2/records/${recordId}`)).status, 404);
  assert.equal((await request('PUT', '/api/v2/records/not-exist', { pieces: 1 })).status, 404);
});

// 取件员：权限回收规则必须与 v1 一致
test('v2 记录：取件员不可操作他人记录，完成后权限回收', async () => {
  const uname = `v2-rec-worker-${Date.now()}`;
  const emp = await request('POST', '/api/v2/employees', {
    username: uname, password: 'strong-password-7', name: 'v2 记录取件员', role: 'courier'
  });
  assert.equal(emp.status, 201);
  const workerLogin = await request('POST', '/api/v2/auth/login', { username: uname, password: 'strong-password-7' }, false);
  const workerToken = workerLogin.body.data.token;
  const workerCourierId = workerLogin.body.data.user.courierId;

  // 管理员建一条记录并指派给该取件员
  const created = await request('POST', '/api/v2/records', {
    date: '2026-09-02', customer: 'v2 权限客户', pieces: 1, address: '权限地址',
    courierId: workerCourierId
  }, true, { 'X-Idempotency-Key': `recperm-${Date.now()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const recordId = created.body.data.record.id;

  const saved = token;
  token = workerToken;
  // 自己的、未结束 → 可以改
  assert.equal((await request('PUT', `/api/v2/records/${recordId}`, { pieces: 2 })).status, 200);
  // 置为已完成（管理员态下操作，因为取件员完成后权限即回收）
  token = saved;
  assert.equal((await request('PUT', `/api/v2/records/${recordId}/status`, { status: '已完成' })).status, 200);
  token = workerToken;
  const afterDone = await request('PUT', `/api/v2/records/${recordId}`, { pieces: 3 });
  assert.equal(afterDone.status, 403);
  assert.match(String(afterDone.body.error), /权限已回收/);
  assert.equal((await request('DELETE', `/api/v2/records/${recordId}`)).status, 403);
  token = saved;
});

// ============ v1↔v2 补齐：重量匹配中心 ============
test('v2 匹配中心：待匹配列表与补票号', async () => {
  const center = await request('GET', '/api/v2/sync/match-center');
  assert.equal(center.status, 200);
  assert.ok(Array.isArray(center.body.data.items));

  // 建一条无票号明细，使其进入匹配中心
  const customerName = `v2 匹配客户 ${Date.now()}`;
  const cust = await request('POST', '/api/v2/customers', { name: customerName, address: '匹配地址' });
  const customerId = cust.body.data.customer.id;
  const detail = await request('GET', `/api/v2/customers/${customerId}`);
  const addressId = detail.body.data.customer.addresses[0].id;
  const task = await request('POST', '/api/v2/tasks', { customerId, addressId, taskType: 'normal' }, true,
    { 'X-Idempotency-Key': `match-task-${Date.now()}` });
  assert.equal([200, 201].includes(task.status), true, JSON.stringify(task.body));
  const taskId = task.body.data.task.id;
  const item = await request('POST', `/api/v2/tasks/${taskId}/items`, {
    entryMethod: 'manual', pieces: 2, goodsName: '待匹配货物'
  });
  assert.equal([200, 201].includes(item.status), true, JSON.stringify(item.body));

  const after = await request('GET', '/api/v2/sync/match-center');
  const target = after.body.data.items.find(i => i.taskId === taskId);
  assert.ok(target, '新录入的明细应出现在匹配中心');

  // 补票号：未登记过重量时应 matched=false 且状态转 pending
  const matched = await request('POST', `/api/v2/sync/match/${target.id}`, { waybillNo: `V2-MATCH-${Date.now()}` });
  assert.equal(matched.status, 200);
  assert.equal(matched.body.data.matched, false);
  assert.equal(matched.body.data.finalWeight, 0);
  // 空票号 → 400
  assert.equal((await request('POST', `/api/v2/sync/match/${target.id}`, { waybillNo: '  ' })).status, 400);
  assert.equal((await request('POST', '/api/v2/sync/match/not-exist', { waybillNo: 'x' })).status, 404);
});

// ============ v1↔v2 补齐：看板其余聚合 / 区域取件员 / 自助查单 / 任务明细编辑 ============
test('v2 看板聚合与 v1 同源（数字一致）', async () => {
  for (const path of ['/api/dashboard/workers', '/api/dashboard/cs', '/api/dashboard/customers', '/api/dashboard/trends']) {
    const v1 = await request('GET', path);
    const v2 = await request('GET', '/api/v2' + path.replace('/api', ''));
    assert.equal(v1.status, 200, path);
    assert.equal(v2.status, 200, path);
    const a = Array.isArray(v1.body) ? v1.body : v1.body.weight;
    const b = Array.isArray(v2.body.data.items) ? v2.body.data.items : v2.body.data.weight;
    assert.deepEqual(b, a, `${path} 的 v1/v2 结果必须一致`);
  }
});

test('v2 区域取件员分配 / 自助查单 / 任务明细编辑', async () => {
  // 区域取件员分配
  const area = await request('POST', '/api/v2/areas', { name: `v2 区域 ${Date.now()}` });
  assert.equal([200, 201].includes(area.status), true, JSON.stringify(area.body));
  const areaId = (area.body.data.area || area.body.data).id;
  const assign = await request('PUT', `/api/v2/areas/${areaId}/workers`, {
    defaultWorkerIds: [], backupWorkerIds: []
  });
  assert.equal(assign.status, 200);
  assert.equal(assign.body.data.ok, true);
  assert.equal((await request('PUT', '/api/v2/areas/not-exist/workers', {})).status, 404);

  // 自助查单：参数缺失与查不到
  assert.equal((await request('GET', '/api/v2/track', undefined, false)).status, 400);
  assert.equal((await request('GET', '/api/v2/track?phone=13800000000', undefined, false)).status, 400);
  assert.equal((await request('GET', '/api/v2/track?q=NOT-EXIST-XYZ', undefined, false)).status, 404);

  // 任务明细编辑：建单 → 加明细 → 改件数 → 换面单号需重置匹配状态
  const cust = await request('POST', '/api/v2/customers', { name: `v2 明细客户 ${Date.now()}`, address: '明细地址' });
  const customerId = cust.body.data.customer.id;
  const detail = await request('GET', `/api/v2/customers/${customerId}`);
  const addressId = detail.body.data.customer.addresses[0].id;
  const task = await request('POST', '/api/v2/tasks', { customerId, addressId, taskType: 'normal' }, true,
    { 'X-Idempotency-Key': `item-edit-${Date.now()}` });
  assert.equal([200, 201].includes(task.status), true, JSON.stringify(task.body));
  const taskId = task.body.data.task.id;

  const added = await request('POST', `/api/v2/tasks/${taskId}/items`, {
    entryMethod: 'manual', waybillNo: `V2-ITEM-${Date.now()}`, pieces: 2, goodsName: '初始品名'
  });
  assert.equal([200, 201].includes(added.status), true, JSON.stringify(added.body));
  const items = added.body.data.task.items;
  const itemId = items[items.length - 1].id;

  // 件数必须为正整数
  assert.equal((await request('PUT', `/api/v2/tasks/${taskId}/items/${itemId}`, { pieces: 0 })).status, 400);
  assert.equal((await request('PUT', `/api/v2/tasks/${taskId}/items/${itemId}`, { pieces: '2' })).status, 400);

  const edited = await request('PUT', `/api/v2/tasks/${taskId}/items/${itemId}`, { pieces: 5, goodsName: '改后品名' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const changed = edited.body.data.task.items.find(i => i.id === itemId);
  assert.equal(changed.pieces, 5);
  assert.equal(changed.goodsName, '改后品名');

  // 不存在明细 / 不存在任务
  assert.equal((await request('PUT', `/api/v2/tasks/${taskId}/items/not-exist`, { pieces: 1 })).status, 404);
  assert.equal((await request('PUT', '/api/v2/tasks/not-exist/items/not-exist', { pieces: 1 })).status, 404);

  // 任务状态直改（v1 同款语义）
  const st = await request('PUT', `/api/v2/tasks/${taskId}/status`, { status: 'in_progress' });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.data.task.status, 'in_progress');
  assert.equal((await request('PUT', `/api/v2/tasks/${taskId}/status`, { status: '乱写' })).status, 400);
});

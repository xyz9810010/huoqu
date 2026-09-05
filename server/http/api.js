// 统一 API 路由模块：所有 /api 接口统一在这里注册。
// 职责：认证与会话、取件任务、单据/客户/取件员、看板统计、导入导出、
// 通知订阅与投递管理、SSE 实时连接等 HTTP 接口；服务端装配与启动见 server.js。
const { randomUUID } = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');

const { mountNotificationRoutes } = require('../modules/notifications/routes');
const { requireAuth, requireAdmin, requireStaff } = require('./auth-guard');
const { createUploader } = require('./uploads');

function mountApiRoutes(app, deps) {
  const {
    db, auth, tasks, businessNotificationPublisher, notificationService, notificationRepository,
    subscriptionStore, preferenceStore, providerConfigStore, providerRegistry,
    sseTickets, sseClients, broadcast, uploadsDir, machineApiKey: MACHINE_API_KEY
  } = deps;

  const { upload, imageUpload } = createUploader(uploadsDir);


// ---------- 工具 ----------
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const bjNow = () => new Date(Date.now() + 8 * 3600 * 1000); // 北京时间(UTC+8)
const todayStr = () => { const d = bjNow(); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const nowStr = () => { const d = bjNow(); return todayStr() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); };
const startOfWeek = () => { const d = bjNow(); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const rowCourier = (c) => ({ id: c.id, name: c.name, region: c.region || '', commissionRate: c.commission_rate || 0 });
const parseImages = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const rowRecord = (r) => ({
  id: r.id, date: r.date, courierId: r.courier_id, customer: r.customer, customerId: r.customer_id || '', address: r.address || '',
  pieces: r.pieces, region: r.region || '', note: r.note || '', status: r.status || '待取', orderNo: r.order_no || '',
  goods: r.goods || '', weight: r.weight || 0, volume: r.volume || 0, trackingNo: r.tracking_no || '',
  amountReceivable: r.amount_receivable || 0, amountPayable: r.amount_payable || 0, settled: r.settled || '未结算',
  pickupPhone: r.pickup_phone || '', createdAt: String(r.created_at || '').slice(0, 19),
  appointmentTime: r.appointment_time || '', completedAt: r.completed_at || '', dimensions: r.dimensions || '',
  dispatcherId: r.dispatcher_id || '', dispatcherName: r.dispatcher_name || '',
  goodsImages: parseImages(r.goods_images), pickupImages: parseImages(r.pickup_images)
});
const rowCustomer = (c) => ({
  id: c.id, customerNo: String(c.id || '').slice(0, 8), name: c.name,
  contact: c.contact || '', contactName: c.contact || '', phone: c.phone || '', contactPhone: c.phone || '',
  address: c.address || '', note: c.note || '', remark: c.note || '', status: c.status || 'active',
  legacyCustomerId: c.legacy_customer_id || '', importantNote: c.important_note || '', mainCsId: c.main_cs_id || ''
});
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const STATUSES = ['待取', '已取', '已完成', '已取消'];
// 客户名称归一化：全角→半角、全角空格→半角、合并连续空白
function normalizeCustomer(name) {
  let s = String(name || '');
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}


mountNotificationRoutes(app, {
  requireAuth,
  requireAdmin,
  registry: providerRegistry,
  subscriptions: subscriptionStore,
  preferences: preferenceStore,
  providerConfigs: providerConfigStore,
  notificationService,
  db,
  audit: logOperation
});
// 角色数据范围：admin / cs 看全部；courier 只能操作自己绑定的取件员
function dataFilter(user) {
  if (user.role === 'admin' || user.role === 'cs') return { cond: '', params: {} };
  return { cond: 'r.courier_id = :myCid', params: { myCid: user.courier_id || '__none__' } };
}


// ================= 认证 =================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = auth.verifyLogin(username, password);
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  const token = auth.createSession(u.id);
  res.json({ token, user: auth.publicUser(u) });
});
app.post('/api/logout', requireAuth, (req, res) => {
  auth.destroySession(req.token);
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => {
  res.json(auth.publicUser(req.user));
});
app.post('/api/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少6位' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (auth.hashPassword(oldPassword || '', u.salt) !== u.password_hash)
    return res.status(400).json({ error: '原密码不正确' });
  const salt = auth.createSalt();
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
    .run(auth.hashPassword(newPassword, salt), salt, u.id);
  res.json({ ok: true });
});

// ================= 统一取件任务 =================
function taskVisibleTo(user, task) {
  if (user.role === 'admin' || user.role === 'cs') return true;
  return Boolean(user.courier_id && task.defaultWorkerId === user.courier_id);
}

function taskDetail(taskId) {
  const task = tasks.getTask(taskId);
  if (!task) return null;
  const worker = task.defaultWorkerId ? db.prepare('SELECT name FROM couriers WHERE id=?').get(task.defaultWorkerId) : null;
  const mainCs = task.mainCsId ? db.prepare('SELECT name FROM users WHERE id=?').get(task.mainCsId) : null;
  task.defaultWorkerName = worker ? worker.name : '';
  task.mainCsName = mainCs ? mainCs.name : '';
  task.addressPointName = task.areaName || '默认地址';
  task.items = task.items.map(item => {
    const itemWorker = item.workerId ? db.prepare('SELECT name FROM couriers WHERE id=?').get(item.workerId) : null;
    return Object.assign(item, { workerName: itemWorker ? itemWorker.name : task.defaultWorkerName });
  });
  task.photos = db.prepare('SELECT * FROM pickup_photos WHERE task_id=? ORDER BY created_at,id').all(taskId).map(photo => ({
    id: photo.id, type: photo.photo_type, filename: photo.filename, filePath: '/uploads/' + photo.filename, createdAt: photo.created_at
  }));
  task.exceptions = db.prepare('SELECT * FROM task_exceptions WHERE task_id=? ORDER BY created_at DESC').all(taskId).map(row => ({
    id: row.id, type: row.exception_type, description: row.description, resolved: Boolean(row.resolved),
    resolution: row.resolution, createdAt: row.created_at, resolvedAt: row.resolved_at
  }));
  task.workers = task.defaultWorkerId ? [{ userId: task.defaultWorkerId, name: task.defaultWorkerName, role: 'primary' }] : [];
  return task;
}

function logOperation(user, action, targetType = '', targetId = '', detail = '') {
  db.prepare(`INSERT INTO operation_logs (id,user_id,user_name,action,target_type,target_id,detail,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), user?.id || '', user?.name || user?.username || '', action, targetType, targetId, detail, nowStr());
}

app.get('/api/tasks', requireAuth, (req, res) => {
  const filters = {
    status: String(req.query.status || ''),
    customerId: String(req.query.customerId || ''),
    keyword: String(req.query.keyword || ''),
    workerId: req.user.role === 'courier' ? (req.user.courier_id || '__none__') : String(req.query.workerId || '')
  };
  const all = tasks.listTasks(filters);
  const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size || '20', 10) || 20));
  res.json({ list: all.slice(page * size, page * size + size), total: all.length, page, size });
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = taskDetail(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权查看该任务' });
  res.json(task);
});

app.post('/api/tasks', requireAuth, requireStaff, (req, res) => {
  try {
    const input = { ...(req.body || {}) };
    if (input.customerId) {
      const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(String(input.customerId));
      if (!customer) return res.status(400).json({ error: '客户不存在' });
      input.customerName = input.customerName || customer.name;
      input.contact = input.contact || customer.contact || '';
      input.phone = input.phone || customer.phone || '';
      input.mainCsId = input.mainCsId || customer.main_cs_id || '';
    }
    if (input.addressId) {
      const address = db.prepare('SELECT a.*,r.name AS area_name FROM customer_addresses a LEFT JOIN areas r ON r.id=a.area_id WHERE a.id=?').get(String(input.addressId));
      if (!address) return res.status(400).json({ error: '取件地址不存在' });
      input.address = input.address || address.address;
      input.contact = input.contact || address.contact_name || '';
      input.phone = input.phone || address.contact_phone || '';
      input.areaName = input.areaName || address.area_name || '';
    }
    input.defaultWorkerId = input.defaultWorkerId || input.workerId || '';
    const task = tasks.createTask(input, { id: req.user.id, name: req.user.name || req.user.username });
    logOperation(req.user, '创建取件任务', 'task', task.id, task.taskNo);
    broadcast({ type: 'task.created', taskId: task.id, status: task.status });
    res.status(201).json(task);
  } catch (error) {
    res.status(400).json({ error: error.message || '创建任务失败' });
  }
});

app.put('/api/tasks/:id/status', requireAuth, (req, res) => {
  try {
    const current = tasks.getTask(req.params.id);
    if (!current) return res.status(404).json({ error: '取件任务不存在' });
    if (!taskVisibleTo(req.user, current)) return res.status(403).json({ error: '无权操作该任务' });
    const task = tasks.transitionTask(
      req.params.id,
      String((req.body && req.body.status) || ''),
      { id: req.user.id, name: req.user.name || req.user.username },
      String((req.body && req.body.note) || '')
    );
    broadcast({ type: 'task.status', taskId: task.id, status: task.status });
    res.json(task);
  } catch (error) {
    res.status(400).json({ error: error.message || '更新任务状态失败' });
  }
});

app.post('/api/tasks/:id/items', requireAuth, (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
  const body = req.body || {};
  const pieces = Math.max(1, parseInt(body.pieces || '1', 10) || 1);
  const itemId = randomUUID();
  const createdAt = nowStr();
  const waybillNo = String(body.waybillNo || '').trim();
  db.prepare(`INSERT INTO pickup_items
    (id,task_id,worker_id,entry_method,waybill_no,goods_name,pieces,sort_order,final_weight,weight_source,match_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      itemId, task.id, req.user.courier_id || task.defaultWorkerId || '', body.entryMethod || (waybillNo ? 'manual' : 'no_waybill'),
      waybillNo, String(body.goodsName || body.goods || ''), pieces, task.items.length, num(body.finalWeight),
      body.weightSource || '', num(body.finalWeight) ? 'matched' : (waybillNo ? 'pending' : 'no_waybill'), createdAt, createdAt
    );
  db.prepare(`INSERT INTO task_events (id,task_id,event_type,note,actor_id,actor_name,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.id, 'item_added', waybillNo, req.user.id, req.user.name || req.user.username, createdAt);
  res.status(201).json(taskDetail(task.id));
});

function transitionAlias(status) {
  return (req, res) => {
    try {
      const task = tasks.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: '取件任务不存在' });
      if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
      res.json(taskDetail(tasks.transitionTask(task.id, status, {
        id: req.user.id, name: req.user.name || req.user.username
      }, String((req.body && req.body.note) || '')).id));
    } catch (error) {
      res.status(400).json({ error: error.message || '更新任务失败' });
    }
  };
}
app.post('/api/tasks/:id/start', requireAuth, transitionAlias('in_progress'));
app.post('/api/tasks/:id/complete', requireAuth, transitionAlias('completed'));
app.post('/api/tasks/:id/cancel', requireAuth, transitionAlias('cancelled'));

app.post('/api/tasks/:id/exceptions', requireAuth, (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
  try {
    tasks.reportException(task.id, req.body || {}, { id: req.user.id, name: req.user.name || req.user.username });
    res.status(201).json(taskDetail(task.id));
  } catch (error) {
    res.status(400).json({ error: error.message || '上报异常失败' });
  }
});

app.post('/api/exceptions/:id/resolve', requireAuth, requireStaff, (req, res) => {
  try {
    res.json(tasks.resolveException(req.params.id, String((req.body && req.body.resolution) || ''), {
      id: req.user.id, name: req.user.name || req.user.username
    }));
  } catch (error) {
    const status = /不存在/.test(error.message || '') ? 404 : 400;
    res.status(status).json({ error: error.message || '处理异常失败' });
  }
});

app.post('/api/tasks/:id/reassign', requireAuth, requireStaff, (req, res) => {
  const workerId = String((req.body && req.body.workerId) || '');
  if (workerId && !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId)) return res.status(400).json({ error: '取件员不存在' });
  try {
    res.json(taskDetail(tasks.assignTask(req.params.id, workerId, {
      id: req.user.id, name: req.user.name || req.user.username
    }).id));
  } catch (error) {
    res.status(400).json({ error: error.message || '改派失败' });
  }
});
app.post('/api/tasks/:id/transfer', requireAuth, (req, res) => {
  const workerId = String((req.body && req.body.workerId) || '');
  const task = tasks.getTask(req.params.id);
  if (!task || !taskVisibleTo(req.user, task)) return res.status(task ? 403 : 404).json({ error: task ? '无权操作该任务' : '取件任务不存在' });
  try {
    res.json(taskDetail(tasks.assignTask(task.id, workerId, {
      id: req.user.id, name: req.user.name || req.user.username
    }).id));
  } catch (error) {
    res.status(400).json({ error: error.message || '转派失败' });
  }
});
app.post('/api/tasks/:id/assist', requireAuth, (req, res) => res.json(taskDetail(req.params.id)));

app.put('/api/tasks/:id', requireAuth, requireStaff, (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  try {
    const updated = tasks.updateTask(task.id, req.body || {}, { id: req.user.id, name: req.user.name || req.user.username });
    logOperation(req.user, '修改取件任务', 'task', task.id);
    res.json(taskDetail(updated.id));
  } catch (error) {
    res.status(400).json({ error: error.message || '修改取件任务失败' });
  }
});

app.post('/api/tasks/:id/again', requireAuth, requireStaff, (req, res) => {
  const source = tasks.getTask(req.params.id);
  if (!source) return res.status(404).json({ error: '取件任务不存在' });
  try {
    const created = tasks.createTask({
      customerId: source.customerId, customerName: source.customerName, address: source.address,
      contact: source.contact, phone: source.phone, areaName: source.areaName, mainCsId: source.mainCsId,
      defaultWorkerId: source.defaultWorkerId, taskType: source.taskType, pickupNote: source.pickupNote,
      internalNote: source.internalNote, items: source.items.map(item => ({ goodsName: item.goodsName, pieces: item.pieces }))
    }, { id: req.user.id, name: req.user.name || req.user.username });
    logOperation(req.user, '再次取件', 'task', created.id, `来源 ${source.taskNo}`);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message || '创建任务失败' });
  }
});

app.post('/api/tasks/:id/photos', requireAuth, imageUpload.any(), (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
  const createdAt = nowStr();
  const insert = db.prepare('INSERT INTO pickup_photos (id,task_id,photo_type,filename,uploaded_by,created_at) VALUES (?,?,?,?,?,?)');
  for (const file of req.files || []) insert.run(randomUUID(), task.id, 'pickup', file.filename, req.user.id, createdAt);
  logOperation(req.user, '上传取件照片', 'task', task.id, String((req.files || []).length));
  res.status(201).json(taskDetail(task.id));
});

app.get('/api/sync/match-center', requireAuth, requireStaff, (req, res) => {
  const rows = db.prepare(`SELECT i.*,t.task_no,t.customer_name_snap FROM pickup_items i
    JOIN pickup_tasks t ON t.id=i.task_id WHERE i.match_status IN ('pending','no_waybill') ORDER BY i.created_at DESC`).all();
  res.json(rows.map(row => ({
    id: row.id, taskId: row.task_id, taskNo: row.task_no, customerName: row.customer_name_snap,
    waybillNo: row.waybill_no, pieces: row.pieces, entryMethod: row.entry_method, matchStatus: row.match_status
  })));
});

app.post('/api/sync/match/:id', requireAuth, requireStaff, (req, res) => {
  const item = db.prepare('SELECT * FROM pickup_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '货物明细不存在' });
  const waybillNo = String((req.body && req.body.waybillNo) || '').trim();
  if (!waybillNo) return res.status(400).json({ error: '请输入票号' });
  const weight = db.prepare('SELECT * FROM waybill_weights WHERE waybill_no=?').get(waybillNo);
  db.prepare(`UPDATE pickup_items SET waybill_no=?,entry_method='manual',final_weight=?,weight_source=?,match_status=?,updated_at=? WHERE id=?`)
    .run(waybillNo, weight ? num(weight.final_weight) : num(item.final_weight), weight ? 'waybill_sync' : '', weight ? 'matched' : 'pending', nowStr(), item.id);
  res.json({ matched: Boolean(weight), finalWeight: weight ? num(weight.final_weight) : 0 });
});

function dashboardRangeStart(range) {
  if (range === 'today') return todayStr();
  if (range === 'yesterday') {
    const d = bjNow(); d.setUTCDate(d.getUTCDate() - 1);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  if (range === 'week') return startOfWeek();
  if (range === 'month') return todayStr().slice(0, 8) + '01';
  return '';
}
function dashboardWhere(range, alias = 't') {
  const start = dashboardRangeStart(range);
  return start ? { sql: `WHERE substr(${alias}.created_at,1,10)>=?`, params: [start] } : { sql: '', params: [] };
}

app.get('/api/dashboard/board', requireAuth, (req, res) => {
  const where = dashboardWhere(String(req.query.range || 'today'));
  const taskRows = db.prepare(`SELECT * FROM pickup_tasks t ${where.sql}`).all(...where.params);
  const ids = taskRows.map(row => row.id);
  const itemRows = ids.length ? db.prepare(`SELECT * FROM pickup_items WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const completed = taskRows.filter(row => row.status === 'completed');
  res.json({
    shipCustomerCount: new Set(completed.map(row => row.customer_id || row.customer_name_snap)).size,
    finalWeight: itemRows.reduce((sum, row) => sum + num(row.final_weight), 0),
    pickupCustomerCount: new Set(completed.map(row => row.customer_id || row.customer_name_snap)).size,
    pickupCount: completed.length,
    pieces: itemRows.reduce((sum, row) => sum + Number(row.pieces || 0), 0),
    pendingCount: taskRows.filter(row => row.status === 'pending' || row.status === 'in_progress').length
  });
});

app.get('/api/dashboard/workers', requireAuth, (req, res) => {
  const workers = db.prepare('SELECT * FROM couriers ORDER BY name').all();
  res.json(workers.map(worker => {
    const taskRows = db.prepare('SELECT * FROM pickup_tasks WHERE default_worker_id=?').all(worker.id);
    const ids = taskRows.map(row => row.id);
    const itemRows = ids.length ? db.prepare(`SELECT * FROM pickup_items WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
    return {
      id: worker.id, name: worker.name, pickupCount: taskRows.filter(row => row.status === 'completed').length,
      customerCount: new Set(taskRows.map(row => row.customer_id || row.customer_name_snap)).size,
      pieces: itemRows.reduce((sum, row) => sum + Number(row.pieces || 0), 0),
      weight: itemRows.reduce((sum, row) => sum + num(row.final_weight), 0), assistCount: 0,
      pending: taskRows.filter(row => row.status === 'pending' || row.status === 'in_progress').length
    };
  }));
});

app.get('/api/dashboard/cs', requireAuth, (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE role='cs' ORDER BY name").all();
  res.json(users.map(user => {
    const taskRows = db.prepare('SELECT * FROM pickup_tasks WHERE dispatch_cs_id=?').all(user.id);
    return { id: user.id, name: user.name || user.username, customerCount: new Set(taskRows.map(r => r.customer_id)).size, shipCustomerCount: 0, taskCount: taskRows.length, weight: 0 };
  }));
});

app.get('/api/dashboard/customers', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT customer_id AS id,customer_name_snap AS name,COUNT(*) AS taskCount
    FROM pickup_tasks GROUP BY customer_id,customer_name_snap ORDER BY taskCount DESC LIMIT 20`).all().map(row => ({ ...row, weight: 0 })));
});

app.get('/api/dashboard/trends', requireAuth, (req, res) => {
  const weight = db.prepare(`SELECT substr(t.created_at,1,10) AS date,ROUND(COALESCE(SUM(i.final_weight),0),2) AS weight
    FROM pickup_tasks t LEFT JOIN pickup_items i ON i.task_id=t.id GROUP BY substr(t.created_at,1,10) ORDER BY date DESC LIMIT 30`).all().reverse();
  res.json({ weight });
});

app.get('/api/dashboard/attention', requireAuth, (req, res) => {
  res.json({
    rushNearDeadline: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE task_type='rush' AND status IN ('pending','in_progress') AND rush_ship_time<>'' AND datetime(rush_ship_time)<=datetime('now','+8 hours','+2 hours')").get().count,
    overdue: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE status='pending' AND datetime(created_at)<=datetime('now','+8 hours','-2 hours')").get().count,
    unmatchedWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='pending'").get().count,
    noWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='no_waybill'").get().count,
    unresolvedException: db.prepare('SELECT COUNT(*) AS count FROM task_exceptions WHERE resolved=0').get().count,
    syncFailed: 0
  });
});

app.get('/api/dashboard/me', requireAuth, (req, res) => {
  const list = tasks.listTasks({ workerId: req.user.courier_id || '__none__' });
  res.json({ pending: list.filter(t => t.status === 'pending').length, inProgress: list.filter(t => t.status === 'in_progress').length, completed: list.filter(t => t.status === 'completed').length, pieces: list.flatMap(t => t.items).reduce((s, i) => s + i.pieces, 0) });
});
app.get('/api/worker/tasks', requireAuth, (req, res) => res.json(tasks.listTasks({ workerId: req.user.courier_id || '__none__', status: String(req.query.status || '') })));

function legacyNotification(notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: JSON.stringify(notification.data || {}),
    isRead: notification.read,
    read: notification.read,
    createdAt: notification.createdAt
  };
}

app.get('/api/notifications', requireAuth, (req, res) => {
  const result = notificationService.listForUser(req.user.id, { page: 1, pageSize: 100 });
  res.json(result.items.map(legacyNotification));
});
app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  res.json(notificationService.unreadCount(req.user.id));
});
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  notificationService.markRead(req.user.id, req.params.id);
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  notificationService.markAllRead(req.user.id);
  res.json({ ok: true });
});

app.get('/api/v1/notifications', requireAuth, (req, res) => {
  res.json({ data: notificationService.listForUser(req.user.id, req.query) });
});
app.get('/api/v1/notifications/unread-count', requireAuth, (req, res) => {
  res.json({ data: { count: notificationService.unreadCount(req.user.id) } });
});
app.post('/api/v1/notifications/:id/read', requireAuth, (req, res) => {
  const result = notificationService.markRead(req.user.id, req.params.id);
  if (result.changes === 0 && !notificationRepository.findById(req.params.id)) {
    return res.status(404).json({ error: '通知不存在' });
  }
  if (result.changes === 0) {
    const item = notificationRepository.findById(req.params.id);
    if (!item || item.recipientUserId !== req.user.id) return res.status(404).json({ error: '通知不存在' });
  }
  res.json({ data: { ok: true } });
});
app.post('/api/v1/notifications/read-all', requireAuth, (req, res) => {
  const result = notificationService.markAllRead(req.user.id);
  res.json({ data: { ok: true, updated: result.changes } });
});

// ================= 华为推送（设备注册） =================
app.post('/api/push/register', requireAuth, (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: '缺少推送 token' });
  try {
    const subscription = subscriptionStore.register({
      userId: req.user.id,
      channel: 'vendor_push',
      providerCode: 'huawei',
      platform: 'harmonyos',
      deviceLabel: 'HarmonyOS 设备',
      role: req.user.role,
      courierId: req.user.courier_id || '',
      secret: { token }
    });
    db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
    res.json({ ok: true, subscriptionId: subscription.id });
  } catch (error) {
    const status = error && error.code === 'PUSH_MASTER_KEY_MISSING' ? 503 : 400;
    res.status(status).json({ error: error.message || '登记推送订阅失败', code: error.code || '' });
  }
});
app.post('/api/push/unregister', requireAuth, (req, res) => {
  subscriptionStore.removeProviderForUser(req.user.id, 'huawei');
  db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ================= 实时推送（SSE 连接） =================
function openSse(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':connected\n\n');
  res.write('retry: 3000\n\n');
  const client = { id: randomUUID(), userId: user.id, role: user.role, courierId: user.courier_id || null, res };
  sseClients.add(client);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
}

app.post('/api/v1/events/tickets', requireAuth, (req, res) => {
  const ticket = sseTickets.issue({ token: req.token, userId: req.user.id });
  res.status(201).json({ data: { ticket, expiresInSeconds: 30 } });
});

app.get('/api/v1/events', (req, res) => {
  const ticket = String(req.query.ticket || '');
  let user = null;
  if (ticket) {
    const consumed = sseTickets.consume(ticket);
    user = consumed ? db.prepare('SELECT * FROM users WHERE id=?').get(consumed.userId) : null;
    if (!user) return res.status(401).json({ error: '推送连接凭证无效或已过期' });
  } else {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    user = token ? auth.findSession(token) : null;
    if (!user) return res.status(401).json({ error: '未登录' });
  }
  openSse(req, res, user);
});

// 旧客户端兼容入口：会话查询参数会被日志脱敏，客户端迁移后删除。
app.get('/api/events', (req, res) => {
  const token = String(req.query.token || '');
  const user = token ? auth.findSession(token) : null;
  if (!user) return res.status(401).json({ error: '未登录' });
  res.setHeader('Deprecation', 'true');
  openSse(req, res, user);
});

// ================= 用户管理（管理员） =================
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  res.json(rows.map(u => Object.assign(auth.publicUser(u), { courierName: (() => {
    const c = u.courier_id ? db.prepare('SELECT name FROM couriers WHERE id = ?').get(u.courier_id) : null;
    return c ? c.name : '';
  })() })));
});
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role, courierId, name } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname) return res.status(400).json({ error: '请输入用户名' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname))
    return res.status(400).json({ error: '用户名已存在' });
  if (!['admin', 'courier', 'cs'].includes(role)) return res.status(400).json({ error: '角色不正确' });
  const salt = auth.createSalt();
  const id = randomUUID();
  // 取件员账号姓名留空时，自动取绑定的取件员姓名
  let finalName = String(name || '').trim();
  if (finalName === '' && role === 'courier' && courierId) {
    const c = db.prepare('SELECT name FROM couriers WHERE id = ?').get(courierId);
    if (c) finalName = c.name;
  }
  // 客服（派单员）不绑定取件员
  db.prepare('INSERT INTO users (id,username,password_hash,salt,role,courier_id,name) VALUES (?,?,?,?,?,?,?)')
    .run(id, uname, auth.hashPassword(password, salt), salt, role, role === 'cs' ? null : (courierId || null), finalName);
  res.json(auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin' && u.username === 'admin') return res.status(400).json({ error: '不能删除内置管理员' });
  if (u.role === 'admin' && db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get('admin').n <= 1)
    return res.status(400).json({ error: '系统至少需要一个管理员' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ ok: true });
});
app.post('/api/users/:id/reset', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '新密码至少6位' });
  const salt = auth.createSalt();
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
    .run(auth.hashPassword(password, salt), salt, u.id);
  res.json({ ok: true });
});

// ================= 取件员（管理员） =================
app.get('/api/couriers', requireAuth, requireStaff, (req, res) => {
  res.json(db.prepare('SELECT * FROM couriers ORDER BY name').all().map(rowCourier));
});
app.post('/api/couriers', requireAuth, requireAdmin, (req, res) => {
  const { name, region = '', commissionRate = 0 } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入取件员姓名' });
  const id = randomUUID();
  db.prepare('INSERT INTO couriers (id, name, region, commission_rate) VALUES (?,?,?,?)').run(id, String(name).trim(), String(region || '').trim(), num(commissionRate));
  broadcast({ type: 'couriers.updated' });
  res.json(rowCourier(db.prepare('SELECT * FROM couriers WHERE id = ?').get(id)));
});
app.put('/api/couriers/:id', requireAuth, requireAdmin, (req, res) => {
  const cur = db.prepare('SELECT * FROM couriers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '取件员不存在' });
  const name = (req.body && req.body.name != null) ? String(req.body.name).trim() : cur.name;
  const region = (req.body && req.body.region != null) ? String(req.body.region).trim() : (cur.region || '');
  const rate = (req.body && req.body.commissionRate != null) ? num(req.body.commissionRate) : (cur.commission_rate || 0);
  if (!name) return res.status(400).json({ error: '姓名不能为空' });
  db.prepare('UPDATE couriers SET name = ?, region = ?, commission_rate = ? WHERE id = ?').run(name, region, rate, req.params.id);
  broadcast({ type: 'couriers.updated' });
  res.json(rowCourier(db.prepare('SELECT * FROM couriers WHERE id = ?').get(req.params.id)));
});
app.delete('/api/couriers/:id', requireAuth, requireAdmin, (req, res) => {
  if (!db.prepare('SELECT * FROM couriers WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: '取件员不存在' });
  db.prepare('DELETE FROM couriers WHERE id = ?').run(req.params.id);
  broadcast({ type: 'couriers.updated' });
  res.json({ ok: true });
});

// ================= 记录 =================
app.get('/api/records', requireAuth, (req, res) => {
  const { courierId, start, end, keyword, status, customerId } = req.query;
  // 待认领视图：只查未分配订单（取件员可查看并认领；管理员/客服用于找出漏派单）
  const wantUnassigned = req.query.unassigned === '1';
  const scope = wantUnassigned ? { cond: '', params: {} } : dataFilter(req.user);
  const conds = scope.cond ? [scope.cond] : [];
  const params = Object.assign({}, scope.params);
  if (wantUnassigned) conds.push("(r.courier_id IS NULL OR r.courier_id = '')");
  if (courierId && courierId !== 'all') {
    if (courierId === 'none') conds.push("(r.courier_id IS NULL OR r.courier_id = '')");
    else { conds.push('r.courier_id = :cid'); params.cid = courierId; }
  }
  if (start) { conds.push('r.date >= :start'); params.start = start; }
  if (end) { conds.push('r.date <= :end'); params.end = end; }
  if (status && status !== 'all' && STATUSES.includes(status)) { conds.push('r.status = :status'); params.status = status; }
  if (customerId && customerId !== 'all') { conds.push('r.customer_id = :custId'); params.custId = customerId; }
  if (keyword) { conds.push('(r.customer LIKE :kw OR r.order_no LIKE :kw OR r.tracking_no LIKE :kw OR r.goods LIKE :kw)'); params.kw = '%' + keyword + '%'; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`SELECT r.*, c.name AS cname, cu.name AS customer_name, cu.phone AS customer_phone
    FROM records r
    LEFT JOIN couriers c ON r.courier_id = c.id
    LEFT JOIN customers cu ON r.customer_id = cu.id
    ${where} ORDER BY r.date DESC, r.id DESC`).all(params);
  res.json(rows.map(r => Object.assign(rowRecord(r), { customerName: r.customer_name || r.customer, customerPhone: r.customer_phone || '' })));
});
app.post('/api/records', requireAuth, (req, res) => {
  const { date, courierId, customer, customerId, pieces, address = '', region = '', note = '', status = '待取', orderNo = '',
          goods = '', weight = 0, volume = 0, trackingNo = '', amountReceivable = 0, amountPayable = 0, settled = '未结算',
          pickupPhone = '', appointmentTime = '' } = req.body || {};
  if (!date) return res.status(400).json({ error: '请选择日期' });
  // 客户：优先用客户档案（customerId），否则用自由文本
  let custId = '', custFinal = '';
  if (customerId) {
    const cu = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (cu) { custId = cu.id; custFinal = cu.name; }
  }
  if (!custFinal) custFinal = normalizeCustomer(customer);
  if (!custFinal) return res.status(400).json({ error: '请输入客户名称' });
  // 件数仅取件员必填；派单角色（管理员/客服）取件地址必填
  const p = parseInt(pieces, 10) || 0;
  if (req.user.role === 'courier' && p <= 0) return res.status(400).json({ error: '请输入有效的取件件数' });
  const addressFinal = String(address || '').trim();
  if ((req.user.role === 'admin' || req.user.role === 'cs') && !addressFinal)
    return res.status(400).json({ error: '请输入取件地址' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: '状态不正确' });
  if (!['未结算', '已结算'].includes(settled)) return res.status(400).json({ error: '结算状态不正确' });
  const settledFinal = req.user.role === 'courier' ? '未结算' : settled; // 取件员登记固定为未结算
  const orderFinal = String(orderNo || '').trim();
  const trackingFinal = String(trackingNo || '').trim();
  // 订单号唯一校验（防重复录入）
  if (orderFinal && db.prepare('SELECT id FROM records WHERE order_no = ?').get(orderFinal))
    return res.status(409).json({ error: '订单号已存在，请勿重复录入：' + orderFinal });
  // 取件员角色：强制绑定为自己；管理员/客服可指定任意取件员
  const canAssign = req.user.role === 'admin' || req.user.role === 'cs';
  const cid = canAssign ? (courierId || null) : (req.user.courier_id || null);
  const id = randomUUID();
  const regionFinal = String(region || '').trim() ||
    (() => { const c = cid ? db.prepare('SELECT region FROM couriers WHERE id=?').get(cid) : null; return c ? c.region : ''; })();
  db.prepare(`INSERT INTO records (id,date,courier_id,customer,customer_id,pieces,address,region,note,status,order_no,goods,weight,volume,tracking_no,amount_receivable,amount_payable,settled,pickup_phone,appointment_time,dispatcher_id,dispatcher_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, date, cid, custFinal, custId, p, addressFinal, regionFinal, String(note || ''), status, orderFinal,
         String(goods || '').trim(), num(weight), num(volume), trackingFinal, num(amountReceivable), num(amountPayable), settledFinal,
         String(pickupPhone || '').trim(), String(appointmentTime || '').trim(), req.user.id, req.user.name || req.user.username);
  // 记录状态轨迹
  db.prepare('INSERT INTO record_status_log (id,record_id,status,note,user_name) VALUES (?,?,?,?,?)')
    .run(randomUUID(), id, status, String(note || ''), req.user.name || req.user.username);
  const created = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id));
  broadcast({ type: 'record.created', record: created, actorId: req.user.id, actor: req.user.name || req.user.username });
  businessNotificationPublisher.recordAssigned(created, {
    id: req.user.id, name: req.user.name || req.user.username
  }, randomUUID());
  res.json(created);
});
app.put('/api/records/:id/status', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const status = req.body && req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: '状态不正确' });
  // 取件员只能改自己的记录，且订单完成后权限自动回收；客服只能改自己派发的记录
  if (req.user.role === 'courier' && r.courier_id !== req.user.courier_id)
    return res.status(403).json({ error: '无权操作该记录' });
  if (req.user.role === 'courier' && (r.status === '已完成' || r.status === '已取消'))
    return res.status(403).json({ error: '订单已完成/已取消，操作权限已回收' });
  const completedAt = status === '已完成' ? nowStr() : (r.completed_at || '');
  db.prepare('UPDATE records SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, r.id);
  db.prepare('INSERT INTO record_status_log (id,record_id,status,note,user_name) VALUES (?,?,?,?,?)')
    .run(randomUUID(), r.id, status, String((req.body && req.body.note) || ''), req.user.name || req.user.username);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'status', actorId: req.user.id, actor: req.user.name || req.user.username });
  businessNotificationPublisher.recordStatusChanged(updated, {
    id: req.user.id, name: req.user.name || req.user.username
  }, randomUUID());
  res.json(updated);
});
app.put('/api/records/:id/settle', requireAuth, requireStaff, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const settled = req.body && req.body.settled;
  if (!['未结算', '已结算'].includes(settled)) return res.status(400).json({ error: '结算状态不正确' });
  db.prepare('UPDATE records SET settled = ? WHERE id = ?').run(settled, r.id);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'settle', actorId: req.user.id, actor: req.user.name || req.user.username });
  res.json(updated);
});
app.delete('/api/records/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  // 取件员只能删除自己的记录（且订单完成后权限回收）；客服只能删除自己派发的记录
  if (req.user.role === 'courier' && r.courier_id !== req.user.courier_id)
    return res.status(403).json({ error: '无权删除该记录' });
  if (req.user.role === 'courier' && (r.status === '已完成' || r.status === '已取消'))
    return res.status(403).json({ error: '订单已完成/已取消，操作权限已回收' });
  db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
  broadcast({ type: 'record.deleted', id: r.id, actorId: req.user.id, actor: req.user.name || req.user.username });
  res.json({ ok: true });
});

// ================= 图片上传（货物图 / 取件图） =================
app.post('/api/records/:id/images', requireAuth, (req, res, next) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  // 取件员仅自己的记录（且订单完成后权限回收）；客服仅自己派发的记录；管理员任意
  if (req.user.role === 'courier' && r.courier_id !== req.user.courier_id)
    return res.status(403).json({ error: '无权操作该记录' });
  if (req.user.role === 'courier' && (r.status === '已完成' || r.status === '已取消'))
    return res.status(403).json({ error: '订单已完成/已取消，操作权限已回收' });
  req.recordRow = r;
  next();
}, imageUpload.array('images', 9), (req, res) => {
  const r = req.recordRow;
  const type = (req.body && req.body.type) === 'pickup' ? 'pickup' : 'goods';
  const files = (req.files || []).map(f => f.filename);
  if (!files.length) return res.status(400).json({ error: '请选择图片' });
  const col = type === 'pickup' ? 'pickup_images' : 'goods_images';
  db.prepare(`UPDATE records SET ${col} = ? WHERE id = ?`).run(JSON.stringify(parseImages(r[col]).concat(files)), r.id);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'image', actorId: req.user.id, actor: req.user.name || req.user.username });
  res.json(updated);
});

// ================= 改派 / 认领 =================
app.put('/api/records/:id/courier', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const courierId = req.body && req.body.courierId;
  if (req.user.role === 'courier') {
    // 取件员只能认领「未分配」订单给自己
    if (r.courier_id && r.courier_id !== '') return res.status(403).json({ error: '该订单已分配，无法认领' });
    if (courierId !== req.user.courier_id) return res.status(403).json({ error: '只能认领给自己' });
  } else if (req.user.role === 'cs') {
    // 客服可改派任意订单
  }
  const finalCid = (courierId === '' || courierId === null || courierId === undefined) ? null : courierId;
  db.prepare('UPDATE records SET courier_id = ? WHERE id = ?').run(finalCid, r.id);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'assign', actorId: req.user.id, actor: req.user.name || req.user.username });
  businessNotificationPublisher.recordAssigned(updated, {
    id: req.user.id, name: req.user.name || req.user.username
  }, randomUUID());
  res.json(updated);
});

// ================= 有限编辑（取件实况字段） =================
app.put('/api/records/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  // 权限：取件员仅自己名下进行中订单；客服/管理员可操作全部
  if (req.user.role === 'courier') {
    if (r.courier_id !== req.user.courier_id) return res.status(403).json({ error: '无权操作该记录' });
    if (r.status === '已完成' || r.status === '已取消') return res.status(403).json({ error: '订单已完成/已取消，操作权限已回收' });
  }
  const b = req.body || {};
  // 允许补录：件数、面单号、地址、区域、品名、备注、取件电话（不允许改财务结算/状态/客户/取件员）
  const pieces = parseInt(b.pieces, 10);
  if (!pieces || pieces <= 0) return res.status(400).json({ error: '请输入取件件数' });
  const trackingNo = b.trackingNo != null ? String(b.trackingNo).trim() : (r.tracking_no || '');
  const address = b.address != null ? String(b.address).trim() : (r.address || '');
  const region = b.region != null ? String(b.region).trim() : (r.region || '');
  const goods = b.goods != null ? String(b.goods).trim() : (r.goods || '');
  const note = b.note != null ? String(b.note).trim() : (r.note || '');
  const pickupPhone = b.pickupPhone != null ? String(b.pickupPhone).trim() : (r.pickup_phone || '');
  const isStaff = req.user.role === 'admin' || req.user.role === 'cs';
  const amountReceivable = (isStaff && b.amountReceivable != null) ? num(b.amountReceivable) : (r.amount_receivable || 0);
  const amountPayable = (isStaff && b.amountPayable != null) ? num(b.amountPayable) : (r.amount_payable || 0);
  db.prepare('UPDATE records SET pieces=?, tracking_no=?, address=?, region=?, goods=?, note=?, pickup_phone=?, amount_receivable=?, amount_payable=? WHERE id=?')
    .run(pieces, trackingNo, address, region, goods, note, pickupPhone, amountReceivable, amountPayable, r.id);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'edit', actorId: req.user.id, actor: req.user.name || req.user.username });
  res.json(updated);
});

// ================= 过机设备上传（重量 + 尺寸） =================
// 公司过机设备：货物过机获取重量/尺寸后，调用此接口回传
// 请求头：X-Machine-Key: <密钥>  请求体：{ orderNo 或 trackingNo, weight, dimensions 或 length/width/height }
app.post('/api/machine/weigh', (req, res) => {
  if (!MACHINE_API_KEY) {
    return res.status(503).json({ error: '过机设备接口尚未配置', code: 'MACHINE_API_KEY_MISSING' });
  }
  const key = String(req.headers['x-machine-key'] || '').trim();
  if (key !== MACHINE_API_KEY) return res.status(401).json({ error: '无效的机器密钥' });
  const b = req.body || {};
  const orderNo = String(b.orderNo || '').trim();
  const trackingNo = String(b.trackingNo || '').trim();
  let r = null;
  if (orderNo) r = db.prepare('SELECT * FROM records WHERE order_no = ?').get(orderNo);
  if (!r && trackingNo) r = db.prepare('SELECT * FROM records WHERE tracking_no = ?').get(trackingNo);
  if (!r) return res.status(404).json({ error: '未找到对应订单（请提供 orderNo 或 trackingNo）' });
  const weight = num(b.weight);
  let dimensions = String(b.dimensions || '').trim();
  if (!dimensions) {
    const parts = [b.length, b.width, b.height].filter(x => x !== undefined && x !== null && x !== '');
    if (parts.length) dimensions = parts.join('×');
  }
  db.prepare('UPDATE records SET weight = ?, dimensions = ? WHERE id = ?').run(weight, dimensions, r.id);
  const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
  broadcast({ type: 'record.updated', record: updated, action: 'weigh', actorId: '', actor: '过机设备' });
  res.json({ ok: true, record: updated });
});

// ================= 客户管理 =================
// Unified Web operations: areas, employees and audit logs.
function areaView(row) {
  const assigned = db.prepare(`SELECT aw.worker_id AS userId,c.name,aw.worker_role AS role FROM area_workers aw
    LEFT JOIN couriers c ON c.id=aw.worker_id WHERE aw.area_id=? ORDER BY c.name`).all(row.id);
  const defaults = assigned.filter(item => item.role === 'default');
  const backups = assigned.filter(item => item.role === 'backup');
  return { id: row.id, name: row.name, code: row.code || '', defaultWorkerId: defaults[0]?.userId || '',
    defaultWorkerName: defaults[0]?.name || '', defaultWorkers: defaults, backupWorkers: backups };
}
app.get('/api/areas', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM areas ORDER BY name').all().map(areaView)));
app.post('/api/areas', requireAuth, requireStaff, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '区域名称不能为空' });
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO areas (id,name,code,created_at) VALUES (?,?,?,?)').run(id, name, String(req.body?.code || ''), nowStr());
    if (req.body?.defaultWorkerId) db.prepare("INSERT INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,'default')").run(id, req.body.defaultWorkerId);
    logOperation(req.user, '创建区域', 'area', id, name);
    res.status(201).json(areaView(db.prepare('SELECT * FROM areas WHERE id=?').get(id)));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/areas/:id', requireAuth, requireStaff, (req, res) => {
  const cur = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '区域不存在' });
  db.prepare('UPDATE areas SET name=?,code=? WHERE id=?').run(req.body?.name ?? cur.name, req.body?.code ?? cur.code, cur.id);
  if (req.body?.defaultWorkerId !== undefined) {
    db.prepare("DELETE FROM area_workers WHERE area_id=? AND worker_role='default'").run(cur.id);
    if (req.body.defaultWorkerId) db.prepare("INSERT INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,'default')").run(cur.id, req.body.defaultWorkerId);
  }
  res.json(areaView(db.prepare('SELECT * FROM areas WHERE id=?').get(cur.id)));
});
app.put('/api/areas/:id/workers', requireAuth, requireStaff, (req, res) => {
  if (!db.prepare('SELECT 1 FROM areas WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '区域不存在' });
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM area_workers WHERE area_id=?').run(req.params.id);
    const insert = db.prepare('INSERT OR IGNORE INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,?)');
    for (const workerId of req.body?.defaultWorkerIds || []) insert.run(req.params.id, workerId, 'default');
    for (const workerId of req.body?.backupWorkerIds || []) insert.run(req.params.id, workerId, 'backup');
  });
  replace(); res.json(areaView(db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id)));
});

function employeeView(user) {
  const courier = user.courier_id ? db.prepare('SELECT * FROM couriers WHERE id=?').get(user.courier_id) : null;
  return { id: user.id, username: user.username, name: user.name || courier?.name || '', phone: user.phone || '',
    employeeNo: user.employee_no || '', role: user.role === 'courier' ? 'worker' : user.role,
    status: user.status || 'active', courierId: user.courier_id || '', region: courier?.region || '' };
}
app.get('/api/employees/workers', requireAuth, (req, res) => res.json(
  db.prepare('SELECT * FROM couriers ORDER BY name').all().map(c => ({ id: c.id, userId: c.id, name: c.name, region: c.region || '' }))
));
app.get('/api/employees', requireAuth, requireAdmin, (req, res) => {
  let rows = db.prepare('SELECT * FROM users ORDER BY role,name').all().map(employeeView); const role = String(req.query.role || '');
  if (role) rows = rows.filter(row => row.role === role || (role === 'boss' && row.role === 'admin'));
  res.json(rows);
});
app.post('/api/employees', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {}; const username = String(body.username || '').trim(); const password = String(body.password || '');
  if (!username || password.length < 6 || !String(body.name || '').trim()) return res.status(400).json({ error: '用户名、姓名不能为空，密码至少 6 位' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(400).json({ error: '用户名已存在' });
  const role = body.role === 'worker' ? 'courier' : (body.role === 'boss' ? 'admin' : body.role);
  if (!['admin','cs','courier'].includes(role)) return res.status(400).json({ error: '角色不正确' });
  const userId = randomUUID(), courierId = role === 'courier' ? randomUUID() : '', salt = auth.createSalt();
  db.transaction(() => {
    if (courierId) db.prepare('INSERT INTO couriers (id,name,region) VALUES (?,?,?)').run(courierId, String(body.name).trim(), String(body.region || ''));
    db.prepare(`INSERT INTO users (id,username,password_hash,salt,role,courier_id,name,phone,employee_no,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?)`).run(userId, username, auth.hashPassword(password,salt), salt, role, courierId || null,
      String(body.name).trim(), String(body.phone || ''), String(body.employeeNo || ''), nowStr());
  })();
  logOperation(req.user, '创建员工', 'employee', userId, username);
  res.status(201).json(employeeView(db.prepare('SELECT * FROM users WHERE id=?').get(userId)));
});
app.put('/api/employees/:id', requireAuth, requireAdmin, (req, res) => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '员工不存在' });
  const role = req.body?.role === 'worker' ? 'courier' : (req.body?.role === 'boss' ? 'admin' : (req.body?.role || cur.role));
  let courierId = cur.courier_id || '';
  if (role === 'courier' && !courierId) { courierId=randomUUID(); db.prepare('INSERT INTO couriers (id,name,region) VALUES (?,?,?)').run(courierId,req.body?.name || cur.name,''); }
  db.prepare('UPDATE users SET name=?,phone=?,employee_no=?,role=?,courier_id=? WHERE id=?').run(
    req.body?.name ?? cur.name, req.body?.phone ?? cur.phone, req.body?.employeeNo ?? cur.employee_no, role, courierId || null, cur.id);
  if (courierId) db.prepare('UPDATE couriers SET name=? WHERE id=?').run(req.body?.name ?? cur.name,courierId);
  if (req.body?.password) { const salt=auth.createSalt(); db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').run(auth.hashPassword(req.body.password,salt),salt,cur.id); }
  res.json(employeeView(db.prepare('SELECT * FROM users WHERE id=?').get(cur.id)));
});
app.patch('/api/employees/:id/status', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET status=? WHERE id=?').run(String(req.query.status)==='disabled'?'disabled':'active',req.params.id);
  res.json(employeeView(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)));
});
app.get('/api/logs', requireAuth, requireAdmin, (req, res) => {
  const page=Math.max(0,Number(req.query.page)||0), size=Math.min(200,Math.max(1,Number(req.query.size)||50));
  const total=db.prepare('SELECT COUNT(*) AS n FROM operation_logs').get().n;
  const list=db.prepare(`SELECT user_name AS userName,action,target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt
    FROM operation_logs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(size,page*size);
  res.json({list,total,page,size});
});

app.get('/api/customers', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim();
  const rows = search
    ? db.prepare("SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR legacy_customer_id LIKE ? ORDER BY name").all(`%${search}%`, `%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM customers ORDER BY name').all();
  res.json(rows.map(row => ({ ...rowCustomer(row), addressCount: db.prepare('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?').get(row.id).n })));
});
app.post('/api/customers', requireAuth, (req, res) => {
  const { name, address = '' } = req.body || {};
  const contact = req.body?.contact ?? req.body?.contactName ?? '';
  const phone = req.body?.phone ?? req.body?.contactPhone ?? '';
  const note = req.body?.note ?? req.body?.remark ?? '';
  const n = normalizeCustomer(name);
  if (!n) return res.status(400).json({ error: '请输入客户名称' });
  const id = randomUUID();
  db.prepare(`INSERT INTO customers (id,name,contact,phone,address,note,legacy_customer_id,important_note,status)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, n, String(contact || '').trim(), String(phone || '').trim(), String(address || '').trim(),
      String(note || '').trim(), String(req.body?.legacyCustomerId || ''), String(req.body?.importantNote || ''), 'active');
  if (String(address || '').trim()) db.prepare(`INSERT INTO customer_addresses
    (id,customer_id,name,address,contact_name,contact_phone,is_common,is_active,created_at) VALUES (?,?,?,?,?,?,1,1,?)`)
    .run(randomUUID(), id, '默认地址', String(address).trim(), String(contact || '').trim(), String(phone || '').trim(), nowStr());
  logOperation(req.user, '创建客户', 'customer', id, n);
  broadcast({ type: 'customers.updated' });
  res.json(rowCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)));
});
app.put('/api/customers/:id', requireAuth, requireStaff, (req, res) => {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '客户不存在' });
  const g = (k) => (req.body && req.body[k] != null) ? String(req.body[k]).trim() : (cur[k] || '');
  const name = normalizeCustomer(g('name'));
  if (!name) return res.status(400).json({ error: '客户名称不能为空' });
  const contact = req.body?.contactName ?? req.body?.contact ?? cur.contact ?? '';
  const phone = req.body?.contactPhone ?? req.body?.phone ?? cur.phone ?? '';
  const note = req.body?.remark ?? req.body?.note ?? cur.note ?? '';
  db.prepare(`UPDATE customers SET name=?,contact=?,phone=?,address=?,note=?,legacy_customer_id=?,important_note=? WHERE id=?`)
    .run(name, String(contact), String(phone), g('address'), String(note), req.body?.legacyCustomerId ?? cur.legacy_customer_id ?? '',
      req.body?.importantNote ?? cur.important_note ?? '', req.params.id);
  logOperation(req.user, '修改客户', 'customer', req.params.id, name);
  broadcast({ type: 'customers.updated' });
  res.json(rowCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)));
});
app.delete('/api/customers/:id', requireAuth, requireStaff, (req, res) => {
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: '客户不存在' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  broadcast({ type: 'customers.updated' });
  res.json({ ok: true });
});

app.get('/api/customers/:id', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT c.*,u.name AS main_cs_name FROM customers c LEFT JOIN users u ON u.id=c.main_cs_id WHERE c.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '客户不存在' });
  const addresses = db.prepare('SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY is_common DESC,created_at,id').all(row.id).map(a => ({
    id: a.id, name: a.name, address: a.address, contactName: a.contact_name, contactPhone: a.contact_phone,
    areaId: a.area_id || '', isCommon: Boolean(a.is_common), isActive: Boolean(a.is_active), remark: a.remark || ''
  }));
  res.json({ ...rowCustomer(row), mainCsName: row.main_cs_name || '', addresses });
});

app.patch('/api/customers/:id/status', requireAuth, requireStaff, (req, res) => {
  const status = String(req.query.status || 'active');
  db.prepare('UPDATE customers SET status=? WHERE id=?').run(status === 'disabled' ? 'disabled' : 'active', req.params.id);
  logOperation(req.user, '修改客户状态', 'customer', req.params.id, status);
  res.json(rowCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id)));
});

app.post('/api/customers/:id/addresses', requireAuth, requireStaff, (req, res) => {
  if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '客户不存在' });
  const body = req.body || {};
  if (!String(body.address || '').trim()) return res.status(400).json({ error: '地址不能为空' });
  const id = randomUUID();
  db.prepare(`INSERT INTO customer_addresses (id,customer_id,name,address,contact_name,contact_phone,area_id,is_common,is_active,remark,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(id, req.params.id, body.name || '', String(body.address).trim(), body.contactName || '', body.contactPhone || '',
      body.areaId || '', body.isCommon ? 1 : 0, body.remark || '', nowStr());
  logOperation(req.user, '新增客户地址', 'customer', req.params.id, id);
  res.status(201).json({ id });
});

app.put('/api/addresses/:id', requireAuth, requireStaff, (req, res) => {
  const body = req.body || {};
  const cur = db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '地址不存在' });
  db.prepare(`UPDATE customer_addresses SET name=?,address=?,contact_name=?,contact_phone=?,area_id=?,is_common=?,remark=? WHERE id=?`).run(
    body.name ?? cur.name, body.address ?? cur.address, body.contactName ?? cur.contact_name, body.contactPhone ?? cur.contact_phone,
    body.areaId ?? cur.area_id, body.isCommon == null ? cur.is_common : (body.isCommon ? 1 : 0), body.remark ?? cur.remark, cur.id);
  res.json({ ok: true });
});

app.patch('/api/addresses/:id/status', requireAuth, requireStaff, (req, res) => {
  db.prepare('UPDATE customer_addresses SET is_active=? WHERE id=?').run(String(req.query.isActive) === 'false' ? 0 : 1, req.params.id);
  res.json({ ok: true });
});

// ================= 统计 =================
function buildDateFilter(mode, start, end) {
  const conds = []; const params = {};
  if (mode === 'today') { conds.push('r.date = :s'); params.s = todayStr(); }
  else if (mode === 'week') { conds.push('r.date BETWEEN :s AND :e'); params.s = startOfWeek(); params.e = todayStr(); }
  else if (mode === 'month') { conds.push("r.date LIKE :s || '%'"); params.s = todayStr().slice(0, 7); }
  else if (mode === 'year') { conds.push("r.date LIKE :s || '%'"); params.s = todayStr().slice(0, 4); }
  else if (mode === 'custom') {
    if (start && end) { conds.push('r.date BETWEEN :s AND :e'); params.s = start; params.e = end; }
    else if (start) { conds.push('r.date >= :s'); params.s = start; }
    else if (end) { conds.push('r.date <= :e'); params.e = end; }
  }
  return { where: conds.length ? conds.join(' AND ') : '1=1', params };
}
app.get('/api/stats', requireAuth, (req, res) => {
  const mode = ['today', 'week', 'month', 'year', 'custom', 'all'].includes(req.query.range) ? req.query.range : 'today';
  const df = buildDateFilter(mode, req.query.start, req.query.end);
  const scope = dataFilter(req.user);
  const conds = scope.cond ? [scope.cond, df.where] : [df.where];
  const where = 'WHERE ' + conds.join(' AND ');
  const params = Object.assign({}, scope.params, df.params);

  const global = db.prepare(`SELECT COALESCE(SUM(pieces),0) AS pieces, COUNT(*) AS orders,
     COUNT(DISTINCT customer) AS customers, COUNT(DISTINCT courier_id) AS couriers
     FROM records r ${where}`).get(params);
  const weightStat = db.prepare(`SELECT COALESCE(SUM(r.weight),0) AS totalWeight, COALESCE(AVG(r.weight),0) AS avgWeight, COALESCE(SUM(CASE WHEN r.weight > 0 THEN 1 ELSE 0 END),0) AS weighedCount FROM records r ${where}`).get(params);
  global.totalWeight = Math.round(weightStat.totalWeight * 100) / 100;
  global.avgWeight = Math.round(weightStat.avgWeight * 100) / 100;
  global.weighedCount = weightStat.weighedCount;
  // 「取件员数」口径修正：显示团队总人数（含暂无记录的取件员），避免月初无单时误显示为 0
  const teamCount = db.prepare('SELECT COUNT(*) AS n FROM couriers').get().n;
  global.couriers = (req.user.role === 'admin' || req.user.role === 'cs') ? teamCount : (req.user.courier_id ? 1 : 0);
  const byStatus = db.prepare(`SELECT r.status AS status, COUNT(*) AS orders, COALESCE(SUM(r.pieces),0) AS pieces
     FROM records r ${where} GROUP BY r.status ORDER BY orders DESC`).all(params);
  let perCourier;
  if (req.user.role === 'admin' || req.user.role === 'cs') {
    perCourier = db.prepare(`SELECT r.courier_id AS courierId, COALESCE(MAX(c.name),'未分配') AS name,
       COALESCE(MAX(c.region),'') AS region, COALESCE(SUM(r.pieces),0) AS pieces,
       COUNT(*) AS orders, COUNT(DISTINCT r.customer) AS customers
       FROM records r LEFT JOIN couriers c ON r.courier_id = c.id
       ${where} GROUP BY r.courier_id ORDER BY pieces DESC`).all(params);
  } else {
    const selfName = db.prepare('SELECT name FROM couriers WHERE id = ?').get(req.user.courier_id);
    perCourier = [{
      courierId: req.user.courier_id, name: (selfName && selfName.name) || req.user.name || '我的',
      region: '', pieces: global.pieces, orders: global.orders, customers: global.customers
    }];
  }
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const ydStr = yd.getFullYear() + '-' + pad(yd.getMonth() + 1) + '-' + pad(yd.getDate());
  const sc = dataFilter(req.user);
  const ycond = sc.cond ? sc.cond + ' AND r.date = :yd' : 'r.date = :yd';
  const yp = Object.assign({ yd: ydStr }, sc.params);
  const yPieces = db.prepare(`SELECT COALESCE(SUM(pieces),0) AS p FROM records r WHERE ${ycond}`).get(yp).p;
  // 客服派单量（管理员 / 客服可见）
  let perDispatcher = [];
  if (req.user.role === 'admin' || req.user.role === 'cs') {
    perDispatcher = db.prepare(`SELECT r.dispatcher_id AS dispatcherId, MAX(r.dispatcher_name) AS name,
       COUNT(*) AS orders, COALESCE(SUM(r.pieces),0) AS pieces, COUNT(DISTINCT r.customer) AS customers
       FROM records r ${where} GROUP BY r.dispatcher_id ORDER BY orders DESC`).all(params);
  }
  // 客户件数TOP10（取件员看自己的；客服/管理员看全部）
  const topCustomers = db.prepare(`SELECT r.customer AS name, COALESCE(SUM(r.pieces),0) AS pieces, COUNT(*) AS orders
    FROM records r ${where} GROUP BY r.customer ORDER BY pieces DESC LIMIT 10`).all(params);
  res.json({ range: mode, label: mode, yesterdayPieces: yPieces, global, byStatus, perCourier, perDispatcher, topCustomers });
});

// ================= 对账 =================
app.get('/api/billing', requireAuth, requireStaff, (req, res) => {
  const { start, end, customerId } = req.query;
  const conds = []; const params = {};
  if (start) { conds.push('r.date >= :start'); params.start = start; }
  if (end) { conds.push('r.date <= :end'); params.end = end; }
  if (customerId && customerId !== 'all') { conds.push('r.customer_id = :cid'); params.cid = customerId; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const byCustomer = db.prepare(`SELECT
     CASE WHEN r.customer_id != '' THEN r.customer_id ELSE r.customer END AS customerId,
     CASE WHEN r.customer_id != '' THEN COALESCE(MAX(cu.name),'') ELSE MAX(r.customer) END AS name,
     COUNT(*) AS orders, COALESCE(SUM(r.pieces),0) AS pieces,
     COALESCE(SUM(r.amount_receivable),0) AS receivable, COALESCE(SUM(r.amount_payable),0) AS payable,
     COALESCE(SUM(CASE WHEN r.settled='未结算' THEN r.amount_receivable ELSE 0 END),0) AS unsettled
     FROM records r LEFT JOIN customers cu ON r.customer_id = cu.id
     ${where}
     GROUP BY CASE WHEN r.customer_id != '' THEN r.customer_id ELSE r.customer END
     ORDER BY receivable DESC`).all(params);
  const total = db.prepare(`SELECT COALESCE(SUM(amount_receivable),0) AS receivable, COALESCE(SUM(amount_payable),0) AS payable,
     COALESCE(SUM(CASE WHEN settled='未结算' THEN amount_receivable ELSE 0 END),0) AS unsettled,
     COUNT(*) AS orders
     FROM records r ${where}`).get(params);
  res.json({ byCustomer, total });
});

// ================= 提成工资（管理员） =================
app.get('/api/commission', requireAuth, (req, res) => {
  const { start, end } = req.query;
  const conds = []; const params = {};
  if (start) { conds.push('r.date >= :start'); params.start = start; }
  if (end) { conds.push('r.date <= :end'); params.end = end; }
  const dateCond = conds.length ? conds.join(' AND ') : '1=1';
  const isStaff = req.user.role === 'admin' || req.user.role === 'cs';
  // 取件员只能看自己的提成；管理员/客服看全部
  const ownCond = isStaff ? '1=1' : 'c.id = :myCid';
  if (!isStaff) params.myCid = req.user.courier_id || '__none__';
  const rows = db.prepare(`SELECT c.id AS courierId, c.name AS name, COALESCE(c.commission_rate,0) AS rate,
     COALESCE(SUM(CASE WHEN ${dateCond} THEN r.pieces ELSE 0 END),0) AS pieces,
     COALESCE(SUM(CASE WHEN ${dateCond} THEN 1 ELSE 0 END),0) AS orders
     FROM couriers c LEFT JOIN records r ON r.courier_id = c.id
     WHERE ${ownCond}
     GROUP BY c.id ORDER BY pieces DESC`).all(params);
  const data = rows.map(x => ({ courierId: x.courierId, name: x.name, rate: x.rate, pieces: x.pieces, orders: x.orders, amount: Math.round(x.pieces * x.rate * 100) / 100 }));
  const total = data.reduce((s, x) => ({ pieces: s.pieces + x.pieces, orders: s.orders + x.orders, amount: Math.round((s.amount + x.amount) * 100) / 100 }), { pieces: 0, orders: 0, amount: 0 });
  res.json({ rows: data, total });
});

// ================= 趋势分析 =================
app.get('/api/trend', requireAuth, (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
  const scope = dataFilter(req.user);
  const extraCond = scope.cond ? ' AND ' + scope.cond : '';
  const params = Object.assign({}, scope.params);

  let labels = [], keyExpr, bucketStart;
  const now = new Date();
  if (period === 'daily') {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    for (let i = days - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); labels.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())); }
    keyExpr = "date";
    bucketStart = labels[0];
  } else if (period === 'weekly') {
    const weeks = Math.min(parseInt(req.query.weeks, 10) || 13, 52);
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i * 7); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1);
      const monday = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      labels.push(monday);
    }
    keyExpr = `strftime('%Y-%m-%d', date(date, 'weekday 0', '-6 days'))`;
    bucketStart = labels[0];
  } else { // monthly
    const months = Math.min(parseInt(req.query.months, 10) || 12, 36);
    for (let i = months - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); labels.push(d.getFullYear() + '-' + pad(d.getMonth() + 1)); }
    keyExpr = `substr(date,1,7)`;
    bucketStart = labels[0] + '-01';
  }

  const rows = db.prepare(`SELECT ${keyExpr} AS k, COALESCE(SUM(pieces),0) AS pieces, COUNT(DISTINCT customer) AS customers
     FROM records r WHERE date >= :bs ${extraCond} GROUP BY k`)
    .all(Object.assign({ bs: bucketStart }, params));
  const map = {};
  rows.forEach(r => { map[r.k] = { pieces: r.pieces, customers: r.customers }; });
  res.json({
    period, labels,
    pieces: labels.map(l => map[l] ? map[l].pieces : 0),
    customers: labels.map(l => map[l] ? map[l].customers : 0),
    totalPieces: labels.reduce((s, l) => s + (map[l] ? map[l].pieces : 0), 0)
  });
});

// ================= 备份 / 导入 / 导出 =================
app.get('/api/backup', requireAuth, requireAdmin, (req, res) => {
  const couriers = db.prepare('SELECT * FROM couriers ORDER BY name').all().map(rowCourier);
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all().map(rowCustomer);
  const records = db.prepare('SELECT * FROM records ORDER BY date DESC, id DESC').all().map(rowRecord);
  const statusLogs = db.prepare('SELECT * FROM record_status_log ORDER BY rowid ASC').all();
  res.json({ version: 3, exportedAt: new Date().toISOString(), couriers, customers, records, statusLogs });
});
app.post('/api/import', requireAuth, requireAdmin, (req, res) => {
  const { couriers = [], customers = [], records = [], statusLogs = [] } = req.body || {};
  if (!Array.isArray(couriers) || !Array.isArray(customers) || !Array.isArray(records)) return res.status(400).json({ error: '数据格式不正确' });
  const insC = db.prepare('INSERT OR REPLACE INTO couriers (id,name,region) VALUES (?,?,?)');
  const insCust = db.prepare('INSERT OR REPLACE INTO customers (id,name,contact,phone,address,note) VALUES (?,?,?,?,?,?)');
  const insR = db.prepare('INSERT OR REPLACE INTO records (id,date,courier_id,customer,customer_id,pieces,address,region,note,status,order_no,goods,weight,volume,tracking_no,amount_receivable,amount_payable,settled,dispatcher_id,dispatcher_name,goods_images,pickup_images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insLog = db.prepare('INSERT OR REPLACE INTO record_status_log (id,record_id,status,note,user_name,created_at) VALUES (?,?,?,?,?,?)');
  const tx = db.transaction(() => {
    couriers.forEach(c => insC.run(c.id || randomUUID(), c.name || '', c.region || ''));
    customers.forEach(c => insCust.run(c.id || randomUUID(), c.name || '', c.contact || '', c.phone || '', c.address || '', c.note || ''));
    records.forEach(r => insR.run(r.id || randomUUID(), r.date || '', r.courierId || null, r.customer || '', r.customerId || '', parseInt(r.pieces, 10) || 0, r.address || '', r.region || '', r.note || '', STATUSES.includes(r.status) ? r.status : '待取', r.orderNo || '', r.goods || '', num(r.weight), num(r.volume), r.trackingNo || '', num(r.amountReceivable), num(r.amountPayable), ['未结算', '已结算'].includes(r.settled) ? r.settled : '未结算', r.dispatcherId || '', r.dispatcherName || '', JSON.stringify(r.goodsImages || []), JSON.stringify(r.pickupImages || [])));
    (statusLogs || []).forEach(l => insLog.run(l.id || randomUUID(), l.record_id || '', l.status || '', l.note || '', l.user_name || '', l.created_at || ''));
  });
  tx();
  res.json({ ok: true, couriers: couriers.length, customers: customers.length, records: records.length });
});

// Excel 导出
app.get('/api/export.xlsx', requireAuth, requireStaff, (req, res) => {
  const records = db.prepare(`SELECT r.date, COALESCE(c.name,'未分配') AS 取件员,
     COALESCE(r.region,'') AS 区域, r.customer AS 客户名称, COALESCE(cu.phone,'') AS 客户电话, r.address AS 取件地址,
     r.order_no AS 订单号, r.tracking_no AS 面单号, r.goods AS 品名, r.weight AS 重量kg, r.volume AS 体积m3,
     r.pieces AS 件数, r.status AS 状态, r.amount_receivable AS 应收, r.amount_payable AS 应付, r.settled AS 结算, r.note AS 备注
     FROM records r LEFT JOIN couriers c ON r.courier_id = c.id LEFT JOIN customers cu ON r.customer_id = cu.id
     ORDER BY r.date DESC`).all();
  const perC = db.prepare(`SELECT COALESCE(c.name,'未分配') AS 取件员, COALESCE(SUM(r.pieces),0) AS 总件数,
     COUNT(*) AS 订单数, COUNT(DISTINCT r.customer) AS 客户数
     FROM records r LEFT JOIN couriers c ON r.courier_id = c.id
     GROUP BY r.courier_id ORDER BY 总件数 DESC`).all();
  const billing = db.prepare(`SELECT
     CASE WHEN r.customer_id != '' THEN COALESCE(MAX(cu.name),'') ELSE MAX(r.customer) END AS 客户,
     COUNT(*) AS 订单数, COALESCE(SUM(r.amount_receivable),0) AS 应收, COALESCE(SUM(r.amount_payable),0) AS 应付,
     COALESCE(SUM(CASE WHEN r.settled='未结算' THEN r.amount_receivable ELSE 0 END),0) AS 未结算应收
     FROM records r LEFT JOIN customers cu ON r.customer_id = cu.id
     GROUP BY CASE WHEN r.customer_id != '' THEN r.customer_id ELSE r.customer END
     ORDER BY 应收 DESC`).all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Huoqu 取件统计报表'], ['导出时间', new Date().toLocaleString('zh-CN')], ['']]),
    '汇总'); // 说明sheet
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(records), '取件记录');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(perC), '按取件员统计');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(billing), '客户对账');
  const commission = db.prepare(`SELECT c.name AS 取件员, COALESCE(c.commission_rate,0) AS 单价, COALESCE(SUM(r.pieces),0) AS 件数,
     COALESCE(SUM(r.pieces),0)*COALESCE(c.commission_rate,0) AS 提成金额
     FROM couriers c LEFT JOIN records r ON r.courier_id = c.id
     GROUP BY c.id ORDER BY 提成金额 DESC`).all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(commission), '取件员提成');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="huoqu_' + todayStr() + '.xlsx"');
  res.send(buf);
});
// 导入模板
app.get('/api/import.template.xlsx', requireAuth, requireAdmin, (req, res) => {
  const aoa = [['日期', '取件员', '客户名称', '地址', '订单号', '面单号', '品名', '重量kg', '体积m3', '件数', '状态', '应收', '应付', '结算', '区域', '备注'], ['2026-08-14', '张三', '义乌A贸易', '义乌市稠州路1号', 'PO20260814-001', 'YD001', '服装', '12.5', '0.3', '3', '待取', '150', '80', '未结算', '义乌市区', '']];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '取件记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // 中文文件名需用 filename*（RFC 5987）编码，避免非法 header 字符
  res.setHeader('Content-Disposition', "attachment; filename=\"import_template.xlsx\"; filename*=UTF-8''" + encodeURIComponent('导入模板.xlsx'));
  res.send(buf);
});
// Excel/Csv 导入（multer）
app.post('/api/import.file', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
    if (!rows.length) return res.status(400).json({ error: 'Excel 中没有数据' });
    const getName = (row) => row['取件员'] || row['取件人员'] || row['取件人'] || row['负责人'] || row['员工'] || '';
    const insR = db.prepare('INSERT INTO records (id,date,courier_id,customer,customer_id,pieces,address,region,note,status,order_no,goods,weight,volume,tracking_no,amount_receivable,amount_payable,settled,dispatcher_id,dispatcher_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const findC = db.prepare('SELECT id FROM couriers WHERE name = ?');
    const findOrder = db.prepare('SELECT id FROM records WHERE order_no = ?');
    const findCustomer = db.prepare('SELECT id FROM customers WHERE name = ?');
    const insC = db.prepare('INSERT INTO couriers (id,name,region) VALUES (?,?,?)');
    const insCust = db.prepare('INSERT INTO customers (id,name) VALUES (?,?)');
    let ok = 0, skip = 0;
    const tx = db.transaction(() => {
      rows.forEach(row => {
        const date = String(row['日期'] || '').trim();
        const dateNorm = normalizeDate(date);
        const customer = normalizeCustomer(row['客户名称'] || row['客户'] || '');
        const pieces = parseInt(row['件数'] || row['数量'] || 0, 10);
        const address = String(row['地址'] || row['取件地址'] || '').trim();
        const region = String(row['区域'] || '').trim();
        const note = String(row['备注'] || '').trim();
        const orderNo = String(row['订单号'] || '').trim();
        const trackingNo = String(row['面单号'] || '').trim();
        const goods = String(row['品名'] || '').trim();
        const weight = num(row['重量kg'] || row['重量'] || 0);
        const volume = num(row['体积m3'] || row['体积'] || 0);
        const amountReceivable = num(row['应收'] || 0);
        const amountPayable = num(row['应付'] || 0);
        const settled = String(row['结算'] || '').trim() === '已结算' ? '已结算' : '未结算';
        const status = STATUSES.includes(String(row['状态'] || '').trim()) ? String(row['状态']).trim() : '待取';
        if (!dateNorm || !customer || !pieces || pieces <= 0) { skip++; return; }
        if (orderNo && findOrder.get(orderNo)) { skip++; return; } // 订单号已存在，跳过防重复
        let cid = null;
        const cname = String(getName(row)).trim();
        if (cname) {
          let c = findC.get(cname);
          if (!c) { const id = randomUUID(); insC.run(id, cname, region); cid = id; }
          else cid = c.id;
        }
        // 客户档案自动匹配/创建
        let custId = '';
        let cc = findCustomer.get(customer);
        if (cc) custId = cc.id;
        else { const cid2 = randomUUID(); insCust.run(cid2, customer); custId = cid2; }
        insR.run(randomUUID(), dateNorm, cid, customer, custId, pieces, address, region, note, status, orderNo, goods, weight, volume, trackingNo, amountReceivable, amountPayable, settled, '', '');
        ok++;
      });
    });
    tx();
    res.json({ ok: true, imported: ok, skipped: skip });
  } catch (e) {
    res.status(400).json({ error: '文件解析失败：' + e.message });
  }
});
function normalizeDate(v) {
  if (v == null) return '';
  // Excel 日期单元格（cellDates:true）会以 Date 对象给出
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  const s = String(v).trim();
  if (!s) return '';
  // 支持 '2026-08-14' 或 '2026/8/14'
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + pad(parseInt(m[2])) + '-' + pad(parseInt(m[3]));
  // 支持 Excel 日期序列号（自 1899-12-30 起算的天数）
  const num = Number(s);
  if (/^\d+(\.\d+)?$/.test(s) && !isNaN(num) && num > 20000 && num < 80000) {
    const d = new Date(Math.round((num - 25569) * 86400000));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  // 兜底：常见日期字符串
  const d = new Date(s);
  if (!isNaN(d.getTime()) && s.length >= 8) return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return '';
}

// 隐私脱敏：只显示姓/简称
function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.length <= 1 ? s : s[0] + '**';
}
// 客户自助查单（免登录）：按订单号/面单号，或按「手机号 + 姓氏」查询轨迹
app.get('/api/track', (req, res) => {
  const q = String(req.query.q || '').trim();
  const phone = String(req.query.phone || '').trim();
  const surname = String(req.query.surname || '').trim();
  let r = null;
  if (q) {
    r = db.prepare('SELECT * FROM records WHERE order_no = ? OR tracking_no = ?').get(q, q);
  } else if (phone) {
    if (!surname) return res.status(400).json({ error: '请同时输入姓氏以确认身份' });
    const custs = db.prepare('SELECT * FROM customers WHERE phone = ?').all(phone);
    if (!custs.length) return res.status(404).json({ error: '未查询到该手机号对应的订单' });
    const matched = custs.filter(c => String(c.name || '').startsWith(surname) || String(c.contact || '').startsWith(surname));
    if (!matched.length) return res.status(404).json({ error: '手机号与姓氏不匹配，无法查询' });
    const ids = matched.map(c => c.id);
    r = db.prepare(`SELECT * FROM records WHERE customer_id IN (${ids.map(() => '?').join(',')}) ORDER BY date DESC, id DESC LIMIT 1`).get(...ids);
  } else {
    return res.status(400).json({ error: '请输入订单号、面单号或手机号' });
  }
  if (!r) return res.status(404).json({ error: '未查询到该单' });
  const timeline = db.prepare('SELECT status, note, user_name AS by, created_at AS at FROM record_status_log WHERE record_id = ? ORDER BY rowid ASC').all(r.id);
  res.json({
    orderNo: r.order_no || '', trackingNo: r.tracking_no || '', customer: maskName(r.customer),
    pieces: r.pieces, goods: r.goods || '', status: r.status || '待取', timeline
  });
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
}

module.exports = { mountApiRoutes };

// 统一 API 路由模块：所有 /api 接口统一在这里注册。
// 职责：认证与会话、取件任务、单据/客户/取件员、看板统计、导入导出、
// 通知订阅与投递管理、SSE 实时连接等 HTTP 接口；服务端装配与启动见 server.js。
const { randomUUID } = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');

const { mountNotificationRoutes } = require('../modules/notifications/routes');
const { requireAuth, requireAdmin, requireStaff } = require('./auth-guard');
const { taskVisibleTo, enrichTaskDetail, courierActiveTaskCount, workerStatsWindow } = require('./task-views');
const { createUploader } = require('./uploads');
const { withIdempotency } = require('./idempotency');
const { workerTaskInput } = require('./worker-task-input');
const { workerCustomerOptions } = require('./worker-customer-options');
const { utcText, utcTextToBjText } = require('../time');
const fc = require('../security/field-crypto');
const loginPolicy = require('../security/login-policy');
const { pinyin } = require('pinyin-pro');
const { createAuditLogger } = require('../operations/audit');

// 客户名称匹配：汉字包含 + 拼音（全拼/首字母）
function customerNameMatches(name, query) {
  const text = String(name || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const q = String(query || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (text === '' || q === '') return true;
  if (text.includes(q)) return true;
  if (!/[a-z0-9]/.test(q)) return false;
  return ['pinyin', 'first'].some((pattern) => {
    try { return pinyin(text, { toneType: 'none', pattern: pattern, nonZh: 'consecutive', v: true }).replace(/\s+/g, '').includes(q); } catch { return false; }
  });
}

// v1（Web）展示口径：任务域存储为 UTC 空格文本，输出前统一转为北京时间文本。
// 只转换机器时刻字段；scheduled_time/rush_ship_time 为录入型北京钟面文本，保持原样。
const TASK_UTC_FIELDS = ['createdAt', 'updatedAt', 'dispatchAt', 'completedAt'];
function localizeTimeFields(obj, fields) {
  if (!obj) return obj;
  for (const key of fields) {
    if (obj[key] !== undefined) obj[key] = utcTextToBjText(obj[key]);
  }
  return obj;
}
function localizeTaskForWeb(task) {
  if (!task) return task;
  localizeTimeFields(task, TASK_UTC_FIELDS);
  for (const item of task.items || []) localizeTimeFields(item, ['createdAt', 'updatedAt']);
  for (const photo of task.photos || []) localizeTimeFields(photo, ['createdAt']);
  for (const exception of task.exceptions || []) localizeTimeFields(exception, ['createdAt', 'resolvedAt']);
  return task;
}
function localizeExceptionForWeb(exception) {
  return localizeTimeFields(exception, ['createdAt', 'resolvedAt']);
}

// 时间范围（今天/本周/本月）转 UTC 起止文本（北京时间口径，用于 SQL 过滤）
function timeRangeBounds(range) {
  if (!range || range === 'all') return null;
  const bj = new Date(Date.now() + 8 * 3600 * 1000); // 当前北京时间
  let startBj;
  let endBj;
  if (range === 'today') {
    startBj = new Date(bj.getFullYear(), bj.getMonth(), bj.getDate());
    endBj = new Date(startBj.getTime() + 86400000);
  } else if (range === 'week') {
    const daysSinceMonday = (bj.getDay() + 6) % 7;
    startBj = new Date(bj.getFullYear(), bj.getMonth(), bj.getDate() - daysSinceMonday);
    endBj = new Date(startBj.getTime() + 7 * 86400000);
  } else if (range === 'month') {
    startBj = new Date(bj.getFullYear(), bj.getMonth(), 1);
    endBj = new Date(bj.getFullYear(), bj.getMonth() + 1, 1);
  } else {
    return null;
  }
  const toUtc = (d) => new Date(d.getTime() - 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return { start: toUtc(startBj), end: toUtc(endBj) };
}

function mountApiRoutes(app, deps) {
  const {
    db, auth, tasks, businessNotificationPublisher, notificationService, notificationRepository,
    subscriptionStore, preferenceStore, providerConfigStore, providerRegistry,
    sseTickets, sseClients, broadcast, uploadsDir, machineApiKey: MACHINE_API_KEY
  } = deps;

  const { upload, imageUpload } = createUploader(uploadsDir);

  // 过机/导入的最终重量统一落入 waybill_weights，供任务明细按票号自动匹配；
  // 历史数据（仅存在于 records 表）在匹配时兜底回填。
  const upsertWaybillWeight = db.prepare(`INSERT INTO waybill_weights
    (waybill_no, customer_id, final_weight, ship_date, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(waybill_no) DO UPDATE SET customer_id=excluded.customer_id,
    final_weight=excluded.final_weight, ship_date=excluded.ship_date, updated_at=excluded.updated_at`);
  const findWaybillWeight = (waybillNo) => {
    const row = db.prepare('SELECT * FROM waybill_weights WHERE waybill_no=?').get(waybillNo);
    if (row) return { finalWeight: num(row.final_weight), matched: true };
    const legacy = db.prepare(`SELECT customer_id, weight AS final_weight, date AS ship_date
      FROM records WHERE tracking_no=? AND weight>0 ORDER BY date DESC LIMIT 1`).get(waybillNo);
    if (legacy) {
      upsertWaybillWeight.run(waybillNo, legacy.customer_id || '', num(legacy.final_weight), legacy.ship_date || '', nowStr());
      return { finalWeight: num(legacy.final_weight), matched: true };
    }
    return { finalWeight: 0, matched: false };
  };


// ---------- 工具 ----------
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const bjNow = () => new Date(Date.now() + 8 * 3600 * 1000); // 北京时间(UTC+8)
const todayStr = () => { const d = bjNow(); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
// nowStr 只用于北京自洽模块（操作日志/旧 records/基础资料等原样展示的表）；
// 任务域机器时刻一律 utcText()（见 server/time.js）。
const nowStr = () => { const d = bjNow(); return todayStr() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); };
// 操作日志走统一审计模块（与 v2 共用同一张表与北京时间口径）。
const logOperation = createAuditLogger(db, nowStr);
const startOfWeek = () => { const d = bjNow(); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const rowCourier = (c) => ({ id: c.id, name: c.name, region: c.region || '', commissionRate: c.commission_rate || 0 });
const parseImages = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const rowRecord = (r) => ({
  id: r.id, date: r.date, courierId: r.courier_id, customer: fc.decryptField(r.customer), customerId: r.customer_id || '', address: fc.decryptField(r.address || ''),
  pieces: r.pieces, region: r.region || '', note: fc.decryptField(r.note || ''), status: r.status || '待取', orderNo: r.order_no || '',
  goods: r.goods || '', weight: r.weight || 0, volume: r.volume || 0, trackingNo: r.tracking_no || '',
  amountReceivable: r.amount_receivable || 0, amountPayable: r.amount_payable || 0, settled: r.settled || '未结算',
  pickupPhone: fc.decryptField(r.pickup_phone || ''), createdAt: String(r.created_at || '').slice(0, 19),
  appointmentTime: r.appointment_time || '', completedAt: r.completed_at || '', dimensions: r.dimensions || '',
  dispatcherId: r.dispatcher_id || '', dispatcherName: r.dispatcher_name || '',
  goodsImages: parseImages(r.goods_images), pickupImages: parseImages(r.pickup_images)
});
const rowCustomer = (c) => ({
  id: c.id, customerNo: String(c.id || '').slice(0, 8), name: fc.decryptField(c.name),
  contact: fc.decryptField(c.contact || ''), contactName: fc.decryptField(c.contact || ''), phone: fc.decryptField(c.phone || ''), contactPhone: fc.decryptField(c.phone || ''),
  address: fc.decryptField(c.address || ''), note: fc.decryptField(c.note || ''), remark: fc.decryptField(c.note || ''), status: c.status || 'active',
  legacyCustomerId: c.legacy_customer_id || '', importantNote: fc.decryptField(c.important_note || ''), mainCsId: c.main_cs_id || ''
});
const customerOrderStats = (db, ids) => {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT customer_id AS id,
      COUNT(*) AS taskCount,
      SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS openTaskCount,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount
    FROM pickup_tasks WHERE customer_id IN (${ids.map(() => '?').join(',')}) GROUP BY customer_id`).all(...ids);
  return new Map(rows.map(row => [row.id, {
    taskCount: Number(row.taskCount), openTaskCount: Number(row.openTaskCount || 0),
    completedTaskCount: Number(row.completedTaskCount || 0)
  }]));
};
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
  const clientIp = String(req.ip || '').replace('::ffff:', '');
  const blocked = auth.loginBlockedSeconds(username, clientIp);
  if (blocked) {
    return res.status(429).json({ error: `登录失败次数过多，请 ${blocked} 秒后再试`, retryAfterSeconds: blocked });
  }
  const u = auth.verifyLogin(username, password);
  if (!u) {
    const retryAfterSeconds = auth.noteLoginFailure(username, clientIp);
    if (retryAfterSeconds) {
      return res.status(429).json({ error: `登录失败次数过多，请 ${retryAfterSeconds} 秒后再试`, retryAfterSeconds });
    }
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  auth.clearLoginFailures(username, clientIp);
  // 登录时间限制（仅客服/取件员，管理员不受限）
  if (u.role === 'cs' || u.role === 'courier') {
    const check = loginPolicy.checkLoginAllowed(u.role);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }
  }
  const token = auth.createSession(u.id);
  // 单端接收：登录即清理该用户旧的手机推送订阅（鸿蒙/安卓），当前端登录后再上报新 token。
  // 这样在网页端登录后，鸿蒙端就不会再收到推送。
  try {
    subscriptionStore.removeProviderForUser(u.id, 'huawei');
  } catch (e) {
    // 清理失败忽略，不影响登录
  }
  res.json({ token, user: auth.publicUser(u) });
});
app.post('/api/logout', requireAuth, (req, res) => {
  auth.destroySession(req.token);
  // 退出登录后清理该用户的手机推送订阅，避免已退出设备仍收到推送
  try {
    subscriptionStore.removeProviderForUser(req.user.id, 'huawei');
  } catch (e) {
    // 清理失败忽略
  }
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

// ================= 登录时间限制（管理员可编辑） =================
app.get('/api/login-restrictions', requireAuth, requireAdmin, (req, res) => {
  res.json(loginPolicy.listRestrictions());
});
app.put('/api/login-restrictions/:role', requireAuth, requireAdmin, (req, res) => {
  const role = String(req.params.role || '');
  if (role !== 'cs' && role !== 'courier') {
    return res.status(400).json({ error: '仅支持 cs / courier 角色' });
  }
  res.json(loginPolicy.saveRestriction(role, req.body || {}));
});

// ================= 统一取件任务 =================
// 权限/详情富化/删除占用判定收敛到 server/http/task-views.js；此处仅做 v1 时间本地化
function taskDetail(taskId) {
  return localizeTaskForWeb(enrichTaskDetail(db, tasks, taskId));
}

app.get('/api/tasks', requireAuth, (req, res) => {
  const filters = {
    status: String(req.query.status || ''),
    customerId: String(req.query.customerId || ''),
    keyword: String(req.query.keyword || ''),
    workerId: req.user.role === 'courier' ? (req.user.courier_id || '__none__') : String(req.query.workerId || '')
  };
  const bounds = timeRangeBounds(String(req.query.timeRange || ''));
  if (bounds) {
    filters.timeStart = bounds.start;
    filters.timeEnd = bounds.end;
  }
  const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
  const size = Math.min(1000, Math.max(1, parseInt(req.query.size || '50', 10) || 50));
  const total = tasks.countTasks(filters);
  const list = tasks.listTasks(filters, { limit: size, offset: page * size }).map(localizeTaskForWeb);
  res.json({ list, total, page, size });
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = taskDetail(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权查看该任务' });
  res.json(task);
});

app.post('/api/tasks', requireAuth, withIdempotency((req, res) => {
  try {
    if (!['admin', 'cs', 'courier'].includes(req.user.role)) return res.status(403).json({ error: '无权创建取件订单' });
    const input = req.user.role === 'courier'
      ? workerTaskInput(db, req.user, req.body || {}) : { ...(req.body || {}) };
    if (input.customerId) {
      const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(String(input.customerId));
      if (!customer) return res.status(400).json({ error: '客户不存在' });
      input.customerName = input.customerName || fc.decryptField(customer.name);
      input.contact = input.contact || fc.decryptField(customer.contact) || '';
      input.phone = input.phone || fc.decryptField(customer.phone) || '';
      input.mainCsId = input.mainCsId || customer.main_cs_id || '';
    }
    if (input.addressId) {
      const address = db.prepare('SELECT a.*,r.name AS area_name FROM customer_addresses a LEFT JOIN areas r ON r.id=a.area_id WHERE a.id=?').get(String(input.addressId));
      if (!address) return res.status(400).json({ error: '取件地址不存在' });
      input.address = input.address || fc.decryptField(address.address);
      input.contact = input.contact || fc.decryptField(address.contact_name) || '';
      input.phone = input.phone || fc.decryptField(address.contact_phone) || '';
      input.areaName = input.areaName || address.area_name || '';
    }
    input.defaultWorkerId = input.defaultWorkerId || input.workerId || '';
    const task = tasks.createTask(input, { id: req.user.id, name: req.user.name || req.user.username });
    if (req.user.role === 'courier') {
      // 取件员自助建单时，通知该客户的负责客服
      businessNotificationPublisher.taskCreatedForCs(task, { id: req.user.id, name: req.user.name || req.user.username }, task.id);
    }
    logOperation(req.user, '创建取件任务', 'task', task.id, task.taskNo);
    broadcast({ type: 'task.created', taskId: task.id, status: task.status });
    res.status(201).json(localizeTaskForWeb(task));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || '创建任务失败' });
  }
}));

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
    res.json(localizeTaskForWeb(task));
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
  const finalWeight = num(body.finalWeight);
  if (!Number.isFinite(finalWeight) || finalWeight < 0) return res.status(400).json({ error: '货品重量不正确' });
  const itemId = randomUUID();
  const createdAt = utcText(); // 任务域机器时刻统一 UTC
  const waybillNo = String(body.waybillNo || '').trim();
  const itemWorkerId = req.user.courier_id || task.defaultWorkerId || '';
  const itemWorkerSnap = itemWorkerId
    ? (db.prepare('SELECT name FROM couriers WHERE id=?').get(itemWorkerId) || {}).name || '' : '';
  db.prepare(`INSERT INTO pickup_items
    (id,task_id,worker_id,worker_name_snap,entry_method,waybill_no,goods_name,pieces,sort_order,final_weight,weight_source,match_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      itemId, task.id, itemWorkerId, itemWorkerSnap, body.entryMethod || (waybillNo ? 'manual' : 'no_waybill'),
      waybillNo, String(body.goodsName || body.goods || ''), pieces, task.items.length, finalWeight,
      body.weightSource || '', finalWeight ? 'matched' : (waybillNo ? 'pending' : 'no_waybill'), createdAt, createdAt
    );
  db.prepare(`INSERT INTO task_events (id,task_id,event_type,note,actor_id,actor_name,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.id, 'item_added', waybillNo, req.user.id, req.user.name || req.user.username, createdAt);
  broadcast({ type: 'task.updated', taskId: task.id });
  res.status(201).json(taskDetail(task.id));
});

app.put('/api/tasks/:id/items/:itemId', requireAuth, (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
  if (task.status === 'cancelled') return res.status(409).json({ error: '已取消任务不能修改明细' });
  const item = db.prepare('SELECT * FROM pickup_items WHERE id=? AND task_id=?').get(req.params.itemId, task.id);
  if (!item) return res.status(404).json({ error: '货物明细不存在' });
  const body = req.body || {};
  if (typeof body.pieces !== 'number' || !Number.isSafeInteger(body.pieces) || body.pieces <= 0) {
    return res.status(400).json({ error: '件数必须为正整数' });
  }
  const goodsName = body.goodsName === undefined ? item.goods_name : body.goodsName;
  const waybillInput = body.waybillNo === undefined ? item.waybill_no : body.waybillNo;
  if (typeof goodsName !== 'string' || goodsName.length > 200 ||
      typeof waybillInput !== 'string' || waybillInput.length > 128) {
    return res.status(400).json({ error: '品名或面单号格式不正确' });
  }
  const waybillNo = waybillInput.trim();
  const changedWaybill = waybillNo !== item.waybill_no;
  const before = { goodsName: item.goods_name, waybillNo: item.waybill_no, pieces: item.pieces };
  const after = { goodsName: goodsName.trim(), waybillNo, pieces: body.pieces };
  if (JSON.stringify(before) === JSON.stringify(after)) return res.json(taskDetail(task.id));
  const updatedAt = utcText();
  try {
    db.transaction(() => {
      // Keep ownership and financial fields untouched. A different waybill must
      // not inherit the old shipment's matched weight; it will be matched again.
      db.prepare(`UPDATE pickup_items SET goods_name=?,waybill_no=?,pieces=?,entry_method=?,
        final_weight=?,weight_source=?,match_status=?,updated_at=? WHERE id=? AND task_id=?`).run(
        after.goodsName, waybillNo, after.pieces,
        changedWaybill ? (waybillNo ? 'manual' : 'no_waybill') : item.entry_method,
        changedWaybill ? 0 : item.final_weight, changedWaybill ? '' : item.weight_source,
        changedWaybill ? (waybillNo ? 'pending' : 'no_waybill') : item.match_status,
        updatedAt, item.id, task.id
      );
      db.prepare('UPDATE pickup_tasks SET updated_at=? WHERE id=?').run(updatedAt, task.id);
      db.prepare(`INSERT INTO task_events (id,task_id,event_type,note,actor_id,actor_name,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.id, 'item_updated',
        JSON.stringify({ itemId: item.id, before, after }), req.user.id, req.user.name || req.user.username, updatedAt);
    })();
    broadcast({ type: 'task.updated', taskId: task.id, status: task.status });
    res.json(taskDetail(task.id));
  } catch (error) {
    res.status(500).json({ error: '保存货物明细失败' });
  }
});

function transitionAlias(status) {
  return (req, res) => {
    try {
      const task = tasks.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: '取件任务不存在' });
      if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
      const updated = tasks.transitionTask(task.id, status, {
        id: req.user.id, name: req.user.name || req.user.username
      }, String((req.body && req.body.note) || ''));
      broadcast({ type: 'task.updated', taskId: updated.id, status: updated.status });
      res.json(taskDetail(updated.id));
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
    res.json(localizeExceptionForWeb(tasks.resolveException(req.params.id, String((req.body && req.body.resolution) || ''), {
      id: req.user.id, name: req.user.name || req.user.username
    })));
  } catch (error) {
    const status = /不存在/.test(error.message || '') ? 404 : 400;
    res.status(status).json({ error: error.message || '处理异常失败' });
  }
});

app.post('/api/tasks/:id/reassign', requireAuth, requireStaff, (req, res) => {
  const workerId = String((req.body && req.body.workerId) || '');
  if (workerId && !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId)) return res.status(400).json({ error: '取件员不存在' });
  try {
    const updated = tasks.assignTask(req.params.id, workerId, {
      id: req.user.id, name: req.user.name || req.user.username
    });
    broadcast({ type: 'task.updated', taskId: updated.id });
    res.json(taskDetail(updated.id));
  } catch (error) {
    res.status(400).json({ error: error.message || '改派失败' });
  }
});
app.post('/api/tasks/:id/transfer', requireAuth, (req, res) => {
  const workerId = String((req.body && req.body.workerId) || '');
  if (workerId && !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId)) return res.status(400).json({ error: '取件员不存在' });
  const task = tasks.getTask(req.params.id);
  if (!task || !taskVisibleTo(req.user, task)) return res.status(task ? 403 : 404).json({ error: task ? '无权操作该任务' : '取件任务不存在' });
  if (req.user.role !== 'admin' && req.user.role !== 'cs' && task.defaultWorkerId !== req.user.courier_id) {
    return res.status(403).json({ error: '只有主取件员或客服可以转派' });
  }
  try {
    const updated = tasks.assignTask(task.id, workerId, {
      id: req.user.id, name: req.user.name || req.user.username
    });
    broadcast({ type: 'task.updated', taskId: updated.id });
    res.json(taskDetail(updated.id));
  } catch (error) {
    res.status(400).json({ error: error.message || '转派失败' });
  }
});
app.post('/api/tasks/:id/assist', requireAuth, (req, res) => {
  try {
    const task = tasks.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '取件任务不存在' });
    const isPrimary = Boolean(req.user.courier_id && task.defaultWorkerId === req.user.courier_id);
    if (req.user.role !== 'admin' && req.user.role !== 'cs' && !isPrimary) {
      return res.status(403).json({ error: '无权邀请协助' });
    }
    const workerId = String((req.body && req.body.workerId) || '');
    const updated = tasks.assistTask(task.id, workerId, { id: req.user.id, name: req.user.name || req.user.username });
    broadcast({ type: 'task.updated', taskId: task.id });
    res.status(201).json(taskDetail(updated.id));
  } catch (error) {
    res.status(400).json({ error: error.message || '邀请协助失败' });
  }
});

app.put('/api/tasks/:id', requireAuth, requireStaff, (req, res) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  try {
    const updated = tasks.updateTask(task.id, req.body || {}, { id: req.user.id, name: req.user.name || req.user.username });
    logOperation(req.user, '修改取件任务', 'task', task.id);
    broadcast({ type: 'task.updated', taskId: updated.id });
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
    broadcast({ type: 'task.created', taskId: created.id, status: created.status });
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message || '创建任务失败' });
  }
});

app.post('/api/tasks/:id/photos', requireAuth, (req, res, next) => {
  const task = tasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '取件任务不存在' });
  if (!taskVisibleTo(req.user, task)) return res.status(403).json({ error: '无权操作该任务' });
  req.huoquTask = task;
  next();
}, imageUpload.any(), (req, res) => {
  const task = req.huoquTask;
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: '未收到图片文件：请以 multipart/form-data 的图片字段上传' });
  }
  const createdAt = utcText(); // 任务域机器时刻统一 UTC
  const insert = db.prepare('INSERT INTO pickup_photos (id,task_id,photo_type,filename,uploaded_by,created_at) VALUES (?,?,?,?,?,?)');
  for (const file of req.files || []) insert.run(randomUUID(), task.id, 'pickup', file.filename, req.user.id, createdAt);
  logOperation(req.user, '上传取件照片', 'task', task.id, String((req.files || []).length));
  broadcast({ type: 'task.updated', taskId: task.id });
  res.status(201).json(taskDetail(task.id));
});

app.get('/api/sync/match-center', requireAuth, requireStaff, (req, res) => {
  const rows = db.prepare(`SELECT i.*,t.task_no,t.customer_name_snap FROM pickup_items i
    JOIN pickup_tasks t ON t.id=i.task_id WHERE i.match_status IN ('pending','no_waybill') ORDER BY i.created_at DESC`).all();
  res.json(rows.map(row => ({
    id: row.id, taskId: row.task_id, taskNo: row.task_no, customerName: fc.decryptField(row.customer_name_snap),
    waybillNo: row.waybill_no, pieces: row.pieces, entryMethod: row.entry_method, matchStatus: row.match_status
  })));
});

app.post('/api/sync/match/:id', requireAuth, requireStaff, (req, res) => {
  const item = db.prepare('SELECT * FROM pickup_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '货物明细不存在' });
  const waybillNo = String((req.body && req.body.waybillNo) || '').trim();
  if (!waybillNo) return res.status(400).json({ error: '请输入票号' });
  const found = findWaybillWeight(waybillNo);
  db.prepare(`UPDATE pickup_items SET waybill_no=?,entry_method='manual',final_weight=?,weight_source=?,match_status=?,updated_at=? WHERE id=?`)
    .run(waybillNo, found.matched ? found.finalWeight : num(item.final_weight),
      found.matched ? 'waybill_sync' : '', found.matched ? 'matched' : 'pending', utcText(), item.id);
  res.json({ matched: found.matched, finalWeight: found.finalWeight });
});

// 区间口径：start 下界 + 可选 end 上界（仅"昨日"需要，避免把今天的数据算进昨天）。
function dashboardRange(range) {
  if (range === 'today') return { start: todayStr(), end: '' };
  if (range === 'yesterday') {
    const d = bjNow(); d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    return { start: day, end: day };
  }
  if (range === 'week') return { start: startOfWeek(), end: '' };
  if (range === 'month') return { start: todayStr().slice(0, 8) + '01', end: '' };
  return { start: '', end: '' };
}
function dashboardWhere(range, alias = 't') {
  // created_at 为 UTC 文本：先 +8 小时换算为北京日期再按天过滤
  const { start, end } = dashboardRange(range);
  if (!start) return { sql: '', params: [] };
  if (end) {
    return {
      sql: `WHERE date(${alias}.created_at,'+8 hours')>=? AND date(${alias}.created_at,'+8 hours')<=?`,
      params: [start, end]
    };
  }
  return { sql: `WHERE date(${alias}.created_at,'+8 hours')>=?`, params: [start] };
}

app.get('/api/dashboard/board', requireAuth, (req, res) => {
  const where = dashboardWhere(String(req.query.range || 'today'));
  const taskRows = db.prepare(`SELECT * FROM pickup_tasks t ${where.sql}`).all(...where.params);
  const ids = taskRows.map(row => row.id);
  const itemRows = ids.length ? db.prepare(`SELECT * FROM pickup_items WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const completed = taskRows.filter(row => row.status === 'completed');
  res.json({
    shipCustomerCount: new Set(completed.map(row => row.customer_id || fc.decryptField(row.customer_name_snap))).size,
    finalWeight: itemRows.reduce((sum, row) => sum + num(row.final_weight), 0),
    pickupCustomerCount: new Set(completed.map(row => row.customer_id || fc.decryptField(row.customer_name_snap))).size,
    pickupCount: completed.length,
    pieces: itemRows.reduce((sum, row) => sum + Number(row.pieces || 0), 0),
    pendingCount: taskRows.filter(row => row.status === 'pending' || row.status === 'in_progress').length
  });
});

app.get('/api/dashboard/workers', requireAuth, (req, res) => {
  // 聚合 SQL 替代按人逐查（任务数/件数/重量按 default_worker 归组，协助次数按 task_assistants 归组）
  const taskAgg = db.prepare(`SELECT default_worker_id AS cid,
      COUNT(*) AS taskCount,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completedCount,
      SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS activeCount
    FROM pickup_tasks WHERE default_worker_id<>'' GROUP BY default_worker_id`).all();
  // customer_name_snap 已加密：客户数按取件员内存解密去重
  const custByWorker = new Map();
  for (const r of db.prepare(`SELECT default_worker_id AS cid, customer_id, customer_name_snap FROM pickup_tasks WHERE default_worker_id<>''`).all()) {
    if (!custByWorker.has(r.cid)) custByWorker.set(r.cid, new Set());
    custByWorker.get(r.cid).add((r.customer_id || '') + '|' + fc.decryptField(r.customer_name_snap));
  }
  const itemAgg = db.prepare(`SELECT t.default_worker_id AS cid,
      COALESCE(SUM(i.pieces),0) AS pieces, COALESCE(SUM(i.final_weight),0) AS weight
    FROM pickup_items i JOIN pickup_tasks t ON t.id=i.task_id
    WHERE t.default_worker_id<>'' GROUP BY t.default_worker_id`).all();
  const assistAgg = db.prepare(`SELECT a.worker_id AS cid, COUNT(DISTINCT t.id) AS n
    FROM task_assistants a JOIN pickup_tasks t ON t.id=a.task_id
    WHERE t.status='completed' GROUP BY a.worker_id`).all();
  const taskMap = new Map(taskAgg.map(row => [row.cid, row]));
  const itemMap = new Map(itemAgg.map(row => [row.cid, row]));
  const assistMap = new Map(assistAgg.map(row => [row.cid, row.n]));
  res.json(db.prepare('SELECT * FROM couriers ORDER BY name').all().map(worker => {
    const tasks = taskMap.get(worker.id) || {};
    const items = itemMap.get(worker.id) || {};
    return {
      id: worker.id, name: worker.name,
      pickupCount: Number(tasks.completedCount || 0),
      customerCount: (custByWorker.get(worker.id) || new Set()).size,
      pieces: Number(items.pieces || 0),
      weight: num(items.weight || 0),
      assistCount: assistMap.get(worker.id) || 0,
      pending: Number(tasks.activeCount || 0)
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
  const custRows = db.prepare('SELECT customer_id, customer_name_snap FROM pickup_tasks').all();
  const agg = new Map();
  for (const r of custRows) {
    const name = fc.decryptField(r.customer_name_snap);
    const key = r.customer_id + '|' + name;
    if (!agg.has(key)) agg.set(key, { id: r.customer_id, name, taskCount: 0 });
    agg.get(key).taskCount++;
  }
  res.json([...agg.values()].sort((a, b) => b.taskCount - a.taskCount).slice(0, 20).map(row => ({ ...row, weight: 0 })));
});

app.get('/api/dashboard/trends', requireAuth, (req, res) => {
  const weight = db.prepare(`SELECT date(t.created_at,'+8 hours') AS date,ROUND(COALESCE(SUM(i.final_weight),0),2) AS weight
    FROM pickup_tasks t LEFT JOIN pickup_items i ON i.task_id=t.id GROUP BY date(t.created_at,'+8 hours') ORDER BY date DESC LIMIT 30`).all().reverse();
  res.json({ weight });
});

app.get('/api/dashboard/attention', requireAuth, (req, res) => {
  res.json({
    rushNearDeadline: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE task_type='rush' AND status IN ('pending','in_progress') AND rush_ship_time<>'' AND datetime(rush_ship_time)<=datetime('now','+8 hours','+2 hours')").get().count,
    overdue: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE status='pending' AND datetime(created_at,'+8 hours')<=datetime('now','+8 hours','-2 hours')").get().count,
    unmatchedWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='pending'").get().count,
    noWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='no_waybill'").get().count,
    unresolvedException: db.prepare('SELECT COUNT(*) AS count FROM task_exceptions WHERE resolved=0').get().count,
    syncFailed: 0
  });
});

app.get('/api/dashboard/me', requireAuth, (req, res) => {
  const courierId = req.user.courier_id || '__none__';
  const list = tasks.listTasks({ workerId: courierId });
  const today = todayStr();
  const monthStart = today.slice(0, 8) + '01';
  const assistCount = courierId === '__none__' ? 0 : db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM pickup_tasks t
    JOIN task_assistants a ON a.task_id=t.id WHERE a.worker_id=? AND t.status='completed'`).get(courierId).n;
  res.json({
    pending: list.filter(t => t.status === 'pending').length,
    inProgress: list.filter(t => t.status === 'in_progress').length,
    completed: list.filter(t => t.status === 'completed').length,
    pieces: list.flatMap(t => t.items).reduce((s, i) => s + Number(i.pieces || 0), 0),
    assistCount,
    today: workerStatsWindow(db, courierId, today, today),
    month: workerStatsWindow(db, courierId, monthStart, today)
  });
});
app.get('/api/worker/tasks', requireAuth, (req, res) => res.json(tasks.listTasks({ workerId: req.user.courier_id || '__none__', status: String(req.query.status || '') }).map(localizeTaskForWeb)));

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

// ================= 设备注册（旧 /api/push/* 兼容层已下线，保留 410 指引） =================
const REGISTER_GONE = { error: '该接口已下线，请改用 POST /api/v1/notification-subscriptions（channel=vendor_push/providerCode=huawei）或 POST /api/v2/push/devices' };
const UNREGISTER_GONE = { error: '该接口已下线，请改用 DELETE /api/v1/notification-subscriptions/:id 或 DELETE /api/v2/push/devices/:id' };
app.post('/api/push/register', requireAuth, (req, res) => res.status(410).json(REGISTER_GONE));
app.post('/api/push/unregister', requireAuth, (req, res) => res.status(410).json(UNREGISTER_GONE));

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

// 旧 SSE 兼容入口已下线（URL 携带会话 token 会进日志），统一走票据/请求头通道
app.get('/api/events', (req, res) => {
  res.status(410).json({ error: '该实时通道已下线，请先 POST /api/v1/events/tickets 获取票据，再连接 GET /api/v1/events?ticket=…（或直接在请求头带 Authorization）' });
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
  // 客户主客服引用指向已删账号时清空，避免悬空引用
  db.prepare('UPDATE customers SET main_cs_id=? WHERE main_cs_id=?').run('', u.id);
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
  const rename = name !== cur.name;
  db.prepare('UPDATE couriers SET name = ?, region = ?, commission_rate = ? WHERE id = ?').run(name, region, rate, req.params.id);
  if (rename) {
    // 档案改名：同步历史任务/明细/协助上的姓名快照，保持展示一致
    db.prepare("UPDATE pickup_tasks SET default_worker_name_snap=? WHERE default_worker_id=?").run(name, cur.id);
    db.prepare("UPDATE pickup_items SET worker_name_snap=? WHERE worker_id=?").run(name, cur.id);
    db.prepare("UPDATE task_assistants SET worker_name_snap=? WHERE worker_id=?").run(name, cur.id);
  }
  broadcast({ type: 'couriers.updated' });
  res.json(rowCourier(db.prepare('SELECT * FROM couriers WHERE id = ?').get(req.params.id)));
});

app.delete('/api/couriers/:id', requireAuth, requireAdmin, (req, res) => {
  const cur = db.prepare('SELECT * FROM couriers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '取件员不存在' });
  if (courierActiveTaskCount(db, cur.id) > 0)
    return res.status(400).json({ error: '该取件员有进行中的任务，请先转派或完成后再删除' });
  if (db.prepare('SELECT 1 FROM users WHERE courier_id=?').get(cur.id))
    return res.status(400).json({ error: '该取件员绑定着登录账号，请先删除对应账号' });
  const removal = db.transaction(() => {
    // 档案删除前固化历史任务/明细/协助上的姓名快照，保证历史档案可追溯
    db.prepare("UPDATE pickup_tasks SET default_worker_name_snap=? WHERE default_worker_id=? AND (default_worker_name_snap IS NULL OR default_worker_name_snap='')")
      .run(cur.name, cur.id);
    db.prepare("UPDATE pickup_items SET worker_name_snap=? WHERE worker_id=? AND (worker_name_snap IS NULL OR worker_name_snap='')")
      .run(cur.name, cur.id);
    db.prepare("UPDATE task_assistants SET worker_name_snap=? WHERE worker_id=? AND (worker_name_snap IS NULL OR worker_name_snap='')")
      .run(cur.name, cur.id);
    db.prepare('DELETE FROM area_workers WHERE worker_id=?').run(cur.id);
    db.prepare('DELETE FROM couriers WHERE id=?').run(cur.id);
  });
  removal();
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
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  // 带 page/size 时返回 {list,total,page,size}；不带时保持历史数组直出
  const wantPaged = req.query.page !== undefined || req.query.size !== undefined;
  const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size || '20', 10) || 20));
  const kw = String(keyword || '').trim().toLowerCase();
  const sql = `SELECT r.*, c.name AS cname, cu.name AS customer_name, cu.phone AS customer_phone
    FROM records r
    LEFT JOIN couriers c ON r.courier_id = c.id
    LEFT JOIN customers cu ON r.customer_id = cu.id
    ${where} ORDER BY r.date DESC, r.id DESC`;
  let items = db.prepare(sql).all(params).map(r => Object.assign(rowRecord(r), { customerName: fc.decryptField(r.customer_name || r.customer), customerPhone: fc.decryptField(r.customer_phone || '') }));
  // records.customer 已加密：关键词改内存匹配
  if (kw) {
    items = items.filter(it =>
      (it.customer && it.customer.toLowerCase().includes(kw)) ||
      (it.orderNo && it.orderNo.toLowerCase().includes(kw)) ||
      (it.trackingNo && it.trackingNo.toLowerCase().includes(kw)) ||
      (it.goods && it.goods.toLowerCase().includes(kw)));
  }
  const total = items.length;
  const list = wantPaged ? items.slice(page * size, page * size + size) : items;
  res.json(wantPaged ? { list, total, page, size } : list);
});
app.post('/api/records', requireAuth, withIdempotency((req, res) => {
  const { date, courierId, customer, customerId, pieces, address = '', region = '', note = '', status = '待取', orderNo = '',
          goods = '', weight = 0, volume = 0, trackingNo = '', amountReceivable = 0, amountPayable = 0, settled = '未结算',
          pickupPhone = '', appointmentTime = '' } = req.body || {};
  if (!date) return res.status(400).json({ error: '请选择日期' });
  // 客户：优先用客户档案（customerId），否则用自由文本
  let custId = '', custFinal = '';
  if (customerId) {
    const cu = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (cu) { custId = cu.id; custFinal = fc.decryptField(cu.name); }
  }
  if (!custFinal) custFinal = normalizeCustomer(customer);
  if (!custFinal) return res.status(400).json({ error: '请输入客户名称' });
  // 件数仅取件员必填；派单角色（管理员/客服）取件地址必填
  const p = parseInt(pieces, 10) || 0;
  if (req.user.role === 'courier' && p <= 0) return res.status(400).json({ error: '请输入有效的取件件数' });
  if (p < 0) return res.status(400).json({ error: '件数不能为负数' });
  const weightFinal = num(weight);
  const volumeFinal = num(volume);
  if (!Number.isFinite(weightFinal) || weightFinal < 0) return res.status(400).json({ error: '重量不能为负数' });
  if (!Number.isFinite(volumeFinal) || volumeFinal < 0) return res.status(400).json({ error: '体积不能为负数' });
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
    .run(id, date, cid, fc.encryptField(custFinal), custId, p, fc.encryptField(addressFinal), regionFinal, fc.encryptField(String(note || '')), status, orderFinal,
         String(goods || '').trim(), weightFinal, volumeFinal, trackingFinal, num(amountReceivable), num(amountPayable), settledFinal,
         fc.encryptField(String(pickupPhone || '').trim()), String(appointmentTime || '').trim(), req.user.id, req.user.name || req.user.username);
  // 记录状态轨迹
  db.prepare('INSERT INTO record_status_log (id,record_id,status,note,user_name) VALUES (?,?,?,?,?)')
    .run(randomUUID(), id, status, String(note || ''), req.user.name || req.user.username);
  const created = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id));
  broadcast({ type: 'record.created', record: created, actorId: req.user.id, actor: req.user.name || req.user.username });
  businessNotificationPublisher.recordAssigned(created, {
    id: req.user.id, name: req.user.name || req.user.username
  }, randomUUID());
  res.json(created);
}));
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
  const decRec = { address: fc.decryptField(r.address), note: fc.decryptField(r.note), pickup_phone: fc.decryptField(r.pickup_phone) };
  const address = b.address != null ? String(b.address).trim() : (decRec.address || '');
  const region = b.region != null ? String(b.region).trim() : (r.region || '');
  const goods = b.goods != null ? String(b.goods).trim() : (r.goods || '');
  const note = b.note != null ? String(b.note).trim() : (decRec.note || '');
  const pickupPhone = b.pickupPhone != null ? String(b.pickupPhone).trim() : (decRec.pickup_phone || '');
  const isStaff = req.user.role === 'admin' || req.user.role === 'cs';
  const amountReceivable = (isStaff && b.amountReceivable != null) ? num(b.amountReceivable) : (r.amount_receivable || 0);
  const amountPayable = (isStaff && b.amountPayable != null) ? num(b.amountPayable) : (r.amount_payable || 0);
  db.prepare('UPDATE records SET pieces=?, tracking_no=?, address=?, region=?, goods=?, note=?, pickup_phone=?, amount_receivable=?, amount_payable=? WHERE id=?')
    .run(pieces, trackingNo, fc.encryptField(address), region, goods, fc.encryptField(note), fc.encryptField(pickupPhone), amountReceivable, amountPayable, r.id);
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
  if (r.tracking_no) upsertWaybillWeight.run(r.tracking_no, r.customer_id || '', weight, todayStr(), nowStr());
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

app.get('/api/worker/customer-options', requireAuth, (req, res) => {
  if (req.user.role !== 'courier') return res.status(403).json({ error: '仅取件员可用' });
  res.json(workerCustomerOptions(db, req.user.courier_id, req.query.search));
});

app.get('/api/customers', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const sizeLimit = Math.max(1, Number(req.query.size) || 0);
  const all = db.prepare('SELECT * FROM customers').all();
  let rows = all
    .filter(c => {
      if (!search) return true;
      const name = fc.decryptField(c.name) || '';
      const phone = fc.decryptField(c.phone) || '';
      const legacy = c.legacy_customer_id || '';
      return name.toLowerCase().includes(search) || phone.toLowerCase().includes(search) || legacy.toLowerCase().includes(search)
        || customerNameMatches(name, search);
    })
    .sort((a, b) => (fc.decryptField(a.name) || '').localeCompare(fc.decryptField(b.name) || '', 'zh'));
  if (sizeLimit > 0) rows = rows.slice(0, sizeLimit);
  const stats = customerOrderStats(db, rows.map(row => row.id));
  res.json(rows.map(row => {
    const stat = stats.get(row.id) || { taskCount: 0, openTaskCount: 0, completedTaskCount: 0 };
    return { ...rowCustomer(row), addressCount: db.prepare('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?').get(row.id).n, ...stat };
  }));
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
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, fc.encryptField(n), fc.encryptField(String(contact || '').trim()), fc.encryptField(String(phone || '').trim()), fc.encryptField(String(address || '').trim()),
      fc.encryptField(String(note || '').trim()), String(req.body?.legacyCustomerId || ''), fc.encryptField(String(req.body?.importantNote || '')), 'active');
  if (String(address || '').trim()) db.prepare(`INSERT INTO customer_addresses
    (id,customer_id,name,address,contact_name,contact_phone,is_common,is_active,created_at) VALUES (?,?,?,?,?,?,1,1,?)`)
    .run(randomUUID(), id, '默认地址', fc.encryptField(String(address).trim()), fc.encryptField(String(contact || '').trim()), fc.encryptField(String(phone || '').trim()), nowStr());
  logOperation(req.user, '创建客户', 'customer', id, n);
  broadcast({ type: 'customers.updated' });
  res.json(rowCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)));
});
app.put('/api/customers/:id', requireAuth, requireStaff, (req, res) => {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '客户不存在' });
  const dec = {
    name: fc.decryptField(cur.name), contact: fc.decryptField(cur.contact), phone: fc.decryptField(cur.phone),
    address: fc.decryptField(cur.address), note: fc.decryptField(cur.note), important_note: fc.decryptField(cur.important_note)
  };
  const g = (k) => (req.body && req.body[k] != null) ? String(req.body[k]).trim() : (dec[k] || '');
  const name = normalizeCustomer(g('name'));
  if (!name) return res.status(400).json({ error: '客户名称不能为空' });
  const contact = req.body?.contactName ?? req.body?.contact ?? dec.contact ?? '';
  const phone = req.body?.contactPhone ?? req.body?.phone ?? dec.phone ?? '';
  const note = req.body?.remark ?? req.body?.note ?? dec.note ?? '';
  db.prepare(`UPDATE customers SET name=?,contact=?,phone=?,address=?,note=?,legacy_customer_id=?,important_note=? WHERE id=?`)
    .run(fc.encryptField(name), fc.encryptField(String(contact)), fc.encryptField(String(phone)), fc.encryptField(g('address')), fc.encryptField(String(note)), req.body?.legacyCustomerId ?? cur.legacy_customer_id ?? '',
      fc.encryptField(req.body?.importantNote ?? dec.important_note ?? ''), req.params.id);
  logOperation(req.user, '修改客户', 'customer', req.params.id, name);
  broadcast({ type: 'customers.updated' });
  res.json(rowCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)));
});
app.delete('/api/customers/:id', requireAuth, requireStaff, (req, res) => {
  const cur = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '客户不存在' });
  const active = db.prepare("SELECT COUNT(*) AS n FROM pickup_tasks WHERE customer_id=? AND status IN ('pending','in_progress')")
    .get(cur.id).n;
  if (active > 0) return res.status(400).json({ error: '该客户有进行中的任务，请先完成或取消后再删除' });
  const removal = db.transaction(() => {
    db.prepare('DELETE FROM customer_addresses WHERE customer_id=?').run(cur.id);
    db.prepare('DELETE FROM customers WHERE id=?').run(cur.id);
  });
  removal();
  broadcast({ type: 'customers.updated' });
  res.json({ ok: true });
});

app.get('/api/customers/:id', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT c.*,u.name AS main_cs_name FROM customers c LEFT JOIN users u ON u.id=c.main_cs_id WHERE c.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '客户不存在' });
  const addresses = db.prepare('SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY is_common DESC,created_at,id').all(row.id).map(a => ({
    id: a.id, name: fc.decryptField(a.name), address: fc.decryptField(a.address), contactName: fc.decryptField(a.contact_name), contactPhone: fc.decryptField(a.contact_phone),
    areaId: a.area_id || '', isCommon: Boolean(a.is_common), isActive: Boolean(a.is_active), remark: fc.decryptField(a.remark || '')
  }));
  const stat = customerOrderStats(db, [row.id]).get(row.id) || { taskCount: 0, openTaskCount: 0, completedTaskCount: 0 };
  res.json({ ...rowCustomer(row), mainCsName: row.main_cs_name || '', addresses, ...stat });
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
    VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(id, req.params.id, fc.encryptField(body.name || ''), fc.encryptField(String(body.address).trim()), fc.encryptField(body.contactName || ''), fc.encryptField(body.contactPhone || ''),
      body.areaId || '', body.isCommon ? 1 : 0, fc.encryptField(body.remark || ''), nowStr());
  logOperation(req.user, '新增客户地址', 'customer', req.params.id, id);
  res.status(201).json({ id });
});

app.put('/api/addresses/:id', requireAuth, requireStaff, (req, res) => {
  const body = req.body || {};
  const cur = db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '地址不存在' });
  const dec = { name: fc.decryptField(cur.name), address: fc.decryptField(cur.address), contact_name: fc.decryptField(cur.contact_name), contact_phone: fc.decryptField(cur.contact_phone), remark: fc.decryptField(cur.remark) };
  db.prepare(`UPDATE customer_addresses SET name=?,address=?,contact_name=?,contact_phone=?,area_id=?,is_common=?,remark=? WHERE id=?`).run(
    fc.encryptField(body.name ?? dec.name), fc.encryptField(body.address ?? dec.address), fc.encryptField(body.contactName ?? dec.contact_name), fc.encryptField(body.contactPhone ?? dec.contact_phone),
    body.areaId ?? cur.area_id, body.isCommon == null ? cur.is_common : (body.isCommon ? 1 : 0), fc.encryptField(body.remark ?? dec.remark), cur.id);
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

  // records.customer 已加密：原始行内存解密后统一聚合
  const rawRows = db.prepare(`SELECT r.customer, r.pieces, r.courier_id, r.status, r.dispatcher_id, r.dispatcher_name, r.weight
     FROM records r ${where}`).all(params);
  const dec = rawRows.map(r => ({ ...r, customer: fc.decryptField(r.customer) }));
  const global = {
    pieces: dec.reduce((s, r) => s + Number(r.pieces || 0), 0),
    orders: dec.length,
    customers: new Set(dec.map(r => r.customer)).size,
    couriers: 0
  };
  const totalWeight = dec.reduce((s, r) => s + Number(r.weight || 0), 0);
  const weighedCount = dec.filter(r => Number(r.weight) > 0).length;
  global.totalWeight = Math.round(totalWeight * 100) / 100;
  global.avgWeight = weighedCount ? Math.round((totalWeight / weighedCount) * 100) / 100 : 0;
  global.weighedCount = weighedCount;
  // 「取件员数」口径修正：显示团队总人数（含暂无记录的取件员），避免月初无单时误显示为 0
  const teamCount = db.prepare('SELECT COUNT(*) AS n FROM couriers').get().n;
  global.couriers = (req.user.role === 'admin' || req.user.role === 'cs') ? teamCount : (req.user.courier_id ? 1 : 0);
  const byStatusMap = new Map();
  for (const r of dec) {
    const k = r.status || '待取';
    if (!byStatusMap.has(k)) byStatusMap.set(k, { status: k, orders: 0, pieces: 0 });
    const m = byStatusMap.get(k); m.orders++; m.pieces += Number(r.pieces || 0);
  }
  const byStatus = [...byStatusMap.values()].sort((a, b) => b.orders - a.orders);
  let perCourier;
  if (req.user.role === 'admin' || req.user.role === 'cs') {
    const names = new Map(db.prepare('SELECT id, name, region FROM couriers').all().map(c => [c.id, c]));
    const byC = new Map();
    for (const r of dec) {
      const cid = r.courier_id || '__unassigned__';
      if (!byC.has(cid)) byC.set(cid, { courierId: r.courier_id || '', name: (names.get(r.courier_id) || {}).name || '未分配', region: (names.get(r.courier_id) || {}).region || '', pieces: 0, orders: 0, _cust: new Set() });
      const m = byC.get(cid); m.pieces += Number(r.pieces || 0); m.orders++; m._cust.add(r.customer);
    }
    perCourier = [...byC.values()].map(m => ({ courierId: m.courierId, name: m.name, region: m.region, pieces: m.pieces, orders: m.orders, customers: m._cust.size })).sort((a, b) => b.pieces - a.pieces);
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
    const byD = new Map();
    for (const r of dec) {
      const did = r.dispatcher_id || '__none__';
      if (!byD.has(did)) byD.set(did, { dispatcherId: r.dispatcher_id || '', name: r.dispatcher_name || '', orders: 0, pieces: 0, _cust: new Set() });
      const m = byD.get(did); m.orders++; m.pieces += Number(r.pieces || 0); m._cust.add(r.customer);
      if (!m.name && r.dispatcher_name) m.name = r.dispatcher_name;
    }
    perDispatcher = [...byD.values()].map(m => ({ dispatcherId: m.dispatcherId, name: m.name, orders: m.orders, pieces: m.pieces, customers: m._cust.size })).sort((a, b) => b.orders - a.orders);
  }
  // 客户件数TOP10（取件员看自己的；客服/管理员看全部）
  const topCustMap = new Map();
  for (const r of dec) {
    if (!topCustMap.has(r.customer)) topCustMap.set(r.customer, { name: r.customer, pieces: 0, orders: 0 });
    const m = topCustMap.get(r.customer); m.pieces += Number(r.pieces || 0); m.orders++;
  }
  const topCustomers = [...topCustMap.values()].sort((a, b) => b.pieces - a.pieces).slice(0, 10);
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
  const rawBill = db.prepare(`SELECT r.customer, r.customer_id, cu.name AS customer_name, r.pieces, r.amount_receivable, r.amount_payable, r.settled
     FROM records r LEFT JOIN customers cu ON r.customer_id = cu.id ${where}`).all(params);
  const billMap = new Map();
  for (const r of rawBill) {
    const cid = r.customer_id ? r.customer_id : fc.decryptField(r.customer);
    const name = r.customer_id ? (fc.decryptField(r.customer_name || '') || fc.decryptField(r.customer)) : fc.decryptField(r.customer);
    if (!billMap.has(cid)) billMap.set(cid, { customerId: cid, name, orders: 0, pieces: 0, receivable: 0, payable: 0, unsettled: 0 });
    const m = billMap.get(cid);
    m.orders++; m.pieces += Number(r.pieces || 0); m.receivable += Number(r.amount_receivable || 0); m.payable += Number(r.amount_payable || 0);
    if (r.settled === '未结算') m.unsettled += Number(r.amount_receivable || 0);
  }
  const byCustomer = [...billMap.values()].sort((a, b) => b.receivable - a.receivable);
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

  // records.customer 已加密：按桶内存解密去重
  const rawTrend = db.prepare(`SELECT date, customer, pieces FROM records r WHERE date >= :bs ${extraCond}`)
    .all(Object.assign({ bs: bucketStart }, params));
  const map = {};
  for (const r of rawTrend) {
    const d = String(r.date || '');
    let k;
    if (period === 'daily') k = d.slice(0, 10);
    else if (period === 'weekly') {
      const dt = new Date(d.slice(0, 10) + 'T00:00:00');
      const day = dt.getDay() || 7;
      dt.setDate(dt.getDate() - day + 1);
      k = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
    } else k = d.slice(0, 7);
    if (!map[k]) map[k] = { pieces: 0, cust: new Set() };
    map[k].pieces += Number(r.pieces || 0);
    map[k].cust.add(fc.decryptField(r.customer));
  }
  for (const [k, v] of Object.entries(map)) map[k] = { pieces: v.pieces, customers: v.cust.size };
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
    customers.forEach(c => insCust.run(c.id || randomUUID(), fc.encryptField(c.name || ''), fc.encryptField(c.contact || ''), fc.encryptField(c.phone || ''), fc.encryptField(c.address || ''), fc.encryptField(c.note || '')));
    records.forEach(r => insR.run(r.id || randomUUID(), r.date || '', r.courierId || null, fc.encryptField(r.customer || ''), r.customerId || '', parseInt(r.pieces, 10) || 0, fc.encryptField(r.address || ''), r.region || '', fc.encryptField(r.note || ''), STATUSES.includes(r.status) ? r.status : '待取', r.orderNo || '', r.goods || '', num(r.weight), num(r.volume), r.trackingNo || '', num(r.amountReceivable), num(r.amountPayable), ['未结算', '已结算'].includes(r.settled) ? r.settled : '未结算', r.dispatcherId || '', r.dispatcherName || '', JSON.stringify(r.goodsImages || []), JSON.stringify(r.pickupImages || [])));
    (statusLogs || []).forEach(l => insLog.run(l.id || randomUUID(), l.record_id || '', l.status || '', l.note || '', l.user_name || '', l.created_at || ''));
  });
  tx();
  res.json({ ok: true, couriers: couriers.length, customers: customers.length, records: records.length });
});

// Excel 导出
app.get('/api/export.xlsx', requireAuth, requireStaff, (req, res) => {
  // 敏感列已加密：先取原始行内存解密，统计在 JS 完成
  const rawRows = db.prepare(`SELECT r.date, COALESCE(c.name,'未分配') AS courier_name, r.region,
     r.customer, r.customer_id, cu.phone AS customer_phone, r.address, r.order_no, r.tracking_no, r.goods,
     r.weight, r.volume, r.pieces, r.status, r.amount_receivable, r.amount_payable, r.settled, r.note, cu.name AS customer_name
     FROM records r LEFT JOIN couriers c ON r.courier_id = c.id LEFT JOIN customers cu ON r.customer_id = cu.id
     ORDER BY r.date DESC`).all();
  const records = rawRows.map(r => ({
    日期: r.date, 取件员: r.courier_name, 区域: r.region || '',
    客户名称: fc.decryptField(r.customer), 客户电话: fc.decryptField(r.customer_phone || ''), 取件地址: fc.decryptField(r.address),
    订单号: r.order_no, 面单号: r.tracking_no, 品名: r.goods, '重量kg': r.weight, '体积m3': r.volume,
    件数: r.pieces, 状态: r.status, 应收: r.amount_receivable, 应付: r.amount_payable, 结算: r.settled, 备注: fc.decryptField(r.note)
  }));
  const perCMap = new Map();
  for (const r of rawRows) {
    if (!perCMap.has(r.courier_name)) perCMap.set(r.courier_name, { 取件员: r.courier_name, 总件数: 0, 订单数: 0, _cust: new Set() });
    const m = perCMap.get(r.courier_name);
    m.总件数 += Number(r.pieces || 0); m.订单数 += 1; m._cust.add(fc.decryptField(r.customer));
  }
  const perC = [...perCMap.values()].map(m => ({ 取件员: m.取件员, 总件数: m.总件数, 订单数: m.订单数, 客户数: m._cust.size })).sort((a, b) => b.总件数 - a.总件数);
  const billingMap = new Map();
  for (const r of rawRows) {
    const key = r.customer_id ? r.customer_id : fc.decryptField(r.customer);
    const name = r.customer_id ? (fc.decryptField(r.customer_name || '') || fc.decryptField(r.customer)) : fc.decryptField(r.customer);
    if (!billingMap.has(key)) billingMap.set(key, { 客户: name, 订单数: 0, 应收: 0, 应付: 0, 未结算应收: 0 });
    const m = billingMap.get(key);
    m.订单数 += 1; m.应收 += Number(r.amount_receivable || 0); m.应付 += Number(r.amount_payable || 0);
    if (r.settled === '未结算') m.未结算应收 += Number(r.amount_receivable || 0);
  }
  const billing = [...billingMap.values()].sort((a, b) => b.应收 - a.应收);
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
    const customerByName = new Map(db.prepare('SELECT id, name FROM customers').all().map(c => [fc.decryptField(c.name), c.id]));
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
        let cc = customerByName.get(customer);
        if (cc) custId = cc;
        else { const cid2 = randomUUID(); insCust.run(cid2, fc.encryptField(customer)); customerByName.set(customer, cid2); custId = cid2; }
        insR.run(randomUUID(), dateNorm, cid, fc.encryptField(customer), custId, pieces, fc.encryptField(address), region, fc.encryptField(note), status, orderNo, goods, weight, volume, trackingNo, amountReceivable, amountPayable, settled, '', '');
        if (trackingNo && weight > 0) upsertWaybillWeight.run(trackingNo, custId, weight, dateNorm, nowStr());
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
function trackTaskRecord(q, phone, surname) {
  // 新任务模型优先（业务订单号/任务号/明细面单号），旧 records 兜底，兼顾迁移后的老单。
  if (q) {
    const task = db.prepare(`SELECT DISTINCT t.* FROM pickup_tasks t
      LEFT JOIN pickup_items i ON i.task_id = t.id
      WHERE t.business_order_no = ? OR t.task_no = ? OR i.waybill_no = ?
      ORDER BY t.created_at DESC LIMIT 1`).get(q, q, q);
    if (task) return { task };
    const legacy = db.prepare('SELECT * FROM records WHERE order_no = ? OR tracking_no = ?').get(q, q);
    return { legacy };
  }
  if (phone) {
    const allCust = db.prepare('SELECT id,name,contact,phone FROM customers').all();
    const custIds = allCust
      .filter(c => fc.decryptField(c.phone) === phone && (fc.decryptField(c.name).startsWith(surname) || fc.decryptField(c.contact).startsWith(surname)))
      .map(c => c.id);
    const task = custIds.length
      ? db.prepare(`SELECT * FROM pickup_tasks WHERE customer_id IN (${custIds.map(() => '?').join(',')})
          ORDER BY created_at DESC LIMIT 1`).get(...custIds)
      : null;
    if (!task) {
      const bySnap = db.prepare(`SELECT * FROM pickup_tasks WHERE phone_snap <> '' ORDER BY created_at DESC`).all()
        .find(t => fc.decryptField(t.phone_snap) === phone &&
          (fc.decryptField(t.customer_name_snap).startsWith(surname) || fc.decryptField(t.contact_snap).startsWith(surname)));
      if (bySnap) return { task: bySnap };
    } else {
      return { task };
    }
    if (!custIds.length) return {};
    const legacy = db.prepare(`SELECT * FROM records WHERE customer_id IN (${custIds.map(() => '?').join(',')})
      ORDER BY date DESC, id DESC LIMIT 1`).get(...custIds);
    return { legacy };
  }
  return {};
}

app.get('/api/track', (req, res) => {
  const q = String(req.query.q || '').trim();
  const phone = String(req.query.phone || '').trim();
  const surname = String(req.query.surname || '').trim();
  if (!q && !phone) return res.status(400).json({ error: '请输入订单号、面单号或手机号' });
  if (phone && !surname) return res.status(400).json({ error: '请同时输入姓氏以确认身份' });
  const found = trackTaskRecord(q, phone, surname);
  const task = found.task;
  const legacy = found.legacy;
  if (task) {
    const label = { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[task.status] || task.status;
    const totalPieces = db.prepare('SELECT COALESCE(SUM(pieces),0) AS n FROM pickup_items WHERE task_id=?').get(task.id).n;
    const waybills = db.prepare("SELECT waybill_no FROM pickup_items WHERE task_id=? AND waybill_no<>'' ORDER BY sort_order").all(task.id).map(r => r.waybill_no);
    const timeline = db.prepare(`SELECT event_type,note,actor_name AS by,created_at AS at FROM task_events
      WHERE task_id=? ORDER BY created_at,rowid`).all(task.id).map(row => ({
        status: ({ created: '已下单', assigned: '已派单', assist_added: '已邀请协助', status_changed: label, updated: '信息更新', exception_resolved: '异常已处理' })[row.event_type] || row.event_type,
        note: row.note || '', by: row.by || '', at: utcTextToBjText(row.at || '')
      }));
    return res.json({
      taskNo: task.task_no || '',
      orderNo: task.business_order_no || '',
      trackingNo: waybills.join('、'),
      customer: maskName(fc.decryptField(task.customer_name_snap || '')),
      pieces: totalPieces,
      goods: fc.decryptField(task.pickup_note || ''),
      status: label,
      timeline
    });
  }
  if (legacy) {
    const timeline = db.prepare('SELECT status, note, user_name AS by, created_at AS at FROM record_status_log WHERE record_id = ? ORDER BY rowid ASC').all(legacy.id);
    return res.json({
      orderNo: legacy.order_no || '', trackingNo: legacy.tracking_no || '', customer: maskName(fc.decryptField(legacy.customer)),
      pieces: legacy.pieces, goods: legacy.goods || '', status: legacy.status || '待取', timeline
    });
  }
  return res.status(404).json({ error: '未查询到该单' });
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
}

module.exports = { mountApiRoutes };

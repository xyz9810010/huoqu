// 统一 v2 API：面向 Android / HarmonyOS 新客户端的规范接口层。
// 统一约定（v1 老接口不具备、新端请只依赖这些约定）：
//   1. 成功响应一律 { "data": ... }；列表一律 { data: { items, total, page, pageSize } }
//   2. 分页 page 从 1 开始、pageSize 默认 20 上限 100
//   3. 错误响应一律 { error, code? }，并配合恰当的 HTTP 状态码
//   4. 服务端以 UTC 生成的时间输出 ISO8601（带 Z）；北京时区录入的时间同样转 ISO8601 UTC。
//      存储口径见 server/time.js：任务域机器时刻统一 UTC 空格文本（任务/明细/事件/
//      照片/异常/协助），录入型计划时刻（scheduled_time/rush_ship_time）为北京钟面文本。
const { randomUUID } = require('node:crypto');
const { requireAuth, requireAdmin, requireStaff } = require('./auth-guard');
const { withIdempotency } = require('./idempotency');
const { createUploader } = require('./uploads');
const { utcText } = require('../time');
const { taskVisibleTo, enrichTaskDetail, courierActiveTaskCount, workerStatsWindow } = require('./task-views');
const views = require('./views');
const dashViews = require('./dashboard-views');
const { rowCourier, employeeView, customerListView, maskName, locateTrackTarget, findWaybillWeight } = views;
const fc = require('../security/field-crypto');
const loginPolicy = require('../security/login-policy');
const { createEmployeeService } = require('../operations/employees');
const { workerCustomerOptions } = require('./worker-customer-options');

const TIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function toIso(text, utc = true) {
  if (typeof text !== 'string' || !TIME_TEXT.test(text)) return text;
  const [datePart, timePart] = text.split(' ');
  const [y, mo, dd] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, dd, h + (utc ? 0 : -8), mi, s)).toISOString();
}

function isoTask(task, utc = true) {
  if (!task) return task;
  for (const key of ['createdAt', 'updatedAt', 'dispatchAt', 'completedAt']) {
    if (task[key] !== undefined) task[key] = toIso(task[key], utc);
  }
  for (const item of task.items || []) {
    item.createdAt = toIso(item.createdAt, utc);
    item.updatedAt = toIso(item.updatedAt, utc);
  }
  for (const photo of task.photos || []) photo.createdAt = toIso(photo.createdAt, utc);
  for (const exception of task.exceptions || []) {
    exception.createdAt = toIso(exception.createdAt, utc);
    exception.resolvedAt = toIso(exception.resolvedAt, utc);
  }
  return task;
}

function pageOf(query) {
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize || '20', 10) || 20));
  return { page, pageSize };
}

function ok(res, data, status = 200) {
  return res.status(status).json({ data });
}

function fail(res, status, message, code = '') {
  return res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

// v2 详情视图复用共享富化，并保持原语义输出 ISO8601（外层再次 isoTask 幂等无害）
function taskDetailV2(db, tasks, taskId) {
  return isoTask(enrichTaskDetail(db, tasks, taskId));
}

function customerView(db, row, addressCount) {
  const count = addressCount === undefined
    ? db.prepare('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?').get(row.id).n
    : addressCount;
  return {
    id: row.id, customerNo: String(row.id || '').slice(0, 8), name: fc.decryptField(row.name),
    contact: fc.decryptField(row.contact || ''), phone: fc.decryptField(row.phone || ''),
    address: fc.decryptField(row.address || ''), note: fc.decryptField(row.note || ''), status: row.status || 'active',
    legacyCustomerId: row.legacy_customer_id || '', importantNote: fc.decryptField(row.important_note || ''),
    mainCsId: row.main_cs_id || '', addressCount: count
  };
}

/** 客户地址视图（v2 客户详情与地址接口共用，字段与 v1 一致） */
function addressView(address) {
  return {
    id: address.id, name: fc.decryptField(address.name), address: fc.decryptField(address.address),
    contactName: fc.decryptField(address.contact_name), contactPhone: fc.decryptField(address.contact_phone),
    areaId: address.area_id || '', isCommon: Boolean(address.is_common),
    isActive: Boolean(address.is_active), remark: fc.decryptField(address.remark || '')
  };
}

function mountApiV2Routes(app, deps) {
  const {
    db, auth, tasks, notificationService, notificationRepository,
    subscriptionStore, preferenceStore, providerConfigStore, providerRegistry, uploadsDir,
    businessNotificationPublisher
  } = deps;
  const { imageUpload } = createUploader(uploadsDir);
  const broadcast = deps.broadcast || (() => {});
  const audit = deps.audit || (() => {});
  const employees = createEmployeeService(db, auth, () => nowStr());

  // ---------- 工具（与 v1 语义一致） ----------
  const pad = n => (n < 10 ? '0' + n : String(n));
  const bjNow = () => new Date(Date.now() + 8 * 3600 * 1000);
  const todayStr = () => {
    const d = bjNow();
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  };
  const nowStr = () => {
    const d = bjNow();
    return `${todayStr()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const startOfWeek = () => {
    const d = bjNow();
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  };
  /**
   * 区间口径：start 为下界，end 为可选上界（仅"昨日"需要）。
   *
   * 真机验收发现：原先只取下界，导致"昨日"把今天创建的任务也算进去。
   * now 与 end 都按北京日期计算（与存储的 +8 小时换算保持一致）。
   */
  const dashboardRange = range => {
    if (range === 'yesterday') {
      const d = bjNow();
      d.setUTCDate(d.getUTCDate() - 1);
      const day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
      return { start: day, end: day };
    }
    if (range === 'today') return { start: todayStr(), end: '' };
    if (range === 'week') return { start: startOfWeek(), end: '' };
    if (range === 'month') return { start: `${todayStr().slice(0, 8)}01`, end: '' };
    return { start: '', end: '' };
  };
  const dashboardWhere = (range, alias = 't') => {
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
  };
  const num = v => {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };
  const recordScope = user => {
    if (user.role === 'admin' || user.role === 'cs') return { cond: '', params: {} };
    return { cond: 'r.courier_id = :myCid', params: { myCid: user.courier_id || '__none__' } };
  };
  const rowRecord = r => ({
    id: r.id, date: r.date, courierId: r.courier_id, customer: fc.decryptField(r.customer), customerId: r.customer_id || '',
    address: fc.decryptField(r.address || ''), pieces: r.pieces, region: r.region || '', note: fc.decryptField(r.note || ''),
    status: r.status || '待取', orderNo: r.order_no || '', goods: r.goods || '', weight: r.weight || 0,
    volume: r.volume || 0, trackingNo: r.tracking_no || '', amountReceivable: r.amount_receivable || 0,
    amountPayable: r.amount_payable || 0, settled: r.settled || '未结算', pickupPhone: fc.decryptField(r.pickup_phone || ''),
    createdAt: toIso(String(r.created_at || '').slice(0, 19), false),
    appointmentTime: toIso(r.appointment_time || '', false), completedAt: toIso(r.completed_at || '', false),
    dimensions: r.dimensions || '', dispatcherId: r.dispatcher_id || '', dispatcherName: r.dispatcher_name || ''
  });
  const areaView = row => {
    const assigned = db.prepare(`SELECT aw.worker_id AS userId,c.name,aw.worker_role AS role FROM area_workers aw
      LEFT JOIN couriers c ON c.id=aw.worker_id WHERE aw.area_id=? ORDER BY c.name`).all(row.id);
    const defaults = assigned.filter(item => item.role === 'default');
    const backups = assigned.filter(item => item.role === 'backup');
    return {
      id: row.id, name: row.name, code: row.code || '', defaultWorkerId: (defaults[0] || {}).userId || '',
      defaultWorkerName: (defaults[0] || {}).name || '', defaultWorkers: defaults, backupWorkers: backups
    };
  };
  const listSlice = (rows, page, pageSize) => ({
    items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize
  });

  function requireTaskAccess(req, res) {
    const task = tasks.getTask(req.params.id);
    if (!task) return fail(res, 404, '取件任务不存在');
    if (!taskVisibleTo(req.user, task)) return fail(res, 403, '无权操作该任务');
    return task;
  }

  // ============ 认证 ============
  app.post('/api/v2/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const clientIp = String(req.ip || '').replace('::ffff:', '');
    const blocked = auth.loginBlockedSeconds(username, clientIp);
    if (blocked) return fail(res, 429, `登录失败次数过多，请 ${blocked} 秒后再试`, 'LOGIN_THROTTLED');
    const userRow = auth.verifyLogin(username, password);
    if (!userRow) {
      const retryAfterSeconds = auth.noteLoginFailure(username, clientIp);
      if (retryAfterSeconds) return fail(res, 429, `登录失败次数过多，请 ${retryAfterSeconds} 秒后再试`, 'LOGIN_THROTTLED');
      return fail(res, 401, '用户名或密码错误');
    }
    auth.clearLoginFailures(username, clientIp);
    if (userRow.status === 'disabled') {
      return fail(res, 401, '账号已停用，请联系管理员', 'ACCOUNT_DISABLED');
    }
    if (userRow.role === 'cs' || userRow.role === 'courier') {
      const check = loginPolicy.checkLoginAllowed(userRow.role);
      if (!check.allowed) return fail(res, 403, check.reason, 'LOGIN_TIME_FORBIDDEN');
    }
    const token = auth.createSession(userRow.id);
    ok(res, { token, user: auth.publicUser(userRow) });
  });

  app.get('/api/v2/me', requireAuth, (req, res) => ok(res, { user: auth.publicUser(req.user) }));
  app.post('/api/v2/logout', requireAuth, (req, res) => {
    auth.destroySession(req.token);
    ok(res, { ok: true });
  });
  app.post('/api/v2/password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return fail(res, 400, '新密码至少6位');
    const userRow = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (auth.hashPassword(oldPassword || '', userRow.salt) !== userRow.password_hash) {
      return fail(res, 400, '原密码不正确');
    }
    const salt = auth.createSalt();
    db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?')
      .run(auth.hashPassword(newPassword, salt), salt, userRow.id);
    ok(res, { ok: true });
  });

  // ============ 任务 ============
  app.get('/api/v2/tasks', requireAuth, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const filters = {
      status: String(req.query.status || ''),
      customerId: String(req.query.customerId || ''),
      keyword: String(req.query.keyword || ''),
      workerId: req.user.role === 'courier' ? (req.user.courier_id || '__none__') : String(req.query.workerId || '')
    };
    const total = tasks.countTasks(filters);
    const items = tasks.listTasks(filters, { limit: pageSize, offset: (page - 1) * pageSize })
      .map(task => isoTask(task));
    ok(res, { items, total, page, pageSize });
  });

  app.get('/api/v2/tasks/:id', requireAuth, (req, res) => {
    const task = taskDetailV2(db, tasks, req.params.id);
    if (!task) return fail(res, 404, '取件任务不存在');
    if (!taskVisibleTo(req.user, task)) return fail(res, 403, '无权查看该任务');
    ok(res, { task });
  });

  app.post('/api/v2/tasks', requireAuth, requireStaff, withIdempotency((req, res) => {
    try {
      const input = { ...(req.body || {}) };
      if (input.customerId) {
        const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(String(input.customerId));
        if (!customer) return fail(res, 400, '客户不存在');
        input.customerName = input.customerName || fc.decryptField(customer.name);
        input.contact = input.contact || fc.decryptField(customer.contact) || '';
        input.phone = input.phone || fc.decryptField(customer.phone) || '';
        input.mainCsId = input.mainCsId || customer.main_cs_id || '';
      }
      if (input.addressId) {
        const address = db.prepare('SELECT a.*,r.name AS area_name FROM customer_addresses a LEFT JOIN areas r ON r.id=a.area_id WHERE a.id=?')
          .get(String(input.addressId));
        if (!address) return fail(res, 400, '取件地址不存在');
        input.address = input.address || fc.decryptField(address.address);
        input.contact = input.contact || fc.decryptField(address.contact_name) || '';
        input.phone = input.phone || fc.decryptField(address.contact_phone) || '';
        input.areaName = input.areaName || address.area_name || '';
      }
      input.defaultWorkerId = input.defaultWorkerId || input.workerId || '';
      const task = isoTask(tasks.createTask(input, { id: req.user.id, name: req.user.name || req.user.username }), true);
      ok(res, { task }, 201);
    } catch (error) {
      fail(res, 400, error.message || '创建任务失败');
    }
  }));

  app.put('/api/v2/tasks/:id', requireAuth, requireStaff, (req, res) => {
    const task = tasks.getTask(req.params.id);
    if (!task) return fail(res, 404, '取件任务不存在');
    try {
      const updated = tasks.updateTask(task.id, req.body || {}, { id: req.user.id, name: req.user.name || req.user.username });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, updated.id)) });
    } catch (error) {
      fail(res, 400, error.message || '修改取件任务失败');
    }
  });

  function transitionV2(status) {
    return (req, res) => {
      const task = requireTaskAccess(req, res);
      if (!task) return;
      try {
        const updated = tasks.transitionTask(task.id, status, {
          id: req.user.id, name: req.user.name || req.user.username
        }, String((req.body && req.body.note) || ''));
        broadcast({ type: 'task.updated', taskId: updated.id });
        ok(res, { task: isoTask(taskDetailV2(db, tasks, updated.id)) });
      } catch (error) {
        fail(res, 400, error.message || '更新任务失败');
      }
    };
  }
  app.post('/api/v2/tasks/:id/start', requireAuth, transitionV2('in_progress'));
  app.post('/api/v2/tasks/:id/complete', requireAuth, transitionV2('completed'));
  app.post('/api/v2/tasks/:id/cancel', requireAuth, transitionV2('cancelled'));

  app.post('/api/v2/tasks/:id/assist', requireAuth, (req, res) => {
    try {
      const task = tasks.getTask(req.params.id);
      if (!task) return fail(res, 404, '取件任务不存在');
      const isPrimary = Boolean(req.user.courier_id && task.defaultWorkerId === req.user.courier_id);
      if (req.user.role !== 'admin' && req.user.role !== 'cs' && !isPrimary) {
        return fail(res, 403, '无权邀请协助');
      }
      const workerId = String((req.body && req.body.workerId) || '');
      const updated = tasks.assistTask(task.id, workerId, { id: req.user.id, name: req.user.name || req.user.username });
      broadcast({ type: 'task.updated', taskId: updated.id });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, updated.id)) }, 201);
    } catch (error) {
      fail(res, 400, error.message || '邀请协助失败');
    }
  });

  app.post('/api/v2/tasks/:id/transfer', requireAuth, (req, res) => {
    const task = requireTaskAccess(req, res);
    if (!task) return;
    const workerId = String((req.body && req.body.workerId) || '');
    if (workerId && !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId)) {
      return fail(res, 400, '取件员不存在');
    }
    if (req.user.role !== 'admin' && req.user.role !== 'cs' && task.defaultWorkerId !== req.user.courier_id) {
      return fail(res, 403, '只有主取件员或客服可以转派');
    }
    try {
      const updated = tasks.assignTask(task.id, workerId, { id: req.user.id, name: req.user.name || req.user.username });
      broadcast({ type: 'task.updated', taskId: updated.id });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, updated.id)) });
    } catch (error) {
      fail(res, 400, error.message || '转派失败');
    }
  });

  app.post('/api/v2/tasks/:id/reassign', requireAuth, requireStaff, (req, res) => {
    const task = tasks.getTask(req.params.id);
    if (!task) return fail(res, 404, '取件任务不存在');
    const workerId = String((req.body && req.body.workerId) || '');
    if (workerId && !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId)) {
      return fail(res, 400, '取件员不存在');
    }
    try {
      const updated = tasks.assignTask(task.id, workerId, { id: req.user.id, name: req.user.name || req.user.username });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, updated.id)) });
    } catch (error) {
      fail(res, 400, error.message || '改派失败');
    }
  });

  app.post('/api/v2/tasks/:id/again', requireAuth, requireStaff, (req, res) => {
    const source = tasks.getTask(req.params.id);
    if (!source) return fail(res, 404, '取件任务不存在');
    try {
      const created = tasks.createTask({
        customerId: source.customerId, customerName: source.customerName, address: source.address,
        contact: source.contact, phone: source.phone, areaName: source.areaName, mainCsId: source.mainCsId,
        defaultWorkerId: source.defaultWorkerId, taskType: source.taskType, pickupNote: source.pickupNote,
        internalNote: source.internalNote,
        items: source.items.map(item => ({ goodsName: item.goodsName, pieces: item.pieces }))
      }, { id: req.user.id, name: req.user.name || req.user.username });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, created.id)) }, 201);
    } catch (error) {
      fail(res, 400, error.message || '创建任务失败');
    }
  });

  app.post('/api/v2/tasks/:id/items', requireAuth, (req, res) => {
    const task = requireTaskAccess(req, res);
    if (!task) return;
    const body = req.body || {};
    const waybillNo = String(body.waybillNo || '').trim();
    const pieces = Math.max(1, Number.parseInt(body.pieces || '1', 10) || 1);
    const itemId = randomUUID();
    const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entryMethod = body.entryMethod || (waybillNo ? 'manual' : 'no_waybill');
    const finalWeight = Number(body.finalWeight) || 0;
    if (!Number.isFinite(finalWeight) || finalWeight < 0) return fail(res, 400, '货品重量不正确');
    const matchStatus = finalWeight ? 'matched' : (waybillNo ? 'pending' : 'no_waybill');
    const itemWorkerId = req.user.courier_id || task.defaultWorkerId || '';
    const itemWorkerSnap = itemWorkerId
      ? (db.prepare('SELECT name FROM couriers WHERE id=?').get(itemWorkerId) || {}).name || '' : '';
    db.prepare(`INSERT INTO pickup_items
      (id,task_id,worker_id,worker_name_snap,entry_method,waybill_no,goods_name,pieces,sort_order,final_weight,weight_source,match_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        itemId, task.id, itemWorkerId, itemWorkerSnap, entryMethod,
        waybillNo, String(body.goodsName || body.goods || ''), pieces, task.items.length, finalWeight,
        body.weightSource || '', matchStatus, createdAt, createdAt
      );
    db.prepare(`INSERT INTO task_events (id,task_id,event_type,note,actor_id,actor_name,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.id, 'item_added', waybillNo,
      req.user.id, req.user.name || req.user.username, createdAt);
    broadcast({ type: 'task.updated', taskId: task.id });
    ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) }, 201);
  });

  app.post('/api/v2/tasks/:id/photos', requireAuth, (req, res, next) => {
    const task = requireTaskAccess(req, res);
    if (!task) return; // 404/403 已响应：multer 不执行，避免落盘孤儿文件
    req.huoquTask = task;
    next();
  }, imageUpload.any(), (req, res) => {
    const task = req.huoquTask;
    if (!req.files || !req.files.length) {
      return fail(res, 400, '未收到图片文件：请以 multipart/form-data 的图片字段上传');
    }
    const createdAt = utcText();
    const insert = db.prepare('INSERT INTO pickup_photos (id,task_id,photo_type,filename,uploaded_by,created_at) VALUES (?,?,?,?,?,?)');
    for (const file of req.files || []) insert.run(randomUUID(), task.id, 'pickup', file.filename, req.user.id, createdAt);
    broadcast({ type: 'task.updated', taskId: task.id });
    ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) }, 201);
  });

  app.post('/api/v2/tasks/:id/exceptions', requireAuth, (req, res) => {
    const task = requireTaskAccess(req, res);
    if (!task) return;
    try {
      tasks.reportException(task.id, req.body || {}, { id: req.user.id, name: req.user.name || req.user.username });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) }, 201);
    } catch (error) {
      fail(res, 400, error.message || '上报异常失败');
    }
  });

  app.post('/api/v2/exceptions/:id/resolve', requireAuth, requireStaff, (req, res) => {
    try {
      const exception = tasks.resolveException(req.params.id, String((req.body && req.body.resolution) || ''), {
        id: req.user.id, name: req.user.name || req.user.username
      });
      if (exception) {
        exception.createdAt = toIso(exception.createdAt, true);
        exception.resolvedAt = toIso(exception.resolvedAt, true);
      }
      ok(res, { exception });
    } catch (error) {
      fail(res, /不存在/.test(error.message || '') ? 404 : 400, error.message || '处理异常失败');
    }
  });

  // ---- 取件员端：我的任务（等价 v1 GET /api/worker/tasks）----
  // 取件员强制只看自己；其它角色给空列表（与 v1 的 '__none__' 语义一致，不报错）
  app.get('/api/v2/worker/tasks', requireAuth, (req, res) => {
    const list = tasks.listTasks({
      workerId: req.user.courier_id || '__none__',
      status: String(req.query.status || '')
    }).map(task => isoTask(task));
    ok(res, { items: list, total: list.length });
  });

  // ---- 取件员端：可选客户（用于移动端新建单据时的客户下拉）----
  app.get('/api/v2/worker/customer-options', requireAuth, (req, res) => {
    if (req.user.role !== 'courier') return fail(res, 403, '仅取件员可用');
    ok(res, { items: workerCustomerOptions(db, req.user.courier_id, req.query.search) });
  });

  // ---- 取件员下拉（id/userId/name/region）：等价 v1 GET /api/employees/workers ----
  app.get('/api/v2/employees/workers', requireAuth, (req, res) => {
    const items = db.prepare('SELECT * FROM couriers ORDER BY name').all()
      .map(c => ({ id: c.id, userId: c.id, name: c.name, region: c.region || '' }));
    ok(res, { items });
  });

  // ============ 客户（只读检索对取件员开放，编辑仅客服/管理员） ============
  app.get('/api/v2/customers', requireAuth, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const search = String(req.query.search || '').trim().toLowerCase();
    const all = db.prepare('SELECT * FROM customers').all();
    const filtered = all.filter(c => {
      if (!search) return true;
      const name = fc.decryptField(c.name) || '';
      const phone = fc.decryptField(c.phone) || '';
      const legacy = c.legacy_customer_id || '';
      return name.toLowerCase().includes(search) || phone.toLowerCase().includes(search) || legacy.toLowerCase().includes(search);
    }).sort((a, b) => (fc.decryptField(a.name) || '').localeCompare(fc.decryptField(b.name) || '', 'zh'));
    const total = filtered.length;
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
    const countMap = new Map(rows.length
      ? db.prepare(`SELECT customer_id,COUNT(*) AS n FROM customer_addresses
        WHERE customer_id IN (${rows.map(() => '?').join(',')}) GROUP BY customer_id`).all(...rows.map(row => row.id))
        .map(count => [count.customer_id, count.n])
      : []);
    // 主客服姓名：一次 JOIN 批量取，避免逐行查询
    const nameMap = new Map(rows.length
      ? db.prepare(`SELECT c.id,u.name AS cs FROM customers c LEFT JOIN users u ON u.id=c.main_cs_id
        WHERE c.id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(row => row.id))
        .map(r => [r.id, r.cs || ''])
      : []);
    // 与 v1 字段完全对齐（含 taskCount/openTaskCount/completedTaskCount、contactName 别名与 mainCsName）
    const items = customerListView(db, rows, countMap, nameMap);
    ok(res, { items, total, page, pageSize });
  });

  app.get('/api/v2/customers/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT c.*,u.name AS main_cs_name FROM customers c LEFT JOIN users u ON u.id=c.main_cs_id WHERE c.id=?')
      .get(req.params.id);
    if (!row) return fail(res, 404, '客户不存在');
    const addresses = db.prepare('SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY is_common DESC,created_at,id')
      .all(row.id).map(addressView);
    ok(res, { customer: { ...customerView(db, row), mainCsName: row.main_cs_name || '', addresses } });
  });

  app.post('/api/v2/customers', requireAuth, requireStaff, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return fail(res, 400, '请输入客户名称');
    const id = randomUUID();
    db.prepare(`INSERT INTO customers (id,name,contact,phone,address,note,legacy_customer_id,important_note,status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, fc.encryptField(name), fc.encryptField(String(body.contact || body.contactName || '').trim()),
      fc.encryptField(String(body.phone || body.contactPhone || '').trim()), fc.encryptField(String(body.address || '').trim()),
      fc.encryptField(String(body.note || body.remark || '').trim()), String(body.legacyCustomerId || ''),
      fc.encryptField(String(body.importantNote || '')), 'active');
    if (String(body.address || '').trim()) {
      db.prepare(`INSERT INTO customer_addresses (id,customer_id,name,address,contact_name,contact_phone,is_common,is_active,created_at)
        VALUES (?,?,?,?,?,?,1,1,?)`).run(randomUUID(), id, '默认地址', fc.encryptField(String(body.address).trim()),
        fc.encryptField(String(body.contact || body.contactName || '').trim()), fc.encryptField(String(body.phone || body.contactPhone || '').trim()),
        new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19));
    }
    const row = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    ok(res, { customer: customerView(db, row) }, 201);
  });

  app.put('/api/v2/customers/:id', requireAuth, requireStaff, (req, res) => {
    const current = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '客户不存在');
    const body = req.body || {};
    const curDec = { name: fc.decryptField(current.name), contact: fc.decryptField(current.contact), phone: fc.decryptField(current.phone), address: fc.decryptField(current.address), note: fc.decryptField(current.note), important_note: fc.decryptField(current.important_note) };
    const val = (fallback, ...keys) => {
      for (const key of keys) {
        if (body[key] != null) return body[key];
      }
      return fallback;
    };
    const name = String(val(curDec.name || '', 'name')).trim();
    if (!name) return fail(res, 400, '客户名称不能为空');
    const contact = String(val(curDec.contact || '', 'contact', 'contactName')).trim();
    const phone = String(val(curDec.phone || '', 'phone', 'contactPhone')).trim();
    const address = String(val(curDec.address || '', 'address')).trim();
    const note = String(val(curDec.note || '', 'note', 'remark')).trim();
    const importantNote = String(val(curDec.important_note || '', 'importantNote')).trim();
    const mainCsId = String(val(current.main_cs_id || '', 'mainCsId')).trim();
    db.prepare(`UPDATE customers SET name=?,contact=?,phone=?,address=?,note=?,important_note=?,main_cs_id=? WHERE id=?`)
      .run(fc.encryptField(name), fc.encryptField(contact), fc.encryptField(phone), fc.encryptField(address), fc.encryptField(note), fc.encryptField(importantNote), mainCsId, current.id);
    ok(res, { customer: customerView(db, db.prepare('SELECT * FROM customers WHERE id=?').get(current.id)) });
  });

  // ---- 客户停用/启用（等价 v1 PATCH /api/customers/:id/status）----
  app.patch('/api/v2/customers/:id/status', requireAuth, requireStaff, (req, res) => {
    const current = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '客户不存在');
    const raw = (req.body && req.body.status != null) ? req.body.status : req.query.status;
    const status = String(raw || 'active') === 'disabled' ? 'disabled' : 'active';
    db.prepare('UPDATE customers SET status=? WHERE id=?').run(status, current.id);
    audit(req.user, '修改客户状态', 'customer', current.id, status);
    ok(res, { customer: customerView(db, db.prepare('SELECT * FROM customers WHERE id=?').get(current.id)) });
  });

  // ---- 删除客户（等价 v1 DELETE /api/customers/:id；有进行中任务时拒绝）----
  app.delete('/api/v2/customers/:id', requireAuth, requireStaff, (req, res) => {
    const current = db.prepare('SELECT id FROM customers WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '客户不存在');
    const active = db.prepare("SELECT COUNT(*) AS n FROM pickup_tasks WHERE customer_id=? AND status IN ('pending','in_progress')")
      .get(current.id).n;
    if (active > 0) return fail(res, 400, '该客户有进行中的任务，请先完成或取消后再删除');
    db.transaction(() => {
      db.prepare('DELETE FROM customer_addresses WHERE customer_id=?').run(current.id);
      db.prepare('DELETE FROM customers WHERE id=?').run(current.id);
    })();
    broadcast({ type: 'customers.updated' });
    ok(res, { ok: true });
  });

  // ---- 客户地址：新增（等价 v1 POST /api/customers/:id/addresses）----
  app.post('/api/v2/customers/:id/addresses', requireAuth, requireStaff, (req, res) => {
    if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(req.params.id)) return fail(res, 404, '客户不存在');
    const body = req.body || {};
    const address = String(body.address || '').trim();
    if (!address) return fail(res, 400, '地址不能为空');
    const id = randomUUID();
    db.prepare(`INSERT INTO customer_addresses (id,customer_id,name,address,contact_name,contact_phone,area_id,is_common,is_active,remark,created_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(
      id, req.params.id, fc.encryptField(body.name || ''), fc.encryptField(address),
      fc.encryptField(body.contactName || ''), fc.encryptField(body.contactPhone || ''),
      body.areaId || '', body.isCommon ? 1 : 0, fc.encryptField(body.remark || ''), nowStr());
    audit(req.user, '新增客户地址', 'customer', req.params.id, id);
    const row = db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(id);
    ok(res, { address: addressView(row) }, 201);
  });

  // ---- 客户地址：编辑（等价 v1 PUT /api/addresses/:id；省缺字段保持原值）----
  app.put('/api/v2/addresses/:id', requireAuth, requireStaff, (req, res) => {
    const current = db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '地址不存在');
    const body = req.body || {};
    const dec = {
      name: fc.decryptField(current.name), address: fc.decryptField(current.address),
      contact_name: fc.decryptField(current.contact_name), contact_phone: fc.decryptField(current.contact_phone),
      remark: fc.decryptField(current.remark)
    };
    db.prepare(`UPDATE customer_addresses SET name=?,address=?,contact_name=?,contact_phone=?,area_id=?,is_common=?,remark=? WHERE id=?`).run(
      fc.encryptField(body.name != null ? body.name : dec.name),
      fc.encryptField(body.address != null ? body.address : dec.address),
      fc.encryptField(body.contactName != null ? body.contactName : dec.contact_name),
      fc.encryptField(body.contactPhone != null ? body.contactPhone : dec.contact_phone),
      body.areaId != null ? body.areaId : current.area_id,
      body.isCommon == null ? current.is_common : (body.isCommon ? 1 : 0),
      fc.encryptField(body.remark != null ? body.remark : dec.remark), current.id);
    ok(res, { address: addressView(db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(current.id)) });
  });

  // ---- 客户地址：启用/停用（等价 v1 PATCH /api/addresses/:id/status）----
  app.patch('/api/v2/addresses/:id/status', requireAuth, requireStaff, (req, res) => {
    const current = db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '地址不存在');
    const raw = (req.body && req.body.isActive != null) ? req.body.isActive : req.query.isActive;
    const active = String(raw) === 'false' ? 0 : 1;
    db.prepare('UPDATE customer_addresses SET is_active=? WHERE id=?').run(active, current.id);
    ok(res, { address: addressView(db.prepare('SELECT * FROM customer_addresses WHERE id=?').get(current.id)) });
  });

  // ============ 基础资料：取件员 / 区域 ============
  app.get('/api/v2/couriers', requireAuth, requireStaff, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const rows = db.prepare('SELECT * FROM couriers ORDER BY name').all().map(rowCourier);
    ok(res, listSlice(rows, page, pageSize));
  });

  app.post('/api/v2/couriers', requireAuth, requireAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return fail(res, 400, '请输入取件员姓名');
    const id = randomUUID();
    db.prepare('INSERT INTO couriers (id,name,region,commission_rate) VALUES (?,?,?,?)')
      .run(id, name, String((req.body && req.body.region) || '').trim(), num((req.body && req.body.commissionRate) || 0));
    broadcast({ type: 'couriers.updated' });
    ok(res, { courier: rowCourier(db.prepare('SELECT * FROM couriers WHERE id=?').get(id)) }, 201);
  });

  app.put('/api/v2/couriers/:id', requireAuth, requireAdmin, (req, res) => {
    const cur = db.prepare('SELECT * FROM couriers WHERE id=?').get(req.params.id);
    if (!cur) return fail(res, 404, '取件员不存在');
    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : cur.name;
    if (!name) return fail(res, 400, '姓名不能为空');
    const region = body.region != null ? String(body.region).trim() : (cur.region || '');
    const rate = body.commissionRate != null ? num(body.commissionRate) : (cur.commission_rate || 0);
    const rename = name !== cur.name;
    db.prepare('UPDATE couriers SET name=?,region=?,commission_rate=? WHERE id=?').run(name, region, rate, cur.id);
    if (rename) {
      // 档案改名：同步历史任务/明细/协助上的姓名快照，保持展示一致
      db.prepare('UPDATE pickup_tasks SET default_worker_name_snap=? WHERE default_worker_id=?').run(name, cur.id);
      db.prepare('UPDATE pickup_items SET worker_name_snap=? WHERE worker_id=?').run(name, cur.id);
      db.prepare('UPDATE task_assistants SET worker_name_snap=? WHERE worker_id=?').run(name, cur.id);
    }
    broadcast({ type: 'couriers.updated' });
    ok(res, { courier: rowCourier(db.prepare('SELECT * FROM couriers WHERE id=?').get(cur.id)) });
  });

  app.delete('/api/v2/couriers/:id', requireAuth, requireAdmin, (req, res) => {
    const cur = db.prepare('SELECT * FROM couriers WHERE id=?').get(req.params.id);
    if (!cur) return fail(res, 404, '取件员不存在');
    if (courierActiveTaskCount(db, cur.id) > 0) {
      return fail(res, 400, '该取件员有进行中的任务，请先转派或完成后再删除');
    }
    if (db.prepare('SELECT 1 FROM users WHERE courier_id=?').get(cur.id)) {
      return fail(res, 400, '该取件员绑定着登录账号，请先删除对应账号');
    }
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
    ok(res, { ok: true });
  });

  app.get('/api/v2/areas', requireAuth, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const rows = db.prepare('SELECT * FROM areas ORDER BY name').all().map(areaView);
    ok(res, listSlice(rows, page, pageSize));
  });

  // ---- 区域管理（写接口仅管理员；客户地址引用区域时不允许删除） ----
  const areaNameTaken = (name, excludeId = '') =>
    Boolean(db.prepare('SELECT 1 FROM areas WHERE name=? AND id<>?').get(name, excludeId));

  const workerIdsOf = ids => [...new Set(
    (Array.isArray(ids) ? ids : [])
      .filter(value => value != null)
      .map(value => String(value).trim())
      .filter(Boolean)
  )];

  /**
   * 区域人员分配：字段缺省表示"这一项不改动"，显式传空数组表示"清空"。
   * 与 v1 `/api/areas/:id` 的语义保持一致，避免客户端只想改名字却清掉人员。
   */
  const assignedWorkers = body => {
    const payload = body || {};
    const hasDefaults = Object.prototype.hasOwnProperty.call(payload, 'defaultWorkerIds');
    const hasBackups = Object.prototype.hasOwnProperty.call(payload, 'backupWorkerIds');
    const defaultWorkerIds = hasDefaults ? workerIdsOf(payload.defaultWorkerIds) : null;
    const backupWorkerIds = hasBackups ? workerIdsOf(payload.backupWorkerIds) : null;
    const unknown = [...(defaultWorkerIds || []), ...(backupWorkerIds || [])]
      .find(workerId => !db.prepare('SELECT 1 FROM couriers WHERE id=?').get(workerId));
    if (unknown) return { error: fail(res, 400, '指定的取件员不存在') };
    return { defaultWorkerIds, backupWorkerIds };
  };

  const writeAreaWorkers = (areaId, defaultWorkerIds, backupWorkerIds) => {
    db.prepare('DELETE FROM area_workers WHERE area_id=?').run(areaId);
    const insert = db.prepare('INSERT OR IGNORE INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,?)');
    for (const workerId of defaultWorkerIds) insert.run(areaId, workerId, 'default');
    for (const workerId of backupWorkerIds) insert.run(areaId, workerId, 'backup');
  };

  const referencedAddressCount = areaId =>
    db.prepare('SELECT COUNT(*) AS count FROM customer_addresses WHERE area_id=?').get(areaId).count;

  app.post('/api/v2/areas', requireAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return fail(res, 400, '区域名称不能为空');
    if (name.length > 50) return fail(res, 400, '区域名称不能超过 50 个字符');
    if (areaNameTaken(name)) return fail(res, 400, '区域名称已存在');

    const workers = assignedWorkers(body);
    if (workers.error) return workers.error;
    const code = String(body.code || '').trim().slice(0, 50);
    const id = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO areas (id,name,code,created_at) VALUES (?,?,?,?)').run(id, name, code, nowStr());
      writeAreaWorkers(id, workers.defaultWorkerIds || [], workers.backupWorkerIds || []);
    })();
    audit(req.user, '创建区域', 'area', id, name);
    broadcast({ type: 'areas.updated' });
    ok(res, { area: areaView(db.prepare('SELECT * FROM areas WHERE id=?').get(id)) }, 201);
  });

  app.put('/api/v2/areas/:id', requireAuth, requireAdmin, (req, res) => {
    const current = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '区域不存在');
    const body = req.body || {};
    const name = body.name == null ? current.name : String(body.name).trim();
    if (!name) return fail(res, 400, '区域名称不能为空');
    if (name.length > 50) return fail(res, 400, '区域名称不能超过 50 个字符');
    if (areaNameTaken(name, current.id)) return fail(res, 400, '区域名称已存在');

    const workers = assignedWorkers(body);
    if (workers.error) return workers.error;
    const existingWorkers = db.prepare('SELECT worker_id,worker_role FROM area_workers WHERE area_id=?')
      .all(current.id);
    const nextDefaults = workers.defaultWorkerIds
      ?? existingWorkers.filter(row => row.worker_role === 'default').map(row => row.worker_id);
    const nextBackups = workers.backupWorkerIds
      ?? existingWorkers.filter(row => row.worker_role === 'backup').map(row => row.worker_id);
    const code = String(body.code == null ? (current.code || '') : body.code).trim().slice(0, 50);
    db.transaction(() => {
      db.prepare('UPDATE areas SET name=?,code=? WHERE id=?').run(name, code, current.id);
      writeAreaWorkers(current.id, nextDefaults, nextBackups);
    })();
    audit(req.user, '编辑区域', 'area', current.id, name);
    broadcast({ type: 'areas.updated' });
    ok(res, { area: areaView(db.prepare('SELECT * FROM areas WHERE id=?').get(current.id)) });
  });

  app.delete('/api/v2/areas/:id', requireAuth, requireAdmin, (req, res) => {
    const current = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
    if (!current) return fail(res, 404, '区域不存在');
    const addressCount = referencedAddressCount(current.id);
    if (addressCount > 0) {
      return fail(res, 400, `该区域已被 ${addressCount} 个客户地址使用，请先调整地址所属区域`);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM area_workers WHERE area_id=?').run(current.id);
      db.prepare('DELETE FROM areas WHERE id=?').run(current.id);
    })();
    audit(req.user, '删除区域', 'area', current.id, current.name);
    broadcast({ type: 'areas.updated' });
    ok(res, { ok: true });
  });

  // ============ 员工（仅管理员） ============
  app.get('/api/v2/employees', requireAuth, requireAdmin, (req, res) => {
    const role = String(req.query.role || '').trim();
    ok(res, { items: employees.list(role) });
  });

  app.post('/api/v2/employees', requireAuth, requireAdmin, (req, res) => {
    const result = employees.create(req.body || {});
    if (result.error) return fail(res, 400, result.error);
    audit(req.user, '创建员工', 'employee', result.data.id, result.data.username);
    ok(res, { employee: result.data }, 201);
  });

  app.put('/api/v2/employees/:id', requireAuth, requireAdmin, (req, res) => {
    const result = employees.update(req.params.id, req.body || {});
    if (result.error) return fail(res, result.status || 400, result.error);
    audit(req.user, '编辑员工', 'employee', result.data.id, result.data.username);
    ok(res, { employee: result.data });
  });

  app.put('/api/v2/employees/:id/status', requireAuth, requireAdmin, (req, res) => {
    const result = employees.setStatus(req.params.id, (req.body || {}).status, req.user);
    if (result.error) return fail(res, result.status || 400, result.error);
    audit(
      req.user,
      result.data.status === 'disabled' ? '停用员工' : '启用员工',
      'employee',
      result.data.id,
      result.data.username
    );
    ok(res, { employee: result.data });
  });

  // ---- 用户账号（管理员；等价 v1 /api/users 系列）----
  // 与 employees 的区别：这里直接管理登录账号本身（含绑定取件员），角色用存储值 admin/cs/courier。
  app.get('/api/v2/users', requireAuth, requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
    const items = rows.map(u => Object.assign(auth.publicUser(u), {
      courierName: (() => {
        const c = u.courier_id ? db.prepare('SELECT name FROM couriers WHERE id = ?').get(u.courier_id) : null;
        return c ? c.name : '';
      })()
    }));
    ok(res, { items, total: items.length });
  });

  app.post('/api/v2/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role, courierId, name } = req.body || {};
    const uname = String(username || '').trim();
    if (!uname) return fail(res, 400, '请输入用户名');
    if (!password || String(password).length < 6) return fail(res, 400, '密码至少6位');
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) return fail(res, 400, '用户名已存在');
    if (!['admin', 'courier', 'cs'].includes(role)) return fail(res, 400, '角色不正确');
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
      .run(id, uname, auth.hashPassword(password, salt), salt, role,
        role === 'cs' ? null : (courierId || null), finalName);
    audit(req.user, '创建用户', 'user', id, uname);
    ok(res, { user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) }, 201);
  });

  app.delete('/api/v2/users/:id', requireAuth, requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return fail(res, 404, '用户不存在');
    if (u.role === 'admin' && u.username === 'admin') return fail(res, 400, '不能删除内置管理员');
    if (u.role === 'admin' && db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get('admin').n <= 1) {
      return fail(res, 400, '系统至少需要一个管理员');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      // 客户主客服引用指向已删账号时清空，避免悬空引用
      db.prepare('UPDATE customers SET main_cs_id=? WHERE main_cs_id=?').run('', u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    })();
    audit(req.user, '删除用户', 'user', u.id, u.username);
    ok(res, { ok: true });
  });

  app.post('/api/v2/users/:id/reset', requireAuth, requireAdmin, (req, res) => {
    const { password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return fail(res, 404, '用户不存在');
    if (!password || String(password).length < 6) return fail(res, 400, '新密码至少6位');
    const salt = auth.createSalt();
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
      .run(auth.hashPassword(password, salt), salt, u.id);
    audit(req.user, '重置用户密码', 'user', u.id, u.username);
    ok(res, { ok: true });
  });

  // ---- 登录时间限制（管理员；等价 v1 /api/login-restrictions）----
  app.get('/api/v2/login-restrictions', requireAuth, requireAdmin, (req, res) => {
    ok(res, { items: loginPolicy.listRestrictions() });
  });

  app.put('/api/v2/login-restrictions/:role', requireAuth, requireAdmin, (req, res) => {
    const role = String(req.params.role || '');
    if (role !== 'cs' && role !== 'courier') return fail(res, 400, '仅支持 cs / courier 角色');
    ok(res, { restriction: loginPolicy.saveRestriction(role, req.body || {}) });
  });

  // ============ 操作日志（仅管理员） ============
  app.get('/api/v2/logs', requireAuth, requireAdmin, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const conditions = [];
    const params = [];
    const targetType = String(req.query.targetType || '').trim();
    if (targetType) { conditions.push('target_type=?'); params.push(targetType); }
    const action = String(req.query.action || '').trim();
    if (action) { conditions.push('action LIKE ?'); params.push(`%${action}%`); }
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
      conditions.push("(action LIKE ? OR detail LIKE ? OR user_name LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM operation_logs ${where}`).get(...params).count;
    const rows = db.prepare(`SELECT id,user_id AS userId,user_name AS userName,action,
        target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt
      FROM operation_logs ${where}
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    ok(res, {
      items: rows.map(row => ({ ...row, createdAt: toIso(row.createdAt, false) })),
      total,
      page,
      pageSize
    });
  });

  // ============ 推送供应商配置（仅管理员；密钥只回传"是否已配置"） ============
  const providerOr404 = (req, res) => {
    const adapter = providerRegistry.get(req.params.code);
    if (!adapter) {
      fail(res, 404, '推送供应商不存在');
      return null;
    }
    return adapter;
  };

  const providerView = adapter => ({
    ...adapter,
    ...providerConfigStore.publicView(adapter.code, adapter.credentialSchema)
  });

  app.get('/api/v2/push-providers', requireAuth, requireAdmin, (req, res) => {
    ok(res, { items: providerRegistry.list().map(providerView) });
  });

  app.put('/api/v2/push-providers/:code', requireAuth, requireAdmin, async (req, res) => {
    const adapter = providerOr404(req, res);
    if (!adapter) return;
    try {
      const credentials = (req.body && req.body.credentials) || {};
      providerConfigStore.save(adapter.code, credentials, adapter.credentialSchema);
      const allowed = new Set(adapter.credentialSchema.map(field => field.key));
      const changed = Object.keys(credentials).filter(key => allowed.has(key)).sort();
      audit(req.user, '保存推送供应商配置', 'push_provider', adapter.code, `字段：${changed.join(',')}`);
      const validation = await adapter.validateConfig(providerConfigStore.getDecrypted(adapter.code));
      if (!validation.ok) {
        providerConfigStore.recordHealth(adapter.code, validation);
        return fail(res, 400, validation.message || '供应商配置校验失败', validation.code || 'PROVIDER_CONFIG_INVALID');
      }
      ok(res, providerConfigStore.publicView(adapter.code, adapter.credentialSchema));
    } catch (error) {
      const status = error && error.code === 'PUSH_MASTER_KEY_MISSING' ? 503 : 400;
      fail(res, status, error.message || '保存供应商配置失败', error.code || '');
    }
  });

  app.post('/api/v2/push-providers/:code/test', requireAuth, requireAdmin, async (req, res) => {
    const adapter = providerOr404(req, res);
    if (!adapter) return;
    try {
      const config = providerConfigStore.getDecrypted(adapter.code);
      if (!config) return fail(res, 400, '供应商尚未配置');
      const result = await adapter.healthCheck(config);
      providerConfigStore.recordHealth(adapter.code, result);
      audit(req.user, '测试推送供应商配置', 'push_provider', adapter.code, `结果：${result.ok ? 'healthy' : (result.code || 'unhealthy')}`);
      const view = providerConfigStore.publicView(adapter.code, adapter.credentialSchema);
      if (!result.ok) return fail(res, 400, result.message || '供应商连接测试失败', result.code || '');
      ok(res, view);
    } catch (error) {
      fail(res, 400, '供应商连接测试失败', error.code || 'PROVIDER_TEST_FAILED');
    }
  });

  app.put('/api/v2/push-providers/:code/enabled', requireAuth, requireAdmin, (req, res) => {
    const adapter = providerOr404(req, res);
    if (!adapter) return;
    try {
      const enabled = Boolean(req.body && req.body.enabled);
      const result = providerConfigStore.setEnabled(adapter.code, enabled);
      audit(req.user, enabled ? '启用推送供应商' : '停用推送供应商', 'push_provider', adapter.code);
      ok(res, result);
    } catch (error) {
      fail(res, 400, error.message || '切换供应商状态失败');
    }
  });

  app.get('/api/v2/dashboard/me', requireAuth, (req, res) => {
    const courierId = req.user.courier_id || '__none__';
    const list = tasks.listTasks({ workerId: courierId });
    const today = todayStr();
    const monthStart = today.slice(0, 8) + '01';
    const assistCount = courierId === '__none__' ? 0 : db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM pickup_tasks t
      JOIN task_assistants a ON a.task_id=t.id WHERE a.worker_id=? AND t.status='completed'`).get(courierId).n;
    ok(res, {
      pending: list.filter(t => t.status === 'pending').length,
      inProgress: list.filter(t => t.status === 'in_progress').length,
      completed: list.filter(t => t.status === 'completed').length,
      pieces: list.flatMap(t => t.items).reduce((sum, item) => sum + Number(item.pieces || 0), 0),
      assistCount,
      today: workerStatsWindow(db, courierId, today, today),
      month: workerStatsWindow(db, courierId, monthStart, today)
    });
  });

  app.get('/api/v2/dashboard/board', requireAuth, requireStaff, (req, res) => {
    const where = dashboardWhere(String(req.query.range || 'today'));
    const taskRows = db.prepare(`SELECT * FROM pickup_tasks t ${where.sql}`).all(...where.params);
    const ids = taskRows.map(row => row.id);
    const itemRows = ids.length
      ? db.prepare(`SELECT * FROM pickup_items WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    const completed = taskRows.filter(row => row.status === 'completed');
    ok(res, {
      shipCustomerCount: new Set(completed.map(row => row.customer_id || fc.decryptField(row.customer_name_snap))).size,
      finalWeight: itemRows.reduce((sum, row) => sum + num(row.final_weight), 0),
      pickupCustomerCount: new Set(completed.map(row => row.customer_id || fc.decryptField(row.customer_name_snap))).size,
      pickupCount: completed.length,
      pieces: itemRows.reduce((sum, row) => sum + Number(row.pieces || 0), 0),
      pendingCount: taskRows.filter(row => row.status === 'pending' || row.status === 'in_progress').length
    });
  });

  app.get('/api/v2/dashboard/attention', requireAuth, requireStaff, (req, res) => {
    ok(res, {
      rushNearDeadline: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE task_type='rush' AND status IN ('pending','in_progress') AND rush_ship_time<>'' AND datetime(rush_ship_time)<=datetime('now','+8 hours','+2 hours')").get().count,
      overdue: db.prepare("SELECT COUNT(*) AS count FROM pickup_tasks WHERE status='pending' AND datetime(created_at,'+8 hours')<=datetime('now','+8 hours','-2 hours')").get().count,
      unmatchedWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='pending'").get().count,
      noWaybill: db.prepare("SELECT COUNT(*) AS count FROM pickup_items WHERE match_status='no_waybill'").get().count,
      unresolvedException: db.prepare('SELECT COUNT(*) AS count FROM task_exceptions WHERE resolved=0').get().count,
      syncFailed: 0
    });
  });

  // ---- 看板其余聚合（与 v1 同名接口同源，避免两端数字不一致）----
  app.get('/api/v2/dashboard/workers', requireAuth, requireStaff, (req, res) => {
    const items = dashViews.dashboardWorkers(db);
    ok(res, { items, total: items.length });
  });

  app.get('/api/v2/dashboard/cs', requireAuth, requireStaff, (req, res) => {
    const items = dashViews.dashboardCs(db);
    ok(res, { items, total: items.length });
  });

  app.get('/api/v2/dashboard/customers', requireAuth, requireStaff, (req, res) => {
    const items = dashViews.dashboardCustomers(db);
    ok(res, { items, total: items.length });
  });

  app.get('/api/v2/dashboard/trends', requireAuth, requireStaff, (req, res) => {
    ok(res, dashViews.dashboardTrends(db, req.query.days));
  });

  // ---- 区域取件员分配（等价 v1 PUT /api/areas/:id/workers）----
  app.put('/api/v2/areas/:id/workers', requireAuth, requireStaff, (req, res) => {
    const area = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
    if (!area) return fail(res, 404, '区域不存在');
    const body = req.body || {};
    const defaults = Array.isArray(body.defaultWorkerIds) ? body.defaultWorkerIds : [];
    const backups = Array.isArray(body.backupWorkerIds) ? body.backupWorkerIds : [];
    db.transaction(() => {
      db.prepare('DELETE FROM area_workers WHERE area_id=?').run(area.id);
      const insert = db.prepare('INSERT INTO area_workers (area_id,worker_id,worker_role) VALUES (?,?,?)');
      for (const id of defaults) if (id) insert.run(area.id, id, 'default');
      for (const id of backups) if (id) insert.run(area.id, id, 'backup');
    })();
    audit(req.user, '设置区域取件员', 'area', area.id);
    ok(res, { ok: true });
  });

  // ---- 自助查单（免登录；等价 v1 GET /api/track，输出统一 ISO8601）----
  app.get('/api/v2/track', (req, res) => {
    const q = String(req.query.q || '').trim();
    const phone = String(req.query.phone || '').trim();
    const surname = String(req.query.surname || '').trim();
    if (!q && !phone) return fail(res, 400, '请输入订单号、面单号或手机号');
    if (phone && !surname) return fail(res, 400, '请同时输入姓氏以确认身份');
    const found = locateTrackTarget(db, { q, phone, surname });
    if (found.task) {
      const task = found.task;
      const label = { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[task.status] || task.status;
      const totalPieces = db.prepare('SELECT COALESCE(SUM(pieces),0) AS n FROM pickup_items WHERE task_id=?').get(task.id).n;
      const waybills = db.prepare("SELECT waybill_no FROM pickup_items WHERE task_id=? AND waybill_no<>'' ORDER BY sort_order").all(task.id).map(r => r.waybill_no);
      const timeline = db.prepare(`SELECT event_type,note,actor_name AS by,created_at AS at FROM task_events
        WHERE task_id=? ORDER BY created_at,rowid`).all(task.id).map(row => ({
        status: ({ created: '已下单', assigned: '已派单', assist_added: '已邀请协助', status_changed: label, updated: '信息更新', exception_resolved: '异常已处理' })[row.event_type] || row.event_type,
        note: row.note || '', by: row.by || '', at: toIso(String(row.at || '').slice(0, 19), true)
      }));
      return ok(res, {
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
    if (found.legacy) {
      const legacy = found.legacy;
      const timeline = db.prepare('SELECT status, note, user_name AS by, created_at AS at FROM record_status_log WHERE record_id = ? ORDER BY rowid ASC').all(legacy.id);
      return ok(res, {
        orderNo: legacy.order_no || '', trackingNo: legacy.tracking_no || '',
        customer: maskName(fc.decryptField(legacy.customer)), pieces: legacy.pieces,
        goods: legacy.goods || '', status: legacy.status || '待取', timeline: timeline.map(row => ({ ...row, at: toIso(String(row.at || '').slice(0, 19), false) }))
      });
    }
    fail(res, 404, '未查询到该单');
  });

  // ---- 任务：状态直改 与 明细编辑（等价 v1，权限沿用任务可见性）----
  app.put('/api/v2/tasks/:id/status', requireAuth, (req, res) => {
    try {
      const current = tasks.getTask(req.params.id);
      if (!current) return fail(res, 404, '取件任务不存在');
      if (!taskVisibleTo(req.user, current)) return fail(res, 403, '无权操作该任务');
      const task = tasks.transitionTask(
        req.params.id,
        String((req.body && req.body.status) || ''),
        { id: req.user.id, name: req.user.name || req.user.username },
        String((req.body && req.body.note) || '')
      );
      broadcast({ type: 'task.status', taskId: task.id, status: task.status });
      ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) });
    } catch (error) {
      fail(res, 400, error.message || '更新任务状态失败');
    }
  });

  app.put('/api/v2/tasks/:id/items/:itemId', requireAuth, (req, res) => {
    const task = tasks.getTask(req.params.id);
    if (!task) return fail(res, 404, '取件任务不存在');
    if (!taskVisibleTo(req.user, task)) return fail(res, 403, '无权操作该任务');
    if (task.status === 'cancelled') return fail(res, 409, '已取消任务不能修改明细');
    const item = db.prepare('SELECT * FROM pickup_items WHERE id=? AND task_id=?').get(req.params.itemId, task.id);
    if (!item) return fail(res, 404, '货物明细不存在');
    const body = req.body || {};
    if (typeof body.pieces !== 'number' || !Number.isSafeInteger(body.pieces) || body.pieces <= 0) {
      return fail(res, 400, '件数必须为正整数');
    }
    const goodsName = body.goodsName === undefined ? item.goods_name : body.goodsName;
    const waybillInput = body.waybillNo === undefined ? item.waybill_no : body.waybillNo;
    if (typeof goodsName !== 'string' || goodsName.length > 200 ||
        typeof waybillInput !== 'string' || waybillInput.length > 128) {
      return fail(res, 400, '品名或面单号格式不正确');
    }
    const waybillNo = waybillInput.trim();
    const changedWaybill = waybillNo !== item.waybill_no;
    const before = { goodsName: item.goods_name, waybillNo: item.waybill_no, pieces: item.pieces };
    const after = { goodsName: goodsName.trim(), waybillNo, pieces: body.pieces };
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) });
    }
    const updatedAt = utcText();
    try {
      db.transaction(() => {
        // 保留归属与财务字段；换了面单号不得继承旧运单的匹配重量，需重新匹配
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
      ok(res, { task: isoTask(taskDetailV2(db, tasks, task.id)) });
    } catch {
      fail(res, 500, '保存货物明细失败');
    }
  });

  // ============ 历史取件记录（后台与取件员共用） ============
  app.get('/api/v2/records', requireAuth, (req, res) => {
    const { page, pageSize } = pageOf(req.query);
    const { courierId, start, end, keyword, status, customerId } = req.query;
    const wantUnassigned = req.query.unassigned === '1';
    const scope = wantUnassigned ? { cond: '', params: {} } : recordScope(req.user);
    const conds = scope.cond ? [scope.cond] : [];
    const params = Object.assign({}, scope.params);
    if (wantUnassigned) conds.push("(r.courier_id IS NULL OR r.courier_id = '')");
    if (courierId && courierId !== 'all') {
      if (courierId === 'none') conds.push("(r.courier_id IS NULL OR r.courier_id = '')");
      else { conds.push('r.courier_id = :cid'); params.cid = courierId; }
    }
    if (start) { conds.push('r.date >= :start'); params.start = start; }
    if (end) { conds.push('r.date <= :end'); params.end = end; }
    if (status && status !== 'all' && ['待取', '已取', '已完成', '已取消'].includes(status)) {
      conds.push('r.status = :status'); params.status = status;
    }
    if (customerId && customerId !== 'all') { conds.push('r.customer_id = :custId'); params.custId = customerId; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const kw = String(keyword || '').trim().toLowerCase();
    const rows = db.prepare(`SELECT r.*, c.name AS cname, cu.name AS customer_name, cu.phone AS customer_phone
      FROM records r
      LEFT JOIN couriers c ON r.courier_id = c.id
      LEFT JOIN customers cu ON r.customer_id = cu.id
      ${where} ORDER BY r.date DESC, r.id DESC`).all(params);
    let items = rows.map(r => Object.assign(rowRecord(r), {
      customerName: fc.decryptField(r.customer_name || r.customer), customerPhone: fc.decryptField(r.customer_phone || '')
    }));
    if (kw) {
      items = items.filter(it =>
        (it.customer && it.customer.toLowerCase().includes(kw)) ||
        (it.orderNo && it.orderNo.toLowerCase().includes(kw)) ||
        (it.trackingNo && it.trackingNo.toLowerCase().includes(kw)) ||
        (it.goods && it.goods.toLowerCase().includes(kw)));
    }
    const total = items.length;
    ok(res, { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize });
  });

  // ---- 记录写操作（等价 v1 /api/records* ；权限规则完全一致）----
  const RECORD_STATUSES = ['待取', '已取', '已完成', '已取消'];
  // 取件员只能操作自己名下"未结束"的记录；客服/管理员不受限（与 v1 注释同义）
  function recordWritable(req, res, row) {
    if (req.user.role !== 'courier') return true;
    if (row.courier_id !== req.user.courier_id) { fail(res, 403, '无权操作该记录'); return false; }
    if (row.status === '已完成' || row.status === '已取消') {
      fail(res, 403, '订单已完成/已取消，操作权限已回收');
      return false;
    }
    return true;
  }

  app.post('/api/v2/records', requireAuth, withIdempotency((req, res) => {
    const {
      date, courierId, customer, customerId, pieces, address = '', region = '', note = '', status = '待取', orderNo = '',
      goods = '', weight = 0, volume = 0, trackingNo = '', amountReceivable = 0, amountPayable = 0, settled = '未结算',
      pickupPhone = '', appointmentTime = ''
    } = req.body || {};
    if (!date) return fail(res, 400, '请选择日期');
    // 客户：优先用客户档案（customerId），否则用自由文本
    let custId = '';
    let custFinal = '';
    if (customerId) {
      const cu = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      if (cu) { custId = cu.id; custFinal = fc.decryptField(cu.name); }
    }
    if (!custFinal) custFinal = String(customer || '').trim();
    if (!custFinal) return fail(res, 400, '请输入客户名称');
    const p = parseInt(pieces, 10) || 0;
    if (req.user.role === 'courier' && p <= 0) return fail(res, 400, '请输入有效的取件件数');
    if (p < 0) return fail(res, 400, '件数不能为负数');
    const weightFinal = num(weight);
    const volumeFinal = num(volume);
    if (!Number.isFinite(weightFinal) || weightFinal < 0) return fail(res, 400, '重量不能为负数');
    if (!Number.isFinite(volumeFinal) || volumeFinal < 0) return fail(res, 400, '体积不能为负数');
    const addressFinal = String(address || '').trim();
    if ((req.user.role === 'admin' || req.user.role === 'cs') && !addressFinal) return fail(res, 400, '请输入取件地址');
    if (!RECORD_STATUSES.includes(status)) return fail(res, 400, '状态不正确');
    if (!['未结算', '已结算'].includes(settled)) return fail(res, 400, '结算状态不正确');
    const settledFinal = req.user.role === 'courier' ? '未结算' : settled; // 取件员登记固定为未结算
    const orderFinal = String(orderNo || '').trim();
    const trackingFinal = String(trackingNo || '').trim();
    if (orderFinal && db.prepare('SELECT id FROM records WHERE order_no = ?').get(orderFinal)) {
      return fail(res, 409, '订单号已存在，请勿重复录入：' + orderFinal);
    }
    const canAssign = req.user.role === 'admin' || req.user.role === 'cs';
    const cid = canAssign ? (courierId || null) : (req.user.courier_id || null);
    const id = randomUUID();
    const regionFinal = String(region || '').trim() ||
      (() => { const c = cid ? db.prepare('SELECT region FROM couriers WHERE id=?').get(cid) : null; return c ? c.region : ''; })();
    db.prepare(`INSERT INTO records (id,date,courier_id,customer,customer_id,pieces,address,region,note,status,order_no,goods,weight,volume,tracking_no,amount_receivable,amount_payable,settled,pickup_phone,appointment_time,dispatcher_id,dispatcher_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, date, cid, fc.encryptField(custFinal), custId, p, fc.encryptField(addressFinal), regionFinal,
        fc.encryptField(String(note || '')), status, orderFinal, String(goods || '').trim(), weightFinal, volumeFinal,
        trackingFinal, num(amountReceivable), num(amountPayable), settledFinal,
        fc.encryptField(String(pickupPhone || '').trim()), String(appointmentTime || '').trim(),
        req.user.id, req.user.name || req.user.username);
    db.prepare('INSERT INTO record_status_log (id,record_id,status,note,user_name) VALUES (?,?,?,?,?)')
      .run(randomUUID(), id, status, String(note || ''), req.user.name || req.user.username);
    const created = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id));
    broadcast({ type: 'record.created', record: created, actorId: req.user.id, actor: req.user.name || req.user.username });
    if (businessNotificationPublisher) {
      businessNotificationPublisher.recordAssigned(created, {
        id: req.user.id, name: req.user.name || req.user.username
      }, randomUUID());
    }
    ok(res, { record: created }, 201);
  }));

  app.put('/api/v2/records/:id', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    if (!recordWritable(req, res, r)) return undefined;
    const b = req.body || {};
    // 允许补录：件数、面单号、地址、区域、品名、备注、取件电话（不允许改财务结算/状态/客户/取件员）
    const pieces = parseInt(b.pieces, 10);
    if (!pieces || pieces <= 0) return fail(res, 400, '请输入取件件数');
    const trackingNo = b.trackingNo != null ? String(b.trackingNo).trim() : (r.tracking_no || '');
    const decRec = {
      address: fc.decryptField(r.address), note: fc.decryptField(r.note), pickup_phone: fc.decryptField(r.pickup_phone)
    };
    const address = b.address != null ? String(b.address).trim() : (decRec.address || '');
    const region = b.region != null ? String(b.region).trim() : (r.region || '');
    const goods = b.goods != null ? String(b.goods).trim() : (r.goods || '');
    const note = b.note != null ? String(b.note).trim() : (decRec.note || '');
    const pickupPhone = b.pickupPhone != null ? String(b.pickupPhone).trim() : (decRec.pickup_phone || '');
    const isStaff = req.user.role === 'admin' || req.user.role === 'cs';
    const amountReceivable = (isStaff && b.amountReceivable != null) ? num(b.amountReceivable) : (r.amount_receivable || 0);
    const amountPayable = (isStaff && b.amountPayable != null) ? num(b.amountPayable) : (r.amount_payable || 0);
    db.prepare('UPDATE records SET pieces=?, tracking_no=?, address=?, region=?, goods=?, note=?, pickup_phone=?, amount_receivable=?, amount_payable=? WHERE id=?')
      .run(pieces, trackingNo, fc.encryptField(address), region, goods, fc.encryptField(note),
        fc.encryptField(pickupPhone), amountReceivable, amountPayable, r.id);
    const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
    broadcast({ type: 'record.updated', record: updated, action: 'edit', actorId: req.user.id, actor: req.user.name || req.user.username });
    ok(res, { record: updated });
  });

  app.put('/api/v2/records/:id/status', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    const status = req.body && req.body.status;
    if (!RECORD_STATUSES.includes(status)) return fail(res, 400, '状态不正确');
    if (!recordWritable(req, res, r)) return undefined;
    const completedAt = status === '已完成' ? nowStr() : (r.completed_at || '');
    db.prepare('UPDATE records SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, r.id);
    db.prepare('INSERT INTO record_status_log (id,record_id,status,note,user_name) VALUES (?,?,?,?,?)')
      .run(randomUUID(), r.id, status, String((req.body && req.body.note) || ''), req.user.name || req.user.username);
    const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
    broadcast({ type: 'record.updated', record: updated, action: 'status', actorId: req.user.id, actor: req.user.name || req.user.username });
    if (businessNotificationPublisher) {
      businessNotificationPublisher.recordStatusChanged(updated, {
        id: req.user.id, name: req.user.name || req.user.username
      }, randomUUID());
    }
    ok(res, { record: updated });
  });

  app.put('/api/v2/records/:id/settle', requireAuth, requireStaff, (req, res) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    const settled = req.body && req.body.settled;
    if (!['未结算', '已结算'].includes(settled)) return fail(res, 400, '结算状态不正确');
    db.prepare('UPDATE records SET settled = ? WHERE id = ?').run(settled, r.id);
    const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
    broadcast({ type: 'record.updated', record: updated, action: 'settle', actorId: req.user.id, actor: req.user.name || req.user.username });
    ok(res, { record: updated });
  });

  app.put('/api/v2/records/:id/courier', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    const courierId = req.body && req.body.courierId;
    if (req.user.role === 'courier') {
      // 取件员只能认领「未分配」订单给自己
      if (r.courier_id) return fail(res, 403, '该订单已分配，无法认领');
      if (courierId !== req.user.courier_id) return fail(res, 403, '只能认领给自己');
    }
    const finalCid = (courierId === '' || courierId === null || courierId === undefined) ? null : courierId;
    db.prepare('UPDATE records SET courier_id = ? WHERE id = ?').run(finalCid, r.id);
    const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
    broadcast({ type: 'record.updated', record: updated, action: 'assign', actorId: req.user.id, actor: req.user.name || req.user.username });
    if (businessNotificationPublisher) {
      businessNotificationPublisher.recordAssigned(updated, {
        id: req.user.id, name: req.user.name || req.user.username
      }, randomUUID());
    }
    ok(res, { record: updated });
  });

  app.delete('/api/v2/records/:id', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    if (!recordWritable(req, res, r)) return undefined;
    db.prepare('DELETE FROM records WHERE id = ?').run(r.id);
    broadcast({ type: 'record.deleted', id: r.id, actorId: req.user.id, actor: req.user.name || req.user.username });
    ok(res, { ok: true });
  });

  // 记录图片上传（multipart，字段名 images，最多 9 张）
  app.post('/api/v2/records/:id/images', requireAuth, (req, res, next) => {
    const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!r) return fail(res, 404, '记录不存在');
    if (!recordWritable(req, res, r)) return undefined;
    req.recordRow = r;
    next();
  }, imageUpload.array('images', 9), (req, res) => {
    const r = req.recordRow;
    const type = (req.body && req.body.type) === 'pickup' ? 'pickup' : 'goods';
    const files = (req.files || []).map(f => f.filename);
    if (!files.length) return fail(res, 400, '请选择图片');
    const col = type === 'pickup' ? 'pickup_images' : 'goods_images';
    const parseImages = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    db.prepare(`UPDATE records SET ${col} = ? WHERE id = ?`)
      .run(JSON.stringify(parseImages(r[col]).concat(files)), r.id);
    const updated = rowRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(r.id));
    broadcast({ type: 'record.updated', record: updated, action: 'image', actorId: req.user.id, actor: req.user.name || req.user.username });
    ok(res, { record: updated });
  });

  // ============ 重量匹配中心（等价 v1 /api/sync/*）============
  app.get('/api/v2/sync/match-center', requireAuth, requireStaff, (req, res) => {
    const rows = db.prepare(`SELECT i.*,t.task_no,t.customer_name_snap FROM pickup_items i
      JOIN pickup_tasks t ON t.id=i.task_id WHERE i.match_status IN ('pending','no_waybill') ORDER BY i.created_at DESC`).all();
    const items = rows.map(row => ({
      id: row.id, taskId: row.task_id, taskNo: row.task_no,
      customerName: fc.decryptField(row.customer_name_snap), waybillNo: row.waybill_no,
      pieces: row.pieces, entryMethod: row.entry_method, matchStatus: row.match_status
    }));
    ok(res, { items, total: items.length });
  });

  app.post('/api/v2/sync/match/:id', requireAuth, requireStaff, (req, res) => {
    const item = db.prepare('SELECT * FROM pickup_items WHERE id=?').get(req.params.id);
    if (!item) return fail(res, 404, '货物明细不存在');
    const waybillNo = String((req.body && req.body.waybillNo) || '').trim();
    if (!waybillNo) return fail(res, 400, '请输入票号');
    const found = findWaybillWeight(db, waybillNo, nowStr());
    db.prepare(`UPDATE pickup_items SET waybill_no=?,entry_method='manual',final_weight=?,weight_source=?,match_status=?,updated_at=? WHERE id=?`)
      .run(waybillNo, found.matched ? found.finalWeight : num(item.final_weight),
        found.matched ? 'waybill_sync' : '', found.matched ? 'matched' : 'pending', utcText(), item.id);
    ok(res, { matched: found.matched, finalWeight: found.finalWeight });
  });

  // ============ 对账 / 提成 ============
  app.get('/api/v2/billing', requireAuth, requireStaff, (req, res) => {
    const { start, end, customerId } = req.query;
    const conds = [];
    const params = {};
    if (start) { conds.push('r.date >= :start'); params.start = start; }
    if (end) { conds.push('r.date <= :end'); params.end = end; }
    if (customerId && customerId !== 'all') { conds.push('r.customer_id = :cid'); params.cid = customerId; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
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
    const total = db.prepare(`SELECT COALESCE(SUM(amount_receivable),0) AS receivable,
      COALESCE(SUM(amount_payable),0) AS payable,
      COALESCE(SUM(CASE WHEN settled='未结算' THEN amount_receivable ELSE 0 END),0) AS unsettled,
      COUNT(*) AS orders FROM records r ${where}`).get(params);
    ok(res, { byCustomer, total });
  });

  app.get('/api/v2/commission', requireAuth, (req, res) => {
    const { start, end } = req.query;
    const conds = [];
    const params = {};
    if (start) { conds.push('r.date >= :start'); params.start = start; }
    if (end) { conds.push('r.date <= :end'); params.end = end; }
    const dateCond = conds.length ? conds.join(' AND ') : '1=1';
    const isStaff = req.user.role === 'admin' || req.user.role === 'cs';
    const ownCond = isStaff ? '1=1' : 'c.id = :myCid';
    if (!isStaff) params.myCid = req.user.courier_id || '__none__';
    const rows = db.prepare(`SELECT c.id AS courierId, c.name AS name, COALESCE(c.commission_rate,0) AS rate,
      COALESCE(SUM(CASE WHEN ${dateCond} THEN r.pieces ELSE 0 END),0) AS pieces,
      COALESCE(SUM(CASE WHEN ${dateCond} THEN 1 ELSE 0 END),0) AS orders
      FROM couriers c LEFT JOIN records r ON r.courier_id = c.id
      WHERE ${ownCond}
      GROUP BY c.id ORDER BY pieces DESC`).all(params);
    const data = rows.map(x => ({
      courierId: x.courierId, name: x.name, rate: x.rate, pieces: x.pieces, orders: x.orders,
      amount: Math.round(x.pieces * x.rate * 100) / 100
    }));
    const total = data.reduce(
      (sum, x) => ({
        pieces: sum.pieces + x.pieces,
        orders: sum.orders + x.orders,
        amount: Math.round((sum.amount + x.amount) * 100) / 100
      }),
      { pieces: 0, orders: 0, amount: 0 }
    );
    ok(res, { rows: data, total });
  });

  // ============ 站内通知 ============
  app.get('/api/v2/notifications', requireAuth, (req, res) => {
    const query = { page: String(req.query.page || '1'), pageSize: String(req.query.pageSize || '20') };
    if (req.query.unread === '1' || req.query.unread === 'true') query.unread = '1';
    if (req.query.type) query.type = String(req.query.type);
    ok(res, notificationService.listForUser(req.user.id, query));
  });

  app.get('/api/v2/notifications/unread-count', requireAuth, (req, res) => {
    ok(res, { count: notificationService.unreadCount(req.user.id) });
  });

  app.post('/api/v2/notifications/:id/read', requireAuth, (req, res) => {
    const result = notificationService.markRead(req.user.id, req.params.id);
    if (result.changes === 0 && !notificationRepository.findById(req.params.id)) {
      return fail(res, 404, '通知不存在');
    }
    ok(res, { ok: true });
  });

  app.post('/api/v2/notifications/read-all', requireAuth, (req, res) => {
    const result = notificationService.markAllRead(req.user.id);
    ok(res, { ok: true, updated: result.changes });
  });

  // ============ 推送设备（华为 Push Kit：Android 与鸿蒙共用） ============
  app.get('/api/v2/push/devices', requireAuth, (req, res) => {
    const items = subscriptionStore.listForUser(req.user.id)
      .filter(item => item.channel === 'vendor_push')
      .map(item => ({
        id: item.id, platform: item.platform, deviceLabel: item.deviceLabel,
        appVersion: item.appVersion, status: item.status,
        lastSeenAt: item.lastSeenAt, createdAt: item.createdAt
      }));
    ok(res, { items });
  });

  app.post('/api/v2/push/devices', requireAuth, (req, res) => {
    const body = req.body || {};
    const providerCode = String(body.providerCode || 'huawei');
    if (!providerRegistry.get(providerCode)) return fail(res, 400, '推送供应商不可用');
    const token = String(body.token || '').trim();
    if (!token || token.length > 8192) return fail(res, 400, '设备 token 不正确');
    const platform = String(body.platform || '');
    if (!['android', 'harmonyos'].includes(platform)) return fail(res, 400, 'platform 必须是 android 或 harmonyos');
    try {
      const item = subscriptionStore.register({
        userId: req.user.id,
        channel: 'vendor_push',
        providerCode,
        platform,
        deviceLabel: String(body.deviceLabel || '').slice(0, 100),
        appVersion: String(body.appVersion || '').slice(0, 50),
        role: req.user.role,
        courierId: req.user.courier_id || '',
        secret: { token }
      });
      ok(res, {
        device: {
          id: item.id, platform: item.platform, deviceLabel: item.deviceLabel,
          appVersion: item.appVersion, status: item.status, createdAt: item.createdAt
        }
      }, 201);
    } catch (error) {
      const status = error && error.code === 'PUSH_MASTER_KEY_MISSING' ? 503 : 400;
      fail(res, status, error.message || '登记推送订阅失败', error.code || '');
    }
  });

  app.delete('/api/v2/push/devices/:id', requireAuth, (req, res) => {
    const result = subscriptionStore.remove(req.user.id, req.params.id);
    if (!result.changes) return fail(res, 404, '设备订阅不存在');
    ok(res, { ok: true });
  });

  app.post('/api/v2/push/devices/:id/test', requireAuth, (req, res) => {
    const target = subscriptionStore.getDecrypted(req.params.id);
    if (!target || target.userId !== req.user.id) return fail(res, 404, '设备订阅不存在');
    const notification = notificationService.publish({
      recipientUserId: req.user.id,
      type: 'system.test',
      title: '推送测试',
      body: '消息推送配置正常',
      data: { route: '/notifications' },
      priority: 'normal',
      dedupeKey: `push-test:${req.user.id}:${randomUUID()}`
    });
    ok(res, { notificationId: notification.id }, 202);
  });

  // ============ 通知偏好 ============
  app.get('/api/v2/notification-preferences', requireAuth, (req, res) => {
    ok(res, { items: preferenceStore.listForUser(req.user.id) });
  });

  app.put('/api/v2/notification-preferences', requireAuth, (req, res) => {
    const body = req.body || {};
    const type = String(body.type || '');
    const channel = String(body.channel || '');
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/i.test(type)) return fail(res, 400, '通知类型不正确');
    if (!['in_app', 'web_push', 'vendor_push'].includes(channel)) return fail(res, 400, '通知通道不正确');
    preferenceStore.set(req.user.id, type, channel, body.enabled !== false, {
      start: body.quietStart, end: body.quietEnd
    });
    ok(res, { items: preferenceStore.listForUser(req.user.id) });
  });
}

module.exports = { mountApiV2Routes };

// v1 / v2 共用的读视图与查询助手。
//
// 为什么要单独一个文件：v2 是"规范层"，但它与 v1 必须是同一套业务语义。
// 如果两边各写一份，字段迟早会漂移（历史上 v2 客户列表就漏了 taskCount / contactName 等字段）。
// 因此把视图与统计查询放在这里，两个 API 都从这里取，从结构上保证一致。
'use strict';

const fc = require('../security/field-crypto');

/** 客户行视图（v1 与 v2 完全一致：主名字段与历史别名同时保留，兼容老客户端） */
const rowCustomer = (c) => ({
  id: c.id,
  customerNo: String(c.id || '').slice(0, 8),
  name: fc.decryptField(c.name),
  contact: fc.decryptField(c.contact || ''),
  contactName: fc.decryptField(c.contact || ''),
  phone: fc.decryptField(c.phone || ''),
  contactPhone: fc.decryptField(c.phone || ''),
  address: fc.decryptField(c.address || ''),
  note: fc.decryptField(c.note || ''),
  remark: fc.decryptField(c.note || ''),
  status: c.status || 'active',
  legacyCustomerId: c.legacy_customer_id || '',
  importantNote: fc.decryptField(c.important_note || ''),
  mainCsId: c.main_cs_id || ''
});

/** 取件员行视图 */
const rowCourier = (c) => ({
  id: c.id,
  name: c.name,
  region: c.region || '',
  commissionRate: c.commission_rate || 0
});

/** 员工视图（角色 worker 与存储值 courier 的映射与 v1 一致） */
function employeeView(db, user) {
  const courier = user.courier_id ? db.prepare('SELECT * FROM couriers WHERE id=?').get(user.courier_id) : null;
  return {
    id: user.id,
    username: user.username,
    name: user.name || (courier && courier.name) || '',
    phone: user.phone || '',
    employeeNo: user.employee_no || '',
    role: user.role === 'courier' ? 'worker' : user.role,
    status: user.status || 'active',
    courierId: user.courier_id || '',
    region: (courier && courier.region) || ''
  };
}

/** 客户订单统计：按客户聚合任务数 / 待办数 / 已完成数 */
function customerOrderStats(db, ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT customer_id AS id,
      COUNT(*) AS taskCount,
      SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS openTaskCount,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount
    FROM pickup_tasks WHERE customer_id IN (${ids.map(() => '?').join(',')}) GROUP BY customer_id`).all(...ids);
  return new Map(rows.map(row => [row.id, {
    taskCount: Number(row.taskCount),
    openTaskCount: Number(row.openTaskCount || 0),
    completedTaskCount: Number(row.completedTaskCount || 0)
  }]));
}

/**
 * 客户列表统一视图：基础字段 + 地址数 + 订单统计（v1 与 v2 共用，保证字段一致）。
 * countMap 可选：调用方已批量查好地址数时传入，避免逐行查询。
 * mainCsName 由调用方 JOIN 得到时经 nameMap 传入（移动端列表需要展示主客服）。
 */
function customerListView(db, rows, countMap, nameMap) {
  const stats = customerOrderStats(db, rows.map(row => row.id));
  return rows.map(row => {
    const stat = stats.get(row.id) || { taskCount: 0, openTaskCount: 0, completedTaskCount: 0 };
    const addressCount = countMap ? (countMap.get(row.id) || 0)
      : db.prepare('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?').get(row.id).n;
    return { ...rowCustomer(row), addressCount, ...stat, mainCsName: (nameMap && nameMap.get(row.id)) || '' };
  });
}

/** 姓名脱敏（自助查单展示用） */
function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.length <= 1 ? s : s[0] + '**';
}

/**
 * 客户自助查单的数据定位（免登录）。
 * 新任务模型优先（业务订单号 / 任务号 / 明细面单号），旧 records 兜底，兼顾迁移后的老单。
 * 返回 { task } 或 { legacy } 或 {}；不负责渲染，渲染由各自 API 决定（v1 本地时间文本、v2 ISO8601）。
 */
function locateTrackTarget(db, { q, phone, surname }) {
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
      .filter(c => fc.decryptField(c.phone) === phone
        && (fc.decryptField(c.name).startsWith(surname) || fc.decryptField(c.contact).startsWith(surname)))
      .map(c => c.id);
    const task = custIds.length
      ? db.prepare(`SELECT * FROM pickup_tasks WHERE customer_id IN (${custIds.map(() => '?').join(',')})
          ORDER BY created_at DESC LIMIT 1`).get(...custIds)
      : null;
    if (!task) {
      const bySnap = db.prepare("SELECT * FROM pickup_tasks WHERE phone_snap <> '' ORDER BY created_at DESC").all()
        .find(t => fc.decryptField(t.phone_snap) === phone
          && (fc.decryptField(t.customer_name_snap).startsWith(surname) || fc.decryptField(t.contact_snap).startsWith(surname)));
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

module.exports = {
  rowCustomer,
  rowCourier,
  employeeView,
  customerOrderStats,
  customerListView,
  maskName,
  locateTrackTarget
};

// Worker self-service accepts order details only, never assignment or billing authority.
function workerTaskInput(db, user, body) {
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const text = (value, limit, label) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > limit) fail(`${label}格式不正确`);
    return value.trim();
  };
  const workerId = user.courier_id;
  if (!workerId || !db.prepare('SELECT id FROM couriers WHERE id=?').get(workerId)) {
    fail('账号未绑定有效取件员，请联系管理员', 403);
  }
  if ((body.workerId && body.workerId !== workerId) || (body.defaultWorkerId && body.defaultWorkerId !== workerId)) {
    fail('只能为自己创建取件订单', 403);
  }
  const suppliedItems = body.items === undefined && body.customerId ? [] : body.items;
  if (!Array.isArray(suppliedItems) || (!body.customerId && suppliedItems.length === 0) || suppliedItems.length > 100) fail('请填写货物件数');
  const items = suppliedItems.map(item => {
    if (!item || typeof item.pieces !== 'number' || !Number.isSafeInteger(item.pieces) || item.pieces <= 0) {
      fail('件数必须为正整数');
    }
    const waybillNo = text(item.waybillNo, 128, '面单号');
    return { pieces: item.pieces, goodsName: text(item.goodsName, 200, '品名'), waybillNo,
      workerId, entryMethod: waybillNo ? 'manual' : 'no_waybill' };
  });
  const scheduledTime = text(body.scheduledTime, 64, '预约时间');
  const scheduledKind = ['before', 'after', 'around'].includes(body.scheduledKind) ? body.scheduledKind : '';
  const input = {
    defaultWorkerId: workerId,
    items,
    taskType: scheduledTime ? 'scheduled' : 'normal',
    scheduledKind,
    scheduledTime,
    pickupNote: text(body.pickupNote, 2000, '备注')
  };
  const customerId = text(body.customerId, 128, '客户');
  const addressId = text(body.addressId, 128, '地址');
  if (customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
    if (!customer || customer.status === 'disabled') fail('客户不存在或已停用');
    const address = db.prepare(`SELECT a.*,r.name AS area_name FROM customer_addresses a
      LEFT JOIN areas r ON r.id=a.area_id WHERE a.id=? AND a.customer_id=? AND a.is_active=1
      AND EXISTS (SELECT 1 FROM area_workers aw WHERE aw.area_id=a.area_id AND aw.worker_id=?)`).get(addressId, customerId, workerId);
    if (!address) fail('请选择该客户的有效取件地址');
    Object.assign(input, { customerId, addressId, customerName: customer.name, address: address.address,
      contact: address.contact_name || customer.contact || '', phone: address.contact_phone || customer.phone || '',
      areaName: address.area_name || '', mainCsId: customer.main_cs_id || '' });
  } else {
    if (addressId) fail('取件地址必须关联所选客户');
    Object.assign(input, { customerName: text(body.customerName, 200, '客户名称'),
      address: text(body.address, 1000, '取件地址'), contact: text(body.contact, 100, '联系人'),
      phone: text(body.phone, 64, '联系电话') });
    if (!input.customerName || !input.address || !input.contact || !input.phone) fail('请填写客户、地址、联系人和电话');
  }
  return input;
}
module.exports = { workerTaskInput };

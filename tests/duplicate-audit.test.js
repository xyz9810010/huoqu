// 运维稽核模块回归：重复业务单号 / 重复面单号 / 同秒孪生任务三类都能被识别，
// 且不带重复时输出为空；本模块只读不写（唯一写入是测试夹具）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-audit-'));
process.env.DB_PATH = path.join(tempDir, 'app.db');
const db = require('../db');
const { createTaskModule } = require('../server/domain/tasks');
const { auditDuplicates } = require('../server/operations/duplicate-audit');
const tasks = createTaskModule(db);

function mkTask(customerName, address, extra = {}) {
  return tasks.createTask({
    customerName, address, contact: '稽核联系人', phone: '13800000000',
    items: extra.items || [], ...extra
  }, { id: 'audit-user', name: '稽核' });
}

test.after(() => {
  try { db.close(); } catch (_) { /* 忽略 */ }
  for (let i = 0; i < 10; i += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); break; }
    catch (_) { if (i === 9) throw _; }
  }
});

test('识别重复业务单号 / 重复面单号 / 同秒孪生任务', () => {
  // 同一业务单号建两单（幂等键漏网场景）
  const a1 = mkTask('稽核客户甲', '义乌市稽核路 1 号', { businessOrderNo: 'AUDIT-ORDER-001' });
  const a2 = mkTask('稽核客户甲', '义乌市稽核路 2 号', { businessOrderNo: 'AUDIT-ORDER-001' });
  // 同一面单号挂在两个不同任务（跨单重录场景）
  mkTask('稽核客户乙', '义乌市稽核路 3 号', {
    items: [{ waybillNo: 'AUDIT-WB-001', pieces: 1, goodsName: '箱' }]
  });
  mkTask('稽核客户丙', '义乌市稽核路 4 号', {
    items: [{ waybillNo: 'AUDIT-WB-001', pieces: 2, goodsName: '袋' }]
  });
  // 同客户同地址同秒孪生（双击漏网）：任务域按秒生成 created_at，这里显式对齐
  const c1 = mkTask('稽核客户丁', '义乌市稽核路 5 号');
  const c2 = mkTask('稽核客户丁', '义乌市稽核路 5 号');
  db.prepare('UPDATE pickup_tasks SET created_at = ? WHERE id = ?')
    .run(c1.createdAt, c2.id);

  const findings = auditDuplicates(db);
  const byKind = Object.fromEntries(findings.map(f => [f.kind, f]));
  assert.equal(findings.length, 3, JSON.stringify(findings));
  assert.equal(byKind.duplicate_business_order_no.count, 2);
  assert.ok(byKind.duplicate_business_order_no.activeCount >= 1);
  assert.equal(byKind.duplicate_waybill_no.count, 2);
  assert.equal(byKind.twin_tasks_same_second.count, 2);
  assert.deepEqual(
    byKind.twin_tasks_same_second.detail.map(r => r.id).sort(),
    [c1.id, c2.id].sort()
  );
});

test('新写入的干净数据不产生新误报', () => {
  const a = mkTask('稽核干净客户', '义乌市干净路 1 号', { businessOrderNo: 'AUDIT-CLEAN-1' });
  const b = mkTask('稽核干净客户乙', '义乌市干净路 2 号', {
    items: [{ waybillNo: 'AUDIT-WB-CLEAN-1', pieces: 1, goodsName: '箱' }]
  });
  db.prepare('UPDATE pickup_tasks SET created_at = datetime(created_at, \'+1 minutes\') WHERE id IN (?, ?)')
    .run(a.id, b.id);
  const findings = auditDuplicates(db);
  const mine = findings.filter(f => f.detail.some(row => (row.id || row.taskId) === a.id || (row.id || row.taskId) === b.id));
  assert.deepEqual(mine, [], JSON.stringify(findings.map(f => ({ kind: f.kind, key: f.key }))));
  assert.equal(findings.length, 3, '既有三组夹具重复仍应被识别');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRole, taskStatusLabel, taskStatusType, unwrapResponse } = require('../web/src/api-contract.ts');

test('normalizeRole maps the unified Node roles to Web route roles', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('cs'), 'cs');
  assert.equal(normalizeRole('courier'), 'worker');
});

test('task status presentation uses the canonical lifecycle', () => {
  assert.equal(taskStatusLabel('pending'), '待取');
  assert.equal(taskStatusLabel('in_progress'), '取件中');
  assert.equal(taskStatusLabel('completed'), '已完成');
  assert.equal(taskStatusLabel('cancelled'), '已取消');
  assert.equal(taskStatusType('pending'), 'warning');
  assert.equal(taskStatusType('completed'), 'success');
});

test('unwrapResponse accepts raw Node JSON and legacy wrapped responses during the cutover', () => {
  assert.deepEqual(unwrapResponse({ token: 'raw-token' }), { token: 'raw-token' });
  assert.deepEqual(unwrapResponse({ data: { ticket: 'v1-ticket' } }), { ticket: 'v1-ticket' });
  assert.deepEqual(unwrapResponse({ code: 0, data: { token: 'wrapped-token' } }), { token: 'wrapped-token' });
  assert.throws(() => unwrapResponse({ code: 400, message: '失败' }), /失败/);
});

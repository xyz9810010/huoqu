const test = require('node:test');
const assert = require('node:assert/strict');

const { generatePushMasterKey } = require('../scripts/generate-push-key');

test('push master key generator returns a fresh 32-byte Base64 value', () => {
  const first = generatePushMasterKey();
  const second = generatePushMasterKey();
  assert.equal(Buffer.from(first, 'base64').length, 32);
  assert.equal(Buffer.from(second, 'base64').length, 32);
  assert.notEqual(first, second);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHuaweiProvider } = require('../server/modules/notifications/providers/huawei');

test('Huawei provider declares configuration fields and validates service account JSON', async () => {
  const provider = createHuaweiProvider({ fetch: async () => { throw new Error('not called'); } });
  assert.equal(provider.code, 'huawei');
  assert.deepEqual(provider.credentialSchema.map(field => field.key), ['projectId', 'serviceAccount']);
  assert.equal((await provider.validateConfig({ projectId: '', serviceAccount: '{}' })).ok, false);
  assert.equal((await provider.validateConfig({
    projectId: 'project-1',
    serviceAccount: JSON.stringify({ key_id: 'key-1', sub_account: 'account', private_key: 'key' })
  })).ok, true);
});

test('Huawei provider maps a successful gateway response to each target', async () => {
  let capturedUrl = '';
  let capturedBody = null;
  const provider = createHuaweiProvider({
    getAccessToken: async () => 'access-token',
    fetch: async (url, request) => {
      capturedUrl = url;
      capturedBody = JSON.parse(request.body);
      return { ok: true, status: 200, json: async () => ({ code: '80000000', requestId: 'request-1' }) };
    }
  });
  const targets = [{ id: 's1', secret: { token: 'device-1' } }, { id: 's2', secret: { token: 'device-2' } }];
  const result = await provider.send({ id: 'n1', title: '标题', body: '正文', type: 'system.test', data: {} }, targets, {
    projectId: 'project-1', serviceAccount: '{}'
  });

  assert.equal(capturedUrl, 'https://push-api.cloud.huawei.com/v3/project-1/messages:send');
  assert.deepEqual(capturedBody.target.token, ['device-1', 'device-2']);
  assert.deepEqual(result, [
    { targetId: 's1', status: 'sent', providerMessageId: 'request-1' },
    { targetId: 's2', status: 'sent', providerMessageId: 'request-1' }
  ]);
});

test('Huawei provider classifies rate limiting as retryable', () => {
  const provider = createHuaweiProvider({ fetch: async () => {} });
  assert.deepEqual(provider.normalizeError({ statusCode: 429, code: 'HTTP_429' }), {
    status: 'retryable', code: 'HTTP_429'
  });
});

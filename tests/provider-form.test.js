const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderDraft, canEnableProvider, validateProviderCredentials } = require('../web/src/services/provider-form.ts');

test('provider form uses schema fields and never places masked secrets in the draft', () => {
  const provider = {
    credentialSchema: [
      { key: 'projectId', label: 'Project ID', secret: false, required: true, control: 'text' },
      { key: 'serviceAccount', label: '服务账号 JSON', secret: true, required: true, control: 'textarea' },
    ],
    fields: {
      projectId: { configured: true, value: 'project-1' },
      serviceAccount: { configured: true, masked: '••••••' },
    },
  };

  assert.deepEqual(createProviderDraft(provider), { projectId: 'project-1', serviceAccount: '' });
});

test('provider can only be enabled after the current configuration passes health check', () => {
  assert.equal(canEnableProvider({ configured: true, healthStatus: 'healthy', configVersion: 3, testedVersion: 3 }), true);
  assert.equal(canEnableProvider({ configured: true, healthStatus: 'healthy', configVersion: 4, testedVersion: 3 }), false);
  assert.equal(canEnableProvider({ configured: true, healthStatus: 'failed', configVersion: 3, testedVersion: 3 }), false);
});

test('provider credential pre-check rejects agconnect-services.json pasted as service account', () => {
  const provider = {
    code: 'huawei',
    credentialSchema: [
      { key: 'projectId', label: 'Project ID', secret: false, required: true },
      { key: 'serviceAccount', label: '服务账号 JSON', secret: true, required: true },
    ],
  };
  const errors = validateProviderCredentials(provider, {
    projectId: '101653523864770079',
    serviceAccount: JSON.stringify({ agcgw: { url: 'x' }, client: {} }),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /agconnect-services\.json/);

  assert.deepEqual(validateProviderCredentials(provider, {
    projectId: '',
    serviceAccount: JSON.stringify({ key_id: 'k', sub_account: 'a', private_key: 'p' }),
  }), ['请填写Project ID']);

  assert.deepEqual(validateProviderCredentials(provider, {
    projectId: '101653523864770079',
    serviceAccount: JSON.stringify({ key_id: 'k', sub_account: 'a', private_key: 'p' }),
  }), []);
});

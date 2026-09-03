const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderDraft, canEnableProvider } = require('../web/src/services/provider-form.ts');

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

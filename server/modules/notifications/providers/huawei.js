const { createHash, sign, constants } = require('node:crypto');

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function parseServiceAccount(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function createHuaweiProvider(options = {}) {
  const request = options.fetch || fetch;
  const customAccessToken = options.getAccessToken;
  const tokenCache = new Map();

  async function validateConfig(config) {
    const serviceAccount = parseServiceAccount(config && config.serviceAccount);
    const ok = Boolean(
      config && String(config.projectId || '').trim() &&
      serviceAccount.key_id && serviceAccount.sub_account && serviceAccount.private_key
    );
    return ok ? { ok: true } : { ok: false, code: 'HUAWEI_CONFIG_INVALID' };
  }

  async function getAccessToken(config) {
    if (customAccessToken) return customAccessToken(config);
    const serviceAccount = parseServiceAccount(config.serviceAccount);
    const cacheKey = createHash('sha256').update(JSON.stringify(serviceAccount)).digest('hex');
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { kid: serviceAccount.key_id, typ: 'JWT', alg: 'PS256' };
    const payload = {
      aud: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
      iss: serviceAccount.sub_account,
      iat: nowSeconds,
      exp: nowSeconds + 3600
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: serviceAccount.private_key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    });
    const token = `${unsigned}.${signature.toString('base64url')}`;
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 55 * 60_000 });
    return token;
  }

  function normalizeError(error) {
    const statusCode = Number(error && (error.statusCode || error.status) || 0);
    const code = String((error && error.code) || (statusCode ? `HTTP_${statusCode}` : 'HUAWEI_REQUEST_FAILED'));
    if (statusCode === 429 || statusCode >= 500 || !statusCode) return { status: 'retryable', code };
    if (statusCode === 404 || statusCode === 410) return { status: 'invalid_target', code };
    return { status: 'failed', code };
  }

  return {
    code: 'huawei',
    displayName: '华为 Push Kit',
    platforms: ['harmonyos'],
    capabilities: { batch: true, maxBatchSize: 1000 },
    credentialSchema: [
      { key: 'projectId', label: 'Project ID', secret: false, required: true, control: 'text' },
      { key: 'serviceAccount', label: '服务账号 JSON', secret: true, required: true, control: 'textarea' }
    ],
    validateConfig,
    async healthCheck(config) {
      const validation = await validateConfig(config);
      if (!validation.ok) return validation;
      try {
        await getAccessToken(config);
        return { ok: true };
      } catch {
        return { ok: false, code: 'HUAWEI_CREDENTIAL_INVALID' };
      }
    },
    normalizeError,
    async send(message, targets, config) {
      const accessToken = await getAccessToken(config);
      const response = await request(`https://push-api.cloud.huawei.com/v3/${encodeURIComponent(config.projectId)}/messages:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'push-type': '0' },
        body: JSON.stringify({
          payload: {
            notification: {
              category: 'EXPRESS', title: message.title, body: message.body,
              clickAction: { actionType: 0 }
            },
            data: JSON.stringify({
              notificationId: message.id, type: message.type,
              title: message.title, body: message.body,
              resourceType: message.data.resourceType || '', resourceId: message.data.resourceId || ''
            })
          },
          target: { token: targets.map(target => target.secret.token) }
        })
      });
      if (!response.ok) {
        const error = new Error('华为推送网关请求失败');
        error.statusCode = response.status;
        error.code = `HTTP_${response.status}`;
        throw error;
      }
      const result = await response.json();
      if (result.code !== '80000000') {
        return targets.map(target => ({ targetId: target.id, status: 'failed', code: String(result.code || 'HUAWEI_REJECTED') }));
      }
      return targets.map(target => ({
        targetId: target.id,
        status: 'sent',
        providerMessageId: String(result.requestId || result.request_id || '')
      }));
    }
  };
}

module.exports = { createHuaweiProvider };

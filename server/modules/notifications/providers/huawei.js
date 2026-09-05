const { createHash, sign, constants } = require('node:crypto');

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function parseServiceAccount(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function serviceAccountProblem(raw) {
  let parsed = null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return '服务账号 JSON 为空';
    try {
      parsed = JSON.parse(text);
    } catch {
      return '服务账号 JSON 不是有效的 JSON 文本';
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw;
  } else {
    return '服务账号 JSON 缺失';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '服务账号 JSON 必须是 JSON 对象（包含 key_id、sub_account、private_key 字段）';
  }
  const looksLikeAgconnect = parsed && typeof parsed === 'object' &&
    (parsed.agcgw || parsed.appInfos || parsed.oauth_client);
  if (looksLikeAgconnect) {
    return '检测到内容像是 agconnect-services.json（AGC 工程配置）。请粘贴 AGC「项目设置 → 服务账号」下载的 JSON，其中包含 key_id、sub_account、private_key 字段';
  }
  const missing = ['key_id', 'sub_account', 'private_key']
    .filter(key => !(parsed && typeof parsed[key] === 'string' && parsed[key].trim()));
  if (missing.length) {
    return `服务账号 JSON 缺少字段：${missing.join('、')}。请粘贴 AGC「项目设置 → 服务账号」下载的 JSON`;
  }
  return '';
}

function createHuaweiProvider(options = {}) {
  const request = options.fetch || fetch;
  const customAccessToken = options.getAccessToken;
  const tokenCache = new Map();

  async function validateConfig(config) {
    const projectId = String((config && config.projectId) || '').trim();
    if (!projectId) return { ok: false, code: 'HUAWEI_CONFIG_INVALID', message: '缺少 Project ID（应为 AGC 项目 ID，如 101653523864770079）' };
    const problem = serviceAccountProblem(config && config.serviceAccount);
    if (problem) return { ok: false, code: 'HUAWEI_CONFIG_INVALID', message: problem };
    return { ok: true };
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
      { key: 'projectId', label: 'Project ID', secret: false, required: true, control: 'text',
        hint: 'AGC 项目 ID（项目设置 → 常规信息），不是 cp_id。本应用为 101653523864770079' },
      { key: 'serviceAccount', label: '服务账号 JSON', secret: true, required: true, control: 'textarea',
        hint: '粘贴 AGC「项目设置 → 服务账号」下载的 JSON（含 key_id、sub_account、private_key）。不要把 AppScope/agconnect-services.json 工程配置贴进来' }
    ],
    validateConfig,
    async healthCheck(config) {
      const validation = await validateConfig(config);
      if (!validation.ok) return validation;
      try {
        await getAccessToken(config);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: 'HUAWEI_CREDENTIAL_INVALID',
          message: `凭据校验失败：无法用 private_key 签发访问令牌（${(error && error.message || '未知错误').split('\n')[0]}）`
        };
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
              // category 必须与 AGC「自分类权益」获批分类一致（本项目为“工作事项提醒”→ WORK）。
              // 分类不匹配时华为会把通知降级为资讯营销提醒方式（只进通知栏、息屏不响不振）。
              category: 'WORK', title: message.title, body: message.body,
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
        try {
          const detail = await response.clone().text();
          if (detail) error.message = `${error.message}：${detail.slice(0, 300)}`;
        } catch {}
        throw error;
      }
      const result = await response.json();
      if (result.code !== '80000000') {
        if (String(result.code) === '80300007') {
          return targets.map(target => ({ targetId: target.id, status: 'invalid_target', code: 'HUAWEI_TOKEN_INVALID' }));
        }
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

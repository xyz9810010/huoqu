const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'ticket',
  'authorization',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey'
]);

function redactUrl(rawUrl) {
  const url = new URL(String(rawUrl || '/'), 'http://request.local');
  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.pathname + url.search;
}

function createRequestLogger(options = {}) {
  const write = options.write || console.log;
  const now = options.now || (() => new Date());
  return function requestLogger(req, res, next) {
    const time = now().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    const ip = String(req.ip || '').replace('::ffff:', '');
    write(`[${time}] ${ip} ${req.method || ''} ${redactUrl(req.originalUrl || req.url || '/')}`);
    next();
  };
}

module.exports = { createRequestLogger, redactUrl };

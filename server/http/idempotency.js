// 单据创建幂等：客户端（Web / 安卓 / 鸿蒙原生端）在“新建取件订单/任务”这类请求上携带
// X-Idempotency-Key（或 Idempotency-Key），窗口内同用户同键的重复请求回放首次成功响应，
// 避免断网重试、双击提交产生重复单据。未带键的请求不做任何去重，
// 不影响“再次取件”等需要真实重复创建的业务语义。
'use strict';

const WINDOW_MS = 10 * 60 * 1000; // 10 分钟幂等窗口
const MAX_KEY_LENGTH = 128;
const store = new Map();
let lastSweepAt = 0;

function sweep(now) {
  if (now - lastSweepAt < 60 * 1000) return;
  lastSweepAt = now;
  for (const [cacheKey, entry] of store) {
    if (now - entry.at > WINDOW_MS) store.delete(cacheKey);
  }
}

function withIdempotency(handler) {
  return (req, res) => {
    const key = String(
      req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || ''
    ).trim();
    if (!key || key.length > MAX_KEY_LENGTH) return handler(req, res);
    const userId = (req.user && req.user.id) || 'anon';
    const cacheKey = `${userId}:${key}`;
    const now = Date.now();
    const hit = store.get(cacheKey);
    if (hit && now - hit.at <= WINDOW_MS) {
      return res.status(hit.statusCode).json(hit.body);
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        sweep(now);
        store.set(cacheKey, { statusCode: res.statusCode || 200, body, at: now });
      }
      return originalJson(body);
    };
    handler(req, res);
  };
}

module.exports = { withIdempotency };

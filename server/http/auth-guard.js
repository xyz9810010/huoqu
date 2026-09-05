// 鉴权中间件（v1 / v2 路由共用）
const auth = require('../../auth');

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token ? auth.findSession(token) : null;
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  req.token = token;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
function requireStaff(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'cs') return res.status(403).json({ error: '需要管理员或客服权限' });
  next();
}

module.exports = { requireAuth, requireAdmin, requireStaff };

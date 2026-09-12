const { randomUUID } = require('node:crypto');

const ROLES = ['admin', 'cs', 'courier'];
const STATUSES = ['active', 'disabled'];
const MIN_PASSWORD_LENGTH = 6;

/**
 * 员工账号（users + 取件员档案）的 v1/v2 共用逻辑。
 *
 * 角色只接受 canonical 值 `admin|cs|courier`；Web 旧入口的 `boss`/`worker`
 * 别名由 v1 路由自己转换，避免把历史命名写进新接口。
 */
function createEmployeeService(db, auth, now) {
  const findUser = db.prepare('SELECT * FROM users WHERE id=?');

  function view(user) {
    const courier = user.courier_id
      ? db.prepare('SELECT * FROM couriers WHERE id=?').get(user.courier_id)
      : null;
    return {
      id: user.id,
      username: user.username,
      name: user.name || courier?.name || '',
      phone: user.phone || '',
      employeeNo: user.employee_no || '',
      role: user.role,
      status: user.status || 'active',
      courierId: user.courier_id || '',
      region: courier?.region || ''
    };
  }

  function list(role = '') {
    const wanted = String(role || '').trim();
    return db.prepare('SELECT * FROM users ORDER BY role,name').all()
      .filter(user => !wanted || user.role === wanted)
      .map(view);
  }

  function create(input = {}) {
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    const name = String(input.name || '').trim();
    const role = String(input.role || '');
    if (!username || !name) return { error: '用户名和姓名不能为空' };
    if (password.length < MIN_PASSWORD_LENGTH) return { error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
    if (!ROLES.includes(role)) return { error: '角色不正确' };
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
      return { error: '用户名已存在' };
    }

    const userId = randomUUID();
    const courierId = role === 'courier' ? randomUUID() : '';
    const salt = auth.createSalt();
    db.transaction(() => {
      if (courierId) {
        db.prepare('INSERT INTO couriers (id,name,region) VALUES (?,?,?)')
          .run(courierId, name, String(input.region || '').trim());
      }
      db.prepare(`INSERT INTO users (id,username,password_hash,salt,role,courier_id,name,phone,employee_no,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'active',?)`).run(
        userId, username, auth.hashPassword(password, salt), salt, role, courierId || null,
        name, String(input.phone || '').trim(), String(input.employeeNo || '').trim(), now()
      );
    })();
    return { data: view(findUser.get(userId)), created: true };
  }

  function update(userId, input = {}) {
    const current = findUser.get(userId);
    if (!current) return { error: '员工不存在', status: 404 };
    const role = input.role == null ? current.role : String(input.role);
    if (!ROLES.includes(role)) return { error: '角色不正确' };

    const name = String(input.name == null ? (current.name || '') : input.name).trim();
    if (!name) return { error: '姓名不能为空' };
    const phone = String(input.phone == null ? (current.phone || '') : input.phone).trim();
    const employeeNo = String(input.employeeNo == null ? (current.employee_no || '') : input.employeeNo).trim();

    let courierId = current.courier_id || '';
    const newCourierId = role === 'courier' && !courierId ? randomUUID() : '';
    if (newCourierId) courierId = newCourierId;

    const password = String(input.password || '');
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      return { error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
    }

    db.transaction(() => {
      if (newCourierId) {
        db.prepare('INSERT INTO couriers (id,name,region) VALUES (?,?,?)')
          .run(newCourierId, name, String(input.region || '').trim());
      }
      db.prepare('UPDATE users SET name=?,phone=?,employee_no=?,role=?,courier_id=? WHERE id=?')
        .run(name, phone, employeeNo, role, courierId || null, current.id);
      if (courierId) {
        const region = input.region == null ? null : String(input.region).trim();
        if (region == null) db.prepare('UPDATE couriers SET name=? WHERE id=?').run(name, courierId);
        else db.prepare('UPDATE couriers SET name=?,region=? WHERE id=?').run(name, region, courierId);
      }
      if (password) {
        const salt = auth.createSalt();
        db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?')
          .run(auth.hashPassword(password, salt), salt, current.id);
      }
    })();
    return { data: view(findUser.get(current.id)) };
  }

  /**
   * 启停账号。
   *
   * 额外两条保护（v1 没有，但 Android 管理页会出现）：
   * - 不能停用自己，避免管理员把自己锁在门外；
   * - 不能停用最后一个可用管理员。
   */
  function setStatus(userId, nextStatus, actor = {}) {
    const status = String(nextStatus || '');
    if (!STATUSES.includes(status)) return { error: '状态不正确' };
    const current = findUser.get(userId);
    if (!current) return { error: '员工不存在', status: 404 };
    if (actor.id && actor.id === current.id && status === 'disabled') {
      return { error: '不能停用当前登录的账号' };
    }
    if (status === 'disabled' && current.role === 'admin') {
      const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND COALESCE(status,'active')='active'").get().n;
      if (activeAdmins <= 1) return { error: '系统至少需要保留一个启用的管理员' };
    }
    db.prepare('UPDATE users SET status=? WHERE id=?').run(status, current.id);
    return { data: view(findUser.get(current.id)) };
  }

  return { list, create, update, setStatus, view };
}

module.exports = { createEmployeeService, EMPLOYEE_ROLES: ROLES };

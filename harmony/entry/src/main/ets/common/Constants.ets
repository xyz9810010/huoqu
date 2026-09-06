// 全局常量与业务工具函数
export class Constants {
  static readonly DEFAULT_BASE_URL: string = 'http://192.168.5.83:3000';
  // 图片服务器 https 地址（Image 组件默认禁止加载 http 明文图片，图片统一走 https）
  static readonly IMAGE_BASE_URL: string = 'https://qj.9810010.xyz:1666';
  static readonly STORAGE_TOKEN: string = 'token';
  static readonly STORAGE_USER: string = 'userJson';
  static readonly STORAGE_BASE_URL: string = 'baseUrl';
}

// 服务器地址规范化：容错处理 http: / 少 // / 末尾斜杠
export function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  while (u.length > 1 && u.endsWith('/')) {
    u = u.substring(0, u.length - 1);
  }
  if (u.startsWith('http://') || u.startsWith('https://')) {
    return u;
  }
  if (u.startsWith('http:')) {
    return 'http://' + u.substring(5);
  }
  if (u.startsWith('https:')) {
    return 'https://' + u.substring(6);
  }
  return 'http://' + u;
}

// 后端 role -> 前端角色归一化
export function normalizeRole(role: string): string {
  if (role === 'courier') {
    return 'worker';
  }
  if (role === 'boss') {
    return 'admin';
  }
  return role;
}

export function isStaff(role: string): boolean {
  return role === 'admin' || role === 'cs';
}

export function homePageForRole(role: string): string {
  const normalized = normalizeRole(role);
  if (normalized === 'worker') {
    return 'pages/WorkerTabPage';
  }
  if (normalized === 'cs') {
    return 'pages/TasksPage';
  }
  return 'pages/DashboardPage';
}

// 任务状态
export class TaskStatus {
  static readonly PENDING: string = 'pending';
  static readonly IN_PROGRESS: string = 'in_progress';
  static readonly COMPLETED: string = 'completed';
  static readonly CANCELLED: string = 'cancelled';
}

export function taskStatusLabel(status: string): string {
  if (status === 'pending') {
    return '待取';
  }
  if (status === 'in_progress') {
    return '取件中';
  }
  if (status === 'completed') {
    return '已完成';
  }
  if (status === 'cancelled') {
    return '已取消';
  }
  return status;
}

export function taskTypeLabel(taskType: string): string {
  if (taskType === 'scheduled') {
    return '指定时间';
  }
  if (taskType === 'rush') {
    return '赶出货';
  }
  return '普通';
}

export function matchStatusLabel(matchStatus: string): string {
  if (matchStatus === 'matched') {
    return '已匹配';
  }
  if (matchStatus === 'no_waybill') {
    return '无面单';
  }
  return '待匹配';
}

export function entryMethodLabel(entryMethod: string): string {
  if (entryMethod === 'scan') {
    return '扫码';
  }
  if (entryMethod === 'no_waybill') {
    return '无面单';
  }
  return '手动';
}

// 格式化时间：后端返回 'YYYY-MM-DD HH:mm:ss'，截取到分钟
export function fmtTime(s: string): string {
  if (s === '') {
    return '';
  }
  let t = s;
  t = t.replace('T', ' ');
  if (t.length > 16) {
    t = t.substring(0, 16);
  }
  return t;
}

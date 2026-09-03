export function normalizeRole(role: string): string {
  if (role === 'courier') return 'worker'
  if (role === 'boss') return 'admin'
  return role || ''
}

export function taskStatusLabel(status: string): string {
  return {
    pending: '待取',
    in_progress: '取件中',
    completed: '已完成',
    cancelled: '已取消',
  }[status] || status
}

export function taskStatusType(status: string): string {
  return {
    pending: 'warning',
    in_progress: 'primary',
    completed: 'success',
    cancelled: 'info',
  }[status] || 'info'
}

export function unwrapResponse(body: any): any {
  if (body && typeof body === 'object' && 'code' in body) {
    if (body.code === 0) return body.data
    throw new Error(body.message || body.error || '请求失败')
  }
  if (body && typeof body === 'object' && 'data' in body) {
    const keys = Object.keys(body)
    if (keys.every((key) => ['data', 'meta', 'requestId'].includes(key))) return body.data
  }
  return body
}

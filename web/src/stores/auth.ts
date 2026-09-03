import { defineStore } from 'pinia'
import http from '../api'
import { normalizeRole } from '../api-contract'

function savedUser() {
  const user = JSON.parse(localStorage.getItem('user') || 'null') as any
  if (user) user.role = normalizeRole(user.role)
  return user
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    user: savedUser(),
  }),
  getters: {
    role: (s) => s.user?.role || '',
    isLoggedIn: (s) => !!s.token,
  },
  actions: {
    async login(username: string, password: string) {
      const data: any = await http.post('/login', { username, password })
      this.token = data.token
      this.user = { ...data.user, role: normalizeRole(data.user?.role) }
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(this.user))
    },
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem('token')
      localStorage.removeItem('user')
    },
  },
})

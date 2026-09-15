import axios from 'axios'
import { ElMessage } from 'element-plus'
import 'element-plus/es/components/message/style/css'
import router from './router'
import { unwrapResponse } from './api-contract'

const http = axios.create({ baseURL: '/api', timeout: 60000 })

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

http.interceptors.response.use(
  (res: any) => {
    try {
      return unwrapResponse(res.data)
    } catch (error: any) {
      ElMessage.error(error.message || '请求失败')
      return Promise.reject(error)
    }
  },
  (err: any) => {
    const status = err.response?.status
    // 无 response = 断网 / 超时 / DNS 失败。axios 原生文案是英文 "Network Error"，
    // 对仓库里弱网作业的取件员没有指导意义，这里换成能照做的中文提示。
    const offline = !err.response
    const msg = err.response?.data?.error || err.response?.data?.message
      || (offline ? '网络连接失败，请检查网络或稍后重试' : err.message)
      || '请求失败'
    if (status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      router.push('/login')
    }
    ElMessage.error(msg)
    return Promise.reject(err)
  },
)

export default http

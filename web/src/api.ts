import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from './router'
import { unwrapResponse } from './api-contract'

const http = axios.create({ baseURL: '/api', timeout: 20000 })

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
    const msg = err.response?.data?.error || err.response?.data?.message || err.message || '网络错误'
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

import { ref } from 'vue'
import http from '../api'

export const unreadCount = ref(0)

export async function refreshUnread() {
  try {
    const result = await http.get<any, { count: number }>('/v1/notifications/unread-count')
    unreadCount.value = result.count
  } catch {
    /* ignore */
  }
}

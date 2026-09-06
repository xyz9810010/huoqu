<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="logo">
        <div class="logo-mark"><el-icon :size="18"><Van /></el-icon></div>
        <span>Huoqu</span>
      </div>
      <el-menu :default-active="route.path" router class="menu">
        <template v-for="m in menus" :key="m.path">
          <el-menu-item :index="m.path">
            <el-icon><component :is="m.icon" /></el-icon>
            <span>{{ m.label }}</span>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>

    <el-container class="body">
      <el-header class="header">
        <div class="header-left">
          <el-button class="mobile-menu-trigger" circle aria-label="打开导航菜单" @click="mobileMenuOpen = true">
            <el-icon><Menu /></el-icon>
          </el-button>
          <span class="crumb">{{ currentTitle }}</span>
        </div>
        <div class="header-right">
          <el-button circle class="shortcut-help" aria-label="快捷键帮助" @click="showShortcutHelp">
            <el-icon><QuestionFilled /></el-icon>
          </el-button>
          <el-badge :value="unreadCount" :hidden="unreadCount === 0" :max="99">
            <el-button circle class="bell" @click="router.push('/notifications')">
              <el-icon><Bell /></el-icon>
            </el-button>
          </el-badge>
          <div class="latency" :class="{ 'is-online': connected }">
            <span class="latency-dot" />
            <span class="latency-text">{{ latency >= 0 ? latency + ' ms' : '连接中…' }}</span>
          </div>
          <el-dropdown trigger="click" @command="onCommand">
            <div class="user-box">
              <div class="avatar">{{ (auth.user?.name || '?').slice(0, 1) }}</div>
              <span class="name">{{ auth.user?.name }}</span>
              <el-icon class="caret"><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main">
        <div class="page">
          <router-view />
        </div>
      </el-main>
    </el-container>

    <el-drawer v-model="mobileMenuOpen" direction="ltr" size="264px" :with-header="false" class="mobile-nav-drawer">
      <div class="logo mobile-logo">
        <div class="logo-mark"><el-icon :size="18"><Van /></el-icon></div>
        <span>Huoqu</span>
      </div>
      <el-menu :default-active="route.path" router class="menu mobile-menu" @select="mobileMenuOpen = false">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-drawer>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox, ElNotification } from 'element-plus'
import 'element-plus/es/components/notification/style/css'
import { useAuthStore } from '../stores/auth'
import { unreadCount, refreshUnread } from '../stores/notif'
import {
  createRealtimeEventClient,
  notificationFromRealtimeEvent,
  realtimeEventHub,
} from '../services/realtime-events'
import { notificationSound } from '../services/notification-sound'
import http from '../api'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const mobileMenuOpen = ref(false)
const latency = ref<number>(-1)
const connected = ref(false)
let heartbeatTimer: number | undefined

const allMenus: any[] = [
  { path: '/dashboard', label: '数据看板', icon: 'DataBoard', roles: ['boss', 'admin'] },
  { path: '/customers', label: '客户管理', icon: 'User', roles: ['cs', 'admin', 'boss'] },
  { path: '/dispatch', label: '新建取件', icon: 'Plus', roles: ['cs', 'admin'] },
  { path: '/tasks', label: '取件任务', icon: 'List', roles: ['cs', 'admin', 'boss'] },
  { path: '/match-center', label: '待匹配中心', icon: 'Link', roles: ['cs', 'admin'] },
  { path: '/worker/tasks', label: '我的任务', icon: 'Van', roles: ['worker'] },
  { path: '/my-data', label: '我的数据', icon: 'TrendCharts', roles: ['worker'] },
  { path: '/areas', label: '区域管理', icon: 'MapLocation', roles: ['admin'] },
  { path: '/employees', label: '员工管理', icon: 'UserFilled', roles: ['admin'] },
  { path: '/logs', label: '操作日志', icon: 'Document', roles: ['admin'] },
  { path: '/push-providers', label: '消息推送', icon: 'Connection', roles: ['admin'] },
  { path: '/notifications', label: '通知中心', icon: 'Bell', roles: ['boss', 'cs', 'worker', 'admin'] },
]

const menus = computed(() => allMenus.filter((m) => m.roles.includes(auth.role)))
const currentTitle = computed(() => String(route.meta.title || menus.value.find((m) => m.path === route.path)?.label || ''))

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    auth.logout()
    router.push('/login')
  }
}

// 键盘快捷键（桌面端高频操作）
const shortcutDefs: { key: string; label: string; path: string; roles: string[] }[] = [
  { key: 'x', label: '新建取件', path: '/dispatch', roles: ['cs', 'admin'] },
  { key: 'q', label: '取件任务', path: '/tasks', roles: ['cs', 'admin', 'boss'] },
  { key: 'k', label: '客户管理', path: '/customers', roles: ['cs', 'admin', 'boss'] },
  { key: 's', label: '数据看板', path: '/dashboard', roles: ['admin', 'boss'] },
]
function showShortcutHelp() {
  const kbd = 'display:inline-block;min-width:24px;text-align:center;padding:2px 8px;border:1px solid #d0d5dd;border-bottom-width:2px;border-radius:6px;background:#f7f8fa;font-family:ui-monospace,monospace;font-weight:600;color:#182431'
  const rows = shortcutDefs
    .filter((s) => s.roles.includes(auth.role))
    .map((s) => '<tr><td style="padding:6px 0"><kbd style="' + kbd + '">' + s.key.toUpperCase() + '</kbd></td><td style="padding:6px 8px">' + s.label + '</td></tr>')
    .join('')
  const html = '<div style="line-height:1.8">'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px">' + rows + '</table>'
    + '<div style="margin-top:12px;font-size:12px;color:#86909c;border-top:1px solid #f0f0f0;padding-top:10px">'
    + '<div>仓库地址：<a href="https://github.com/xyz9810010/huoqu" target="_blank" style="color:#0a59f7;text-decoration:none">github.com/xyz9810010/huoqu</a></div>'
    + '<div>实例地址：<a href="https://huoqu.onrender.com" target="_blank" style="color:#0a59f7;text-decoration:none">huoqu.onrender.com</a></div>'
    + '<div style="margin-top:8px">按 <kbd style="' + kbd + '">?</kbd> 查看帮助 · 输入框内输入时不触发快捷键</div>'
    + '</div>'
    + '</div>'
  ElMessageBox.alert(html, '帮助', {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '知道了',
  }).catch(() => {})
}
function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const tag = target?.tagName || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === '?') {
    e.preventDefault()
    showShortcutHelp()
    return
  }
  const hit = shortcutDefs.find((s) => s.key === key && s.roles.includes(auth.role))
  if (hit) {
    e.preventDefault()
    router.push(hit.path)
  }
}

async function loadUnread() {
  await refreshUnread()
}

// 实时心跳：探测服务端延迟（用原生 fetch 绕过 axios 拦截器，避免离线时反复弹错）
async function heartbeat() {
  const start = performance.now()
  try {
    const resp = await fetch('/api/health')
    if (!resp.ok) throw new Error('bad status')
    latency.value = Math.max(0, Math.round(performance.now() - start))
    connected.value = true
  } catch {
    latency.value = -1
    connected.value = false
  }
}

function handleRealtimeEvent(message: unknown) {
  if (!realtimeEventHub.publish(message)) return
  const notification = notificationFromRealtimeEvent(message)
  if (!notification) return
  notificationSound.play()
  const targetRoute = typeof notification.data.route === 'string' ? notification.data.route : ''
  ElNotification({
    title: notification.title,
    message: notification.body,
    type: notification.priority === 'high' ? 'warning' : 'info',
    duration: 6000,
    onClick: () => {
      if (targetRoute.startsWith('/') && !targetRoute.startsWith('//')) router.push(targetRoute)
    },
  })
  void refreshUnread()
}

function onServiceWorkerMessage(event: MessageEvent) {
  handleRealtimeEvent(event.data)
}

const realtime = createRealtimeEventClient({
  issueTicket: async () => {
    const issued: { ticket: string } = await http.post('/v1/events/tickets')
    return issued.ticket
  },
  createEventSource: (url) => new EventSource(url),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancelSchedule: (handle) => window.clearTimeout(handle),
  onMessage: (ev) => {
    try {
      handleRealtimeEvent(JSON.parse(ev.data))
    } catch {
      /* ignore */
    }
  },
})

onMounted(() => {
  loadUnread()
  navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
  realtime.start().catch(() => {
    /* API 层已经展示连接错误，页面其余功能保持可用 */
  })
  heartbeat()
  heartbeatTimer = window.setInterval(heartbeat, 5000)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
  realtime.stop()
  window.clearInterval(heartbeatTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.layout {
  height: 100%;
}
.aside {
  background: var(--qj-side);
  border-right: 1px solid var(--qj-border);
  display: flex;
  flex-direction: column;
}
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 20px;
  border-bottom: 1px solid var(--qj-border);
}
.logo-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.logo span {
  font-size: 15px;
  font-weight: 600;
  color: var(--qj-text);
}
.menu {
  flex: 1;
  border-right: none;
  padding: 8px;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: transparent;
}
.menu :deep(.el-menu-item) {
  height: 42px;
  border-radius: 8px;
  margin-bottom: 2px;
  color: var(--qj-text-2);
  font-size: 14px;
}
.menu :deep(.el-menu-item:hover) {
  background: #f2f3f5;
  color: var(--qj-text);
}
.menu :deep(.el-menu-item.is-active) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}
.menu :deep(.el-menu-item.is-active .el-icon) {
  color: var(--el-color-primary);
}
.body {
  background: var(--qj-bg);
}
.header {
  height: 60px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--qj-border);
}
.header-left .crumb {
  font-size: 16px;
  font-weight: 600;
  color: var(--qj-text);
}
.header-left {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}
.mobile-menu-trigger {
  display: none;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.latency {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--qj-muted);
  white-space: nowrap;
}
.latency-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c9cdd4;
}
.latency.is-online .latency-dot {
  background: #00b42a;
}
.latency.is-online .latency-text {
  color: #00b42a;
}
.bell, .shortcut-help {
  border: 1px solid var(--qj-border);
  background: #fff;
  color: var(--qj-text-2);
}
.shortcut-help:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
.bell:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
.user-box {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
}
.user-box:hover {
  background: #f2f3f5;
}
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
}
.name {
  font-size: 14px;
  color: var(--qj-text);
}
.caret {
  color: var(--qj-muted);
  font-size: 12px;
}
.main {
  padding: 20px 24px;
  overflow-y: auto;
}
.mobile-nav-drawer :deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--qj-side);
}
.mobile-logo {
  flex: none;
}
.mobile-menu {
  overflow-y: auto;
}
@media (max-width: 768px) {
  .layout, .body {
    min-width: 0;
  }
  .aside {
    display: none;
  }
  .header {
    height: 56px;
    padding: 0 12px;
  }
  .mobile-menu-trigger {
    display: inline-flex;
  }
  .crumb {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .header-right {
    gap: 8px;
  }
  .header-right .name, .header-right .caret {
    display: none;
  }
  .user-box {
    padding: 2px;
  }
  .main {
    padding: 14px 12px;
  }
}
</style>

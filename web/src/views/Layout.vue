<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="logo">
        <div class="logo-mark"><el-icon :size="18"><Van /></el-icon></div>
        <span>Huoqu</span>
      </div>
      <el-menu :default-active="route.path" router class="menu">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="body">
      <!-- 极简顶栏：页面标题由内容区的吸顶页头承担，避免两处重复 -->
      <el-header class="header">
        <div class="header-left">
          <el-button class="mobile-menu-trigger" circle aria-label="打开导航菜单" @click="mobileMenuOpen = true">
            <el-icon><Menu /></el-icon>
          </el-button>
        </div>
        <div class="header-right">
          <el-button circle class="shortcut-help" aria-label="快捷键帮助" @click="showShortcutHelp">
            <el-icon><QuestionFilled /></el-icon>
          </el-button>
          <el-badge :value="unreadCount" :hidden="unreadCount === 0" :max="99">
            <el-button circle class="bell" aria-label="通知中心" @click="router.push('/notifications')">
              <el-icon><Bell /></el-icon>
            </el-button>
          </el-badge>
          <div class="latency" :class="{ 'is-online': connected }" role="status"
               :aria-label="connected ? '服务连接正常，延迟 ' + latency + ' 毫秒' : '正在连接服务'">
            <span class="latency-dot" />
            <span class="latency-text">{{ connected ? latency + ' ms' : '连接中…' }}</span>
          </div>
          <el-dropdown trigger="click" @command="onCommand">
            <div class="user-box" role="button" tabindex="0" :aria-label="'账号菜单：' + (auth.user?.name || '')">
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

    <el-drawer v-model="mobileMenuOpen" direction="ltr" size="272px" :with-header="false" class="mobile-nav-drawer">
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

    <el-dialog v-model="helpVisible" title="帮助" width="440px" class="help-dialog">
      <div class="help-shortcuts">
        <div v-for="s in visibleShortcuts" :key="s.key" class="help-row">
          <kbd class="help-kbd">{{ s.key.toUpperCase() }}</kbd>
          <span class="help-row-label">{{ s.label }}</span>
        </div>
      </div>
      <el-divider content-position="left">信息</el-divider>
      <div class="help-info">
        <div class="help-row">
          <span class="help-label">仓库地址</span>
          <span class="help-copy" title="点击打开新标签页" @click="openUrl('https://github.com/xyz9810010/huoqu')">github.com/xyz9810010/huoqu ↗</span>
        </div>
        <div class="help-row">
          <span class="help-label">实例地址</span>
          <span class="help-copy" title="点击打开新标签页" @click="openUrl('https://huoqu.onrender.com')">huoqu.onrender.com ↗</span>
        </div>
        <div class="help-row">
          <span class="help-label">实例账号</span>
          <span class="help-copy" title="点击复制" @click="copyText('admin')">admin</span>
        </div>
        <div class="help-row">
          <span class="help-label">实例密码</span>
          <span class="help-note">见部署配置的 INITIAL_ADMIN_PASSWORD（不在此处展示）</span>
        </div>
      </div>
      <div class="help-tip">点击地址 / 账号即可复制 · 输入框内输入时不触发快捷键</div>
      <template #footer>
        <el-button type="primary" @click="helpVisible = false">知道了</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElNotification } from 'element-plus'
import 'element-plus/es/components/notification/style/css'
import { useAuthStore } from '../stores/auth'
import { unreadCount, refreshUnread } from '../stores/notif'
import {
  createRealtimeEventClient,
  notificationFromRealtimeEvent,
  realtimeEventHub,
} from '../services/realtime-events'
import { notificationSound } from '../services/notification-sound'
import { autoRepairBrowserPush } from '../services/browser-push'
import http from '../api'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const mobileMenuOpen = ref(false)
const helpVisible = ref(false)
const latency = ref<number>(-1)
const connected = ref(false)
let heartbeatTimer: number | undefined
let syncTimer: number | undefined

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
const visibleShortcuts = computed(() => shortcutDefs.filter((s) => s.roles.includes(auth.role)))
function showShortcutHelp() {
  helpVisible.value = true
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  ElMessage.success('已复制：' + text)
}
function openUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
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

// 兜底同步：SSE 断开期间错过的通知，定时拉取未读补弹（去重由 realtimeEventHub 保证）
async function syncNotifications() {
  try {
    const result = await http.get<any, { items: any[] }>('/v1/notifications', { params: { unread: 'true', pageSize: 30 } })
    const items = Array.isArray(result?.items) ? result.items : []
    for (const item of items) {
      handleRealtimeEvent({ type: 'notification.created', data: { notification: item } })
    }
  } catch {
    /* ignore */
  }
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
  void autoRepairBrowserPush()
  navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
  realtime.start().catch(() => {
    /* API 层已经展示连接错误，页面其余功能保持可用 */
  })
  // 基线：把当前未读标记为已见（避免刷新后补弹历史通知），随后开启兜底轮询补发错过的通知
  void (async () => {
    try {
      const result = await http.get<any, { items: any[] }>('/v1/notifications', { params: { unread: 'true', pageSize: 30 } })
      realtimeEventHub.markSeen((Array.isArray(result?.items) ? result.items : []).map((i: any) => i.id))
    } catch {
      /* ignore */
    }
    syncTimer = window.setInterval(syncNotifications, 15000)
  })()
  heartbeat()
  heartbeatTimer = window.setInterval(heartbeat, 5000)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
  realtime.stop()
  window.clearInterval(heartbeatTimer)
  if (syncTimer !== undefined) window.clearInterval(syncTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.layout {
  height: 100%;
}
/* ===== 浅色操作台：左侧导航 =====
 * 不使用大面积深色（长时间阅读易疲劳）：靠结构线 + 青色指示做出秩序感。
 */
.aside {
  background-color: var(--qj-chrome);
  background-image: var(--qj-grid-chrome);
  background-size: var(--qj-grid-size);
  border-right: 1px solid var(--qj-chrome-border);
  display: flex;
  flex-direction: column;
}
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid var(--qj-chrome-border);
}
.logo-mark {
  width: 32px;
  height: 32px;
  border-radius: var(--r-control);
  /* 青色渐变品牌块：点睛色唯一的大面积出现处 */
  background: linear-gradient(140deg, var(--qj-accent-bright) 0%, var(--qj-accent-strong) 55%, #155e75 100%);
  color: #04121a;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 1px rgba(8, 145, 178, 0.22), 0 3px 10px rgba(8, 145, 178, 0.22);
}
.logo span {
  font-size: var(--fs-card);
  font-weight: 600;
  color: var(--qj-chrome-text-strong);
  letter-spacing: 0.4px;
}
.menu {
  flex: 1;
  border-right: none;
  padding: 10px 8px;
  overflow-y: auto;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: transparent;
  --el-menu-text-color: var(--qj-chrome-text);
  --el-menu-active-color: var(--qj-chrome-active-text);
}
.menu :deep(.el-menu-item) {
  height: 42px;
  border-radius: var(--r-control);
  margin-bottom: 2px;
  color: var(--qj-chrome-text);
  font-size: var(--fs-body);
  transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.menu :deep(.el-menu-item .el-icon) {
  color: var(--qj-chrome-text-dim);
  transition: color var(--dur-fast) var(--ease);
}
.menu :deep(.el-menu-item:hover) {
  background: var(--qj-chrome-hover);
  color: var(--qj-chrome-text-strong);
}
.menu :deep(.el-menu-item:hover .el-icon) {
  color: var(--qj-accent);
}
.menu :deep(.el-menu-item.is-active) {
  /* 激活态：淡青底 + 深青文字 + 左侧 3px 青色指示条 */
  background: var(--qj-chrome-active-bg);
  color: var(--qj-chrome-active-text);
  font-weight: 600;
  box-shadow: var(--qj-chrome-glow);
}
.menu :deep(.el-menu-item.is-active .el-icon) {
  color: var(--qj-chrome-active-icon);
}
.menu :deep(.el-menu-item:focus-visible) {
  box-shadow: var(--qj-focus);
}
.body {
  background: transparent;
}
/* ===== 顶栏：深色细条（仪表盘质感；深色只占这一条）===== */
.header {
  height: 56px;
  background-color: var(--qj-bar);
  background-image: linear-gradient(180deg, var(--qj-bar-2) 0%, var(--qj-bar) 100%);
  border-bottom: 1px solid var(--qj-bar-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-6);
}
.header-left {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: var(--sp-2);
}
.mobile-menu-trigger {
  display: none;
}
.header-right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
/* 深色顶栏内的键盘焦点用亮青环，保证可见 */
.header :deep(.el-button:focus-visible),
.header .user-box:focus-visible {
  box-shadow: var(--qj-focus-chrome);
}
.latency {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  color: var(--qj-bar-text);
  white-space: nowrap;
}
.latency-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--qj-bar-border);
}
.latency.is-online .latency-dot {
  background: var(--qj-bar-accent);
  box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.16);
  animation: qj-pulse 2.6s var(--ease) infinite;
}
.latency.is-online .latency-text {
  color: var(--qj-bar-accent-2);
}
@keyframes qj-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.16); }
  50% { box-shadow: 0 0 0 6px rgba(34, 211, 238, 0.06); }
}
.bell,
.shortcut-help {
  border: 1px solid var(--qj-bar-border);
  background: transparent;
  color: var(--qj-bar-text);
  width: 34px;
  height: 34px;
}
.shortcut-help:hover,
.bell:hover {
  color: var(--qj-bar-accent);
  border-color: var(--qj-bar-accent);
  background: rgba(34, 211, 238, 0.1);
}
.help-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 0;
}
.help-kbd {
  display: inline-block;
  min-width: 24px;
  text-align: center;
  padding: 2px 8px;
  border: 1px solid var(--qj-border-strong);
  border-bottom-width: 2px;
  border-radius: var(--r-badge);
  background: var(--qj-surface-subtle);
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: var(--qj-text);
}
.help-row-label {
  font-size: var(--fs-body);
  color: var(--qj-text);
}
.help-label {
  width: 64px;
  font-size: var(--fs-sub);
  color: var(--qj-muted);
  flex: none;
}
.help-copy {
  flex: 1;
  font-size: var(--fs-sub);
  color: var(--qj-accent);
  cursor: pointer;
  word-break: break-all;
}
.help-copy:hover {
  text-decoration: underline;
}
.help-note {
  flex: 1;
  font-size: var(--fs-sub);
  color: var(--qj-muted);
}
.help-tip {
  margin-top: var(--sp-3);
  font-size: var(--fs-meta);
  color: var(--qj-muted);
}
.user-box {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--r-control);
  transition: background-color var(--dur-fast) var(--ease);
}
.user-box:hover {
  background: rgba(148, 163, 184, 0.14);
}
.user-box:focus-visible {
  box-shadow: var(--qj-focus-chrome);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  /* 深色顶栏内用白底 + 深青字（9.18:1），是顶栏里唯一的高亮块 */
  background: #ffffff;
  color: var(--qj-chrome-active-text);
  border: 1px solid var(--qj-bar-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: var(--fs-sub);
}
.name {
  font-size: var(--fs-body);
  color: var(--qj-bar-text-strong);
}
.caret {
  color: var(--qj-bar-text);
  font-size: var(--fs-meta);
}
.main {
  padding: var(--sp-5) var(--sp-6);
  overflow-y: auto;
}
.mobile-nav-drawer :deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
  padding: 0;
  background-color: var(--qj-chrome);
  background-image: var(--qj-grid-chrome);
  background-size: var(--qj-grid-size);
}
.mobile-logo {
  flex: none;
}
.mobile-menu {
  overflow-y: auto;
}
@media (max-width: 768px) {
  .layout,
  .body {
    min-width: 0;
  }
  .aside {
    display: none;
  }
  .header {
    height: 56px;
    padding: 0 var(--sp-3);
  }
  .mobile-menu-trigger {
    display: inline-flex;
    width: 40px;
    height: 40px;
    border: 1px solid var(--qj-bar-border);
    background: transparent;
    color: var(--qj-bar-text-strong);
  }
  .mobile-menu-trigger:hover {
    color: var(--qj-bar-accent);
    border-color: var(--qj-bar-accent);
    background: rgba(34, 211, 238, 0.1);
  }
  .header-right {
    gap: var(--sp-2);
  }
  .header-right .name,
  .header-right .caret,
  .shortcut-help {
    display: none;
  }
  .latency-text {
    display: none;
  }
  .user-box {
    padding: 2px;
  }
  .main {
    padding: var(--sp-3);
  }
  .mobile-menu :deep(.el-menu-item) {
    height: 48px;
  }
}
</style>

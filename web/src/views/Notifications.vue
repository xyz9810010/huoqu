<template>
  <div class="notifications-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">通知中心</h2>
        <p class="page-description">任务、异常和系统动态都汇总在这里。</p>
      </div>
      <div class="head-actions">
        <el-button @click="router.push('/notification-settings')"><el-icon><Setting /></el-icon>消息设置</el-button>
        <el-button type="primary" plain :disabled="unreadTotal === 0" @click="readAll">全部已读</el-button>
      </div>
    </div>

    <el-card>
      <div class="filter-bar">
        <el-radio-group v-model="filter" size="small" @change="changeFilter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="unread">未读</el-radio-button>
        </el-radio-group>
        <span class="summary">{{ total }} 条通知<span v-if="unreadTotal"> · {{ unreadTotal }} 条未读</span></span>
      </div>

      <div v-loading="loading" class="notification-list">
        <button v-for="item in list" :key="item.id" type="button" class="notification-row"
          :class="{ unread: !item.read, actionable: Boolean(item.data?.route) }" @click="openNotification(item)">
          <span class="unread-dot" :class="item.priority"></span>
          <span class="notification-content">
            <span class="notification-title">{{ item.title }}</span>
            <span v-if="item.body" class="notification-body">{{ item.body }}</span>
          </span>
          <span class="notification-meta"><time>{{ formatTime(item.createdAt) }}</time>
            <el-icon v-if="item.data?.route"><ArrowRight /></el-icon>
          </span>
        </button>
        <el-empty v-if="!loading && !list.length" :description="filter === 'unread' ? '没有未读通知' : '暂无通知'" />
      </div>

      <el-pagination v-if="total > pageSize" v-model:current-page="page" :page-size="pageSize"
        :total="total" layout="prev, pager, next" @current-change="load" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import http from '../api'
import { refreshUnread } from '../stores/notif'
import type { NotificationItem } from '../types/notifications'
import { createRealtimeRefreshSubscription, notificationFromRealtimeEvent } from '../services/realtime-events'

interface NotificationPage { items: NotificationItem[]; total: number; page: number; pageSize: number }

const router = useRouter()
const list = ref<NotificationItem[]>([])
const loading = ref(false)
const filter = ref<'all' | 'unread'>('all')
const total = ref(0)
const unreadTotal = ref(0)
const page = ref(1)
const pageSize = 20

async function load() {
  loading.value = true
  try {
    const [result, unread] = await Promise.all([
      http.get<any, NotificationPage>('/v1/notifications', {
        params: { page: page.value, pageSize, unread: filter.value === 'unread' ? '1' : undefined },
      }),
      http.get<any, { count: number }>('/v1/notifications/unread-count'),
    ])
    list.value = result.items
    total.value = result.total
    unreadTotal.value = unread.count
  } finally { loading.value = false }
}

function changeFilter() { page.value = 1; load() }

async function openNotification(item: NotificationItem) {
  if (!item.read) {
    await http.post(`/v1/notifications/${encodeURIComponent(item.id)}/read`)
    item.read = true
    unreadTotal.value = Math.max(0, unreadTotal.value - 1)
    await refreshUnread()
  }
  const route = typeof item.data?.route === 'string' ? item.data.route : ''
  if (route.startsWith('/') && !route.startsWith('//')) router.push(route)
}

async function readAll() { await http.post('/v1/notifications/read-all'); await Promise.all([load(), refreshUnread()]) }

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '').replace('T', ' ').slice(0, 16)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

const liveRefresh = createRealtimeRefreshSubscription({
  predicate: event => Boolean(notificationFromRealtimeEvent(event)),
  refresh: () => {
    page.value = 1
    return load()
  },
})

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.page-description { margin: 6px 0 0; color: var(--qj-muted); font-size: 13px; }
.head-actions { display: flex; gap: 8px; }
.filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--qj-border); }
.summary { color: var(--qj-muted); font-size: 12px; }
.notification-list { min-height: 180px; }
.notification-row { width: 100%; border: 0; border-bottom: 1px solid var(--qj-border); background: transparent; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 16px 4px; text-align: left; color: inherit; font: inherit; }
.notification-row:last-child { border-bottom: 0; }
.notification-row.actionable { cursor: pointer; }
.notification-row.actionable:hover { background: #fafbfc; }
.unread-dot { width: 7px; height: 7px; border-radius: 50%; background: transparent; }
.notification-row.unread .unread-dot { background: var(--el-color-primary); }
.notification-row.unread .unread-dot.high { background: var(--el-color-warning); }
.notification-content, .notification-title, .notification-body { display: block; min-width: 0; }
.notification-title { font-size: 14px; font-weight: 500; color: var(--qj-text); }
.notification-row.unread .notification-title { font-weight: 650; }
.notification-body { margin-top: 5px; color: var(--qj-text-2); font-size: 13px; line-height: 1.55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notification-meta { display: flex; align-items: center; gap: 8px; color: var(--qj-muted); font-size: 12px; }
@media (max-width: 640px) {
  .head-actions { width: 100%; }
  .notification-row { grid-template-columns: 8px minmax(0, 1fr); }
  .notification-meta { grid-column: 2; justify-content: flex-start; }
}
</style>

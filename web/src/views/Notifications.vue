<template>
  <div class="notifications-page">
    <PageHead title="通知中心" description="任务、异常和系统动态都汇总在这里" nowrap>
      <template #actions>
        <el-button class="settings-btn" aria-label="消息设置" @click="router.push('/notification-settings')">
          <el-icon><Setting /></el-icon><span class="settings-btn__text">消息设置</span>
        </el-button>
        <el-button type="primary" :disabled="unreadTotal === 0" @click="readAll">全部已读</el-button>
      </template>
    </PageHead>

    <el-card shadow="never">
      <div class="filter-bar">
        <div class="qj-pills">
          <button type="button" class="qj-pill" :class="{ 'is-active': filter === 'all' }" @click="filter = 'all'; changeFilter()">全部</button>
          <button type="button" class="qj-pill" :class="{ 'is-active': filter === 'unread' }" @click="filter = 'unread'; changeFilter()">未读</button>
        </div>
        <span class="summary qj-num">{{ total }} 条通知<span v-if="unreadTotal"> · {{ unreadTotal }} 条未读</span></span>
      </div>

      <SkeletonBlock v-if="loading && !list.length" :rows="4" />

      <div v-else class="notification-list">
        <button v-for="item in list" :key="item.id" type="button" class="notification-row"
          :class="{ unread: !item.read, actionable: Boolean(item.data?.route) }" @click="openNotification(item)">
          <span class="unread-dot" :class="item.priority" aria-hidden="true" />
          <span class="notification-content">
            <span class="notification-title">
              <span v-if="!item.read" class="sr-only">未读：</span>{{ item.title }}
            </span>
            <span v-if="item.body" class="notification-body">{{ item.body }}</span>
          </span>
          <span class="notification-meta">
            <time class="qj-num">{{ formatTime(item.createdAt) }}</time>
            <el-icon v-if="item.data?.route"><ArrowRight /></el-icon>
          </span>
        </button>
      </div>

      <EmptyState v-if="!loading && !list.length"
                  :title="filter === 'unread' ? '没有未读通知' : '暂无通知'"
                  :description="filter === 'unread' ? '所有通知都已读完了' : '派单、状态变更与异常上报都会出现在这里'" />

      <el-pagination v-if="total > pageSize" v-model:current-page="page" :page-size="pageSize"
        :total="total" layout="prev, pager, next" @current-change="load" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Setting } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
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
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--qj-border);
  flex-wrap: wrap;
}
.summary {
  color: var(--qj-muted);
  font-size: var(--fs-meta);
}
.notification-list {
  min-height: 180px;
}
.notification-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--qj-border);
  background: transparent;
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: var(--sp-3);
  align-items: center;
  padding: var(--sp-4) var(--sp-1);
  text-align: left;
  color: inherit;
  font: inherit;
  transition: background-color var(--dur-fast) var(--ease);
}
.notification-row:last-child {
  border-bottom: 0;
}
.notification-row.actionable {
  cursor: pointer;
}
.notification-row.actionable:hover {
  background: var(--qj-surface-subtle);
}
.notification-row:focus-visible {
  box-shadow: var(--qj-focus);
}
.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
}
.notification-row.unread .unread-dot {
  background: var(--qj-primary);
}
.notification-row.unread .unread-dot.high {
  background: #d97706;
}
.notification-content,
.notification-title,
.notification-body {
  display: block;
  min-width: 0;
}
.notification-title {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--qj-text);
}
.notification-row.unread .notification-title {
  font-weight: 650;
}
.notification-body {
  margin-top: 5px;
  color: var(--qj-text-2);
  font-size: var(--fs-sub);
  line-height: 1.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notification-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--qj-muted);
  font-size: var(--fs-meta);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 640px) {
  /* 筛选行收成一行：胶囊左、条数右，避免换行多占一行 */
  .filter-bar {
    flex-wrap: nowrap;
    gap: var(--sp-2);
    padding-bottom: var(--sp-2);
  }
  .filter-bar .qj-pill {
    height: 34px;
    padding: 0 12px;
  }
  .summary {
    flex: none;
  }
  /* 消息设置在手机上只留图标，给「全部已读」让出空间，保证页头一行放得下 */
  .settings-btn__text {
    display: none;
  }
  .notification-row {
    grid-template-columns: 8px minmax(0, 1fr);
    padding: var(--sp-3) var(--sp-1);
  }
  .notification-meta {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>

<template>
  <div>
    <div class="toolbar">
      <h2 class="page-title" style="margin:0">我的任务</h2>
      <span class="count">{{ activeLabel }} {{ shown.length }} 单</span>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <el-tabs v-model="active" class="status-tabs" @tab-change="onTab">
      <el-tab-pane v-for="s in statuses" :key="s.value" :name="s.value"
                   :label="`${s.label} ${counts[s.value]}`" />
    </el-tabs>

    <el-card v-for="t in shown" :key="t.id" shadow="never" class="task-card"
             :class="{ rush: t.taskType === 'rush' }">
      <div class="task-head">
        <div class="left">
          <el-tag size="small" :type="statusType(t.status) as any">{{ statusLabel(t.status) }}</el-tag>
          <el-tag v-if="t.taskType === 'rush'" type="danger" size="small">🔴 赶 {{ fmt(t.rushShipTime) }} 出货</el-tag>
          <el-tag v-else-if="t.taskType === 'scheduled'" type="warning" size="small">指定时间 {{ fmt(t.scheduledTime) }}</el-tag>
        </div>
        <div class="time">{{ timeTitle(t) }} {{ fmt(timeOf(t)) }}</div>
      </div>
      <div class="cust-line">
        <span class="customer">{{ t.customerName }}</span>
        <span class="task-no">{{ t.taskNo }}</span>
      </div>
      <div class="addr">
        <div><b v-if="t.areaName">{{ t.areaName }}</b> {{ t.address }}</div>
        <div>联系人：{{ t.contact }}　电话：{{ t.phone }}</div>
        <div v-if="t.pickupNote" class="note">备注：{{ t.pickupNote }}</div>
      </div>
      <div class="actions">
        <template v-if="t.status === 'pending' || t.status === 'in_progress'">
          <el-button size="small" @click="copyAddr(t)">复制地址</el-button>
          <el-button size="small" @click="copyFull(t)">复制取件信息</el-button>
          <el-button size="small"><a :href="'tel:' + t.phone" style="color:inherit;text-decoration:none">拨打电话</a></el-button>
          <el-button size="small" @click="navigate(t)">导航</el-button>
        </template>
        <el-button v-else size="small" @click="copyFull(t)">复制取件信息</el-button>
        <el-button v-if="t.status === 'pending'" type="primary" size="large" class="main"
                   @click="open(t)">开始取件</el-button>
        <el-button v-else-if="t.status === 'in_progress'" type="primary" class="main"
                   @click="open(t)">继续取件</el-button>
        <el-button v-else class="main" @click="open(t)">查看详情</el-button>
      </div>
    </el-card>
    <el-empty v-if="!shown.length" :description="emptyText" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import http from '../api'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const router = useRouter()
const list = ref<any[]>([])
const active = ref('pending')

const statuses = [
  { value: 'pending', label: '待取' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

const counts = computed<Record<string, number>>(() => {
  const c: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
  for (const t of list.value) c[t.status] = (c[t.status] || 0) + 1
  return c
})
const activeLabel = computed(() => statuses.find(s => s.value === active.value)?.label || '')
const shown = computed(() => list.value.filter(t => t.status === active.value))
const emptyText = computed(() => `暂无${activeLabel.value}任务`)

async function load() {
  list.value = await http.get('/worker/tasks')
}

function onTab(name: string | number) {
  active.value = String(name)
}

function open(t: any) {
  router.push('/tasks/' + t.id)
}

function fmt(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
}
function timeTitle(t: any) {
  return t.status === 'completed' ? '完成' : t.status === 'cancelled' ? '状态更新' : '派单'
}
function timeOf(t: any) {
  if (t.status === 'completed') return t.completedAt
  if (t.status === 'cancelled') return t.updatedAt
  return t.dispatchAt
}
function statusLabel(s: string) {
  return { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[s] || s
}
function statusType(s: string) {
  return { pending: 'warning', in_progress: 'primary', completed: 'success', cancelled: 'info' }[s] || 'info'
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 剪贴板权限被拒时降级为传统复制，兼容局域网 HTTP/非安全上下文
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

async function copyAddr(t: any) {
  const ok = await copyText(t.address || '')
  ElMessage.success(ok ? '地址已复制' : '复制失败，请手动复制')
}

async function copyFull(t: any) {
  const text = `客户：${t.customerName}\n取件点：${t.addressPointName}\n地址：${t.address}\n联系人：${t.contact}\n电话：${t.phone}`
  const ok = await copyText(text)
  ElMessage.success(ok ? '取件信息已复制' : '复制失败，请手动复制')
}

function navigate(t: any) {
  const q = encodeURIComponent(t.address || '')
  window.open(`https://uri.amap.com/search?keyword=${q}`, '_blank')
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: load })

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.count {
  font-size: 15px;
  font-weight: 600;
  color: var(--qj-text-2);
}
.status-tabs {
  margin-bottom: 12px;
}
.status-tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}
.task-card {
  margin-bottom: 12px;
}
.task-card.rush {
  border: 1px solid #f56c6c !important;
}
.task-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.cust-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
}
.customer {
  font-size: 17px;
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-no {
  color: var(--qj-muted);
  font-size: 12px;
  white-space: nowrap;
}
.time {
  color: #999;
  font-size: 13px;
  white-space: nowrap;
}
.addr {
  margin: 8px 0 10px;
  color: #555;
  line-height: 1.8;
  font-size: 14px;
}
.note {
  color: #e6a23c;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--qj-border);
}
.actions .el-button {
  margin-left: 0;
}
.actions .main {
  margin-left: auto;
}
@media (max-width: 768px) {
  .task-head {
    align-items: flex-start;
  }
  .time {
    font-size: 12px;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .actions .el-button {
    width: 100%;
    min-height: 44px;
    font-size: 14px;
  }
  .actions .main {
    grid-column: 1 / -1;
    height: 48px;
    font-size: 16px;
    margin-left: 0;
    order: -1;
  }
}
</style>

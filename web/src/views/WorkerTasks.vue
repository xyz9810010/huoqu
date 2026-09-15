<template>
  <div @touchstart="onTouchStart" @touchend="onTouchEnd">
    <PageHead title="我的任务" sticky nowrap>
      <template #actions>
        <span class="count qj-num">{{ activeLabel }} {{ shown.length }} 单</span>
        <el-button type="primary" @click="router.push('/worker/dispatch')">新增订单</el-button>
        <el-button :icon="Refresh" circle aria-label="刷新任务" @click="load" />
      </template>
    </PageHead>

    <el-tabs v-model="active" class="status-tabs" @tab-change="onTab">
      <el-tab-pane v-for="s in statuses" :key="s.value" :name="s.value"
                   :label="`${s.label} ${counts[s.value]}`" />
    </el-tabs>

    <Transition name="slide" mode="out-in">
      <div :key="active">
        <el-card v-for="t in shown" :key="t.id" shadow="never" class="task-card"
                 :class="{ rush: t.taskType === 'rush' }">
          <div class="task-head">
            <div class="left">
              <StatusBadge :status="t.status" />
              <span v-if="t.taskType === 'rush'" class="qj-badge qj-badge--danger">赶 {{ fmt(t.rushShipTime) }} 出货</span>
              <span v-else-if="t.taskType === 'scheduled'" class="qj-badge qj-badge--pending">指定时间 {{ fmt(t.scheduledTime) }}</span>
            </div>
            <div class="time qj-num">{{ timeTitle(t) }} {{ fmt(timeOf(t)) }}</div>
          </div>
          <div class="cust-line">
            <span class="customer">{{ t.customerName }}</span>
            <span class="task-no qj-num">{{ t.taskNo }}</span>
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
              <el-button size="small" class="tel-link-btn">
                <a :href="'tel:' + t.phone" class="tel-link">拨打电话</a>
              </el-button>
              <el-button size="small" @click="navigate(t)">导航</el-button>
            </template>
            <el-button v-else size="small" @click="copyFull(t)">复制取件信息</el-button>
            <el-button v-if="t.status === 'pending'" type="primary" class="main" @click="open(t)">开始取件</el-button>
            <el-button v-else-if="t.status === 'in_progress'" type="primary" class="main" @click="open(t)">继续取件</el-button>
            <el-button v-else class="main" @click="open(t)">查看详情</el-button>
          </div>
        </el-card>
        <EmptyState v-if="!shown.length" :title="emptyText" description="切换到其他状态，或新建一条取件订单">
          <el-button type="primary" @click="router.push('/worker/dispatch')">新增订单</el-button>
        </EmptyState>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import StatusBadge from '../components/StatusBadge.vue'
import EmptyState from '../components/EmptyState.vue'
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

// 移动端左右滑动切换状态（待取/进行中/已完成/已取消）
let touchStartX = 0
let touchStartY = 0
function onTouchStart(e: TouchEvent) {
  touchStartX = e.touches[0].clientX
  touchStartY = e.touches[0].clientY
}
function onTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - touchStartX
  const dy = e.changedTouches[0].clientY - touchStartY
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return
  const idx = statuses.findIndex(s => s.value === active.value)
  if (dx < 0 && idx >= 0 && idx < statuses.length - 1) {
    active.value = statuses[idx + 1].value
  } else if (dx > 0 && idx > 0) {
    active.value = statuses[idx - 1].value
  }
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
.slide-enter-active,
.slide-leave-active {
  transition: opacity var(--dur-base) var(--ease), transform var(--dur-base) var(--ease);
}
.slide-enter-from {
  opacity: 0;
  transform: translateX(28px);
}
.slide-leave-to {
  opacity: 0;
  transform: translateX(-28px);
}
.count {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--qj-text-2);
  margin-right: var(--sp-1);
  white-space: nowrap;
}
.status-tabs {
  margin-bottom: var(--sp-3);
}
.status-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--sp-3);
}
.status-tabs :deep(.el-tabs__active-bar) {
  transition: transform var(--dur-base) var(--ease), width var(--dur-base) var(--ease);
}
.task-card {
  margin-bottom: var(--sp-3);
}
.task-card.rush {
  border-color: var(--qj-danger-text) !important;
}
.task-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
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
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.customer {
  font-size: 17px;
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-no {
  color: var(--qj-muted);
  font-size: var(--fs-meta);
  white-space: nowrap;
}
.time {
  color: var(--qj-muted);
  font-size: var(--fs-sub);
  white-space: nowrap;
}
.addr {
  margin: var(--sp-2) 0 var(--sp-3);
  color: var(--qj-text-2);
  line-height: 1.8;
  font-size: var(--fs-body);
}
.note {
  color: var(--qj-warning-text);
}
.tel-link {
  color: inherit;
  text-decoration: none;
  /* "拨打电话"是取件员的高频操作。链接被包在 el-button 里，
     若不撑满，真正可点的只有文字那点区域（实测 48x12），手机上很难点中。 */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 32px;
  position: relative;
}
/* 用伪元素把可点区域左右上下都扩出去，覆盖按钮的内边距，
   使整颗按钮都可点（仅设 width:100% 只等于文字宽度，两侧会漏）。 */
.tel-link::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: calc(100% + 26px);
  height: 100%;
  min-height: 44px;
}
.tel-link-btn {
  padding: 0;
}
.actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
  align-items: center;
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
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
  .actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-2);
  }
  .actions .el-button {
    width: 100%;
    min-height: 44px;
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

<template>
  <div>
    <PageHead title="取件任务" description="按时间与状态筛选，点击任意行进入任务详情">
      <template #actions>
        <el-button type="primary" @click="router.push('/dispatch')">
          <el-icon><Plus /></el-icon>新建取件
        </el-button>
      </template>
    </PageHead>

    <div class="filter-bar">
      <div class="qj-pills">
        <button v-for="r in timeRanges" :key="r.key" type="button"
                class="qj-pill" :class="{ 'is-active': timeRange === r.key }"
                @click="pickTimeRange(r.key)">
          {{ r.label }}
        </button>
      </div>

      <div class="qj-pills">
        <button v-for="tab in statusTabs" :key="tab.key" type="button"
                class="qj-pill" :class="{ 'is-active': isActiveTab(tab.key) }"
                @click="pickTab(tab.key)">
          <span class="qj-pill__dot" :class="tab.dotClass" />
          {{ tab.label }}
          <b>{{ tab.count }}</b>
        </button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="taskType" class="type-filter" placeholder="全部类型" clearable
                 style="width:150px" @change="onFilterChange">
        <el-option label="普通" value="normal" />
        <el-option label="指定时间" value="scheduled" />
        <el-option label="赶出货" value="rush" />
      </el-select>
      <el-input v-model="keyword" class="keyword-filter" placeholder="任务号 / 客户" clearable
                style="width:240px" @keyup.enter="onFilterChange" @clear="onFilterChange" />
      <el-button type="primary" @click="onFilterChange">查询</el-button>
    </div>

    <el-card shadow="never" class="list-card">
      <SkeletonBlock v-if="loading && !list.length" :rows="5" />

      <template v-else>
        <el-table v-if="list.length" class="desktop-table" :data="list" :row-class-name="rowClass"
                  @row-click="(r: any) => router.push('/tasks/' + r.id)" style="cursor:pointer">
          <el-table-column prop="taskNo" label="任务号" width="164" class-name="cell-nowrap" show-overflow-tooltip />
          <el-table-column label="状态" width="104">
            <template #default="{ row }">
              <StatusBadge :status="row.status" />
            </template>
          </el-table-column>
          <el-table-column label="类型" width="180">
            <template #default="{ row }">
              <span v-if="row.taskType === 'rush'" class="qj-badge qj-badge--danger">赶 {{ fmtTime(row.rushShipTime) }} 出货</span>
              <span v-else-if="row.taskType === 'scheduled'" class="qj-badge qj-badge--pending">
                {{ kindLabel(row.scheduledKind) }} {{ fmtTime(row.scheduledTime) }}
              </span>
              <span v-else class="qj-badge qj-badge--plain">普通</span>
            </template>
          </el-table-column>
          <el-table-column prop="customerName" label="客户" min-width="150" show-overflow-tooltip />
          <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
          <el-table-column prop="defaultWorkerName" label="取件员" width="96">
            <template #default="{ row }">{{ row.defaultWorkerName || '未分配' }}</template>
          </el-table-column>
          <el-table-column label="派单时间" width="152">
            <template #default="{ row }">
              <span class="qj-num qj-nowrap">{{ fmtTime(row.dispatchAt) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <EmptyState v-if="!list.length" title="暂无取件任务"
                    description="换个筛选条件，或直接新建一条取件任务">
          <el-button type="primary" @click="router.push('/dispatch')">新建取件</el-button>
        </EmptyState>
      </template>

      <div class="mobile-list" @touchstart="onTouchStart" @touchend="onTouchEnd">
        <Transition name="slide" mode="out-in">
          <div :key="status">
            <article v-for="row in list" :key="row.id" class="mobile-item mobile-item--clickable mobile-task"
                     :class="'mobile-task--' + row.status" @click="router.push('/tasks/' + row.id)">
              <div class="mobile-item__head">
                <div>
                  <div class="mobile-item__title">{{ row.customerName || '未命名客户' }}</div>
                  <div class="mobile-item__sub qj-num">{{ row.taskNo }} · {{ fmtTime(row.dispatchAt) }}</div>
                </div>
                <StatusBadge :status="row.status" />
              </div>
              <div class="task-type">
                <span v-if="row.taskType === 'rush'" class="qj-badge qj-badge--danger">赶 {{ fmtTime(row.rushShipTime) }} 出货</span>
                <span v-else-if="row.taskType === 'scheduled'" class="qj-badge qj-badge--pending">
                  {{ kindLabel(row.scheduledKind) }} {{ fmtTime(row.scheduledTime) }}
                </span>
                <span v-else class="qj-badge qj-badge--plain">普通任务</span>
              </div>
              <div class="mobile-field"><span class="mobile-field__label">取件地址</span><span class="mobile-field__value">{{ row.addressPointName || row.address || '—' }}</span></div>
              <div class="mobile-field"><span class="mobile-field__label">取件员</span><span class="mobile-field__value">{{ row.defaultWorkerName || '未分配' }}</span></div>
            </article>
            <EmptyState v-if="!list.length" title="暂无取件任务" description="换个筛选条件试试" />
          </div>
        </Transition>
      </div>
    </el-card>

    <div ref="sentinel" style="height: 1px" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import StatusBadge from '../components/StatusBadge.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const router = useRouter()
const list = ref<any[]>([])
const status = ref('')
const taskType = ref('')
const keyword = ref('')
const timeRange = ref('today')
const timeRanges = [
  { key: '', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
]
const page = ref(0)
const size = 20
const total = ref(0)
const hasMore = ref(true)
const loading = ref(false)
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
const counts = ref({ all: 0, open: 0, completed: 0, cancelled: 0 })
let countSeq = 0

const statusTabs = computed(() => [
  { key: '', label: '全部', dotClass: '', count: counts.value.all },
  { key: 'open', label: '待办', dotClass: 'qj-pill__dot--warn', count: counts.value.open },
  { key: 'completed', label: '已完成', dotClass: 'qj-pill__dot--ok', count: counts.value.completed },
  { key: 'cancelled', label: '已取消', dotClass: 'qj-pill__dot--mute', count: counts.value.cancelled },
])

async function load(reset = false) {
  if (loading.value) return
  loading.value = true
  if (reset) page.value = 0
  try {
    const data: any = await http.get('/tasks', {
      params: { status: status.value, taskType: taskType.value, keyword: keyword.value, timeRange: timeRange.value, page: page.value, size },
    })
    list.value = reset ? data.list : [...list.value, ...data.list]
    total.value = data.total
    hasMore.value = list.value.length < data.total
    page.value += 1
  } finally {
    loading.value = false
  }
  if (reset) loadCounts()
}

function loadMore() {
  if (!loading.value && hasMore.value) load(false)
}

async function loadCounts() {
  const seq = ++countSeq
  const base = { taskType: taskType.value, keyword: keyword.value, timeRange: timeRange.value, page: 0, size: 1 }
  const grab = async (statusValue: string) => {
    const data: any = await http.get('/tasks', { params: { ...base, status: statusValue } })
    return data.total
  }
  const [all, open, completed, cancelled] = await Promise.all([
    grab(''), grab('open'), grab('completed'), grab('cancelled'),
  ])
  if (seq !== countSeq) return // 丢弃过期响应，避免快速切筛选时数字错乱
  counts.value = { all, open, completed, cancelled }
}

function onFilterChange() {
  load(true)
}

function pickTab(key: string) {
  status.value = key
  onFilterChange()
}

function pickTimeRange(key: string) {
  timeRange.value = key
  onFilterChange()
}

// 移动端左右滑动切换状态 Tab（全部/待办/已完成/已取消）
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
  const keys = statusTabs.value.map((t: any) => t.key)
  const current = status.value === 'pending' || status.value === 'in_progress' ? 'open' : status.value
  const idx = keys.indexOf(current)
  if (dx < 0 && idx >= 0 && idx < keys.length - 1) {
    pickTab(keys[idx + 1])
  } else if (dx > 0 && idx > 0) {
    pickTab(keys[idx - 1])
  }
}

function isActiveTab(key: string) {
  if (key === 'open') {
    return status.value === 'open' || status.value === 'pending' || status.value === 'in_progress'
  }
  return status.value === key
}

function rowClass(data: any) {
  const s = data && data.row ? data.row.status : ''
  if (s === 'completed') return 'task-row--done'
  if (s === 'cancelled') return 'task-row--cancelled'
  return 'task-row--open'
}

function fmtTime(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
}
function kindLabel(k: string) {
  return { before: '前', after: '后', around: '左右' }[k] || ''
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: () => load(true) })

onMounted(() => {
  load(true)
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMore()
  }, { root: null, threshold: 0.1 })
  if (sentinel.value) observer.observe(sentinel.value)
})
onUnmounted(() => {
  liveRefresh.dispose()
  observer?.disconnect()
})
</script>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-5);
  margin-bottom: var(--sp-3);
}
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
.toolbar {
  margin-bottom: var(--sp-3);
}
.task-type {
  margin-bottom: var(--sp-1);
}
.list-card {
  margin-bottom: var(--sp-4);
}

:deep(.el-table__body tr.task-row--open > td) { background-color: var(--qj-row-open); }
:deep(.el-table__body tr.task-row--open:hover > td) { background-color: var(--qj-row-open-hover); }
:deep(.el-table__body tr.task-row--done > td) { background-color: var(--qj-row-done); }
:deep(.el-table__body tr.task-row--done:hover > td) { background-color: #eff9e9; }
:deep(.el-table__body tr.task-row--cancelled > td) { background-color: var(--qj-row-cancelled); color: var(--qj-muted); }
:deep(.el-table__body tr.task-row--cancelled:hover > td) { background-color: #f2f2f2; }

.mobile-task--pending,
.mobile-task--in_progress {
  border-left: 3px solid #d97706;
}
.mobile-task--completed {
  border-left: 3px solid #16a34a;
}
.mobile-task--cancelled {
  border-left: 3px solid #94a3b8;
}

@media (max-width: 768px) {
  .toolbar :deep(.el-select),
  .toolbar :deep(.el-input) {
    flex: 1 1 100%;
    width: auto !important;
  }
  .toolbar .el-button {
    /* 查询等次要动作保持自然宽度，不占满整行 */
    flex: 0 1 auto;
    margin-left: 0;
    min-height: 44px;
    padding: 0 20px;
  }
}
</style>

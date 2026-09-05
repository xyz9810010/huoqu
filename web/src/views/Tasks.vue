<template>
  <div>
    <h2 class="page-title" style="margin-bottom:12px">取件任务</h2>

    <div class="status-tabs">
      <button v-for="tab in statusTabs" :key="tab.key" type="button"
              class="status-tab" :class="[tab.tone, { 'is-active': isActiveTab(tab.key) }]"
              @click="pickTab(tab.key)">
        <span class="status-tab__dot" />
        {{ tab.label }}
        <b>{{ tab.count }}</b>
      </button>
    </div>

    <div class="toolbar">
      <el-select v-model="status" class="status-filter" placeholder="状态" clearable style="width:150px" @change="onFilterChange">
        <el-option label="待办（待取/取件中）" value="open" />
        <el-option label="待取" value="pending" />
        <el-option label="取件中" value="in_progress" />
        <el-option label="已完成" value="completed" />
        <el-option label="已取消" value="cancelled" />
      </el-select>
      <el-select v-model="taskType" class="type-filter" placeholder="类型" clearable style="width:140px" @change="onFilterChange">
        <el-option label="普通" value="normal" />
        <el-option label="指定时间" value="scheduled" />
        <el-option label="赶出货" value="rush" />
      </el-select>
      <el-input v-model="keyword" class="keyword-filter" placeholder="任务号/客户" clearable style="width:220px" @keyup.enter="onFilterChange" @clear="onFilterChange" />
      <el-button class="query-button" type="primary" @click="onFilterChange">查询</el-button>
      <el-button class="create-button" type="success" @click="router.push('/dispatch')">新建取件</el-button>
    </div>

    <el-table class="desktop-table" :data="list" :row-class-name="rowClass"
              @row-click="(r: any) => router.push('/tasks/' + r.id)" style="cursor:pointer">
      <el-table-column prop="taskNo" label="任务号" width="170" />
      <el-table-column label="状态" width="112">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status) as any">
            {{ row.status === 'completed' ? '✓ 已完成' : statusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="150">
        <template #default="{ row }">
          <el-tag v-if="row.taskType === 'rush'" type="danger">🔴 赶 {{ fmtTime(row.rushShipTime) }} 出货</el-tag>
          <el-tag v-else-if="row.taskType === 'scheduled'" type="warning">
            {{ kindLabel(row.scheduledKind) }} {{ fmtTime(row.scheduledTime) }}
          </el-tag>
          <el-tag v-else type="info">普通</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="customerName" label="客户" min-width="160" />
      <el-table-column prop="addressPointName" label="取件点" width="110" />
      <el-table-column prop="address" label="地址" min-width="200" show-overflow-tooltip />
      <el-table-column prop="defaultWorkerName" label="取件员" width="100" />
      <el-table-column prop="mainCsName" label="主客服" width="100" />
      <el-table-column prop="dispatchAt" label="派单时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.dispatchAt) }}</template>
      </el-table-column>
    </el-table>

    <div class="mobile-list">
      <article v-for="row in list" :key="row.id" class="mobile-item mobile-item--clickable mobile-task"
               :class="'mobile-task--' + row.status" @click="router.push('/tasks/' + row.id)">
        <div class="mobile-item__head">
          <div>
            <div class="mobile-item__title">{{ row.customerName || '未命名客户' }}</div>
            <div class="mobile-item__sub">{{ row.taskNo }}</div>
          </div>
          <el-tag :type="statusType(row.status) as any" size="small">
            {{ row.status === 'completed' ? '✓ 已完成' : statusLabel(row.status) }}
          </el-tag>
        </div>
        <div class="task-type">
          <el-tag v-if="row.taskType === 'rush'" type="danger" size="small">赶 {{ fmtTime(row.rushShipTime) }} 出货</el-tag>
          <el-tag v-else-if="row.taskType === 'scheduled'" type="warning" size="small">
            {{ kindLabel(row.scheduledKind) }} {{ fmtTime(row.scheduledTime) }}
          </el-tag>
          <el-tag v-else type="info" size="small">普通任务</el-tag>
        </div>
        <div class="mobile-field"><span class="mobile-field__label">取件地址</span><span class="mobile-field__value">{{ row.addressPointName || row.address || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">取件员</span><span class="mobile-field__value">{{ row.defaultWorkerName || '未分配' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">主客服</span><span class="mobile-field__value">{{ row.mainCsName || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">派单时间</span><span class="mobile-field__value">{{ fmtTime(row.dispatchAt) || '—' }}</span></div>
      </article>
      <el-empty v-if="!list.length" description="暂无取件任务" />
    </div>

    <el-pagination background layout="total, prev, pager, next" :total="total" :page-size="size"
                   :current-page="page + 1" @current-change="(p: number) => { page = p - 1; load() }" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import http from '../api'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const router = useRouter()
const list = ref<any[]>([])
const status = ref('')
const taskType = ref('')
const keyword = ref('')
const page = ref(0)
const size = 20
const total = ref(0)
const counts = ref({ all: 0, open: 0, completed: 0, cancelled: 0 })
let countSeq = 0

const statusTabs = computed(() => [
  { key: '', label: '全部', tone: 'all', count: counts.value.all },
  { key: 'open', label: '待办', tone: 'open', count: counts.value.open },
  { key: 'completed', label: '已完成', tone: 'done', count: counts.value.completed },
  { key: 'cancelled', label: '已取消', tone: 'cancelled', count: counts.value.cancelled },
])

async function load() {
  const data: any = await http.get('/tasks', {
    params: { status: status.value, taskType: taskType.value, keyword: keyword.value, page: page.value, size },
  })
  list.value = data.list
  total.value = data.total
  loadCounts()
}

async function loadCounts() {
  const seq = ++countSeq
  const base = { taskType: taskType.value, keyword: keyword.value, page: 0, size: 1 }
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
  page.value = 0
  load()
}

function pickTab(key: string) {
  status.value = key
  onFilterChange()
}

function isActiveTab(key: string) {
  if (key === 'open') {
    return status.value === 'open' || status.value === 'pending' || status.value === 'in_progress'
  }
  return status.value === key
}

function rowClass(data: any) {
  const status = data && data.row ? data.row.status : ''
  if (status === 'completed') return 'task-row--done'
  if (status === 'cancelled') return 'task-row--cancelled'
  return 'task-row--open'
}

function fmtTime(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
}
function kindLabel(k: string) {
  return { before: '前', after: '后', around: '左右' }[k] || ''
}
function statusLabel(s: string) {
  return { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[s] || s
}
function statusType(s: string) {
  return { pending: 'warning', in_progress: 'primary', completed: 'success', cancelled: 'info' }[s] || 'info'
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: load })

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.status-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 16px;
  border: 1px solid var(--el-border-color);
  background: #fff;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: all 0.15s ease;
}
.status-tab b {
  font-weight: 600;
}
.status-tab__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-tab.all .status-tab__dot { background: var(--el-color-primary); }
.status-tab.open .status-tab__dot { background: var(--el-color-warning); }
.status-tab.done .status-tab__dot { background: var(--el-color-success); }
.status-tab.cancelled .status-tab__dot { background: var(--el-color-info); }
.status-tab.is-active.all { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary); color: var(--el-color-primary); }
.status-tab.is-active.open { background: var(--el-color-warning-light-9); border-color: var(--el-color-warning); color: var(--el-color-warning-dark-2, #b88230); }
.status-tab.is-active.done { background: var(--el-color-success-light-9); border-color: var(--el-color-success); color: var(--el-color-success-dark-2, #529b2e); }
.status-tab.is-active.cancelled { background: var(--el-color-info-light-9); border-color: var(--el-color-info); color: var(--el-color-info-dark-2, #63656a); }

.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.task-type {
  margin-bottom: 6px;
}

:deep(.el-table__body tr.task-row--open > td) { background-color: #fffdf3; }
:deep(.el-table__body tr.task-row--open:hover > td) { background-color: var(--el-color-warning-light-9); }
:deep(.el-table__body tr.task-row--done > td) { background-color: #f6fdf2; }
:deep(.el-table__body tr.task-row--done:hover > td) { background-color: var(--el-color-success-light-9); }
:deep(.el-table__body tr.task-row--cancelled > td) { background-color: #fafafa; color: #a8abb2; }
:deep(.el-table__body tr.task-row--cancelled:hover > td) { background-color: #f0f0f0; }

.mobile-task--pending,
.mobile-task--in_progress {
  border-left: 4px solid var(--el-color-warning);
}
.mobile-task--completed {
  border-left: 4px solid var(--el-color-success);
  background: #fbfef8;
}
.mobile-task--cancelled {
  border-left: 4px solid var(--el-color-info);
  opacity: 0.72;
}

@media (max-width: 768px) {
  .toolbar .status-filter,
  .toolbar .type-filter {
    flex: 1 1 calc(50% - 5px);
    width: auto !important;
  }
  .toolbar .keyword-filter {
    flex: 1 1 calc(100% - 80px);
    width: auto !important;
  }
  .toolbar .query-button {
    flex: 0 0 70px;
    margin-left: 0;
  }
  .toolbar .create-button {
    flex: 1 1 100%;
    margin-left: 0;
  }
}
</style>

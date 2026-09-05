<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">取件任务</h2>
    <div class="toolbar">
      <el-select v-model="status" class="status-filter" placeholder="状态" clearable style="width:140px" @change="load">
        <el-option label="待取" value="pending" />
        <el-option label="取件中" value="in_progress" />
        <el-option label="已完成" value="completed" />
        <el-option label="已取消" value="cancelled" />
      </el-select>
      <el-select v-model="taskType" class="type-filter" placeholder="类型" clearable style="width:140px" @change="load">
        <el-option label="普通" value="normal" />
        <el-option label="指定时间" value="scheduled" />
        <el-option label="赶出货" value="rush" />
      </el-select>
      <el-input v-model="keyword" class="keyword-filter" placeholder="任务号/客户" clearable style="width:220px" @keyup.enter="load" @clear="load" />
      <el-button class="query-button" type="primary" @click="load">查询</el-button>
      <el-button class="create-button" type="success" @click="router.push('/dispatch')">新建取件</el-button>
    </div>

    <el-table class="desktop-table" :data="list" @row-click="(r: any) => router.push('/tasks/' + r.id)" style="cursor:pointer">
      <el-table-column prop="taskNo" label="任务号" width="170" />
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
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status) as any">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <div class="mobile-list">
      <article v-for="row in list" :key="row.id" class="mobile-item mobile-item--clickable"
               @click="router.push('/tasks/' + row.id)">
        <div class="mobile-item__head">
          <div>
            <div class="mobile-item__title">{{ row.customerName || '未命名客户' }}</div>
            <div class="mobile-item__sub">{{ row.taskNo }}</div>
          </div>
          <el-tag :type="statusType(row.status) as any" size="small">{{ statusLabel(row.status) }}</el-tag>
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
import { onMounted, onUnmounted, ref } from 'vue'
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

async function load() {
  const data: any = await http.get('/tasks', {
    params: { status: status.value, taskType: taskType.value, keyword: keyword.value, page: page.value, size },
  })
  list.value = data.list
  total.value = data.total
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
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.task-type {
  margin-bottom: 6px;
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

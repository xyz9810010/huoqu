<template>
  <div>
    <PageHead title="数据看板" description="今日经营指标、取件员负荷与出货趋势">
      <template #actions>
        <el-radio-group v-model="mode" size="default">
          <el-radio-button value="table">列表</el-radio-button>
          <el-radio-button value="chart">图表</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="range" size="default" @change="loadAll">
          <el-radio-button value="today">今天</el-radio-button>
          <el-radio-button value="yesterday">昨天</el-radio-button>
          <el-radio-button value="week">本周</el-radio-button>
          <el-radio-button value="month">本月</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" circle aria-label="刷新数据" @click="loadAll" />
      </template>
    </PageHead>

    <SkeletonBlock v-if="loading && !loaded" :rows="3" class="block" />

    <div class="stat-grid">
      <div v-for="m in metrics" :key="m.label" class="stat-card">
        <div class="stat-icon" :style="{ background: m.tint, color: m.ink }">
          <el-icon><component :is="m.icon" /></el-icon>
        </div>
        <div class="stat-body">
          <div class="stat-label">{{ m.label }}</div>
          <div class="stat-value" :class="{ 'is-zero': !m.value }">
            {{ m.display }}<span v-if="m.unit && m.value" class="stat-unit">{{ m.unit }}</span>
          </div>
          <div class="stat-sub">{{ m.sub }}</div>
        </div>
      </div>
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-title"><el-icon><Warning /></el-icon>待关注</div>
      </template>
      <div class="attention">
        <div v-if="attention.rushNearDeadline" class="attn danger">
          <el-icon><Timer /></el-icon><b>{{ attention.rushNearDeadline }}</b> 个赶出货临近未完成
        </div>
        <div v-if="attention.overdue" class="attn warn">
          <el-icon><Clock /></el-icon><b>{{ attention.overdue }}</b> 个任务超时未取
        </div>
        <div v-if="attention.unmatchedWaybill" class="attn info">
          <el-icon><Link /></el-icon><b>{{ attention.unmatchedWaybill }}</b> 票待匹配重量
        </div>
        <div v-if="attention.noWaybill" class="attn info">
          <el-icon><Document /></el-icon><b>{{ attention.noWaybill }}</b> 条无票号待补
        </div>
        <div v-if="attention.unresolvedException" class="attn danger">
          <el-icon><Warning /></el-icon><b>{{ attention.unresolvedException }}</b> 个异常未处理
        </div>
        <div v-if="attention.syncFailed" class="attn warn">
          <el-icon><RefreshRight /></el-icon><b>{{ attention.syncFailed }}</b> 次同步失败
        </div>
        <span v-if="!hasAttention" class="all-clear">
          <el-icon><CircleCheck /></el-icon> 暂无需要关注的项
        </span>
      </div>
    </el-card>

    <!-- 列表模式 -->
    <template v-if="mode === 'table'">
      <el-row :gutter="16">
        <el-col :xs="24" :lg="14">
          <el-card shadow="never" class="block">
            <template #header>
              <div class="block-title"><el-icon><Van /></el-icon>取件员排行</div>
            </template>
            <el-table class="desktop-table" :data="workers">
              <el-table-column type="index" label="#" width="52" />
              <el-table-column prop="name" label="取件员" min-width="118">
                <template #default="{ row }">
                  <div class="worker-cell">
                    <span class="avatar-mini">{{ row.name?.slice(0, 1) }}</span>{{ row.name }}
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="pickupCount" label="取件次数" width="92" />
              <el-table-column prop="customerCount" label="客户数" width="80" />
              <el-table-column prop="pieces" label="件数" width="80" />
              <el-table-column label="最终重量" width="112">
                <template #default="{ row }"><b class="qj-num">{{ row.weight }}</b> kg</template>
              </el-table-column>
              <el-table-column prop="assistCount" label="协助" width="70" />
              <el-table-column prop="pending" label="待取" width="70">
                <template #default="{ row }">
                  <span v-if="row.pending" class="qj-badge qj-badge--pending qj-num">{{ row.pending }}</span>
                  <span v-else class="qj-num qj-muted">0</span>
                </template>
              </el-table-column>
            </el-table>
            <div class="mobile-list mobile-list--inset dashboard-mobile-list">
              <div v-for="(row, index) in workers" :key="row.id || row.name" class="mobile-item">
                <div class="mobile-item__head">
                  <div class="worker-cell"><span class="rank">{{ index + 1 }}</span><span class="mobile-item__title">{{ row.name }}</span></div>
                  <strong class="weight qj-num">{{ row.weight || 0 }} kg</strong>
                </div>
                <div class="metric-line"><span>取件 {{ row.pickupCount || 0 }} 次</span><span>客户 {{ row.customerCount || 0 }}</span><span>件数 {{ row.pieces || 0 }}</span><span>待取 {{ row.pending || 0 }}</span></div>
              </div>
              <EmptyState v-if="!workers.length" title="暂无取件员数据" description="该时间段内还没有取件记录" />
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :lg="10">
          <el-card shadow="never" class="block">
            <template #header>
              <div class="block-title"><el-icon><User /></el-icon>客服数据</div>
            </template>
            <el-table class="desktop-table" :data="cs">
              <el-table-column prop="name" label="客服" min-width="96" />
              <el-table-column prop="customerCount" label="负责客户" width="92" />
              <el-table-column prop="shipCustomerCount" label="发货客户" width="92" />
              <el-table-column prop="taskCount" label="取件任务" width="92" />
              <el-table-column label="重量" width="100">
                <template #default="{ row }"><b class="qj-num">{{ row.weight }}</b> kg</template>
              </el-table-column>
            </el-table>
            <div class="mobile-list mobile-list--inset dashboard-mobile-list">
              <div v-for="row in cs" :key="row.id || row.name" class="mobile-item">
                <div class="mobile-item__head"><span class="mobile-item__title">{{ row.name }}</span><strong class="weight qj-num">{{ row.weight || 0 }} kg</strong></div>
                <div class="metric-line"><span>负责客户 {{ row.customerCount || 0 }}</span><span>发货客户 {{ row.shipCustomerCount || 0 }}</span><span>任务 {{ row.taskCount || 0 }}</span></div>
              </div>
              <EmptyState v-if="!cs.length" title="暂无客服数据" description="客服派单量会显示在这里" />
            </div>
          </el-card>

          <el-card shadow="never" class="block">
            <template #header>
              <div class="block-title"><el-icon><OfficeBuilding /></el-icon>客户重量排行</div>
            </template>
            <el-table class="desktop-table" :data="customers.slice(0, 8)">
              <el-table-column type="index" label="#" width="52" />
              <el-table-column prop="name" label="客户" min-width="130" show-overflow-tooltip />
              <el-table-column label="重量" width="110">
                <template #default="{ row }"><b class="qj-num">{{ row.weight }}</b> kg</template>
              </el-table-column>
            </el-table>
            <div class="mobile-list mobile-list--inset dashboard-mobile-list">
              <div v-for="(row, index) in customers.slice(0, 8)" :key="row.id || row.name" class="mobile-item ranking-row">
                <span class="rank">{{ index + 1 }}</span><span class="mobile-item__title">{{ row.name }}</span><strong class="weight qj-num">{{ row.weight || 0 }} kg</strong>
              </div>
              <EmptyState v-if="!customers.length" title="暂无客户数据" description="出货重量排行会显示在这里" />
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="block-title"><el-icon><TrendCharts /></el-icon>每日出货重量趋势（近 30 天）</div>
        </template>
        <el-table class="desktop-table" :data="trends.weight" max-height="300">
          <el-table-column prop="date" label="日期" width="150" />
          <el-table-column label="最终重量 (kg)" min-width="200">
            <template #default="{ row }">
              <div class="trend-row">
                <div class="trend-bar" :style="{ width: barWidth(row.weight) }" />
                <b class="qj-num">{{ row.weight }}</b>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div class="mobile-list mobile-list--inset dashboard-mobile-list trend-mobile-list">
          <div v-for="row in trends.weight" :key="row.date" class="mobile-item ranking-row">
            <span class="mobile-item__title">{{ row.date }}</span><strong class="weight qj-num">{{ row.weight || 0 }} kg</strong>
          </div>
          <EmptyState v-if="!trends.weight.length" title="暂无趋势数据" description="有取件记录后这里会显示 30 天走势" />
        </div>
      </el-card>
    </template>

    <!-- 图表模式 -->
    <template v-else>
      <el-card shadow="never" class="block">
        <template #header>
          <div class="block-title"><el-icon><TrendCharts /></el-icon>每日出货重量趋势</div>
        </template>
        <div ref="trendChartEl" class="chart-box" />
      </el-card>

      <el-row :gutter="16">
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="block">
            <template #header>
              <div class="block-title"><el-icon><Van /></el-icon>取件员重量排行</div>
            </template>
            <div ref="workerChartEl" class="chart-box" />
          </el-card>
        </el-col>
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="block">
            <template #header>
              <div class="block-title"><el-icon><OfficeBuilding /></el-icon>客户重量占比</div>
            </template>
            <div ref="customerChartEl" class="chart-box" />
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="block-title"><el-icon><User /></el-icon>客服重量</div>
        </template>
        <div ref="csChartEl" class="chart-box" />
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import type { ECharts } from 'echarts/core'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const mode = ref<'table' | 'chart'>('table')
const range = ref('today')
const board = reactive<any>({})
const workers = ref<any[]>([])
const cs = ref<any[]>([])
const customers = ref<any[]>([])
const trends = reactive<any>({ weight: [] })
const attention = reactive<any>({})
const loading = ref(false)
const loaded = ref(false)

const trendChartEl = ref<HTMLElement>()
const workerChartEl = ref<HTMLElement>()
const customerChartEl = ref<HTMLElement>()
const csChartEl = ref<HTMLElement>()
let charts: ECharts[] = []
let echartsSetupPromise: Promise<typeof import('../services/echarts-setup')> | null = null
let renderSeq = 0
async function getEchartsSetup() {
  if (!echartsSetupPromise) {
    echartsSetupPromise = import('../services/echarts-setup')
  }
  return echartsSetupPromise
}
const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: loadAll, delayMs: 250 })

const metrics = computed(() => [
  { label: '发货客户数', value: board.shipCustomerCount ?? 0, display: String(board.shipCustomerCount ?? 0), unit: '', sub: '原系统出货口径', icon: 'OfficeBuilding', tint: 'var(--tint-blue)', ink: 'var(--tint-blue-ink)' },
  { label: '最终出货重量', value: board.finalWeight ?? 0, display: String(board.finalWeight ?? 0), unit: 'kg', sub: '唯一重量口径', icon: 'ScaleToOriginal', tint: 'var(--tint-green)', ink: 'var(--tint-green-ink)' },
  { label: '取件客户数', value: board.pickupCustomerCount ?? 0, display: String(board.pickupCustomerCount ?? 0), unit: '', sub: '实际完成去重', icon: 'User', tint: 'var(--tint-sky)', ink: 'var(--tint-sky-ink)' },
  { label: '取件次数', value: board.pickupCount ?? 0, display: String(board.pickupCount ?? 0), unit: '', sub: '已完成任务', icon: 'Van', tint: 'var(--tint-amber)', ink: 'var(--tint-amber-ink)' },
  { label: '取件件数', value: board.pieces ?? 0, display: String(board.pieces ?? 0), unit: '', sub: '现场实录入', icon: 'Box', tint: 'var(--tint-violet)', ink: 'var(--tint-violet-ink)' },
  { label: '待取任务', value: board.pendingCount ?? 0, display: String(board.pendingCount ?? 0), unit: '', sub: '待取 / 取件中', icon: 'List', tint: 'var(--tint-red)', ink: 'var(--tint-red-ink)' },
])

const hasAttention = computed(() =>
  attention.rushNearDeadline || attention.overdue || attention.unmatchedWaybill ||
  attention.noWaybill || attention.unresolvedException || attention.syncFailed)

const maxWeight = computed(() => {
  const arr = trends.weight.map((t: any) => t.weight || 0)
  return Math.max(1, ...arr)
})
function barWidth(w: number) {
  return Math.max(2, Math.round((w / maxWeight.value) * 100)) + '%'
}

async function loadAll() {
  loading.value = true
  try {
    const [b, w, c, cu, t, a] = await Promise.all([
      http.get('/dashboard/board', { params: { range: range.value } }),
      http.get('/dashboard/workers', { params: { range: range.value } }),
      http.get('/dashboard/cs', { params: { range: 'month' } }),
      http.get('/dashboard/customers', { params: { range: 'month' } }),
      http.get('/dashboard/trends', { params: { days: 30 } }),
      http.get('/dashboard/attention'),
    ])
    Object.assign(board, b)
    workers.value = w as any
    cs.value = c as any
    customers.value = cu as any
    trends.weight = (t as any).weight
    Object.assign(attention, a)
    loaded.value = true
  } finally {
    loading.value = false
  }
  if (mode.value === 'chart') {
    await nextTick()
    renderCharts()
  }
}

function disposeCharts() {
  charts.forEach((c) => c.dispose())
  charts = []
}

async function initChart(el: HTMLElement | undefined, option: any, seq: number) {
  if (!el) return
  const setup = await getEchartsSetup()
  if (seq !== renderSeq) return
  const c = setup.createChart(el)
  c.setOption(option)
  charts.push(c)
}

async function renderCharts() {
  const seq = ++renderSeq
  disposeCharts()
  await getEchartsSetup()
  if (seq !== renderSeq) return

  // 出货重量趋势：折线图
  await initChart(trendChartEl.value, {
    color: ['#3370ff'],
    tooltip: { trigger: 'axis' },
    grid: { left: 55, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: trends.weight.map((t: any) => t.date), boundaryGap: false },
    yAxis: { type: 'value', name: 'kg' },
    series: [{
      name: '最终重量', type: 'line', smooth: true,
      data: trends.weight.map((t: any) => t.weight),
      areaStyle: { opacity: 0.08 }, itemStyle: { color: '#3370ff' }, lineStyle: { width: 2.5 },
    }],
  }, seq)

  // 取件员重量排行：横向柱状图
  const ws = [...workers.value].sort((a, b) => (b.weight || 0) - (a.weight || 0))
  await initChart(workerChartEl.value, {
    color: ['#3370ff'],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 90, right: 40, top: 20, bottom: 30 },
    xAxis: { type: 'value', name: 'kg' },
    yAxis: { type: 'category', data: ws.map((w) => w.name), inverse: true },
    series: [{
      type: 'bar', data: ws.map((w) => w.weight), barMaxWidth: 22,
      itemStyle: { borderRadius: [0, 4, 4, 0], color: '#3370ff' },
    }],
  }, seq)

  // 客户重量占比：环形饼图
  const topCustomers = [...customers.value].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 8)
  await initChart(customerChartEl.value, {
    color: ['#3370ff', '#0ea5e9', '#16a34a', '#d97706', '#8b5cf6', '#dc2626', '#0d9488', '#64748b'],
    tooltip: { trigger: 'item', formatter: '{b}: {c} kg ({d}%)' },
    legend: { bottom: 0, type: 'scroll' },
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '44%'],
      data: topCustomers.map((c) => ({ name: c.name, value: c.weight })),
      label: { formatter: '{b}\n{d}%' },
      itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
    }],
  }, seq)

  // 客服重量：柱状图
  await initChart(csChartEl.value, {
    color: ['#16a34a'],
    tooltip: { trigger: 'axis' },
    grid: { left: 55, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: cs.value.map((c) => c.name) },
    yAxis: { type: 'value', name: 'kg' },
    series: [{
      type: 'bar', data: cs.value.map((c) => c.weight), barMaxWidth: 30,
      itemStyle: { borderRadius: [4, 4, 0, 0], color: '#16a34a' },
    }],
  }, seq)
}

watch(mode, async (m) => {
  if (m === 'chart') {
    await nextTick()
    renderCharts()
  } else {
    disposeCharts()
  }
})

function onResize() {
  charts.forEach((c) => c.resize())
}

onMounted(() => {
  loadAll()
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  liveRefresh.dispose()
  window.removeEventListener('resize', onResize)
  disposeCharts()
})
</script>

<style scoped>
.stat-grid {
  display: grid;
  /* 170px 下限保证 1440px 容器 + 220px 侧栏下仍能排满 6 列，窄屏自动降列 */
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.block {
  margin-bottom: var(--sp-4);
}
.attention {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.attn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: var(--r-control);
  font-size: var(--fs-sub);
  border: 1px solid transparent;
}
.attn.danger {
  background: var(--qj-danger-bg);
  color: var(--qj-danger-text);
  border-color: #f6d0d0;
}
.attn.warn {
  background: var(--qj-warning-bg);
  color: var(--qj-warning-text);
  border-color: #f6e0c4;
}
.attn.info {
  background: var(--qj-primary-bg);
  color: var(--qj-primary-text);
  border-color: #d6e2ff;
}
.all-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--qj-success-text);
  font-size: var(--fs-body);
}
.worker-cell {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.avatar-mini {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--qj-primary-bg);
  color: var(--qj-primary-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-meta);
  font-weight: 600;
  flex: none;
}
.rank {
  width: 24px;
  height: 24px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--qj-primary-bg);
  color: var(--qj-primary-text);
  font-size: var(--fs-meta);
  font-weight: 600;
}
.weight {
  flex: none;
  color: var(--qj-text);
  font-size: var(--fs-body);
}
.metric-line,
.ranking-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.metric-line {
  flex-wrap: wrap;
  color: var(--qj-text-2);
  font-size: var(--fs-meta);
}
.ranking-row .mobile-item__title {
  flex: 1;
}
.trend-mobile-list {
  max-height: 320px;
  overflow-y: auto;
}
.trend-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.trend-bar {
  height: 16px;
  border-radius: var(--r-badge);
  background: var(--qj-primary);
  min-width: 2px;
  transition: width var(--dur-base) var(--ease);
}
.chart-box {
  height: 320px;
  width: 100%;
}
@media (max-width: 768px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-3);
  }
}
</style>

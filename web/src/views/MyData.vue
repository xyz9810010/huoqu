<template>
  <div>
    <PageHead title="我的数据" description="今日与本月的取件量、客户数与已回填重量" />

    <div class="stat-grid">
      <div v-for="m in metrics" :key="m.label" class="stat-card">
        <div class="stat-icon" :style="{ background: m.tint, color: m.ink }">
          <el-icon><component :is="m.icon" /></el-icon>
        </div>
        <div class="stat-body">
          <div class="stat-label">{{ m.label }}</div>
          <div class="stat-value" :class="{ 'is-zero': !m.value }">
            {{ m.value }}<span v-if="m.unit && m.value" class="stat-unit">{{ m.unit }}</span>
          </div>
          <div class="stat-sub">{{ m.sub }}</div>
        </div>
      </div>
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-title"><el-icon><InfoFilled /></el-icon>其他</div>
      </template>
      <div class="kv">
        <span class="kv__k">协助次数</span>
        <b class="kv__v qj-num">{{ data.assistCount || 0 }}</b>
      </div>
      <el-alert type="info" :closable="false" class="tip"
                title="最终重量按已回填统计，未回填部分不显示，避免误解为最终完整数据。" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const data = reactive<any>({})

const metrics = computed(() => [
  { label: '今日取件次数', value: data.today?.pickupCount ?? 0, unit: '', sub: '已完成任务', icon: 'Van', tint: 'var(--tint-amber)', ink: 'var(--tint-amber-ink)' },
  { label: '今日客户数', value: data.today?.customerCount ?? 0, unit: '', sub: '去重客户', icon: 'User', tint: 'var(--tint-sky)', ink: 'var(--tint-sky-ink)' },
  { label: '今日件数', value: data.today?.pieces ?? 0, unit: '', sub: '现场实录入', icon: 'Box', tint: 'var(--tint-violet)', ink: 'var(--tint-violet-ink)' },
  { label: '今日已回填重量', value: data.today?.matchedWeight ?? 0, unit: 'kg', sub: '仅统计已回填', icon: 'ScaleToOriginal', tint: 'var(--tint-green)', ink: 'var(--tint-green-ink)' },
  { label: '本月取件次数', value: data.month?.pickupCount ?? 0, unit: '', sub: '已完成任务', icon: 'DataBoard', tint: 'var(--tint-blue)', ink: 'var(--tint-blue-ink)' },
  { label: '本月最终重量', value: data.month?.matchedWeight ?? 0, unit: 'kg', sub: '已回填口径', icon: 'TrendCharts', tint: 'var(--tint-red)', ink: 'var(--tint-red-ink)' },
])

async function load() {
  Object.assign(data, await http.get('/dashboard/me'))
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: load })

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.block {
  margin-bottom: var(--sp-4);
}
.kv {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--qj-border);
}
.kv__k {
  color: var(--qj-text-2);
  font-size: var(--fs-body);
}
.kv__v {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--qj-text);
}
.tip {
  margin-top: var(--sp-3);
}
@media (max-width: 768px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-3);
  }
}
</style>

<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">我的数据</h2>
    <el-row :gutter="16">
      <el-col :span="8" :xs="24" class="data-col">
        <el-card shadow="never">
          <template #header>今日数据</template>
          <div class="kv" v-for="kv in todayItems" :key="kv.label">
            <span>{{ kv.label }}</span><b>{{ kv.value }}</b>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8" :xs="24" class="data-col">
        <el-card shadow="never">
          <template #header>本月数据</template>
          <div class="kv" v-for="kv in monthItems" :key="kv.label">
            <span>{{ kv.label }}</span><b>{{ kv.value }}</b>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8" :xs="24" class="data-col">
        <el-card shadow="never">
          <template #header>其他</template>
          <div class="kv"><span>协助次数</span><b>{{ data.assistCount || 0 }}</b></div>
          <el-alert type="info" :closable="false" style="margin-top:10px"
                    title="最终重量按已回填统计，未回填部分不显示，避免误解为最终完整数据。" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from 'vue'
import http from '../api'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const data = reactive<any>({})

const todayItems = computed(() => [
  { label: '取件次数', value: data.today?.pickupCount ?? 0 },
  { label: '客户数', value: data.today?.customerCount ?? 0 },
  { label: '件数', value: data.today?.pieces ?? 0 },
  { label: '已回填重量(kg)', value: data.today?.matchedWeight ?? 0 },
])
const monthItems = computed(() => [
  { label: '取件次数', value: data.month?.pickupCount ?? 0 },
  { label: '客户数', value: data.month?.customerCount ?? 0 },
  { label: '件数', value: data.month?.pieces ?? 0 },
  { label: '最终重量(kg)', value: data.month?.matchedWeight ?? 0 },
])

async function load() {
  Object.assign(data, await http.get('/dashboard/me'))
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: load })

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.kv {
  display: flex;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
}
.kv span {
  color: #666;
}
.kv b {
  font-size: 18px;
}
@media (max-width: 768px) {
  .data-col {
    margin-bottom: 12px;
  }
  .data-col:last-child {
    margin-bottom: 0;
  }
}
</style>

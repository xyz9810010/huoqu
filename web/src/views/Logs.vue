<template>
  <div>
    <PageHead title="操作日志" description="记录关键写操作，便于追溯谁在什么时候改了什么" />

    <el-card shadow="never" class="list-card">
      <SkeletonBlock v-if="loading && !list.length" :rows="5" />
      <template v-else>
        <el-table v-if="list.length" class="desktop-table" :data="list">
          <el-table-column prop="createdAt" label="时间" width="180" class-name="cell-nowrap">
            <template #default="{ row }">
              <span class="qj-num qj-nowrap">{{ formatTime(row.createdAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="userName" label="操作人" width="110" />
          <el-table-column prop="action" label="操作" width="200" />
          <el-table-column prop="targetType" label="对象类型" width="130" />
          <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
        </el-table>
        <div class="mobile-list">
          <article v-for="row in list" :key="row.id" class="mobile-item log-item">
            <div class="mobile-item__head">
              <div>
                <div class="mobile-item__title">{{ row.action || '操作记录' }}</div>
                <div class="mobile-item__sub qj-num">{{ formatTime(row.createdAt) }}</div>
              </div>
              <span class="operator">{{ row.userName || '系统' }}</span>
            </div>
            <div class="mobile-field"><span class="mobile-field__label">对象</span><span class="mobile-field__value">{{ row.targetType || '—' }} · {{ row.targetId || '—' }}</span></div>
            <div v-if="row.detail" class="log-detail">{{ row.detail }}</div>
          </article>
        </div>
        <EmptyState v-if="!list.length" title="暂无操作日志"
                    description="派单、改派、状态流转等关键操作会被记录在这里" />
      </template>
    </el-card>

    <el-pagination v-if="total > size" background layout="total, prev, pager, next" :total="total" :page-size="size"
                   :current-page="page + 1" @current-change="(p: number) => { page = p - 1; load() }" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'

const list = ref<any[]>([])
const page = ref(0)
const size = 50
const total = ref(0)
const loading = ref(false)

function formatTime(value: string) {
  return (value || '').replace('T', ' ').slice(0, 19)
}

async function load() {
  loading.value = true
  try {
    const data: any = await http.get('/logs', { params: { page: page.value, size } })
    list.value = data.list
    total.value = data.total
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.list-card {
  margin-bottom: var(--sp-4);
}
.operator {
  flex: none;
  color: var(--qj-text-2);
  font-size: var(--fs-sub);
}
.log-detail {
  margin-top: var(--sp-2);
  padding: 9px 10px;
  border-radius: var(--r-badge);
  background: var(--qj-bg);
  color: var(--qj-text-2);
  font-size: var(--fs-meta);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
</style>

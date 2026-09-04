<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">操作日志</h2>
    <el-table class="desktop-table" :data="list">
      <el-table-column prop="createdAt" label="时间" width="170">
        <template #default="{ row }">{{ (row.createdAt || '').replace('T', ' ').slice(0, 19) }}</template>
      </el-table-column>
      <el-table-column prop="userName" label="操作人" width="110" />
      <el-table-column prop="action" label="操作" width="200" />
      <el-table-column prop="targetType" label="对象类型" width="150" />
      <el-table-column prop="targetId" label="对象ID" width="100" />
      <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
    </el-table>
    <div class="mobile-list">
      <article v-for="row in list" :key="row.id" class="mobile-item log-item">
        <div class="mobile-item__head">
          <div>
            <div class="mobile-item__title">{{ row.action || '操作记录' }}</div>
            <div class="mobile-item__sub">{{ formatTime(row.createdAt) }}</div>
          </div>
          <span class="operator">{{ row.userName || '系统' }}</span>
        </div>
        <div class="mobile-field"><span class="mobile-field__label">对象</span><span class="mobile-field__value">{{ row.targetType || '—' }} · {{ row.targetId || '—' }}</span></div>
        <div v-if="row.detail" class="log-detail">{{ row.detail }}</div>
      </article>
      <el-empty v-if="!list.length" description="暂无操作日志" />
    </div>
    <el-pagination background layout="total, prev, pager, next" :total="total" :page-size="size"
                   :current-page="page + 1" @current-change="(p: number) => { page = p - 1; load() }" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import http from '../api'

const list = ref<any[]>([])
const page = ref(0)
const size = 50
const total = ref(0)

function formatTime(value: string) {
  return (value || '').replace('T', ' ').slice(0, 19)
}

async function load() {
  const data: any = await http.get('/logs', { params: { page: page.value, size } })
  list.value = data.list
  total.value = data.total
}

onMounted(load)
</script>

<style scoped>
.operator {
  flex: none;
  color: var(--qj-text-2);
  font-size: 13px;
}
.log-detail {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--qj-bg);
  color: var(--qj-text-2);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
</style>

<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">操作日志</h2>
    <el-table :data="list">
      <el-table-column prop="createdAt" label="时间" width="170">
        <template #default="{ row }">{{ (row.createdAt || '').replace('T', ' ').slice(0, 19) }}</template>
      </el-table-column>
      <el-table-column prop="userName" label="操作人" width="110" />
      <el-table-column prop="action" label="操作" width="200" />
      <el-table-column prop="targetType" label="对象类型" width="150" />
      <el-table-column prop="targetId" label="对象ID" width="100" />
      <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
    </el-table>
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

async function load() {
  const data: any = await http.get('/logs', { params: { page: page.value, size } })
  list.value = data.list
  total.value = data.total
}

onMounted(load)
</script>

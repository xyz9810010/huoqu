<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">待匹配中心</h2>
    <el-card shadow="never">
      <template #header>待匹配中心</template>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom:12px"
                title="无票号记录补票号后自动获取最终重量；有票号但暂无重量会自动匹配原系统同步结果。" />
      <el-table :data="list">
        <el-table-column prop="taskId" label="任务ID" width="90" />
        <el-table-column prop="waybillNo" label="票号" width="160">
          <template #default="{ row }">{{ row.waybillNo || '（无票号）' }}</template>
        </el-table-column>
        <el-table-column prop="pieces" label="件数" width="80" />
        <el-table-column prop="entryMethod" label="录入方式" width="100">
          <template #default="{ row }">{{ entryMethodLabel(row.entryMethod) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.matchStatus === 'pending' ? 'warning' : 'info'">
              {{ row.matchStatus === 'pending' ? '待重量' : '待补票号' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="openMatch(row)">补票号</el-button>
            <el-button size="small" @click="router.push('/tasks/' + row.taskId)">查看任务</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="matchVisible" title="补票号" width="360px">
      <el-input v-model="waybillNo" placeholder="输入票号" @keyup.enter="doMatch" />
      <template #footer>
        <el-button @click="matchVisible = false">取消</el-button>
        <el-button type="primary" @click="doMatch">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import http from '../api'

const router = useRouter()
const list = ref<any[]>([])
const matchVisible = ref(false)
const waybillNo = ref('')
const currentItem = ref<any>(null)

function entryMethodLabel(method: string) {
  const labels: Record<string, string> = { scan: '扫码', manual: '手输', no_waybill: '无票号' }
  return labels[method] || method
}

async function load() {
  list.value = await http.get('/sync/match-center')
}

function openMatch(row: any) {
  currentItem.value = row
  waybillNo.value = row.waybillNo || ''
  matchVisible.value = true
}

async function doMatch() {
  if (!waybillNo.value) return ElMessage.warning('请输入票号')
  const res: any = await http.post(`/sync/match/${currentItem.value.id}`, { waybillNo: waybillNo.value })
  if (res.matched) {
    ElMessage.success(`已匹配，最终重量 ${res.finalWeight} kg`)
  } else {
    ElMessage.info('已补票号，等待原系统同步重量')
  }
  matchVisible.value = false
  load()
}

onMounted(load)
</script>

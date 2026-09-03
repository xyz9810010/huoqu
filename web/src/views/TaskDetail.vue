<template>
  <div>
    <el-page-header @back="router.back()" :content="task.taskNo || '任务详情'" style="margin-bottom:16px" />

    <el-card shadow="never" class="block">
      <el-descriptions :column="3" border>
        <el-descriptions-item label="任务类型">
          <el-tag v-if="task.taskType === 'rush'" type="danger">🔴 赶 {{ fmt(task.rushShipTime) }} 出货</el-tag>
          <el-tag v-else-if="task.taskType === 'scheduled'" type="warning">指定时间 {{ fmt(task.scheduledTime) }}</el-tag>
          <el-tag v-else type="info">普通</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusType(task.status)">{{ statusLabel(task.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="取件员">{{ task.defaultWorkerName || '未分配' }}</el-descriptions-item>
        <el-descriptions-item label="客户">{{ task.customerName }}</el-descriptions-item>
        <el-descriptions-item label="取件点">{{ task.addressPointName }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ task.phone }}</el-descriptions-item>
        <el-descriptions-item label="地址" :span="3">{{ task.address }}</el-descriptions-item>
        <el-descriptions-item label="主客服">{{ task.mainCsName }}</el-descriptions-item>
        <el-descriptions-item label="派单时间">{{ fmt(task.dispatchAt) }}</el-descriptions-item>
        <el-descriptions-item label="完成时间">{{ fmt(task.completedAt) }}</el-descriptions-item>
        <el-descriptions-item label="加急原因" :span="3">{{ task.rushReason }}</el-descriptions-item>
        <el-descriptions-item label="取件备注" :span="3">{{ task.pickupNote }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="head">
          <span>取件货物（{{ task.items?.length || 0 }} 票 / {{ totalPieces }} 件）</span>
          <div v-if="isWorker && canOperate">
            <el-button size="small" type="primary" @click="itemVisible = true">扫码/录单</el-button>
            <el-button size="small" @click="uploadVisible = true">拍照留底</el-button>
            <el-button size="small" type="success" @click="complete">完成取件</el-button>
          </div>
        </div>
      </template>
      <el-table :data="task.items || []" size="small">
        <el-table-column prop="waybillNo" label="票号" width="150">
          <template #default="{ row }">{{ row.waybillNo || '（无票号）' }}</template>
        </el-table-column>
        <el-table-column prop="pieces" label="件数" width="80" />
        <el-table-column prop="entryMethod" label="录入方式" width="100">
          <template #default="{ row }">{{ entryMethodLabel(row.entryMethod) }}</template>
        </el-table-column>
        <el-table-column prop="workerName" label="取件员" width="100" />
        <el-table-column prop="finalWeight" label="最终重量(kg)" width="120" />
        <el-table-column label="匹配状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="matchStatusType(row.matchStatus)">
              {{ matchStatusLabel(row.matchStatus) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never" class="block">
          <template #header>现场照片（{{ task.photos?.length || 0 }}）</template>
          <div class="photos">
            <el-image v-for="p in task.photos" :key="p.id" :src="p.filePath" :preview-src-list="task.photos.map((x: any) => x.filePath)"
                      fit="cover" style="width:96px;height:96px;margin:4px" />
            <el-empty v-if="!task.photos?.length" description="暂无照片" :image-size="60" />
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never" class="block">
          <template #header>取件员 / 异常</template>
          <div class="workers">
            <el-tag v-for="w in task.workers" :key="w.userId" :type="w.role === 'primary' ? 'primary' : 'warning'" style="margin:4px">
              {{ w.name }}（{{ w.role === 'primary' ? '主取' : '协助' }}）
            </el-tag>
          </div>
          <el-divider content-position="left">异常记录</el-divider>
          <div v-for="e in task.exceptions" :key="e.id" style="margin-bottom:8px">
            <el-tag :type="e.resolved ? 'info' : 'danger'" size="small">{{ e.type }}</el-tag>
            <span style="margin-left:8px">{{ e.description }}</span>
            <span v-if="!e.resolved && isCs" style="margin-left:8px">
              <el-button size="small" @click="resolveException(e)">处理</el-button>
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="block">
      <template #header>操作</template>
      <div v-if="isCs">
        <el-button @click="reassignVisible = true">改派</el-button>
        <el-button @click="updateVisible = true">修改时间/类型</el-button>
        <el-button @click="cancel">取消任务</el-button>
        <el-button type="primary" @click="again">再次取件</el-button>
      </div>
      <div v-else-if="isWorker && canOperate">
        <el-button @click="start">开始取件</el-button>
        <el-button @click="transferVisible = true">转派</el-button>
        <el-button @click="assistVisible = true">邀请协助</el-button>
        <el-button type="danger" @click="exceptionVisible = true">上报异常</el-button>
      </div>
    </el-card>

    <!-- 录单 -->
    <el-dialog v-model="itemVisible" title="扫码/录单" width="420px">
      <el-radio-group v-model="itemForm.entryMethod">
        <el-radio-button value="scan">扫码</el-radio-button>
        <el-radio-button value="manual">手输票号</el-radio-button>
        <el-radio-button value="no_waybill">无票号</el-radio-button>
      </el-radio-group>
      <div style="margin-top:16px">
        <el-input v-if="itemForm.entryMethod !== 'no_waybill'" v-model="itemForm.waybillNo" placeholder="票号"
                  @keyup.enter="addItem" />
        <el-input-number v-model="itemForm.pieces" :min="1" label="件数" style="margin-top:12px" />
      </div>
      <template #footer>
        <el-button @click="itemVisible = false">关闭</el-button>
        <el-button type="primary" :loading="adding" @click="addItem">录入（继续扫码）</el-button>
      </template>
    </el-dialog>

    <!-- 上传照片 -->
    <el-dialog v-model="uploadVisible" title="拍照留底" width="420px">
      <el-upload :http-request="uploadPhoto" :show-file-list="false" accept="image/*">
        <el-button type="primary">选择图片上传</el-button>
      </el-upload>
      <div style="margin-top:8px;color:#999">完成取件前至少上传 1 张现场照片</div>
    </el-dialog>

    <!-- 改派 -->
    <el-dialog v-model="reassignVisible" title="改派取件员" width="380px">
      <el-select v-model="assignWorkerId" placeholder="选择取件员" style="width:100%">
        <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <template #footer>
        <el-button @click="reassignVisible = false">取消</el-button>
        <el-button type="primary" @click="doReassign">确认改派</el-button>
      </template>
    </el-dialog>

    <!-- 转派 -->
    <el-dialog v-model="transferVisible" title="转派取件员" width="380px">
      <el-select v-model="assignWorkerId" placeholder="选择取件员" style="width:100%">
        <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <template #footer>
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button type="primary" @click="doTransfer">确认转派</el-button>
      </template>
    </el-dialog>

    <!-- 协助 -->
    <el-dialog v-model="assistVisible" title="邀请协助取件员" width="380px">
      <el-select v-model="assignWorkerId" placeholder="选择取件员" style="width:100%">
        <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <template #footer>
        <el-button @click="assistVisible = false">取消</el-button>
        <el-button type="primary" @click="doAssist">确认邀请</el-button>
      </template>
    </el-dialog>

    <!-- 异常 -->
    <el-dialog v-model="exceptionVisible" title="上报异常" width="420px">
      <el-select v-model="exceptionForm.type" placeholder="异常类型" style="width:100%">
        <el-option v-for="t in exceptionTypes" :key="t" :label="t" :value="t" />
      </el-select>
      <el-input v-model="exceptionForm.description" type="textarea" placeholder="说明" style="margin-top:12px" />
      <template #footer>
        <el-button @click="exceptionVisible = false">取消</el-button>
        <el-button type="danger" @click="reportException">提交</el-button>
      </template>
    </el-dialog>

    <!-- 修改任务 -->
    <el-dialog v-model="updateVisible" title="修改时间/类型" width="420px">
      <el-radio-group v-model="updateForm.taskType">
        <el-radio-button value="normal">普通</el-radio-button>
        <el-radio-button value="scheduled">指定时间</el-radio-button>
        <el-radio-button value="rush">赶出货</el-radio-button>
      </el-radio-group>
      <div style="margin-top:12px">
        <el-date-picker v-if="updateForm.taskType === 'rush'" v-model="updateForm.rushShipTime" type="datetime"
                        value-format="YYYY-MM-DDTHH:mm:ss" placeholder="出货时间" />
        <el-date-picker v-else-if="updateForm.taskType === 'scheduled'" v-model="updateForm.scheduledTime" type="datetime"
                        value-format="YYYY-MM-DDTHH:mm:ss" placeholder="指定时间" />
      </div>
      <el-input v-if="updateForm.taskType === 'rush'" v-model="updateForm.rushReason" placeholder="加急原因" style="margin-top:12px" />
      <template #footer>
        <el-button @click="updateVisible = false">取消</el-button>
        <el-button type="primary" @click="doUpdate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { useAuthStore } from '../stores/auth'
import { createRealtimeRefreshSubscription, taskIdFromRealtimeEvent } from '../services/realtime-events'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = route.params.id as string
const task = reactive<any>({})
const workers = ref<any[]>([])
const itemVisible = ref(false)
const uploadVisible = ref(false)
const reassignVisible = ref(false)
const transferVisible = ref(false)
const assistVisible = ref(false)
const exceptionVisible = ref(false)
const updateVisible = ref(false)
const adding = ref(false)
const assignWorkerId = ref<any>(null)
const itemForm = reactive<any>({ entryMethod: 'scan', waybillNo: '', pieces: 1 })
const exceptionForm = reactive<any>({ type: '', description: '' })
const updateForm = reactive<any>({ taskType: 'normal', rushShipTime: '', rushReason: '', scheduledTime: '' })
const exceptionTypes = ['客户取消', '到场无货', '联系不上', '地址错误', '客户要求改时间', '货物/包装异常', '其他']

const isCs = computed(() => ['cs', 'admin'].includes(auth.role))
const isWorker = computed(() => auth.role === 'worker')
const isBoss = computed(() => ['boss', 'admin'].includes(auth.role))
const totalPieces = computed(() => (task.items || []).reduce((s: number, i: any) => s + (i.pieces || 0), 0))
const canOperate = computed(() => {
  const myCourierId = auth.user?.courierId
  if (!myCourierId || !task.defaultWorkerId) return false
  return task.defaultWorkerId === myCourierId || (task.workers || []).some((w: any) => w.userId === myCourierId)
})

async function load() {
  Object.assign(task, await http.get(`/tasks/${id}`))
}

function fmt(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
}
function statusLabel(s: string) {
  return { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[s] || s
}
function statusType(s: string) {
  return { pending: 'warning', in_progress: 'primary', completed: 'success', cancelled: 'info' }[s] || 'info'
}
function entryMethodLabel(method: string) {
  const labels: Record<string, string> = { scan: '扫码', manual: '手输', no_waybill: '无票号' }
  return labels[method] || method
}
function matchStatusLabel(status: string) {
  const labels: Record<string, string> = { matched: '已回填', pending: '待重量', no_waybill: '待补票号' }
  return labels[status] || status
}
function matchStatusType(status: string) {
  const types: Record<string, 'success' | 'warning' | 'info'> = { matched: 'success', pending: 'warning', no_waybill: 'info' }
  return types[status] || 'info'
}

async function addItem() {
  adding.value = true
  try {
    await http.post(`/tasks/${id}/items`, itemForm)
    itemForm.waybillNo = ''
    load()
  } finally {
    adding.value = false
  }
}

async function uploadPhoto(opt: any) {
  const fd = new FormData()
  fd.append('file', opt.file)
  await http.post(`/tasks/${id}/photos`, fd)
  ElMessage.success('照片已上传')
  load()
}

async function start() {
  await http.post(`/tasks/${id}/start`)
  ElMessage.success('已开始取件')
  load()
}

async function complete() {
  await ElMessageBox.confirm(`本次共 ${task.items?.length || 0} 票 / ${totalPieces.value} 件，照片 ${task.photos?.length || 0} 张，确认完成取件？`, '完成取件')
  await http.post(`/tasks/${id}/complete`)
  ElMessage.success('取件完成')
  router.push(isWorker.value ? '/worker/tasks' : '/tasks')
}

async function doReassign() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${id}/reassign`, { workerId: assignWorkerId.value })
  ElMessage.success('已改派')
  reassignVisible.value = false
  load()
}

async function doTransfer() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${id}/transfer`, { workerId: assignWorkerId.value })
  ElMessage.success('已转派')
  transferVisible.value = false
  load()
}

async function doAssist() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${id}/assist`, { workerId: assignWorkerId.value })
  ElMessage.success('已邀请协助')
  assistVisible.value = false
  load()
}

async function reportException() {
  if (!exceptionForm.type) return ElMessage.warning('请选择异常类型')
  await http.post(`/tasks/${id}/exceptions`, exceptionForm)
  ElMessage.success('异常已上报')
  exceptionVisible.value = false
  exceptionForm.type = ''
  exceptionForm.description = ''
  load()
}

async function resolveException(e: any) {
  const { value } = await ElMessageBox.prompt('处理说明 / 恢复取件或取消任务', '处理异常', {
    inputValue: '',
  }).catch(() => ({ value: null }))
  if (value === null) return
  await http.post(`/exceptions/${e.id}/resolve`, { resolution: value, action: 'resume' })
  ElMessage.success('已处理')
  load()
}

async function cancel() {
  await ElMessageBox.confirm('确认取消该任务？', '取消任务', { type: 'warning' })
  await http.post(`/tasks/${id}/cancel`)
  ElMessage.success('已取消')
  load()
}

async function again() {
  const res: any = await http.post(`/tasks/${id}/again`)
  ElMessage.success('已再次派单')
  router.push(`/tasks/${res.id}`)
}

async function doUpdate() {
  const payload: any = {
    taskType: updateForm.taskType,
    rushShipTime: updateForm.taskType === 'rush' ? updateForm.rushShipTime : null,
    rushReason: updateForm.taskType === 'rush' ? updateForm.rushReason : null,
    scheduledTime: updateForm.taskType === 'scheduled' ? updateForm.scheduledTime : null,
    scheduledKind: updateForm.taskType === 'scheduled' ? 'before' : null,
  }
  await http.put(`/tasks/${id}`, payload)
  ElMessage.success('已更新')
  updateVisible.value = false
  load()
}

onMounted(async () => {
  workers.value = (await http.get('/employees/workers')) as any[]
  load()
})
const liveRefresh = createRealtimeRefreshSubscription({
  predicate: event => taskIdFromRealtimeEvent(event) === id,
  refresh: load,
})
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.photos {
  display: flex;
  flex-wrap: wrap;
}
</style>

<template>
  <div>
    <header class="detail-bar">
      <button type="button" class="back-btn" aria-label="返回" @click="goBack">
        <el-icon :size="20"><ArrowLeft /></el-icon>
      </button>
      <div class="bar-text">
        <div class="bar-no">{{ task.taskNo || '任务详情' }}</div>
        <div class="bar-sub">{{ task.customerName }}</div>
      </div>
      <el-tag class="bar-tag" size="small" :type="statusType(task.status) as any">{{ statusLabel(task.status) }}</el-tag>
    </header>

    <!-- 客户与取件信息 -->
    <el-card shadow="never" class="block info-card">
      <div class="who-line">
        <span class="who">{{ task.customerName || '未命名客户' }}</span>
        <el-tag v-if="task.taskType === 'rush'" type="danger">🔴 赶 {{ fmt(task.rushShipTime) }} 出货</el-tag>
        <el-tag v-else-if="task.taskType === 'scheduled'" type="warning">⏰ 指定时间 {{ fmt(task.scheduledTime) }}</el-tag>
      </div>
      <div class="addr-box">
        <el-icon :size="18" class="ic"><Location /></el-icon>
        <div class="addr-txt">
          <div class="addr-main">{{ task.address }}</div>
          <div v-if="task.addressPointName" class="addr-sub">{{ task.addressPointName }}</div>
        </div>
      </div>
      <div class="contact-box">
        <span v-if="task.contact" class="contact-name">{{ task.contact }}</span>
        <a v-if="task.phone" class="tel" :href="'tel:' + task.phone">
          <el-icon :size="15"><Phone /></el-icon>{{ task.phone }}
        </a>
      </div>
      <div class="meta-grid">
        <div v-if="task.defaultWorkerName" class="meta"><span>取件员</span><b>{{ task.defaultWorkerName }}</b></div>
        <div v-if="task.mainCsName" class="meta"><span>主客服</span><b>{{ task.mainCsName }}</b></div>
        <div class="meta"><span>派单时间</span><b>{{ fmt(task.dispatchAt) || '—' }}</b></div>
        <div v-if="task.completedAt" class="meta"><span>完成时间</span><b>{{ fmt(task.completedAt) }}</b></div>
      </div>
      <div v-if="task.pickupNote" class="note-line">📝 取件备注：{{ task.pickupNote }}</div>
      <div class="quick-actions">
        <el-button size="small" text type="primary" @click="copyAddr">复制地址</el-button>
        <el-button size="small" text type="primary" @click="copyFull">复制取件信息</el-button>
        <el-button size="small" text type="primary" @click="navigate">导航</el-button>
      </div>
    </el-card>

    <!-- 取件员操作 -->
    <el-card v-if="isWorker && canOperate && (task.status === 'pending' || task.status === 'in_progress')"
             shadow="never" class="block action-card">
      <template #header>取件操作</template>
      <div v-if="task.status === 'pending'" class="worker-action">
        <el-button type="primary" size="large" class="action-main" :loading="starting" @click="start">开始取件</el-button>
        <p class="hint">开始后即可扫码录单、拍照留底</p>
      </div>
      <div v-else class="worker-action">
        <el-button type="success" size="large" class="action-main" @click="complete">完成取件</el-button>
        <p class="hint">完成前请上传至少 1 张现场照片</p>
        <div class="grid2">
          <el-button type="primary" @click="itemVisible = true">扫码 / 录单</el-button>
          <el-button @click="uploadVisible = true">拍照留底</el-button>
          <el-button @click="transferVisible = true">转派</el-button>
          <el-button @click="assistVisible = true">邀请协助</el-button>
          <el-button type="danger" plain @click="exceptionVisible = true">上报异常</el-button>
        </div>
      </div>
    </el-card>
    <el-alert v-else-if="isWorker && (task.status === 'completed' || task.status === 'cancelled')"
              class="state-alert" :closable="false" show-icon
              :type="task.status === 'completed' ? 'success' : 'info'"
              :title="task.status === 'completed' ? '该任务已完成取件' : '该任务已取消，如仍需取件请联系客服再次派单'" />

    <!-- 客服管理操作 -->
    <el-card v-if="isCs" shadow="never" class="block action-card">
      <template #header>管理操作</template>
      <div class="grid2">
        <el-button v-if="task.status === 'pending' || task.status === 'in_progress'" @click="reassignVisible = true">改派取件员</el-button>
        <el-button v-if="task.status === 'pending' || task.status === 'in_progress'" @click="updateVisible = true">修改时间 / 类型</el-button>
        <el-button v-if="task.status === 'pending' || task.status === 'in_progress'" type="danger" plain @click="cancel">取消任务</el-button>
        <el-button type="primary" @click="again">再次取件</el-button>
      </div>
      <el-alert v-if="task.status === 'completed'" class="mini-alert" :closable="false" type="success"
                title="已完成取件；如需为客户再次派单请点「再次取件」" />
      <el-alert v-else-if="task.status === 'cancelled'" class="mini-alert" :closable="false" type="info"
                title="该任务已取消" />
    </el-card>

    <!-- 取件货物 -->
    <el-card shadow="never" class="block">
      <template #header>
        <span>取件货物（{{ task.items?.length || 0 }} 票 / {{ totalPieces }} 件）</span>
      </template>
      <div class="items-table">
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
      </div>
      <div v-if="(task.items || []).length" class="mobile-items">
        <div v-for="(row, index) in task.items" :key="row.id" class="m-item">
          <div class="m-top">
            <span class="m-idx">{{ index + 1 }}</span>
            <span class="m-no">{{ row.waybillNo || '（无票号）' }}</span>
            <el-tag size="small" :type="matchStatusType(row.matchStatus)">{{ matchStatusLabel(row.matchStatus) }}</el-tag>
          </div>
          <div class="m-meta">
            {{ row.pieces || 0 }} 件 · {{ entryMethodLabel(row.entryMethod) }} · {{ row.workerName || '—' }} · {{ row.finalWeight ?? 0 }}kg
          </div>
        </div>
      </div>
      <div v-else class="no-items">本单尚未录入货物</div>
    </el-card>

    <!-- 现场照片 -->
    <el-card shadow="never" class="block">
      <template #header>现场照片（{{ task.photos?.length || 0 }}）</template>
      <div class="photos">
        <el-image v-for="p in task.photos" :key="p.id" :src="p.filePath"
                  :preview-src-list="task.photos.map((x: any) => x.filePath)" fit="cover" class="photo-img" />
        <el-empty v-if="!task.photos?.length" description="暂无照片" :image-size="60" />
      </div>
    </el-card>

    <!-- 协作与异常 -->
    <el-card shadow="never" class="block">
      <template #header>协作与异常</template>
      <div class="workers">
        <el-tag v-for="w in task.workers" :key="w.userId" :type="w.role === 'primary' ? 'primary' : 'warning'">
          {{ w.name }}（{{ w.role === 'primary' ? '主取' : '协助' }}）
        </el-tag>
        <span v-if="!(task.workers || []).length" class="muted">暂无取件员</span>
      </div>
      <el-divider content-position="left">异常记录</el-divider>
      <div v-for="e in task.exceptions" :key="e.id" class="exc-row">
        <el-tag :type="e.resolved ? 'info' : 'danger'" size="small">{{ e.type }}</el-tag>
        <span class="exc-desc">{{ e.description }}</span>
        <el-button v-if="!e.resolved && isCs" size="small" @click="resolveException(e)">处理</el-button>
      </div>
      <el-empty v-if="!(task.exceptions || []).length" description="暂无异常记录" :image-size="50" />
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
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, Location, Phone } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import http from '../api'
import { useAuthStore } from '../stores/auth'
import { createRealtimeRefreshSubscription, taskIdFromRealtimeEvent } from '../services/realtime-events'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const taskId = computed(() => route.params.id as string)

function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push(isWorker.value ? '/worker/tasks' : '/tasks')
  }
}
const task = reactive<any>({})
const workers = ref<any[]>([])
const starting = ref(false)
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

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  const data: any = await http.get(`/tasks/${taskId.value}`)
  if (seq !== loadSeq) return
  Object.keys(task).forEach(key => delete task[key])
  Object.assign(task, data)
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 剪贴板权限被拒时降级为传统复制，兼容局域网 HTTP/非安全上下文
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

async function copyAddr() {
  const ok = await copyText(task.address || '')
  ElMessage.success(ok ? '地址已复制' : '复制失败，请手动复制')
}

async function copyFull() {
  const text = `客户：${task.customerName}\n取件点：${task.addressPointName}\n地址：${task.address}\n联系人：${task.contact}\n电话：${task.phone}`
  const ok = await copyText(text)
  ElMessage.success(ok ? '取件信息已复制' : '复制失败，请手动复制')
}

function navigate() {
  const q = encodeURIComponent(task.address || '')
  window.open(`https://uri.amap.com/search?keyword=${q}`, '_blank')
}

async function addItem() {
  adding.value = true
  try {
    await http.post(`/tasks/${taskId.value}/items`, itemForm)
    itemForm.waybillNo = ''
    load()
  } finally {
    adding.value = false
  }
}

async function uploadPhoto(opt: any) {
  const fd = new FormData()
  fd.append('file', opt.file)
  await http.post(`/tasks/${taskId.value}/photos`, fd)
  ElMessage.success('照片已上传')
  load()
}

async function start() {
  if (task.status !== 'pending') return
  starting.value = true
  try {
    await http.post(`/tasks/${taskId.value}/start`)
  } finally {
    starting.value = false
  }
  ElMessage.success('已开始取件')
  load()
}

async function complete() {
  await ElMessageBox.confirm(`本次共 ${task.items?.length || 0} 票 / ${totalPieces.value} 件，照片 ${task.photos?.length || 0} 张，确认完成取件？`, '完成取件')
  await http.post(`/tasks/${taskId.value}/complete`)
  ElMessage.success('取件完成')
  router.push(isWorker.value ? '/worker/tasks' : '/tasks')
}

async function doReassign() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${taskId.value}/reassign`, { workerId: assignWorkerId.value })
  ElMessage.success('已改派')
  reassignVisible.value = false
  load()
}

async function doTransfer() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${taskId.value}/transfer`, { workerId: assignWorkerId.value })
  ElMessage.success('已转派')
  transferVisible.value = false
  load()
}

async function doAssist() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择取件员')
  await http.post(`/tasks/${taskId.value}/assist`, { workerId: assignWorkerId.value })
  ElMessage.success('已邀请协助')
  assistVisible.value = false
  load()
}

async function reportException() {
  if (!exceptionForm.type) return ElMessage.warning('请选择异常类型')
  await http.post(`/tasks/${taskId.value}/exceptions`, exceptionForm)
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
  await http.post(`/tasks/${taskId.value}/cancel`)
  ElMessage.success('已取消')
  load()
}

async function again() {
  const res: any = await http.post(`/tasks/${taskId.value}/again`)
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
  await http.put(`/tasks/${taskId.value}`, payload)
  ElMessage.success('已更新')
  updateVisible.value = false
  load()
}

watch(taskId, () => {
  itemVisible.value = false
  uploadVisible.value = false
  reassignVisible.value = false
  transferVisible.value = false
  assistVisible.value = false
  exceptionVisible.value = false
  updateVisible.value = false
  load()
})

onMounted(async () => {
  workers.value = (await http.get('/employees/workers')) as any[]
  load()
})
const liveRefresh = createRealtimeRefreshSubscription({
  predicate: event => taskIdFromRealtimeEvent(event) === taskId.value,
  refresh: load,
})
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.detail-bar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -20px -24px 16px;
  padding: 10px 24px;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--qj-border);
}
.back-btn {
  flex: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--qj-border);
  background: #fff;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--qj-text-2);
  padding: 0;
}
.back-btn:active {
  background: #f2f3f5;
}
.bar-text {
  flex: 1;
  min-width: 0;
  line-height: 1.35;
}
.bar-no {
  font-size: 16px;
  font-weight: 600;
  color: var(--qj-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-sub {
  font-size: 12px;
  color: var(--qj-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-tag {
  flex: none;
}
.block {
  margin-bottom: 16px;
}
.info-card :deep(.el-card__body) {
  padding: 18px 20px;
}
.who-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.who {
  font-size: 19px;
  font-weight: 700;
  color: var(--qj-text);
}
.addr-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  background: var(--qj-bg);
  border-radius: 8px;
}
.addr-box .ic {
  flex: none;
  margin-top: 2px;
  color: var(--el-color-primary);
}
.addr-main {
  font-size: 15px;
  line-height: 1.5;
  color: var(--qj-text);
  overflow-wrap: anywhere;
}
.addr-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--qj-muted);
}
.contact-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.contact-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--qj-text);
}
.tel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-primary);
  text-decoration: none;
  background: var(--el-color-primary-light-9);
  border-radius: 999px;
  padding: 6px 12px;
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 24px;
  margin-top: 14px;
}
.meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px dashed var(--qj-border);
  padding-bottom: 6px;
}
.meta span {
  font-size: 12px;
  color: var(--qj-muted);
  flex: none;
}
.meta b {
  font-size: 13px;
  color: var(--qj-text);
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}
.note-line {
  margin-top: 12px;
  padding: 8px 12px;
  background: #fff7ec;
  border-radius: 8px;
  font-size: 13px;
  color: #b26a00;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 10px;
}
.quick-actions :deep(.el-button) {
  margin-left: 0;
  padding: 6px 10px;
  height: auto;
}
.action-card :deep(.el-card__header) {
  padding-top: 12px;
  padding-bottom: 12px;
}
.worker-action {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.action-main {
  width: 100%;
  height: 48px;
  font-size: 17px;
  margin-left: 0;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--qj-muted);
  text-align: center;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.grid2 .el-button {
  margin-left: 0;
  width: 100%;
}
.grid2 .el-button:only-child {
  grid-column: 1 / -1;
}
.state-alert {
  margin-bottom: 16px;
}
.mini-alert {
  margin-top: 12px;
}
.workers {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.muted {
  color: var(--qj-muted);
  font-size: 13px;
}
.exc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  flex-wrap: wrap;
}
.exc-desc {
  flex: 1;
  min-width: 140px;
  font-size: 13px;
  color: var(--qj-text-2);
  overflow-wrap: anywhere;
}
.items-table {
  overflow-x: auto;
}
.items-table .el-table {
  min-width: 640px;
}
.mobile-items,
.no-items {
  display: none;
}
.m-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--qj-border);
  border-radius: 8px;
  margin-bottom: 8px;
}
.m-item:last-child {
  margin-bottom: 0;
}
.m-idx {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.m-no {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.m-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.m-meta {
  flex: none;
  font-size: 12px;
  color: var(--qj-muted);
  white-space: nowrap;
}
.photos {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}
.photo-img {
  width: 100% !important;
  height: 96px;
  border-radius: 8px;
  background: #f2f3f5;
}
@media (max-width: 768px) {
  .detail-bar {
    margin: -14px -12px 12px;
    padding: 8px 12px;
  }
  .bar-no {
    font-size: 15px;
  }
  .items-table {
    display: none;
  }
  .mobile-items,
  .no-items {
    display: block;
  }
  .no-items {
    text-align: center;
    color: var(--qj-muted);
    font-size: 13px;
    padding: 14px 0;
  }
  .m-item {
    flex-wrap: wrap;
  }
  .m-top {
    flex-basis: 100%;
  }
  .m-meta {
    flex-basis: 100%;
    padding-left: 32px;
    white-space: normal;
    line-height: 1.5;
  }
  .exc-row {
    align-items: flex-start;
  }
  .exc-row .el-button {
    margin-left: 32px;
  }
  .meta-grid {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .quick-actions :deep(.el-button),
  .grid2 .el-button {
    width: 100%;
    min-height: 44px;
    margin-left: 0;
  }
  .who {
    font-size: 17px;
  }
}
</style>

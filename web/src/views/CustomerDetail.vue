<template>
  <div>
    <el-page-header @back="router.back()" :content="customer.name || '客户详情'" style="margin-bottom:16px" />

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>客户资料</span>
          <div>
            <el-button size="small" @click="goDispatch">派单</el-button>
            <el-button size="small" type="primary" @click="openEdit">编辑</el-button>
            <el-button size="small" :type="customer.status === 'active' ? 'danger' : 'success'" @click="toggleStatus">
              {{ customer.status === 'active' ? '停用' : '启用' }}
            </el-button>
          </div>
        </div>
      </template>
      <el-descriptions class="desktop-descriptions" :column="3" border>
        <el-descriptions-item label="编号">{{ customer.customerNo }}</el-descriptions-item>
        <el-descriptions-item label="客户名称">{{ customer.name }}</el-descriptions-item>
        <el-descriptions-item label="主客服">{{ customer.mainCsName }}</el-descriptions-item>
        <el-descriptions-item label="联系人">{{ customer.contactName }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ customer.contactPhone }}</el-descriptions-item>
        <el-descriptions-item label="原系统ID">{{ customer.legacyCustomerId }}</el-descriptions-item>
        <el-descriptions-item label="重要提醒" :span="3">{{ customer.importantNote }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="3">{{ customer.remark }}</el-descriptions-item>
        <el-descriptions-item label="订单进度" :span="3">
          <template v-if="customer.taskCount">
            <el-tag v-if="customer.openTaskCount" type="warning" size="small">待办 {{ customer.openTaskCount }}</el-tag>
            <el-tag v-else type="success" size="small">全部完成</el-tag>
            <span class="order-count">已完成 {{ customer.completedTaskCount || 0 }} / {{ customer.taskCount }} 单</span>
          </template>
          <span v-else class="order-count">暂无取件订单</span>
        </el-descriptions-item>
      </el-descriptions>
      <div class="mobile-detail-list">
        <div class="mobile-field"><span class="mobile-field__label">编号</span><span class="mobile-field__value">{{ customer.customerNo || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">客户名称</span><span class="mobile-field__value">{{ customer.name || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">主客服</span><span class="mobile-field__value">{{ customer.mainCsName || '未分配' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">联系人</span><span class="mobile-field__value">{{ customer.contactName || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">联系电话</span><span class="mobile-field__value">{{ customer.contactPhone || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">原系统 ID</span><span class="mobile-field__value">{{ customer.legacyCustomerId || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">重要提醒</span><span class="mobile-field__value">{{ customer.importantNote || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">备注</span><span class="mobile-field__value">{{ customer.remark || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">订单进度</span><span class="mobile-field__value">
          <template v-if="customer.taskCount">
            <el-tag v-if="customer.openTaskCount" type="warning" size="small">待办 {{ customer.openTaskCount }}</el-tag>
            <el-tag v-else type="success" size="small">全部完成</el-tag>
            <span style="margin-left:6px">已完成 {{ customer.completedTaskCount || 0 }}/{{ customer.taskCount }}</span>
          </template>
          <span v-else>暂无取件订单</span>
        </span></div>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>取件地址</span>
          <el-button size="small" type="success" @click="openAddAddr">新增地址</el-button>
        </div>
      </template>
      <el-table class="desktop-table" :data="customer.addresses || []">
        <el-table-column prop="name" label="取件点名称" width="140" />
        <el-table-column prop="address" label="完整地址" min-width="220" />
        <el-table-column prop="contactName" label="联系人" width="100" />
        <el-table-column prop="contactPhone" label="电话" width="130" />
        <el-table-column prop="areaId" label="区域" width="100">
          <template #default="{ row }">{{ areaName(row.areaId) }}</template>
        </el-table-column>
        <el-table-column label="常用" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.isCommon" size="small" type="warning">常用</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-button size="small" @click="openEditAddr(row)">编辑</el-button>
            <el-button size="small" @click="toggleAddr(row)">{{ row.isActive ? '停用' : '启用' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-list mobile-list--inset">
        <article v-for="row in customer.addresses || []" :key="row.id" class="mobile-item">
          <div class="mobile-item__head">
            <div>
              <div class="mobile-item__title">{{ row.name }}</div>
              <div class="mobile-item__sub">{{ row.address }}</div>
            </div>
            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
          </div>
          <div class="mobile-field"><span class="mobile-field__label">联系人</span><span class="mobile-field__value">{{ row.contactName || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">电话</span><span class="mobile-field__value">{{ row.contactPhone || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">所属区域</span><span class="mobile-field__value">{{ areaName(row.areaId) || '未设置' }}</span></div>
          <div v-if="row.isCommon" class="common-mark">常用地址</div>
          <div class="mobile-item__actions">
            <el-button @click="openEditAddr(row)">编辑</el-button>
            <el-button @click="toggleAddr(row)">{{ row.isActive ? '停用' : '启用' }}</el-button>
          </div>
        </article>
        <el-empty v-if="!(customer.addresses || []).length" description="暂无取件地址" />
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>取件订单</span>
          <el-tag v-if="customer.openTaskCount" type="warning" size="small">待办 {{ customer.openTaskCount }}</el-tag>
        </div>
      </template>
      <el-table class="desktop-table" :data="tasks" @row-click="(r: any) => router.push('/tasks/' + r.id)" style="cursor:pointer">
        <el-table-column prop="taskNo" label="任务号" width="150" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status) as any">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.taskType === 'rush'" type="danger" size="small">加急</el-tag>
            <el-tag v-else-if="row.taskType === 'scheduled'" type="warning" size="small">预约</el-tag>
            <span v-else>普通</span>
          </template>
        </el-table-column>
        <el-table-column prop="defaultWorkerName" label="取件员" width="100" />
        <el-table-column label="地址" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.addressPointName || row.address || '—' }}</template>
        </el-table-column>
        <el-table-column label="派单时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.dispatchAt) || fmtTime(row.createdAt) || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" @click.stop="router.push('/tasks/' + row.id)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-list mobile-list--inset">
        <article v-for="row in tasks" :key="row.id" class="mobile-item mobile-item--clickable"
                 @click="router.push('/tasks/' + row.id)">
          <div class="mobile-item__head">
            <div>
              <div class="mobile-item__title">{{ row.taskNo }}</div>
              <div class="mobile-item__sub">{{ row.customerName || '客户' }}</div>
            </div>
            <el-tag :type="statusType(row.status) as any" size="small">{{ statusLabel(row.status) }}</el-tag>
          </div>
          <div class="mobile-field"><span class="mobile-field__label">地址</span><span class="mobile-field__value">{{ row.addressPointName || row.address || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">取件员</span><span class="mobile-field__value">{{ row.defaultWorkerName || '未分配' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">派单时间</span><span class="mobile-field__value">{{ fmtTime(row.dispatchAt) || fmtTime(row.createdAt) || '—' }}</span></div>
        </article>
        <el-empty v-if="!tasks.length" description="该客户暂无取件订单" />
      </div>
    </el-card>

    <el-dialog v-model="editVisible" title="编辑客户" width="560px">
      <el-form :model="editForm" label-width="110px">
        <el-form-item label="客户名称" required><el-input v-model="editForm.name" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="editForm.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="editForm.contactPhone" /></el-form-item>
        <el-form-item label="原系统ID"><el-input v-model="editForm.legacyCustomerId" /></el-form-item>
        <el-form-item label="重要提醒"><el-input v-model="editForm.importantNote" type="textarea" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="editForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addrVisible" :title="addrForm.id ? '编辑地址' : '新增地址'" width="560px">
      <el-form :model="addrForm" label-width="110px">
        <el-form-item label="取件点名称" required><el-input v-model="addrForm.name" /></el-form-item>
        <el-form-item label="完整地址" required><el-input v-model="addrForm.address" type="textarea" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="addrForm.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="addrForm.contactPhone" /></el-form-item>
        <el-form-item label="所属区域">
          <el-select v-model="addrForm.areaId" clearable placeholder="选择区域">
            <el-option v-for="a in areas" :key="a.id" :label="a.name" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="常用地址"><el-switch v-model="addrForm.isCommon" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="addrForm.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addrVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAddr">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import http from '../api'

const route = useRoute()
const router = useRouter()
const id = route.params.id as string
const customer = reactive<any>({})
const areas = ref<any[]>([])
const tasks = ref<any[]>([])
const editVisible = ref(false)
const addrVisible = ref(false)
const editForm = reactive<any>({})
const addrForm = reactive<any>({})

async function load() {
  Object.assign(customer, await http.get(`/customers/${id}`))
}

async function loadTasks() {
  const data: any = await http.get('/tasks', { params: { customerId: id, page: 0, size: 20 } })
  tasks.value = Array.isArray(data) ? data : data.list || []
}

function statusLabel(s: string) {
  return { pending: '待取', in_progress: '取件中', completed: '已完成', cancelled: '已取消' }[s] || s
}
function statusType(s: string) {
  return { pending: 'warning', in_progress: 'primary', completed: 'success', cancelled: 'info' }[s] || 'info'
}
function fmtTime(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
}

function areaName(aid: number) {
  return areas.value.find((a) => a.id === aid)?.name || ''
}

function openEdit() {
  Object.assign(editForm, {
    name: customer.name, contactName: customer.contactName, contactPhone: customer.contactPhone,
    legacyCustomerId: customer.legacyCustomerId, importantNote: customer.importantNote, remark: customer.remark,
  })
  editVisible.value = true
}

async function submitEdit() {
  await http.put(`/customers/${id}`, editForm)
  ElMessage.success('已保存')
  editVisible.value = false
  load()
}

async function toggleStatus() {
  const s = customer.status === 'active' ? 'disabled' : 'active'
  await http.patch(`/customers/${id}/status`, null, { params: { status: s } })
  ElMessage.success('已更新')
  load()
}

function openAddAddr() {
  Object.assign(addrForm, { id: null, name: '', address: '', contactName: '', contactPhone: '', areaId: null, isCommon: false, remark: '' })
  addrVisible.value = true
}

function openEditAddr(row: any) {
  Object.assign(addrForm, row)
  addrVisible.value = true
}

async function submitAddr() {
  if (addrForm.id) {
    await http.put(`/addresses/${addrForm.id}`, addrForm)
  } else {
    await http.post(`/customers/${id}/addresses`, addrForm)
  }
  ElMessage.success('已保存')
  addrVisible.value = false
  load()
}

async function toggleAddr(row: any) {
  await http.patch(`/addresses/${row.id}/status`, null, { params: { isActive: !row.isActive } })
  load()
}

function goDispatch() {
  router.push({ path: '/dispatch', query: { customerId: id } })
}

onMounted(async () => {
  areas.value = (await http.get('/areas')) as any[]
  load()
  loadTasks()
})
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}
.order-count {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.common-mark {
  margin-top: 6px;
  color: var(--el-color-warning);
  font-size: 12px;
}
@media (max-width: 768px) {
  .card-head {
    align-items: flex-start;
    gap: 12px;
  }
  .card-head > div {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .card-head .el-button {
    margin-left: 0;
  }
  .mobile-detail-list {
    gap: 0;
  }
  .mobile-detail-list .mobile-field {
    border-bottom: 1px solid var(--qj-border);
  }
  .mobile-detail-list .mobile-field:last-child {
    border-bottom: 0;
  }
}
</style>

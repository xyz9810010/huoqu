<template>
  <div>
    <PageHead :title="customer.name || '客户详情'" :description="'编号 ' + (customer.customerNo || '—')">
      <template #actions>
        <el-button @click="goDispatch">派单</el-button>
        <el-button type="primary" @click="openEdit">编辑</el-button>
        <el-button :type="customer.status === 'active' ? 'danger' : 'success'" plain @click="toggleStatus">
          {{ customer.status === 'active' ? '停用' : '启用' }}
        </el-button>
      </template>
    </PageHead>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-title"><el-icon><User /></el-icon>客户资料</div>
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
            <span v-if="customer.openTaskCount" class="qj-badge qj-badge--pending">待办 {{ customer.openTaskCount }}</span>
            <span v-else class="qj-badge qj-badge--done">全部完成</span>
            <span class="order-count qj-num">已完成 {{ customer.completedTaskCount || 0 }} / {{ customer.taskCount }} 单</span>
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
            <span v-if="customer.openTaskCount" class="qj-badge qj-badge--pending">待办 {{ customer.openTaskCount }}</span>
            <span v-else class="qj-badge qj-badge--done">全部完成</span>
            <span class="order-count">已完成 {{ customer.completedTaskCount || 0 }}/{{ customer.taskCount }}</span>
          </template>
          <span v-else>暂无取件订单</span>
        </span></div>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <div class="block-title"><el-icon><Location /></el-icon>取件地址</div>
          <el-button size="small" type="primary" plain @click="openAddAddr">新增地址</el-button>
        </div>
      </template>
      <el-table v-if="(customer.addresses || []).length" class="desktop-table" :data="customer.addresses || []">
        <el-table-column prop="name" label="取件点名称" width="130" />
        <el-table-column prop="address" label="完整地址" min-width="200" show-overflow-tooltip />
        <el-table-column prop="contactName" label="联系人" width="96" />
        <el-table-column prop="contactPhone" label="电话" width="130" class-name="cell-nowrap" />
        <el-table-column prop="areaId" label="区域" width="100">
          <template #default="{ row }">{{ areaName(row.areaId) || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <StatusBadge :tone="row.isActive ? 'done' : 'cancel'" :label="row.isActive ? '启用' : '停用'" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
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
            <StatusBadge :tone="row.isActive ? 'done' : 'cancel'" :label="row.isActive ? '启用' : '停用'" />
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
      </div>
      <EmptyState v-if="!(customer.addresses || []).length" title="暂无取件地址"
                  description="为客户添加取件地址后，派单时可直接选择">
        <el-button type="primary" @click="openAddAddr">新增地址</el-button>
      </EmptyState>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <div class="block-title"><el-icon><List /></el-icon>取件订单</div>
          <span v-if="customer.openTaskCount" class="qj-badge qj-badge--pending">待办 {{ customer.openTaskCount }}</span>
        </div>
      </template>
      <el-table v-if="tasks.length" class="desktop-table" :data="tasks"
                @row-click="(r: any) => router.push('/tasks/' + r.id)" style="cursor:pointer">
        <el-table-column prop="taskNo" label="任务号" width="168" class-name="cell-nowrap" />
        <el-table-column label="状态" width="104">
          <template #default="{ row }">
            <StatusBadge :status="row.status" />
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <span v-if="row.taskType === 'rush'" class="qj-badge qj-badge--danger">加急</span>
            <span v-else-if="row.taskType === 'scheduled'" class="qj-badge qj-badge--pending">预约</span>
            <span v-else class="qj-badge qj-badge--plain">普通</span>
          </template>
        </el-table-column>
        <el-table-column prop="defaultWorkerName" label="取件员" width="100">
          <template #default="{ row }">{{ row.defaultWorkerName || '未分配' }}</template>
        </el-table-column>
        <el-table-column label="地址" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.addressPointName || row.address || '—' }}</template>
        </el-table-column>
        <el-table-column label="派单时间" width="152">
          <template #default="{ row }">
            <span class="qj-num qj-nowrap">{{ fmtTime(row.dispatchAt) || fmtTime(row.createdAt) || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="88">
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
              <div class="mobile-item__title qj-num">{{ row.taskNo }}</div>
              <div class="mobile-item__sub">{{ row.customerName || '客户' }}</div>
            </div>
            <StatusBadge :status="row.status" />
          </div>
          <div class="mobile-field"><span class="mobile-field__label">地址</span><span class="mobile-field__value">{{ row.addressPointName || row.address || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">取件员</span><span class="mobile-field__value">{{ row.defaultWorkerName || '未分配' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">派单时间</span><span class="mobile-field__value">{{ fmtTime(row.dispatchAt) || fmtTime(row.createdAt) || '—' }}</span></div>
        </article>
      </div>
      <EmptyState v-if="!tasks.length" title="该客户暂无取件订单"
                  description="从右上角「派单」创建第一条取件任务" />
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
import { List, Location, User } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import StatusBadge from '../components/StatusBadge.vue'
import EmptyState from '../components/EmptyState.vue'

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
  margin-bottom: var(--sp-4);
}
.order-count {
  margin-left: var(--sp-2);
  color: var(--qj-text-2);
  font-size: var(--fs-sub);
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
}
.common-mark {
  margin-top: var(--sp-1);
  color: var(--qj-warning-text);
  font-size: var(--fs-meta);
}
@media (max-width: 768px) {
  .card-head {
    align-items: flex-start;
    gap: var(--sp-3);
  }
  .card-head > div:last-child {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-1);
  }
  .card-head .el-button {
    margin-left: 0;
    min-height: 40px;
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

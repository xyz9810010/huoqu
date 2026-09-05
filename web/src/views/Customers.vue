<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">客户管理</h2>
    <div class="toolbar">
      <el-input v-model="search" placeholder="搜索名称/电话/原系统ID" clearable style="width:260px"
                @keyup.enter="load" @clear="load" />
      <el-select v-model="status" placeholder="状态" clearable style="width:140px" @change="load">
        <el-option label="正常" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button type="success" @click="openCreate">新增客户</el-button>
    </div>

    <el-table class="desktop-table" :data="list" @row-click="(r: any) => router.push('/customers/' + r.id)" style="cursor:pointer">
      <el-table-column prop="customerNo" label="编号" width="100" />
      <el-table-column prop="name" label="客户名称" min-width="180" />
      <el-table-column prop="mainCsName" label="主客服" width="100" />
      <el-table-column prop="contactName" label="联系人" width="100" />
      <el-table-column prop="contactPhone" label="电话" width="130" />
      <el-table-column prop="legacyCustomerId" label="原系统ID" width="120" />
      <el-table-column prop="addressCount" label="地址数" width="80" />
      <el-table-column label="取件订单" width="170">
        <template #default="{ row }">
          <div v-if="row.taskCount" class="order-cell">
            <el-tag v-if="row.openTaskCount" type="warning" size="small">待办 {{ row.openTaskCount }}</el-tag>
            <el-tag v-else type="success" size="small">全部完成</el-tag>
            <div class="order-cell__sub">{{ row.completedTaskCount || 0 }} / {{ row.taskCount }} 已完成</div>
          </div>
          <span v-else class="order-none">无订单</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '正常' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" @click.stop="goDispatch(row)">派单</el-button>
          <el-button size="small" @click.stop="router.push('/customers/' + row.id)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="mobile-list">
      <article v-for="row in list" :key="row.id" class="mobile-item mobile-item--clickable"
               @click="router.push('/customers/' + row.id)">
        <div class="mobile-item__head">
          <div>
            <div class="mobile-item__title">{{ row.name }}</div>
            <div class="mobile-item__sub">{{ row.customerNo || '暂无客户编号' }}</div>
          </div>
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '正常' : '停用' }}
          </el-tag>
        </div>
        <div class="mobile-field"><span class="mobile-field__label">主客服</span><span class="mobile-field__value">{{ row.mainCsName || '未分配' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">联系人</span><span class="mobile-field__value">{{ row.contactName || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">联系电话</span><span class="mobile-field__value">{{ row.contactPhone || '—' }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">取件地址</span><span class="mobile-field__value">{{ row.addressCount || 0 }} 个</span></div>
        <div class="mobile-field"><span class="mobile-field__label">取件订单</span><span class="mobile-field__value">
          <template v-if="row.taskCount">
            <el-tag v-if="row.openTaskCount" type="warning" size="small">待办 {{ row.openTaskCount }}</el-tag>
            <el-tag v-else type="success" size="small">全部完成</el-tag>
            <span class="order-none" style="margin-left:6px">{{ row.completedTaskCount || 0 }}/{{ row.taskCount }} 已完成</span>
          </template>
          <span v-else class="order-none">无订单</span>
        </span></div>
        <div class="mobile-item__actions" @click.stop>
          <el-button type="primary" plain @click="goDispatch(row)">派单</el-button>
          <el-button @click="router.push('/customers/' + row.id)">查看详情</el-button>
        </div>
      </article>
      <el-empty v-if="!list.length" description="暂无客户" />
    </div>

    <el-pagination background layout="total, prev, pager, next" :total="total" :page-size="size"
                   :current-page="page + 1" @current-change="(p: number) => { page = p - 1; load() }" />

    <el-dialog v-model="createVisible" title="新增客户" width="560px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="客户名称" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="form.contactPhone" /></el-form-item>
        <el-form-item label="原系统客户ID"><el-input v-model="form.legacyCustomerId" /></el-form-item>
        <el-form-item label="重要提醒"><el-input v-model="form.importantNote" type="textarea" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'

const router = useRouter()
const list = ref<any[]>([])
const search = ref('')
const status = ref('')
const page = ref(0)
const size = 20
const total = ref(0)
const createVisible = ref(false)
const saving = ref(false)
const form = reactive<any>({ name: '', contactName: '', contactPhone: '', legacyCustomerId: '', importantNote: '', remark: '' })

async function load() {
  const data: any = await http.get('/customers', {
    params: { search: search.value, status: status.value, page: page.value, size },
  })
  list.value = Array.isArray(data) ? data : data.list
  total.value = Array.isArray(data) ? data.length : data.total
}

function openCreate() {
  Object.assign(form, { name: '', contactName: '', contactPhone: '', legacyCustomerId: '', importantNote: '', remark: '' })
  createVisible.value = true
}

async function submitCreate() {
  if (!form.name) {
    ElMessage.warning('请填写客户名称')
    return
  }
  saving.value = true
  try {
    const res: any = await http.post('/customers', form)
    if (res.duplicates && res.duplicates.length) {
      await ElMessageBox.alert(
        '发现可能重复客户：' + res.duplicates.map((d: any) => d.name + '（' + d.reason + '）').join('；'),
        '查重提示',
      )
    }
    ElMessage.success('创建成功')
    createVisible.value = false
    load()
  } finally {
    saving.value = false
  }
}

function goDispatch(row: any) {
  router.push({ path: '/dispatch', query: { customerId: row.id } })
}

onMounted(load)
</script>

<style scoped>
.order-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.order-cell__sub { color: var(--text-muted, #909399); font-size: 12px; line-height: 1.2; }
.order-none { color: var(--text-muted, #909399); font-size: 12px; }

.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
@media (max-width: 768px) {
  .toolbar :deep(.el-input) {
    width: 100% !important;
  }
  .toolbar :deep(.el-select) {
    flex: 1;
    width: auto !important;
    min-width: 120px;
  }
  .toolbar .el-button {
    flex: 1;
    margin-left: 0;
  }
}
</style>

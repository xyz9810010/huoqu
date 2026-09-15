<template>
  <div>
    <PageHead title="客户管理" description="维护客户档案、取件地址与派单入口" nowrap>
      <template #actions>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>新增客户
        </el-button>
      </template>
    </PageHead>

    <div class="toolbar">
      <el-input v-model="search" placeholder="搜索名称 / 电话 / 原系统 ID" clearable style="width:260px"
                class="search-input" @keyup.enter="load" @clear="load" />
      <el-select v-model="status" class="status-select" placeholder="状态" clearable style="width:140px" @change="load">
        <el-option label="正常" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
    </div>

    <el-card shadow="never" class="list-card">
      <SkeletonBlock v-if="loading && !list.length" :rows="4" />
      <LoadFailed v-else-if="loadError && !list.length" :message="loadError" @retry="load" />
      <el-table v-if="list.length" class="desktop-table" :data="list"
                @row-click="(r: any) => router.push('/customers/' + r.id)" style="cursor:pointer">
        <el-table-column prop="customerNo" label="编号" width="100" class-name="cell-nowrap" />
        <el-table-column prop="name" label="客户名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="contactName" label="联系人" width="96" />
        <el-table-column prop="contactPhone" label="电话" width="130" class-name="cell-nowrap" />
        <el-table-column prop="legacyCustomerId" label="原系统 ID" width="120" class-name="cell-nowrap" />
        <el-table-column label="取件订单" width="150">
          <template #default="{ row }">
            <div v-if="row.taskCount" class="order-cell">
              <span v-if="row.openTaskCount" class="qj-badge qj-badge--pending">待办 {{ row.openTaskCount }}</span>
              <span v-else class="qj-badge qj-badge--done">全部完成</span>
              <span class="order-cell__sub qj-num">{{ row.completedTaskCount || 0 }} / {{ row.taskCount }} 已完成</span>
            </div>
            <span v-else class="order-none">无订单</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <StatusBadge :tone="row.status === 'active' ? 'done' : 'cancel'"
                         :label="row.status === 'active' ? '正常' : '停用'" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
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
              <div class="mobile-item__sub qj-num">{{ row.customerNo || '暂无客户编号' }}</div>
            </div>
            <StatusBadge :tone="row.status === 'active' ? 'done' : 'cancel'"
                         :label="row.status === 'active' ? '正常' : '停用'" />
          </div>
          <div class="mobile-field"><span class="mobile-field__label">主客服</span><span class="mobile-field__value">{{ row.mainCsName || '未分配' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">联系人</span><span class="mobile-field__value">{{ row.contactName || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">联系电话</span><span class="mobile-field__value">{{ row.contactPhone || '—' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">取件地址</span><span class="mobile-field__value">{{ row.addressCount || 0 }} 个</span></div>
          <div class="mobile-field"><span class="mobile-field__label">取件订单</span><span class="mobile-field__value">
            <template v-if="row.taskCount">
              <span v-if="row.openTaskCount" class="qj-badge qj-badge--pending">待办 {{ row.openTaskCount }}</span>
              <span v-else class="qj-badge qj-badge--done">全部完成</span>
              <span class="order-none">{{ row.completedTaskCount || 0 }}/{{ row.taskCount }} 已完成</span>
            </template>
            <span v-else class="order-none">无订单</span>
          </span></div>
          <div class="mobile-item__actions" @click.stop>
            <el-button type="primary" plain @click="goDispatch(row)">派单</el-button>
            <el-button @click="router.push('/customers/' + row.id)">查看详情</el-button>
          </div>
        </article>
      </div>

      <EmptyState v-if="!list.length && !loading && !loadError" title="暂无客户" description="新增客户后即可为其派单">
        <el-button type="primary" @click="openCreate">新增客户</el-button>
      </EmptyState>
    </el-card>

    <el-pagination v-if="total > size" background layout="total, prev, pager, next" :total="total" :page-size="size"
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
import { Plus } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import StatusBadge from '../components/StatusBadge.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import LoadFailed from '../components/LoadFailed.vue'

const router = useRouter()
const list = ref<any[]>([])
const search = ref('')
const status = ref('')
const page = ref(0)
const size = 20
const total = ref(0)
const createVisible = ref(false)
const saving = ref(false)
const loading = ref(false)
const loadError = ref('')
const form = reactive<any>({ name: '', contactName: '', contactPhone: '', legacyCustomerId: '', importantNote: '', remark: '' })

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const data: any = await http.get('/customers', {
      params: { search: search.value, status: status.value, page: page.value, size },
    })
    list.value = Array.isArray(data) ? data : data.list
    total.value = Array.isArray(data) ? data.length : data.total
  } catch (e: any) {
    // 记下失败原因，让页面画出"加载失败 + 重试"，而不是静默落到"暂无客户"
    loadError.value = e?.response?.data?.error || e?.message || '加载失败'
    if (!list.value.length) total.value = 0
  } finally {
    loading.value = false
  }
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
.list-card {
  margin-bottom: var(--sp-4);
}
.order-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
}
.order-cell__sub {
  color: var(--qj-muted);
  font-size: var(--fs-meta);
  line-height: 1.2;
}
.order-none {
  color: var(--qj-muted);
  font-size: var(--fs-meta);
}
@media (max-width: 768px) {
  /* 手机端：搜索 + 状态 + 查询 收成一行，不再各占一行 */
  .toolbar {
    flex-wrap: nowrap;
    gap: var(--sp-2);
  }
  /* 关键：给搜索框一个小的 flex 基准宽度，否则行内 width:260px 会成为换行依据 */
  .toolbar :deep(.el-input) {
    flex: 1 1 110px;
    width: 110px !important;
    min-width: 0;
  }
  /* 状态只占固定窄位；空间让给搜索框 */
  .toolbar .status-select {
    flex: 0 0 80px;
    width: 80px !important;
  }
  .toolbar .el-button {
    flex: 0 0 auto;
    margin-left: 0;
    min-height: 44px;
    padding: 0 14px;
  }
}
</style>

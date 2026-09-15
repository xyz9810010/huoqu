<template>
  <div>
    <PageHead title="员工管理" description="开通账号、分配角色，并设置客服 / 取件员的可登录时段" nowrap>
      <template #actions>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>新增员工
        </el-button>
      </template>
    </PageHead>

    <div class="toolbar">
      <el-select v-model="role" placeholder="全部角色" clearable style="width:150px" @change="load">
        <el-option label="老板" value="boss" />
        <el-option label="客服" value="cs" />
        <el-option label="取件员" value="worker" />
        <el-option label="管理员" value="admin" />
      </el-select>
    </div>

    <el-card shadow="never" class="list-card">
      <SkeletonBlock v-if="loading && !list.length" :rows="4" />
      <LoadFailed v-else-if="loadError && !list.length" :message="loadError" @retry="load" />
      <el-table v-if="list.length" class="desktop-table" :data="list">
        <el-table-column prop="employeeNo" label="工号" width="100" class-name="cell-nowrap" />
        <el-table-column prop="username" label="用户名" width="130" class-name="cell-nowrap" />
        <el-table-column prop="name" label="姓名" width="130" />
        <el-table-column prop="phone" label="电话" width="140" class-name="cell-nowrap" />
        <el-table-column label="角色" width="100">
          <template #default="{ row }">
            <StatusBadge tone="plain" :label="roleLabel(row.role)" />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <StatusBadge :tone="row.status === 'active' ? 'done' : 'cancel'"
                         :label="row.status === 'active' ? '正常' : '停用'" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-list">
        <article v-for="row in list" :key="row.id" class="mobile-item">
          <div class="mobile-item__head">
            <div>
              <div class="mobile-item__title">{{ row.name || row.username }}</div>
              <div class="mobile-item__sub qj-num">{{ row.employeeNo || '未设置工号' }} · {{ row.username }}</div>
            </div>
            <StatusBadge :tone="row.status === 'active' ? 'done' : 'cancel'"
                         :label="row.status === 'active' ? '正常' : '停用'" />
          </div>
          <div class="mobile-field"><span class="mobile-field__label">角色</span><span class="mobile-field__value">{{ roleLabel(row.role) }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">电话</span><span class="mobile-field__value">{{ row.phone || '—' }}</span></div>
          <div class="mobile-item__actions">
            <el-button @click="openEdit(row)">编辑</el-button>
            <el-button @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
          </div>
        </article>
      </div>

      <EmptyState v-if="!list.length && !loading && !loadError" title="暂无员工" description="新增员工后即可为其开通登录账号">
        <el-button type="primary" @click="openCreate">新增员工</el-button>
      </EmptyState>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-title"><el-icon><Clock /></el-icon>登录时间限制（客服 / 取件员）</div>
      </template>
      <div v-for="r in restrictions" :key="r.role" class="login-restrict-row">
        <div class="lr-head">
          <span class="lr-role">{{ r.role === 'cs' ? '客服' : '取件员' }}</span>
          <el-switch v-model="r.enabled" @change="saveRestriction(r)" />
        </div>
        <template v-if="r.enabled">
          <div class="lr-label">允许登录的星期（不勾选则周末/休息日不可登录）</div>
          <el-checkbox-group v-model="r.weekdaysArr" @change="saveRestriction(r)">
            <el-checkbox v-for="d in weekOptions" :key="d.value" :label="d.value">{{ d.label }}</el-checkbox>
          </el-checkbox-group>
          <div class="lr-label">允许时间段（留空 = 全天不限）</div>
          <div class="lr-time">
            <el-input v-model="r.startTime" placeholder="08:00" style="width:120px" @change="saveRestriction(r)" />
            <span class="lr-sep">~</span>
            <el-input v-model="r.endTime" placeholder="20:00" style="width:120px" @change="saveRestriction(r)" />
          </div>
        </template>
      </div>
    </el-card>

    <el-dialog v-model="visible" :title="form.id ? '编辑员工' : '新增员工'" width="460px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="用户名" required><el-input v-model="form.username" :disabled="!!form.id" /></el-form-item>
        <el-form-item label="密码" :required="!form.id">
          <el-input v-model="form.password" placeholder="编辑时留空表示不修改" />
        </el-form-item>
        <el-form-item label="姓名" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="工号"><el-input v-model="form.employeeNo" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%">
            <el-option label="老板" value="boss" />
            <el-option label="客服" value="cs" />
            <el-option label="取件员" value="worker" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Clock, Plus } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import StatusBadge from '../components/StatusBadge.vue'
import EmptyState from '../components/EmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import LoadFailed from '../components/LoadFailed.vue'

const list = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const role = ref('')
const visible = ref(false)
const form = reactive<any>({ id: null, username: '', password: '', name: '', phone: '', employeeNo: '', role: 'cs' })
const weekOptions = [
  { value: '1', label: '周一' }, { value: '2', label: '周二' }, { value: '3', label: '周三' },
  { value: '4', label: '周四' }, { value: '5', label: '周五' }, { value: '6', label: '周六' },
  { value: '7', label: '周日' },
]
const restrictions = ref<any[]>([])

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    list.value = await http.get('/employees', { params: { role: role.value || undefined } })
  } catch (e: any) {
    loadError.value = e?.response?.data?.error || e?.message || '加载失败'
    list.value = []
  } finally {
    loading.value = false
  }
}

async function loadRestrictions() {
  const data: any[] = await http.get('/login-restrictions')
  const map: Record<string, any> = {}
  data.forEach((r: any) => { map[r.role] = r })
  restrictions.value = ['cs', 'courier'].map((rl: string) => {
    const r = map[rl] || { role: rl, weekdays: '', startTime: '', endTime: '', enabled: false }
    return { ...r, weekdaysArr: String(r.weekdays || '').split(',').filter(Boolean) }
  })
}

async function saveRestriction(r: any) {
  await http.put('/login-restrictions/' + r.role, {
    weekdays: (r.weekdaysArr || []).join(','),
    startTime: r.startTime || '',
    endTime: r.endTime || '',
    enabled: r.enabled,
  })
  ElMessage.success('已保存')
}

function roleLabel(r: string) {
  return { boss: '老板', cs: '客服', worker: '取件员', admin: '管理员' }[r] || r
}

function openCreate() {
  Object.assign(form, { id: null, username: '', password: '', name: '', phone: '', employeeNo: '', role: 'cs' })
  visible.value = true
}

function openEdit(row: any) {
  Object.assign(form, { id: row.id, username: row.username, password: '', name: row.name, phone: row.phone, employeeNo: row.employeeNo, role: row.role })
  visible.value = true
}

async function submit() {
  if (form.id) {
    await http.put(`/employees/${form.id}`, form)
  } else {
    await http.post('/employees', form)
  }
  ElMessage.success('已保存')
  visible.value = false
  load()
}

async function toggleStatus(row: any) {
  const s = row.status === 'active' ? 'disabled' : 'active'
  await http.patch(`/employees/${row.id}/status`, null, { params: { status: s } })
  load()
}

onMounted(() => { load(); loadRestrictions() })
</script>

<style scoped>
.list-card {
  margin-bottom: var(--sp-4);
}
.block {
  margin-bottom: var(--sp-4);
}
.login-restrict-row {
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--qj-border);
}
.login-restrict-row:last-child {
  border-bottom: none;
}
.lr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
}
.lr-role {
  font-weight: 600;
  color: var(--qj-text);
}
.lr-label {
  font-size: var(--fs-sub);
  color: var(--qj-muted);
  margin: var(--sp-2) 0 6px;
}
.lr-time {
  display: flex;
  align-items: center;
}
.lr-sep {
  margin: 0 6px;
  color: var(--qj-muted);
}
@media (max-width: 768px) {
  .toolbar :deep(.el-select) {
    flex: 1;
    width: auto !important;
  }
}
</style>

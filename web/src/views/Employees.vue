<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">员工管理</h2>
    <div class="toolbar">
      <el-select v-model="role" placeholder="角色筛选" clearable style="width:140px" @change="load">
        <el-option label="老板" value="boss" />
        <el-option label="客服" value="cs" />
        <el-option label="取件员" value="worker" />
        <el-option label="管理员" value="admin" />
      </el-select>
      <el-button type="success" @click="openCreate">新增员工</el-button>
    </div>
    <el-table class="desktop-table" :data="list">
      <el-table-column prop="employeeNo" label="工号" width="90" />
      <el-table-column prop="username" label="用户名" width="120" />
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column prop="phone" label="电话" width="130" />
      <el-table-column label="角色" width="90">
        <template #default="{ row }">
          <el-tag>{{ roleLabel(row.role) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180">
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
            <div class="mobile-item__sub">{{ row.employeeNo || '未设置工号' }} · {{ row.username }}</div>
          </div>
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '正常' : '停用' }}
          </el-tag>
        </div>
        <div class="mobile-field"><span class="mobile-field__label">角色</span><span class="mobile-field__value">{{ roleLabel(row.role) }}</span></div>
        <div class="mobile-field"><span class="mobile-field__label">电话</span><span class="mobile-field__value">{{ row.phone || '—' }}</span></div>
        <div class="mobile-item__actions">
          <el-button @click="openEdit(row)">编辑</el-button>
          <el-button @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
        </div>
      </article>
      <el-empty v-if="!list.length" description="暂无员工" />
    </div>

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
          <el-select v-model="form.role">
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
import http from '../api'

const list = ref<any[]>([])
const role = ref('')
const visible = ref(false)
const form = reactive<any>({ id: null, username: '', password: '', name: '', phone: '', employeeNo: '', role: 'cs' })

async function load() {
  list.value = await http.get('/employees', { params: { role: role.value || undefined } })
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

onMounted(load)
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
@media (max-width: 768px) {
  .toolbar :deep(.el-select) {
    flex: 1;
    width: auto !important;
  }
  .toolbar .el-button {
    flex: 1;
    margin-left: 0;
  }
}
</style>

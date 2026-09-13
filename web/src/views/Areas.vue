<template>
  <div>
    <PageHead title="区域管理" description="维护区域、默认取件员与备用取件员">
      <template #actions>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>新增区域
        </el-button>
      </template>
    </PageHead>

    <el-card shadow="never" class="list-card">
      <el-table v-if="list.length" class="desktop-table" :data="list">
        <el-table-column prop="name" label="区域名称" width="140" />
        <el-table-column prop="code" label="编码" width="110" class-name="cell-nowrap" />
        <el-table-column label="主取件员" min-width="170">
          <template #default="{ row }">{{ workerNames(row.defaultWorkers) }}</template>
        </el-table-column>
        <el-table-column label="备用取件员" min-width="170">
          <template #default="{ row }">{{ workerNames(row.backupWorkers) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="primary" @click="openAssign(row)">设置取件员</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-list">
        <article v-for="row in list" :key="row.id" class="mobile-item">
          <div class="mobile-item__head">
            <div>
              <div class="mobile-item__title">{{ row.name }}</div>
              <div class="mobile-item__sub qj-num">{{ row.code || '未设置编码' }}</div>
            </div>
          </div>
          <div class="mobile-field"><span class="mobile-field__label">默认取件员</span><span class="mobile-field__value">{{ row.defaultWorkerName || '未设置' }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">主取件员</span><span class="mobile-field__value">{{ workerNames(row.defaultWorkers) }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">备用取件员</span><span class="mobile-field__value">{{ workerNames(row.backupWorkers) }}</span></div>
          <div class="mobile-item__actions">
            <el-button @click="openEdit(row)">编辑</el-button>
            <el-button type="primary" @click="openAssign(row)">设置取件员</el-button>
          </div>
        </article>
      </div>

      <EmptyState v-if="!list.length" title="暂无区域" description="新增区域后，派单时会自动推荐区域内的取件员">
        <el-button type="primary" @click="openCreate">新增区域</el-button>
      </EmptyState>
    </el-card>

    <el-dialog v-model="visible" :title="form.id ? '编辑区域' : '新增区域'" width="420px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="默认取件员">
          <el-select v-model="form.defaultWorkerId" clearable style="width:100%">
            <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignVisible" title="设置取件员" width="420px">
      <div class="assign-label">主取件员</div>
      <el-select v-model="assignForm.defaultWorkerIds" multiple style="width:100%">
        <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <div class="assign-label">备用取件员</div>
      <el-select v-model="assignForm.backupWorkerIds" multiple style="width:100%">
        <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAssign">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import http from '../api'
import PageHead from '../components/PageHead.vue'
import EmptyState from '../components/EmptyState.vue'

const list = ref<any[]>([])
const workers = ref<any[]>([])
const visible = ref(false)
const assignVisible = ref(false)
const form = reactive<any>({ id: null, name: '', code: '', defaultWorkerId: null })
const assignForm = reactive<any>({ areaId: null, defaultWorkerIds: [], backupWorkerIds: [] })

async function load() {
  list.value = await http.get('/areas')
}

function workerNames(items: any[] | undefined) {
  return (items || []).map((worker: any) => worker.name).join('、') || '未设置'
}

function openCreate() {
  Object.assign(form, { id: null, name: '', code: '', defaultWorkerId: null })
  visible.value = true
}

function openEdit(row: any) {
  Object.assign(form, { id: row.id, name: row.name, code: row.code, defaultWorkerId: row.defaultWorkerId })
  visible.value = true
}

async function submit() {
  if (form.id) {
    await http.put(`/areas/${form.id}`, form)
  } else {
    await http.post('/areas', form)
  }
  ElMessage.success('已保存')
  visible.value = false
  load()
}

function openAssign(row: any) {
  assignForm.areaId = row.id
  assignForm.defaultWorkerIds = (row.defaultWorkers || []).map((w: any) => w.userId)
  assignForm.backupWorkerIds = (row.backupWorkers || []).map((w: any) => w.userId)
  assignVisible.value = true
}

async function submitAssign() {
  await http.put(`/areas/${assignForm.areaId}/workers`, {
    defaultWorkerIds: assignForm.defaultWorkerIds,
    backupWorkerIds: assignForm.backupWorkerIds,
  })
  ElMessage.success('已保存')
  assignVisible.value = false
  load()
}

onMounted(async () => {
  workers.value = await http.get('/employees/workers')
  load()
})
</script>

<style scoped>
.list-card {
  margin-bottom: var(--sp-4);
}
.assign-label {
  margin: var(--sp-3) 0 var(--sp-2);
  color: var(--qj-text-2);
  font-size: var(--fs-sub);
  font-weight: 600;
}
.assign-label:first-child {
  margin-top: 0;
}
</style>

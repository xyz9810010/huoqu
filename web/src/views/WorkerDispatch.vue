<template>
  <div class="worker-dispatch">
    <div class="toolbar">
      <el-button :icon="ArrowLeft" circle @click="router.back()" />
      <h2 class="page-title" style="margin:0">新增订单</h2>
    </div>

    <el-card shadow="never" class="card">
      <el-radio-group v-model="mode" class="mode-switch">
        <el-radio-button value="customer">选已有客户</el-radio-button>
        <el-radio-button value="manual">手动填写</el-radio-button>
      </el-radio-group>

      <el-form label-position="top" class="form">
        <template v-if="mode === 'customer'">
          <el-form-item label="客户" required>
            <el-select v-model="customerId" filterable remote :remote-method="searchCustomer"
                       placeholder="搜索客户名称/电话" style="width:100%" @change="onCustomerChange">
              <el-option v-for="c in customerOptions" :key="c.id" :label="c.name + ' · ' + (c.phone || '')" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="取件地址" required>
            <el-select v-model="addressId" placeholder="选择取件地址" style="width:100%">
              <el-option v-for="a in addresses" :key="a.id" :label="a.name + ' · ' + a.address" :value="a.id" />
            </el-select>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="客户名称" required><el-input v-model="customerName" /></el-form-item>
          <el-form-item label="联系人" required><el-input v-model="contact" /></el-form-item>
          <el-form-item label="联系电话" required><el-input v-model="phone" /></el-form-item>
          <el-form-item label="取件地址" required><el-input v-model="address" /></el-form-item>
        </template>

        <el-divider content-position="left">货物明细</el-divider>
        <div v-for="(it, i) in items" :key="i" class="item-row">
          <el-input-number v-model="it.pieces" :min="1" :max="9999" style="width:90px" />
          <el-input v-model="it.goodsName" placeholder="品名（选填）" style="flex:1" />
          <el-input v-model="it.waybillNo" placeholder="面单号（选填）" style="flex:1.2" />
          <el-button :icon="Delete" circle text @click="removeItem(i)" :disabled="items.length <= 1" />
        </div>
        <el-button text type="primary" :icon="Plus" @click="addItem">添加货物</el-button>

        <el-divider content-position="left">预约时间（选填）</el-divider>
        <el-form-item>
          <div class="sched-row">
            <el-select v-model="scheduledKind" style="width:140px">
              <el-option label="不指定时间" value="" />
              <el-option label="几点前取" value="before" />
              <el-option label="几点后取" value="after" />
              <el-option label="几点左右取" value="around" />
            </el-select>
            <el-date-picker v-if="scheduledKind" v-model="scheduledTime" type="datetime"
                            value-format="YYYY-MM-DDTHH:mm:ss" placeholder="选择时间" style="flex:1" />
          </div>
        </el-form-item>

        <el-form-item label="取件备注">
          <el-input v-model="pickupNote" type="textarea" :rows="2" />
        </el-form-item>

        <el-button type="primary" style="width:100%" :loading="saving" @click="submit">提交订单</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Delete, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import http from '../api'

const router = useRouter()
const mode = ref('customer')
const customerId = ref<any>(null)
const customerOptions = ref<any[]>([])
const addresses = ref<any[]>([])
const addressId = ref<any>(null)
const customerName = ref('')
const contact = ref('')
const phone = ref('')
const address = ref('')
const items = ref<any[]>([{ pieces: 1, goodsName: '', waybillNo: '' }])
const scheduledKind = ref('')
const scheduledTime = ref('')
const pickupNote = ref('')
const saving = ref(false)

async function searchCustomer(q: string) {
  const data: any = await http.get('/customers', { params: { search: q } })
  customerOptions.value = Array.isArray(data) ? data : data.list
}

async function onCustomerChange(cid: any) {
  if (!cid) return
  const detail: any = await http.get('/customers/' + cid)
  addresses.value = (detail.addresses || []).filter((a: any) => a.isActive)
  addressId.value = addresses.value.length ? addresses.value[0].id : null
}

function addItem() {
  items.value.push({ pieces: 1, goodsName: '', waybillNo: '' })
}

function removeItem(i: number) {
  if (items.value.length > 1) items.value.splice(i, 1)
}

async function submit() {
  if (saving.value) return
  if (mode.value === 'customer' && (!customerId.value || !addressId.value)) {
    ElMessage.warning('请选择客户和取件地址')
    return
  }
  if (mode.value === 'manual' && (!customerName.value.trim() || !address.value.trim() || !contact.value.trim() || !phone.value.trim())) {
    ElMessage.warning('请填写客户、地址、联系人和电话')
    return
  }
  const validItems = items.value.filter((it) => it.pieces >= 1)
  if (!validItems.length) {
    ElMessage.warning('请填写货物件数')
    return
  }
  saving.value = true
  try {
    const body: any = {
      customerId: mode.value === 'customer' ? customerId.value : undefined,
      addressId: mode.value === 'customer' ? addressId.value : undefined,
      customerName: mode.value === 'manual' ? customerName.value.trim() : undefined,
      address: mode.value === 'manual' ? address.value.trim() : undefined,
      contact: mode.value === 'manual' ? contact.value.trim() : undefined,
      phone: mode.value === 'manual' ? phone.value.trim() : undefined,
      items: validItems.map((it) => ({ pieces: it.pieces, goodsName: it.goodsName, waybillNo: it.waybillNo })),
      scheduledKind: scheduledKind.value || undefined,
      scheduledTime: scheduledKind.value ? scheduledTime.value : undefined,
      pickupNote: pickupNote.value,
    }
    await http.post('/tasks', body)
    ElMessage.success('订单已新增，进入待取件')
    router.replace('/worker/tasks')
  } catch (e: any) {
    ElMessage.error(e?.message || '提交失败')
  } finally {
    saving.value = false
  }
}

onMounted(() => { searchCustomer('') })
</script>

<style scoped>
.worker-dispatch { max-width: 640px; margin: 0 auto; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.card { padding: 8px; }
.mode-switch { width: 100%; margin-bottom: 12px; }
.mode-switch :deep(.el-radio-button) { flex: 1; }
.mode-switch :deep(.el-radio-button__inner) { width: 100%; }
.form { margin-top: 6px; }
.item-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.sched-row { display: flex; gap: 8px; width: 100%; align-items: center; }
</style>

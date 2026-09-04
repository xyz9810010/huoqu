<template>
  <div>
    <h2 class="page-title" style="margin-bottom:16px">新建取件</h2>
    <el-card shadow="never" style="max-width:760px">
      <template #header>新建取件</template>
      <el-form class="dispatch-form" label-width="110px">
        <el-form-item label="客户" required>
          <el-select v-model="customerId" filterable remote :remote-method="searchCustomer" placeholder="搜索客户名称/电话"
                     style="width:100%" @change="onCustomerChange">
            <el-option v-for="c in customerOptions" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="取件地址" required>
          <el-select v-model="addressId" placeholder="选择取件地址" style="width:100%" @change="onAddressChange">
            <el-option v-for="a in addresses" :key="a.id" :label="`${a.name} · ${a.address}`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="推荐取件员">
          <el-input :model-value="recommendName || '暂无'" disabled style="width:200px" />
          <span style="margin-left:10px;color:#999">可改派</span>
        </el-form-item>
        <el-form-item label="取件员">
          <el-select v-model="workerId" placeholder="默认使用推荐取件员" clearable style="width:200px">
            <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="任务类型">
          <el-radio-group v-model="taskType">
            <el-radio-button value="normal">普通</el-radio-button>
            <el-radio-button value="scheduled">指定时间</el-radio-button>
            <el-radio-button value="rush">赶出货</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="taskType === 'scheduled'">
          <el-form-item label="时间类型">
            <el-select v-model="scheduledKind" style="width:200px">
              <el-option label="XX点前取" value="before" />
              <el-option label="XX点后取" value="after" />
              <el-option label="XX点左右取" value="around" />
            </el-select>
          </el-form-item>
          <el-form-item label="指定时间">
            <el-date-picker v-model="scheduledTime" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss"
                            placeholder="选择时间" />
          </el-form-item>
        </template>
        <template v-if="taskType === 'rush'">
          <el-form-item label="赶几点出货" required>
            <el-date-picker v-model="rushShipTime" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="选择出货时间" />
          </el-form-item>
          <el-form-item label="加急原因" required>
            <el-input v-model="rushReason" type="textarea" placeholder="如：客户下午航班" />
          </el-form-item>
        </template>
        <el-form-item label="取件备注"><el-input v-model="pickupNote" type="textarea" /></el-form-item>
        <el-form-item label="内部备注"><el-input v-model="internalNote" type="textarea" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="submit">确认派单</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import http from '../api'

const route = useRoute()
const router = useRouter()
const customerId = ref<any>(null)
const customerOptions = ref<any[]>([])
const addresses = ref<any[]>([])
const areas = ref<any[]>([])
const workers = ref<any[]>([])
const addressId = ref<any>(null)
const workerId = ref<any>(null)
const taskType = ref('normal')
const scheduledKind = ref('before')
const scheduledTime = ref('')
const rushShipTime = ref('')
const rushReason = ref('')
const pickupNote = ref('')
const internalNote = ref('')
const saving = ref(false)

const currentAddress = computed(() => addresses.value.find((a) => a.id === addressId.value))
const recommendName = computed(() => {
  const a = currentAddress.value
  if (!a || !a.areaId) return ''
  const area = areas.value.find((x) => x.id === a.areaId)
  return area?.defaultWorkerName || ''
})

async function searchCustomer(q: string) {
  const data: any = await http.get('/customers', { params: { search: q, size: 20 } })
  customerOptions.value = Array.isArray(data) ? data : data.list
}

async function onCustomerChange(cid: any) {
  if (!cid) return
  const detail: any = await http.get(`/customers/${cid}`)
  addresses.value = (detail.addresses || []).filter((a: any) => a.isActive)
  addressId.value = addresses.value.length ? addresses.value[0].id : null
  onAddressChange()
}

function onAddressChange() {
  const a = currentAddress.value
  if (a && a.areaId) {
    const area = areas.value.find((x) => x.id === a.areaId)
    workerId.value = area?.defaultWorkerId || null
  }
}

async function submit() {
  if (!customerId.value || !addressId.value) {
    ElMessage.warning('请选择客户和取件地址')
    return
  }
  if (taskType.value === 'rush' && (!rushShipTime.value || !rushReason.value)) {
    ElMessage.warning('赶出货必须填写出货时间和加急原因')
    return
  }
  if (taskType.value === 'scheduled' && !scheduledTime.value) {
    ElMessage.warning('指定时间任务必须填写时间')
    return
  }
  saving.value = true
  try {
    const res: any = await http.post('/tasks', {
      customerId: customerId.value,
      addressId: addressId.value,
      taskType: taskType.value,
      scheduledKind: taskType.value === 'scheduled' ? scheduledKind.value : null,
      scheduledTime: taskType.value === 'scheduled' ? scheduledTime.value : null,
      rushShipTime: taskType.value === 'rush' ? rushShipTime.value : null,
      rushReason: taskType.value === 'rush' ? rushReason.value : null,
      pickupNote: pickupNote.value,
      internalNote: internalNote.value,
      workerId: workerId.value,
    })
    ElMessage.success('派单成功')
    router.push(`/tasks/${res.id}`)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  areas.value = (await http.get('/areas')) as any[]
  workers.value = (await http.get('/employees/workers')) as any[]
  searchCustomer('')
  if (route.query.customerId) {
    customerId.value = String(route.query.customerId)
    await onCustomerChange(customerId.value)
  }
})
</script>

<style scoped>
@media (max-width: 560px) {
  .dispatch-form :deep(.el-form-item) {
    display: block;
    margin-bottom: 18px;
  }
  .dispatch-form :deep(.el-form-item__label) {
    width: auto !important;
    height: auto;
    margin-bottom: 7px;
    line-height: 1.4;
    justify-content: flex-start;
  }
  .dispatch-form :deep(.el-form-item__content) {
    margin-left: 0 !important;
  }
  .dispatch-form :deep(.el-radio-group) {
    width: 100%;
    display: flex;
  }
  .dispatch-form :deep(.el-radio-button) {
    flex: 1;
  }
  .dispatch-form :deep(.el-radio-button__inner) {
    width: 100%;
    padding-left: 8px;
    padding-right: 8px;
  }
}
</style>

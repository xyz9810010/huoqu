<template>
  <div>
    <div class="toolbar">
      <h2 class="page-title" style="margin:0">我的任务</h2>
      <span class="count">待取 {{ list.length }} 单</span>
      <el-button :icon="Refresh" circle @click="load" />
    </div>

    <el-card v-for="t in list" :key="t.id" shadow="never" class="task-card"
             :class="{ rush: t.taskType === 'rush' }">
      <div class="task-head">
        <div>
          <el-tag v-if="t.taskType === 'rush'" type="danger" size="large">🔴 赶 {{ fmt(t.rushShipTime) }} 出货</el-tag>
          <el-tag v-else-if="t.taskType === 'scheduled'" type="warning">指定时间 {{ fmt(t.scheduledTime) }}</el-tag>
          <el-tag v-else type="info">普通</el-tag>
          <span class="customer">{{ t.customerName }}</span>
        </div>
        <div class="time">派单 {{ fmt(t.dispatchAt) }}</div>
      </div>
      <div class="addr">
        <div><b>{{ t.addressPointName }}</b> {{ t.address }}</div>
        <div>联系人：{{ t.contact }}　电话：{{ t.phone }}</div>
        <div v-if="t.pickupNote" class="note">备注：{{ t.pickupNote }}</div>
      </div>
      <div class="actions">
        <el-button size="small" @click="copyAddr(t)">复制地址</el-button>
        <el-button size="small" @click="copyFull(t)">复制取件信息</el-button>
        <el-button size="small"><a :href="'tel:' + t.phone" style="color:inherit;text-decoration:none">拨打电话</a></el-button>
        <el-button size="small" @click="navigate(t)">导航</el-button>
        <el-button size="small" type="primary" @click="router.push('/tasks/' + t.id)">开始取件</el-button>
      </div>
    </el-card>
    <el-empty v-if="!list.length" description="暂无待取任务" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import http from '../api'
import { createRealtimeRefreshSubscription, isTaskRealtimeEvent } from '../services/realtime-events'

const router = useRouter()
const list = ref<any[]>([])

async function load() {
  list.value = await http.get('/worker/tasks')
}

function fmt(t: string) {
  return t ? t.replace('T', ' ').slice(0, 16) : ''
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

async function copyAddr(t: any) {
  const ok = await copyText(t.address || '')
  ElMessage.success(ok ? '地址已复制' : '复制失败，请手动复制')
}

async function copyFull(t: any) {
  const text = `客户：${t.customerName}\n取件点：${t.addressPointName}\n地址：${t.address}\n联系人：${t.contact}\n电话：${t.phone}`
  const ok = await copyText(text)
  ElMessage.success(ok ? '取件信息已复制' : '复制失败，请手动复制')
}

function navigate(t: any) {
  const q = encodeURIComponent(t.address || '')
  window.open(`https://uri.amap.com/search?keyword=${q}`, '_blank')
}

const liveRefresh = createRealtimeRefreshSubscription({ predicate: isTaskRealtimeEvent, refresh: load })

onMounted(load)
onUnmounted(() => liveRefresh.dispose())
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.count {
  font-size: 16px;
  font-weight: 600;
}
.task-card {
  margin-bottom: 12px;
}
.task-card.rush {
  border: 1px solid #f56c6c;
}
.task-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.customer {
  font-size: 16px;
  font-weight: 600;
  margin-left: 10px;
}
.time {
  color: #999;
  font-size: 13px;
}
.addr {
  margin: 10px 0;
  color: #555;
  line-height: 1.8;
}
.note {
  color: #e6a23c;
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>

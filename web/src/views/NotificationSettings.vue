<template>
  <div class="settings-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">消息设置</h2>
        <p class="page-description">管理当前浏览器、接收方式和不同业务消息的提醒偏好。</p>
      </div>
      <el-button @click="router.push('/notifications')">
        <el-icon><ArrowLeft /></el-icon>
        返回通知中心
      </el-button>
    </div>

    <div class="settings-grid">
      <el-card class="browser-card">
        <div class="card-heading">
          <div class="heading-icon"><el-icon><Monitor /></el-icon></div>
          <div><h3>浏览器系统通知</h3><p>页面关闭后仍可接收任务和异常提醒。</p></div>
        </div>
        <div class="status-row">
          <span class="status-dot" :class="pushState.status"></span>
          <div><strong>{{ statusCopy.title }}</strong><div class="status-help">{{ statusCopy.help }}</div></div>
        </div>
        <div class="actions">
          <el-button v-if="pushState.status !== 'granted'" type="primary"
            :disabled="!pushState.available || pushState.status === 'denied'" :loading="busy" @click="enable">
            开启系统通知
          </el-button>
          <template v-else>
            <el-button type="primary" :loading="testing" @click="sendTest">发送测试通知</el-button>
            <el-button :loading="busy" @click="disable">关闭当前浏览器</el-button>
          </template>
        </div>
      </el-card>

      <el-card>
        <div class="card-heading compact">
          <div class="heading-icon green"><el-icon><Setting /></el-icon></div>
          <div><h3>接收偏好</h3><p>站内通知始终保留，可单独控制系统提醒。</p></div>
        </div>
        <div class="preference-list">
          <div v-for="item in preferenceRows" :key="item.type" class="preference-row">
            <div><strong>{{ item.label }}</strong><span>{{ item.description }}</span></div>
            <el-switch v-model="item.enabled" :loading="item.saving"
              @change="(value: string | number | boolean) => savePreference(item, Boolean(value))" />
          </div>
        </div>
      </el-card>
    </div>

    <el-card class="devices-card">
      <template #header>
        <div class="devices-head"><span>已登记设备</span><el-button text :loading="loading" @click="load">刷新</el-button></div>
      </template>
      <el-table v-if="devices.length" class="desktop-table" :data="devices" style="width:100%">
        <el-table-column label="设备">
          <template #default="scope">
            <div class="device-name"><el-icon><Monitor /></el-icon><div>
              <strong>{{ scope.row.deviceLabel || '未命名设备' }}</strong>
              <span>{{ scope.row.platform || scope.row.providerCode }}</span>
            </div></div>
          </template>
        </el-table-column>
        <el-table-column label="通道" width="150">
          <template #default="scope">{{ scope.row.channel === 'web_push' ? '浏览器通知' : scope.row.providerCode }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" effect="plain">
            {{ scope.row.status === 'active' ? '正常' : '已失效' }}
          </el-tag></template>
        </el-table-column>
        <el-table-column prop="createdAt" label="登记时间" min-width="180" />
      </el-table>
      <div class="mobile-list mobile-list--inset">
        <article v-for="device in devices" :key="device.id" class="mobile-item">
          <div class="mobile-item__head">
            <div class="device-name">
              <el-icon><Monitor /></el-icon>
              <div>
                <strong>{{ device.deviceLabel || '未命名设备' }}</strong>
                <span>{{ device.platform || device.providerCode }}</span>
              </div>
            </div>
            <el-tag :type="device.status === 'active' ? 'success' : 'info'" effect="plain" size="small">
              {{ device.status === 'active' ? '正常' : '已失效' }}
            </el-tag>
          </div>
          <div class="mobile-field"><span class="mobile-field__label">通道</span><span class="mobile-field__value">{{ device.channel === 'web_push' ? '浏览器通知' : device.providerCode }}</span></div>
          <div class="mobile-field"><span class="mobile-field__label">登记时间</span><span class="mobile-field__value">{{ formatDeviceTime(device.createdAt) }}</span></div>
        </article>
      </div>
      <el-empty v-if="!devices.length" description="暂无已登记的推送设备" :image-size="72" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import http from '../api'
import { currentBrowserSubscriptionId, disableBrowserPush, enableBrowserPush,
  getBrowserPushState, sendBrowserPushTest } from '../services/browser-push'
import type { BrowserPushState } from '../services/browser-push'
import type { NotificationPreference, NotificationSubscription } from '../types/notifications'

interface PreferenceRow { type: string; label: string; description: string; enabled: boolean; saving: boolean }

const router = useRouter()
const loading = ref(false)
const busy = ref(false)
const testing = ref(false)
const devices = ref<NotificationSubscription[]>([])
const pushState = ref<BrowserPushState>(getBrowserPushState())
const preferenceRows = reactive<PreferenceRow[]>([
  { type: 'pickupTask.assigned', label: '新任务与改派', description: '有新的取件任务分配给我时提醒', enabled: true, saving: false },
  { type: 'pickupTask.statusChanged', label: '任务状态变化', description: '任务开始、完成或取消时提醒', enabled: true, saving: false },
  { type: 'pickupTask.overdue', label: '超时与紧急任务', description: '临近赶货时间或任务超时时提醒', enabled: true, saving: false },
  { type: 'pickupTask.exception', label: '异常处理', description: '出现异常或处理完成时提醒', enabled: true, saving: false },
])

function formatDeviceTime(value: string) {
  return String(value || '').replace('T', ' ').slice(0, 16) || '—'
}

const unsupportedCopy = {
  'ios-pwa': {
    title: 'iOS 需从主屏幕打开',
    help: 'iPhone/iPad 的系统通知要求 iOS 16.4+：请在 Safari 打开本站后点「分享」→「添加到主屏幕」，之后始终从主屏幕图标进入本站再开启。',
  },
  'embedded-browser': {
    title: '微信/QQ 内置浏览器不支持',
    help: '请点右上角菜单选择「在浏览器打开」（iOS Safari 或 Android Chrome），系统通知需在系统浏览器中开启。',
  },
  'generic': {
    title: '当前浏览器不支持',
    help: '请使用最新版 Chrome、Edge、Firefox 或 Safari，并以 HTTPS 安全地址访问本系统。',
  },
}

const statusCopy = computed(() => {
  if (pushState.value.status === 'unsupported') {
    return unsupportedCopy[pushState.value.reason || 'generic']
  }
  return ({
  granted: { title: '当前浏览器已开启', help: '系统通知可以在页面关闭后显示。' },
  denied: { title: '浏览器已拒绝通知', help: '请两步重新允许：① 系统设置 → 应用 → 本浏览器（华为浏览器/Chrome/Safari 等）→ 通知 → 允许；② 浏览器「网站设置/权限 → 通知」把本站改为允许，然后刷新本页重试。' },
  default: { title: '尚未开启', help: '点击按钮后，浏览器会询问是否允许通知。' },
  insecure: { title: '当前地址不是 HTTPS', help: '系统通知要求 HTTPS；站内通知和实时刷新仍可使用。' },
  } as Record<string, { title: string; help: string }>)[pushState.value.status]
})

async function load() {
  loading.value = true
  try {
    const [subscriptionList, savedPreferences] = await Promise.all([
      http.get<any, NotificationSubscription[]>('/v1/notification-subscriptions'),
      http.get<any, NotificationPreference[]>('/v1/notification-preferences'),
    ])
    devices.value = subscriptionList
    for (const row of preferenceRows) {
      const saved = savedPreferences.find((item) => item.type === row.type && item.channel === 'web_push')
      row.enabled = saved ? saved.enabled : true
    }
    pushState.value = getBrowserPushState()
  } finally { loading.value = false }
}

async function enable() {
  busy.value = true
  try {
    await enableBrowserPush(); pushState.value = getBrowserPushState(); await load()
    ElMessage.success('当前浏览器系统通知已开启')
  } catch (error: any) { ElMessage.error(error.message || '开启系统通知失败') }
  finally { busy.value = false }
}

async function disable() {
  busy.value = true
  try {
    await disableBrowserPush(); pushState.value = getBrowserPushState(); await load()
    ElMessage.success('当前浏览器系统通知已关闭')
  } catch (error: any) { ElMessage.error(error.message || '关闭系统通知失败') }
  finally { busy.value = false }
}

async function sendTest() {
  testing.value = true
  try {
    const ownId = currentBrowserSubscriptionId()
    const fallback = devices.value.find((item) => item.channel === 'web_push' && item.status === 'active')?.id
    await sendBrowserPushTest(ownId || fallback); ElMessage.success('测试通知已进入发送队列')
  } catch (error: any) { ElMessage.error(error.message || '发送测试通知失败') }
  finally { testing.value = false }
}

async function savePreference(item: PreferenceRow, enabled: boolean) {
  item.saving = true
  try { await http.put('/v1/notification-preferences', { type: item.type, channel: 'web_push', enabled }) }
  catch { item.enabled = !enabled }
  finally { item.saving = false }
}

onMounted(load)
</script>

<style scoped>
.page-description { margin: 6px 0 0; color: var(--qj-muted); font-size: 13px; }
.settings-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 16px; margin-bottom: 16px; }
.card-heading { display: flex; gap: 12px; align-items: center; margin-bottom: 22px; }
.card-heading.compact { margin-bottom: 10px; }
.card-heading h3 { margin: 0 0 5px; font-size: 16px; }
.card-heading p { margin: 0; color: var(--qj-muted); font-size: 13px; }
.heading-icon { width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center; color: var(--el-color-primary); background: var(--tint-blue); font-size: 20px; flex: none; }
.heading-icon.green { color: var(--el-color-success); background: var(--tint-green); }
.status-row { display: flex; align-items: flex-start; gap: 10px; padding: 14px; background: #fafbfc; border: 1px solid var(--qj-border); border-radius: 8px; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; background: var(--qj-muted); }
.status-dot.granted { background: var(--el-color-success); box-shadow: 0 0 0 4px #e8f8e8; }
.status-dot.denied, .status-dot.insecure { background: var(--el-color-warning); }
.status-help { color: var(--qj-muted); font-size: 12px; margin-top: 4px; line-height: 1.5; }
.actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.preference-list { display: grid; }
.preference-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid var(--qj-border); }
.preference-row:last-child { border-bottom: 0; }
.preference-row strong, .preference-row span { display: block; }
.preference-row strong { font-size: 14px; margin-bottom: 4px; }
.preference-row span { color: var(--qj-muted); font-size: 12px; }
.devices-head { display: flex; align-items: center; justify-content: space-between; }
.device-name { display: flex; align-items: center; gap: 10px; }
.device-name .el-icon { color: var(--el-color-primary); font-size: 18px; }
.device-name strong, .device-name span { display: block; }
.device-name span { color: var(--qj-muted); font-size: 12px; margin-top: 2px; }
@media (max-width: 900px) { .settings-grid { grid-template-columns: 1fr; } }
</style>

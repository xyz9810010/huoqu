<template>
  <div class="providers-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">消息推送</h2>
        <p class="page-description">集中配置浏览器与系统级推送通道。配置通过测试后才能启用。</p>
      </div>
      <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>刷新状态</el-button>
    </div>

    <el-alert type="info" :closable="false" show-icon class="flow-tip">
      <template #title>统一接入流程：填写凭据并保存 → 连接测试 → 启用通道</template>
    </el-alert>

    <div v-loading="loading" class="provider-grid">
      <el-card v-for="provider in providers" :key="provider.code" class="provider-card">
        <template #header>
          <div class="provider-head">
            <div class="provider-identity">
              <div class="provider-icon"><el-icon><Connection /></el-icon></div>
              <div>
                <strong>{{ provider.displayName }}</strong>
                <span>{{ provider.platforms.join(' · ') || '通用平台' }}</span>
              </div>
            </div>
            <el-tag :type="statusMeta(provider).type" effect="plain">{{ statusMeta(provider).label }}</el-tag>
          </div>
        </template>

        <el-form label-position="top" @submit.prevent>
          <el-form-item v-for="field in provider.credentialSchema" :key="field.key">
            <template #label>
              <span>{{ field.label }}<i v-if="field.required">必填</i></span>
            </template>
            <el-input v-model="drafts[provider.code][field.key]"
              :type="field.control === 'textarea' ? 'textarea' : (field.secret ? 'password' : 'text')"
              :rows="field.control === 'textarea' ? 5 : undefined"
              :show-password="field.secret && field.control !== 'textarea'"
              :placeholder="field.secret && provider.fields[field.key]?.configured ? '已安全保存，留空表示不修改' : `请输入${field.label}`"
              autocomplete="off" />
            <div v-if="field.secret && provider.fields[field.key]?.configured" class="field-state">
              <el-icon><Lock /></el-icon>已加密保存
            </div>
          </el-form-item>
        </el-form>

        <div class="health-row">
          <span>配置版本 v{{ provider.configVersion || 0 }}</span>
          <span v-if="provider.lastTestedAt">最近测试 {{ formatTime(provider.lastTestedAt) }}</span>
          <span v-if="provider.lastErrorCode" class="health-error">{{ provider.lastErrorCode }}</span>
        </div>

        <div class="provider-actions">
          <el-button type="primary" :loading="busy[provider.code] === 'save'" @click="save(provider)">保存配置</el-button>
          <el-button :disabled="!provider.configured" :loading="busy[provider.code] === 'test'" @click="testProvider(provider)">
            连接测试
          </el-button>
          <el-button v-if="!provider.enabled" type="success" plain :disabled="!canEnableProvider(provider)"
            :loading="busy[provider.code] === 'enable'" @click="setEnabled(provider, true)">启用</el-button>
          <el-button v-else type="danger" plain :loading="busy[provider.code] === 'disable'"
            @click="setEnabled(provider, false)">停用</el-button>
        </div>
      </el-card>
      <el-empty v-if="!loading && !providers.length" description="暂无已安装的推送适配器" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import http from '../api'
import { canEnableProvider, createProviderDraft } from '../services/provider-form'
import type { PushProvider } from '../types/notifications'

const providers = ref<PushProvider[]>([])
const drafts = reactive<Record<string, Record<string, string>>>({})
const busy = reactive<Record<string, string>>({})
const loading = ref(false)

function replaceProvider(updated: PushProvider) {
  const index = providers.value.findIndex((item) => item.code === updated.code)
  if (index >= 0) providers.value[index] = { ...providers.value[index], ...updated }
}

async function load() {
  loading.value = true
  try {
    providers.value = await http.get<any, PushProvider[]>('/v1/admin/push-providers')
    for (const provider of providers.value) drafts[provider.code] = createProviderDraft(provider)
  } finally { loading.value = false }
}

function credentialsFor(provider: PushProvider): Record<string, string> {
  const credentials: Record<string, string> = {}
  for (const field of provider.credentialSchema) {
    const value = drafts[provider.code]?.[field.key] || ''
    if (!field.secret || value) credentials[field.key] = value
  }
  return credentials
}

async function save(provider: PushProvider) {
  busy[provider.code] = 'save'
  try {
    const updated = await http.put<any, PushProvider>(`/v1/admin/push-providers/${encodeURIComponent(provider.code)}`, {
      credentials: credentialsFor(provider),
    })
    replaceProvider(updated)
    drafts[provider.code] = createProviderDraft({ ...provider, ...updated })
    ElMessage.success('配置已安全保存，请继续执行连接测试')
  } finally { busy[provider.code] = '' }
}

async function testProvider(provider: PushProvider) {
  busy[provider.code] = 'test'
  try {
    const updated = await http.post<any, PushProvider>(`/v1/admin/push-providers/${encodeURIComponent(provider.code)}/test`)
    replaceProvider(updated)
    ElMessage.success('连接测试通过，现在可以启用该通道')
  } finally { busy[provider.code] = '' }
}

async function setEnabled(provider: PushProvider, enabled: boolean) {
  busy[provider.code] = enabled ? 'enable' : 'disable'
  try {
    await http.post(`/v1/admin/push-providers/${encodeURIComponent(provider.code)}/enable`, { enabled })
    provider.enabled = enabled
    ElMessage.success(enabled ? '推送通道已启用' : '推送通道已停用')
  } finally { busy[provider.code] = '' }
}

function statusMeta(provider: PushProvider): { label: string; type: 'success' | 'warning' | 'danger' | 'info' } {
  if (provider.enabled) return { label: '运行中', type: 'success' }
  if (provider.healthStatus === 'failed') return { label: '测试失败', type: 'danger' }
  if (provider.healthStatus === 'healthy') return { label: '测试通过', type: 'warning' }
  if (provider.configured) return { label: '待测试', type: 'warning' }
  return { label: '未配置', type: 'info' }
}

function formatTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { hour12: false })
}

onMounted(load)
</script>

<style scoped>
.page-description { margin: 6px 0 0; color: var(--qj-muted); font-size: 13px; }
.flow-tip { margin-bottom: 16px; }
.provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 16px; min-height: 160px; }
.provider-card { align-self: start; }
.provider-head, .provider-identity, .provider-actions, .health-row { display: flex; align-items: center; }
.provider-head { justify-content: space-between; gap: 12px; }
.provider-identity { gap: 11px; min-width: 0; }
.provider-identity strong, .provider-identity span { display: block; }
.provider-identity strong { font-size: 15px; }
.provider-identity span { margin-top: 3px; color: var(--qj-muted); font-size: 12px; text-transform: uppercase; }
.provider-icon { width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; color: var(--el-color-primary); background: var(--tint-blue); font-size: 18px; flex: none; }
.provider-card :deep(.el-form-item) { margin-bottom: 17px; }
.provider-card :deep(.el-form-item__label) { color: var(--qj-text-2); font-size: 13px; }
.provider-card :deep(.el-form-item__label i) { margin-left: 7px; color: var(--el-color-danger); font-size: 11px; font-style: normal; font-weight: 400; }
.field-state { display: flex; align-items: center; gap: 4px; margin-top: 5px; color: var(--el-color-success); font-size: 11px; }
.health-row { min-height: 30px; flex-wrap: wrap; gap: 6px 14px; padding: 9px 11px; margin: 4px 0 16px; border: 1px solid var(--qj-border); border-radius: 7px; background: #fafbfc; color: var(--qj-muted); font-size: 11px; }
.health-error { color: var(--el-color-danger); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.provider-actions { gap: 8px; flex-wrap: wrap; }
@media (max-width: 640px) { .provider-actions .el-button { flex: 1; margin-left: 0; } }
</style>

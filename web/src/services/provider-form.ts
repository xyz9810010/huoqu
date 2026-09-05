import type { PushProvider } from '../types/notifications'

const SERVICE_ACCOUNT_KEYS = ['key_id', 'sub_account', 'private_key'] as const

export function createProviderDraft(provider: Pick<PushProvider, 'credentialSchema' | 'fields'>): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const field of provider.credentialSchema) {
    const state = provider.fields[field.key]
    draft[field.key] = field.secret ? '' : String(state?.value || '')
  }
  return draft
}

export function canEnableProvider(provider: Pick<PushProvider,
  'configured' | 'healthStatus' | 'configVersion' | 'testedVersion'>): boolean {
  return provider.configured && provider.healthStatus === 'healthy' && provider.configVersion === provider.testedVersion
}

export function validateProviderCredentials(
  provider: Pick<PushProvider, 'code' | 'credentialSchema'>,
  credentials: Record<string, string>,
): string[] {
  const errors: string[] = []
  for (const field of provider.credentialSchema) {
    const value = String(credentials[field.key] || '').trim()
    if (field.required && !value) {
      errors.push(`请填写${field.label}`)
      continue
    }
    if (provider.code === 'huawei' && field.key === 'serviceAccount' && value) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(value)
      } catch {
        errors.push('服务账号 JSON 不是有效的 JSON 文本')
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('服务账号 JSON 必须是 JSON 对象')
        continue
      }
      const object = parsed as Record<string, unknown>
      if (object.agcgw || object.appInfos || object.oauth_client) {
        errors.push('检测到内容像是 agconnect-services.json（AGC 工程配置）。请粘贴 AGC「项目设置 → 服务账号」下载的 JSON（含 key_id、sub_account、private_key）')
      } else {
        const missing = SERVICE_ACCOUNT_KEYS.filter(key => typeof object[key] !== 'string' || !String(object[key]).trim())
        if (missing.length) {
          errors.push(`服务账号 JSON 缺少字段：${missing.join('、')}。请粘贴 AGC「项目设置 → 服务账号」下载的 JSON`)
        }
      }
    }
  }
  return errors
}

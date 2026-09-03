import type { PushProvider } from '../types/notifications'

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

export type NotificationPriority = 'low' | 'normal' | 'high'

export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  data: Record<string, unknown>
  priority: NotificationPriority
  read: boolean
  readAt: string
  createdAt: string
}

export interface NotificationSubscription {
  id: string
  userId: string
  channel: 'web_push' | 'vendor_push'
  providerCode: string
  platform: string
  deviceLabel: string
  appVersion: string
  status: 'active' | 'invalid'
  lastSeenAt: string
  createdAt: string
}

export interface NotificationPreference {
  type: string
  channel: string
  enabled: boolean
  quietStart?: string
  quietEnd?: string
}

export interface PushCredentialField {
  key: string
  label: string
  secret: boolean
  required: boolean
  control?: 'text' | 'password' | 'textarea'
}

export interface PushProviderFieldState {
  configured: boolean
  value?: string
  masked?: string
}

export interface PushProvider {
  code: string
  displayName: string
  platforms: string[]
  capabilities: Record<string, unknown>
  credentialSchema: PushCredentialField[]
  fields: Record<string, PushProviderFieldState>
  configured: boolean
  enabled: boolean
  configVersion: number
  testedVersion: number
  healthStatus: 'unconfigured' | 'untested' | 'healthy' | 'failed'
  lastTestedAt: string
  lastErrorCode: string
}

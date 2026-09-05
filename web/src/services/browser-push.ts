import http from '../api'
import type { NotificationSubscription } from '../types/notifications'

export type BrowserPushStatus = 'unsupported' | 'insecure' | 'default' | 'denied' | 'granted'

export interface BrowserPushState {
  status: BrowserPushStatus
  available: boolean
  reason?: 'ios-pwa' | 'embedded-browser' | 'generic'
}

const STORAGE_KEY = 'cargo:web-push-subscription-id'

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

export function getBrowserPushState(): BrowserPushState {
  if (!window.isSecureContext) return { status: 'insecure', available: false }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { status: 'unsupported', available: false, reason: unsupportedReason() }
  }
  return { status: Notification.permission, available: true }
}

function unsupportedReason(): 'ios-pwa' | 'embedded-browser' | 'generic' {
  const ua = navigator.userAgent
  if (/MicroMessenger|QQ\//.test(ua)) return 'embedded-browser'
  const ios = /iPhone|iPad|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (ios) return 'ios-pwa'
  return 'generic'
}

function deviceLabel(): string {
  const agent = navigator.userAgent
  if (/Edg\//.test(agent)) return 'Edge 浏览器'
  if (/Chrome\//.test(agent)) return 'Chrome 浏览器'
  if (/Firefox\//.test(agent)) return 'Firefox 浏览器'
  if (/Safari\//.test(agent)) return 'Safari 浏览器'
  return 'Web 浏览器'
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/push-sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

export async function enableBrowserPush(): Promise<NotificationSubscription> {
  const state = getBrowserPushState()
  if (state.status === 'insecure') throw new Error('浏览器系统通知需要 HTTPS 安全访问地址')
  if (state.status === 'unsupported') throw new Error('当前浏览器不支持系统通知')
  const permission = state.status === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('浏览器通知权限未开启')

  const sw = await registration()
  const config = await http.get<any, { publicKey: string }>('/v1/notification-providers/web-push/public-key')
  let pushSubscription = await sw.pushManager.getSubscription()
  if (!pushSubscription) {
    pushSubscription = await sw.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    })
  }
  const item = await http.post<any, NotificationSubscription>('/v1/notification-subscriptions', {
    channel: 'web_push',
    providerCode: 'web_push',
    platform: 'web',
    deviceLabel: deviceLabel(),
    subscription: pushSubscription.toJSON(),
  })
  localStorage.setItem(STORAGE_KEY, item.id)
  return item
}

export async function disableBrowserPush(): Promise<void> {
  if ('serviceWorker' in navigator) {
    const sw = await navigator.serviceWorker.ready
    const subscription = await sw.pushManager.getSubscription()
    if (subscription) await subscription.unsubscribe()
  }
  const id = localStorage.getItem(STORAGE_KEY)
  if (id) {
    try {
      await http.delete(`/v1/notification-subscriptions/${encodeURIComponent(id)}`)
    } catch (_) {
      // 服务端订阅可能已不存在（清理旧登记属幂等操作），本地照常清除
    }
  }
  localStorage.removeItem(STORAGE_KEY)
}

export async function sendBrowserPushTest(subscriptionId?: string): Promise<void> {
  const id = subscriptionId || localStorage.getItem(STORAGE_KEY)
  if (!id) throw new Error('当前浏览器尚未登记系统通知')
  await http.post(`/v1/notification-subscriptions/${encodeURIComponent(id)}/test`)
}

export function currentBrowserSubscriptionId(): string {
  return localStorage.getItem(STORAGE_KEY) || ''
}

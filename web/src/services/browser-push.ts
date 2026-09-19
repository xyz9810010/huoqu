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

/**
 * 给 Promise 加超时。
 *
 * 为什么必需：navigator.serviceWorker.ready 在"没有 Service Worker 成功注册"时
 * **永远不会 resolve**（它不是 reject，是彻底悬住）。若直接 await 它，
 * 调用链会一直挂着 —— 实测表现为界面永远停在"正在自动登记本浏览器…"，
 * 用户既等不到成功、也看不到手动按钮。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + '超时')), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/push-sw.js', { scope: '/' })
  // 注册成功也可能迟迟不进入 ready（例如被浏览器节流），加超时避免整体悬住
  return withTimeout(navigator.serviceWorker.ready, 8000, '等待 Service Worker 就绪')
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

export function currentBrowserSubscriptionId(): string {
  return localStorage.getItem(STORAGE_KEY) || ''
}

// 自动修复：浏览器已授权通知、本地有订阅，但服务端订阅已失效时，自动重新登记（静默）
export async function autoRepairBrowserPush(): Promise<boolean> {
  if (getBrowserPushState().status !== 'granted') return false
  if (!('serviceWorker' in navigator)) return false
  try {
    // 必须先注册 Service Worker，再等 ready。
    // navigator.serviceWorker.ready 只在"该作用域已有注册"时才 resolve；
    // 全新浏览器上直接 await ready 会一直悬住 —— 实测 5 秒都等不到，
    // 这会让"自动登记"在任何新设备上永远失败（只表现为超时）。
    const sw = await registration()
    const localSubscription = await sw.pushManager.getSubscription()
    const list = await http.get<any, NotificationSubscription[]>('/v1/notification-subscriptions')
    const active = list.find((item) => item.channel === 'web_push' && item.status === 'active')
    // 只有「本地有订阅」且「服务端有 active 订阅」才视为正常；任一端缺失都重新登记。
    // 覆盖两种失效：服务端订阅被标记 invalid（WEB_PUSH_ENDPOINT_GONE），或本地订阅被浏览器清掉。
    if (active && localSubscription) return false
    await disableBrowserPush()
    await enableBrowserPush()
    return true
  } catch {
    return false
  }
}

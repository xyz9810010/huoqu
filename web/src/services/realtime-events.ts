export interface RealtimeEventClientOptions {
  issueTicket: () => Promise<string>
  createEventSource: (url: string) => EventSource
  schedule: (callback: () => void | Promise<void>, delayMs: number) => number
  cancelSchedule: (handle: number) => void
  reconnectDelayMs?: number
  onMessage: (event: MessageEvent<string>) => void
  onConnectionError?: (error: unknown) => void
}

export interface RealtimeNotification {
  id: string
  type: string
  title: string
  body: string
  data: Record<string, unknown>
  priority: 'low' | 'normal' | 'high'
  createdAt: string
}

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

export type RealtimeEventListener = (event: RealtimeEvent) => void

function eventValue(event: unknown): RealtimeEvent | null {
  if (!event || typeof event !== 'object') return null
  const value = event as Record<string, unknown>
  if (typeof value.type !== 'string' || !value.type) return null
  return value as RealtimeEvent
}

export function notificationFromRealtimeEvent(event: unknown): RealtimeNotification | null {
  if (!event || typeof event !== 'object') return null
  const message = event as Record<string, unknown>
  if (message.type !== 'notification.created' || !message.data || typeof message.data !== 'object') return null
  const notification = (message.data as Record<string, unknown>).notification
  if (!notification || typeof notification !== 'object') return null
  const value = notification as Record<string, unknown>
  if (!value.id || !value.type || !value.title) return null
  const priority = value.priority === 'low' || value.priority === 'high' ? value.priority : 'normal'
  return {
    id: String(value.id),
    type: String(value.type),
    title: String(value.title),
    body: String(value.body || ''),
    data: value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? value.data as Record<string, unknown>
      : {},
    priority,
    createdAt: String(value.createdAt || ''),
  }
}

export function createRealtimeEventHub() {
  const listeners = new Set<RealtimeEventListener>()
  const seenNotificationIds = new Set<string>()
  const notificationOrder: string[] = []

  return {
    subscribe(listener: RealtimeEventListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(rawEvent: unknown) {
      const event = eventValue(rawEvent)
      if (!event) return false
      const notification = notificationFromRealtimeEvent(event)
      if (notification) {
        if (seenNotificationIds.has(notification.id)) return false
        seenNotificationIds.add(notification.id)
        notificationOrder.push(notification.id)
        if (notificationOrder.length > 200) {
          seenNotificationIds.delete(notificationOrder.shift() as string)
        }
      }
      for (const listener of [...listeners]) {
        try { listener(event) } catch { /* 隔离页面监听异常，保持实时链路可用 */ }
      }
      return true
    },
  }
}

export const realtimeEventHub = createRealtimeEventHub()

interface RealtimeRefreshOptions {
  hub?: ReturnType<typeof createRealtimeEventHub>
  predicate: (event: RealtimeEvent) => boolean
  refresh: () => void | Promise<void>
  schedule?: (callback: () => void, delayMs: number) => number
  cancelSchedule?: (handle: number) => void
  delayMs?: number
}

export function createRealtimeRefreshSubscription(options: RealtimeRefreshOptions) {
  const hub = options.hub || realtimeEventHub
  const schedule = options.schedule || ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancelSchedule = options.cancelSchedule || ((handle) => window.clearTimeout(handle))
  let handle: number | null = null
  const unsubscribe = hub.subscribe((event) => {
    if (!options.predicate(event)) return
    if (handle !== null) cancelSchedule(handle)
    handle = schedule(() => {
      handle = null
      void Promise.resolve(options.refresh()).catch(() => {})
    }, options.delayMs ?? 100)
  })
  return {
    dispose() {
      unsubscribe()
      if (handle !== null) cancelSchedule(handle)
      handle = null
    },
  }
}

export function taskIdFromRealtimeEvent(rawEvent: unknown): string {
  const event = eventValue(rawEvent)
  if (!event) return ''
  const notification = notificationFromRealtimeEvent(event)
  if (notification?.data.resourceType === 'pickupTask') {
    return String(notification.data.resourceId || '')
  }
  return event.type.startsWith('task.') ? String(event.taskId || '') : ''
}

export function isTaskRealtimeEvent(rawEvent: unknown): boolean {
  const event = eventValue(rawEvent)
  if (!event) return false
  const notification = notificationFromRealtimeEvent(event)
  return Boolean(notification?.type.startsWith('pickupTask.')) || event.type.startsWith('task.')
}

export function createRealtimeEventClient(options: RealtimeEventClientOptions) {
  let source: EventSource | null = null
  let reconnectHandle: number | null = null
  let stopped = true
  let connecting = false

  async function connect() {
    if (stopped || connecting) return
    connecting = true
    try {
      const ticket = await options.issueTicket()
      if (stopped) return
      source?.close()
      source = options.createEventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`)
      source.onmessage = options.onMessage
      source.onerror = () => {
        source?.close()
        source = null
        if (stopped || reconnectHandle !== null) return
        reconnectHandle = options.schedule(async () => {
          reconnectHandle = null
          await connect()
        }, options.reconnectDelayMs ?? 3_000)
      }
    } catch (error) {
      options.onConnectionError?.(error)
      if (!stopped && reconnectHandle === null) {
        reconnectHandle = options.schedule(async () => {
          reconnectHandle = null
          await connect()
        }, options.reconnectDelayMs ?? 3_000)
      }
    } finally {
      connecting = false
    }
  }

  return {
    async start() {
      stopped = false
      await connect()
    },
    stop() {
      stopped = true
      source?.close()
      source = null
      if (reconnectHandle !== null) options.cancelSchedule(reconnectHandle)
      reconnectHandle = null
    },
  }
}

interface NotificationSoundOptions {
  eventTarget?: EventTarget
  audioContextFactory?: () => AudioContext
  visibilityState?: () => DocumentVisibilityState
}

export function createNotificationSoundController(options: NotificationSoundOptions = {}) {
  const eventTarget = options.eventTarget || (typeof window !== 'undefined' ? window : undefined)
  const audioContextFactory = options.audioContextFactory || (() => {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    return new AudioContextClass()
  })
  const visibilityState = options.visibilityState || (() => document.visibilityState)
  const VOLUME_KEY = 'cargo:notification-volume'
  let context: AudioContext | null = null
  let installed = false
  let volume = 1
  try {
    const saved = localStorage.getItem(VOLUME_KEY)
    if (saved !== null) {
      const parsed = parseFloat(saved)
      if (!Number.isNaN(parsed)) volume = Math.min(1, Math.max(0, parsed))
    }
  } catch {
    // localStorage 不可用时使用默认音量
  }

  function setVolume(value: number) {
    volume = Math.min(1, Math.max(0, value))
    try { localStorage.setItem(VOLUME_KEY, String(volume)) } catch {}
  }
  function getVolume() {
    return volume
  }

  function removeUnlockListeners() {
    if (!eventTarget || !installed) return
    eventTarget.removeEventListener('pointerdown', unlock)
    eventTarget.removeEventListener('keydown', unlock)
    installed = false
  }

  function unlock() {
    try {
      context ||= audioContextFactory()
      void context.resume().then(removeUnlockListeners).catch(() => {})
    } catch {
      // 不支持 Web Audio 的浏览器仍可依赖系统 Web Push 提示。
    }
  }

  function tone(frequency: number, startAt: number) {
    if (!context) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, startAt)
    const peak = 0.12 * volume
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + 0.15)
  }

  return {
    install() {
      if (!eventTarget || installed || context?.state === 'running') return
      installed = true
      eventTarget.addEventListener('pointerdown', unlock, { capture: true })
      eventTarget.addEventListener('keydown', unlock, { capture: true })
    },
    play() {
      if (!context || context.state !== 'running' || visibilityState() !== 'visible') return false
      const now = context.currentTime
      tone(740, now)
      tone(988, now + 0.18)
      return true
    },
    dispose() {
      removeUnlockListeners()
      if (context) void Promise.resolve(context.close()).catch(() => {})
      context = null
    },
    setVolume,
    getVolume,
  }
}

export const notificationSound = createNotificationSoundController()

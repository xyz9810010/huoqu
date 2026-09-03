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
  let context: AudioContext | null = null
  let installed = false

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
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.015)
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
  }
}

export const notificationSound = createNotificationSoundController()

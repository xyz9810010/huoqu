// 摄像头扫码：优先用浏览器原生 BarcodeDetector，回退到本地打包的 html5-qrcode
// 依赖：/html5-qrcode.min.js（由 server.js 从 public/ 提供，无需外网）

export interface ScannerHandle {
  stop(): Promise<void>
}

export interface ScannerOptions {
  onDetected: (text: string) => void
  onError: (message: string) => void
}

const LIB_URL = '/html5-qrcode.min.js'

/** 摄像头只在「安全上下文」可用：HTTPS 或 localhost/127.0.0.1；局域网 http://IP 不行。 */
export function cameraSupport(): { ok: boolean; reason: string } {
  const isSecure = typeof window !== 'undefined' && window.isSecureContext
  const hasMedia = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  if (isSecure && hasMedia) return { ok: true, reason: '' }
  const host = typeof location !== 'undefined' ? location.host : ''
  return {
    ok: false,
    reason: `当前地址 ${host} 不是安全上下文，浏览器不允许网页调用摄像头。`,
  }
}

export function hasNativeDetector(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window
}

let libPromise: Promise<any> | null = null

function loadLib(): Promise<any> {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const existing = (window as any).Html5Qrcode
      if (existing) return resolve(existing)
      const script = document.createElement('script')
      script.src = LIB_URL
      script.async = true
      script.onload = () => {
        const Ctor = (window as any).Html5Qrcode
        Ctor ? resolve(Ctor) : reject(new Error('扫码组件加载后未找到 Html5Qrcode'))
      }
      script.onerror = () => reject(new Error('扫码组件加载失败'))
      document.head.appendChild(script)
    }).catch((err) => {
      libPromise = null // 允许下次重试
      throw err
    })
  }
  return libPromise
}

function describeCameraError(err: any): string {
  const name = String(err?.name || '')
  if (name === 'NotAllowedError' || name === 'SecurityError') return '摄像头权限被拒绝，请在浏览器设置里允许本站使用摄像头'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的摄像头'
  if (name === 'NotReadableError') return '摄像头被其他应用占用，请关闭后重试'
  return err?.message || '无法启动摄像头'
}

/** 用原生 BarcodeDetector + 自建 <video> 取流（安卓 Chrome 支持，性能最好） */
async function startNative(elementId: string, opts: ScannerOptions): Promise<ScannerHandle> {
  const video = document.querySelector<HTMLVideoElement>(`#${elementId} video`)
  if (!video) throw new Error('扫码容器未就绪')
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  })
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => undefined)

  const AnyWin = window as any
  const detector = new AnyWin.BarcodeDetector()
  let stopped = false
  let timer: number | undefined

  const tick = async () => {
    if (stopped) return
    try {
      const codes = await detector.detect(video)
      if (codes && codes.length) {
        const raw = String(codes[0].rawValue || '').trim()
        if (raw) {
          opts.onDetected(raw)
          return // 由调用方决定是否停止
        }
      }
    } catch {
      /* 单帧识别失败不致命，继续下一帧 */
    }
    timer = window.setTimeout(tick, 280)
  }
  timer = window.setTimeout(tick, 400)

  return {
    async stop() {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
}

/** 回退：html5-qrcode（iOS Safari 等无 BarcodeDetector 的浏览器） */
async function startLib(elementId: string, opts: ScannerOptions): Promise<ScannerHandle> {
  const Ctor = await loadLib()
  const scanner = new Ctor(elementId, { verbose: false })
  await scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 160 } },
    (decoded: string) => {
      const raw = String(decoded || '').trim()
      if (raw) opts.onDetected(raw)
    },
    () => undefined, // 逐帧失败不提示，避免刷屏
  )
  return {
    async stop() {
      try {
        await scanner.stop()
        scanner.clear()
      } catch {
        /* 已停止时忽略 */
      }
    },
  }
}

export async function startScanner(elementId: string, opts: ScannerOptions): Promise<ScannerHandle> {
  const support = cameraSupport()
  if (!support.ok) {
    const err = new Error(support.reason)
    opts.onError(support.reason)
    throw err
  }
  try {
    return hasNativeDetector()
      ? await startNative(elementId, opts)
      : await startLib(elementId, opts)
  } catch (err: any) {
    const msg = describeCameraError(err)
    opts.onError(msg)
    throw new Error(msg)
  }
}

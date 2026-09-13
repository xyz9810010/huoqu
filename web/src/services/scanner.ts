// 摄像头扫码：优先用浏览器原生 BarcodeDetector（快），回退到本地打包的 html5-qrcode
// 依赖：/html5-qrcode.min.js（由 Vite 从 web/public 打进 dist，无需外网）
//
// 实测教训（务必保留）：一维条码（Code128 等）宽度可达 500px 以上，
// 扫描窗若只给 400px 宽会把条码裁断、导致"相机开着但识别不了"。
// 因此这里一律用「整帧」作为扫描区域，让解码器看到完整条码。

export interface ScannerHandle {
  stop(): Promise<void>
}

export interface ScannerOptions {
  onDetected: (text: string) => void
  onError: (message: string) => void
  /** 一组制式试扫失败、切换到下一组时回调，便于向用户解释 */
  onFormatChange?: (label: string) => void
}

const LIB_URL = '/html5-qrcode.min.js'

// 快递/物流面单常见制式：一维为主，兼顾二维码
const FORMAT_SETS: { label: string; names: string[] }[] = [
  { label: '常用面单码（Code128 / Code39 / ITF / 二维码）', names: ['CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR', 'QR_CODE'] },
  { label: '全部支持制式', names: ['CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR', 'QR_CODE', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'DATA_MATRIX', 'PDF_417'] },
]
const FORMAT_SWITCH_MS = 7000

/** 摄像头只在「安全上下文」可用：HTTPS 或 localhost/127.0.0.1；局域网 http://IP 不行。 */
export function cameraSupport(): { ok: boolean; reason: string } {
  const isSecure = typeof window !== 'undefined' && window.isSecureContext
  const hasMedia = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  if (isSecure && hasMedia) return { ok: true, reason: '' }
  const host = typeof location !== 'undefined' ? location.host : ''
  return { ok: false, reason: `当前地址 ${host} 不是安全上下文，浏览器不允许网页调用摄像头。` }
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
  // 库有时只抛出字符串（如约束不合法），把它原样带出来，便于定位
  const raw = typeof err === 'string' ? err : err?.message
  if (raw) return `无法启动摄像头：${String(raw).slice(0, 160)}`
  return '无法启动摄像头'
}

/** 高分辨率 + 连续对焦：一维码很细，低分辨率或失焦都解不出。
 *  注意：html5-qrcode 对 videoConstraints 有自己的校验 —— facingMode 只接受
 *  字符串或 { exact: ... }，写成 { ideal: ... } 会直接抛
 *  "'facingMode' should be string or object with exact as key."，导致相机根本起不来。 */
const VIDEO_CONSTRAINTS = {
  facingMode: 'environment',
  width: { ideal: 1920 },
  height: { ideal: 1080 },
} as any

function makeScanner(Ctor: any, elementId: string, formatNames: string[]): any {
  const F = (window as any).Html5QrcodeSupportedFormats
  const formats = formatNames.map((n) => F[n]).filter((v: any) => v !== undefined)
  return new Ctor(elementId, {
    formatsToSupport: formats,
    // 关掉原生 BarcodeDetector：其可用制式由平台决定、不可控，且不少机型不含 1D 码
    useBarCodeDetectorIfSupported: false,
  })
}

/** 扫描窗：整帧。给固定小窗会把一维码裁断（实测 400px 窗无法识别 500px 宽的 Code128） */
const SCAN_CONFIG = {
  fps: 10,
  qrbox: (vw: number, vh: number) => ({
    width: Math.max(200, Math.floor(vw * 0.92)),
    height: Math.max(140, Math.floor(vh * 0.72)),
  }),
}

export async function startScanner(elementId: string, opts: ScannerOptions): Promise<ScannerHandle> {
  const support = cameraSupport()
  if (!support.ok) {
    opts.onError(support.reason)
    throw new Error(support.reason)
  }

  let Ctor: any
  try {
    Ctor = await loadLib()
  } catch (err: any) {
    const msg = err?.message || '扫码组件加载失败'
    opts.onError(msg)
    throw new Error(msg)
  }

  let scanner: any = null
  let stopped = false
  let switchTimer: number | undefined
  let setIndex = 0
  let detected = false

  const stopCurrent = async () => {
    if (!scanner) return
    const s = scanner
    scanner = null
    try {
      await s.stop()
      s.clear()
    } catch {
      /* 已停止时忽略 */
    }
  }

  const startWithSet = async (index: number) => {
    setIndex = index
    const set = FORMAT_SETS[index]
    scanner = makeScanner(Ctor, elementId, set.names)
    await scanner.start(
      VIDEO_CONSTRAINTS,
      SCAN_CONFIG,
      (decoded: string) => {
        const raw = String(decoded || '').trim()
        if (!raw) return
        detected = true
        if (switchTimer !== undefined) window.clearTimeout(switchTimer)
        opts.onDetected(raw)
      },
      () => undefined, // 逐帧失败不提示，避免刷屏
    )
    // 第一组制式扫不到时，自动换更全的一组，并告知用户
    if (index === 0 && !stopped) {
      switchTimer = window.setTimeout(async () => {
        if (stopped || detected || setIndex !== 0) return
        try {
          await stopCurrent()
          if (stopped || detected) return
          await startWithSet(1)
          opts.onFormatChange?.(FORMAT_SETS[1].label)
        } catch {
          /* 切换失败保持原状 */
        }
      }, FORMAT_SWITCH_MS)
    }
  }

  try {
    await startWithSet(0)
  } catch (err: any) {
    // 再退一步：去掉分辨率约束，只保留后置摄像头，排除个别机型不吃宽高约束
    try {
      scanner = makeScanner(Ctor, elementId, FORMAT_SETS[0].names)
      await scanner.start(
        { facingMode: 'environment' },
        SCAN_CONFIG,
        (decoded: string) => {
          const raw = String(decoded || '').trim()
          if (raw) { detected = true; opts.onDetected(raw) }
        },
        () => undefined,
      )
    } catch (retryErr: any) {
      const msg = describeCameraError(retryErr ?? err)
      opts.onError(msg)
      throw new Error(msg)
    }
  }

  return {
    async stop() {
      stopped = true
      if (switchTimer !== undefined) window.clearTimeout(switchTimer)
      await stopCurrent()
    },
  }
}

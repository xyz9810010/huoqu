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

// 条码制式集合。
// 关键教训：商品条码是 EAN-13 / UPC-A，与面单的 Code128 完全不同的制式。
// 实测（同一张真实图片）：只启用 Code128 那组时，EAN-13 报
// "No MultiFormat Readers were able to detect the code."；把 EAN/UPC 加进来后立刻可解。
// 因此第一组就必须覆盖「面单码 + 商品码」，不能让用户等切换。
// 制式分组：先试"日常真正会遇到"的少数几种，失败再退到全量。
//
// 为什么要分组而不是一上来就全开：每多一种制式，解码器每一帧都要多试一遍。
// 12 种一起开会让识别明显变慢（用户反馈"扫码好慢"），而且制式越多越容易
// 出现误判/互相干扰。实际业务里 99% 就是：面单 Code128 与商品 EAN-13/UPC。
const CORE_FORMATS = [
  'CODE_128', 'CODE_39', 'ITF',
  'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E',
  'QR_CODE',
]
const EXTRA_FORMATS = ['CODE_93', 'CODABAR', 'DATA_MATRIX', 'PDF_417']

const FORMAT_SETS: { label: string; names: string[] }[] = [
  {
    label: '面单码 + 商品码（Code128 / Code39 / ITF / EAN / UPC / 二维码）',
    names: CORE_FORMATS,
  },
  // 少数场景才会用到（如个别面单用 Code93/库德巴、个别标签用 DataMatrix/PDF417）
  {
    label: '扩充码（含 Code93 / 库德巴 / DataMatrix / PDF417）',
    names: [...CORE_FORMATS, ...EXTRA_FORMATS],
  },
]
const FORMAT_SWITCH_MS = 6000

/**
 * 是否使用浏览器原生 BarcodeDetector。
 *
 * 原生识别由系统提供、通常硬件加速，对一维码的速度与命中率都明显优于
 * 库内置的 JS 解码器 —— 这正是"扫码慢、很多识别不了"的主要改善点。
 *
 * 但不能无条件开启：各平台支持的原生制式不同，若它不支持我们要的制式，
 * 开了反而什么都识别不出。因此先问一句 getSupportedFormats()，
 * 至少覆盖「面单 Code128 + 商品 EAN-13」这两个主力制式才启用。
 */
function nativeDetectorUsable(): boolean {
  try {
    const BD: any = (window as any).BarcodeDetector
    if (typeof BD !== 'function') return false
    if (typeof BD.getSupportedFormats !== 'function') return false
    // 注意：这个 API 是异步的，这里只能同步判断"有没有"，具体制式在 loadLib 后异步确认
    return true
  } catch {
    return false
  }
}

/** 异步确认原生识别是否覆盖主力制式（结果缓存，只问一次） */
let nativeFormatsPromise: Promise<string[]> | null = null
function getNativeFormats(): Promise<string[]> {
  if (!nativeFormatsPromise) {
    nativeFormatsPromise = (async () => {
      try {
        const BD: any = (window as any).BarcodeDetector
        if (typeof BD?.getSupportedFormats !== 'function') return []
        const list = (await BD.getSupportedFormats()) || []
        nativeFormatsCache = list.map((s: any) => String(s))
        return list
      } catch {
        return []
      }
    })()
  }
  return nativeFormatsPromise
}

/** 原生制式名（snake_case）与我们用的一致，见库内映射表 */
const NATIVE_REQUIRED = ['code_128', 'ean_13']
let useNativeDetector = false
async function resolveNativeDetector(): Promise<boolean> {
  if (!nativeDetectorUsable()) return false
  const supported = await getNativeFormats()
  const has = (f: string) => supported.some((s) => String(s).toLowerCase() === f)
  const ok = NATIVE_REQUIRED.every(has)
  return ok
}

/**
 * 供界面显示"当前用的哪个识别引擎"。
 *
 * 为什么要显示：原生识别是否可用取决于机型与浏览器，无法在开发机上确定。
 * 把引擎直接标在扫码界面上，现场就能判断"慢"是因为没走到原生路径，
 * 还是别的原因（对焦、光线、码太小），不必来回猜。
 */
function scannerEngineInfo(): { native: boolean; supportedCount: number } {
  return { native: useNativeDetector, supportedCount: nativeFormatsCache.length }
}
let nativeFormatsCache: string[] = []

/** 等待扫码库与引擎判定就绪，然后返回引擎信息（供界面显示） */
export async function ensureScannerReady(): Promise<{ native: boolean; supportedCount: number }> {
  await loadLib()
  return scannerEngineInfo()
}

/** 摄像头只在「安全上下文」可用：HTTPS 或 localhost/127.0.0.1；局域网 http://IP 不行。 */
export function cameraSupport(): { ok: boolean; reason: string } {
  const isSecure = typeof window !== 'undefined' && window.isSecureContext
  const hasMedia = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  if (isSecure && hasMedia) return { ok: true, reason: '' }
  const host = typeof location !== 'undefined' ? location.host : ''
  return { ok: false, reason: `当前地址 ${host} 不是安全上下文，浏览器不允许网页调用摄像头。` }
}

/**
 * 查询摄像头的授权状态。
 *
 * 用途：一旦用户在权限弹窗里点了"拒绝"，浏览器会**记住**该决定，
 * 之后 getUserMedia 直接抛 NotAllowedError，且**不再弹窗** ——
 * 用户会以为"点了没反应"。因此在打开扫码弹窗时先查一次，
 * 若已拒绝就直接给"如何改回来"的指引，而不是让他白点一次。
 */
export async function getCameraPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    if (!navigator.permissions?.query) return 'unknown'
    const status: any = await navigator.permissions.query({ name: 'camera' as PermissionName })
    const state = String(status?.state || '')
    if (state === 'granted' || state === 'denied' || state === 'prompt') return state
    return 'unknown'
  } catch {
    // 部分浏览器不支持查询 camera（会抛 TypeError），此时按未知处理
    return 'unknown'
  }
}

let libPromise: Promise<any> | null = null

/**
 * 预加载扫码库。
 *
 * 为什么必须预加载：startScanner 里原本是"点按钮 → 动态插入 <script> 等网络 →
 * 再调 getUserMedia"。而 iOS Safari 等浏览器要求 getUserMedia
 * **必须在用户手势的调用栈内发起**；中间 await 一次网络请求后手势即失效，
 * 表现为"点了实时扫码没反应 / 直接报权限错误"。
 * 在扫码弹窗打开时就先把库拉好，点击时便无需再等网络。
 */
export function preloadScannerLib(): void {
  void loadLib().catch(() => {
    /* 预加载失败不提示，真正点击时还会再试并给出错误 */
  })
}

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
    })
      // 顺带确定是否可用原生识别：必须在创建 scanner 之前完成，
      // 否则 makeScanner 读到的 useNativeDetector 还是默认值。
      .then(async (Ctor) => {
        useNativeDetector = await resolveNativeDetector()
        return Ctor
      })
      .catch((err) => {
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

/**
 * 取流约束。
 *
 * 重要：html5-qrcode 对 videoConstraints 有严格校验 ——
 *   · facingMode 只接受字符串或 { exact: ... }，写成 { ideal: ... } 直接抛错；
 *   · **不要加 width/height**：实测（本文件作者在假摄像头上复现）加上
 *     { ideal: 1280/720 } 后，摄像头起不来、什么都识别不到。
 *     曾以为"降分辨率能加快解码"而加过，结果直接导致扫码不可用，已回退。
 *     若将来要调分辨率，必须先在真机上验证，不能只凭推理。
 */
function videoConstraintsFor(): any {
  return { facingMode: 'environment' }
}

function makeScanner(Ctor: any, elementId: string, formatNames: string[]): any {
  const F = (window as any).Html5QrcodeSupportedFormats
  const formats = formatNames.map((n) => F[n]).filter((v: any) => v !== undefined)
  return new Ctor(elementId, {
    formatsToSupport: formats,
    // 优先用浏览器原生识别（更快、一维码命中率更高）；已确认该平台支持主力制式才开启，
    // 否则退回库内置的 JS 解码器，避免"开了反而识别不到"。
    useBarCodeDetectorIfSupported: useNativeDetector,
  })
}

/**
 * 扫描配置。
 *
 * 关键教训（两次踩坑，务必保留）：
 * 1) 不要设 qrbox！库会把 qrbox 区域裁剪后再缩放交给解码器，
 *    这会破坏 EAN-13 这类条码两侧必要的静区（quiet zone）。
 *    实测同一台假摄像头下的 EAN-13：
 *      qrbox 92%x72%  → 识别不到
 *      qrbox 500x300  → 识别不到
 *      不设 qrbox     → 识别成功
 *    一维码（面单 Code128 与商品 EAN-13）都对裁剪很敏感，直接扫整帧最稳。
 * 2) 也不要给固定小窗：400px 宽的窗口装不下 500px 宽的 Code128，会被裁断。
 */
const SCAN_CONFIG = {
  fps: 10,
  // 明确不传 qrbox：整帧识别
}

/**
 * 解码"用系统相机拍下的照片"里的条码。
 *
 * 为什么需要这条路（关键）：
 * 系统部署在 http://192.168.x.x:3000，属于**非安全上下文**。浏览器在这种地址下
 * 根本不暴露 navigator.mediaDevices —— 实测 isSecureContext=false、
 * hasMediaDevices=false。也就是说 getUserMedia 的"页内实时扫码"在该地址上
 * **无论怎么写都不可能工作**，不是代码缺陷。
 *
 * 而 <input type="file" capture="environment"> 不受安全上下文限制：
 * 它直接调起系统相机 App，由系统自动挑选镜头、并自带变焦/对焦/闪光灯。
 * 这同时解决了三件事：
 *   1) 非 HTTPS 也能用；
 *   2) 不必枚举与切换摄像头（用户此前反馈"好几个摄像头只能用一颗"）；
 *   3) 前置摄像头不会被动用（capture="environment" 只请求后置）。
 *
 * 代价：不是连续扫描，一次拍一张。因此界面文案要引导用户对准后拍摄。
 */
export async function decodeImageFile(file: File | Blob): Promise<string> {
  if (!file) throw new Error('未选择图片')
  const Ctor = await loadLib()
  const F = (window as any).Html5QrcodeSupportedFormats

  // scanFile 需要一个容器；用屏幕外但**参与布局**的节点，
  // 完全不渲染（display:none）时库可能拿不到尺寸。
  const holderId = 'qr-file-decode'
  let holder = document.getElementById(holderId)
  if (!holder) {
    holder = document.createElement('div')
    holder.id = holderId
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:360px;height:280px;overflow:hidden'
    document.body.appendChild(holder)
  }

  // 与实时扫码同样的策略：先试"面单码 + 商品码"这一组，失败再用更全的一组。
  const errors: string[] = []
  for (const set of FORMAT_SETS) {
    const formats = set.names.map((n) => F[n]).filter((v: any) => v !== undefined)
    const scanner = new Ctor(holderId, {
      formatsToSupport: formats,
      useBarCodeDetectorIfSupported: useNativeDetector,
    })
    try {
      const text = await scanner.scanFile(file, false)
      const raw = String(text || '').trim()
      if (raw) return raw
      errors.push(`${set.label}: 未识别到条码`)
    } catch (err: any) {
      errors.push(`${set.label}: ${err?.message || err}`)
    } finally {
      try { scanner.clear() } catch { /* 忽略 */ }
    }
  }
  throw new Error('未能从照片中识别出条码，请靠近条码、保证清晰后重拍')
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
      videoConstraintsFor(),
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
    const msg = describeCameraError(err)
    opts.onError(msg)
    throw new Error(msg)
  }

  const handle: ScannerHandle = {
    async stop() {
      stopped = true
      if (switchTimer !== undefined) window.clearTimeout(switchTimer)
      await stopCurrent()
    },
  }
  // 尽量开启连续自动对焦：很多安卓机型默认单次对焦，扫近处的条码会一直模糊。
  // 单独放、且自身吞掉异常 —— 不支持该能力的机型不能因此启动失败。
  void tryContinuousFocus(elementId)
  return handle
}

/**
 * 请求连续自动对焦（"对准就自己变清楚"）。
 *
 * 不放在 videoConstraints 里传给 html5-qrcode：该库对约束校验严格，
 * 复杂约束会直接抛错导致相机起不来（此前 facingMode 用 {ideal} 就踩过）。
 * 这里在流已建立后，直接对 video 轨道 applyConstraints，失败也只当不支持。
 */
async function tryContinuousFocus(elementId: string): Promise<void> {
  try {
    const video = document.querySelector<HTMLVideoElement>(`#${elementId} video`)
    const src = video && video.srcObject
    if (!(src instanceof MediaStream)) return
    const track = src.getVideoTracks()[0]
    if (!track || typeof track.applyConstraints !== 'function') return
    const caps: any = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] })
    }
  } catch {
    /* 机型不支持则忽略，保持默认对焦 */
  }
}

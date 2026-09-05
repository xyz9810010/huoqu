// 浏览器边缘场景巡检：404 兜底页、断网→恢复、派单防重复提交、存储型 XSS 渲染安全。
// 复用 e2e-web 的用法约定：默认自启隔离服务；可 BASE_URL=... 对接已运行服务。
// Playwright 模块与浏览器路径约定见 docs/operations/e2e-web.md。
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/pw/node_modules/playwright'].filter(Boolean)
  for (const candidate of candidates) {
    try { return require(candidate) } catch (_) { /* 尝试下一个来源 */ }
  }
  throw new Error('找不到 playwright 模块：请安装后重试，或用 PLAYWRIGHT_MODULE 指向已安装路径')
}

const ADMIN_PASSWORD = 'e2e-strong-password'
const MACHINE_KEY = 'e2e-machine-key'
const problems = []
const steps = []
const repoRoot = path.resolve(__dirname, '..')
const screenshotDir = process.env.E2E_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hq-edge-shots-'))
const { chromium } = loadPlaywright()
let child = null
let tempDir = null

async function waitForServer(baseUrl, child) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(baseUrl + '/api/health')
      if (res.ok) return
    } catch (_) { /* 未就绪 */ }
    if (child && child.exitCode !== null) throw new Error('被测服务提前退出')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('被测服务 10 秒内未就绪')
}

async function login(page, baseUrl, username, password) {
  await page.goto(baseUrl + '/login', { waitUntil: 'networkidle' })
  const ok = await page.evaluate(async ({ baseUrl, username, password }) => {
    const r = await fetch(baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const body = await r.json()
    if (!body.token) return false
    localStorage.setItem('token', body.token)
    localStorage.setItem('user', JSON.stringify(body.user))
    return true
  }, { baseUrl, username, password })
  if (!ok) throw new Error(`登录失败: ${username}`)
}

async function api(page, method, url, { token, body } = {}) {
  const r = await page.evaluate(async ({ method, url, token, body }) => {
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON */ }
    return { status: res.status, json, text }
  }, { method, url, token, body })
  return r
}

async function main() {
  let baseUrl = process.env.BASE_URL
  if (!baseUrl) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-edge-'))
    const port = 38100 + Math.floor(Math.random() * 900)
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempDir, 'app.db'),
        INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD, DISABLE_PUSH: '1', MACHINE_API_KEY: MACHINE_KEY },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk))
  }
  await waitForServer(baseUrl, child)

  const browser = await chromium.launch()
  let watchPhase = 'normal' // 'offline' 阶段预期存在网络失败噪音，不记入问题
  const watch = (page, label) => {
    const isNoise = msg => /net::ERR_FAILED|Network Error|Failed to load resource/i.test(String(msg))
    page.on('console', msg => {
      if (msg.type() === 'error' && !(watchPhase === 'offline' && isNoise(msg.text()))) problems.push(`${label} console.error: ${msg.text()}`)
    })
    page.on('pageerror', err => { if (watchPhase !== 'offline') problems.push(`${label} pageerror: ${err.message}`) })
    page.on('requestfailed', req => {
      if (!(watchPhase === 'offline' && /net::ERR_FAILED|ERR_ABORTED|ERR_CONNECTION/.test(req.failure()?.errorText || ''))) {
        problems.push(`${label} requestfailed: ${req.url()} ${req.failure()?.errorText}`)
      }
    })
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  watch(page, 'admin')
  await login(page, baseUrl, 'admin', ADMIN_PASSWORD)
  steps.push('admin login')
  const adminApi = (method, url, body) => page.evaluate(async ({ method, url, body, baseUrl }) => {
    const res = await fetch(baseUrl + url, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON */ }
    return { status: res.status, json }
  }, { method, url, body, baseUrl })

  // ---------- 1) 404 兜底页 ----------
  await page.goto(baseUrl + '/no-such-page-xyz', { waitUntil: 'networkidle' })
  await page.getByText('页面不存在').first().waitFor({ state: 'visible', timeout: 8000 })
  steps.push('404 page shows')
  await page.screenshot({ path: path.join(screenshotDir, 'edge-404.png') })
  await page.getByRole('button', { name: '返回首页' }).click()
  await page.waitForURL(url => url.pathname === '/dashboard' || url.pathname === '/tasks', { timeout: 8000 })
  steps.push('404 back home -> ' + page.url())

  // ---------- 2) 断网 → 友好提示 → 恢复 ----------
  await page.route('**/api/**', route => route.abort())
  watchPhase = 'offline'
  await page.goto(baseUrl + '/tasks', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const msgShown = await page.locator('.el-message').first().isVisible().catch(() => false)
  const stuckLoading = await page.locator('.el-loading-mask').isVisible().catch(() => false)
  const clickable = await page.locator('.el-aside, nav, .el-menu').first().isVisible().catch(() => false)
  if (!msgShown) problems.push('断网请求失败后未出现 .el-message 提示')
  if (stuckLoading) problems.push('断网后页面停留在 loading 态')
  if (!clickable) problems.push('断网后页面导航不可用（卡死）')
  steps.push('offline: message=' + msgShown + ' stuck=' + stuckLoading)
  await page.screenshot({ path: path.join(screenshotDir, 'edge-offline.png') })
  await page.unroute('**/api/**')
  watchPhase = 'normal'
  await page.reload({ waitUntil: 'networkidle' })
  const recovered = await page.locator('body').innerText()
  if (!/暂无|加载|任务|刷新|错误/i.test(recovered)) problems.push('网络恢复刷新后页面未正常渲染')
  steps.push('recovered after reload')

  // ---------- 3) 派单防重复提交 ----------
  const cust = await adminApi('POST', '/api/customers', { name: '边缘测试客户' + Date.now(), address: '义乌市边缘路 2 号' })
  if (cust.status >= 400) throw new Error('客户种子失败 ' + cust.status)
  const cid = cust.json.id
  const detail = await adminApi('GET', '/api/customers/' + cid)
  const addrId = detail.json.addresses[0].id
  await page.goto(baseUrl + '/dispatch', { waitUntil: 'networkidle' })
  // 拦截并延迟 POST /api/tasks：制造“首个请求未返回”的重复提交窗口并统计真实下发次数
  let createPosts = 0
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST' && route.request().postData()) {
      createPosts += 1
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    await route.continue().catch(() => {})
  })
  await page.locator('.dispatch-form .el-select').first().click()
  await page.locator('.el-select-dropdown__item:visible', { hasText: cust.json.name }).first().click()
  await page.waitForTimeout(700)
  await page.locator('.dispatch-form button', { hasText: '确认派单' }).click()
  await page.waitForTimeout(120)
  // 请求未返回时再强制触发一次提交（模拟回车+点击/设备双击）
  await page.locator('.dispatch-form button', { hasText: '确认派单' }).click({ force: true, timeout: 3000 }).catch(() => {})
  let landed = false
  try {
    await page.waitForURL(url => /\/tasks\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 15000 })
    landed = true
  } catch (_) { /* 可能因重复提交失败提示留在原页 */ }
  await page.waitForTimeout(1500)
  await page.unroute('**/api/tasks')
  if (createPosts !== 1) problems.push(`派单重复提交应只下发 1 次创建请求，实际 ${createPosts}`)
  const count = await adminApi('GET', '/api/tasks?customerId=' + encodeURIComponent(cid) + '&page=0&size=20')
  const total = count.json && count.json.total !== undefined ? count.json.total : (Array.isArray(count.json) ? count.json.length : -1)
  if (total !== 1) problems.push(`派单双击应只生成 1 个任务，实际 ${total}；landed=${landed}`)
  if (!landed) problems.push('派单成功后未跳转任务详情')
  steps.push('dispatch double submit -> tasks=' + total)
  await page.screenshot({ path: path.join(screenshotDir, 'edge-dispatch.png') })

  // ---------- 4) 存储型 XSS 渲染安全 ----------
  const xssPayload = '<img src=x onerror="window.__xss=1"> 取件备注<script>window.__xss=1</script>'
  const task = await adminApi('POST', '/api/tasks', {
    customerName: 'XSS客户' + Date.now(), address: '义乌市安全路 9 号',
    pickupNote: xssPayload, items: [{ goodsName: '<svg onload="window.__xss=1">', pieces: 1 }]
  })
  if (task.status >= 400) throw new Error('XSS 任务种子失败 ' + task.status)
  const taskId = task.json.id
  await page.goto(baseUrl + '/tasks/' + taskId, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const xssState = await page.evaluate(() => ({
    flag: window.__xss || 0,
    onerrorNodes: document.querySelectorAll('img[onerror], svg[onload], *[onerror], *[onload^="window.__xss"]').length
  }))
  if (xssState.flag) problems.push('XSS 载荷在任务详情页被执行')
  if (xssState.onerrorNodes > 0) problems.push(`XSS 载荷以可执行节点渲染: ${xssState.onerrorNodes}`)
  const detailText = await page.locator('body').innerText()
  if (!detailText.includes('取件备注')) problems.push('任务详情未正常渲染')
  steps.push('xss render safe')
  await page.screenshot({ path: path.join(screenshotDir, 'edge-xss.png') })

  await browser.close()
  const passed = problems.length === 0
  console.log(JSON.stringify({ passed, steps, problems, screenshots: screenshotDir }, null, 2))
  process.exitCode = passed ? 0 : 1
}

main().catch(err => {
  console.error(err)
  if (child && !child.killed) child.kill()
  process.exitCode = 1
})

process.on('exit', () => {
  if (child && !child.killed) child.kill()
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) { /* 忽略 */ } }
})

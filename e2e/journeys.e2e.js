// Huoqu · 应用层业务旅程巡检（真实 Chromium 多角色闭环）
// 与 e2e/web.e2e.js 的静态巡检互补：这里按客服/取件员真实操作顺序走完整业务闭环，
// 覆盖：派单、移动端取件、拍照、完成、站内通知、重量匹配中心、权限守卫与错误体验。
// 运行方式同 docs/operations/e2e-web.md（自动拉起隔离服务，账号密码见脚本常量）。
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/pw/node_modules/playwright'].filter(Boolean)
  for (const candidate of candidates) {
    try { return require(candidate) } catch (_) { /* 下一个来源 */ }
  }
  throw new Error('找不到 playwright 模块')
}

const ADMIN_PASSWORD = 'e2e-strong-password'
const CS_PASSWORD = 'cs-journey-pass-1'
const WORKER_PASSWORD = 'worker-journey-pass-1'
const MACHINE_KEY = 'e2e-machine-key'
const problems = []
const steps = []

async function waitForServer(baseUrl, child) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(baseUrl + '/api/health')
      if (res.ok) return
    } catch (_) { /* 未就绪 */ }
    if (child && child.exitCode !== null) throw new Error('被测服务提前退出')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('被测服务未就绪')
}

async function api(page, method, apiPath, { token, body, headers = {}, raw = false } = {}) {
  const res = await page.evaluate(async ({ method, apiPath, token, body, headers }) => {
    const r = await fetch(apiPath, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch (_) { /* 非 JSON */ }
    return { status: r.status, body: json, text }
  }, { method, apiPath, token, body, headers })
  if (raw) return res
  if (res.status >= 400) throw new Error(`${method} ${apiPath} -> ${res.status} ${res.text.slice(0, 160)}`)
  return res.body
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.list)) return payload.list
  if (payload && payload.data && Array.isArray(payload.data.list)) return payload.data.list
  return []
}

async function login(page, baseUrl, username, password) {
  await page.goto(baseUrl + '/login', { waitUntil: 'networkidle' })
  await page.getByPlaceholder('用户名').fill(username)
  await page.getByPlaceholder('密码').fill(password)
  await page.locator('.login-btn').click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15000 })
}

(async () => {
  const { chromium } = loadPlaywright()
  const repoRoot = path.resolve(__dirname, '..')
  const base = process.env.BASE_URL || ''
  let child = null
  let tempDir = ''
  const screenshotDir = process.env.E2E_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hq-journeys-'))
  fs.mkdirSync(screenshotDir, { recursive: true })

  if (!base) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-journeys-'))
    const port = 38000 + Math.floor(Math.random() * 1000)
    process.env.BASE_URL = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: path.join(tempDir, 'app.db'),
        INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
        DISABLE_PUSH: '1',
        MACHINE_API_KEY: MACHINE_KEY
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk))
  }
  const baseUrl = process.env.BASE_URL
  await waitForServer(baseUrl, child)

  const browser = await chromium.launch()
  const watch = (page, label) => {
    page.on('console', msg => {
      const text = msg.text()
      if (msg.type() === 'error') problems.push(`${label} console.error: ${text}`)
      if (text.includes('Failed to resolve component')) problems.push(`${label} warn: ${text}`)
    })
    page.on('pageerror', err => problems.push(`${label} pageerror: ${err.message}`))
    page.on('requestfailed', req => problems.push(`${label} requestfailed: ${req.url()} ${req.failure()?.errorText}`))
  }
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(screenshotDir, name), fullPage: false }).catch(() => {})
  }

  const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageAdmin = await ctxAdmin.newPage()
  watch(pageAdmin, 'admin')
  await pageAdmin.goto(baseUrl + '/login', { waitUntil: 'networkidle' })
  const adminLogin = await pageAdmin.evaluate(async ({ baseUrl, ADMIN_PASSWORD }) => {
    const r = await fetch(baseUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    })
    return r.json()
  }, { baseUrl, ADMIN_PASSWORD })
  if (!adminLogin.token) throw new Error('admin 登录失败')
  const adminToken = adminLogin.token

  // ---------- 筹备：取件员 / 客服账号 / 区域 / 客户 ----------
  const couriers = asArray(await api(pageAdmin, 'GET', baseUrl + '/api/couriers', { token: adminToken }))
  let courier = couriers.find(c => c.name === '测试取件员A')
  if (!courier) {
    courier = await api(pageAdmin, 'POST', baseUrl + '/api/couriers', { token: adminToken, body: { name: '测试取件员A', region: '江东', commissionRate: 0.8 } })
  }
  const csUsername = 'csjourney' + Math.floor(Date.now() / 1000) % 100000
  const workerUsername = 'wjourney' + Math.floor(Date.now() / 1000) % 100000
  const users = asArray(await api(pageAdmin, 'GET', baseUrl + '/api/users', { token: adminToken }))
  const csName = '客服测试A'
  const workerName = '取件员测试A'
  let csUser = users.find(u => u.name === csName && u.role === 'cs')
  if (!csUser) csUser = await api(pageAdmin, 'POST', baseUrl + '/api/users', { token: adminToken, body: { username: csUsername, password: CS_PASSWORD, role: 'cs', name: csName } })
  let workerUser = users.find(u => u.name === workerName && u.role === 'courier')
  if (!workerUser) workerUser = await api(pageAdmin, 'POST', baseUrl + '/api/users', { token: adminToken, body: { username: workerUsername, password: WORKER_PASSWORD, role: 'courier', courierId: courier.id, name: workerName } })
  let area = asArray(await api(pageAdmin, 'GET', baseUrl + '/api/areas', { token: adminToken })).find(a => a.name === '江东A区')
  if (!area) area = await api(pageAdmin, 'POST', baseUrl + '/api/areas', { token: adminToken, body: { name: '江东A区', code: 'JD', defaultWorkerId: courier.id } })
  let customer = asArray(await api(pageAdmin, 'GET', baseUrl + '/api/customers?search=' + encodeURIComponent('星河科技'), { token: adminToken })).find(c => c.name === '星河科技')
  if (!customer) customer = await api(pageAdmin, 'POST', baseUrl + '/api/customers', { token: adminToken, body: { name: '星河科技', address: '义乌市江东街道创新路1号' } })
  const customerDetail = await api(pageAdmin, 'GET', baseUrl + '/api/customers/' + customer.id, { token: adminToken })
  const firstAddress = customerDetail.addresses && customerDetail.addresses[0]
  if (firstAddress && firstAddress.areaId !== area.id) {
    await api(pageAdmin, 'PUT', baseUrl + '/api/addresses/' + firstAddress.id, { token: adminToken, body: { areaId: area.id } })
  }
  steps.push('seed: courier/area/customer/users ready')

  // ---------- 客服 UI 派单 ----------
  const ctxCs = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageCs = await ctxCs.newPage()
  watch(pageCs, 'cs')
  await login(pageCs, baseUrl, csUser.username, CS_PASSWORD)
  steps.push('cs login -> ' + pageCs.url())
  await pageCs.goto(baseUrl + '/dispatch', { waitUntil: 'networkidle' })
  const customerSelect = pageCs.locator('.dispatch-form .el-select').first()
  await customerSelect.click()
  const customerOption = pageCs.locator('.el-select-dropdown__item:visible', { hasText: '星河科技' }).first()
  await customerOption.waitFor({ state: 'visible', timeout: 5000 })
  await customerOption.click()
  await pageCs.waitForTimeout(500)
  const formText = await pageCs.locator('.dispatch-form').innerText()
  if (!formText.includes('创新路1号')) problems.push('派单页未自动带出客户地址')
  await pageCs.locator('.dispatch-form button', { hasText: '确认派单' }).click()
  await pageCs.waitForURL(url => /\/tasks\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 15000 })
  const taskDetailUrl = pageCs.url()
  const taskId = taskDetailUrl.split('/').pop()
  steps.push('dispatch -> ' + taskDetailUrl)
  await pageCs.waitForTimeout(800)
  const taskText = await pageCs.locator('body').innerText()
  if (!taskText.includes('星河科技')) problems.push('任务详情页未显示客户名')
  await shot(pageCs, '01-dispatch-task-detail.png')

  // ---------- 取件员移动端闭环 ----------
  const ctxWorker = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const pageWorker = await ctxWorker.newPage()
  watch(pageWorker, 'worker')
  await login(pageWorker, baseUrl, workerUser.username, WORKER_PASSWORD)
  await pageWorker.goto(baseUrl + '/worker/tasks', { waitUntil: 'networkidle' })
  const workerListText = await pageWorker.locator('body').innerText()
  if (!workerListText.includes('星河科技')) problems.push('取件员任务列表未显示新任务')
  steps.push('worker sees task in list')
  await shot(pageWorker, '02-worker-task-list.png')

  await pageWorker.goto(baseUrl + '/tasks/' + taskId, { waitUntil: 'networkidle' })
  const startBtn = pageWorker.locator('button', { hasText: '开始取件' }).first()
  await startBtn.waitFor({ state: 'visible', timeout: 8000 })
  await startBtn.click()
  await pageWorker.getByText('已开始取件', { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  await pageWorker.waitForTimeout(600)
  steps.push('worker started task')

  const pngPath = path.join(screenshotDir, 'pickup-photo.png')
  fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  await pageWorker.locator('button', { hasText: '拍照留底' }).first().click()
  await pageWorker.locator('.el-dialog input[type=file]').first().waitFor({ state: 'attached', timeout: 8000 })
  await pageWorker.locator('.el-dialog input[type=file]').first().setInputFiles(pngPath)
  await pageWorker.getByText('照片已上传', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  await pageWorker.waitForTimeout(800)
  // 上传弹窗支持连续拍照，需手动关闭后继续
  const closeBtn = pageWorker.locator('.el-dialog__headerbtn').first()
  if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click()
  await pageWorker.waitForTimeout(400)
  steps.push('worker uploaded photo')

  await pageWorker.locator('button', { hasText: '完成取件' }).first().click()
  await pageWorker.locator('.el-message-box').waitFor({ state: 'visible', timeout: 5000 })
  await pageWorker.locator('.el-message-box button.el-button--primary').click()
  await pageWorker.getByText('该任务已完成取件', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(async () => {
    const body = await pageWorker.locator('body').innerText()
    if (!body.includes('已完成')) problems.push('完成取件后未显示已完成状态')
  })
  steps.push('worker completed task')
  await shot(pageWorker, '03-worker-completed.png')

  // ---------- 客服站内通知：完成事件 + 全部已读 ----------
  const csUnread = await api(pageCs, 'GET', baseUrl + '/api/notifications/unread-count', { token: await pageCs.evaluate(() => localStorage.getItem('token')) })
  if (!(Number(csUnread) >= 1)) problems.push('客服未收到任务完成站内通知')
  await pageCs.goto(baseUrl + '/notifications', { waitUntil: 'networkidle' })
  await pageCs.waitForTimeout(600)
  const notifBody = await pageCs.locator('body').innerText()
  if (!/完成|取件/.test(notifBody)) problems.push('通知中心未展示任务通知')
  await shot(pageCs, '04-cs-notifications.png')
  const readAllBtn = pageCs.locator('button', { hasText: '全部已读' }).first()
  if (await readAllBtn.isEnabled()) {
    await readAllBtn.click()
    await pageCs.waitForTimeout(800)
    const after = await api(pageCs, 'GET', baseUrl + '/api/notifications/unread-count', { token: await pageCs.evaluate(() => localStorage.getItem('token')) })
    if (Number(after) !== 0) problems.push(`全部已读后未读数=${after}，应为 0`)
    steps.push('cs read-all ok')
  } else {
    problems.push('全部已读按钮不可用（存在未读通知时）')
  }

  // ---------- 重量匹配中心闭环（过机 → 补票号 → 最终重量） ----------
  const csToken = await pageCs.evaluate(() => localStorage.getItem('token'))
  const matchTask = await api(pageCs, 'POST', baseUrl + '/api/tasks', {
    token: csToken,
    body: { customerId: customer.id, addressId: firstAddress ? firstAddress.id : undefined, address: '义乌市江东街道创新路1号', defaultWorkerId: courier.id, items: [{ waybillNo: 'WB-E2E-UI-1', pieces: 2, goodsName: '匹配件' }] }
  })
  // 过机设备按 trackingNo 找单，先落一条旧域记录承载重量
  await api(pageCs, 'POST', baseUrl + '/api/records', {
    token: csToken,
    body: { date: '2026-09-05', customer: '星河科技', customerId: customer.id, pieces: 2, address: '义乌市江东街道创新路1号', trackingNo: 'WB-E2E-UI-1', weight: 0, goods: '匹配件' }
  })
  const weigh = await api(pageCs, 'POST', baseUrl + '/api/machine/weigh', {
    raw: true,
    headers: { 'x-machine-key': MACHINE_KEY },
    body: { trackingNo: 'WB-E2E-UI-1', weight: 23.4 }
  })
  if (weigh.status !== 200) problems.push(`过机接口返回 ${weigh.status}`)
  await pageCs.goto(baseUrl + '/match-center', { waitUntil: 'networkidle' })
  await pageCs.waitForTimeout(600)
  const matchRow = pageCs.locator('.el-table__row', { hasText: 'WB-E2E-UI-1' }).first()
  if (await matchRow.count()) {
    await matchRow.locator('button', { hasText: '补票号' }).click()
    await pageCs.locator('.el-dialog', { hasText: '补票号' }).waitFor({ state: 'visible', timeout: 5000 })
    const input = pageCs.locator('.el-dialog input').first()
    await input.fill('WB-E2E-UI-1')
    const toastPromise = pageCs.evaluate(() => new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const message = document.querySelector('.el-message--success')
        if (message) { observer.disconnect(); resolve(message.textContent || '') }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => { observer.disconnect(); resolve('') }, 8000)
    }))
    await pageCs.locator('.el-dialog button.el-button--primary', { hasText: '确认' }).click()
    const toastText = await toastPromise
    if (!toastText.includes('已匹配') || !toastText.includes('23.4')) problems.push(`匹配成功提示异常：${toastText || '（未出现）'}`)
    steps.push('match-center confirmed final weight')
  } else {
    problems.push('待匹配中心未显示 WB-E2E-UI-1 明细')
  }
  await shot(pageCs, '05-match-center.png')
  const matchDetail = await api(pageCs, 'GET', baseUrl + '/api/tasks/' + matchTask.id, { token: csToken })
  const matchedItem = matchDetail.items.find(row => row.waybillNo === 'WB-E2E-UI-1')
  if (!matchedItem || matchedItem.matchStatus !== 'matched' || Number(matchedItem.finalWeight) !== 23.4) {
    problems.push(`明细未匹配成功 finalWeight=${matchedItem && matchedItem.finalWeight} status=${matchedItem && matchedItem.matchStatus}`)
  }

  // ---------- 权限守卫：越级路由被弹回 + 未登录拦截 ----------
  await pageWorker.goto(baseUrl + '/employees', { waitUntil: 'networkidle' })
  await pageWorker.waitForTimeout(800)
  if (pageWorker.url().includes('/employees')) problems.push('取件员可访问 /employees（越权）')
  await pageCs.goto(baseUrl + '/areas', { waitUntil: 'networkidle' })
  await pageCs.waitForTimeout(800)
  if (pageCs.url().includes('/areas')) problems.push('客服可访问 /areas（越权）')
  const ctxAnon = await browser.newContext()
  const pageAnon = await ctxAnon.newPage()
  await pageAnon.goto(baseUrl + '/dashboard', { waitUntil: 'networkidle' })
  if (!pageAnon.url().endsWith('/login')) problems.push('未登录访问看板未被拦截')
  await pageAnon.goto(baseUrl + '/login', { waitUntil: 'networkidle' })
  await pageAnon.getByPlaceholder('用户名').fill('admin')
  await pageAnon.getByPlaceholder('密码').fill('wrong-password-1')
  await pageAnon.locator('.login-btn').click()
  await pageAnon.waitForTimeout(1200)
  if (!pageAnon.url().endsWith('/login')) problems.push('错误密码登录未停留在登录页')
  const loginBody = await pageAnon.locator('body').innerText()
  if (!/密码|用户名/.test(loginBody)) problems.push('错误密码未给出明确提示文案')
  steps.push('guard & error UX checked')
  await shot(pageAnon, '06-login-error.png')

  // ---------- 通知设置页渲染 ----------
  await pageCs.goto(baseUrl + '/notification-settings', { waitUntil: 'networkidle' })
  await pageCs.waitForTimeout(500)
  if ((await pageCs.locator('.el-switch').count()) < 1) problems.push('消息设置页未渲染任何开关')
  steps.push('notification-settings rendered')

  await browser.close()
  if (child) {
    child.kill()
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ])
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
  }
  console.log('SCREENSHOTS: ' + screenshotDir)
  console.log('STEPS:\n  ' + steps.join('\n  '))
  if (problems.length) {
    console.log('PROBLEMS:\n  ' + [...new Set(problems)].join('\n  '))
    process.exit(1)
  }
  console.log('journeys-e2e=ok')
})().catch(err => { console.error('JOURNEYS-FATAL', err); process.exit(2) })

// Huoqu · Web 浏览器端到端巡检（无需真实业务数据）
// 用法：
//   1) 自启动模式（推荐）：直接运行 node e2e/web.e2e.js
//      脚本会临时拉起 server.js（独立 DB + 初始密码 e2e-strong-password）
//   2) 复用已运行服务：BASE_URL=http://127.0.0.1:3999 node e2e/web.e2e.js
//      （需保证该服务已有 admin/e2e-strong-password 账号）
// Playwright 模块解析顺序：PLAYWRIGHT_MODULE 环境变量 -> 本地依赖 -> 容器 /pw
// 浏览器二进制路径通过 PLAYWRIGHT_BROWSERS_PATH 指定（见 docs/operations/e2e-web.md）
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

const problems = []
const checked = []

async function waitForServer(baseUrl, child) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(baseUrl + '/api/health')
      if (res.ok) return
    } catch (_) { /* 服务未就绪 */ }
    if (child && child.exitCode !== null) throw new Error('被测服务提前退出')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('被测服务 10 秒内未就绪')
}

async function seedData(page, token) {
  const seed = async (apiPath, body) => {
    const status = await page.evaluate(async ({ apiPath, body, token }) => {
      const res = await fetch('/api' + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      })
      return res.status
    }, { apiPath, body, token })
    if (status >= 400) throw new Error(`种子数据失败 ${apiPath} status=${status}`)
    return status
  }
  await seed('/customers', { name: 'E2E客户', phone: '13800000000', address: '义乌E2E地址' })
  const customerList = await page.evaluate(async (token) => {
    const res = await fetch('/api/customers?search=E2E%E5%AE%A2%E6%88%B7', {
      headers: { Authorization: 'Bearer ' + token }
    })
    return res.json()
  }, token)
  const customerRow = (Array.isArray(customerList) ? customerList : []).find((c) => c.name === 'E2E客户')
  const customerId = customerRow ? customerRow.id : ''
  if (customerId) {
    await seed('/tasks', {
      customerId, customerName: 'E2E客户', address: '义乌E2E地址', taskType: 'rush',
      items: [{ waybillNo: 'E2E-WB-1', pieces: 2, goodsName: '样品' }]
    })
  }
  const list = await page.evaluate(async (token) => {
    const res = await fetch('/api/v2/tasks?page=1&pageSize=5', {
      headers: { Authorization: 'Bearer ' + token }
    })
    return res.json()
  }, token)
  const taskId = list.data && list.data.items && list.data.items[0] ? list.data.items[0].id : ''
  return { taskId, customerId }
}

async function collectStyleFacts(page) {
  // 关键视觉回归：主题主色变量、主按钮实色、弹层/消息样式确实注入
  const facts = await page.evaluate(() => {
    const cssText = Array.from(document.styleSheets).reduce((acc, sheet) => {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText) acc += rule.cssText
          if (rule.cssRules) for (const r of rule.cssRules) if (r.cssText) acc += r.cssText
        }
      } catch (_) { /* 跨域/受限样式表跳过 */ }
      return acc
    }, '')
    const rootVar = getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary').trim()
    const probeButton = document.createElement('button')
    probeButton.className = 'el-button el-button--primary'
    probeButton.style.cssText = 'position:absolute;left:-9999px;top:0'
    document.body.appendChild(probeButton)
    const buttonBg = getComputedStyle(probeButton).backgroundColor
    probeButton.remove()
    const probeCard = document.createElement('div')
    probeCard.className = 'el-card'
    probeCard.style.cssText = 'position:absolute;left:-9999px;top:0'
    document.body.appendChild(probeCard)
    const cardRadius = getComputedStyle(probeCard).borderRadius
    probeCard.remove()
    return {
      rootVar,
      buttonBg,
      cardRadius,
      hasMessageCss: cssText.includes('.el-message{') || cssText.includes('.el-message '),
      hasMessageBoxCss: cssText.includes('.el-message-box'),
      hasOverlayCss: cssText.includes('.el-overlay{') || cssText.includes('.el-overlay ')
    }
  })
  if (facts.rootVar !== '#3370ff') problems.push(`主题主色变量异常: ${facts.rootVar}`)
  if (facts.buttonBg !== 'rgb(51, 112, 255)') problems.push(`主按钮背景异常: ${facts.buttonBg}`)
  if (!facts.hasMessageCss) problems.push('缺失 el-message 样式')
  if (!facts.hasMessageBoxCss) problems.push('缺失 el-message-box 样式（TaskDetail 弹窗）')
  if (!facts.hasOverlayCss) problems.push('缺失 el-overlay 样式')
  if (!facts.cardRadius) problems.push('卡片样式未生效')
  checked.push(`styles rootVar=${facts.rootVar} buttonBg=${facts.buttonBg} msgBox=${facts.hasMessageBoxCss} overlay=${facts.hasOverlayCss}`)
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..')
  const { chromium } = loadPlaywright()
  const base = process.env.BASE_URL || ''
  let child = null
  let tempDir = ''
  let screenshotDir = process.env.E2E_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-shots-'))

  if (!base) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-'))
    const port = 37000 + Math.floor(Math.random() * 1000)
    process.env.BASE_URL = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: path.join(tempDir, 'app.db'),
        INITIAL_ADMIN_PASSWORD: 'e2e-strong-password',
        DISABLE_PUSH: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk))
  }
  const baseUrl = process.env.BASE_URL
  await waitForServer(baseUrl, child)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', msg => {
    const text = msg.text()
    if (msg.type() === 'error') problems.push(`console.error: ${text}`)
    if (text.includes('Failed to resolve component')) problems.push(`warn: ${text}`)
  })
  page.on('pageerror', err => problems.push(`pageerror: ${err.message}`))
  page.on('requestfailed', req => problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`))

  const login = async () => {
    await page.goto(baseUrl + '/login', { waitUntil: 'networkidle' })
    await page.getByPlaceholder('用户名').fill('admin')
    await page.getByPlaceholder('密码').fill('e2e-strong-password')
    await page.locator('.login-btn').click()
    await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15000 })
  }

  await login()
  checked.push('login -> ' + page.url())

  const token = await page.evaluate(() => localStorage.getItem('token') || '')
  const seeded = await seedData(page, token)
  const taskId = seeded.taskId
  const customerId = seeded.customerId
  if (!taskId) problems.push('种子任务未创建，无法巡检任务详情页')
  checked.push('seeded taskId=' + (taskId || 'none') + ' customerId=' + (customerId || 'none'))

  // 看板：表格 + 图表模式
  await page.goto(baseUrl + '/dashboard', { waitUntil: 'networkidle' })
  const radio = page.locator('.el-radio-button', { hasText: '图表' })
  await radio.click()
  await page.waitForTimeout(1200)
  const canvasCount = await page.locator('canvas').count()
  if (canvasCount < 1) problems.push('图表模式未渲染 canvas')
  checked.push(`dashboard chart canvases=${canvasCount}`)
  await page.screenshot({ path: path.join(screenshotDir, 'dashboard-chart.png') })
  await collectStyleFacts(page)

  // 主要页面逐一巡检（校验无解析失败组件/无控制台错误）
  const routes = ['/customers', '/dispatch', '/tasks', '/match-center', '/areas', '/employees', '/logs',
    '/notifications', '/notification-settings', '/push-providers']
  for (const route of routes) {
    await page.goto(baseUrl + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    checked.push(route + ' title=' + (await page.title()))
  }
  if (taskId) {
    await page.goto(baseUrl + '/tasks/' + taskId, { waitUntil: 'networkidle' })
    checked.push('/tasks/:id title=' + (await page.title()))
    await collectStyleFacts(page)
  }
  if (customerId) {
    await page.goto(baseUrl + '/customers/' + customerId, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const detailText = await page.evaluate(() => document.body.innerText)
    if (!detailText.includes('取件订单')) problems.push('客户详情未渲染「取件订单」区块')
    if (!/已完成\s*0\s*\/\s*1/.test(detailText)) problems.push('客户详情订单进度文案缺失（应为 已完成 0 / 1）')
    checked.push('/customers/:id 取件订单区块渲染正常')
    await page.screenshot({ path: path.join(screenshotDir, 'customer-detail-orders.png') })
  }
  await page.goto(baseUrl + '/dashboard', { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(screenshotDir, 'dashboard-table.png') })
  await browser.close()

  if (child) {
    child.kill()
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ])
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (_) { /* 临时目录清理失败不阻塞 */ }
  }

  console.log('SCREENSHOTS: ' + screenshotDir)
  console.log('CHECKED:\n  ' + checked.join('\n  '))
  if (problems.length) {
    console.log('PROBLEMS:\n  ' + [...new Set(problems)].join('\n  '))
    process.exit(1)
  }
  console.log('e2e-web=ok')
})().catch(err => { console.error('E2E-FATAL', err); process.exit(2) })

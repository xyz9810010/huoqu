import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const etsRoot = path.join(root, 'entry', 'src', 'main', 'ets')
const pagesRoot = path.join(etsRoot, 'pages')
const checks = []
const add = (name, ok, detail) => checks.push({ name, ok, detail })
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(dir, entry.name)
  return entry.isDirectory() ? files(target) : [target]
})

const registryText = read('entry/src/main/resources/base/profile/main_pages.json')
const registry = JSON.parse(registryText).src
const sources = files(etsRoot).filter((f) => f.endsWith('.ets'))
const allSource = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

const routeTargets = [...allSource.matchAll(/url:\s*'pages\/([A-Za-z0-9]+)'/g)].map((m) => `pages/${m[1]}`)
const missingRoutes = [...new Set(routeTargets.filter((route) => !registry.includes(route)))]
add('路由目标均已注册', missingRoutes.length === 0, missingRoutes.join(', ') || `${routeTargets.length} 次跳转有效`)

const badTextFiles = sources.filter((f) => /锟斤拷|璇锋|鍖哄|娑堟|閫氱|�/.test(fs.readFileSync(f, 'utf8')))
add('UTF-8 中文无乱码', badTextFiles.length === 0, badTextFiles.map((f) => path.relative(root, f)).join(', ') || '未发现乱码')

const legacyColorFiles = sources.filter((f) => /#409EFF/i.test(fs.readFileSync(f, 'utf8')))
add('无遗留主题色', legacyColorFiles.length === 0, legacyColorFiles.length ? `${legacyColorFiles.length} 个文件` : '通过')

const duplicateHeaders = fs.readdirSync(pagesRoot).filter((name) => name.endsWith('.ets')).filter((name) => {
  const source = fs.readFileSync(path.join(pagesRoot, name), 'utf8')
  return source.includes('MobileHeader') && source.includes("Button('返回')")
})
add('页面不存在重复顶栏', duplicateHeaders.length === 0, duplicateHeaders.join(', ') || '通过')

const iconSource = read('entry/src/main/ets/components/AppIcon.ets')
add('生产图标使用矢量资源', !iconSource.includes('symbol(): string'), iconSource.includes('symbol(): string') ? '当前使用文本符号模拟图标' : '通过')

const notifications = read('entry/src/main/ets/pages/NotificationsPage.ets')
add('通知深链兼容服务端 resourceId/route', notifications.includes("data['resourceId']") || notifications.includes("data['route']"), '服务端通知数据使用 resourceId 与 route')

const entry = read('entry/src/main/ets/entryability/EntryAbility.ets')
const login = read('entry/src/main/ets/pages/LoginPage.ets')
add('冷启动恢复已登录会话', !entry.includes("loadContent('pages/LoginPage'") || login.includes('SessionStore.isLoggedIn()'), '当前总是加载登录页，登录页未恢复会话')

const myData = read('entry/src/main/ets/pages/MyDataPage.ets')
add('我的数据契约与网页一致', myData.includes('today') && myData.includes('month') && myData.includes('assistCount'), '参考页需要今日、本月、协助次数三组数据')

const taskDetail = read('entry/src/main/ets/pages/TaskDetailPage.ets')
add('Photo upload offers camera and gallery', taskDetail.includes('cameraPicker.pick') && taskDetail.includes('PickerMediaType.PHOTO') && taskDetail.includes('PhotoViewPicker') && taskDetail.includes('相机拍照') && taskDetail.includes('本地图片'), 'Upload must offer both the system camera and local image picker')

const uiUtil = read('entry/src/main/ets/common/UiUtil.ets')
add('Dial uses native telephony service', uiUtil.includes('call.makeCall('), 'Dial must not rely on an unresolved custom Want')
add('Navigation uses native map service', uiUtil.includes('petalMaps.openMapTextSearch(') && !uiUtil.includes('https://uri.amap.com'), 'Navigation must not open an Amap web page')

const roleGuardPages = ['DashboardPage.ets', 'AreasPage.ets', 'EmployeesPage.ets', 'LogsPage.ets']
const weakGuards = roleGuardPages.filter((name) => {
  const source = fs.readFileSync(path.join(pagesRoot, name), 'utf8')
  return !source.includes('SessionStore.role()') && !source.includes('normalizeRole(SessionStore.role())')
})
add('角色敏感页面具备直接访问守卫', weakGuards.length === 0, weakGuards.join(', ') || '通过')

const emptyCatches = [...allSource.matchAll(/catch\s*\([^)]*\)\s*\{\s*\}/g)].length
add('API 错误均有用户反馈或记录', emptyCatches === 0, `${emptyCatches} 个空 catch`)

const testDirs = ['entry/src/test', 'entry/src/ohosTest']
const testFileCount = testDirs.filter((p) => fs.existsSync(path.join(root, p))).flatMap((p) => files(path.join(root, p))).length
add('存在自动化单元/组件测试', testFileCount > 0, `${testFileCount} 个测试文件`)

for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} | ${check.name} | ${check.detail}`)
const failed = checks.filter((c) => !c.ok).length
console.log(`SUMMARY | ${checks.length - failed} passed, ${failed} failed, ${checks.length} total`)
process.exitCode = failed ? 1 : 0

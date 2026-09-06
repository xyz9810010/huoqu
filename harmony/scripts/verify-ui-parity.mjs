import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const etsRoot = path.join(root, 'entry', 'src', 'main', 'ets')
const pagesRoot = path.join(etsRoot, 'pages')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const expectedPages = [
  'LoginPage.ets', 'DashboardPage.ets', 'CustomersPage.ets', 'CustomerDetailPage.ets',
  'DispatchPage.ets', 'TasksPage.ets', 'TaskDetailPage.ets', 'MatchCenterPage.ets',
  'WorkerTabPage.ets', 'MyDataPage.ets', 'AreasPage.ets', 'EmployeesPage.ets',
  'LogsPage.ets', 'NotificationsPage.ets', 'NotificationSettingsPage.ets',
  'PushProvidersPage.ets',
]

for (const page of expectedPages) {
  assert(fs.existsSync(path.join(pagesRoot, page)), `Missing page: ${page}`)
}

const theme = read('entry/src/main/ets/common/Theme.ets')
for (const token of ['#3370FF', '#F0F2F5', '#F7F8FA', '#E7E9EE', '#2A2F36', '#5A6068', '#9198A1']) {
  assert(theme.includes(token), `Theme is missing ${token}`)
}

const shell = read('entry/src/main/ets/components/AppShell.ets')
for (const token of ['AppTheme.DRAWER_WIDTH', 'AppTheme.HEADER_HEIGHT', '通知中心', '退出登录', 'pages/PushProvidersPage']) {
  assert(shell.includes(token), `App shell is missing ${token}`)
}

const sourceFiles = walk(etsRoot).filter((file) => file.endsWith('.ets'))
const forbidden = /#409EFF|#409eff|☰|🔔|📦|📊|🚪/
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8')
  assert(!forbidden.test(source), `Legacy color or emoji icon remains in ${path.relative(root, file)}`)
}

const pageRegistry = read('entry/src/main/resources/base/profile/main_pages.json')
assert(pageRegistry.includes('pages/PushProvidersPage'), 'PushProvidersPage is not registered')

const shellPages = [
  'DashboardPage.ets', 'CustomersPage.ets', 'DispatchPage.ets', 'TasksPage.ets',
  'MatchCenterPage.ets', 'WorkerTabPage.ets', 'MyDataPage.ets', 'AreasPage.ets',
  'EmployeesPage.ets', 'LogsPage.ets', 'NotificationsPage.ets',
  'NotificationSettingsPage.ets', 'PushProvidersPage.ets',
]
for (const page of shellPages) {
  const source = fs.readFileSync(path.join(pagesRoot, page), 'utf8')
  assert(source.includes('MobileHeader'), `${page} does not use the shared mobile header`)
  assert(source.includes('MobileDrawer'), `${page} does not use the shared mobile drawer`)
}

const interactionChecks = {
  'CustomersPage.ets': ['新增客户', '派单', '详情'],
  'AreasPage.ets': ['新增区域', '编辑区域', '设置取件员', 'defaultWorkerIds', 'backupWorkerIds'],
  'EmployeesPage.ets': ['新增员工', '编辑员工', 'toggleStatus', '角色'],
  'DispatchPage.ets': ['customerId', 'preselectCustomer', '赶出货', '指定时间'],
  'NotificationsPage.ets': ['未读', '全部已读', '消息设置', 'TaskDetailPage'],
  'NotificationSettingsPage.ets': ['新任务与改派', '任务状态变化', '超时与紧急任务', '异常处理', '已登记设备'],
  'PushProvidersPage.ets': ['保存配置', '连接测试', '启用'],
}
for (const [page, tokens] of Object.entries(interactionChecks)) {
  const source = fs.readFileSync(path.join(pagesRoot, page), 'utf8')
  for (const token of tokens) assert(source.includes(token), `${page} is missing interaction: ${token}`)
}

console.log(`UI parity static checks passed (${expectedPages.length} pages, ${sourceFiles.length} ArkTS files).`)

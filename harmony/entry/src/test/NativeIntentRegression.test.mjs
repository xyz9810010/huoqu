import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const taskDetail = read('entry/src/main/ets/pages/TaskDetailPage.ets')
assert.match(taskDetail, /cameraPicker\.pick\(/)
assert.match(taskDetail, /PickerMediaType\.PHOTO/)
assert.match(taskDetail, /requestPermissionsFromUser\(/)
assert.doesNotMatch(taskDetail, /new cameraPicker\.PickerProfile\(\)/)
assert.match(taskDetail, /PhotoViewPicker/)
assert.match(taskDetail, /showActionSheet\(/)
assert.match(taskDetail, /相机拍照/)
assert.match(taskDetail, /本地图片/)

const uiUtil = read('entry/src/main/ets/common/UiUtil.ets')
assert.match(uiUtil, /call\.makeCall\(context, phone\)/)
assert.match(uiUtil, /showActionSheet\(/)
assert.match(uiUtil, /高德地图/)
assert.match(uiUtil, /Petal Maps/)
assert.match(uiUtil, /amap_icon/)
assert.match(uiUtil, /petal_maps_icon/)
assert.match(uiUtil, /amapuri:\/\/route\/plan/)
assert.match(uiUtil, /petalMaps\.openMapTextSearch\(context/)
assert.doesNotMatch(uiUtil, /https:\/\/uri\.amap\.com/)

const entryAbility = read('entry/src/main/ets/entryability/EntryAbility.ets')
assert.match(entryAbility, /SessionStore\.isLoggedIn\(\)/)
assert.match(entryAbility, /homePageForRole\(SessionStore\.role\(\)\)/)
assert.match(entryAbility, /SseClient\.get\(\)\.start\(\)/)
assert.match(entryAbility, /NotificationService\.requestPermission\(\)/)
assert.match(entryAbility, /PushService\.register\(\)/)

const notificationService = read('entry/src/main/ets/service/NotificationService.ets')
assert.match(notificationService, /notificationManager\.addSlot\(/)
assert.match(notificationService, /Date\.now\(\)/)
assert.match(notificationService, /openNotificationSettings\(/)
assert.match(notificationService, /notificationContentType:\s*notificationManager\.ContentType\.NOTIFICATION_CONTENT_BASIC_TEXT/)

const drawer = read('entry/src/main/ets/components/AppShell.ets')
assert.match(drawer, /MenuSectionTitle/)
assert.match(drawer, /SessionStore\.getUser\(\)/)

const notificationSettings = read('entry/src/main/ets/pages/NotificationSettingsPage.ets')
assert.match(notificationSettings, /pickupTask\.assistInvited/)

assert.match(taskDetail, /协助取件/)

const dispatch = read('entry/src/main/ets/pages/DispatchPage.ets')
assert.match(dispatch, /if \(this\.submitting\) return/)

const workerTab = read('entry/src/main/ets/pages/WorkerTabPage.ets')
assert.match(workerTab, /await TaskApi\.start\(t\.id\)/)
assert.match(workerTab, /RefreshIconButton/)

const moduleConfig = read('entry/src/main/module.json5')
assert.match(moduleConfig, /2018153252817773568/)
const pushService = read('entry/src/main/ets/service/PushService.ets')
assert.match(pushService, /CargoPush/)
assert.match(pushService, /hilog\.info/)
assert.match(pushService, /hilog\.error/)

const notifications = read('entry/src/main/ets/pages/NotificationsPage.ets')
assert.match(notifications, /data\['resourceId'\]/)
assert.match(notifications, /data\['route'\]/)

console.log('Native intent and navigation regressions: PASS')

import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { SessionStore } from '../store/SessionStore';
import { NotificationApi } from '../api/NotificationApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { NotificationPreference, NotificationPreferenceRequest, NotificationSubscription } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { LoadingState, EmptyState, StatusPill, MobileField } from '../components/PageComponents';
import { NotificationService } from '../service/NotificationService';

interface PreferenceRow { type: string; label: string; description: string; enabled: boolean; }

@Entry
@Component
struct NotificationSettingsPage {
  @State menuOpen: boolean = false;
  @State loading: boolean = false;
  @State systemEnabled: boolean = false;
  @State soundEnabled: boolean = false;
  @State vibrationEnabled: boolean = false;
  @State devices: NotificationSubscription[] = [];
  @State rows: PreferenceRow[] = [
    { type: 'pickupTask.assigned', label: '新任务与改派', description: '有新的取件任务分配给我时提醒', enabled: true },
    { type: 'pickupTask.assistInvited', label: '协助取件邀请', description: '被邀请协助取件任务时提醒', enabled: true },
    { type: 'pickupTask.statusChanged', label: '任务状态变化', description: '任务开始、完成或取消时提醒', enabled: true },
    { type: 'pickupTask.overdue', label: '超时与紧急任务', description: '临近赶货时间或任务超时时提醒', enabled: true },
    { type: 'pickupTask.exception', label: '异常处理', description: '出现异常或处理完成时提醒', enabled: true }
  ];

  aboutToAppear(): void { if (!SessionStore.isLoggedIn()) { router.replaceUrl({ url: 'pages/LoginPage' }); return; } this.load(); }
  async load(): Promise<void> {
    this.loading = true;
    try {
      const status = await NotificationService.getStatus();
      this.systemEnabled = status.enabled;
      this.soundEnabled = status.soundEnabled;
      this.vibrationEnabled = status.vibrationEnabled;
    } catch (e) {
      this.systemEnabled = false;
    }
    try {
      const preferences = await NotificationApi.preferences(); this.devices = await NotificationApi.subscriptions();
      const updated = this.rows.slice();
      for (let i = 0; i < updated.length; i++) for (let j = 0; j < preferences.length; j++) if (preferences[j].type === updated[i].type && (preferences[j].channel === 'vendor_push' || preferences[j].channel === 'web_push')) updated[i].enabled = preferences[j].enabled;
      this.rows = updated;
    } catch (e) { UiUtil.toast((e as ApiError).message); }
    finally { this.loading = false; }
  }

  testNotification(): void {
    if (!this.systemEnabled) {
      UiUtil.toast('请先开启系统通知权限');
      NotificationService.openNotificationSettings(getContext(this) as common.UIAbilityContext);
      return;
    }
    NotificationService.show('Huoqu 测试通知', '通知与声音链路工作正常', '');
    UiUtil.toast('测试通知已发送，请查看通知栏');
  }

  async setPreference(index: number, enabled: boolean): Promise<void> {
    const copy = this.rows.slice(); copy[index].enabled = enabled; this.rows = copy;
    const body: NotificationPreferenceRequest = { type: copy[index].type, channel: 'vendor_push', enabled: enabled };
    try { await NotificationApi.savePreference(body); }
    catch (e) { copy[index].enabled = !enabled; this.rows = copy; UiUtil.toast((e as ApiError).message); }
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '消息设置', unreadCount: 0 })
        Scroll() { Column({ space: 12 }) {
          Column({ space: 5 }) { Text('消息设置').fontSize(20).fontWeight(FontWeight.Bold).width('100%'); Text('管理当前设备、接收方式和不同业务消息的提醒偏好。').fontSize(13).fontColor('#86909C').width('100%') }.alignItems(HorizontalAlign.Start)
          Column({ space: 12 }) {
            Row({ space: 12 }) {
              Text('通').fontSize(20).fontColor('#0A59F7').width(42).height(42).textAlign(TextAlign.Center).backgroundColor('#E8F3FF').borderRadius(10)
              Column({ space: 4 }) {
                Text('HarmonyOS 系统通知').fontSize(16).fontWeight(FontWeight.Bold)
                Text('应用切换到后台后仍可接收任务和异常提醒。').fontSize(12).fontColor('#86909C')
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            }.width('100%')
            Row({ space: 10 }) {
              Circle().width(9).height(9).fill(this.systemEnabled ? '#00B42A' : '#F53F3F')
              Column({ space: 4 }) {
                Text(this.systemEnabled ? '系统通知已开启' : '系统通知未开启').fontSize(14).fontWeight(FontWeight.Medium)
                Text(this.systemEnabled
                  ? ('声音' + (this.soundEnabled ? '已开启' : '未开启') + ' · 振动' + (this.vibrationEnabled ? '已开启' : '未开启'))
                  : '当前收不到通知，请进入系统设置开启。')
                  .fontSize(12).fontColor(this.systemEnabled ? '#86909C' : '#F53F3F')
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            }.width('100%').padding(14).backgroundColor('#F7F8FA').border({ width: 1, color: '#E5E6EB' }).borderRadius(8)
            Row({ space: 8 }) {
              Button('系统通知设置').layoutWeight(1).height(42).fontColor('#0A59F7').backgroundColor('#E8F3FF')
                .onClick(() => { NotificationService.openNotificationSettings(getContext(this) as common.UIAbilityContext); })
              Button('测试通知和声音').layoutWeight(1).height(42).backgroundColor('#0A59F7')
                .onClick(() => { this.testNotification(); })
            }.width('100%')
          }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).border({ width: 1, color: '#E5E6EB' })
          Column() { Row({ space: 12 }) { Text('设').fontSize(20).fontColor('#00B42A').width(42).height(42).textAlign(TextAlign.Center).backgroundColor('#E8FFEA').borderRadius(10); Column({ space: 4 }) { Text('接收偏好').fontSize(16).fontWeight(FontWeight.Bold); Text('站内通知始终保留，可单独控制系统提醒。').fontSize(12).fontColor('#86909C') }.layoutWeight(1).alignItems(HorizontalAlign.Start) }.width('100%').margin({ bottom: 8 }); ForEach(this.rows, (item: PreferenceRow, index: number) => { Row({ space: 12 }) { Column({ space: 4 }) { Text(item.label).fontSize(14).fontWeight(FontWeight.Medium); Text(item.description).fontSize(12).fontColor('#86909C') }.layoutWeight(1).alignItems(HorizontalAlign.Start); Toggle({ type: ToggleType.Switch, isOn: item.enabled }).selectedColor('#0A59F7').onChange((value: boolean) => { this.setPreference(index, value); }) }.width('100%').padding({ top: 13, bottom: 13 }).border({ width: { bottom: 1 }, color: '#E5E6EB' }) }, (item: PreferenceRow) => item.type) }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).border({ width: 1, color: '#E5E6EB' })
          Column() {
            Row() { Text('已登记设备').fontSize(16).fontWeight(FontWeight.Bold).layoutWeight(1); Button('刷新').fontSize(13).fontColor('#0A59F7').backgroundColor(Color.Transparent).onClick(() => { this.load(); }) }.width('100%').margin({ bottom: 8 })
            if (this.loading) {
              LoadingState({ label: '正在加载设备' })
            } else if (this.devices.length === 0) {
              EmptyState({ title: '暂无已登记的推送设备' })
            } else {
              ForEach(this.devices, (device: NotificationSubscription) => { Column() { Row() { Column({ space: 3 }) { Text(device.deviceLabel === '' ? '未命名设备' : device.deviceLabel).fontSize(15).fontWeight(FontWeight.Bold); Text(device.platform === '' ? device.providerCode : device.platform).fontSize(12).fontColor('#86909C') }.layoutWeight(1).alignItems(HorizontalAlign.Start); StatusPill({ label: device.status === 'active' ? '正常' : '已失效', color: device.status === 'active' ? '#00B42A' : '#86909C', fillColor: device.status === 'active' ? '#E8FFEA' : '#F2F3F5' }) }.width('100%'); MobileField({ label: '通道', value: device.channel === 'web_push' ? '浏览器通知' : device.providerCode }); MobileField({ label: '登记时间', value: device.createdAt.replace('T', ' ').slice(0, 16) }) }.width('100%').padding({ top: 12, bottom: 12 }).border({ width: { bottom: 1 }, color: '#E5E6EB' }) }, (device: NotificationSubscription) => device.id)
            }
          }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).border({ width: 1, color: '#E5E6EB' })
          Button('返回通知中心').width('100%').height(44).fontColor('#4E5969').backgroundColor('#FFFFFF').border({ width: 1, color: '#C9CDD4' }).onClick(() => { router.pushUrl({ url: 'pages/NotificationsPage' }); })
        }.width('100%').padding(12) }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/NotificationSettingsPage' })
    }.width('100%').height('100%')
  }
}

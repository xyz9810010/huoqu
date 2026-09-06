import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { EventHub } from '../service/EventHub';
import { TaskApi } from '../api/TaskApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { PickupTask } from '../model/Models';
import { taskStatusLabel, fmtTime } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { BackToTop } from '../components/PageComponents';
import { NotificationBanner } from '../components/NotificationBanner';
import { NotificationApi } from '../api/NotificationApi';

@Entry
@Component
struct TasksPage {
  @State menuOpen: boolean = false;
  @State list: PickupTask[] = [];
  @State activeStatus: string = '';
  @State taskType: string = '';
  @State keyword: string = '';
  @State loading: boolean = false;
  @State showBackTop: boolean = false;
  @State unreadCount: number = 0;
  private scroller: Scroller = new Scroller();
  private statuses: string[] = ['', 'pending', 'in_progress', 'completed', 'cancelled'];
  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.load();
    this.loadUnread();
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      const taskId = EventHub.taskIdFromEvent(event);
      if (taskId !== '') {
        this.updateTaskById(taskId, String(event['type'] ?? ''));
      }
      if (EventHub.extractNotification(event) !== null) {
        this.loadUnread();
      }
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async loadUnread(): Promise<void> {
    this.unreadCount = await NotificationApi.unreadCount();
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const resp = await TaskApi.list(this.activeStatus, 0, 100, this.taskType, this.keyword.trim());
      this.list = resp.list;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  async updateTaskById(taskId: string, eventType: string): Promise<void> {
    try {
      const task = await TaskApi.detail(taskId);
      let found = false;
      const newArr: PickupTask[] = [];
      for (let i = 0; i < this.list.length; i++) {
        if (this.list[i].id === task.id) {
          newArr.push(task);
          found = true;
        } else {
          newArr.push(this.list[i]);
        }
      }
      if (!found && (eventType === 'task.created' || eventType === 'task.assigned') && this.activeStatus === task.status) {
        newArr.unshift(task);
      }
      this.list = newArr;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  statusLabel(status: string): string {
    if (status === '') {
      return '全部';
    }
    return taskStatusLabel(status);
  }

  tagColor(status: string): string {
    if (status === 'pending') {
      return '#FF7D00';
    }
    if (status === 'in_progress') {
      return '#0A59F7';
    }
    if (status === 'completed') {
      return '#00B42A';
    }
    return '#86909C';
  }

  taskTypeLabel(task: PickupTask): string {
    if (task.taskType === 'rush') return '赶 ' + fmtTime(task.rushShipTime) + ' 出货';
    if (task.taskType === 'scheduled') {
      let kind = '';
      if (task.scheduledKind === 'before') kind = '前';
      if (task.scheduledKind === 'after') kind = '后';
      if (task.scheduledKind === 'around') kind = '左右';
      return fmtTime(task.scheduledTime) + ' ' + kind;
    }
    return '普通任务';
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '取件任务', unreadCount: this.unreadCount })
      Row({ space: 6 }) {
        Text('取件任务')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
        Blank()
        Button('新建取件')
          .fontSize(13)
          .height(32)
          .onClick(() => { router.pushUrl({ url: 'pages/DispatchPage' }); })
        Button('通知')
          .fontSize(13)
          .height(32)
          .onClick(() => { router.pushUrl({ url: 'pages/NotificationsPage' }); })
        Button('设置')
          .fontSize(13)
          .height(32)
          .onClick(() => { router.pushUrl({ url: 'pages/SettingsPage' }); })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      Row({ space: 8 }) {
        ForEach(this.statuses, (s: string) => {
          Text(this.statusLabel(s))
            .fontSize(14)
            .fontColor(this.activeStatus === s ? '#0A59F7' : '#4E5969')
            .fontWeight(this.activeStatus === s ? FontWeight.Bold : FontWeight.Normal)
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .backgroundColor(this.activeStatus === s ? '#E8F3FF' : '#00000000')
            .borderRadius(16)
            .onClick(() => {
              this.activeStatus = s;
              this.load();
            })
        }, (s: string) => s)
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 8 })
      .justifyContent(FlexAlign.SpaceBetween)

      Row({ space: 8 }) {
        ForEach(['', 'normal', 'scheduled', 'rush'], (type: string) => {
          Text(type === '' ? '全部类型' : (type === 'normal' ? '普通' : (type === 'scheduled' ? '指定时间' : '赶出货')))
            .fontSize(12)
            .fontColor(this.taskType === type ? '#0A59F7' : '#4E5969')
            .padding({ left: 9, right: 9, top: 6, bottom: 6 })
            .backgroundColor(this.taskType === type ? '#E8F3FF' : '#FFFFFF')
            .border({ width: 1, color: this.taskType === type ? '#0A59F7' : '#E5E6EB' })
            .borderRadius(6)
            .onClick(() => { this.taskType = type; this.load(); })
        }, (type: string) => type)
      }
      .width('100%').padding({ left: 12, right: 12, bottom: 8 })

      Row({ space: 8 }) {
        TextInput({ placeholder: '任务号/客户', text: this.keyword })
          .layoutWeight(1).height(44).borderRadius(8)
          .onChange((value: string) => { this.keyword = value; })
          .onSubmit(() => { this.load(); })
        Button('查询').height(44).fontSize(13).backgroundColor('#0A59F7')
          .onClick(() => { this.load(); })
        Button('新建取件').height(44).fontSize(13).backgroundColor('#00B42A')
          .onClick(() => { router.pushUrl({ url: 'pages/DispatchPage' }); })
      }
      .width('100%').padding({ left: 12, right: 12, bottom: 10 })

      if (this.loading) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else if (this.list.length === 0) {
        Text('暂无任务')
          .fontSize(15)
          .fontColor('#86909C')
          .margin({ top: 60 })
      } else {
        List({ space: 10, scroller: this.scroller }) {
          ForEach(this.list, (t: PickupTask) => {
            ListItem() {
              Column() {
                Row() {
                  Text(t.customerName)
                    .fontSize(16)
                    .fontWeight(FontWeight.Medium)
                    .layoutWeight(1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(taskStatusLabel(t.status))
                    .fontSize(12)
                    .fontColor(this.tagColor(t.status))
                }
                .width('100%')
                Row() {
                  Text(t.taskNo)
                    .fontSize(12)
                    .fontColor('#86909C')
                  Blank()
                  Text(fmtTime(t.dispatchAt))
                    .fontSize(12)
                    .fontColor('#86909C')
                }
                .width('100%')
                .margin({ top: 6 })
                Text(this.taskTypeLabel(t))
                  .fontSize(12).fontColor(t.taskType === 'rush' ? '#F53F3F' : (t.taskType === 'scheduled' ? '#FF7D00' : '#86909C'))
                  .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                  .backgroundColor(t.taskType === 'rush' ? '#FFECE8' : (t.taskType === 'scheduled' ? '#FFF3E8' : '#F2F3F5'))
                  .borderRadius(4).margin({ top: 8 })
                Row() {
                  Text('取件地址').width(88).fontSize(13).fontColor('#86909C')
                  Text(t.addressPointName === '' ? (t.address === '' ? '—' : t.address) : t.addressPointName)
                    .layoutWeight(1).fontSize(13).fontColor('#182431').textAlign(TextAlign.End)
                }.width('100%').padding({ top: 6, bottom: 4 }).alignItems(VerticalAlign.Top)
                Row() {
                  Text('取件员').width(88).fontSize(13).fontColor('#86909C')
                  Text(t.defaultWorkerName === '' ? '未分配' : t.defaultWorkerName)
                    .layoutWeight(1).fontSize(13).fontColor('#182431').textAlign(TextAlign.End)
                }.width('100%').padding({ top: 4, bottom: 4 })
                Row() {
                  Text('主客服').width(88).fontSize(13).fontColor('#86909C')
                  Text(t.mainCsName === '' ? '—' : t.mainCsName)
                    .layoutWeight(1).fontSize(13).fontColor('#182431').textAlign(TextAlign.End)
                }.width('100%').padding({ top: 4, bottom: 4 })
                Row() {
                  Text('派单时间').width(88).fontSize(13).fontColor('#86909C')
                  Text(fmtTime(t.dispatchAt) === '' ? '—' : fmtTime(t.dispatchAt))
                    .layoutWeight(1).fontSize(13).fontColor('#182431').textAlign(TextAlign.End)
                }.width('100%').padding({ top: 4, bottom: 4 })
              }
              .width('100%')
              .padding(14)
              .backgroundColor('#FFFFFF')
              .borderRadius(14)
              .shadow({ radius: 8, color: '#0D1F2926', offsetY: 2 })
              .onClick(() => { router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: t.id } }); })
            }
          }, (t: PickupTask) => t.id)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 4, bottom: 12 })
        .onScroll((offset: number) => { this.showBackTop = offset > 500; })
      }
    }
      .width('100%')
      .height('100%')
      .backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/TasksPage' })
      NotificationBanner().position({ x: '4%', y: 62 }).zIndex(300)
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scroller.scrollToIndex(0);
        this.showBackTop = false;
      } })
        .position({ x: '86%', y: '82%' })
    }
    .width('100%').height('100%')
  }
}

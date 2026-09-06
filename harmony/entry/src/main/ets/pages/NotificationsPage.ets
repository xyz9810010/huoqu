import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { NotificationApi } from '../api/NotificationApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { AppNotification } from '../model/Models';
import { fmtTime } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { BackToTop } from '../components/PageComponents';
import { EventHub } from '../service/EventHub';

@Entry
@Component
struct NotificationsPage {
  @State menuOpen: boolean = false;
  @State list: AppNotification[] = [];
  @State loading: boolean = false;
  @State unreadOnly: boolean = false;
  @State markingAll: boolean = false;
  @State showBackTop: boolean = false;
  private scroller: Scroller = new Scroller();
  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.load();
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      if (EventHub.extractNotification(event) !== null || String(event['type'] ?? '') === 'sse_connected') {
        this.load();
      }
    });
  }

  onPageShow(): void {
    if (SessionStore.isLoggedIn()) this.load();
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      this.list = await NotificationApi.list();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  async markRead(n: AppNotification): Promise<void> {
    if (n.read) {
      return;
    }
    try {
      await NotificationApi.markRead(n.id);
      this.list = this.list.map((item: AppNotification): AppNotification => {
        return item.id === n.id ? this.asRead(item) : item;
      });
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async readAll(): Promise<void> {
    if (this.markingAll || this.loading || this.unreadCount() === 0) return;
    this.markingAll = true;
    try {
      await NotificationApi.readAll();
      this.list = this.list.map((item: AppNotification): AppNotification => {
        return this.asRead(item);
      });
      UiUtil.toast('已全部标记为已读');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.markingAll = false;
    }
  }

  asRead(item: AppNotification): AppNotification {
    return {
      id: item.id, type: item.type, title: item.title, body: item.body,
      data: item.data, priority: item.priority, read: true,
      readAt: item.readAt || new Date().toISOString(), createdAt: item.createdAt
    };
  }

  unreadCount(): number {
    let count = 0;
    for (let i = 0; i < this.list.length; i++) {
      if (!this.list[i].read) count++;
    }
    return count;
  }

  filtered(): AppNotification[] {
    if (!this.unreadOnly) return this.list;
    const result: AppNotification[] = [];
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].read) result.push(this.list[i]);
    return result;
  }

  openNotification(n: AppNotification): void {
    this.markRead(n);
    if (n.data === '') return;
    try {
      const data = JSON.parse(n.data) as Record<string, Object>;
      let taskId = data['taskId'] === undefined ? '' : String(data['taskId']);
      if (taskId === '' && data['resourceId'] !== undefined) {
        taskId = String(data['resourceId']);
      }
      if (taskId === '' && data['route'] !== undefined) {
        const route = String(data['route']);
        const marker = '/tasks/';
        const markerIndex = route.indexOf(marker);
        if (markerIndex >= 0) {
          taskId = route.substring(markerIndex + marker.length);
        }
      }
      if (taskId !== '') router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: taskId } });
    } catch (e) {
      UiUtil.toast('通知内容无法打开');
    }
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '通知中心', unreadCount: this.unreadCount() })
      Column({ space: 10 }) {
        Row() {
          Text('消息').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#182431')
          Blank()
        Button('消息设置')
          .fontSize(13).height(36).fontColor('#4E5969').backgroundColor('#FFFFFF')
          .onClick(() => { router.pushUrl({ url: 'pages/NotificationSettingsPage' }); })
        }.width('100%')
        Row({ space: 8 }) {
          Button('全部').fontSize(13).height(34)
            .fontColor(this.unreadOnly ? '#4E5969' : '#0A59F7')
            .backgroundColor(this.unreadOnly ? '#FFFFFF' : '#E8F3FF')
            .onClick(() => { this.unreadOnly = false; })
          Button('未读 ' + this.unreadCount()).fontSize(13).height(34)
            .fontColor(this.unreadOnly ? '#0A59F7' : '#4E5969')
            .backgroundColor(this.unreadOnly ? '#E8F3FF' : '#FFFFFF')
            .onClick(() => { this.unreadOnly = true; })
          Blank()
        Button(this.markingAll ? '处理中…' : '全部已读')
          .fontSize(13).height(34).fontColor('#0A59F7').backgroundColor(Color.Transparent)
          .enabled(!this.markingAll && !this.loading && this.unreadCount() > 0)
          .onClick(() => { this.readAll(); })
        }.width('100%')
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      if (this.loading) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else if (this.filtered().length === 0) {
        Text(this.unreadOnly ? '暂无未读消息' : '暂无通知')
          .fontSize(15)
          .fontColor('#86909C')
          .margin({ top: 60 })
      } else {
        List({ space: 10, scroller: this.scroller }) {
          ForEach(this.filtered(), (n: AppNotification) => {
            ListItem() {
              Column() {
                Row() {
                  Text(n.title)
                    .fontSize(15)
                    .fontWeight(n.read ? FontWeight.Normal : FontWeight.Bold)
                    .layoutWeight(1)
                  if (!n.read) {
                    Circle()
                      .width(8)
                      .height(8)
                      .fill('#F53F3F')
                  }
                }
                .width('100%')
                Text(n.body)
                  .fontSize(13)
                  .fontColor('#4E5969')
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 4 })
                Text(fmtTime(n.createdAt))
                  .fontSize(12)
                  .fontColor('#86909C')
                  .margin({ top: 4 })
              }
              .width('100%')
              .padding(14)
              .backgroundColor(n.read ? '#FFFFFF' : '#E8F3FF')
              .borderRadius(10)
              .onClick(() => { this.openNotification(n); })
            }
          }, (n: AppNotification) => n.id + ':' + String(n.read))
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
      MobileDrawer({ open: $menuOpen, activePath: 'pages/NotificationsPage' })
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scroller.scrollToIndex(0);
        this.showBackTop = false;
      } })
        .position({ x: '86%', y: '82%' })
    }
    .width('100%').height('100%')
  }
}

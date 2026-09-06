import { router } from '@kit.ArkUI';
import { EventHub } from '../service/EventHub';
import { AppTheme } from '../common/Theme';
import { AppIcon } from './AppIcon';

// 应用内通知弹窗：监听 SSE notification.created，顶部横幅提示，点击跳转
@Component
export struct NotificationBanner {
  @State visible: boolean = false;
  @State title: string = '';
  @State body: string = '';
  @State taskId: string = '';
  private unsubscribe: (() => void) | null = null;
  private hideTimer: number = -1;
  private seen: Set<string> = new Set();

  aboutToAppear(): void {
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      const notif = EventHub.extractNotification(event);
      if (notif === null) {
        return;
      }
      const id = String(notif['id'] ?? '');
      if (id === '' || this.seen.has(id)) {
        return;
      }
      this.seen.add(id);
      if (this.seen.size > 100) {
        this.seen.clear();
      }
      this.title = String(notif['title'] ?? '');
      this.body = String(notif['body'] ?? '');
      let taskId = '';
      const data = notif['data'] as Record<string, Object>;
      if (data !== undefined && String(data['resourceType'] ?? '') === 'pickupTask') {
        taskId = String(data['resourceId'] ?? '');
      }
      this.taskId = taskId;
      this.visible = true;
      if (this.hideTimer !== -1) {
        clearTimeout(this.hideTimer);
      }
      this.hideTimer = setTimeout(() => {
        this.visible = false;
        this.hideTimer = -1;
      }, 5000);
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.hideTimer !== -1) {
      clearTimeout(this.hideTimer);
      this.hideTimer = -1;
    }
  }

  private dismiss(): void {
    this.visible = false;
    if (this.hideTimer !== -1) {
      clearTimeout(this.hideTimer);
      this.hideTimer = -1;
    }
  }

  private open(): void {
    const targetTaskId = this.taskId;
    this.dismiss();
    if (targetTaskId !== '') {
      router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: targetTaskId } });
    } else {
      router.pushUrl({ url: 'pages/NotificationsPage' });
    }
  }

  build() {
    if (this.visible) {
      Row({ space: 10 }) {
        AppIcon({ name: 'bell', iconSize: 18, color: AppTheme.PRIMARY })
        Column({ space: 2 }) {
          Text(this.title)
            .fontSize(15).fontWeight(FontWeight.Bold).fontColor(AppTheme.TEXT)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.body !== '') {
            Text(this.body)
              .fontSize(13).fontColor(AppTheme.TEXT_SECONDARY)
              .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1)
      }
      .width('92%')
      .padding(12)
      .backgroundColor(AppTheme.SURFACE)
      .borderRadius(12)
      .shadow({ radius: 16, color: '#22000000', offsetY: 4 })
      .onClick(() => { this.open(); })
    }
  }
}

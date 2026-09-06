import { router } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { SessionStore } from '../store/SessionStore';
import { TaskApi } from '../api/TaskApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { PickupTask } from '../model/Models';
import { taskStatusLabel, fmtTime } from '../common/Constants';
import { RefreshIconButton } from '../components/PageComponents';
import { EventHub } from '../service/EventHub';

@Entry
@Component
struct WorkerTasksPage {
  @State list: PickupTask[] = [];
  @State activeStatus: string = 'pending';
  @State loading: boolean = false;
  @State connected: boolean = false;
  private statuses: string[] = ['pending', 'in_progress', 'completed', 'cancelled'];
  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.load();
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      const type = String(event['type'] ?? '');
      if (type === 'sse_connected') {
        this.connected = true;
      } else if (type === 'sse_disconnected') {
        this.connected = false;
      }
    });
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
      this.list = await TaskApi.listAll('');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  count(status: string): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].status === status) {
        n++;
      }
    }
    return n;
  }

  filtered(): PickupTask[] {
    const result: PickupTask[] = [];
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].status === this.activeStatus) {
        result.push(this.list[i]);
      }
    }
    return result;
  }

  mainBtnLabel(t: PickupTask): string {
    if (t.status === 'pending') {
      return '开始取件';
    }
    if (t.status === 'in_progress') {
      return '继续取件';
    }
    return '查看详情';
  }

  async openTask(t: PickupTask): Promise<void> {
    if (this.loading) return;
    if (t.status === 'pending') {
      this.loading = true;
      try { await TaskApi.start(t.id); }
      catch (e) { UiUtil.toast((e as ApiError).message); this.loading = false; return; }
      this.loading = false;
    }
    router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: t.id } });
  }

  build() {
    Column() {
      Row({ space: 6 }) {
        Text('我的任务')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
        Blank()
        RefreshIconButton({ refreshing: this.loading, connected: this.connected, onRefresh: () => { this.load(); } })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      Row({ space: 8 }) {
        ForEach(this.statuses, (s: string) => {
          Column({ space: 2 }) {
            Text(taskStatusLabel(s) + ' ' + this.count(s))
              .fontSize(14)
              .fontColor(this.activeStatus === s ? '#0A59F7' : '#4E5969')
              .fontWeight(this.activeStatus === s ? FontWeight.Bold : FontWeight.Normal)
            Divider()
              .width(26)
              .strokeWidth(2)
              .color(this.activeStatus === s ? '#0A59F7' : '#00000000')
          }
          .onClick(() => { this.activeStatus = s; })
        }, (s: string) => s)
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 8 })
      .justifyContent(FlexAlign.SpaceBetween)

      if (this.filtered().length === 0) {
        Text('暂无任务')
          .fontSize(15)
          .fontColor('#86909C')
          .margin({ top: 60 })
      } else {
        List({ space: 10 }) {
          ForEach(this.filtered(), (t: PickupTask) => {
            ListItem() {
              Column() {
                Row() {
                  Text(t.customerName)
                    .fontSize(16)
                    .fontWeight(FontWeight.Medium)
                    .layoutWeight(1)
                  Text(taskStatusLabel(t.status))
                    .fontSize(12)
                    .fontColor('#FF7D00')
                }
                .width('100%')
                Text(t.taskNo)
                  .fontSize(12)
                  .fontColor('#86909C')
                  .margin({ top: 4 })
                Text(t.address)
                  .fontSize(13)
                  .fontColor('#4E5969')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 4 })
                Button(this.mainBtnLabel(t))
                  .width('100%')
                  .height(40)
                  .fontSize(14)
                  .margin({ top: 8 })
                  .enabled(!this.loading)
                  .onClick(() => { this.openTask(t); })
              }
              .width('100%')
              .padding(14)
              .backgroundColor('#FFFFFF')
              .borderRadius(10)
            }
          }, (t: PickupTask) => t.id)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 4, bottom: 12 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F2F5')
  }
}

import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { DashboardApi } from '../api/DashboardApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { DashboardBoard, DashboardWorker, DashboardAttention } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { AppIcon } from '../components/AppIcon';
import { NotificationBanner } from '../components/NotificationBanner';
import { NotificationApi } from '../api/NotificationApi';
import { normalizeRole, homePageForRole } from '../common/Constants';

@Entry
@Component
struct DashboardPage {
  @State menuOpen: boolean = false;
  @State board: DashboardBoard | null = null;
  @State workers: DashboardWorker[] = [];
  @State attention: DashboardAttention | null = null;
  @State range: string = 'today';
  @State unreadCount: number = 0;
  private ranges: string[] = ['today', 'yesterday', 'week', 'month'];

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    if (normalizeRole(SessionStore.role()) !== 'admin') {
      router.replaceUrl({ url: homePageForRole(SessionStore.role()) });
      return;
    }
    this.load();
    this.loadUnread();
  }

  async loadUnread(): Promise<void> {
    this.unreadCount = await NotificationApi.unreadCount();
  }

  async load(): Promise<void> {
    try {
      this.board = await DashboardApi.board(this.range);
      this.workers = await DashboardApi.workers();
      this.attention = await DashboardApi.attention();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  rangeLabel(r: string): string {
    if (r === 'today') {
      return '今日';
    }
    if (r === 'yesterday') {
      return '昨日';
    }
    if (r === 'week') {
      return '本周';
    }
    return '本月';
  }

  @Builder
  BoardCard(label: string, value: number, color: string, icon: string) {
    Row({ space: 12 }) {
      Column() { AppIcon({ name: icon, iconSize: 20, color: color }) }
        .width(40).height(40).borderRadius(9).backgroundColor('#E8F3FF')
        .justifyContent(FlexAlign.Center)
      Column({ space: 2 }) {
        Text(label).fontSize(12).fontColor('#86909C').maxLines(1)
        Text(value + '').fontSize(22).fontWeight(FontWeight.Bold).fontColor('#182431')
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .height(82).padding({ left: 14, right: 10 })
    .backgroundColor('#FFFFFF')
    .border({ width: 1, color: '#E5E6EB' }).borderRadius(10)
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '经营看板', unreadCount: this.unreadCount })
      Row({ space: 6 }) {
        Text('经营看板')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
        Blank()
        Button() { AppIcon({ name: 'refresh', iconSize: 18, color: '#4E5969' }) }
          .width(36).height(36).borderRadius(18).backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#E5E6EB' }).onClick(() => { this.load(); })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      Row({ space: 8 }) {
        ForEach(this.ranges, (r: string) => {
          Text(this.rangeLabel(r))
            .fontSize(14)
            .fontColor(this.range === r ? '#0A59F7' : '#4E5969')
            .fontWeight(this.range === r ? FontWeight.Bold : FontWeight.Normal)
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .backgroundColor(this.range === r ? '#E8F3FF' : '#00000000')
            .borderRadius(16)
            .onClick(() => {
              this.range = r;
              this.load();
            })
        }, (r: string) => r)
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 8 })
      .justifyContent(FlexAlign.SpaceBetween)

      Scroll() {
        Column() {
          if (this.board === null) {
            LoadingProgress().width(40).height(40).margin({ top: 60 })
          } else {
            Column({ space: 10 }) {
              Row({ space: 10 }) {
                this.BoardCard('取件量', this.board.pickupCount, '#0A59F7', 'task')
                this.BoardCard('总件数', this.board.pieces, '#86909C', 'worker')
              }.width('100%')
              Row({ space: 10 }) {
                this.BoardCard('客户数', this.board.pickupCustomerCount, '#00B42A', 'customer')
                this.BoardCard('出货客户', this.board.shipCustomerCount, '#FF7D00', 'customer')
              }.width('100%')
              Row({ space: 10 }) {
                this.BoardCard('回填重量(kg)', this.board.finalWeight, '#F53F3F', 'chart')
                this.BoardCard('待办', this.board.pendingCount, '#0A59F7', 'log')
              }.width('100%')
            }
            .width('100%')
            .padding(12)

            Column() {
              Text('取件员工作量')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ bottom: 8 })
              if (this.workers.length === 0) {
                Text('暂无取件员')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                ForEach(this.workers, (w: DashboardWorker) => {
                  Row() {
                    Text(w.name)
                      .fontSize(14)
                      .fontWeight(FontWeight.Medium)
                      .layoutWeight(1)
                    Text('取件 ' + w.pickupCount)
                      .fontSize(13)
                      .fontColor('#0A59F7')
                    Text(' · 件 ' + w.pieces)
                      .fontSize(13)
                      .fontColor('#86909C')
                    Text(' · ' + w.weight + 'kg')
                      .fontSize(13)
                      .fontColor('#00B42A')
                  }
                  .width('100%')
                  .padding({ top: 8, bottom: 8 })
                  .border({ width: { bottom: 0.5 }, color: '#F2F3F5' })
                }, (w: DashboardWorker) => w.id)
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ left: 12, right: 12, top: 8 })
            .alignItems(HorizontalAlign.Start)

            Column() {
              Text('待关注项')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ bottom: 8 })
              if (this.attention !== null) {
                Text('加急临期：' + this.attention.rushNearDeadline)
                  .fontSize(13)
                  .fontColor('#F53F3F')
                  .margin({ bottom: 4 })
                Text('超时未取：' + this.attention.overdue)
                  .fontSize(13)
                  .fontColor('#FF7D00')
                  .margin({ bottom: 4 })
                Text('未匹配面单：' + this.attention.unmatchedWaybill)
                  .fontSize(13)
                  .fontColor('#FF7D00')
                  .margin({ bottom: 4 })
                Text('无面单：' + this.attention.noWaybill)
                  .fontSize(13)
                  .fontColor('#86909C')
                  .margin({ bottom: 4 })
                Text('未解决异常：' + this.attention.unresolvedException)
                  .fontSize(13)
                  .fontColor('#F53F3F')
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ left: 12, right: 12, top: 8 })
            .alignItems(HorizontalAlign.Start)
          }
        }
        .width('100%')
        .padding({ bottom: 16 })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.TopStart)
    }
      .width('100%')
      .height('100%')
      .backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/DashboardPage' })
      NotificationBanner().position({ x: '4%', y: 62 }).zIndex(300)
    }
    .width('100%').height('100%')
  }
}

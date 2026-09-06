import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { DashboardApi } from '../api/DashboardApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { DashboardMe } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';

@Entry
@Component
struct MyDataPage {
  @State menuOpen: boolean = false;
  @State data: DashboardMe | null = null;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.load();
  }

  async load(): Promise<void> {
    try {
      this.data = await DashboardApi.me();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  @Builder
  StatCard(label: string, value: number, color: string) {
    Column({ space: 4 }) {
      Text(value + '')
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor(color)
      Text(label)
        .fontSize(13)
        .fontColor('#4E5969')
    }
    .layoutWeight(1)
    .height(90)
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#FFFFFF')
    .borderRadius(10)
  }

  @Builder
  PeriodCard(title: string, pickupCount: number, customerCount: number, pieces: number, matchedWeight: number) {
    Column({ space: 12 }) {
      Text(title)
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor('#182431')
        .width('100%')
      Row({ space: 8 }) {
        this.StatCard('取件次数', pickupCount, '#0A59F7')
        this.StatCard('客户数', customerCount, '#00B42A')
      }
      .width('100%')
      Row({ space: 8 }) {
        this.StatCard('件数', pieces, '#FF7D00')
        this.StatCard('匹配重量(kg)', matchedWeight, '#86909C')
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .backgroundColor('#FFFFFF')
    .borderRadius(10)
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '我的数据', unreadCount: 0 })

      if (this.data === null) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else {
        Scroll() {
          Column({ space: 10 }) {
            this.PeriodCard('今日数据', this.data.today.pickupCount, this.data.today.customerCount,
              this.data.today.pieces, this.data.today.matchedWeight)
            this.PeriodCard('本月数据', this.data.month.pickupCount, this.data.month.customerCount,
              this.data.month.pieces, this.data.month.matchedWeight)
            Column({ space: 6 }) {
              Text(this.data.assistCount + '')
                .fontSize(28)
                .fontWeight(FontWeight.Bold)
                .fontColor('#0A59F7')
              Text('协助取件次数')
                .fontSize(13)
                .fontColor('#4E5969')
            }
            .width('100%')
            .height(100)
            .justifyContent(FlexAlign.Center)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
          }
          .width('100%')
          .padding(12)
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
      .width('100%')
      .height('100%')
      .backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/MyDataPage' })
    }
    .width('100%').height('100%')
  }
}

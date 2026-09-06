import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { ApiClient, ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { matchStatusLabel } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { BackToTop } from '../components/PageComponents';

interface MatchItem {
  id: string;
  taskId: string;
  taskNo: string;
  customerName: string;
  waybillNo: string;
  pieces: number;
  entryMethod: string;
  matchStatus: string;
}

interface MatchRequest {
  waybillNo: string;
}

@Entry
@Component
struct MatchCenterPage {
  @State menuOpen: boolean = false;
  @State list: MatchItem[] = [];
  @State loading: boolean = false;
  @State showBackTop: boolean = false;
  private scroller: Scroller = new Scroller();

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const text = await ApiClient.get('/api/sync/match-center');
      this.list = JSON.parse(text) as MatchItem[];
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  async match(item: MatchItem): Promise<void> {
    const waybillNo = item.waybillNo;
    if (waybillNo === '') {
      UiUtil.toast('该明细无面单号，请先补充票号');
      return;
    }
    try {
      const body: MatchRequest = { waybillNo: waybillNo };
      const text = await ApiClient.post('/api/sync/match/' + item.id, body);
      const resp = JSON.parse(text) as Record<string, Object>;
      const matched = Boolean(resp['matched']);
      UiUtil.toast(matched ? '匹配成功，重量已回填' : '票号已登记，等待出货数据');
      this.load();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '待匹配中心', unreadCount: 0 })

      if (this.loading) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else if (this.list.length === 0) {
        Text('暂无待匹配明细')
          .fontSize(15)
          .fontColor('#86909C')
          .margin({ top: 60 })
      } else {
        List({ space: 10, scroller: this.scroller }) {
          ForEach(this.list, (item: MatchItem) => {
            ListItem() {
              Column() {
                Row() {
                  Text(item.customerName)
                    .fontSize(15)
                    .fontWeight(FontWeight.Medium)
                    .layoutWeight(1)
                  Text(matchStatusLabel(item.matchStatus))
                    .fontSize(12)
                    .fontColor('#FF7D00')
                }
                .width('100%')
                Text(item.taskNo)
                  .fontSize(12)
                  .fontColor('#86909C')
                  .margin({ top: 4 })
                Text('票号：' + (item.waybillNo === '' ? '未填写' : item.waybillNo) + ' · ' + item.pieces + ' 件')
                  .fontSize(13)
                  .fontColor('#4E5969')
                  .margin({ top: 4 })
                Button('匹配')
                  .width('100%')
                  .height(36)
                  .fontSize(14)
                  .margin({ top: 8 })
                  .onClick(() => { this.match(item); })
              }
              .width('100%')
              .padding(14)
              .backgroundColor('#FFFFFF')
              .borderRadius(10)
            }
          }, (item: MatchItem) => item.id)
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
      MobileDrawer({ open: $menuOpen, activePath: 'pages/MatchCenterPage' })
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scroller.scrollToIndex(0);
        this.showBackTop = false;
      } })
        .position({ x: '86%', y: '82%' })
    }
    .width('100%').height('100%')
  }
}

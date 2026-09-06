import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { ApiClient, ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { fmtTime, normalizeRole, homePageForRole } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { BackToTop } from '../components/PageComponents';

interface LogItem {
  userName: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  createdAt: string;
}

interface LogListResponse {
  list: LogItem[];
  total: number;
  page: number;
  size: number;
}

@Entry
@Component
struct LogsPage {
  @State menuOpen: boolean = false;
  @State list: LogItem[] = [];
  @State loading: boolean = false;
  @State showBackTop: boolean = false;
  private scroller: Scroller = new Scroller();

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
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const text = await ApiClient.get('/api/logs?page=0&size=100');
      const resp = JSON.parse(text) as LogListResponse;
      this.list = resp.list;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: '操作日志', unreadCount: 0 })

      if (this.loading) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else if (this.list.length === 0) {
        Text('暂无日志')
          .fontSize(15)
          .fontColor('#86909C')
          .margin({ top: 60 })
      } else {
        List({ space: 8, scroller: this.scroller }) {
          ForEach(this.list, (item: LogItem, idx: number) => {
            ListItem() {
              Column() {
                Row() {
                  Text(item.action)
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .layoutWeight(1)
                  Text(item.userName)
                    .fontSize(12)
                    .fontColor('#0A59F7')
                }
                .width('100%')
                if (item.detail !== '') {
                  Text(item.detail)
                    .fontSize(12)
                    .fontColor('#4E5969')
                    .margin({ top: 4 })
                }
                Text(fmtTime(item.createdAt))
                  .fontSize(11)
                  .fontColor('#86909C')
                  .margin({ top: 4 })
              }
              .width('100%')
              .padding(12)
              .backgroundColor('#FFFFFF')
              .borderRadius(8)
            }
          }, (item: LogItem, idx: number) => item.createdAt + idx)
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
      MobileDrawer({ open: $menuOpen, activePath: 'pages/LogsPage' })
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scroller.scrollToIndex(0);
        this.showBackTop = false;
      } })
        .position({ x: '86%', y: '82%' })
    }
    .width('100%').height('100%')
  }
}

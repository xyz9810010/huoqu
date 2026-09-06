import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { normalizeRole } from '../common/Constants';
import { AppTheme } from '../common/Theme';
import { AppIcon } from './AppIcon';

@Component
export struct MobileHeader {
  @Link menuOpen: boolean;
  @Prop title: string = '';
  @Prop unreadCount: number = 0;

  userInitial(): string {
    const user = SessionStore.getUser();
    if (user === null || user.name === '') return '?';
    return user.name.substring(0, 1);
  }

  build() {
    Row() {
      Button() {
        AppIcon({ name: 'menu', iconSize: 22, color: AppTheme.TEXT_SECONDARY })
      }
      .width(36).height(36).borderRadius(18)
      .backgroundColor('#00000000')
      .onClick(() => { this.menuOpen = true; })
      Text(this.title)
        .fontSize(16).fontWeight(FontWeight.Bold).fontColor(AppTheme.TEXT)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ left: 10 })
      Blank()
      Stack() {
        AppIcon({ name: 'bell', iconSize: 20, color: AppTheme.TEXT_SECONDARY })
        if (this.unreadCount > 0) {
          Text(this.unreadCount > 99 ? '99+' : this.unreadCount + '')
            .fontSize(9).fontColor(AppTheme.SURFACE)
            .backgroundColor(AppTheme.DANGER).borderRadius(8)
            .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            .position({ x: 21, y: -4 })
        }
      }
      .width(34).height(34).borderRadius(17)
      .backgroundColor('#00000000')
      .onClick(() => { router.pushUrl({ url: 'pages/NotificationsPage' }); })
      Text(this.userInitial())
        .width(32).height(32).borderRadius(16)
        .fontSize(14).fontWeight(FontWeight.Bold).fontColor(AppTheme.SURFACE)
        .backgroundColor(AppTheme.PRIMARY).textAlign(TextAlign.Center)
        .margin({ left: 12 })
    }
    .width('100%').height(AppTheme.HEADER_HEIGHT)
    .padding({ left: 12, right: 12 })
    .backgroundColor(AppTheme.SURFACE)
    .shadow({ radius: 10, color: '#0D1F2333', offsetY: 2 })
  }
}

@Component
export struct MobileDrawer {
  @Link open: boolean;
  @Prop activePath: string = '';

  role(): string {
    return normalizeRole(SessionStore.role());
  }

  isRole(...roles: string[]): boolean {
    return roles.indexOf(this.role()) >= 0;
  }

  navigate(path: string): void {
    this.open = false;
    if (path !== this.activePath) router.replaceUrl({ url: path });
  }

  logout(): void {
    this.open = false;
    SessionStore.clear();
    router.replaceUrl({ url: 'pages/LoginPage' });
  }

  userName(): string {
    const user = SessionStore.getUser();
    return user === null || user.name === '' ? '当前账号' : user.name;
  }

  userInitial(): string {
    return this.userName().substring(0, 1);
  }

  roleLabel(): string {
    const role = this.role();
    if (role === 'admin') return '管理员';
    if (role === 'boss') return '负责人';
    if (role === 'cs') return '客服';
    if (role === 'worker') return '取件员';
    return '用户';
  }

  @Builder
  MenuSectionTitle(title: string) {
    Text(title)
      .fontSize(11).fontWeight(FontWeight.Medium).fontColor('#86909C')
      .letterSpacing(0.8).width('100%')
      .padding({ left: 12, right: 12, top: 14, bottom: 6 })
  }

  @Builder
  MenuItem(label: string, icon: string, path: string) {
    Row({ space: 11 }) {
      Row() {
        AppIcon({ name: icon, iconSize: 18, color: this.activePath === path ? AppTheme.PRIMARY : AppTheme.TEXT_SECONDARY })
      }
      .width(32).height(32).justifyContent(FlexAlign.Center)
      .borderRadius(8).backgroundColor(this.activePath === path ? '#E8F3FF' : '#F2F3F5')
      Text(label)
        .fontSize(14)
        .fontColor(this.activePath === path ? AppTheme.PRIMARY : AppTheme.TEXT_SECONDARY)
        .fontWeight(this.activePath === path ? FontWeight.Bold : FontWeight.Normal)
    }
    .width('100%').height(48)
    .padding({ left: 10, right: 12 }).borderRadius(10)
    .backgroundColor(this.activePath === path ? AppTheme.PRIMARY_TINT : '#00000000')
    .onClick(() => { this.navigate(path); })
  }

  build() {
    if (this.open) {
      Stack({ alignContent: Alignment.TopStart }) {
        Column() {}
          .width('100%').height('100%').backgroundColor('#33000000')
          .onClick(() => { this.open = false; })
        Column() {
          Row({ space: 10 }) {
            Text('取').width(36).height(36).borderRadius(10)
              .fontSize(18).fontWeight(FontWeight.Bold).fontColor(AppTheme.SURFACE)
              .backgroundColor(AppTheme.PRIMARY).textAlign(TextAlign.Center)
            Column({ space: 2 }) {
              Text('Huoqu').fontSize(16).fontWeight(FontWeight.Bold).fontColor(AppTheme.TEXT)
              Text('取件运营管理').fontSize(11).fontColor(AppTheme.TEXT_SECONDARY)
            }.alignItems(HorizontalAlign.Start)
          }
          .width('100%').height(72).padding({ left: 18 })
          .border({ width: { bottom: 1 }, color: AppTheme.BORDER })
          Scroll() {
            Column({ space: 2 }) {
              this.MenuSectionTitle('工作台')
              if (this.isRole('boss', 'admin')) this.MenuItem('数据看板', 'dashboard', 'pages/DashboardPage')
              if (this.isRole('worker')) this.MenuItem('我的任务', 'worker', 'pages/WorkerTabPage')
              if (this.isRole('worker')) this.MenuItem('新增订单', 'add', 'pages/DispatchPage')
              if (this.isRole('worker')) this.MenuItem('我的数据', 'chart', 'pages/MyDataPage')
              if (this.isRole('boss', 'admin', 'cs')) this.MenuSectionTitle('业务管理')
              if (this.isRole('boss', 'admin', 'cs')) this.MenuItem('客户管理', 'customer', 'pages/CustomersPage')
              if (this.isRole('admin', 'cs')) this.MenuItem('新建取件', 'add', 'pages/DispatchPage')
              if (this.isRole('boss', 'admin', 'cs')) this.MenuItem('取件任务', 'task', 'pages/TasksPage')
              if (this.isRole('admin', 'cs')) this.MenuItem('待匹配中心', 'match', 'pages/MatchCenterPage')
              if (this.isRole('admin')) this.MenuSectionTitle('系统管理')
              if (this.isRole('admin')) this.MenuItem('区域管理', 'area', 'pages/AreasPage')
              if (this.isRole('admin')) this.MenuItem('员工管理', 'employee', 'pages/EmployeesPage')
              if (this.isRole('admin')) this.MenuItem('操作日志', 'log', 'pages/LogsPage')
              if (this.isRole('admin')) this.MenuItem('消息推送', 'push', 'pages/PushProvidersPage')
              this.MenuSectionTitle('消息与账户')
              this.MenuItem('通知中心', 'bell', 'pages/NotificationsPage')
            }
            .width('100%').padding(8).alignItems(HorizontalAlign.Start)
          }
          .width('100%').layoutWeight(1).align(Alignment.TopStart)
          Column({ space: 8 }) {
            Row({ space: 10 }) {
              Text(this.userInitial()).width(36).height(36).borderRadius(18)
                .fontSize(15).fontWeight(FontWeight.Bold).fontColor(AppTheme.SURFACE)
                .backgroundColor(AppTheme.PRIMARY).textAlign(TextAlign.Center)
              Column({ space: 2 }) {
                Text(this.userName()).fontSize(13).fontWeight(FontWeight.Medium).fontColor(AppTheme.TEXT)
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(this.roleLabel()).fontSize(11).fontColor(AppTheme.TEXT_SECONDARY)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            }.width('100%')
            Row({ space: 10 }) {
              AppIcon({ name: 'logout', iconSize: 17, color: AppTheme.TEXT_SECONDARY })
              Text('退出登录').fontSize(13).fontColor(AppTheme.TEXT_SECONDARY)
            }
            .width('100%').height(38).padding({ left: 10, right: 10 }).borderRadius(8)
            .backgroundColor('#F2F3F5').onClick(() => { this.logout(); })
          }
          .width('100%').padding({ left: 12, right: 12, top: 10, bottom: 12 })
          .border({ width: { top: 1 }, color: AppTheme.BORDER })
        }
        .width(AppTheme.DRAWER_WIDTH).height('100%')
        .backgroundColor(AppTheme.SIDE_BG).alignItems(HorizontalAlign.Start)
      }
      .width('100%').height('100%').position({ x: 0, y: 0 }).zIndex(200)
    }
  }
}

import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { SessionStore } from '../store/SessionStore';
import { EventHub } from '../service/EventHub';
import { TaskApi } from '../api/TaskApi';
import { NotificationApi } from '../api/NotificationApi';
import { DashboardApi } from '../api/DashboardApi';
import { UiUtil } from '../common/UiUtil';
import { ApiClient, ApiError } from '../api/ApiClient';
import { PickupTask, AppNotification, DashboardMe } from '../model/Models';
import { taskStatusLabel, fmtTime } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { RefreshIconButton, BackToTop } from '../components/PageComponents';
import { NotificationBanner } from '../components/NotificationBanner';

// 取件员主页：网页端移动版 1:1（顶部 header + 左上角抽屉 + 无底部导航）
@Entry
@Component
struct WorkerTabPage {
  @State list: PickupTask[] = [];
  @State activeStatus: string = 'pending';
  @State notifs: AppNotification[] = [];
  @State me: DashboardMe | null = null;
  @State menuOpen: boolean = false;
  @State refreshing: boolean = false;
  @State connected: boolean = false;
  @State latency: number = -1;
  @State actionTaskId: string = '';
  @State showBackTop: boolean = false;
  @State timeRange: string = 'today';
  @State refreshTip: string = '';
  private statuses: string[] = ['pending', 'in_progress', 'completed', 'cancelled'];
  private timeRanges: string[] = ['all', 'today', 'week', 'month'];
  private scrollers: Scroller[] = [new Scroller(), new Scroller(), new Scroller(), new Scroller()];
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: number = -1;
  private tipTimer: number = -1;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.loadAll();
    this.heartbeat();
    this.heartbeatTimer = setInterval(() => { this.heartbeat(); }, 5000);
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      const notif = EventHub.extractNotification(event);
      if (notif !== null) {
        this.insertNotification(notif);
      }
      const taskId = EventHub.taskIdFromEvent(event);
      if (taskId !== '') {
        this.updateTaskById(taskId);
      }
    });
  }

  aboutToDisappear(): void {
    if (this.tipTimer !== -1) {
      clearTimeout(this.tipTimer);
      this.tipTimer = -1;
    }
    if (this.heartbeatTimer !== -1) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = -1;
    }
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  onPageShow(): void {
    if (SessionStore.isLoggedIn()) this.loadAll();
  }

  // 实时心跳：探测服务端延迟，同时刷新连接状态（绿=正常/灰=不可达）
  async heartbeat(): Promise<void> {
    const start = Date.now();
    try {
      await ApiClient.get('/api/health');
      this.latency = Date.now() - start;
      this.connected = true;
    } catch (e) {
      this.latency = -1;
      this.connected = false;
    }
  }

  async loadAll(notify: boolean = false): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.loadTasks();
      await this.loadNotifs();
      await this.loadMe();
    } finally {
      this.refreshing = false;
      if (notify) {
        this.showRefreshTip();
      }
    }
  }

  // 顶部轻提示（Header 下方居中，短暂显示后自动消失）
  showRefreshTip(): void {
    this.refreshTip = '已刷新';
    if (this.tipTimer !== -1) {
      clearTimeout(this.tipTimer);
    }
    this.tipTimer = setTimeout(() => {
      this.refreshTip = '';
      this.tipTimer = -1;
    }, 1800);
  }

  async openTask(t: PickupTask): Promise<void> {
    if (this.actionTaskId !== '') return;
    if (t.status === 'pending') {
      this.actionTaskId = t.id;
      try {
        const updated = await TaskApi.start(t.id);
        const copy = this.list.slice();
        for (let i = 0; i < copy.length; i++) if (copy[i].id === updated.id) copy[i] = updated;
        this.list = copy;
      } catch (e) {
        UiUtil.toast((e as ApiError).message);
        this.actionTaskId = '';
        return;
      }
      this.actionTaskId = '';
    }
    router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: t.id } });
  }

  async loadTasks(): Promise<void> {
    try {
      this.list = await TaskApi.listAll('');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async loadNotifs(): Promise<void> {
    try {
      this.notifs = await NotificationApi.list();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async loadMe(): Promise<void> {
    try {
      this.me = await DashboardApi.me();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  count(status: string): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].status === status && this.inTimeRange(this.list[i])) {
        n++;
      }
    }
    return n;
  }

  timeRangeLabel(r: string): string {
    if (r === 'today') {
      return '今天';
    }
    if (r === 'week') {
      return '本周';
    }
    if (r === 'month') {
      return '本月';
    }
    return '全部';
  }

  // 任务参与时间筛选的时间点：有预约取件时间（指定时间/赶出货）按预约时间，否则按派单时间（空则创建时间兜底）
  taskTime(t: PickupTask): string {
    if (t.scheduledTime !== '') {
      return t.scheduledTime;
    }
    if (t.rushShipTime !== '') {
      return t.rushShipTime;
    }
    return t.dispatchAt !== '' ? t.dispatchAt : t.createdAt;
  }

  pad2(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  dateStr(d: Date): string {
    return d.getFullYear() + '-' + this.pad2(d.getMonth() + 1) + '-' + this.pad2(d.getDate());
  }

  inTimeRange(t: PickupTask): boolean {
    const range = this.timeRange;
    if (range === 'all') {
      return true;
    }
    const ts = this.taskTime(t);
    if (ts === '') {
      return false;
    }
    const day = ts.substring(0, 10);
    const now = new Date();
    if (range === 'today') {
      return day === this.dateStr(now);
    }
    if (range === 'month') {
      return day.substring(0, 7) === now.getFullYear() + '-' + this.pad2(now.getMonth() + 1);
    }
    // 本周：周一 ~ 周日
    const dow = now.getDay();
    const daysSinceMonday = (dow + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday + 6);
    return day >= this.dateStr(monday) && day <= this.dateStr(sunday);
  }

  // 某状态的任务列表
  tasksOf(status: string): PickupTask[] {
    const result: PickupTask[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      if (t.status === status && this.inTimeRange(t)) {
        result.push(t);
      }
    }
    return result;
  }

  statusIndex(): number {
    for (let i = 0; i < this.statuses.length; i++) {
      if (this.statuses[i] === this.activeStatus) {
        return i;
      }
    }
    return 0;
  }

  // 按状态字符串找索引
  statusIndexOf(status: string): number {
    for (let i = 0; i < this.statuses.length; i++) {
      if (this.statuses[i] === status) {
        return i;
      }
    }
    return 0;
  }

  insertNotification(notif: Record<string, Object>): void {
    const id = String(notif['id'] ?? '');
    if (id === '') {
      return;
    }
    const n: AppNotification = {
      id: id,
      type: String(notif['type'] ?? ''),
      title: String(notif['title'] ?? ''),
      body: String(notif['body'] ?? ''),
      data: '',
      priority: String(notif['priority'] ?? 'normal'),
      read: false,
      readAt: '',
      createdAt: String(notif['createdAt'] ?? '')
    };
    const newArr: AppNotification[] = [n];
    for (let i = 0; i < this.notifs.length; i++) {
      if (this.notifs[i].id !== n.id) {
        newArr.push(this.notifs[i]);
      }
    }
    this.notifs = newArr;
  }

  async updateTaskById(taskId: string): Promise<void> {
    try {
      const task = await TaskApi.detail(taskId);
      const newArr: PickupTask[] = [task];
      for (let i = 0; i < this.list.length; i++) {
        if (this.list[i].id !== task.id) {
          newArr.push(this.list[i]);
        }
      }
      this.list = newArr;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  unreadCount(): number {
    let n = 0;
    for (let i = 0; i < this.notifs.length; i++) {
      if (!this.notifs[i].read) {
        n++;
      }
    }
    return n;
  }

  userNameFirst(): string {
    const u = SessionStore.getUser();
    if (u === null || u.name === '') {
      return '?';
    }
    return u.name.substring(0, 1);
  }

  // 顶部 header
  @Builder
  Header() {
    Row() {
      Button('≡')
        .fontSize(18)
        .width(36)
        .height(36)
        .backgroundColor('#FFFFFF')
        .fontColor('#4E5969')
        .onClick(() => { this.menuOpen = true; })
      Text('我的任务')
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor('#182431')
        .margin({ left: 6 })
      Blank()
      // 铃铛
      Stack() {
        Text('◌')
          .fontSize(18)
          .width(34)
          .height(34)
          .textAlign(TextAlign.Center)
          .borderRadius(17)
          .border({ width: 1, color: '#E5E6EB' })
        if (this.unreadCount() > 0) {
          Text(this.unreadCount() > 99 ? '99+' : this.unreadCount() + '')
            .fontSize(9)
            .fontColor('#FFFFFF')
            .backgroundColor('#F53F3F')
            .borderRadius(8)
            .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            .position({ x: 22, y: -4 })
        }
      }
      .width(34)
      .height(34)
      .onClick(() => { router.pushUrl({ url: 'pages/NotificationsPage' }); })
      // 头像
      Column() {
        Text(this.userNameFirst())
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF')
      }
      .width(32)
      .height(32)
      .borderRadius(16)
      .backgroundColor('#0A59F7')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ left: 12 })
    }
    .width('100%')
    .height(56)
    .padding({ left: 12, right: 12 })
    .backgroundColor('#FFFFFF')
    .border({ width: { bottom: 1 }, color: '#E5E6EB' })
  }

  // 抽屉菜单项
  @Builder
  MenuItem(label: string, icon: string, path: string, isCurrent: boolean) {
    Row({ space: 10 }) {
      Text(icon)
        .fontSize(18)
      Text(label)
        .fontSize(14)
        .fontColor(isCurrent ? '#0A59F7' : '#4E5969')
        .fontWeight(isCurrent ? FontWeight.Bold : FontWeight.Normal)
    }
    .width('100%')
    .height(42)
    .padding({ left: 14, right: 14 })
    .borderRadius(8)
    .backgroundColor(isCurrent ? '#ecf5ff' : '#00000000')
    .onClick(() => {
      this.menuOpen = false;
      if (!isCurrent) {
        router.pushUrl({ url: path });
      }
    })
  }

  // 抽屉
  @Builder
  Drawer() {
    if (this.menuOpen) {
      Stack() {
        Column() {
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#33000000')
        .onClick(() => { this.menuOpen = false; })

        Column() {
          Row({ space: 9 }) {
            Column() {
              Text('取')
                .fontSize(18)
                .fontWeight(FontWeight.Bold)
                .fontColor('#FFFFFF')
            }
            .width(30)
            .height(30)
            .borderRadius(8)
            .backgroundColor('#0A59F7')
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            Text('Huoqu')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#182431')
          }
          .width('100%')
          .height(60)
          .padding({ left: 20 })
          .border({ width: { bottom: 1 }, color: '#E5E6EB' })

          Column({ space: 2 }) {
            this.MenuItem('我的任务', '▱', 'pages/WorkerTabPage', true)
            this.MenuItem('我的数据', '▥', 'pages/MyDataPage', false)
            this.MenuItem('通知中心', '◌', 'pages/NotificationsPage', false)
          }
          .width('100%')
          .padding(8)
          .alignItems(HorizontalAlign.Start)

          // 退出登录（底部）
          Row({ space: 10 }) {
            Text('↪')
              .fontSize(18)
            Text('退出登录')
              .fontSize(14)
              .fontColor('#4E5969')
          }
          .width('100%')
          .height(42)
          .padding({ left: 14, right: 14 })
          .borderRadius(8)
          .margin({ left: 8, right: 8 })
          .onClick(() => {
            this.menuOpen = false;
            SessionStore.clear();
            router.replaceUrl({ url: 'pages/LoginPage' });
          })
        }
        .width(264)
        .height('100%')
        .backgroundColor('#F7F8FA')
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .height('100%')
      .position({ x: 0, y: 0 })
      .zIndex(200)
    }
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

  tagBg(status: string): string {
    if (status === 'pending') {
      return '#FFF3E8';
    }
    if (status === 'in_progress') {
      return '#E8F3FF';
    }
    if (status === 'completed') {
      return '#E8FFEA';
    }
    return '#F2F3F5';
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

  // 卡片时间标题：与 web 端一致（派单/完成/状态更新）
  timeTitle(t: PickupTask): string {
    if (t.status === 'completed') {
      return '完成';
    }
    if (t.status === 'cancelled') {
      return '状态更新';
    }
    return '派单';
  }

  timeOf(t: PickupTask): string {
    if (t.status === 'completed') {
      return t.completedAt;
    }
    if (t.status === 'cancelled') {
      return t.updatedAt;
    }
    return t.dispatchAt;
  }

  @Builder
  TaskCard(t: PickupTask) {
    Column() {
      Row({ space: 6 }) {
        Text(taskStatusLabel(t.status))
          .fontSize(12)
          .fontColor(this.tagColor(t.status))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .backgroundColor(this.tagBg(t.status))
          .borderRadius(4)
        if (t.taskType === 'rush') {
          Text('赶 ' + fmtTime(t.rushShipTime) + ' 出货')
            .fontSize(12)
            .fontColor('#F53F3F')
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor('#FFECE8')
            .borderRadius(4)
        } else if (t.taskType === 'scheduled') {
          Text('指定时间 ' + fmtTime(t.scheduledTime))
            .fontSize(12)
            .fontColor('#FF7D00')
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor('#FFF3E8')
            .borderRadius(4)
        }
        Blank()
        Text(this.timeTitle(t) + ' ' + fmtTime(this.timeOf(t)))
          .fontSize(11)
          .fontColor('#86909C')
      }
      .width('100%')

      Row() {
        Text(t.customerName)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Blank()
        Text(t.taskNo)
          .fontSize(11)
          .fontColor('#86909C')
      }
      .width('100%')
      .margin({ top: 8 })

      Column({ space: 4 }) {
        Row() {
          if (t.areaName !== '') {
            Text(t.areaName)
              .fontSize(13)
              .fontColor('#0A59F7')
              .margin({ right: 6 })
          }
          Text(t.address)
            .fontSize(13)
            .fontColor('#4E5969')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)

        Text('联系人：' + t.contact + '　电话：' + t.phone)
          .fontSize(12)
          .fontColor('#86909C')

        if (t.pickupNote !== '') {
          Text('备注：' + t.pickupNote)
            .fontSize(12)
            .fontColor('#FF7D00')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .width('100%')
      .margin({ top: 6 })
      .alignItems(HorizontalAlign.Start)

      if (t.status === 'pending' || t.status === 'in_progress') {
        Row({ space: 8 }) {
          Button('拨号')
            .fontSize(13)
            .height(34)
            .layoutWeight(1)
            .onClick(() => {
              UiUtil.dial(getContext(this) as common.UIAbilityContext, t.phone);
            })
          Button('导航')
            .fontSize(13)
            .height(34)
            .layoutWeight(1)
            .onClick(() => {
              UiUtil.navigate(this.getUIContext(), getContext(this) as common.UIAbilityContext, t.address);
            })
        }
        .width('100%')
        .margin({ top: 10 })
      }

      Button(this.actionTaskId === t.id ? '启动中...' : this.mainBtnLabel(t))
        .width('100%')
        .height(42)
        .fontSize(15)
        .margin({ top: 10 })
        .backgroundColor(t.status === 'pending' || t.status === 'in_progress' ? '#0A59F7' : '#86909C')
        .enabled(this.actionTaskId === '')
        .onClick(() => { this.openTask(t); })
    }
    .width('100%')
    .padding(14)
    .backgroundColor('#FFFFFF')
    .borderRadius(14)
    .border({ width: t.taskType === 'rush' ? 1 : 0, color: '#F53F3F' })
    .shadow({ radius: 10, color: '#0D1F2938', offsetY: 3 })
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '我的任务', unreadCount: this.unreadCount() })
        // 时间范围筛选
        Row({ space: 6 }) {
          ForEach(this.timeRanges, (r: string) => {
            Text(this.timeRangeLabel(r))
              .fontSize(13)
              .fontColor(this.timeRange === r ? '#0A59F7' : '#4E5969')
              .fontWeight(this.timeRange === r ? FontWeight.Bold : FontWeight.Normal)
              .padding({ left: 12, right: 12, top: 5, bottom: 5 })
              .backgroundColor(this.timeRange === r ? '#E8F3FF' : '#00000000')
              .borderRadius(14)
              .onClick(() => { this.timeRange = r; })
          }, (r: string) => r)
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 8, bottom: 2 })

        // 状态 tab（均分宽度）+ 右侧操作按钮
        Row({ space: 4 }) {
          ForEach(this.statuses, (s: string) => {
            Row({ space: 3 }) {
              Text(taskStatusLabel(s))
                .fontSize(14)
                .fontColor(this.activeStatus === s ? '#0A59F7' : '#4E5969')
                .fontWeight(this.activeStatus === s ? FontWeight.Bold : FontWeight.Normal)
              Text(this.count(s) + '')
                .fontSize(11)
                .fontColor(this.activeStatus === s ? '#0A59F7' : '#86909C')
            }
            .layoutWeight(1)
            .height(32)
            .justifyContent(FlexAlign.Center)
            .backgroundColor(this.activeStatus === s ? '#E8F3FF' : '#00000000')
            .borderRadius(16)
            .onClick(() => { this.activeStatus = s; })
          }, (s: string) => s)
          Row({ space: 4 }) {
            RefreshIconButton({ refreshing: this.refreshing, connected: this.connected, onRefresh: () => { this.loadAll(true); } })
            if (this.latency >= 0) {
              Text(this.latency + 'ms')
                .fontSize(8)
                .fontColor(this.connected ? '#00B42A' : '#86909C')
            }
          }
        }
        .width('100%')
        .padding({ left: 8, right: 8, top: 10, bottom: 6 })

        // 任务列表：左右滑动切换状态（Swiper）
        Swiper() {
          ForEach(this.statuses, (s: string) => {
            if (this.tasksOf(s).length === 0) {
              Column() {
                Text('暂无任务')
                  .fontSize(14)
                  .fontColor('#86909C')
              }
              .width('100%')
              .margin({ top: 60 })
            } else {
              List({ space: 10, scroller: this.scrollers[this.statusIndexOf(s)] }) {
                ForEach(this.tasksOf(s), (t: PickupTask) => {
                  ListItem() {
                    this.TaskCard(t)
                  }
                }, (t: PickupTask) => t.id)
              }
              .width('100%')
              .height('100%')
              .padding({ left: 12, right: 12, top: 4, bottom: 12 })
              .onScroll((offset: number) => {
                this.showBackTop = offset > 500;
              })
            }
          }, (s: string) => s)
        }
        .index(this.statusIndex())
        .indicator(false)
        .width('100%')
        .layoutWeight(1)
        .onChange((index: number) => {
          if (index >= 0 && index < this.statuses.length) {
            this.activeStatus = this.statuses[index];
          }
        })
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#F1F2F5')

      MobileDrawer({ open: $menuOpen, activePath: 'pages/WorkerTabPage' })
      NotificationBanner().position({ x: '4%', y: 62 }).zIndex(300)

      // 一键回顶悬浮按钮（在新增订单 FAB 上方）
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scrollers[this.statusIndex()].scrollToIndex(0);
        this.showBackTop = false;
      } })
        .position({ x: '84%', y: '74%' })

      // 新增订单悬浮按钮（右下角）
      Button() {
        Text('＋')
          .fontSize(28)
          .fontColor('#FFFFFF')
          .fontWeight(FontWeight.Bold)
      }
      .width(56)
      .height(56)
      .borderRadius(28)
      .backgroundColor('#0A59F7')
      .shadow({ radius: 12, color: '#40000000', offsetY: 4 })
      .position({ x: '80%', y: '82%' })
      .onClick(() => { router.pushUrl({ url: 'pages/DispatchPage' }); })

      // 顶部轻提示（Header 下方居中）
      if (this.refreshTip !== '') {
        Text(this.refreshTip)
          .fontSize(13)
          .fontColor('#FFFFFF')
          .padding({ left: 18, right: 18, top: 8, bottom: 8 })
          .backgroundColor('#CC182431')
          .borderRadius(20)
          .shadow({ radius: 8, color: '#1A000000', offsetY: 2 })
          .position({ x: '50%', y: 64 })
          .translate({ x: '-50%' })
          .zIndex(400)
      }
    }
    .width('100%')
    .height('100%')
  }
}

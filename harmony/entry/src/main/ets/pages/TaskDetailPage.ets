import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { abilityAccessCtrl, common, Permissions, Want } from '@kit.AbilityKit';
import { camera, cameraPicker } from '@kit.CameraKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { SessionStore } from '../store/SessionStore';
import { TaskApi } from '../api/TaskApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { ScanUtil } from '../common/ScanUtil';
import { PickupTask, PickupItem, TaskPhoto, TaskException } from '../model/Models';
import { taskStatusLabel, matchStatusLabel, entryMethodLabel, fmtTime, Constants, normalizeRole } from '../common/Constants';
import { RefreshIconButton } from '../components/PageComponents';
import { EventHub } from '../service/EventHub';

@Entry
@Component
struct TaskDetailPage {
  @State task: PickupTask | null = null;
  @State taskId: string = '';
  @State loading: boolean = false;
  @State uploading: boolean = false;
  @State showAddItem: boolean = false;
  @State itemGoodsName: string = '';
  @State itemPieces: string = '1';
  @State itemWaybillNo: string = '';
  @State editingItemId: string = '';
  @State savingItem: boolean = false;
  @State showComplete: boolean = false;
  @State completePieces: string = '';
  @State completeWaybill: string = '';
  @State completing: boolean = false;
  @State previewPhotoUrl: string = '';
  @State connected: boolean = false;

  private unsubscribe: (() => void) | null = null;
  private loadRequest: number = 0;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    const params = router.getParams() as Record<string, string>;
    this.taskId = params['id'];
    this.load();
    this.unsubscribe = EventHub.subscribe((event: Record<string, Object>) => {
      const type = String(event['type'] ?? '');
      if (type === 'sse_connected') {
        this.connected = true;
      } else if (type === 'sse_disconnected') {
        this.connected = false;
      }
      // 当前任务有更新时自动刷新（网页端修改明细/照片等）
      if (type.startsWith('task.') && String(event['taskId'] ?? '') === this.taskId) {
        this.load();
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
    if (this.savingItem) return;
    const request = ++this.loadRequest;
    this.loading = true;
    try {
      const latest = await TaskApi.detail(this.taskId);
      if (request === this.loadRequest) this.task = latest;
    } catch (e) {
      if (request === this.loadRequest) UiUtil.toast((e as ApiError).message);
    } finally {
      if (request === this.loadRequest) this.loading = false;
    }
  }

  choosePhotoSource(): void {
    this.getUIContext().showActionSheet({
      title: '上传照片',
      message: '请选择照片来源',
      sheets: [
        { title: '相机拍照', icon: $r('app.media.camera_icon'), action: () => { this.capturePhoto(); } },
        { title: '本地图片', icon: $r('app.media.gallery_icon'), action: () => { this.selectLocalPhotos(); } }
      ],
      confirm: { value: '取消', action: () => {} },
      autoCancel: true
    });
  }

  async uploadUris(uris: string[]): Promise<void> {
    if (uris.length === 0) return;
    this.uploading = true;
    try {
      this.task = await TaskApi.uploadPhotos(this.taskId, uris);
      // 后台同步确保数据完整
      this.load();
      UiUtil.toast('照片已上传，当前共 ' + (this.task?.photos?.length ?? 0) + ' 张');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.uploading = false;
    }
  }

  async capturePhoto(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const cameraPermissions: Array<Permissions> = ['ohos.permission.CAMERA'];
      const permissionResult = await abilityAccessCtrl.createAtManager()
        .requestPermissionsFromUser(context, cameraPermissions);
      if (permissionResult.authResults.length === 0 || permissionResult.authResults[0] !== 0) {
        UiUtil.toast('请允许相机权限后再拍照');
        return;
      }
      const profile: cameraPicker.PickerProfile = {
        cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK
      };
      const result = await cameraPicker.pick(
        context,
        [cameraPicker.PickerMediaType.PHOTO],
        profile
      );
      if (result.resultUri === '') {
        return;
      }
      await this.uploadUris([result.resultUri]);
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async selectLocalPhotos(): Promise<void> {
    try {
      const picker = new photoAccessHelper.PhotoViewPicker();
      const result = await picker.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 9
      });
      await this.uploadUris(result.photoUris);
    } catch (e) {
      // 用户取消选择时保持当前页面。
    }
  }

  async scanItemWaybill(): Promise<void> {
    const code = await ScanUtil.scan(getContext(this) as common.Context);
    if (code !== '') {
      this.itemWaybillNo = code;
    }
  }

  async submitAddItem(): Promise<void> {
    if (this.savingItem || this.task === null || this.task.status === 'cancelled') return;
    const pieces = Number(this.itemPieces.trim());
    if (!/^[0-9]+$/.test(this.itemPieces.trim()) || !Number.isSafeInteger(pieces) || pieces <= 0) {
      UiUtil.toast('请输入有效件数');
      return;
    }
    this.savingItem = true;
    // Discard detail requests started before this write.
    this.loadRequest++;
    this.loading = false;
    try {
      if (this.editingItemId !== '') {
        this.task = await TaskApi.updateItem(this.taskId, this.editingItemId, this.itemWaybillNo.trim(), this.itemGoodsName.trim(), pieces);
      } else {
        this.task = await TaskApi.addItem(this.taskId, this.itemWaybillNo.trim(), this.itemGoodsName.trim(), pieces);
      }
      UiUtil.toast(this.editingItemId !== '' ? '明细已保存' : '明细已添加');
      this.showAddItem = false;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.savingItem = false;
    }
  }

  openAddItem(): void {
    if (this.savingItem) return;
    this.editingItemId = '';
    this.itemGoodsName = '';
    this.itemPieces = '1';
    this.itemWaybillNo = '';
    this.showAddItem = true;
  }

  openEditItem(item: PickupItem): void {
    if (this.savingItem || this.task === null || this.task.status === 'cancelled') return;
    this.editingItemId = item.id;
    this.itemGoodsName = item.goodsName;
    this.itemPieces = String(item.pieces);
    this.itemWaybillNo = item.waybillNo;
    this.showAddItem = true;
  }

  // 计算当前明细总件数（完成弹窗默认值）
  totalPieces(): number {
    if (this.task === null) {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < this.task.items.length; i++) {
      sum += this.task.items[i].pieces;
    }
    return sum;
  }

  openComplete(): void {
    const total = this.totalPieces();
    this.completePieces = total > 0 ? total + '' : '';
    this.completeWaybill = '';
    this.showComplete = true;
  }

  scanCompleteWaybill(): void {
    ScanUtil.scan(getContext(this) as common.Context).then((code: string) => {
      if (code !== '') {
        this.completeWaybill = code;
      }
    });
  }

  async submitComplete(): Promise<void> {
    if (this.completing) {
      return;
    }
    if (this.task === null) return;
    const pieces = this.task.items.length > 0 ? this.totalPieces() : Number(this.completePieces.trim());
    if (!Number.isSafeInteger(pieces) || pieces <= 0) {
      UiUtil.toast('请输入有效件数');
      return;
    }
    this.completing = true;
    try {
      // 已有明细直接完成，避免把总件数重复追加为另一条明细。
      // 如果完成请求失败，重试时已有这条明细，也不会再次新增。
      if (this.task.items.length === 0) {
        this.task = await TaskApi.addItem(this.taskId, this.completeWaybill.trim(), '', pieces);
      }
      this.task = await TaskApi.complete(this.taskId, '');
      UiUtil.toast('已完成取件');
      this.showComplete = false;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.completing = false;
    }
  }

  async doStart(): Promise<void> {
    try {
      this.task = await TaskApi.start(this.taskId);
      UiUtil.toast('已开始取件');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async doComplete(): Promise<void> {
    try {
      this.task = await TaskApi.complete(this.taskId, '');
      UiUtil.toast('已完成取件');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async doCancel(): Promise<void> {
    try {
      this.task = await TaskApi.cancel(this.taskId, '');
      UiUtil.toast('已取消任务');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  confirmComplete(): void {
    this.getUIContext().showAlertDialog({
      title: '完成取件',
      message: '确认完成该取件任务？',
      primaryButton: {
        value: '确认完成',
        action: () => { this.doComplete(); }
      },
      secondaryButton: {
        value: '取消',
        action: () => {}
      }
    });
  }

  confirmCancel(): void {
    this.getUIContext().showAlertDialog({
      title: '取消任务',
      message: '确认取消该取件任务？取消后不可恢复。',
      primaryButton: {
        value: '确认取消',
        action: () => { this.doCancel(); }
      },
      secondaryButton: {
        value: '返回',
        action: () => {}
      }
    });
  }

  copyFull(): void {
    if (this.task === null) {
      return;
    }
    const t = this.task;
    const text = '客户：' + t.customerName + '\n取件点：' + t.addressPointName + '\n地址：' + t.address +
      '\n联系人：' + t.contact + '\n电话：' + t.phone;
    UiUtil.copyText(text);
  }

  navigate(): void {
    if (this.task === null) {
      return;
    }
    UiUtil.navigate(this.getUIContext(), getContext(this) as common.UIAbilityContext, this.task.address);
  }

  photoUrl(p: TaskPhoto): string {
    return SessionStore.getBaseUrl() + p.filePath;
  }

  assistWorkerNames(): string {
    if (this.task === null) {
      return '';
    }
    const names: string[] = [];
    for (let i = 0; i < this.task.workers.length; i++) {
      const worker = this.task.workers[i];
      if (worker.role === 'assist' && worker.name !== '') {
        names.push(worker.name);
      }
    }
    return names.join('、');
  }

  @Builder
  AddItemDialog() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#66000000')
      .onClick(() => { if (!this.savingItem) this.showAddItem = false; })

      Column({ space: 12 }) {
        Text(this.editingItemId !== '' ? '编辑货物明细' : '新增货物明细')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
        // 收件员不需要填写品名
        if (normalizeRole(SessionStore.getUser()?.role ?? '') !== 'worker') {
          TextInput({ placeholder: '品名', text: this.itemGoodsName })
            .height(42)
            .onChange((v: string) => { this.itemGoodsName = v; })
            .enabled(!this.savingItem)
        }
        TextInput({ placeholder: '件数', text: this.itemPieces })
          .height(42)
          .type(InputType.Number)
          .onChange((v: string) => { this.itemPieces = v; })
          .enabled(!this.savingItem)
        Row({ space: 8 }) {
          TextInput({ placeholder: '面单号（可扫码）', text: this.itemWaybillNo })
            .height(42)
            .layoutWeight(1)
            .onChange((v: string) => { this.itemWaybillNo = v; })
            .enabled(!this.savingItem)
          Button('扫码')
            .height(42)
            .fontSize(14)
            .onClick(() => { this.scanItemWaybill(); })
            .enabled(!this.savingItem)
        }
        .width('100%')
        Row({ space: 10 }) {
          Button('取消')
            .height(42)
            .layoutWeight(1)
            .backgroundColor('#F2F3F5')
            .fontColor('#4E5969')
            .onClick(() => { this.showAddItem = false; })
            .enabled(!this.savingItem)
          Button(this.savingItem ? '保存中…' : '保存')
            .height(42)
            .layoutWeight(1)
            .onClick(() => { this.submitAddItem(); })
            .enabled(!this.savingItem)
        }
        .width('100%')
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
    .position({ x: 0, y: 0 })
    .zIndex(100)
  }

  // 完成取件弹窗：整合填数量（件数必填 + 面单可扫码）
  @Builder
  CompleteDialog() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#66000000')
      .onClick(() => {
        if (!this.completing) {
          this.showComplete = false;
        }
      })

      Column({ space: 12 }) {
        Text('完成取件')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
        Text(this.task !== null && this.task.items.length > 0 ? '本次共' + this.totalPieces() + '件' : '请确认本次取件件数')
          .fontSize(12)
          .fontColor('#86909C')
        if (this.task !== null && this.task.items.length > 0) {
          Text('件数和面单以货物明细为准，如需调整请先编辑明细')
            .fontSize(12)
            .fontColor('#86909C')
        } else {
          TextInput({ placeholder: '件数（必填）', text: this.completePieces })
            .height(44)
            .type(InputType.Number)
            .enabled(!this.completing)
            .onChange((v: string) => { this.completePieces = v; })
          Row({ space: 8 }) {
            TextInput({ placeholder: '面单号（选填，可扫码）', text: this.completeWaybill })
              .height(44)
              .layoutWeight(1)
              .enabled(!this.completing)
              .onChange((v: string) => { this.completeWaybill = v; })
            Button('扫码')
              .height(44)
              .fontSize(14)
              .enabled(!this.completing)
              .onClick(() => { this.scanCompleteWaybill(); })
          }
          .width('100%')
        }
        Row({ space: 10 }) {
          Button('取消')
            .height(44)
            .layoutWeight(1)
            .backgroundColor('#F2F3F5')
            .fontColor('#4E5969')
            .onClick(() => { this.showComplete = false; })
            .enabled(!this.completing)
          Button(this.completing ? '提交中...' : '确认完成')
            .height(44)
            .layoutWeight(1)
            .backgroundColor('#00B42A')
            .enabled(!this.completing)
            .onClick(() => { this.submitComplete(); })
        }
        .width('100%')
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
    .position({ x: 0, y: 0 })
    .zIndex(100)
  }

  @Builder
  SectionTitle(title: string) {
    Text(title)
      .fontSize(15)
      .fontWeight(FontWeight.Bold)
      .margin({ top: 16, bottom: 8 })
  }

  @Builder
  InfoRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontColor('#86909C')
        .width(90)
      Text(value)
        .fontSize(14)
        .fontColor('#182431')
        .layoutWeight(1)
        .textAlign(TextAlign.End)
    }
    .width('100%')
    .margin({ bottom: 8 })
  }

  @Builder
  ItemRow(item: PickupItem) {
    Column() {
      Row() {
        Text('件数：' + item.pieces + '件')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor('#182431')
        Blank()
        if (this.task !== null && this.task.status !== 'cancelled') {
          Button('编辑')
            .fontSize(13)
            .height(30)
            .fontColor('#0A59F7')
            .backgroundColor('#E8F3FF')
            .onClick(() => { this.openEditItem(item); })
        }
      }
      .width('100%')
      .margin({ bottom: 6 })
      Row() {
        Text(item.goodsName === '' ? '—' : item.goodsName)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#182431')
          .layoutWeight(1)
        Text(item.finalWeight > 0 ? item.finalWeight + ' kg' : '重量待回填')
          .fontSize(13)
          .fontColor(item.finalWeight > 0 ? '#00B42A' : '#86909C')
      }
      .width('100%')

      Row() {
        Text('票号：' + (item.waybillNo === '' ? '—' : item.waybillNo))
          .fontSize(12)
          .fontColor('#4E5969')
        Blank()
        Text(entryMethodLabel(item.entryMethod) + ' · ' + matchStatusLabel(item.matchStatus))
          .fontSize(12)
          .fontColor('#86909C')
      }
      .width('100%')
      .margin({ top: 4 })
    }
    .width('100%')
    .padding(10)
    .backgroundColor('#F7F8FA')
    .borderRadius(8)
    .margin({ bottom: 6 })
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .fontSize(14)
          .height(34)
          .onClick(() => { router.back(); })
        Text('任务详情')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        RefreshIconButton({ refreshing: this.loading, connected: this.connected, onRefresh: () => { this.load(); } })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      if (this.loading && this.task === null) {
        Column() {
          LoadingProgress().width(40).height(40)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.task === null) {
        Column() {
          Text('加载失败')
            .fontSize(15)
            .fontColor('#86909C')
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Scroll() {
          Column() {
            Row() {
              Text(taskStatusLabel(this.task.status))
                .fontSize(13)
                .fontColor('#FFFFFF')
                .padding({ left: 10, right: 10, top: 4, bottom: 4 })
                .backgroundColor(this.statusColor(this.task.status))
                .borderRadius(4)
              if (this.task.taskType === 'rush') {
                Text('赶 ' + fmtTime(this.task.rushShipTime) + ' 出货')
                  .fontSize(13)
                  .fontColor('#F53F3F')
                  .margin({ left: 8 })
              }
              Blank()
              Text(this.task.taskNo)
                .fontSize(12)
                .fontColor('#86909C')
            }
            .width('100%')
            .margin({ bottom: 12 })

            Column({ space: 8 }) {
              this.InfoRow('客户', this.task.customerName)
              this.InfoRow('取件点', this.task.addressPointName)
              this.InfoRow('区域', this.task.areaName === '' ? '—' : this.task.areaName)
              this.InfoRow('取件员', this.task.defaultWorkerName === '' ? '未分配' : this.task.defaultWorkerName)
              if (this.assistWorkerNames() !== '') {
                this.InfoRow('协助取件', this.assistWorkerNames())
              }
              this.InfoRow('派单客服', this.task.dispatchCsName === '' ? '—' : this.task.dispatchCsName)
              this.InfoRow('任务类型', this.typeLabel(this.task.taskType))
              this.InfoRow('派单时间', fmtTime(this.task.dispatchAt))
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)

            Column({ space: 6 }) {
              this.SectionTitle('取件地址')
              Text(this.task.address)
                .fontSize(15)
                .fontColor('#182431')
                .width('100%')
              Text('联系人：' + this.task.contact)
                .fontSize(14)
                .fontColor('#4E5969')
                .width('100%')
              Text('电话：' + this.task.phone)
                .fontSize(14)
                .fontColor('#4E5969')
                .width('100%')
              if (this.task.pickupNote !== '') {
                Text('取件备注：' + this.task.pickupNote)
                  .fontSize(13)
                  .fontColor('#FF7D00')
                  .width('100%')
              }
              if (this.task.internalNote !== '') {
                Text('内部备注：' + this.task.internalNote)
                  .fontSize(13)
                  .fontColor('#86909C')
                  .width('100%')
              }
              Row({ space: 8 }) {
                Button('复制信息')
                  .fontSize(13)
                  .height(34)
                  .layoutWeight(1)
                  .onClick(() => { this.copyFull(); })
                Button('拨号')
                  .fontSize(13)
                  .height(34)
                  .layoutWeight(1)
                  .onClick(() => {
                    if (this.task !== null) {
                      UiUtil.dial(getContext(this) as common.UIAbilityContext, this.task.phone);
                    }
                  })
                Button('导航')
                  .fontSize(13)
                  .height(34)
                  .layoutWeight(1)
                  .onClick(() => { this.navigate(); })
              }
              .width('100%')
              .margin({ top: 8 })
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ top: 10 })

            Column() {
              Text('货物明细（' + this.task.items.length + '）')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ top: 16, bottom: 8 })
              Text('共' + this.totalPieces() + '件')
                .fontSize(14)
                .fontColor('#0A59F7')
                .margin({ bottom: 10 })
              if (this.task.status === 'pending' || this.task.status === 'in_progress') {
                Button('+ 新增明细')
                  .width('100%')
                  .height(38)
                  .fontSize(14)
                  .margin({ bottom: 8 })
                  .onClick(() => { this.openAddItem(); })
              }
              if (this.task.items.length === 0) {
                Text('暂无货物明细')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                ForEach(this.task.items, (item: PickupItem) => {
                  this.ItemRow(item)
                }, (item: PickupItem) => JSON.stringify(item))
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ top: 10 })
            .alignItems(HorizontalAlign.Start)

            Column() {
              Text('取件照片（' + this.task.photos.length + '）')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ top: 16, bottom: 8 })
              if (this.task.status === 'pending' || this.task.status === 'in_progress') {
                Button(this.uploading ? '上传中...' : '上传照片')
                  .width('100%')
                  .height(40)
                  .fontSize(14)
                  .margin({ bottom: 10 })
                  .enabled(!this.uploading)
                  .onClick(() => { this.choosePhotoSource(); })
              }
              if (this.task.photos.length === 0) {
                Text('暂无照片')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                Scroll() {
                  Row({ space: 8 }) {
                    ForEach(this.task.photos, (p: TaskPhoto) => {
                      Image(this.photoUrl(p))
                        .width(90)
                        .height(90)
                        .borderRadius(6)
                        .objectFit(ImageFit.Cover)
                        .onError(() => {
                          hilog.error(0x0000, 'IMG_LOAD_ERR', 'url=%{public}s', this.photoUrl(p));
                        })
                        .onClick(() => { this.previewPhotoUrl = this.photoUrl(p); })
                    }, (p: TaskPhoto) => p.id)
                  }
                }
                .scrollable(ScrollDirection.Horizontal)
                .width('100%')
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ top: 10 })
            .alignItems(HorizontalAlign.Start)

            Column() {
              Text('异常（' + this.task.exceptions.length + '）')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ top: 16, bottom: 8 })
              if (this.task.exceptions.length === 0) {
                Text('无异常')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                ForEach(this.task.exceptions, (e: TaskException) => {
                  Column() {
                    Text(e.type + (e.resolved ? '（已处理）' : '（未处理）'))
                      .fontSize(13)
                      .fontWeight(FontWeight.Medium)
                      .fontColor(e.resolved ? '#00B42A' : '#FF7D00')
                    if (e.description !== '') {
                      Text(e.description)
                        .fontSize(12)
                        .fontColor('#4E5969')
                    }
                  }
                  .width('100%')
                  .padding(8)
                  .backgroundColor('#F7F8FA')
                  .borderRadius(6)
                  .margin({ bottom: 6 })
                  .alignItems(HorizontalAlign.Start)
                }, (e: TaskException) => e.id)
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ top: 10 })
            .alignItems(HorizontalAlign.Start)

            if (this.task.status === 'pending') {
              Button('开始取件')
                .width('100%')
                .height(46)
                .fontSize(16)
                .backgroundColor('#0A59F7')
                .margin({ top: 16 })
                .onClick(() => { this.doStart(); })
            }
            if (this.task.status === 'in_progress') {
              Button('完成取件')
                .width('100%')
                .height(46)
                .fontSize(16)
                .backgroundColor('#00B42A')
                .margin({ top: 16 })
                .onClick(() => { this.openComplete(); })
            }
            if (this.task.status === 'pending' || this.task.status === 'in_progress') {
              Button('取消任务')
                .width('100%')
                .height(44)
                .fontSize(15)
                .backgroundColor('#F53F3F')
                .margin({ top: 10 })
                .onClick(() => { this.confirmCancel(); })
            }

            Text(' ')
              .height(20)
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 4, bottom: 12 })
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.TopStart)
      }

      if (this.showAddItem) {
        this.AddItemDialog()
      }
      if (this.showComplete) {
        this.CompleteDialog()
      }

      // 照片全屏预览
      if (this.previewPhotoUrl !== '') {
        Stack({ alignContent: Alignment.Center }) {
          Column() {
          }
          .width('100%')
          .height('100%')
          .backgroundColor('#F53F3F00')
          .onClick(() => { this.previewPhotoUrl = ''; })

          Image(this.previewPhotoUrl)
            .width('94%')
            .objectFit(ImageFit.Contain)
            .borderRadius(8)
            .onClick(() => { this.previewPhotoUrl = ''; })
        }
        .width('100%')
        .height('100%')
        .position({ x: 0, y: 0 })
        .zIndex(400)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F2F5')
  }

  statusColor(status: string): string {
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

  typeLabel(taskType: string): string {
    if (taskType === 'scheduled') {
      return '指定时间';
    }
    if (taskType === 'rush') {
      return '赶出货';
    }
    return '普通';
  }
}

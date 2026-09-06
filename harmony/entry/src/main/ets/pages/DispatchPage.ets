import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { TaskApi } from '../api/TaskApi';
import { CustomerApi } from '../api/CustomerApi';
import { ApiClient, ApiError } from '../api/ApiClient';
import { EmployeeApi } from '../api/EmployeeApi';
import { AreaApi } from '../api/AreaApi';
import { UiUtil } from '../common/UiUtil';
import { Customer, CustomerAddress, WorkerOption, Area, PickupTask, CreateTaskRequest, WorkerCustomerOption } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { normalizeRole } from '../common/Constants';

@Entry
@Component
struct DispatchPage {
  @State menuOpen: boolean = false;
  @State isWorker: boolean = false;
  @State workerCustomers: WorkerCustomerOption[] = [];
  @State selectedWorkerCustomer: WorkerCustomerOption | null = null;
  @State searchingCustomers: boolean = false;
  @State hasMoreCustomers: boolean = false;
  @State customerSearchError: string = '';
  private customerSearchTimer: number = -1;
  private customerSearchRequest: number = 0;
  @State searchKeyword: string = '';
  @State customers: Customer[] = [];
  @State selectedCustomer: Customer | null = null;
  @State addresses: CustomerAddress[] = [];
  @State addressId: string = '';
  @State workers: WorkerOption[] = [];
  @State areas: Area[] = [];
  @State workerId: string = '';
  @State recommendName: string = '';
  @State taskType: string = 'normal';
  @State scheduledKind: string = 'before';
  @State scheduledTime: string = '';
  @State rushShipTime: string = '';
  @State rushReason: string = '';
  @State pickupNote: string = '';
  @State internalNote: string = '';
  @State submitting: boolean = false;
  @State workerScheduled: boolean = false;
  @State showDateTimePicker: boolean = false;
  @State pickTarget: string = 'scheduled';
  @State pickDate: Date = new Date();
  @State pickTime: Date = new Date();

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.isWorker = normalizeRole(SessionStore.getUser()?.role ?? '') === 'worker';
    this.loadOptions();
    const params = router.getParams() as Record<string, Object>;
    const customerId = params === null || params === undefined || params['customerId'] === undefined ? '' : String(params['customerId']);
    if (!this.isWorker && customerId !== '') this.preselectCustomer(customerId);
  }

  aboutToDisappear(): void {
    clearTimeout(this.customerSearchTimer);
    this.customerSearchRequest++;
    this.searchingCustomers = false;
  }

  changeWorkerSearch(value: string): void {
    // 已选中客户时，回填客户名触发的 onChange 不应清空选中（避免点两次）
    if (this.selectedWorkerCustomer !== null && value === this.selectedWorkerCustomer.customerName) {
      return;
    }
    this.searchKeyword = value;
    this.selectedWorkerCustomer = null;
    this.workerCustomers = [];
    this.hasMoreCustomers = false;
    this.customerSearchError = '';
    clearTimeout(this.customerSearchTimer);
    const request = ++this.customerSearchRequest;
    this.searchingCustomers = value.trim() !== '';
    if (!this.searchingCustomers) return;
    this.customerSearchTimer = setTimeout(() => { this.searchWorkerCustomers(value.trim(), request); }, 250);
  }

  async searchWorkerCustomers(query: string, request: number, append: boolean = false): Promise<void> {
    try {
      const options = await CustomerApi.workerOptions(query, append ? this.workerCustomers.length : 0);
      if (request === this.customerSearchRequest) {
        this.workerCustomers = append ? this.workerCustomers.concat(options) : options;
        this.hasMoreCustomers = options.length === 50;
      }
    } catch (e) {
      if (request === this.customerSearchRequest) this.customerSearchError = '搜索失败，请重新输入重试';
    } finally {
      if (request === this.customerSearchRequest) this.searchingCustomers = false;
    }
  }

  async loadMoreWorkerCustomers(): Promise<void> {
    if (this.searchingCustomers || !this.hasMoreCustomers || this.selectedWorkerCustomer !== null) return;
    this.searchingCustomers = true;
    this.customerSearchError = '';
    await this.searchWorkerCustomers(this.searchKeyword.trim(), ++this.customerSearchRequest, true);
  }

  selectWorkerCustomer(option: WorkerCustomerOption): void {
    if (this.submitting) return;
    clearTimeout(this.customerSearchTimer);
    this.customerSearchRequest++;
    this.selectedWorkerCustomer = option;
    this.workerCustomers = [];
    this.searchingCustomers = false;
    this.customerSearchError = '';
  }

  async preselectCustomer(id: string): Promise<void> {
    try {
      const customer = await CustomerApi.detail(id);
      this.customers = [customer];
      await this.selectCustomer(customer);
    } catch (e) { UiUtil.toast((e as ApiError).message); }
  }

  async loadOptions(): Promise<void> {
    if (this.isWorker) {
      this.workerId = SessionStore.getUser()?.courierId ?? '';
      return;
    }
    try {
      this.workers = await EmployeeApi.workers();
      this.areas = await AreaApi.list();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  // 打开日期时间选择器
  openDateTimePicker(target: string): void {
    this.pickTarget = target;
    const now = new Date();
    this.pickDate = now;
    this.pickTime = now;
    this.showDateTimePicker = true;
  }

  // 确认日期时间，拼接为 YYYY-MM-DDTHH:mm:ss
  confirmDateTime(): void {
    const y = this.pickDate.getFullYear();
    const m = this.pickDate.getMonth() + 1;
    const d = this.pickDate.getDate();
    const hh = this.pickTime.getHours();
    const mm = this.pickTime.getMinutes();
    const ss = this.pickTime.getSeconds();
    const pad = (n: number): string => (n < 10 ? '0' + n : '' + n);
    const value = y + '-' + pad(m) + '-' + pad(d) + 'T' + pad(hh) + ':' + pad(mm) + ':' + pad(ss);
    if (this.pickTarget === 'rush') {
      this.rushShipTime = value;
    } else {
      this.scheduledTime = value;
    }
    this.showDateTimePicker = false;
  }

  // 显示时间标签
  timeLabel(value: string): string {
    if (value === '') {
      return '点击选择时间';
    }
    return value.replace('T', ' ').substring(0, 16);
  }

  async searchCustomer(): Promise<void> {
    try {
      this.customers = await CustomerApi.list(this.searchKeyword);
      if (this.customers.length === 0) {
        UiUtil.toast('未找到客户');
      }
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async selectCustomer(c: Customer): Promise<void> {
    this.selectedCustomer = c;
    this.addresses = [];
    this.addressId = '';
    this.recommendName = '';
    try {
      const text = await ApiClient.get('/api/customers/' + c.id);
      const detail = JSON.parse(text) as Record<string, Object>;
      const addrList = detail['addresses'] as CustomerAddress[];
      for (let i = 0; i < addrList.length; i++) {
        if (addrList[i].isActive) {
          this.addresses.push(addrList[i]);
        }
      }
      if (this.addresses.length > 0) {
        this.addressId = this.addresses[0].id;
        this.applyRecommend(this.addresses[0]);
      }
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  selectAddress(a: CustomerAddress): void {
    this.addressId = a.id;
    this.applyRecommend(a);
  }

  applyRecommend(a: CustomerAddress): void {
    if (this.isWorker) return;
    if (a.areaId === '') {
      this.recommendName = '';
      return;
    }
    for (let i = 0; i < this.areas.length; i++) {
      if (this.areas[i].id === a.areaId) {
        this.recommendName = this.areas[i].defaultWorkerName;
        this.workerId = this.areas[i].defaultWorkerId;
        return;
      }
    }
    this.recommendName = '';
  }

  async submit(): Promise<void> {
    if (this.submitting) return;
    if (this.isWorker && (SessionStore.getUser()?.courierId ?? '') === '') {
      UiUtil.toast('账号未绑定取件员，请联系管理员');
      return;
    }
    if (this.isWorker && this.selectedWorkerCustomer === null) {
      UiUtil.toast('请从预览结果中选择客户');
      return;
    }
    if (!this.isWorker && (this.selectedCustomer === null || this.addressId === '')) {
      UiUtil.toast('请选择客户和取件地址');
      return;
    }
    if (!this.isWorker && this.taskType === 'rush' && (this.rushShipTime === '' || this.rushReason === '')) {
      UiUtil.toast('赶出货必须填写出货时间和加急原因');
      return;
    }
    if (!this.isWorker && this.taskType === 'scheduled' && this.scheduledTime === '') {
      UiUtil.toast('指定时间任务必须填写时间');
      return;
    }
    if (this.isWorker && this.workerScheduled && this.scheduledTime === '') {
      UiUtil.toast('预约取件需要选择时间');
      return;
    }
    this.submitting = true;
    try {
      const isScheduled = this.isWorker ? this.workerScheduled : this.taskType === 'scheduled';
      const body: CreateTaskRequest = {
        customerId: this.isWorker ? (this.selectedWorkerCustomer?.customerId ?? '') : (this.selectedCustomer?.id ?? ''),
        addressId: this.isWorker ? (this.selectedWorkerCustomer?.addressId ?? '') : this.addressId,
        workerId: this.isWorker ? (SessionStore.getUser()?.courierId ?? '') : this.workerId,
        taskType: isScheduled ? 'scheduled' : (this.isWorker ? 'normal' : this.taskType),
        scheduledKind: isScheduled ? (this.isWorker ? 'around' : this.scheduledKind) : '',
        scheduledTime: isScheduled ? this.scheduledTime : '',
        rushShipTime: this.taskType === 'rush' ? this.rushShipTime : '',
        rushReason: this.taskType === 'rush' ? this.rushReason : '',
        pickupNote: this.pickupNote,
        internalNote: this.internalNote
      };
      if (this.isWorker) {
        body.items = [];
        body.internalNote = '';
      }
      const task: PickupTask = await TaskApi.create(body);
      UiUtil.toast(this.isWorker ? '订单已新增，进入待取件' : '派单成功');
      router.replaceUrl({ url: 'pages/TaskDetailPage', params: { id: task.id } });
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.submitting = false;
    }
  }

  @Builder
  FieldLabel(title: string) {
    Text(title)
      .fontSize(14)
      .fontWeight(FontWeight.Medium)
      .fontColor('#182431')
      .margin({ bottom: 6 })
  }

  @Builder
  TypeOption(label: string, value: string) {
    Text(label)
      .fontSize(14)
      .fontColor(this.taskType === value ? '#0A59F7' : '#4E5969')
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .padding({ top: 8, bottom: 8 })
      .backgroundColor(this.taskType === value ? '#E8F3FF' : '#F2F3F5')
      .borderRadius(6)
      .onClick(() => { this.taskType = value; })
  }

  build() {
    Stack() {
      Column() {
      MobileHeader({ menuOpen: $menuOpen, title: this.isWorker ? '新增订单' : '新建取件', unreadCount: 0 })

      Scroll() {
        Column() {
          if (this.isWorker) {
            Column({ space: 12 }) {
              this.FieldLabel('客户名称')
              TextInput({ placeholder: '输入客户名称 / 拼音 / 首字母', text: this.searchKeyword })
                .height(46).maxLength(100).enabled(!this.submitting)
                .onChange((value: string) => { this.changeWorkerSearch(value); })
              Text('仅显示本人负责区域的客户，点选下方结果即可')
                .fontSize(12).fontColor('#86909C')
              if (this.searchingCustomers) {
                Text('正在搜索…').fontSize(13).fontColor('#86909C')
              } else if (this.customerSearchError !== '') {
                Text(this.customerSearchError).fontSize(13).fontColor('#F53F3F')
              } else if (this.selectedWorkerCustomer !== null) {
                Column({ space: 8 }) {
                  Text('已选：' + this.selectedWorkerCustomer.customerName).fontSize(16).fontColor('#0A59F7')
                  Text(this.selectedWorkerCustomer.areaName + ' · ' + this.selectedWorkerCustomer.address)
                    .fontSize(14).fontColor('#4E5969')
                  Text(this.selectedWorkerCustomer.contact + '  ' + this.selectedWorkerCustomer.phone)
                    .fontSize(13).fontColor('#86909C')
                }.width('100%').padding(12).borderRadius(8).backgroundColor('#E8F3FF').alignItems(HorizontalAlign.Start)
              } else if (this.workerCustomers.length > 0) {
                ForEach(this.workerCustomers, (option: WorkerCustomerOption) => {
                  Column({ space: 6 }) {
                    Text(option.customerName).fontSize(16).fontWeight(FontWeight.Medium).fontColor('#182431')
                    Text(option.areaName + ' · ' + option.address).fontSize(13).fontColor('#4E5969')
                    Text(option.contact + '  ' + option.phone).fontSize(12).fontColor('#86909C')
                  }.width('100%').padding(12).borderRadius(8).backgroundColor('#F7F8FA')
                  .alignItems(HorizontalAlign.Start).onClick(() => { this.selectWorkerCustomer(option); })
                }, (option: WorkerCustomerOption) => option.addressId)
                if (this.hasMoreCustomers) {
                  Button('加载更多客户地址').height(36).fontSize(13)
                    .onClick(() => { this.loadMoreWorkerCustomers(); })
                }
              } else if (this.searchKeyword.trim() !== '') {
                Text('本区域未找到可用客户，请核对名称或联系管理员维护客户及区域')
                  .fontSize(13).fontColor('#86909C')
              }
            }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).alignItems(HorizontalAlign.Start)

            // 预约取件时间（可选，不选即为普通任务）
            Column({ space: 8 }) {
              Row() {
                Text('预约取件时间').fontSize(14).fontWeight(FontWeight.Medium).fontColor('#182431')
                Blank()
                Toggle({ type: ToggleType.Switch, isOn: this.workerScheduled })
                  .onChange((isOn: boolean) => { this.workerScheduled = isOn; })
              }.width('100%')
              if (this.workerScheduled) {
                Row() {
                  Text(this.timeLabel(this.scheduledTime))
                    .fontSize(14)
                    .fontColor(this.scheduledTime === '' ? '#86909C' : '#182431')
                    .layoutWeight(1)
                  Text('📅').fontSize(16)
                }
                .height(44).borderRadius(8).backgroundColor('#F2F3F5').padding({ left: 12, right: 12 })
                .onClick(() => { this.openDateTimePicker('scheduled'); })
              }
            }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).margin({ top: 10 }).alignItems(HorizontalAlign.Start)

            Text('创建后进入待取件，货物件数在取件时填写')
              .fontSize(12).fontColor('#86909C').width('100%').margin({ top: 12 })
          }
          if (!this.isWorker) {
          Column({ space: 8 }) {
            this.FieldLabel('客户（必填）')
            Row({ space: 8 }) {
              TextInput({ placeholder: '搜索客户名称/电话', text: this.searchKeyword })
                .height(42)
                .layoutWeight(1)
                .onChange((v: string) => { this.searchKeyword = v; })
              Button('搜索')
                .height(42)
                .fontSize(14)
                .onClick(() => { this.searchCustomer(); })
            }
            .width('100%')

            if (this.selectedCustomer !== null) {
              Text('已选客户：' + this.selectedCustomer.name)
                .fontSize(14)
                .fontColor('#00B42A')
            }

            if (this.customers.length > 0) {
              ForEach(this.customers, (c: Customer) => {
                Row() {
                  Text(c.name)
                    .fontSize(14)
                    .layoutWeight(1)
                  Text(c.phone === '' ? '' : c.phone)
                    .fontSize(12)
                    .fontColor('#86909C')
                }
                .width('100%')
                .padding(10)
                .backgroundColor('#F7F8FA')
                .borderRadius(6)
                .onClick(() => { this.selectCustomer(c); })
              }, (c: Customer) => c.id)
            }
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .alignItems(HorizontalAlign.Start)

          Column({ space: 8 }) {
            this.FieldLabel('取件地址（必填）')
            if (this.addresses.length === 0) {
              Text('请先选择客户')
                .fontSize(13)
                .fontColor('#86909C')
            } else {
              ForEach(this.addresses, (a: CustomerAddress) => {
                Row() {
                  Text(a.name + ' · ' + a.address)
                    .fontSize(13)
                    .layoutWeight(1)
                    .fontColor(this.addressId === a.id ? '#0A59F7' : '#182431')
                }
                .width('100%')
                .padding(10)
                .backgroundColor(this.addressId === a.id ? '#E8F3FF' : '#F7F8FA')
                .borderRadius(6)
                .onClick(() => { this.selectAddress(a); })
              }, (a: CustomerAddress) => a.id)
            }
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .margin({ top: 10 })
          .alignItems(HorizontalAlign.Start)


          Column({ space: 8 }) {
            this.FieldLabel('取件员')
            Text('推荐：' + (this.recommendName === '' ? '暂无' : this.recommendName))
              .fontSize(13)
              .fontColor('#FF7D00')
            if (this.workers.length > 0) {
              Scroll() {
                Row({ space: 8 }) {
                  ForEach(this.workers, (w: WorkerOption) => {
                    Text(w.name)
                      .fontSize(13)
                      .fontColor(this.workerId === w.id ? '#0A59F7' : '#4E5969')
                      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                      .backgroundColor(this.workerId === w.id ? '#E8F3FF' : '#F2F3F5')
                      .borderRadius(16)
                      .onClick(() => { this.workerId = w.id; })
                  }, (w: WorkerOption) => w.id)
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

          Column({ space: 8 }) {
            this.FieldLabel('任务类型')
            Row({ space: 8 }) {
              this.TypeOption('普通', 'normal')
              this.TypeOption('指定时间', 'scheduled')
              this.TypeOption('赶出货', 'rush')
            }
            .width('100%')

            if (this.taskType === 'scheduled') {
              Text('时间类型')
                .fontSize(13)
                .fontColor('#4E5969')
              Row({ space: 8 }) {
                this.TypeOption('点前', 'before')
                this.TypeOption('点后', 'after')
                this.TypeOption('点左右', 'around')
              }
              .width('100%')
              Row() {
                Text(this.timeLabel(this.scheduledTime))
                  .fontSize(14)
                  .fontColor(this.scheduledTime === '' ? '#86909C' : '#182431')
                  .layoutWeight(1)
                Text('📅')
                  .fontSize(16)
              }
              .height(44)
              .borderRadius(8)
              .backgroundColor('#F2F3F5')
              .padding({ left: 12, right: 12 })
              .onClick(() => { this.openDateTimePicker('scheduled'); })
            }

            if (this.taskType === 'rush') {
              Row() {
                Text(this.timeLabel(this.rushShipTime))
                  .fontSize(14)
                  .fontColor(this.rushShipTime === '' ? '#86909C' : '#182431')
                  .layoutWeight(1)
                Text('📅')
                  .fontSize(16)
              }
              .height(44)
              .borderRadius(8)
              .backgroundColor('#F2F3F5')
              .padding({ left: 12, right: 12 })
              .onClick(() => { this.openDateTimePicker('rush'); })
              TextInput({ placeholder: '加急原因，如 客户下午航班', text: this.rushReason })
                .height(42)
                .onChange((v: string) => { this.rushReason = v; })
            }
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .margin({ top: 10 })
          .alignItems(HorizontalAlign.Start)

          Column({ space: 8 }) {
            this.FieldLabel('备注')
            TextInput({ placeholder: '取件备注', text: this.pickupNote })
              .height(42)
              .onChange((v: string) => { this.pickupNote = v; })
            if (!this.isWorker) {
            TextInput({ placeholder: '内部备注', text: this.internalNote })
              .height(42)
              .onChange((v: string) => { this.internalNote = v; })
            }
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .margin({ top: 10 })
          .alignItems(HorizontalAlign.Start)

          }

          Button(this.submitting ? '提交中...' : (this.isWorker ? '确认新增' : '确认派单'))
            .width('100%')
            .height(46)
            .fontSize(16)
            .margin({ top: 16, bottom: 20 })
            .enabled(!this.submitting && (!this.isWorker || this.selectedWorkerCustomer !== null))
            .onClick(() => { this.submit(); })
        }
        .width('100%')
        .padding(12)
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.TopStart)
    }
      .width('100%')
      .height('100%')
      .backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/DispatchPage' })

      // 日期时间选择弹窗
      if (this.showDateTimePicker) {
        Stack({ alignContent: Alignment.Bottom }) {
          Column() {
          }
          .width('100%')
          .height('100%')
          .backgroundColor('#66000000')
          .onClick(() => { this.showDateTimePicker = false; })

          Column({ space: 12 }) {
            Text('选择时间')
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
            Row({ space: 8 }) {
              Column() {
                Text('日期').fontSize(12).fontColor('#86909C').width('100%')
                DatePicker({ selected: this.pickDate })
                  .onChange((value: DatePickerResult) => {
                    if (value.year !== undefined && value.month !== undefined && value.day !== undefined) {
                      this.pickDate = new Date(value.year, value.month, value.day);
                    }
                  })
              }
              .layoutWeight(1)
              Column() {
                Text('时间').fontSize(12).fontColor('#86909C').width('100%')
                TimePicker({ selected: this.pickTime })
                  .onChange((value: TimePickerResult) => {
                    const hour = value.hour === undefined ? 0 : value.hour;
                    const minute = value.minute === undefined ? 0 : value.minute;
                    const second = value.second === undefined ? 0 : value.second;
                    this.pickTime = new Date(
                      this.pickDate.getFullYear(), this.pickDate.getMonth(), this.pickDate.getDate(),
                      hour, minute, second);
                  })
              }
              .layoutWeight(1)
            }
            .width('100%')
            Row({ space: 10 }) {
              Button('取消')
                .height(44)
                .layoutWeight(1)
                .backgroundColor('#F2F3F5')
                .fontColor('#4E5969')
                .onClick(() => { this.showDateTimePicker = false; })
              Button('确定')
                .height(44)
                .layoutWeight(1)
                .backgroundColor('#0A59F7')
                .onClick(() => { this.confirmDateTime(); })
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
        .zIndex(300)
      }
    }
    .width('100%').height('100%')
  }
}

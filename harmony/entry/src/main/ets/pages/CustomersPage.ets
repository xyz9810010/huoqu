import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { CustomerApi } from '../api/CustomerApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { Customer, CustomerCreateRequest } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { LoadingState, EmptyState, BackToTop } from '../components/PageComponents';

@Entry
@Component
struct CustomersPage {
  @State menuOpen: boolean = false;
  @State list: Customer[] = [];
  @State keyword: string = '';
  @State status: string = '';
  @State loading: boolean = false;
  @State createVisible: boolean = false;
  @State saving: boolean = false;
  @State formName: string = '';
  @State formContact: string = '';
  @State formPhone: string = '';
  @State formLegacyId: string = '';
  @State formImportantNote: string = '';
  @State formRemark: string = '';
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
      this.list = await CustomerApi.list(this.keyword.trim());
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  filtered(): Customer[] {
    if (this.status === '') return this.list;
    const result: Customer[] = [];
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].status === this.status) result.push(this.list[i]);
    }
    return result;
  }

  contactName(customer: Customer): string {
    return customer.contactName === undefined || customer.contactName === '' ? customer.contact : customer.contactName;
  }

  contactPhone(customer: Customer): string {
    return customer.contactPhone === undefined || customer.contactPhone === '' ? customer.phone : customer.contactPhone;
  }

  openCreate(): void {
    this.formName = '';
    this.formContact = '';
    this.formPhone = '';
    this.formLegacyId = '';
    this.formImportantNote = '';
    this.formRemark = '';
    this.createVisible = true;
  }

  async submitCreate(): Promise<void> {
    if (this.formName.trim() === '') {
      UiUtil.toast('请填写客户名称');
      return;
    }
    const body: CustomerCreateRequest = {
      name: this.formName.trim(), contactName: this.formContact.trim(), contactPhone: this.formPhone.trim(),
      legacyCustomerId: this.formLegacyId.trim(), importantNote: this.formImportantNote.trim(), remark: this.formRemark.trim()
    };
    this.saving = true;
    try {
      await CustomerApi.create(body);
      UiUtil.toast('创建成功');
      this.createVisible = false;
      await this.load();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.saving = false;
    }
  }

  dispatch(customer: Customer): void {
    router.pushUrl({ url: 'pages/DispatchPage', params: { customerId: customer.id } });
  }

  @Builder
  Field(label: string, value: string) {
    Row({ space: 8 }) {
      Text(label).width(88).fontSize(13).fontColor('#86909C')
      Text(value === '' ? '—' : value).layoutWeight(1).fontSize(13).fontColor('#182431').textAlign(TextAlign.End)
    }.width('100%').padding({ top: 6, bottom: 6 }).alignItems(VerticalAlign.Top)
  }

  @Builder
  CreateDialog() {
    if (this.createVisible) {
      Stack() {
        Column() {}.width('100%').height('100%').backgroundColor('#66000000')
          .onClick(() => { if (!this.saving) this.createVisible = false; })
        Scroll() {
          Column({ space: 12 }) {
            Text('新增客户').width('100%').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#182431')
            TextInput({ placeholder: '客户名称（必填）', text: this.formName }).height(44)
              .onChange((value: string) => { this.formName = value; })
            TextInput({ placeholder: '联系人', text: this.formContact }).height(44)
              .onChange((value: string) => { this.formContact = value; })
            TextInput({ placeholder: '联系电话', text: this.formPhone }).height(44).type(InputType.PhoneNumber)
              .onChange((value: string) => { this.formPhone = value; })
            TextInput({ placeholder: '原系统ID', text: this.formLegacyId }).height(44)
              .onChange((value: string) => { this.formLegacyId = value; })
            TextArea({ placeholder: '重要提醒', text: this.formImportantNote }).height(82)
              .onChange((value: string) => { this.formImportantNote = value; })
            TextArea({ placeholder: '备注', text: this.formRemark }).height(82)
              .onChange((value: string) => { this.formRemark = value; })
            Row({ space: 8 }) {
              Button('取消').layoutWeight(1).height(44).fontColor('#4E5969').backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.createVisible = false; })
              Button(this.saving ? '保存中…' : '保存').layoutWeight(1).height(44).backgroundColor('#0A59F7')
                .enabled(!this.saving).onClick(() => { this.submitCreate(); })
            }.width('100%').margin({ top: 4 })
          }.width('100%').padding(20).backgroundColor('#FFFFFF').borderRadius(12)
        }.width('calc(100% - 24vp)').constraintSize({ maxHeight: '88%' }).align(Alignment.Center)
      }.width('100%').height('100%').zIndex(300)
    }
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '客户管理', unreadCount: 0 })
        Scroll(this.scroller) {
          Column({ space: 12 }) {
            Text('客户管理').width('100%').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#182431')
            TextInput({ placeholder: '搜索名称/电话/原系统ID', text: this.keyword })
              .width('100%').height(44).borderRadius(8)
              .onChange((value: string) => { this.keyword = value; }).onSubmit(() => { this.load(); })
            Row({ space: 8 }) {
              ForEach(['', 'active', 'disabled'], (value: string) => {
                Text(value === '' ? '全部' : (value === 'active' ? '正常' : '停用'))
                  .layoutWeight(1).fontSize(13).textAlign(TextAlign.Center)
                  .fontColor(this.status === value ? '#0A59F7' : '#4E5969').height(40)
                  .backgroundColor(this.status === value ? '#E8F3FF' : '#FFFFFF')
                  .border({ width: 1, color: this.status === value ? '#0A59F7' : '#E5E6EB' }).borderRadius(8)
                  .onClick(() => { this.status = value; })
              }, (value: string) => value)
            }.width('100%')
            Row({ space: 8 }) {
              Button('查询').layoutWeight(1).height(44).backgroundColor('#0A59F7').onClick(() => { this.load(); })
              Button('新增客户').layoutWeight(1).height(44).backgroundColor('#00B42A').onClick(() => { this.openCreate(); })
            }.width('100%')
            if (this.loading) {
              LoadingState({ label: '正在加载客户' })
            } else if (this.filtered().length === 0) {
              EmptyState({ title: '暂无客户' })
            } else {
              ForEach(this.filtered(), (customer: Customer) => {
                Column() {
                  Row() {
                    Column({ space: 3 }) {
                      Text(customer.name).fontSize(15).fontWeight(FontWeight.Bold).fontColor('#182431')
                      Text(customer.customerNo === undefined || customer.customerNo === '' ? '暂无客户编号' : customer.customerNo)
                        .fontSize(12).fontColor('#86909C')
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                    Text(customer.status === 'disabled' ? '停用' : '正常')
                      .fontSize(12).fontColor(customer.status === 'disabled' ? '#86909C' : '#00B42A')
                      .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                      .backgroundColor(customer.status === 'disabled' ? '#F2F3F5' : '#E8FFEA').borderRadius(4)
                  }.width('100%').margin({ bottom: 4 })
                  this.Field('主客服', customer.mainCsName === undefined || customer.mainCsName === '' ? '未分配' : customer.mainCsName)
                  this.Field('联系人', this.contactName(customer))
                  this.Field('联系电话', this.contactPhone(customer))
                  this.Field('取件地址', customer.addressCount + ' 个')
                  Row({ space: 8 }) {
                    Button('派单').layoutWeight(1).height(44).fontSize(13).fontColor('#0A59F7')
                      .backgroundColor('#E8F3FF').onClick(() => { this.dispatch(customer); })
                    Button('详情').layoutWeight(1).height(44).fontSize(13).fontColor('#4E5969')
                      .backgroundColor('#FFFFFF').border({ width: 1, color: '#C9CDD4' })
                      .onClick(() => { router.pushUrl({ url: 'pages/CustomerDetailPage', params: { id: customer.id } }); })
                  }.width('100%').padding({ top: 10 }).border({ width: { top: 1 }, color: '#E5E6EB' })
                }.width('100%').padding(14).backgroundColor('#FFFFFF')
                  .border({ width: 1, color: '#E5E6EB' }).borderRadius(8)
              }, (customer: Customer) => customer.id)
            }
          }.width('100%').padding(12)
        }.width('100%').layoutWeight(1).align(Alignment.TopStart)
          .onScroll((xOffset: number, yOffset: number) => { this.showBackTop = yOffset > 500; })
      }.width('100%').height('100%').backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/CustomersPage' })
      this.CreateDialog()
      BackToTop({ show: this.showBackTop, onTop: () => {
        this.scroller.scrollEdge(Edge.Top);
        this.showBackTop = false;
      } })
        .position({ x: '86%', y: '82%' })
    }.width('100%').height('100%')
  }
}

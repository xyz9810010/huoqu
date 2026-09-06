import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { ApiClient } from '../api/ApiClient';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { Customer, CustomerAddress, CustomerDetail } from '../model/Models';

@Entry
@Component
struct CustomerDetailPage {
  @State customer: Customer | null = null;
  @State addresses: CustomerAddress[] = [];
  @State customerId: string = '';

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    const params = router.getParams() as Record<string, string>;
    this.customerId = params['id'];
    this.load();
  }

  async load(): Promise<void> {
    try {
      const text = await ApiClient.get('/api/customers/' + this.customerId);
      const detail = JSON.parse(text) as CustomerDetail;
      this.customer = detail;
      this.addresses = detail.addresses;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  @Builder
  InfoRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontColor('#86909C')
        .width(80)
      Text(value === '' ? '—' : value)
        .fontSize(14)
        .fontColor('#182431')
        .layoutWeight(1)
    }
    .width('100%')
    .margin({ bottom: 8 })
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .fontSize(14)
          .height(34)
          .onClick(() => { router.back(); })
        Text('客户详情')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text(' ')
          .width(50)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      if (this.customer === null) {
        LoadingProgress().width(40).height(40).margin({ top: 60 })
      } else {
        Scroll() {
          Column() {
            Column({ space: 8 }) {
              this.InfoRow('客户名称', this.customer.name)
              this.InfoRow('联系人', this.customer.contact)
              this.InfoRow('电话', this.customer.phone)
              this.InfoRow('地址', this.customer.address)
              this.InfoRow('备注', this.customer.note)
              if (this.customer.importantNote !== '') {
                this.InfoRow('重要备注', this.customer.importantNote)
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .alignItems(HorizontalAlign.Start)

            Column({ space: 8 }) {
              Text('地址点（' + this.addresses.length + '）')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ bottom: 6 })
              if (this.addresses.length === 0) {
                Text('无地址点')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                ForEach(this.addresses, (a: CustomerAddress) => {
                  Column() {
                    Row() {
                      Text(a.name + (a.isCommon ? '（常用）' : ''))
                        .fontSize(14)
                        .fontWeight(FontWeight.Medium)
                        .layoutWeight(1)
                      Text(a.isActive ? '启用' : '停用')
                        .fontSize(12)
                        .fontColor(a.isActive ? '#00B42A' : '#86909C')
                    }
                    .width('100%')
                    Text(a.address)
                      .fontSize(13)
                      .fontColor('#4E5969')
                      .margin({ top: 4 })
                  }
                  .width('100%')
                  .padding(10)
                  .backgroundColor('#F7F8FA')
                  .borderRadius(8)
                  .margin({ bottom: 6 })
                  .alignItems(HorizontalAlign.Start)
                }, (a: CustomerAddress) => a.id)
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .margin({ top: 10 })
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .padding(12)
        }
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.TopStart)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F2F5')
  }
}

import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { ApiClient, ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { ScanUtil } from '../common/ScanUtil';
import { TrackResult, TrackTimelineItem } from '../model/Models';
import { fmtTime } from '../common/Constants';

@Entry
@Component
struct TrackPage {
  @State mode: string = 'no';
  @State q: string = '';
  @State phone: string = '';
  @State surname: string = '';
  @State result: TrackResult | null = null;
  @State loading: boolean = false;

  async scanCode(): Promise<void> {
    const code = await ScanUtil.scan(getContext(this) as common.Context);
    if (code !== '') {
      this.q = code;
      this.search();
    }
  }

  async search(): Promise<void> {
    this.result = null;
    if (this.mode === 'no' && this.q.trim() === '') {
      UiUtil.toast('请输入订单号或面单号');
      return;
    }
    if (this.mode === 'phone' && (this.phone.trim() === '' || this.surname.trim() === '')) {
      UiUtil.toast('请输入手机号和姓氏');
      return;
    }
    this.loading = true;
    try {
      let path = '';
      if (this.mode === 'no') {
        path = '/api/track?q=' + encodeURIComponent(this.q.trim());
      } else {
        path = '/api/track?phone=' + encodeURIComponent(this.phone.trim()) + '&surname=' + encodeURIComponent(this.surname.trim());
      }
      const text = await ApiClient.get(path);
      this.result = JSON.parse(text) as TrackResult;
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  @Builder
  ModeTab(label: string, value: string) {
    Text(label)
      .fontSize(14)
      .fontColor(this.mode === value ? '#0A59F7' : '#4E5969')
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .padding({ top: 8, bottom: 8 })
      .backgroundColor(this.mode === value ? '#E8F3FF' : '#F2F3F5')
      .borderRadius(6)
      .onClick(() => {
        this.mode = value;
        this.result = null;
      })
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .fontSize(14)
          .height(34)
          .onClick(() => { router.back(); })
        Text('轨迹查单')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text(' ')
          .width(50)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      Column({ space: 12 }) {
        Row({ space: 8 }) {
          this.ModeTab('单号查询', 'no')
          this.ModeTab('手机号+姓氏', 'phone')
        }
        .width('100%')

        if (this.mode === 'no') {
          Row({ space: 8 }) {
            TextInput({ placeholder: '请输入订单号或面单号', text: this.q })
              .height(44)
              .layoutWeight(1)
              .onChange((v: string) => { this.q = v; })
            Button('扫码')
              .height(44)
              .fontSize(14)
              .onClick(() => { this.scanCode(); })
          }
          .width('100%')
        } else {
          TextInput({ placeholder: '手机号', text: this.phone })
            .height(44)
            .type(InputType.PhoneNumber)
            .onChange((v: string) => { this.phone = v; })
          TextInput({ placeholder: '姓氏（如 张）', text: this.surname })
            .height(44)
            .onChange((v: string) => { this.surname = v; })
        }

        Button(this.loading ? '查询中...' : '查询')
          .width('100%')
          .height(44)
          .enabled(!this.loading)
          .onClick(() => { this.search(); })
      }
      .width('100%')
      .padding(12)

      if (this.result !== null) {
        Scroll() {
          Column() {
            Column({ space: 8 }) {
              Row() {
                Text('状态')
                  .fontSize(14)
                  .fontColor('#86909C')
                Blank()
                Text(this.result.status)
                  .fontSize(16)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.statusColor(this.result.status))
              }
              .width('100%')
              Row() {
                Text('客户')
                  .fontSize(14)
                  .fontColor('#86909C')
                Blank()
                Text(this.result.customer)
                  .fontSize(14)
              }
              .width('100%')
              Row() {
                Text('件数')
                  .fontSize(14)
                  .fontColor('#86909C')
                Blank()
                Text(this.result.pieces + '')
                  .fontSize(14)
              }
              .width('100%')
              if (this.result.goods !== '') {
                Row() {
                  Text('品名')
                    .fontSize(14)
                    .fontColor('#86909C')
                  Blank()
                  Text(this.result.goods)
                    .fontSize(14)
                }
                .width('100%')
              }
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#FFFFFF')
            .borderRadius(10)
            .alignItems(HorizontalAlign.Start)

            Column() {
              Text('物流轨迹')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .margin({ bottom: 8 })
              if (this.result.timeline.length === 0) {
                Text('暂无轨迹')
                  .fontSize(13)
                  .fontColor('#86909C')
              } else {
                ForEach(this.result.timeline, (item: TrackTimelineItem, idx: number) => {
                  Row() {
                    Column() {
                      Circle()
                        .width(8)
                        .height(8)
                        .fill('#0A59F7')
                    }
                    .width(20)
                    .alignItems(HorizontalAlign.Center)
                    Column() {
                      Text(item.status)
                        .fontSize(14)
                        .fontWeight(FontWeight.Medium)
                      if (item.note !== '') {
                        Text(item.note)
                          .fontSize(12)
                          .fontColor('#4E5969')
                      }
                      Text(fmtTime(item.at) + (item.by === '' ? '' : ' · ' + item.by))
                        .fontSize(11)
                        .fontColor('#86909C')
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)
                  }
                  .width('100%')
                  .alignItems(VerticalAlign.Top)
                  .padding({ bottom: 10 })
                }, (item: TrackTimelineItem, idx: number) => item.at + idx)
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
      } else {
        Blank().layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F2F5')
  }

  statusColor(status: string): string {
    if (status === '已完成') {
      return '#00B42A';
    }
    if (status === '已取消') {
      return '#86909C';
    }
    if (status === '已取') {
      return '#0A59F7';
    }
    return '#FF7D00';
  }
}

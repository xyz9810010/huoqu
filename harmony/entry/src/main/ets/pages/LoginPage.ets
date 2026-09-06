import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { PushService } from '../service/PushService';
import { SseClient } from '../service/SseClient';
import { NotificationService } from '../service/NotificationService';
import { AuthApi } from '../api/AuthApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { Constants, homePageForRole, normalizeBaseUrl } from '../common/Constants';
import { LoginResponse } from '../model/Models';

@Entry
@Component
struct LoginPage {
  @State username: string = '';
  @State password: string = '';
  @State baseUrl: string = '';
  @State serverProtocol: string = 'http://';
  @State loading: boolean = false;

  aboutToAppear(): void {
    this.selectServer(SessionStore.getBaseUrl());
    if (SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: homePageForRole(SessionStore.role()) });
    }
  }

  selectServer(address: string): void {
    const normalized = normalizeBaseUrl(address);
    this.serverProtocol = normalized.startsWith('https://') ? 'https://' : 'http://';
    this.baseUrl = normalized.substring(this.serverProtocol.length);
  }

  build() {
    Scroll() {
    Column() {
      Column() {
        Column() {
          Text('取')
            .fontSize(30).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
            .width(68).height(68).borderRadius(18).backgroundColor('#0A59F7')
            .textAlign(TextAlign.Center).margin({ bottom: 18 })
          Text('Huoqu').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#182431')
          Text('Pickup Operations Management')
            .fontSize(14).fontColor('#86909C').margin({ top: 8 })
        }.width('100%').margin({ bottom: 36 })

        Column({ space: 16 }) {
          Column({ space: 8 }) {
            Text('服务端地址').fontSize(13).fontColor('#4E5969').width('100%')
            Row({ space: 8 }) {
              Select([{ value: 'HTTP' }, { value: 'HTTPS' }])
                .selected(this.serverProtocol === 'https://' ? 1 : 0)
                .value(this.serverProtocol === 'https://' ? 'HTTPS' : 'HTTP')
                .font({ size: 13 }).onSelect((index: number) => {
                  this.serverProtocol = index === 1 ? 'https://' : 'http://';
                })
              TextInput({ placeholder: '域名或 IP，可带端口', text: this.baseUrl })
                .height(46).borderRadius(8).fontSize(14).layoutWeight(1)
                .enabled(!this.loading)
                .onChange((value: string) => {
                  if (/^https?:/i.test(value.trim())) this.selectServer(value);
                  else this.baseUrl = value;
                })
            }.width('100%')
            Row({ space: 8 }) {
              Button('公网服务').fontSize(12).height(30).fontColor('#0A59F7').backgroundColor('#E8F3FF')
                .enabled(!this.loading).onClick(() => { this.selectServer('https://qj.9810010.xyz:1666'); })
              Button('局域网服务').fontSize(12).height(30).fontColor('#0A59F7').backgroundColor('#E8F3FF')
                .enabled(!this.loading).onClick(() => { this.selectServer(Constants.DEFAULT_BASE_URL); })
            }.width('100%')
            Text('无需输入协议前缀，登录时自动保存此地址')
              .fontSize(11).fontColor('#86909C').width('100%')
          }.width('100%')
          TextInput({ placeholder: '用户名', text: this.username })
            .height(48).borderRadius(8).fontSize(15)
            .onChange((value: string) => { this.username = value; })
          TextInput({ placeholder: '密码', text: this.password })
            .height(48).borderRadius(8).fontSize(15).type(InputType.Password)
            .showPasswordIcon(true)
            .onChange((value: string) => { this.password = value; })
            .onSubmit(() => { this.doLogin(); })
          Button(this.loading ? '登录中…' : '登 录')
            .width('100%').height(48).fontSize(16).borderRadius(8)
            .backgroundColor('#0A59F7').enabled(!this.loading).margin({ top: 8 })
            .onClick(() => { this.doLogin(); })
        }.width('100%')

        Divider().color('#E5E6EB').margin({ top: 28 })
        Text('请使用管理员分配的账号登录')
          .width('100%').fontSize(13).fontColor('#86909C').margin({ top: 18 })
      }
      .width('100%').padding({ left: 24, right: 24, top: 36, bottom: 28 })
      .backgroundColor('#FFFFFF').borderRadius(16)
      .border({ width: 1, color: '#E5E6EB' })
      .shadow({ radius: 20, color: '#0F1F2329', offsetY: 4 })

      Text('客服派单 · 取件员移动录单 · 老板经营看板')
        .fontSize(13).fontColor('#86909C').textAlign(TextAlign.Center)
        .lineHeight(22).margin({ top: 20 })
    }
    .width('100%').constraintSize({ minHeight: '100%' }).padding({ left: 16, right: 16, top: 24, bottom: 24 })
    .justifyContent(FlexAlign.Center).backgroundColor('#F1F2F5')
    }.width('100%').height('100%').backgroundColor('#F1F2F5')
  }

  async doLogin(): Promise<void> {
    if (this.loading) return;
    if (!/^[^\s\/@?#]+(?::[0-9]{1,5})?$/.test(this.baseUrl.trim())) {
      UiUtil.toast('请输入有效的域名或 IP 地址，可包含端口');
      return;
    }
    if (this.username.trim() === '' || this.password === '') {
      UiUtil.toast('请输入用户名和密码');
      return;
    }
    SessionStore.setBaseUrl(this.serverProtocol + this.baseUrl.trim());
    this.loading = true;
    try {
      const resp: LoginResponse = await AuthApi.login(this.username, this.password);
      SessionStore.setToken(resp.token);
      SessionStore.setUser(resp.user);
      PushService.register();
      SseClient.get().start();
      NotificationService.requestPermission();
      this.goHome(resp.user.role);
    } catch (e) {
      const err = e as ApiError;
      UiUtil.toast(err.message);
    } finally {
      this.loading = false;
    }
  }

  goHome(role: string): void {
    router.replaceUrl({ url: homePageForRole(role) });
  }
}

import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { AuthApi } from '../api/AuthApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { SseClient } from '../service/SseClient';

@Entry
@Component
struct SettingsPage {
  @State baseUrl: string = '';
  @State oldPwd: string = '';
  @State newPwd: string = '';
  @State newPwd2: string = '';

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    this.baseUrl = SessionStore.getBaseUrl();
  }

  saveServer(): void {
    if (this.baseUrl.trim() === '') {
      UiUtil.toast('请输入服务器地址');
      return;
    }
    SessionStore.setBaseUrl(this.baseUrl.trim());
    UiUtil.toast('服务器地址已保存');
  }

  async changePwd(): Promise<void> {
    if (this.newPwd.length < 6) {
      UiUtil.toast('新密码至少6位');
      return;
    }
    if (this.newPwd !== this.newPwd2) {
      UiUtil.toast('两次输入的新密码不一致');
      return;
    }
    try {
      await AuthApi.changePassword(this.oldPwd, this.newPwd);
      UiUtil.toast('密码修改成功');
      this.oldPwd = '';
      this.newPwd = '';
      this.newPwd2 = '';
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
  }

  async logout(): Promise<void> {
    try {
      await AuthApi.logout();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    }
    SseClient.get().stop();
    SessionStore.clear();
    router.replaceUrl({ url: 'pages/LoginPage' });
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .fontSize(14)
          .height(34)
          .onClick(() => { router.back(); })
        Text('设置')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text(' ')
          .width(50)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })

      Scroll() {
        Column() {
          Column({ space: 8 }) {
            Text('服务器地址')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
            TextInput({ placeholder: 'http://IP:3000', text: this.baseUrl })
              .height(44)
              .onChange((v: string) => { this.baseUrl = v; })
            Button('保存服务器地址')
              .width('100%')
              .height(40)
              .onClick(() => { this.saveServer(); })
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .alignItems(HorizontalAlign.Start)

          Column({ space: 8 }) {
            Text('修改密码')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
            TextInput({ placeholder: '原密码', text: this.oldPwd })
              .height(44)
              .type(InputType.Password)
              .onChange((v: string) => { this.oldPwd = v; })
            TextInput({ placeholder: '新密码（至少6位）', text: this.newPwd })
              .height(44)
              .type(InputType.Password)
              .onChange((v: string) => { this.newPwd = v; })
            TextInput({ placeholder: '确认新密码', text: this.newPwd2 })
              .height(44)
              .type(InputType.Password)
              .onChange((v: string) => { this.newPwd2 = v; })
            Button('修改密码')
              .width('100%')
              .height(40)
              .onClick(() => { this.changePwd(); })
          }
          .width('100%')
          .padding(14)
          .backgroundColor('#FFFFFF')
          .borderRadius(10)
          .margin({ top: 10 })
          .alignItems(HorizontalAlign.Start)

          Button('退出登录')
            .width('100%')
            .height(44)
            .backgroundColor('#F53F3F')
            .margin({ top: 20 })
            .onClick(() => { this.logout(); })
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
  }
}

import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { PushProviderApi } from '../api/PushProviderApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { normalizeRole, fmtTime } from '../common/Constants';
import { AppTheme } from '../common/Theme';
import { PushProvider, PushCredentialField, PushProviderFieldState } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { AppIcon } from '../components/AppIcon';
import { LoadingState, EmptyState } from '../components/PageComponents';

@Entry
@Component
struct PushProvidersPage {
  @State providers: PushProvider[] = [];
  @State loading: boolean = false;
  @State busyCode: string = '';
  @State busyAction: string = '';
  @State menuOpen: boolean = false;

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) {
      router.replaceUrl({ url: 'pages/LoginPage' });
      return;
    }
    if (normalizeRole(SessionStore.role()) !== 'admin') {
      router.replaceUrl({ url: 'pages/DashboardPage' });
      return;
    }
    this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      this.providers = await PushProviderApi.list();
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.loading = false;
    }
  }

  fieldState(provider: PushProvider, field: PushCredentialField): PushProviderFieldState | null {
    const state = provider.fields[field.key];
    return state === undefined ? null : state;
  }

  fieldValue(provider: PushProvider, field: PushCredentialField): string {
    const state = this.fieldState(provider, field);
    return state === null || state.value === undefined ? '' : state.value;
  }

  placeholder(provider: PushProvider, field: PushCredentialField): string {
    const state = this.fieldState(provider, field);
    if (field.secret && state !== null && state.configured) return '已安全保存，留空表示不修改';
    return '请输入' + field.label;
  }

  setField(providerIndex: number, field: PushCredentialField, value: string): void {
    const provider = this.providers[providerIndex];
    let state = provider.fields[field.key];
    if (state === undefined) {
      state = { configured: false, value: '', masked: '' };
      provider.fields[field.key] = state;
    }
    state.value = value;
    const refreshed: PushProvider[] = [];
    for (let i = 0; i < this.providers.length; i++) refreshed.push(this.providers[i]);
    this.providers = refreshed;
  }

  credentials(provider: PushProvider): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < provider.credentialSchema.length; i++) {
      const field = provider.credentialSchema[i];
      const value = this.fieldValue(provider, field);
      if (!field.secret || value !== '') result[field.key] = value;
    }
    return result;
  }

  replaceProvider(code: string, updated: PushProvider): void {
    const result: PushProvider[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const current = this.providers[i];
      if (current.code === code) {
        updated.code = current.code;
        if (updated.displayName === undefined || updated.displayName === '') updated.displayName = current.displayName;
        if (updated.platforms === undefined) updated.platforms = current.platforms;
        if (updated.credentialSchema === undefined) updated.credentialSchema = current.credentialSchema;
        result.push(updated);
      } else {
        result.push(current);
      }
    }
    this.providers = result;
  }

  async save(provider: PushProvider): Promise<void> {
    this.busyCode = provider.code;
    this.busyAction = 'save';
    try {
      const updated = await PushProviderApi.save(provider.code, this.credentials(provider));
      this.replaceProvider(provider.code, updated);
      UiUtil.toast('配置已安全保存，请继续执行连接测试');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.busyCode = '';
      this.busyAction = '';
    }
  }

  async testProvider(provider: PushProvider): Promise<void> {
    this.busyCode = provider.code;
    this.busyAction = 'test';
    try {
      const updated = await PushProviderApi.test(provider.code);
      this.replaceProvider(provider.code, updated);
      UiUtil.toast('连接测试通过，现在可以启用该通道');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.busyCode = '';
      this.busyAction = '';
    }
  }

  async setEnabled(provider: PushProvider, enabled: boolean): Promise<void> {
    this.busyCode = provider.code;
    this.busyAction = enabled ? 'enable' : 'disable';
    try {
      await PushProviderApi.setEnabled(provider.code, enabled);
      provider.enabled = enabled;
      this.replaceProvider(provider.code, provider);
      UiUtil.toast(enabled ? '推送通道已启用' : '推送通道已停用');
    } catch (e) {
      UiUtil.toast((e as ApiError).message);
    } finally {
      this.busyCode = '';
      this.busyAction = '';
    }
  }

  statusLabel(provider: PushProvider): string {
    if (provider.enabled) return '运行中';
    if (provider.healthStatus === 'failed') return '测试失败';
    if (provider.healthStatus === 'healthy') return '测试通过';
    if (provider.configured) return '待测试';
    return '未配置';
  }

  statusColor(provider: PushProvider): string {
    if (provider.enabled) return AppTheme.SUCCESS;
    if (provider.healthStatus === 'failed') return AppTheme.DANGER;
    if (provider.healthStatus === 'healthy' || provider.configured) return AppTheme.WARNING;
    return AppTheme.INFO;
  }

  isBusy(provider: PushProvider, action: string): boolean {
    return this.busyCode === provider.code && this.busyAction === action;
  }

  canEnable(provider: PushProvider): boolean {
    return provider.configured && provider.healthStatus === 'healthy' && provider.testedVersion === provider.configVersion;
  }

  @Builder
  ProviderCard(provider: PushProvider, providerIndex: number) {
    Column() {
      Row({ space: 11 }) {
        Column() { AppIcon({ name: 'push', iconSize: 19, color: AppTheme.PRIMARY }) }
          .width(36).height(36).borderRadius(9).backgroundColor(AppTheme.PRIMARY_TINT)
          .justifyContent(FlexAlign.Center)
        Column({ space: 3 }) {
          Text(provider.displayName).fontSize(15).fontWeight(FontWeight.Bold).fontColor(AppTheme.TEXT)
          Text(provider.platforms.length === 0 ? '通用平台' : provider.platforms.join(' · '))
            .fontSize(12).fontColor(AppTheme.MUTED)
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Text(this.statusLabel(provider)).fontSize(12).fontColor(this.statusColor(provider))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .border({ width: 1, color: this.statusColor(provider) }).borderRadius(6)
      }
      .width('100%').padding({ bottom: 14 })
      .border({ width: { bottom: 1 }, color: AppTheme.BORDER })

      Column({ space: 14 }) {
        ForEach(provider.credentialSchema, (field: PushCredentialField) => {
          Column({ space: 6 }) {
            Row({ space: 7 }) {
              Text(field.label).fontSize(13).fontColor(AppTheme.TEXT_SECONDARY)
              if (field.required) Text('必填').fontSize(11).fontColor(AppTheme.DANGER)
            }.width('100%')
            if (field.control === 'textarea') {
              TextArea({ placeholder: this.placeholder(provider, field), text: this.fieldValue(provider, field) })
                .height(112).width('100%').borderRadius(8)
                .onChange((value: string) => { this.setField(providerIndex, field, value); })
            } else {
              TextInput({ placeholder: this.placeholder(provider, field), text: this.fieldValue(provider, field) })
                .height(44).width('100%').borderRadius(8)
                .type(field.secret ? InputType.Password : InputType.Normal)
                .onChange((value: string) => { this.setField(providerIndex, field, value); })
            }
            if (field.secret && this.fieldState(provider, field) !== null && this.fieldState(provider, field)!.configured) {
              Row({ space: 4 }) {
                AppIcon({ name: 'lock', iconSize: 12, color: AppTheme.SUCCESS })
                Text('已加密保存').fontSize(11).fontColor(AppTheme.SUCCESS)
              }.width('100%')
            }
          }.width('100%').alignItems(HorizontalAlign.Start)
        }, (field: PushCredentialField) => field.key)
      }.width('100%').padding({ top: 16 })

      Row({ space: 12 }) {
        Text('配置版本 v' + provider.configVersion).fontSize(11).fontColor(AppTheme.MUTED)
        if (provider.lastTestedAt !== '') Text('最近测试 ' + fmtTime(provider.lastTestedAt)).fontSize(11).fontColor(AppTheme.MUTED)
        if (provider.lastErrorCode !== '') Text(provider.lastErrorCode).fontSize(11).fontColor(AppTheme.DANGER)
      }
      .width('100%').padding(10).margin({ top: 14, bottom: 14 })
      .border({ width: 1, color: AppTheme.BORDER }).borderRadius(7).backgroundColor('#F7F8FA')

      Row({ space: 8 }) {
        Button(this.isBusy(provider, 'save') ? '保存中' : '保存配置')
          .layoutWeight(1).height(44).fontSize(13).backgroundColor(AppTheme.PRIMARY)
          .enabled(this.busyCode === '').onClick(() => { this.save(provider); })
        Button(this.isBusy(provider, 'test') ? '测试中' : '连接测试')
          .layoutWeight(1).height(44).fontSize(13).fontColor(AppTheme.TEXT_SECONDARY)
          .backgroundColor(AppTheme.SURFACE).border({ width: 1, color: AppTheme.BORDER_STRONG })
          .enabled(provider.configured && this.busyCode === '').onClick(() => { this.testProvider(provider); })
      }.width('100%')
      Row({ space: 8 }) {
        Button(provider.enabled ? '停用' : '启用')
          .width('50%').height(44).fontSize(13)
          .fontColor(provider.enabled ? AppTheme.DANGER : AppTheme.SUCCESS)
          .backgroundColor(AppTheme.SURFACE)
          .border({ width: 1, color: provider.enabled ? AppTheme.DANGER : AppTheme.SUCCESS })
          .enabled(this.busyCode === '' && (provider.enabled || this.canEnable(provider)))
          .onClick(() => { this.setEnabled(provider, !provider.enabled); })
      }.width('100%').margin({ top: 8 })
    }
    .width('100%').padding(14).backgroundColor(AppTheme.SURFACE)
    .border({ width: 1, color: AppTheme.BORDER }).borderRadius(10)
    .shadow({ radius: 2, color: '#0A1F2329', offsetY: 1 })
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '消息推送', unreadCount: 0 })
        Scroll() {
          Column({ space: 16 }) {
            Row() {
              Column({ space: 6 }) {
                Text('消息推送').fontSize(18).fontWeight(FontWeight.Bold).fontColor(AppTheme.TEXT)
                Text('集中配置浏览器与系统级推送通道。配置通过测试后才能启用。')
                  .fontSize(13).fontColor(AppTheme.MUTED)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              Button() { AppIcon({ name: 'refresh', iconSize: 18, color: AppTheme.TEXT_SECONDARY }) }
                .width(40).height(40).borderRadius(8).backgroundColor(AppTheme.SURFACE)
                .border({ width: 1, color: AppTheme.BORDER })
                .enabled(!this.loading).onClick(() => { this.load(); })
            }.width('100%').alignItems(VerticalAlign.Top)
            Text('统一接入流程：填写凭据并保存 → 连接测试 → 启用通道')
              .width('100%').fontSize(13).fontColor(AppTheme.PRIMARY)
              .padding(12).backgroundColor(AppTheme.PRIMARY_TINT).borderRadius(8)
            if (this.loading) {
              LoadingState({ label: '正在加载推送通道' })
            } else if (this.providers.length === 0) {
              EmptyState({ title: '暂无已安装的推送适配器' })
            } else {
              ForEach(this.providers, (provider: PushProvider, index: number) => {
                this.ProviderCard(provider, index)
              }, (provider: PushProvider) => provider.code)
            }
          }
          .width('100%').padding(12)
        }.width('100%').layoutWeight(1).align(Alignment.TopStart)
      }.width('100%').height('100%').backgroundColor(AppTheme.PAGE_BG)
      MobileDrawer({ open: $menuOpen, activePath: 'pages/PushProvidersPage' })
    }.width('100%').height('100%')
  }
}

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window, router } from '@kit.ArkUI';
import { pushService } from '@kit.PushKit';
import { SessionStore } from '../store/SessionStore';
import { PushService } from '../service/PushService';
import { SseClient } from '../service/SseClient';
import { NotificationService } from '../service/NotificationService';
import { homePageForRole } from '../common/Constants';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    SessionStore.init(this.context);
    // 监听推送 token 更新
    try {
      pushService.on('tokenUpdate', this, (token: string) => {
        PushService.reportToken(token);
      });
    } catch (e) {
      // 推送未配置时忽略
    }
    this.handlePushClick(want);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.handlePushClick(want);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    const startPage = SessionStore.isLoggedIn()
      ? homePageForRole(SessionStore.role())
      : 'pages/LoginPage';
    windowStage.loadContent(startPage, (err) => {
      if (err.code) {
        return;
      }
      if (SessionStore.isLoggedIn()) {
        SseClient.get().start();
        PushService.register();
        NotificationService.requestPermission();
      }
    });
  }

  onForeground(): void {
    if (SessionStore.isLoggedIn()) {
      SseClient.get().start();
    }
  }

  // 处理推送点击跳转
  private handlePushClick(want: Want): void {
    const params = want.parameters;
    if (params === undefined) {
      return;
    }
    const resourceType = String(params['resourceType'] ?? '');
    const resourceId = String(params['resourceId'] ?? '');
    if (resourceType === 'pickupTask' && resourceId !== '') {
      if (SessionStore.isLoggedIn()) {
        router.pushUrl({ url: 'pages/TaskDetailPage', params: { id: resourceId } });
      }
    }
  }
}

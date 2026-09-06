import { pushService } from '@kit.PushKit';
import { NotificationApi } from '../api/NotificationApi';
import { hilog } from '@kit.PerformanceAnalysisKit';

// 华为推送服务：获取 token 并上报后端
export class PushService {
  private static readonly DOMAIN: number = 0x3200;
  private static readonly TAG: string = 'CargoPush';
  // 登录成功后调用：获取 token 并上报（失败不影响主流程）
  static async register(): Promise<void> {
    try {
      const token = await pushService.getToken();
      if (token !== '') {
        await NotificationApi.registerPush(token);
        hilog.info(PushService.DOMAIN, PushService.TAG, '%{public}s', 'Huawei token registered with server');
      }
    } catch (e) {
      hilog.error(PushService.DOMAIN, PushService.TAG, '%{public}s', 'Huawei push registration failed: ' + String(e));
    }
  }

  // 上报新 token（token 更新时调用）
  static reportToken(token: string): void {
    if (token === '') {
      return;
    }
    NotificationApi.registerPush(token).then(() => {
      hilog.info(PushService.DOMAIN, PushService.TAG, '%{public}s', 'Updated Huawei token registered with server');
    }).catch((e: Object) => {
      hilog.error(PushService.DOMAIN, PushService.TAG, '%{public}s', 'Huawei token update failed: ' + String(e));
    });
  }
}

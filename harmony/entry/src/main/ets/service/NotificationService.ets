import { notificationManager } from '@kit.NotificationKit';
import { common, wantAgent } from '@kit.AbilityKit';

export interface NotificationStatus {
  enabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

// 微信式系统通知服务
export class NotificationService {
  // 请求通知权限（登录后调用一次）
  static async requestPermission(): Promise<void> {
    try {
      await notificationManager.requestEnableNotification();
    } catch (e) {
      // 用户拒绝或已授权，忽略
    }
  }

  static async getStatus(): Promise<NotificationStatus> {
    const enabled = await notificationManager.isNotificationEnabled();
    try {
      const setting = await notificationManager.getNotificationSetting();
      return {
        enabled: enabled,
        soundEnabled: setting.soundEnabled,
        vibrationEnabled: setting.vibrationEnabled
      };
    } catch (e) {
      return { enabled: enabled, soundEnabled: false, vibrationEnabled: false };
    }
  }

  static openNotificationSettings(context: common.UIAbilityContext): void {
    notificationManager.openNotificationSettings(context).catch(() => {
    });
  }

  // 发系统通知（通知栏消息，点击跳转任务详情）
  static async show(title: string, text: string, taskId: string): Promise<void> {
    try {
      const enabled = await notificationManager.isNotificationEnabled();
      if (!enabled) {
        return;
      }
      await notificationManager.addSlot(notificationManager.SlotType.SOCIAL_COMMUNICATION).catch(() => {
      });
      const request: notificationManager.NotificationRequest = {
        id: Date.now() % 2147483647,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: title,
            text: text
          }
        },
        notificationSlotType: notificationManager.SlotType.SOCIAL_COMMUNICATION
      };
      if (taskId !== '') {
        try {
          const info: wantAgent.WantAgentInfo = {
            wants: [
              {
                bundleName: 'com.cargo.pickupstats',
                abilityName: 'EntryAbility',
                parameters: { resourceType: 'pickupTask', resourceId: taskId }
              }
            ],
            operationType: wantAgent.OperationType.START_ABILITY,
            requestCode: 0
          };
          const agent = await wantAgent.getWantAgent(info);
          request.wantAgent = agent;
        } catch (e) {
          // 点击跳转失败不影响通知展示
        }
      }
      await notificationManager.publish(request);
    } catch (e) {
      // 通知失败忽略，不影响主流程
    }
  }
}

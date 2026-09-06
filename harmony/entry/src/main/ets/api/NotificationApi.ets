import { ApiClient } from './ApiClient';
import { AppNotification, EmptyRequest, SubscriptionRequest, NotificationPreference,
  NotificationPreferenceRequest, NotificationSubscription } from '../model/Models';

export class NotificationApi {
  static async list(): Promise<AppNotification[]> {
    const text = await ApiClient.get('/api/notifications');
    return JSON.parse(text) as AppNotification[];
  }

  // 未读通知数（返回纯数字）
  static async unreadCount(): Promise<number> {
    try {
      const text = await ApiClient.get('/api/notifications/unread-count');
      const n = parseInt(text, 10);
      return isNaN(n) ? 0 : n;
    } catch (e) {
      return 0;
    }
  }

  static async markRead(id: string): Promise<void> {
    const body: EmptyRequest = {};
    await ApiClient.post('/api/notifications/' + id + '/read', body);
  }

  static async readAll(): Promise<void> {
    const body: EmptyRequest = {};
    await ApiClient.post('/api/notifications/read-all', body);
  }

  static async preferences(): Promise<NotificationPreference[]> {
    const text = await ApiClient.get('/api/v1/notification-preferences');
    return NotificationApi.unwrapArray<NotificationPreference>(text);
  }

  static async savePreference(body: NotificationPreferenceRequest): Promise<void> {
    await ApiClient.put('/api/v1/notification-preferences', body);
  }

  static async subscriptions(): Promise<NotificationSubscription[]> {
    const text = await ApiClient.get('/api/v1/notification-subscriptions');
    return NotificationApi.unwrapArray<NotificationSubscription>(text);
  }

  private static unwrapArray<T>(text: string): T[] {
    const parsed = JSON.parse(text) as Object;
    if (Array.isArray(parsed)) return parsed as T[];
    const obj = parsed as Record<string, Object>;
    return (obj['data'] === undefined ? [] : obj['data']) as T[];
  }

  // 上报华为推送设备订阅
  static async registerPush(token: string): Promise<void> {
    const body: SubscriptionRequest = {
      channel: 'vendor_push',
      providerCode: 'huawei',
      token: token,
      platform: 'harmonyos',
      deviceLabel: 'HarmonyOS Device',
      appVersion: '1.0.0'
    };
    await ApiClient.post('/api/v1/notification-subscriptions', body);
  }
}

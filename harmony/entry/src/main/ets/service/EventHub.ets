// 实时事件中心：SSE 事件分发
export type EventListener = (event: Record<string, Object>) => void;

export class EventHub {
  private static listeners: EventListener[] = [];

  static subscribe(listener: EventListener): () => void {
    EventHub.listeners.push(listener);
    return () => {
      const idx = EventHub.listeners.indexOf(listener);
      if (idx > -1) {
        EventHub.listeners.splice(idx, 1);
      }
    };
  }

  static publish(event: Record<string, Object>): void {
    for (let i = 0; i < EventHub.listeners.length; i++) {
      try {
        EventHub.listeners[i](event);
      } catch (e) {
        // 隔离监听器异常
      }
    }
  }

  // 判断是否任务相关事件（用于页面刷新）
  static isTaskEvent(event: Record<string, Object>): boolean {
    const type = String(event['type'] ?? '');
    return type.startsWith('task.') || type === 'notification.created';
  }

  // 从 notification.created 提取通知
  static extractNotification(event: Record<string, Object>): Record<string, Object> | null {
    const type = String(event['type'] ?? '');
    if (type !== 'notification.created') {
      return null;
    }
    const data = event['data'] as Record<string, Object>;
    if (data === undefined) {
      return null;
    }
    const notification = data['notification'] as Record<string, Object>;
    if (notification === undefined) {
      return null;
    }
    return notification;
  }

  // 提取任务 ID（用于跳转/更新）
  static taskIdFromEvent(event: Record<string, Object>): string {
    const notif = EventHub.extractNotification(event);
    if (notif !== null) {
      const data = notif['data'] as Record<string, Object>;
      if (data !== undefined && String(data['resourceType'] ?? '') === 'pickupTask') {
        return String(data['resourceId'] ?? '');
      }
    }
    const type = String(event['type'] ?? '');
    if (type.startsWith('task.')) {
      return String(event['taskId'] ?? '');
    }
    return '';
  }
}

import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { ApiClient } from '../api/ApiClient';
import { SessionStore } from '../store/SessionStore';
import { EventHub } from './EventHub';
import { EmptyRequest } from '../model/Models';

// SSE 实时事件客户端：ticket 换取 → 流式连接 → 解析分发 → 断线重连
export class SseClient {
  private static instance: SseClient | null = null;
  private req: http.HttpRequest | null = null;
  private buffer: string = '';
  private stopped: boolean = false;
  private reconnectTimer: number = -1;
  private decoder: util.TextDecoder = new util.TextDecoder('utf-8');

  static get(): SseClient {
    if (SseClient.instance === null) {
      SseClient.instance = new SseClient();
    }
    return SseClient.instance;
  }

  start(): void {
    if (this.req !== null || this.reconnectTimer !== -1) {
      this.stopped = false;
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.req !== null) {
      this.req.destroy();
      this.req = null;
    }
    if (this.reconnectTimer !== -1) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const body: EmptyRequest = {};
      const ticketText = await ApiClient.post('/api/v1/events/tickets', body);
      const ticketObj = JSON.parse(ticketText) as Record<string, Object>;
      const data = ticketObj['data'] as Record<string, Object>;
      const ticket = String(data['ticket'] ?? '');
      if (ticket === '') {
        this.scheduleReconnect();
        return;
      }
      const url = SessionStore.getBaseUrl() + '/api/v1/events?ticket=' + encodeURIComponent(ticket);
      const req = http.createHttp();
      this.req = req;
      this.buffer = '';
      const header: Record<string, string> = {};
      req.on('dataReceive', (chunk: ArrayBuffer) => {
        const text = this.decoder.decodeToString(new Uint8Array(chunk));
        this.handleChunk(text);
      });
      req.on('dataEnd', () => {
        this.req = null;
        EventHub.publish(SseClient.makeEvent('sse_disconnected'));
        this.scheduleReconnect();
      });
      req.requestInStream(url, {
        method: http.RequestMethod.GET,
        header: header
      }, (err) => {
        if (err) {
          EventHub.publish(SseClient.makeEvent('sse_disconnected'));
          this.scheduleReconnect();
        } else {
          EventHub.publish(SseClient.makeEvent('sse_connected'));
        }
      });
    } catch (e) {
      EventHub.publish(SseClient.makeEvent('sse_disconnected'));
      this.scheduleReconnect();
    }
  }

  private static makeEvent(type: string): Record<string, Object> {
    const evt: Record<string, Object> = {};
    evt['type'] = type;
    return evt;
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const frame = this.buffer.substring(0, idx);
      this.buffer = this.buffer.substring(idx + 2);
      this.parseFrame(frame);
      idx = this.buffer.indexOf('\n\n');
    }
  }

  private parseFrame(frame: string): void {
    let data = '';
    const lines = frame.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data:')) {
        data += lines[i].substring(5).trim();
      }
    }
    if (data === '') {
      return;
    }
    try {
      const evt = JSON.parse(data) as Record<string, Object>;
      // 只做页面内实时刷新（通知中心/未读数/任务列表）；系统通知统一由华为推送负责，避免重复弹窗
      EventHub.publish(evt);
    } catch (e) {
      // 忽略无法解析的数据帧
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer !== -1) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.connect();
    }, 3000);
  }
}

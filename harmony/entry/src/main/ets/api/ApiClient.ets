import { http } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { SessionStore } from '../store/SessionStore';

// 网络层封装：统一 Token 注入、响应处理、401 处理
export class ApiError extends Error {
  status: number = 0;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  static async get(path: string): Promise<string> {
    return ApiClient.doRequest(http.RequestMethod.GET, path, undefined);
  }

  static async post(path: string, body: Object): Promise<string> {
    return ApiClient.doRequest(http.RequestMethod.POST, path, body);
  }

  static async put(path: string, body: Object): Promise<string> {
    return ApiClient.doRequest(http.RequestMethod.PUT, path, body);
  }

  static async patch(path: string, body: Object | undefined): Promise<string> {
    const method = 'PATCH' as http.RequestMethod;
    return ApiClient.doRequest(method, path, body);
  }

  static async del(path: string): Promise<string> {
    return ApiClient.doRequest(http.RequestMethod.DELETE, path, undefined);
  }

  // multipart 文件上传：手动拼装 multipart/form-data body（multiFormDataList 的 data/filePath 均不可靠）
  static async upload(path: string, uris: string[]): Promise<string> {
    const url = SessionStore.getBaseUrl() + path;
    const req = http.createHttp();
    const header: Record<string, string> = {};
    const token = SessionStore.getToken();
    if (token !== '') {
      header['Authorization'] = 'Bearer ' + token;
    }
    const encoder = new util.TextEncoder();
    const CRLF: Uint8Array = encoder.encodeInto('\r\n');
    const boundary: string = '----HarmonyOSBoundary' + Date.now().toString(36);
    header['Content-Type'] = 'multipart/form-data; boundary=' + boundary;

    try {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < uris.length; i++) {
        const bytes: ArrayBuffer = ApiClient.readFileBytes(uris[i]);
        const contentType: string = ApiClient.detectImageType(bytes);
        const ext: string = ApiClient.extForType(contentType);
        // --boundary\r\n
        parts.push(encoder.encodeInto('--' + boundary + '\r\n'));
        // Content-Disposition: form-data; name="photo"; filename="photo0.jpg"\r\n
        parts.push(encoder.encodeInto(
          'Content-Disposition: form-data; name="photo"; filename="photo' + i + ext + '"\r\n'));
        // Content-Type: image/jpeg\r\n
        parts.push(encoder.encodeInto('Content-Type: ' + contentType + '\r\n'));
        // \r\n（空行分隔头部与文件体）
        parts.push(CRLF);
        // 文件二进制数据
        parts.push(new Uint8Array(bytes));
        // \r\n（part 分隔）
        parts.push(CRLF);
      }
      // 结束 boundary：--boundary--\r\n
      parts.push(encoder.encodeInto('--' + boundary + '--\r\n'));
      const body: ArrayBuffer = ApiClient.concatBuffers(parts);

      let resp: http.HttpResponse;
      try {
        resp = await req.request(url, {
          method: http.RequestMethod.POST,
          header: header,
          extraData: body,
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 30000,
          readTimeout: 30000
        });
      } catch (e) {
        throw new ApiError('上传失败，请重试', 0);
      } finally {
        req.destroy();
      }
      const status = resp.responseCode as number;
      const text = resp.result as string;
      if (status < 200 || status >= 300) {
        throw new ApiError(ApiClient.extractError(text), status);
      }
      return text;
    } catch (e) {
      req.destroy();
      if (e instanceof ApiError) {
        throw e;
      }
      throw new ApiError('上传失败，请重试', 0);
    }
  }

  private static concatBuffers(buffers: Uint8Array[]): ArrayBuffer {
    let total: number = 0;
    for (const buf of buffers) {
      total += buf.length;
    }
    const merged: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (const buf of buffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    return merged.buffer as ArrayBuffer;
  }

  // 读取照片文件（沙箱路径或 file:// URI）内容为 ArrayBuffer
  private static readFileBytes(uri: string): ArrayBuffer {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const total = fileIo.statSync(file.fd).size;
      const buffer = new ArrayBuffer(total);
      const n = fileIo.readSync(file.fd, buffer);
      if (n !== total) {
        throw new Error('照片读取不完整：' + n + '/' + total);
      }
      return buffer;
    } finally {
      fileIo.closeSync(file);
    }
  }

  // 依据文件魔数识别图片 MIME 类型
  private static detectImageType(data: ArrayBuffer): string {
    const b = new Uint8Array(data);
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
      return 'image/jpeg';
    }
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      return 'image/png';
    }
    if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return 'image/gif';
    }
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return 'image/webp';
    }
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return 'image/heic';
    }
    return 'image/jpeg';
  }

  private static extForType(contentType: string): string {
    if (contentType === 'image/png') {
      return '.png';
    }
    if (contentType === 'image/gif') {
      return '.gif';
    }
    if (contentType === 'image/webp') {
      return '.webp';
    }
    if (contentType === 'image/heic') {
      return '.heic';
    }
    if (contentType === 'image/heif') {
      return '.heif';
    }
    return '.jpg';
  }

  private static async doRequest(method: http.RequestMethod, path: string, body: Object | undefined): Promise<string> {
    const url = SessionStore.getBaseUrl() + path;
    const req = http.createHttp();
    const header: Record<string, string> = {};
    const token = SessionStore.getToken();
    if (token !== '') {
      header['Authorization'] = 'Bearer ' + token;
    }
    let resp: http.HttpResponse;
    try {
      resp = await req.request(url, {
        method: method,
        header: header,
        extraData: body === undefined ? undefined : JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 20000,
        readTimeout: 20000
      });
    } catch (e) {
      throw new ApiError('网络错误，请检查服务器地址与网络连接', 0);
    } finally {
      req.destroy();
    }
    const status = resp.responseCode as number;
    if (status === 401) {
      const respText = resp.result as string;
      let msg = '登录已过期，请重新登录';
      try {
        const parsed = JSON.parse(respText) as Record<string, Object>;
        if (parsed['kicked'] === true || (parsed['error'] !== undefined && String(parsed['error']).includes('别处登录'))) {
          msg = '账号已在别处登录，请重新登录';
        }
      } catch (e) {
        // 解析失败时用默认提示
      }
      SessionStore.clear();
      throw new ApiError(msg, status);
    }
    const text = resp.result as string;
    if (status < 200 || status >= 300) {
      throw new ApiError(ApiClient.extractError(text), status);
    }
    return text;
  }

  // 从错误响应体提取 error/message 字段
  static extractError(text: string): string {
    if (text === '') {
      return '请求失败';
    }
    const obj = JSON.parse(text) as Record<string, Object>;
    if (obj['error'] !== undefined) {
      return String(obj['error']);
    }
    if (obj['message'] !== undefined) {
      return String(obj['message']);
    }
    return '请求失败';
  }
}

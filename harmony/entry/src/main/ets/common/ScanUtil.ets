import { scanBarcode } from '@kit.ScanKit';
import { common } from '@kit.AbilityKit';

// 扫码工具：返回扫码结果字符串，失败/取消返回空串
export class ScanUtil {
  static async scan(context: common.Context): Promise<string> {
    try {
      const result = await scanBarcode.startScanForResult(context);
      return result.originalValue;
    } catch (e) {
      return '';
    }
  }
}

import { promptAction, UIContext } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { call } from '@kit.TelephonyKit';
import { petalMaps } from '@kit.MapKit';

// 通用 UI 工具
export class UiUtil {
  static toast(message: string): void {
    promptAction.showToast({ message: message, duration: 2000 });
  }

  static copyText(text: string): void {
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    const sys = pasteboard.getSystemPasteboard();
    sys.setData(data).catch(() => {
    });
  }

  // 拨号：拉起拨打电话页面，电话号码带过去
  static dial(context: common.UIAbilityContext, phone: string): void {
    if (phone === '') {
      promptAction.showToast({ message: '暂无联系电话', duration: 1500 });
      return;
    }
    call.makeCall(context, phone).catch(() => {
      promptAction.showToast({ message: '无法打开拨号', duration: 1500 });
    });
  }

  // 导航：由用户选择已安装的原生地图应用，不再回退网页。
  static navigate(uiContext: UIContext, context: common.UIAbilityContext, address: string): void {
    if (address === '') {
      promptAction.showToast({ message: '暂无地址', duration: 1500 });
      return;
    }
    uiContext.showActionSheet({
      title: '选择导航地图',
      message: '选择地图应用，直接开始导航',
      sheets: [
        {
          title: '高德地图',
          icon: $r('app.media.amap_icon'),
          action: () => { UiUtil.navigateAmap(context, address); }
        },
        {
          title: 'Petal Maps',
          icon: $r('app.media.petal_maps_icon'),
          action: () => { UiUtil.navigatePetal(context, address); }
        }
      ],
      confirm: { value: '取消', action: () => {} },
      autoCancel: true
    });
  }

  private static navigateAmap(context: common.UIAbilityContext, address: string): void {
    const want: Want = {
      action: 'ohos.want.action.viewData',
      uri: 'amapuri://route/plan/?dname=' + encodeURIComponent(address) +
        '&dev=0&t=0&sourceApplication=Huoqu'
    };
    context.startAbility(want).catch(() => {
      promptAction.showToast({ message: '未安装高德地图或无法打开', duration: 1800 });
    });
  }

  private static navigatePetal(context: common.UIAbilityContext, address: string): void {
    petalMaps.openMapTextSearch(context, { destinationName: address }).catch(() => {
      promptAction.showToast({ message: '未安装 Petal Maps 或无法打开', duration: 1800 });
    });
  }
}

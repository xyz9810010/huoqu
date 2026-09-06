import { AppTheme } from '../common/Theme';

@Component
export struct LoadingState {
  @Prop label: string = '加载中';

  build() {
    Column({ space: 10 }) {
      LoadingProgress().width(34).height(34).color(AppTheme.PRIMARY)
      Text(this.label).fontSize(13).fontColor(AppTheme.MUTED)
    }
    .width('100%')
    .padding({ top: 42, bottom: 42 })
  }
}

@Component
export struct EmptyState {
  @Prop title: string = '暂无数据';
  @Prop description: string = '';

  build() {
    Column({ space: 8 }) {
      Text('—').fontSize(28).fontColor(AppTheme.BORDER_STRONG)
      Text(this.title).fontSize(14).fontColor(AppTheme.TEXT_SECONDARY)
      if (this.description !== '') {
        Text(this.description).fontSize(12).fontColor(AppTheme.MUTED).textAlign(TextAlign.Center)
      }
    }
    .width('100%')
    .padding({ top: 42, bottom: 42, left: 24, right: 24 })
  }
}

@Component
export struct StatusPill {
  @Prop label: string = '';
  @Prop color: string = AppTheme.INFO;
  @Prop fillColor: string = '#F2F3F5';

  build() {
    Text(this.label)
      .fontSize(12)
      .fontColor(this.color)
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .backgroundColor(this.fillColor)
      .borderRadius(12)
  }
}

@Component
export struct MobileField {
  @Prop label: string = '';
  @Prop value: string = '';

  build() {
    Row({ space: 8 }) {
      Text(this.label).width(88).fontSize(13).fontColor(AppTheme.MUTED)
      Text(this.value === '' ? '—' : this.value)
        .layoutWeight(1)
        .fontSize(13)
        .fontColor(AppTheme.TEXT)
        .textAlign(TextAlign.End)
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
    .alignItems(VerticalAlign.Top)
  }
}

@Component
export struct RefreshIconButton {
  @Prop @Watch('onRefreshingChange') refreshing: boolean = false;
  @Prop connected: boolean = false;
  @State angle: number = 0;
  @State pressed: boolean = false;
  onRefresh: () => void = () => {};

  onRefreshingChange(): void {
    if (this.refreshing) {
      this.rotateStep();
    } else {
      this.angle = 0;
    }
  }

  // 刷新中持续旋转，结束后停在 0°（可靠停止）
  rotateStep(): void {
    if (!this.refreshing) {
      this.angle = 0;
      return;
    }
    this.getUIContext().animateTo({
      duration: 240,
      curve: Curve.Linear,
      onFinish: () => { this.rotateStep(); }
    }, () => {
      this.angle += 90;
    });
  }

  build() {
    Button() {
      Stack() {
        SymbolGlyph($r('sys.symbol.arrow_clockwise'))
          .fontSize(13)
          .fontColor([AppTheme.TEXT_SECONDARY])
          .rotate({ angle: this.angle })
        // 连接状态指示点：绿色=在线，灰色=离线
        Circle()
          .size({ width: 5, height: 5 })
          .fill(this.connected ? '#00B42A' : '#C9CDD4')
          .position({ x: '78%', y: '78%' })
      }
      .width('100%')
      .height('100%')
    }
    .width(22)
    .height(22)
    .padding(0)
    .borderRadius(11)
    .backgroundColor('#00000000')
    .scale({ x: this.pressed ? 0.8 : 1, y: this.pressed ? 0.8 : 1 })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressed = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => { this.onRefresh(); })
  }
}

// 一键回顶悬浮按钮：列表滚动超过阈值后显示
@Component
export struct BackToTop {
  @Prop show: boolean = false;
  onTop: () => void = () => {};

  build() {
    if (this.show) {
      Button('↑')
        .width(42)
        .height(42)
        .borderRadius(21)
        .fontSize(20)
        .fontColor(AppTheme.PRIMARY)
        .backgroundColor('#FFFFFF')
        .border({ width: 1, color: AppTheme.BORDER })
        .shadow({ radius: 10, color: '#1A000000', offsetY: 3 })
        .onClick(() => { this.onTop(); })
    }
  }
}

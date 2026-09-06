import { AppTheme } from '../common/Theme';

@Component
export struct AppIcon {
  @Prop name: string = '';
  @Prop iconSize: number = 18;
  @Prop color: string = AppTheme.TEXT_SECONDARY;

  iconResource(): Resource {
    if (this.name === 'menu') return $r('sys.symbol.open_sidebar');
    if (this.name === 'bell') return $r('sys.symbol.bell');
    if (this.name === 'dashboard') return $r('sys.symbol.square_grid_2x2');
    if (this.name === 'customer') return $r('sys.symbol.person_2');
    if (this.name === 'add') return $r('sys.symbol.circle_and_plus');
    if (this.name === 'task') return $r('sys.symbol.checkmark_clipboard');
    if (this.name === 'match') return $r('sys.symbol.square_link_square');
    if (this.name === 'worker') return $r('sys.symbol.person_3');
    if (this.name === 'chart') return $r('sys.symbol.histogram');
    if (this.name === 'area') return $r('sys.symbol.map');
    if (this.name === 'employee') return $r('sys.symbol.person_2_badge_flag');
    if (this.name === 'log') return $r('sys.symbol.doc_text');
    if (this.name === 'push') return $r('sys.symbol.paperplane');
    if (this.name === 'logout') return $r('sys.symbol.rectangle_and_arrowshape_turn_up_right');
    if (this.name === 'back') return $r('sys.symbol.arrow_left');
    if (this.name === 'refresh') return $r('sys.symbol.arrow_clockwise');
    if (this.name === 'lock') return $r('sys.symbol.ohos_lock');
    return $r('sys.symbol.circle');
  }

  build() {
    SymbolGlyph(this.iconResource())
      .fontSize(this.iconSize)
      .fontColor([this.color])
  }
}

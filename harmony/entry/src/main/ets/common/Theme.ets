export class AppTheme {
  static readonly PRIMARY: string = '#0A59F7';
  static readonly PRIMARY_TINT: string = '#E8F3FF';
  static readonly SUCCESS: string = '#00B42A';
  static readonly SUCCESS_TINT: string = '#E8FFEA';
  static readonly WARNING: string = '#FF7D00';
  static readonly WARNING_TINT: string = '#FFF3E8';
  static readonly DANGER: string = '#F53F3F';
  static readonly DANGER_TINT: string = '#FFECE8';
  static readonly INFO: string = '#86909C';
  static readonly PAGE_BG: string = '#F1F2F5';
  static readonly SIDE_BG: string = '#F7F8FA';
  static readonly SURFACE: string = '#FFFFFF';
  static readonly BORDER: string = '#E5E6EB';
  static readonly BORDER_STRONG: string = '#C9CDD4';
  static readonly TEXT: string = '#182431';
  static readonly TEXT_SECONDARY: string = '#4E5969';
  static readonly MUTED: string = '#86909C';
  static readonly DIVIDER: string = '#F2F3F5';
  static readonly CARD_RADIUS: number = 14;
  static readonly CONTROL_RADIUS: number = 10;
  static readonly SMALL_RADIUS: number = 8;
  static readonly PAGE_PADDING: number = 14;
  static readonly CONTROL_HEIGHT: number = 44;
  static readonly HEADER_HEIGHT: number = 56;
  static readonly DRAWER_WIDTH: number = 264;
}

export function statusColor(status: string): string {
  if (status === 'completed' || status === 'healthy' || status === 'enabled') {
    return AppTheme.SUCCESS;
  }
  if (status === 'pending' || status === 'healthy_disabled' || status === 'configured') {
    return AppTheme.WARNING;
  }
  if (status === 'failed' || status === 'rush') {
    return AppTheme.DANGER;
  }
  if (status === 'in_progress') {
    return AppTheme.PRIMARY;
  }
  return AppTheme.INFO;
}

export function statusBackground(status: string): string {
  if (status === 'completed' || status === 'healthy' || status === 'enabled') {
    return AppTheme.SUCCESS_TINT;
  }
  if (status === 'pending' || status === 'healthy_disabled' || status === 'configured') {
    return AppTheme.WARNING_TINT;
  }
  if (status === 'failed' || status === 'rush') {
    return AppTheme.DANGER_TINT;
  }
  if (status === 'in_progress') {
    return AppTheme.PRIMARY_TINT;
  }
  return '#F2F3F5';
}

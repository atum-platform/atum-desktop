import type { Locale } from '@/i18n'

export interface ComputerUseStatusCopy {
  title: string
  scope: (agent: string) => string
  description: string
  refresh: string
  checking: string
  ready: string
  notReady: string
  notInstalled: string
  unsupported: string
  unknown: string
  statusError: string
  retry: string
  driverHealth: string
  macPermissions: string
  accessibility: string
  screenRecording: string
  screenCapture: string
  granted: string
  notGranted: string
  captureAvailable: string
  captureUnavailable: string
  reopenDriver: string
  macDriverOnly: string
  localOnly: string
  nonMac: string
}

export const computerUseStatusCopy: Record<Locale, ComputerUseStatusCopy> = {
  en: {
    title: 'Computer use',
    scope: agent => `This Mac · ${agent}`,
    description:
      'Status for the selected local agent on this Mac. It cannot confirm a remote agent is ready or that control succeeded.',
    refresh: 'Refresh status',
    checking: 'Checking status…',
    ready: 'Ready',
    notReady: 'Not ready',
    notInstalled: 'CuaDriver is not installed',
    unsupported: 'Not supported on this system',
    unknown: 'Status unknown',
    statusError: 'Could not read Computer Use status. Try again.',
    retry: 'Try again',
    driverHealth: 'Driver health',
    macPermissions: 'CuaDriver permissions on this Mac',
    accessibility: 'Accessibility',
    screenRecording: 'Screen recording',
    screenCapture: 'Screen capture',
    granted: 'Granted',
    notGranted: 'Not granted',
    captureUnavailable: 'Capture unavailable',
    reopenDriver:
      'Screen recording is granted, but capture is currently unavailable. Reopen CuaDriver, then refresh this status.',
    captureAvailable: 'Available',
    macDriverOnly:
      'CuaDriver has a separate identity from Atum. In System Settings → Privacy & Security, enable Accessibility and Screen Recording for CuaDriver, then refresh.',
    localOnly:
      'This view reports the selected local agent on this Mac only. Normal chat remains available while you check it.',
    nonMac: 'On Windows and Linux, this is CuaDriver health only; macOS permission grants are not shown here.'
  },
  vi: {
    title: 'Computer use',
    scope: agent => `Máy Mac này · ${agent}`,
    description:
      'Trạng thái của agent cục bộ đang chọn trên máy Mac này. Không thể xác nhận agent từ xa đã sẵn sàng hay thao tác điều khiển đã thành công.',
    refresh: 'Làm mới trạng thái',
    checking: 'Đang kiểm tra trạng thái…',
    ready: 'Sẵn sàng',
    notReady: 'Chưa sẵn sàng',
    notInstalled: 'Chưa cài CuaDriver',
    unsupported: 'Không được hỗ trợ trên hệ thống này',
    unknown: 'Không rõ trạng thái',
    statusError: 'Không thể đọc trạng thái Computer Use. Hãy thử lại.',
    retry: 'Thử lại',
    driverHealth: 'Tình trạng driver',
    macPermissions: 'Quyền CuaDriver trên máy Mac này',
    accessibility: 'Trợ năng',
    screenRecording: 'Ghi màn hình',
    screenCapture: 'Chụp màn hình',
    granted: 'Đã cấp',
    notGranted: 'Chưa cấp',
    captureUnavailable: 'Không thể chụp',
    reopenDriver:
      'Đã cấp quyền ghi màn hình nhưng hiện chưa thể chụp. Hãy mở lại CuaDriver, rồi làm mới trạng thái này.',
    captureAvailable: 'Có thể chụp',
    macDriverOnly:
      'CuaDriver có danh tính riêng với Atum. Trong Cài đặt hệ thống → Quyền riêng tư & Bảo mật, hãy bật Trợ năng và Ghi màn hình cho CuaDriver, rồi làm mới.',
    localOnly:
      'Màn hình này chỉ báo trạng thái agent cục bộ đang chọn trên máy Mac này. Bạn vẫn có thể trò chuyện bình thường trong khi kiểm tra.',
    nonMac: 'Trên Windows và Linux, đây chỉ là tình trạng CuaDriver; quyền macOS không được hiển thị ở đây.'
  },
  ja: {
    title: 'コンピューター操作',
    scope: agent => `この Mac · ${agent}`,
    description:
      'この Mac で選択中のローカルエージェントの状態です。リモートエージェントの準備完了や操作成功は確認できません。',
    refresh: '状態を更新',
    checking: '状態を確認中…',
    ready: '準備完了',
    notReady: '未準備',
    notInstalled: 'CuaDriver は未インストールです',
    unsupported: 'このシステムでは未対応です',
    unknown: '状態不明',
    statusError: 'コンピューター操作の状態を読み取れませんでした。もう一度お試しください。',
    retry: '再試行',
    driverHealth: 'ドライバーの状態',
    macPermissions: 'この Mac の CuaDriver アクセス許可',
    accessibility: 'アクセシビリティ',
    screenRecording: '画面収録',
    screenCapture: '画面キャプチャ',
    granted: '許可済み',
    notGranted: '未許可',
    captureUnavailable: 'キャプチャ不可',
    reopenDriver:
      '画面収録は許可されていますが、現在キャプチャできません。CuaDriver を開き直してから、この状態を更新してください。',
    captureAvailable: '利用可能',
    macDriverOnly:
      'CuaDriver は Atum とは別の識別情報を持ちます。システム設定 → プライバシーとセキュリティで、CuaDriver のアクセシビリティと画面収録を有効にしてから更新してください。',
    localOnly:
      'この画面は、この Mac の選択中ローカルエージェントだけを報告します。確認中も通常のチャットは利用できます。',
    nonMac: 'Windows と Linux では CuaDriver の状態のみを表示します。macOS のアクセス許可はここには表示されません。'
  },
  zh: {
    title: '计算机使用',
    scope: agent => `此 Mac · ${agent}`,
    description: '此 Mac 上所选本地代理的状态。无法确认远程代理是否就绪，或控制是否成功。',
    refresh: '刷新状态',
    checking: '正在检查状态…',
    ready: '已就绪',
    notReady: '未就绪',
    notInstalled: '未安装 CuaDriver',
    unsupported: '此系统不支持',
    unknown: '状态未知',
    statusError: '无法读取计算机使用状态。请重试。',
    retry: '重试',
    driverHealth: '驱动程序健康状态',
    macPermissions: '此 Mac 上的 CuaDriver 权限',
    accessibility: '辅助功能',
    screenRecording: '屏幕录制',
    screenCapture: '屏幕捕获',
    granted: '已授予',
    notGranted: '未授予',
    captureUnavailable: '无法捕获',
    reopenDriver: '已授予屏幕录制权限，但当前无法捕获。请重新打开 CuaDriver，然后刷新此状态。',
    captureAvailable: '可用',
    macDriverOnly:
      'CuaDriver 与 Atum 有独立身份。请在系统设置 → 隐私与安全性中为 CuaDriver 启用辅助功能和屏幕录制，然后刷新。',
    localOnly: '此视图仅报告此 Mac 上所选本地代理。检查时仍可正常聊天。',
    nonMac: '在 Windows 和 Linux 上，这里只显示 CuaDriver 健康状态；不显示 macOS 权限。'
  },
  'zh-hant': {
    title: '電腦操作',
    scope: agent => `此 Mac · ${agent}`,
    description: '此 Mac 上所選本機代理程式的狀態。無法確認遠端代理程式是否就緒，或控制是否成功。',
    refresh: '重新整理狀態',
    checking: '正在檢查狀態…',
    ready: '已就緒',
    notReady: '未就緒',
    notInstalled: '尚未安裝 CuaDriver',
    unsupported: '此系統不支援',
    unknown: '狀態未知',
    statusError: '無法讀取電腦操作狀態。請再試一次。',
    retry: '再試一次',
    driverHealth: '驅動程式健康狀態',
    macPermissions: '此 Mac 上的 CuaDriver 權限',
    accessibility: '輔助使用',
    screenRecording: '螢幕錄製',
    screenCapture: '螢幕擷取',
    granted: '已授予',
    notGranted: '未授予',
    captureUnavailable: '無法擷取',
    reopenDriver: '已授予螢幕錄製權限，但目前無法擷取。請重新開啟 CuaDriver，然後重新整理此狀態。',
    captureAvailable: '可用',
    macDriverOnly:
      'CuaDriver 與 Atum 有獨立身分。請在系統設定 → 隱私權與安全性中為 CuaDriver 啟用輔助使用和螢幕錄製，然後重新整理。',
    localOnly: '此畫面只會報告此 Mac 上所選本機代理程式。檢查時仍可正常聊天。',
    nonMac: '在 Windows 和 Linux 上，這裡只顯示 CuaDriver 健康狀態；不會顯示 macOS 權限。'
  }
}

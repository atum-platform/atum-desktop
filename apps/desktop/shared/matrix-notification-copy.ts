import type { DesktopLocale } from './desktop-locale'
import type { MatrixNotificationLevel, MatrixNotificationOverride } from './matrix-notification-policy'

export interface MatrixNotificationCopy {
  accountLevel: string
  accountLevelHelp: string
  notifications: string
  quietHours: string
  quietHoursHelp: string
  from: string
  until: string
  timeZone: string
  failed: string
  readonly: string
  levels: Record<MatrixNotificationLevel, string>
  overrides: Record<MatrixNotificationOverride, string>
}

const copy: Record<DesktopLocale, MatrixNotificationCopy> = {
  en: {
    accountLevel: 'Team space messages',
    accountLevelHelp: 'Choose which messages can interrupt you.',
    notifications: 'Notifications',
    quietHours: 'Quiet hours',
    quietHoursHelp: 'Silence Team space banners and sounds during this daily window.',
    from: 'From',
    until: 'Until',
    timeZone: 'Time zone',
    failed: 'Could not save notification settings. Try again.',
    readonly: 'These settings need a newer Atum version.',
    levels: { all: 'All', mentions: 'Mentions & replies', nothing: 'Nothing' },
    overrides: { inherit: 'Use account default', all: 'All', mentions: 'Mentions & replies', nothing: 'Nothing' }
  },
  vi: {
    accountLevel: 'Tin nhắn Không gian nhóm',
    accountLevelHelp: 'Chọn tin nhắn nào có thể làm phiền bạn.',
    notifications: 'Thông báo',
    quietHours: 'Giờ yên tĩnh',
    quietHoursHelp: 'Tắt biểu ngữ và âm thanh Không gian nhóm trong khung giờ này mỗi ngày.',
    from: 'Từ',
    until: 'Đến',
    timeZone: 'Múi giờ',
    failed: 'Không lưu được cài đặt thông báo. Hãy thử lại.',
    readonly: 'Các cài đặt này cần phiên bản Atum mới hơn.',
    levels: { all: 'Tất cả', mentions: 'Nhắc đến và trả lời', nothing: 'Không có gì' },
    overrides: { inherit: 'Theo mặc định tài khoản', all: 'Tất cả', mentions: 'Nhắc đến và trả lời', nothing: 'Không có gì' }
  },
  ja: {
    accountLevel: 'チームスペースのメッセージ',
    accountLevelHelp: '通知するメッセージを選びます。',
    notifications: '通知',
    quietHours: '通知を休止する時間',
    quietHoursHelp: '毎日この時間帯は、チームスペースのバナーと音を停止します。',
    from: '開始',
    until: '終了',
    timeZone: 'タイムゾーン',
    failed: '通知設定を保存できませんでした。もう一度お試しください。',
    readonly: 'この設定には新しい Atum が必要です。',
    levels: { all: 'すべて', mentions: 'メンションと返信', nothing: 'なし' },
    overrides: { inherit: 'アカウントの初期設定', all: 'すべて', mentions: 'メンションと返信', nothing: 'なし' }
  },
  zh: {
    accountLevel: '团队空间消息',
    accountLevelHelp: '选择哪些消息可以打扰你。',
    notifications: '通知',
    quietHours: '免打扰时段',
    quietHoursHelp: '每天在此时段关闭团队空间的横幅和声音。',
    from: '开始',
    until: '结束',
    timeZone: '时区',
    failed: '无法保存通知设置，请重试。',
    readonly: '这些设置需要更新版本的 Atum。',
    levels: { all: '全部', mentions: '提及和回复', nothing: '无' },
    overrides: { inherit: '使用账户默认设置', all: '全部', mentions: '提及和回复', nothing: '无' }
  },
  'zh-hant': {
    accountLevel: '團隊空間訊息',
    accountLevelHelp: '選擇哪些訊息可以打擾你。',
    notifications: '通知',
    quietHours: '勿擾時段',
    quietHoursHelp: '每天在此時段關閉團隊空間的橫幅和聲音。',
    from: '開始',
    until: '結束',
    timeZone: '時區',
    failed: '無法儲存通知設定，請再試一次。',
    readonly: '這些設定需要更新版本的 Atum。',
    levels: { all: '全部', mentions: '提及與回覆', nothing: '無' },
    overrides: { inherit: '使用帳戶預設設定', all: '全部', mentions: '提及與回覆', nothing: '無' }
  }
}

export const matrixNotificationCopy = (locale: string): MatrixNotificationCopy =>
  copy[locale as DesktopLocale] ?? copy.vi

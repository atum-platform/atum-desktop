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
  roomModes: Record<MatrixNotificationOverride, string>
  roomModeHelp: Record<MatrixNotificationLevel, string>
  encryptedMentionsHelp: string
}

const copy: Record<DesktopLocale, MatrixNotificationCopy> = {
  en: {
    accountLevel: 'Team space thread messages',
    accountLevelHelp: 'Choose which replies can interrupt you in threads.',
    notifications: 'Notifications',
    quietHours: 'Quiet hours',
    quietHoursHelp: 'Silence Team space banners and sounds during this daily window.',
    from: 'From',
    until: 'Until',
    timeZone: 'Time zone',
    failed: 'Could not save notification settings. Try again.',
    readonly: 'These settings need a newer Atum version.',
    levels: { all: 'All', mentions: 'Mentions & replies', nothing: 'Nothing' },
    overrides: { inherit: 'Use account default', all: 'All', mentions: 'Mentions & replies', nothing: 'Nothing' },
    roomModes: { inherit: 'Restore default', all: 'All', mentions: 'Mentions & keywords', nothing: 'Off' },
    roomModeHelp: { all: 'Every new message', mentions: 'Mentions and your keywords', nothing: 'Silence this chat' },
    encryptedMentionsHelp: 'Mentions may be missed in encrypted chats'
  },
  vi: {
    accountLevel: 'Tin nhắn chủ đề trong Không gian nhóm',
    accountLevelHelp: 'Chọn phản hồi nào có thể làm phiền bạn trong chủ đề.',
    notifications: 'Thông báo',
    quietHours: 'Giờ yên tĩnh',
    quietHoursHelp: 'Tắt biểu ngữ và âm thanh Không gian nhóm trong khung giờ này mỗi ngày.',
    from: 'Từ',
    until: 'Đến',
    timeZone: 'Múi giờ',
    failed: 'Không lưu được cài đặt thông báo. Hãy thử lại.',
    readonly: 'Các cài đặt này cần phiên bản Atum mới hơn.',
    levels: { all: 'Tất cả', mentions: 'Nhắc đến và trả lời', nothing: 'Không có gì' },
    overrides: { inherit: 'Theo mặc định tài khoản', all: 'Tất cả', mentions: 'Nhắc đến và trả lời', nothing: 'Không có gì' },
    roomModes: { inherit: 'Khôi phục mặc định', all: 'Tất cả', mentions: 'Nhắc đến và từ khóa', nothing: 'Tắt' },
    roomModeHelp: { all: 'Mọi tin nhắn mới', mentions: 'Lượt nhắc đến và từ khóa của bạn', nothing: 'Tắt thông báo cuộc trò chuyện này' },
    encryptedMentionsHelp: 'Có thể bỏ sót lượt nhắc đến trong cuộc trò chuyện mã hóa'
  },
  ja: {
    accountLevel: 'チームスペースのスレッド通知',
    accountLevelHelp: 'スレッドで通知する返信を選びます。',
    notifications: '通知',
    quietHours: '通知を休止する時間',
    quietHoursHelp: '毎日この時間帯は、チームスペースのバナーと音を停止します。',
    from: '開始',
    until: '終了',
    timeZone: 'タイムゾーン',
    failed: '通知設定を保存できませんでした。もう一度お試しください。',
    readonly: 'この設定には新しい Atum が必要です。',
    levels: { all: 'すべて', mentions: 'メンションと返信', nothing: 'なし' },
    overrides: { inherit: 'アカウントの初期設定', all: 'すべて', mentions: 'メンションと返信', nothing: 'なし' },
    roomModes: { inherit: '既定に戻す', all: 'すべて', mentions: 'メンションとキーワード', nothing: 'オフ' },
    roomModeHelp: { all: 'すべての新着メッセージ', mentions: 'メンションと登録済みのキーワード', nothing: 'このチャットの通知を停止' },
    encryptedMentionsHelp: '暗号化されたチャットではメンションが届かないことがあります'
  },
  zh: {
    accountLevel: '团队空间话题消息',
    accountLevelHelp: '选择话题中哪些回复会提醒你。',
    notifications: '通知',
    quietHours: '免打扰时段',
    quietHoursHelp: '每天在此时段关闭团队空间的横幅和声音。',
    from: '开始',
    until: '结束',
    timeZone: '时区',
    failed: '无法保存通知设置，请重试。',
    readonly: '这些设置需要更新版本的 Atum。',
    levels: { all: '全部', mentions: '提及和回复', nothing: '无' },
    overrides: { inherit: '使用账户默认设置', all: '全部', mentions: '提及和回复', nothing: '无' },
    roomModes: { inherit: '恢复默认', all: '全部', mentions: '提及和关键词', nothing: '关闭' },
    roomModeHelp: { all: '每条新消息', mentions: '提及和你设置的关键词', nothing: '关闭此聊天的通知' },
    encryptedMentionsHelp: '加密聊天中的提及可能无法通知'
  },
  'zh-hant': {
    accountLevel: '團隊空間討論串訊息',
    accountLevelHelp: '選擇討論串中哪些回覆會提醒你。',
    notifications: '通知',
    quietHours: '勿擾時段',
    quietHoursHelp: '每天在此時段關閉團隊空間的橫幅和聲音。',
    from: '開始',
    until: '結束',
    timeZone: '時區',
    failed: '無法儲存通知設定，請再試一次。',
    readonly: '這些設定需要更新版本的 Atum。',
    levels: { all: '全部', mentions: '提及與回覆', nothing: '無' },
    overrides: { inherit: '使用帳戶預設設定', all: '全部', mentions: '提及與回覆', nothing: '無' },
    roomModes: { inherit: '恢復預設', all: '全部', mentions: '提及與關鍵字', nothing: '關閉' },
    roomModeHelp: { all: '每則新訊息', mentions: '提及和你設定的關鍵字', nothing: '關閉此聊天室的通知' },
    encryptedMentionsHelp: '加密聊天室中的提及可能無法通知'
  }
}

export const matrixNotificationCopy = (locale: string): MatrixNotificationCopy =>
  copy[locale as DesktopLocale] ?? copy.vi

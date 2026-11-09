import type { DesktopLocale } from './desktop-locale'

export interface MatrixPresenceCopy {
  status: string
  statusTitle: string
  statusDescription: string
  emoji: string
  emojiPlaceholder: string
  message: string
  messagePlaceholder: string
  expires: string
  thirtyMinutes: string
  oneHour: string
  fourHours: string
  today: string
  custom: string
  customTime: string
  dnd: string
  dndHelp: string
  clear: string
  cancel: string
  save: string
  saving: string
  failed: string
  online: string
  away: string
  offline: string
  doNotDisturb: string
}

const copy: Record<DesktopLocale, MatrixPresenceCopy> = {
  en: {
    status: 'Set status', statusTitle: 'Your status', statusDescription: 'Teammates can see this beside your name.',
    emoji: 'Emoji', emojiPlaceholder: '👋', message: 'Status', messagePlaceholder: 'What are you working on?',
    expires: 'Clear after', thirtyMinutes: '30 minutes', oneHour: '1 hour', fourHours: '4 hours', today: 'Today',
    custom: 'Custom', customTime: 'End time', dnd: 'Do not disturb', dndHelp: 'Silence Team space banners and sounds.',
    clear: 'Clear status', cancel: 'Cancel', save: 'Save', saving: 'Saving…', failed: 'Could not save your status. Try again.',
    online: 'Online', away: 'Away', offline: 'Offline', doNotDisturb: 'Do not disturb'
  },
  vi: {
    status: 'Đặt trạng thái', statusTitle: 'Trạng thái của bạn', statusDescription: 'Đồng nghiệp sẽ thấy trạng thái này cạnh tên bạn.',
    emoji: 'Biểu tượng', emojiPlaceholder: '👋', message: 'Trạng thái', messagePlaceholder: 'Bạn đang làm gì?',
    expires: 'Xóa sau', thirtyMinutes: '30 phút', oneHour: '1 giờ', fourHours: '4 giờ', today: 'Hôm nay',
    custom: 'Tùy chọn', customTime: 'Thời gian kết thúc', dnd: 'Đừng làm phiền', dndHelp: 'Tắt biểu ngữ và âm thanh Không gian nhóm.',
    clear: 'Xóa trạng thái', cancel: 'Hủy', save: 'Lưu', saving: 'Đang lưu…', failed: 'Không lưu được trạng thái. Hãy thử lại.',
    online: 'Đang trực tuyến', away: 'Vắng mặt', offline: 'Ngoại tuyến', doNotDisturb: 'Đừng làm phiền'
  },
  ja: {
    status: 'ステータスを設定', statusTitle: '自分のステータス', statusDescription: 'チームメイトに名前と一緒に表示されます。',
    emoji: '絵文字', emojiPlaceholder: '👋', message: 'ステータス', messagePlaceholder: '今何をしていますか？',
    expires: '自動解除', thirtyMinutes: '30分', oneHour: '1時間', fourHours: '4時間', today: '今日中',
    custom: 'カスタム', customTime: '終了時刻', dnd: '取り込み中', dndHelp: 'チームスペースのバナーと音を停止します。',
    clear: 'ステータスを解除', cancel: 'キャンセル', save: '保存', saving: '保存中…', failed: 'ステータスを保存できませんでした。もう一度お試しください。',
    online: 'オンライン', away: '離席中', offline: 'オフライン', doNotDisturb: '取り込み中'
  },
  zh: {
    status: '设置状态', statusTitle: '你的状态', statusDescription: '团队成员可以在你的名字旁看到此状态。',
    emoji: '表情', emojiPlaceholder: '👋', message: '状态', messagePlaceholder: '你正在做什么？',
    expires: '自动清除', thirtyMinutes: '30 分钟', oneHour: '1 小时', fourHours: '4 小时', today: '今天',
    custom: '自定义', customTime: '结束时间', dnd: '请勿打扰', dndHelp: '关闭团队空间的横幅和声音。',
    clear: '清除状态', cancel: '取消', save: '保存', saving: '正在保存…', failed: '无法保存状态。请重试。',
    online: '在线', away: '离开', offline: '离线', doNotDisturb: '请勿打扰'
  },
  'zh-hant': {
    status: '設定狀態', statusTitle: '你的狀態', statusDescription: '團隊成員可以在你的名字旁看到此狀態。',
    emoji: '表情符號', emojiPlaceholder: '👋', message: '狀態', messagePlaceholder: '你正在做什麼？',
    expires: '自動清除', thirtyMinutes: '30 分鐘', oneHour: '1 小時', fourHours: '4 小時', today: '今天',
    custom: '自訂', customTime: '結束時間', dnd: '請勿打擾', dndHelp: '關閉團隊空間的橫幅和聲音。',
    clear: '清除狀態', cancel: '取消', save: '儲存', saving: '正在儲存…', failed: '無法儲存狀態。請再試一次。',
    online: '上線', away: '離開', offline: '離線', doNotDisturb: '請勿打擾'
  }
}

export const matrixPresenceCopy = (locale: string): MatrixPresenceCopy =>
  copy[locale as DesktopLocale] ?? copy.vi

import type { Locale } from '@/i18n'

import type { FirstRunProvider } from '../../../shared/first-run-pick'

/**
 * The first chat's Connections block and Settings › Connections' automatic switch. English and Vietnamese are the owner's binding
 * copy (evidence/mockups-1127-r2/COPY.md §c, §d); Japanese and both Chinese scripts follow them line for line. Every fixed line
 * stays under 60 characters. A provider's name is the maker's product name in every language.
 */
export const FIRST_RUN_PROVIDER_NAMES: Record<FirstRunProvider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  antigravity: 'Antigravity',
  opencode: 'OpenCode'
}

export interface FirstRunConnectionsWords {
  /** The block's label column, and the Settings dialog's title. */
  header: string
  ready: string
  connect: string
  /** A free plan's sub-line under a Ready row. */
  freeLine(plan: string): string
  /** While the provider's own sign-in is open. */
  finishInBrowser: string
  /** The row's brief transition after a Connect. */
  connected: string
  autoTitle: string
  autoLine: string
  stopUsing: string
  /** The plan in use, in Settings. */
  inUse(plan: string): string
  /** The quiet bubble while the assistant writes its first greeting (screen readers). */
  greetingWriting(name: string): string
  /** Under the typing bubble once the welcome request has been sent again. */
  greetingRetrying: string
  /** The one quiet line when the retry went unanswered too. */
  greetingQuiet(name: string): string
  tryAgain: string
  /** The three groups of the one Connections list. */
  groups: { plans: string; accounts: string; mac: string }
  /** The disclosure under the list: the assistant reads these from the cloud. */
  cloudLine(name: string): string
  skipRest: string
  skipped: string
  connecting: string
  notAllowed: string
  unavailable: string
  openSettings: string
  restart: string
  failed: string
  /** This Mac's reach-down row (Remote Login under the hood). */
  macReach(name: string): string
  macReachLine: string
  macReachPassword: string
  fullDiskLine: string
}

const en: FirstRunConnectionsWords = {
  header: 'Connections',
  ready: 'Ready',
  connect: 'Connect',
  freeLine: plan => `${plan} · used for small tasks`,
  finishInBrowser: 'Finish in your browser',
  connected: 'Connected',
  autoTitle: 'Pick the best plan automatically',
  autoLine: 'For all your assistants, chats and schedules',
  stopUsing: 'Stop using',
  inUse: plan => `${plan} · your assistants use it`,
  greetingWriting: name => `${name} is writing…`,
  greetingRetrying: 'Taking a little longer…',
  greetingQuiet: name => `${name} isn’t answering yet.`,
  tryAgain: 'Try again',
  groups: { plans: 'AI plans', accounts: 'Accounts', mac: 'This Mac' },
  cloudLine: name => `${name} reads these from the cloud.`,
  skipRest: 'Skip the rest',
  skipped: 'Skipped',
  connecting: 'Connecting…',
  notAllowed: 'Not allowed',
  unavailable: 'Not available',
  openSettings: 'Open Settings',
  restart: 'Restart Atum',
  failed: 'Couldn’t finish that. Try again.',
  macReach: name => `Let ${name} use this Mac`,
  macReachLine: 'Apps, files and terminal',
  macReachPassword: 'Enter your Mac password',
  fullDiskLine: 'Allow Full Disk Access'
}

const vi: FirstRunConnectionsWords = {
  header: 'Kết nối',
  ready: 'Sẵn sàng',
  connect: 'Kết nối',
  freeLine: plan => `${plan} · dùng cho việc nhỏ`,
  finishInBrowser: 'Hoàn tất trên trình duyệt',
  connected: 'Đã kết nối',
  autoTitle: 'Tự động chọn gói phù hợp nhất',
  autoLine: 'Áp dụng cho mọi trợ lý, trò chuyện và tác vụ',
  stopUsing: 'Ngừng dùng',
  inUse: plan => `${plan} · trợ lý đang sử dụng`,
  greetingWriting: name => `${name} đang viết…`,
  greetingRetrying: 'Lâu hơn một chút…',
  greetingQuiet: name => `${name} chưa trả lời.`,
  tryAgain: 'Thử lại',
  groups: { plans: 'Gói AI', accounts: 'Tài khoản', mac: 'Máy Mac này' },
  cloudLine: name => `${name} đọc các mục này từ đám mây.`,
  skipRest: 'Bỏ qua phần còn lại',
  skipped: 'Đã bỏ qua',
  connecting: 'Đang kết nối…',
  notAllowed: 'Chưa cho phép',
  unavailable: 'Chưa dùng được',
  openSettings: 'Mở Cài đặt',
  restart: 'Mở lại Atum',
  failed: 'Chưa hoàn tất được. Hãy thử lại.',
  macReach: name => `Cho ${name} dùng máy Mac này`,
  macReachLine: 'Ứng dụng, tệp và terminal',
  macReachPassword: 'Nhập mật khẩu máy Mac',
  fullDiskLine: 'Cho phép Toàn quyền truy cập ổ đĩa'
}

const ja: FirstRunConnectionsWords = {
  header: '接続',
  ready: '準備完了',
  connect: '接続',
  freeLine: plan => `${plan}・小さな作業に使用`,
  finishInBrowser: 'ブラウザで完了してください',
  connected: '接続しました',
  autoTitle: '最適なプランを自動で選ぶ',
  autoLine: 'すべてのアシスタント、チャット、スケジュールに適用',
  stopUsing: '使用をやめる',
  inUse: plan => `${plan}・アシスタントが使用中`,
  greetingWriting: name => `${name}が入力中…`,
  greetingRetrying: '少し時間がかかっています…',
  greetingQuiet: name => `${name}からまだ返事がありません。`,
  tryAgain: 'もう一度',
  groups: { plans: 'AI プラン', accounts: 'アカウント', mac: 'この Mac' },
  cloudLine: name => `${name}はこれらをクラウドから読み取ります。`,
  skipRest: '残りをスキップ',
  skipped: 'スキップ済み',
  connecting: '接続中…',
  notAllowed: '許可されていません',
  unavailable: '利用できません',
  openSettings: '設定を開く',
  restart: 'Atum を再起動',
  failed: '完了できませんでした。もう一度お試しください。',
  macReach: name => `${name}にこの Mac を使わせる`,
  macReachLine: 'アプリ、ファイル、ターミナル',
  macReachPassword: 'Mac のパスワードを入力',
  fullDiskLine: 'フルディスクアクセスを許可'
}

const zh: FirstRunConnectionsWords = {
  header: '连接',
  ready: '已就绪',
  connect: '连接',
  freeLine: plan => `${plan} · 用于小任务`,
  finishInBrowser: '请在浏览器中完成',
  connected: '已连接',
  autoTitle: '自动选择最合适的方案',
  autoLine: '适用于所有助理、聊天和定时任务',
  stopUsing: '停止使用',
  inUse: plan => `${plan} · 你的助理正在使用`,
  greetingWriting: name => `${name} 正在输入…`,
  greetingRetrying: '需要再等一会儿…',
  greetingQuiet: name => `${name} 还没有回复。`,
  tryAgain: '重试',
  groups: { plans: 'AI 方案', accounts: '账户', mac: '这台 Mac' },
  cloudLine: name => `${name} 从云端读取这些内容。`,
  skipRest: '跳过其余',
  skipped: '已跳过',
  connecting: '正在连接…',
  notAllowed: '未允许',
  unavailable: '暂不可用',
  openSettings: '打开设置',
  restart: '重新启动 Atum',
  failed: '未能完成，请重试。',
  macReach: name => `让 ${name} 使用这台 Mac`,
  macReachLine: '应用、文件和终端',
  macReachPassword: '输入 Mac 密码',
  fullDiskLine: '允许完全磁盘访问'
}

const zhHant: FirstRunConnectionsWords = {
  header: '連線',
  ready: '已就緒',
  connect: '連線',
  freeLine: plan => `${plan} · 用於小任務`,
  finishInBrowser: '請在瀏覽器中完成',
  connected: '已連線',
  autoTitle: '自動選擇最合適的方案',
  autoLine: '適用於所有助理、聊天和排程',
  stopUsing: '停止使用',
  inUse: plan => `${plan} · 你的助理正在使用`,
  greetingWriting: name => `${name} 正在輸入…`,
  greetingRetrying: '需要再等一會兒…',
  greetingQuiet: name => `${name} 還沒有回覆。`,
  tryAgain: '重試',
  groups: { plans: 'AI 方案', accounts: '帳戶', mac: '這台 Mac' },
  cloudLine: name => `${name} 從雲端讀取這些內容。`,
  skipRest: '略過其餘',
  skipped: '已略過',
  connecting: '正在連線…',
  notAllowed: '未允許',
  unavailable: '暫不可用',
  openSettings: '開啟設定',
  restart: '重新啟動 Atum',
  failed: '未能完成，請重試。',
  macReach: name => `讓 ${name} 使用這台 Mac`,
  macReachLine: '應用程式、檔案和終端機',
  macReachPassword: '輸入 Mac 密碼',
  fullDiskLine: '允許完整磁碟取用權限'
}

export const FIRST_RUN_CONNECTIONS_COPY: Record<Locale, FirstRunConnectionsWords> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function firstRunConnectionsCopy(locale: Locale): FirstRunConnectionsWords {
  return FIRST_RUN_CONNECTIONS_COPY[locale] ?? en
}

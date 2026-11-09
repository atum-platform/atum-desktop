import { type Locale, useI18n } from '@/i18n'

import { type MatrixSettingsRevampCopy, matrixSettingsRevampCopy } from '../../shared/matrix-settings-revamp-copy'

/**
 * Settings' own words (DESIGN.md › Settings): the small labels that group the panes in
 * the sheet's navigation, the section titles inside a pane, and the label of the (?) that
 * holds a longer explanation. Kept beside the sheet (all five locales together) rather
 * than in the shared catalogs.
 */
interface MatrixSettingsLegacyCopy {
  /**
   * Promoted to the phone export (phone-export-keys.json), which still reads them; the desktop
   * no longer draws them. Keep their values until the phone's Settings follows the 2026-10-25
   * reorganisation .
   */
  navAccount: string
  navApp: string
  startup: string
  troubleshooting: string
  /** Settings › General. */
  display: string
  notifications: string
  startupSection: string
  /** Settings › Help: the software update, then sharing and feedback. */
  updates: string
  improve: string
  /** Settings › Privacy & security: the recovery key's section. */
  encryptedMessages: string
  /** The (?) beside a row or section whose explanation is longer than one line. */
  moreInfo: string
  /** Settings › This Mac › Technical details: the account check, as a row. */
  atumAccount: string
  atumAccountHelp: string
  /** That row's button; its accessible name stays the whole act ("Check your Atum account"). */
  check: string
}

/** Settings › Advanced › Subscriptions: account-wide plans and one compact sign-in. */
interface MatrixSettingsSubscriptionsCopy {
  subscriptions: string
  chatgptHelp: string
  opencodeHelp: string
  connect: string
  manage: string
  connected: string
  accountWide: string
  relayOn: string
  relayOnAnotherMac: string
  /** ChatGPT's one-line states (subscription-view.ts): everywhere, or this Mac while the cloud catches up. */
  chatgptReady: string
  chatgptCloudSettingUp: string
  chatgptCloudFailed: string
  /** The (?) beside the row in the two this-Mac states: why cloud assistants are different. */
  chatgptCloudTip: string
  /** The status itself could not be read. */
  statusUnavailable: string
  tryAgain: string
  signIn: string
  reconnect: string
  /** A saved ChatGPT sign-in that stopped working. */
  chatgptSignedOut: string
  disconnect: string
  waiting: string
  howItWorks: string
  chatgptSteps: [string, string, string, string]
  chatgptNote: string
  codeLabel: string
  openPage: string
  cancel: string
  keyLabel: string
  keyPlaceholder: string
  save: string
  saved: string
  failed: string
  working: string
  close: string
}

export interface MatrixSettingsCopy extends MatrixSettingsRevampCopy, MatrixSettingsLegacyCopy, MatrixSettingsSubscriptionsCopy {}

const copy: Record<Locale, MatrixSettingsLegacyCopy & MatrixSettingsSubscriptionsCopy> = {
  en: {
    display: 'Look',
    notifications: 'Notifications',
    navAccount: 'Account',
    navApp: 'Atum',
    startup: 'Startup and updates',
    troubleshooting: 'Troubleshooting',
    startupSection: 'Startup',
    updates: 'Updates',
    improve: 'Help improve Atum',
    encryptedMessages: 'Encrypted messages',
    moreInfo: 'More info',
    atumAccount: 'Atum account',
    atumAccountHelp: 'Your browser may open to confirm it’s you.',
    check: 'Check',
    subscriptions: 'Subscriptions',
    chatgptHelp: 'Use your Plus or Pro plan.',
    opencodeHelp: 'Use your OpenCode Go plan in the cloud and on this Mac.',
    connect: 'Connect',
    manage: 'Manage',
    connected: 'Connected',
    accountWide: 'Used by all your assistants',
    relayOn: 'Cloud assistants use ChatGPT through this Mac.',
    relayOnAnotherMac: 'Cloud assistants use ChatGPT through another Mac.',
    chatgptReady: 'Ready for all your assistants',
    chatgptCloudSettingUp: 'Works on this Mac. Setting up for cloud assistants…',
    chatgptCloudFailed: 'Works on this Mac. Not ready for cloud assistants yet.',
    chatgptCloudTip: 'Assistants on this Mac can use ChatGPT now. Cloud assistants use it through this Mac once setup finishes.',
    statusUnavailable: 'Couldn’t check your subscription.',
    tryAgain: 'Try again',
    signIn: 'Sign in',
    reconnect: 'Reconnect',
    chatgptSignedOut: 'ChatGPT needs you to sign in again.',
    disconnect: 'Disconnect',
    waiting: 'Waiting for you…',
    howItWorks: 'How it works',
    chatgptSteps: [
      'In ChatGPT, open Settings › Security and turn on “device code sign-in” if it’s off.',
      'Press Get a code. Atum opens OpenAI’s sign-in page.',
      'Type the code shown here and confirm.',
      'Come back here. Atum finishes by itself.'
    ],
    chatgptNote:
      'OpenAI hasn’t approved this sign-in for apps like Atum yet, so there is a small risk your account gets limited.',
    codeLabel: 'Your code',
    openPage: 'Open the sign-in page',
    cancel: 'Cancel',
    keyLabel: 'OpenCode Go key',
    keyPlaceholder: 'Paste your key',
    save: 'Save',
    saved: 'Saved',
    failed: 'Couldn’t connect. Try again.',
    working: 'Working…',
    close: 'Close',
  },
  vi: {
    display: 'Giao diện',
    notifications: 'Thông báo',
    navAccount: 'Tài khoản',
    navApp: 'Atum',
    startup: 'Khởi động và cập nhật',
    troubleshooting: 'Khắc phục sự cố',
    startupSection: 'Khởi động',
    updates: 'Cập nhật',
    improve: 'Giúp cải thiện Atum',
    encryptedMessages: 'Tin nhắn mã hóa',
    moreInfo: 'Thêm thông tin',
    atumAccount: 'Tài khoản Atum',
    atumAccountHelp: 'Trình duyệt có thể mở để xác nhận đó là bạn.',
    check: 'Kiểm tra',
    subscriptions: 'Gói đăng ký',
    chatgptHelp: 'Dùng gói Plus hoặc Pro của bạn.',
    opencodeHelp: 'Dùng gói OpenCode Go của bạn trên đám mây và trên máy này.',
    connect: 'Kết nối',
    manage: 'Quản lý',
    connected: 'Đã kết nối',
    accountWide: 'Dùng cho mọi trợ lý của bạn',
    relayOn: 'Trợ lý đám mây dùng ChatGPT qua máy Mac này.',
    relayOnAnotherMac: 'Trợ lý đám mây dùng ChatGPT qua một máy Mac khác.',
    chatgptReady: 'Sẵn sàng cho mọi trợ lý của bạn',
    chatgptCloudSettingUp: 'Đã dùng được trên máy này. Đang thiết lập cho trợ lý đám mây…',
    chatgptCloudFailed: 'Đã dùng được trên máy này. Trợ lý đám mây chưa dùng được.',
    chatgptCloudTip: 'Trợ lý trên máy này dùng được ChatGPT ngay. Trợ lý đám mây sẽ dùng qua máy này khi thiết lập xong.',
    statusUnavailable: 'Chưa kiểm tra được gói đăng ký của bạn.',
    tryAgain: 'Thử lại',
    signIn: 'Đăng nhập',
    reconnect: 'Kết nối lại',
    chatgptSignedOut: 'ChatGPT cần bạn đăng nhập lại.',
    disconnect: 'Ngắt kết nối',
    waiting: 'Đang chờ bạn…',
    howItWorks: 'Cách hoạt động',
    chatgptSteps: [
      'Trong ChatGPT, vào Cài đặt › Bảo mật và bật “Đăng nhập bằng mã thiết bị” nếu đang tắt.',
      'Bấm Lấy mã. Atum sẽ mở trang đăng nhập của OpenAI.',
      'Nhập mã hiện ở đây rồi xác nhận.',
      'Quay lại đây. Atum sẽ tự hoàn tất.'
    ],
    chatgptNote:
      'OpenAI chưa chính thức duyệt cách đăng nhập này cho ứng dụng như Atum, nên có một chút rủi ro tài khoản bị giới hạn.',
    codeLabel: 'Mã của bạn',
    openPage: 'Mở trang đăng nhập',
    cancel: 'Hủy',
    keyLabel: 'Khóa OpenCode Go',
    keyPlaceholder: 'Dán khóa của bạn',
    save: 'Lưu',
    saved: 'Đã lưu',
    failed: 'Chưa kết nối được. Bạn thử lại nhé.',
    working: 'Đang xử lý…',
    close: 'Đóng',
  },
  ja: {
    display: '外観',
    notifications: '通知',
    navAccount: 'アカウント',
    navApp: 'Atum',
    startup: '起動とアップデート',
    troubleshooting: 'トラブルシューティング',
    startupSection: '起動',
    updates: 'アップデート',
    improve: 'Atum の改善に協力',
    encryptedMessages: '暗号化されたメッセージ',
    moreInfo: '詳細',
    atumAccount: 'Atum アカウント',
    atumAccountHelp: '本人確認のためにブラウザが開くことがあります。',
    check: '確認',
    subscriptions: 'サブスクリプション',
    chatgptHelp: 'Plus または Pro プランを使います。',
    opencodeHelp: 'OpenCode Go のプランをクラウドでもこの Mac でも使えます。',
    connect: '接続',
    manage: '管理',
    connected: '接続済み',
    accountWide: 'すべてのアシスタントで使えます',
    relayOn: 'クラウドのアシスタントはこの Mac 経由で ChatGPT を使います。',
    relayOnAnotherMac: 'クラウドのアシスタントは別の Mac 経由で ChatGPT を使います。',
    chatgptReady: 'すべてのアシスタントで使えます',
    chatgptCloudSettingUp: 'この Mac で使えます。クラウドのアシスタント向けに準備しています…',
    chatgptCloudFailed: 'この Mac で使えます。クラウドのアシスタントではまだ使えません。',
    chatgptCloudTip: 'この Mac のアシスタントはすぐに ChatGPT を使えます。クラウドのアシスタントは準備ができるとこの Mac 経由で使います。',
    statusUnavailable: 'サブスクリプションを確認できませんでした。',
    tryAgain: 'もう一度',
    signIn: 'サインイン',
    reconnect: '再接続',
    chatgptSignedOut: 'ChatGPT にもう一度サインインしてください。',
    disconnect: '接続を解除',
    waiting: '確認をお待ちしています…',
    howItWorks: '仕組み',
    chatgptSteps: [
      'ChatGPT の 設定 › セキュリティ で「デバイスコードでのサインイン」がオフならオンにします。',
      '「コードを取得」を押すと、Atum が OpenAI のサインインページを開きます。',
      'ここに表示されたコードを入力して確認します。',
      'ここに戻ってください。Atum が自動で完了します。'
    ],
    chatgptNote:
      'OpenAI はまだ Atum のようなアプリでのこのサインインを承認していないため、アカウントが制限される小さなリスクがあります。',
    codeLabel: 'コード',
    openPage: 'サインインページを開く',
    cancel: 'キャンセル',
    keyLabel: 'OpenCode Go キー',
    keyPlaceholder: 'キーを貼り付け',
    save: '保存',
    saved: '保存しました',
    failed: '接続できませんでした。もう一度お試しください。',
    working: '処理中…',
    close: '閉じる',
  },
  zh: {
    display: '外观',
    notifications: '通知',
    navAccount: '账户',
    navApp: 'Atum',
    startup: '启动与更新',
    troubleshooting: '故障排除',
    startupSection: '启动',
    updates: '更新',
    improve: '帮助改进 Atum',
    encryptedMessages: '加密消息',
    moreInfo: '更多信息',
    atumAccount: 'Atum 账户',
    atumAccountHelp: '浏览器可能会打开以确认是你本人。',
    check: '检查',
    subscriptions: '订阅',
    chatgptHelp: '使用你的 Plus 或 Pro 方案。',
    opencodeHelp: '在云端和这台 Mac 上使用你的 OpenCode Go 方案。',
    connect: '连接',
    manage: '管理',
    connected: '已连接',
    accountWide: '适用于你的所有助理',
    relayOn: '云端助理通过这台 Mac 使用 ChatGPT。',
    relayOnAnotherMac: '云端助理通过另一台 Mac 使用 ChatGPT。',
    chatgptReady: '你的所有助理都能使用',
    chatgptCloudSettingUp: '已可在这台 Mac 上使用。正在为云端助理设置…',
    chatgptCloudFailed: '已可在这台 Mac 上使用。云端助理暂时还不能使用。',
    chatgptCloudTip: '这台 Mac 上的助理现在就能使用 ChatGPT。设置完成后，云端助理会通过这台 Mac 使用它。',
    statusUnavailable: '无法检查你的订阅。',
    tryAgain: '重试',
    signIn: '登录',
    reconnect: '重新连接',
    chatgptSignedOut: 'ChatGPT 需要你重新登录。',
    disconnect: '断开连接',
    waiting: '正在等待你…',
    howItWorks: '如何运作',
    chatgptSteps: [
      '在 ChatGPT 的 设置 › 安全 中，如果“设备码登录”已关闭，请打开。',
      '点按“获取代码”，Atum 会打开 OpenAI 的登录页面。',
      '输入这里显示的代码并确认。',
      '回到这里，Atum 会自动完成。'
    ],
    chatgptNote: 'OpenAI 尚未正式批准 Atum 这类应用使用此登录方式，因此账户有小概率受到限制。',
    codeLabel: '你的代码',
    openPage: '打开登录页面',
    cancel: '取消',
    keyLabel: 'OpenCode Go 密钥',
    keyPlaceholder: '粘贴你的密钥',
    save: '保存',
    saved: '已保存',
    failed: '无法连接。请重试。',
    working: '处理中…',
    close: '关闭',
  },
  'zh-hant': {
    display: '外觀',
    notifications: '通知',
    navAccount: '帳戶',
    navApp: 'Atum',
    startup: '啟動與更新',
    troubleshooting: '疑難排解',
    startupSection: '啟動',
    updates: '更新',
    improve: '協助改善 Atum',
    encryptedMessages: '加密訊息',
    moreInfo: '更多資訊',
    atumAccount: 'Atum 帳號',
    atumAccountHelp: '瀏覽器可能會開啟以確認是你本人。',
    check: '檢查',
    subscriptions: '訂閱',
    chatgptHelp: '使用你的 Plus 或 Pro 方案。',
    opencodeHelp: '在雲端和這台 Mac 上使用你的 OpenCode Go 方案。',
    connect: '連接',
    manage: '管理',
    connected: '已連接',
    accountWide: '適用於你的所有助理',
    relayOn: '雲端助理透過這台 Mac 使用 ChatGPT。',
    relayOnAnotherMac: '雲端助理透過另一台 Mac 使用 ChatGPT。',
    chatgptReady: '你的所有助理都能使用',
    chatgptCloudSettingUp: '已可在這台 Mac 上使用。正在為雲端助理設定…',
    chatgptCloudFailed: '已可在這台 Mac 上使用。雲端助理暫時還不能使用。',
    chatgptCloudTip: '這台 Mac 上的助理現在就能使用 ChatGPT。設定完成後，雲端助理會透過這台 Mac 使用它。',
    statusUnavailable: '無法檢查你的訂閱。',
    tryAgain: '重試',
    signIn: '登入',
    reconnect: '重新連接',
    chatgptSignedOut: 'ChatGPT 需要你重新登入。',
    disconnect: '中斷連接',
    waiting: '正在等待你…',
    howItWorks: '如何運作',
    chatgptSteps: [
      '在 ChatGPT 的 設定 › 安全性 中，如果「裝置代碼登入」已關閉，請開啟。',
      '點按「取得代碼」，Atum 會開啟 OpenAI 的登入頁面。',
      '輸入這裡顯示的代碼並確認。',
      '回到這裡，Atum 會自動完成。'
    ],
    chatgptNote: 'OpenAI 尚未正式核准 Atum 這類應用程式使用此登入方式，因此帳戶有小機率受到限制。',
    codeLabel: '你的代碼',
    openPage: '開啟登入頁面',
    cancel: '取消',
    keyLabel: 'OpenCode Go 金鑰',
    keyPlaceholder: '貼上你的金鑰',
    save: '儲存',
    saved: '已儲存',
    failed: '無法連接。請重試。',
    working: '處理中…',
    close: '關閉',
  }
}

export function matrixSettingsCopy(locale: Locale): MatrixSettingsCopy {
  return { ...matrixSettingsRevampCopy(locale), ...(copy[locale] ?? copy.en) }
}

export function useMatrixSettingsCopy(): MatrixSettingsCopy {
  const { locale } = useI18n()

  return matrixSettingsCopy(locale)
}

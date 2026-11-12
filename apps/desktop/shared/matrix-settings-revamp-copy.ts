import type { DesktopLocale } from './desktop-locale'

/**
 * Stable Settings destinations shared with the phone copy export, in their reading order.
 * Keep these ids and their order independent of capability, connection and wallet state.
 * `devices` keeps its id for existing deep links; it is the "This Mac" page.
 */
export const MATRIX_SETTINGS_DESTINATIONS = [
  'account',
  'assistants',
  'protons',
  'general',
  'connections',
  'devices',
  'privacy',
  'help',
  'advanced'
] as const

export type MatrixSettingsDestination = (typeof MATRIX_SETTINGS_DESTINATIONS)[number]

/**
 * The navigation's three quiet groups (2026-10-25 reorg): you (your account, your
 * assistants, your Protons), the app on this Mac, then help and the expert corner.
 */
export const MATRIX_SETTINGS_GROUPS = [
  { id: 'you', destinations: ['account', 'assistants', 'protons'] },
  { id: 'app', destinations: ['general', 'connections', 'devices', 'privacy'] },
  { id: 'support', destinations: ['help', 'advanced'] }
] as const satisfies readonly { id: string; destinations: readonly MatrixSettingsDestination[] }[]

export type MatrixSettingsGroup = (typeof MATRIX_SETTINGS_GROUPS)[number]['id']

export interface MatrixSettingsRevampCopy {
  destinations: Record<MatrixSettingsDestination, string>
  /** Accessible names of the navigation's groups; never drawn. */
  groups: Record<MatrixSettingsGroup, string>
  back: string
  look: string
  howAtumAnswers: string
  protonsLeft: (amount: string) => string
  topUp: string
  yourSubscription: string
  subscriptionHelp: string
  change: string
  profile: string
  yourAssistants: string
  editProfile: string
  assistantsLead: string
  assistantsEmpty: string
  assistantReady: string
  assistantPreparing: string
  mainAssistant: string
  assistantNeedsYou: string
  answersInCloud: string
  openAssistant: string
  notAvailableYet: string
  otherDevices: string
  availability: string
  google: string
  apps: string
  usedInChats: string
  appsEmpty: string
  appUpdateFailed: string
  memory: string
  remembers: string
  remembersHelp: string
  memoryDisclosure: string
  activity: string
  shareActivity: string
  shareActivityHelp: string
  chats: string
  /** What is true for every chat: where it is kept, and that end-to-end encryption is opt-in. */
  chatsStored: string
  chatsStoredHelp: string
  /** The foot: what encrypting a chat does to Atum's memory of it. */
  encryptionDetail: string
  /** Leads the recovery key's section: it is for the chats a person encrypts, not for everyone. */
  recoveryHelp: string
  walletUnavailable: string
  walletUnavailableHelp: string
  providersAndRepair: string
  expertTools: string
  model: string
  repair: string
  assistantNotAnswering: string
}

const copies: Record<DesktopLocale, MatrixSettingsRevampCopy> = {
  en: {
    destinations: {
      account: 'Account',
      assistants: 'Assistants',
      protons: 'Protons',
      general: 'General',
      connections: 'Connections',
      devices: 'This Mac',
      privacy: 'Privacy & security',
      help: 'Help',
      advanced: 'Advanced'
    },
    groups: { you: 'You', app: 'Atum', support: 'Help and advanced' },
    back: 'Settings',
    look: 'Look',
    howAtumAnswers: 'How Atum answers',
    protonsLeft: amount => `${amount} left · used for Atum’s built-in models and the Store`,
    topUp: 'Top up',
    yourSubscription: 'Your subscription',
    subscriptionHelp: 'Use ChatGPT, Claude or Gemini you already pay for',
    change: 'Change',
    profile: 'Profile',
    yourAssistants: 'Your assistants',
    editProfile: 'Edit profile',
    assistantsLead: 'Open an assistant to change its name, photo and how it works.',
    assistantsEmpty: 'Your assistant is being prepared',
    assistantReady: 'Ready',
    assistantPreparing: 'Being prepared',
    mainAssistant: 'Your main assistant',
    assistantNeedsYou: 'Needs you',
    answersInCloud: 'Answers in the cloud',
    openAssistant: 'Open assistant',
    notAvailableYet: 'Not available yet',
    otherDevices: 'Other devices',
    availability: 'Availability',
    google: 'Google',
    apps: 'Apps',
    usedInChats: 'Used in your chats',
    appsEmpty: 'No apps are used in your chats.',
    appUpdateFailed: 'Could not update this app.',
    memory: 'Memory',
    remembers: 'Atum remembers',
    remembersHelp: 'Helps your assistants remember context between conversations.',
    memoryDisclosure:
      'Messages in your chats, including other people’s messages, may be processed by model providers and stored as searchable memory.',
    activity: 'Activity',
    shareActivity: 'Share activity',
    shareActivityHelp: 'Let others see your read receipts and typing.',
    chats: 'Chats',
    chatsStored: 'Kept on Atum’s servers',
    chatsStoredHelp:
      'They aren’t end-to-end encrypted by default. You can turn encryption on for a single chat, in that chat’s info.',
    encryptionDetail:
      'An encrypted chat stays out of Atum’s memory. Turning encryption on doesn’t erase memory already saved.',
    recoveryHelp: 'Only needed for chats you turn encryption on for. The key opens them on a new Mac.',
    walletUnavailable: 'Balance not available',
    walletUnavailableHelp: 'Proton balance and activity will appear here when the wallet is available.',
    providersAndRepair: 'AI model & repair',
    expertTools: 'For developers',
    model: 'Model',
    repair: 'Repair',
    assistantNotAnswering: 'Assistant not answering?'
  },
  vi: {
    destinations: {
      account: 'Tài khoản',
      assistants: 'Trợ lý',
      protons: 'Proton',
      general: 'Chung',
      connections: 'Kết nối',
      devices: 'Máy Mac này',
      privacy: 'Riêng tư & bảo mật',
      help: 'Trợ giúp',
      advanced: 'Nâng cao'
    },
    groups: { you: 'Bạn', app: 'Atum', support: 'Trợ giúp và nâng cao' },
    back: 'Cài đặt',
    look: 'Giao diện',
    howAtumAnswers: 'Cách Atum trả lời',
    protonsLeft: amount => `Còn ${amount} · dùng cho mô hình tích hợp của Atum và Cửa hàng`,
    topUp: 'Nạp thêm',
    yourSubscription: 'Gói đăng ký của bạn',
    subscriptionHelp: 'Dùng ChatGPT, Claude hoặc Gemini bạn đang trả phí',
    change: 'Đổi',
    profile: 'Hồ sơ',
    yourAssistants: 'Trợ lý của bạn',
    editProfile: 'Sửa hồ sơ',
    assistantsLead: 'Mở một trợ lý để đổi tên, ảnh và cách trợ lý làm việc.',
    assistantsEmpty: 'Trợ lý đang được chuẩn bị',
    assistantReady: 'Sẵn sàng',
    assistantPreparing: 'Đang được chuẩn bị',
    mainAssistant: 'Trợ lý chính của bạn',
    assistantNeedsYou: 'Cần bạn',
    answersInCloud: 'Trả lời trên đám mây',
    openAssistant: 'Mở trợ lý',
    notAvailableYet: 'Chưa khả dụng',
    otherDevices: 'Thiết bị khác',
    availability: 'Sẵn sàng giúp bạn',
    google: 'Google',
    apps: 'Ứng dụng',
    usedInChats: 'Được dùng trong cuộc trò chuyện của bạn',
    appsEmpty: 'Chưa có ứng dụng nào được dùng trong cuộc trò chuyện.',
    appUpdateFailed: 'Chưa cập nhật được ứng dụng này.',
    memory: 'Trí nhớ',
    remembers: 'Atum ghi nhớ',
    remembersHelp: 'Giúp các trợ lý nhớ ngữ cảnh giữa những lần trò chuyện.',
    memoryDisclosure:
      'Tin nhắn trong các cuộc trò chuyện của bạn, kể cả của người khác, có thể được nhà cung cấp mô hình xử lý và lưu thành trí nhớ có thể tìm kiếm.',
    activity: 'Hoạt động',
    shareActivity: 'Chia sẻ hoạt động',
    shareActivityHelp: 'Cho người khác thấy bạn đã xem và đang soạn.',
    chats: 'Cuộc trò chuyện',
    chatsStored: 'Được lưu trên máy chủ của Atum',
    chatsStoredHelp:
      'Mặc định không mã hóa đầu cuối. Bạn có thể bật mã hóa cho từng cuộc trò chuyện, trong thông tin của cuộc trò chuyện đó.',
    encryptionDetail: 'Cuộc trò chuyện đã mã hóa không vào trí nhớ của Atum. Bật mã hóa không xóa trí nhớ đã lưu.',
    recoveryHelp: 'Chỉ cần cho các cuộc trò chuyện bạn bật mã hóa. Khóa giúp mở chúng trên máy Mac mới.',
    walletUnavailable: 'Chưa có số dư',
    walletUnavailableHelp: 'Số dư và hoạt động Proton sẽ xuất hiện tại đây khi ví khả dụng.',
    providersAndRepair: 'Mô hình AI & sửa lỗi',
    expertTools: 'Dành cho nhà phát triển',
    model: 'Mô hình',
    repair: 'Sửa chữa',
    assistantNotAnswering: 'Trợ lý không trả lời?'
  },
  ja: {
    destinations: {
      account: 'アカウント',
      assistants: 'アシスタント',
      protons: 'Proton',
      general: '一般',
      connections: '接続',
      devices: 'この Mac',
      privacy: 'プライバシーと安全',
      help: 'ヘルプ',
      advanced: '詳細'
    },
    groups: { you: 'あなた', app: 'Atum', support: 'ヘルプと詳細' },
    back: '設定',
    look: '外観',
    howAtumAnswers: 'Atum の回答方法',
    protonsLeft: amount => `残り ${amount} · Atum の内蔵モデルとストアで使用`,
    topUp: 'チャージ',
    yourSubscription: 'あなたのサブスクリプション',
    subscriptionHelp: '契約中の ChatGPT、Claude、Gemini を使う',
    change: '変更',
    profile: 'プロフィール',
    yourAssistants: 'あなたのアシスタント',
    editProfile: 'プロフィールを編集',
    assistantsLead: 'アシスタントを開くと、名前・写真・働き方を変更できます。',
    assistantsEmpty: 'アシスタントを準備しています',
    assistantReady: '準備完了',
    assistantPreparing: '準備中',
    mainAssistant: 'メインアシスタント',
    assistantNeedsYou: '対応が必要です',
    answersInCloud: 'クラウドで応答',
    openAssistant: 'アシスタントを開く',
    notAvailableYet: 'まだ利用できません',
    otherDevices: 'ほかのデバイス',
    availability: '利用可能性',
    google: 'Google',
    apps: 'アプリ',
    usedInChats: 'チャットで使用中',
    appsEmpty: 'チャットで使っているアプリはありません。',
    appUpdateFailed: 'このアプリを更新できませんでした。',
    memory: 'メモリ',
    remembers: 'Atum のメモリ',
    remembersHelp: '会話をまたいでアシスタントが文脈を覚えるのに役立ちます。',
    memoryDisclosure:
      'あなたのチャット内のメッセージは、ほかの人のメッセージを含め、モデル提供者によって処理され、検索可能なメモリとして保存される場合があります。',
    activity: 'アクティビティ',
    shareActivity: 'アクティビティを共有',
    shareActivityHelp: '既読と入力中の状態をほかの人に表示します。',
    chats: 'チャット',
    chatsStored: 'Atum のサーバーに保存されます',
    chatsStoredHelp:
      'デフォルトではエンドツーエンド暗号化されません。チャットごとに、そのチャットの情報から暗号化をオンにできます。',
    encryptionDetail:
      '暗号化したチャットは Atum のメモリに入りません。暗号化をオンにしても、保存済みのメモリは削除されません。',
    recoveryHelp: '暗号化をオンにしたチャットにのみ必要です。復旧キーで、新しい Mac でもそれらを開けます。',
    walletUnavailable: '残高を利用できません',
    walletUnavailableHelp: 'ウォレットが利用可能になると、Proton の残高と履歴がここに表示されます。',
    providersAndRepair: 'AI モデルと修復',
    expertTools: '開発者向け',
    model: 'モデル',
    repair: '修復',
    assistantNotAnswering: 'アシスタントが応答しませんか？'
  },
  zh: {
    destinations: {
      account: '账户',
      assistants: '助手',
      protons: 'Proton',
      general: '通用',
      connections: '连接',
      devices: '这台 Mac',
      privacy: '隐私与安全',
      help: '帮助',
      advanced: '高级'
    },
    groups: { you: '你', app: 'Atum', support: '帮助与高级' },
    back: '设置',
    look: '外观',
    howAtumAnswers: 'Atum 的回答方式',
    protonsLeft: amount => `剩余 ${amount} · 用于 Atum 内置模型和商店`,
    topUp: '充值',
    yourSubscription: '你的订阅',
    subscriptionHelp: '使用你已付费的 ChatGPT、Claude 或 Gemini',
    change: '更改',
    profile: '个人资料',
    yourAssistants: '你的助手',
    editProfile: '编辑个人资料',
    assistantsLead: '打开助手即可更改它的名字、照片和工作方式。',
    assistantsEmpty: '正在准备你的助手',
    assistantReady: '已就绪',
    assistantPreparing: '正在准备',
    mainAssistant: '你的主助手',
    assistantNeedsYou: '需要你处理',
    answersInCloud: '在云端回答',
    openAssistant: '打开助手',
    notAvailableYet: '暂不可用',
    otherDevices: '其他设备',
    availability: '可用性',
    google: 'Google',
    apps: '应用',
    usedInChats: '用于你的聊天',
    appsEmpty: '聊天中尚未使用任何应用。',
    appUpdateFailed: '无法更新此应用。',
    memory: '记忆',
    remembers: 'Atum 会记忆',
    remembersHelp: '帮助你的助手在不同对话间记住上下文。',
    memoryDisclosure: '你聊天中的消息（包括其他人的消息）可能会由模型提供商处理，并存储为可搜索的记忆。',
    activity: '活动',
    shareActivity: '共享活动状态',
    shareActivityHelp: '让其他人看到你的已读和正在输入状态。',
    chats: '聊天',
    chatsStored: '保存在 Atum 的服务器上',
    chatsStoredHelp: '默认不做端到端加密。你可以在某个聊天的信息中为它单独开启加密。',
    encryptionDetail: '加密的聊天不会进入 Atum 的记忆。开启加密不会删除已保存的记忆。',
    recoveryHelp: '仅用于你开启了加密的聊天。恢复密钥可在新的 Mac 上打开它们。',
    walletUnavailable: '余额不可用',
    walletUnavailableHelp: '钱包可用后，Proton 余额和活动会显示在这里。',
    providersAndRepair: 'AI 模型与修复',
    expertTools: '面向开发者',
    model: '模型',
    repair: '修复',
    assistantNotAnswering: '助手没有回答？'
  },
  'zh-hant': {
    destinations: {
      account: '帳戶',
      assistants: '助理',
      protons: 'Proton',
      general: '一般',
      connections: '連接',
      devices: '這台 Mac',
      privacy: '隱私與安全',
      help: '說明',
      advanced: '進階'
    },
    groups: { you: '你', app: 'Atum', support: '說明與進階' },
    back: '設定',
    look: '外觀',
    howAtumAnswers: 'Atum 的回答方式',
    protonsLeft: amount => `剩餘 ${amount} · 用於 Atum 內建模型和商店`,
    topUp: '儲值',
    yourSubscription: '你的訂閱',
    subscriptionHelp: '使用你已付費的 ChatGPT、Claude 或 Gemini',
    change: '變更',
    profile: '個人資料',
    yourAssistants: '你的助理',
    editProfile: '編輯個人資料',
    assistantsLead: '開啟助理即可變更它的名字、照片和工作方式。',
    assistantsEmpty: '正在準備你的助理',
    assistantReady: '已就緒',
    assistantPreparing: '正在準備',
    mainAssistant: '你的主要助理',
    assistantNeedsYou: '需要你處理',
    answersInCloud: '在雲端回答',
    openAssistant: '開啟助理',
    notAvailableYet: '暫時無法使用',
    otherDevices: '其他裝置',
    availability: '可用性',
    google: 'Google',
    apps: '應用程式',
    usedInChats: '用於你的聊天',
    appsEmpty: '聊天中尚未使用任何應用程式。',
    appUpdateFailed: '無法更新此應用程式。',
    memory: '記憶',
    remembers: 'Atum 會記憶',
    remembersHelp: '幫助你的助理在不同對話間記住脈絡。',
    memoryDisclosure: '你聊天中的訊息（包括其他人的訊息）可能會由模型供應商處理，並儲存為可搜尋的記憶。',
    activity: '活動',
    shareActivity: '分享活動狀態',
    shareActivityHelp: '讓其他人看到你的已讀與正在輸入狀態。',
    chats: '聊天',
    chatsStored: '儲存在 Atum 的伺服器上',
    chatsStoredHelp: '預設不做端對端加密。你可以在某個聊天的資訊中為它單獨開啟加密。',
    encryptionDetail: '加密的聊天不會進入 Atum 的記憶。開啟加密不會刪除已儲存的記憶。',
    recoveryHelp: '僅用於你開啟了加密的聊天。復原金鑰可在新的 Mac 上開啟它們。',
    walletUnavailable: '餘額無法使用',
    walletUnavailableHelp: '錢包可用後，Proton 餘額與活動會顯示在這裡。',
    providersAndRepair: 'AI 模型與修復',
    expertTools: '開發者專用',
    model: '模型',
    repair: '修復',
    assistantNotAnswering: '助理沒有回應？'
  }
}

export function matrixSettingsRevampCopy(locale: DesktopLocale): MatrixSettingsRevampCopy {
  return copies[locale] ?? copies.en
}

/**
 * Words only the phone's Settings pages show. The desktop never reads this table: the phone
 * export promotes it as `shared.matrix-settings-revamp-copy.phoneSettingsCopy.*`, so the
 * phone's wording lives with the desktop Settings copy it mirrors instead of in Swift.
 * `devices` is the phone's own page, the sibling of the desktop's "This Mac".
 */
export interface PhoneSettingsCopy {
  thisIPhone: string
  thisIPad: string
  /** Header over the rows that are managed on the Mac, with `macAccessHelp` as their footer. */
  onYourMac: string
  macAccessHelp: string
  /** Under the profile name field when it is left empty. */
  nameRequired: string
  /** The line under your name on the profile card that opens Account. */
  profileSummary: string
  /** Under Appearance: the phone's sibling of the desktop's "Follow your Mac" line. */
  appearanceDescription: string
  appearanceDescriptionIPad: string
  /** The value of a row whose setting iOS owns (text size), and the footer under a row that
   * opens the iOS Settings app (notifications). */
  usesIOSSettings: string
  opensIOSSettings: string
  /** Help: the two reporting switches and the footer under them. */
  shareCrashReports: string
  shareCrashReportsHelp: string
  shareUsageData: string
  shareUsageDataHelp: string
  reportingFooter: string
}

export const phoneSettingsCopy: Record<DesktopLocale, PhoneSettingsCopy> = {
  en: {
    thisIPhone: 'This iPhone',
    thisIPad: 'This iPad',
    onYourMac: 'On your Mac',
    macAccessHelp: 'Your assistants use your Mac only for what you allow on that Mac.',
    nameRequired: 'Enter a name.',
    profileSummary: 'Account, Protons, devices',
    appearanceDescription: 'Follow your iPhone automatically, or choose light or dark mode.',
    appearanceDescriptionIPad: 'Follow your iPad automatically, or choose light or dark mode.',
    usesIOSSettings: 'Uses iOS settings',
    opensIOSSettings: 'Opens iOS Settings',
    shareCrashReports: 'Share crash reports',
    shareCrashReportsHelp: 'Send crash details to help fix problems. No message content or account details are sent.',
    shareUsageData: 'Share usage data',
    shareUsageDataHelp: 'Send anonymous app usage to help improve Atum. It is not linked to your account.',
    reportingFooter: 'You can turn either report off at any time. Turning one off stops sending immediately.'
  },
  vi: {
    thisIPhone: 'iPhone này',
    thisIPad: 'iPad này',
    onYourMac: 'Trên máy Mac',
    macAccessHelp: 'Trợ lý chỉ dùng máy Mac của bạn cho những việc bạn cho phép trên máy đó.',
    nameRequired: 'Hãy nhập tên.',
    profileSummary: 'Tài khoản, Proton, thiết bị',
    appearanceDescription: 'Tự động theo iPhone hoặc chọn chế độ sáng hay tối.',
    appearanceDescriptionIPad: 'Tự động theo iPad hoặc chọn chế độ sáng hay tối.',
    usesIOSSettings: 'Theo cài đặt iOS',
    opensIOSSettings: 'Mở Cài đặt iOS',
    shareCrashReports: 'Chia sẻ báo cáo sự cố',
    shareCrashReportsHelp: 'Gửi chi tiết sự cố để giúp khắc phục. Không gửi nội dung tin nhắn hay thông tin tài khoản.',
    shareUsageData: 'Chia sẻ dữ liệu sử dụng',
    shareUsageDataHelp: 'Gửi dữ liệu sử dụng ẩn danh để giúp cải thiện Atum. Dữ liệu không gắn với tài khoản của bạn.',
    reportingFooter: 'Bạn có thể tắt từng báo cáo bất cứ lúc nào. Tắt sẽ dừng gửi ngay.'
  },
  ja: {
    thisIPhone: 'この iPhone',
    thisIPad: 'この iPad',
    onYourMac: 'お使いの Mac で',
    macAccessHelp: 'アシスタントがお使いの Mac を使うのは、その Mac で許可したことだけです。',
    nameRequired: '名前を入力してください。',
    profileSummary: 'アカウント、Proton、デバイス',
    appearanceDescription: 'iPhone に自動的に合わせるか、ライトまたはダークを選びます。',
    appearanceDescriptionIPad: 'iPad に自動的に合わせるか、ライトまたはダークを選びます。',
    usesIOSSettings: 'iOS の設定に従います',
    opensIOSSettings: 'iOS の設定を開きます',
    shareCrashReports: 'クラッシュレポートを共有',
    shareCrashReportsHelp:
      '問題の修正に役立てるため、クラッシュの詳細を送信します。メッセージの内容やアカウント情報は送信しません。',
    shareUsageData: '使用データを共有',
    shareUsageDataHelp: '匿名のアプリ利用データを送信し、Atum の改善に役立てます。アカウントには紐付けられません。',
    reportingFooter: 'どちらのレポートもいつでもオフにできます。オフにするとすぐに送信が止まります。'
  },
  zh: {
    thisIPhone: '这台 iPhone',
    thisIPad: '这台 iPad',
    onYourMac: '在你的 Mac 上',
    macAccessHelp: '助理只会按你在 Mac 上允许的范围使用它。',
    nameRequired: '请输入名字。',
    profileSummary: '账户、Proton、设备',
    appearanceDescription: '自动跟随 iPhone，或选择浅色或深色模式。',
    appearanceDescriptionIPad: '自动跟随 iPad，或选择浅色或深色模式。',
    usesIOSSettings: '跟随 iOS 设置',
    opensIOSSettings: '打开 iOS 设置',
    shareCrashReports: '共享崩溃报告',
    shareCrashReportsHelp: '发送崩溃详情以帮助修复问题。不会发送消息内容或账户信息。',
    shareUsageData: '共享使用数据',
    shareUsageDataHelp: '发送匿名的应用使用数据，帮助改进 Atum。这些数据不会关联到你的账户。',
    reportingFooter: '你可以随时关闭任一报告。关闭后立即停止发送。'
  },
  'zh-hant': {
    thisIPhone: '這台 iPhone',
    thisIPad: '這台 iPad',
    onYourMac: '在你的 Mac 上',
    macAccessHelp: '助理只會按你在 Mac 上允許的範圍使用它。',
    nameRequired: '請輸入名字。',
    profileSummary: '帳戶、Proton、裝置',
    appearanceDescription: '自動跟隨 iPhone，或選擇淺色或深色模式。',
    appearanceDescriptionIPad: '自動跟隨 iPad，或選擇淺色或深色模式。',
    usesIOSSettings: '依照 iOS 設定',
    opensIOSSettings: '開啟 iOS 設定',
    shareCrashReports: '分享當機報告',
    shareCrashReportsHelp: '傳送當機詳情以協助修正問題。不會傳送訊息內容或帳戶資訊。',
    shareUsageData: '分享使用資料',
    shareUsageDataHelp: '傳送匿名的應用程式使用資料，協助改進 Atum。這些資料不會連結到你的帳戶。',
    reportingFooter: '你可以隨時關閉任一報告。關閉後立即停止傳送。'
  }
}

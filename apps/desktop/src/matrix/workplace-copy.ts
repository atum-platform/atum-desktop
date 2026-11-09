import type { Locale } from '@/i18n'

/**
 * Workplace's own words, all five locales together. Plain words for a person, not an operator:
 * the everyday places are Atum's own (Routines, Drive, the Store); the Hermes pages wait under
 * For developers, which names them by what they are rather than by which tool they came from.
 */
export interface WorkplaceCopy {
  title: string
  intro: string
  chooseAgent: string
  /** The everyday places: Atum's own Routines, Drive and Store, each with one line of help. */
  routines: string
  routinesHelp: string
  drive: string
  driveHelp: string
  storeHelp: string
  /** The one entry that holds every page of the assistant's own tools, the duplicates too. */
  forDevelopers: string
  scheduled: string
  scheduledHelp: string
  artifacts: string
  artifactsHelp: string
  skills: string
  skillsHelp: string
  runtime: string
  runtimeHelp: string
  providers: string
  providersHelp: string
  connections: string
  connectionsHelp: string
  commandCenterHelp: string
  starmapHelp: string
  mcp: string
  mcpHelp: string
  opening: string
  unavailable: string
  failed: string
  /** The agent answers with Atum's AI everywhere: there is nothing on this Mac to manage. */
  everywhere: string
  /** This native page belongs to an assistant host, but this Mac is only its cloud standby. */
  hostUnavailable: string
  retry: string
  back: string
  /** A page opened from a chat (the model picker) goes back to that chat, not to a list. */
  chat: string
  backToChat: string
  /** A page opened from Settings › Advanced goes back to Settings. */
  settings: string
  backToSettings: string
  /** The Skills Hub opened from a Store listing goes back to the Store. */
  store: string
  backToStore: string
}

/** Plain words for a person, not an operator: no "local", no "on this Mac" on every line. */
export const workplaceCopy: Record<Locale, WorkplaceCopy> = {
  en: {
    title: 'Workplace',
    intro: 'Your assistant’s routines, files and the Store.',
    chooseAgent: 'Assistant',
    routines: 'Routines',
    routinesHelp: 'Things your assistant does on a schedule.',
    drive: 'Atum Drive',
    driveHelp: 'Your files, and the ones your assistant made.',
    storeHelp: 'Skills and apps for your assistant.',
    forDevelopers: 'For developers',
    scheduled: 'Scheduled tasks',
    scheduledHelp: 'Things your assistant does on a schedule.',
    artifacts: 'Files your assistant made',
    artifactsHelp: 'Documents and other files from your chats.',
    skills: 'Skills',
    skillsHelp: 'See and turn on what your assistant can do.',
    runtime: 'Model & Memory',
    runtimeHelp: 'Choose the model and the memory it uses.',
    providers: 'Providers',
    providersHelp: 'Connect your own model providers.',
    connections: 'Connections',
    connectionsHelp: 'Use your ChatGPT plan, an API key or a local model.',
    commandCenterHelp: 'Status, logs and usage.',
    starmapHelp: 'What your assistant has learned.',
    mcp: 'MCP servers',
    mcpHelp: 'Connect outside tools.',
    opening: 'Opening…',
    unavailable: 'Not available for this assistant yet.',
    failed: 'This page couldn’t open.',
    everywhere: 'This assistant answers with Atum’s AI on every computer. Using your own account (such as ChatGPT) with it isn’t available yet.',
    hostUnavailable: 'This page needs this assistant running on this Mac.',
    retry: 'Try again',
    back: 'Back to Workplace',
    chat: 'Chat',
    backToChat: 'Back to the chat',
    settings: 'Settings',
    backToSettings: 'Back to Settings',
    store: 'Store',
    backToStore: 'Back to the Store'
  },
  vi: {
    title: 'Nơi làm việc',
    intro: 'Lịch tự động, tệp và Cửa hàng của trợ lý.',
    chooseAgent: 'Trợ lý',
    routines: 'Lịch tự động',
    routinesHelp: 'Những việc trợ lý tự làm theo lịch.',
    drive: 'Atum Drive',
    driveHelp: 'Tệp của bạn và tệp trợ lý đã tạo.',
    storeHelp: 'Kỹ năng và ứng dụng cho trợ lý.',
    forDevelopers: 'Dành cho nhà phát triển',
    scheduled: 'Việc định kỳ',
    scheduledHelp: 'Những việc trợ lý tự làm theo lịch.',
    artifacts: 'Tệp trợ lý đã tạo',
    artifactsHelp: 'Tài liệu và tệp từ các cuộc trò chuyện.',
    skills: 'Kỹ năng',
    skillsHelp: 'Xem và bật những việc trợ lý làm được.',
    runtime: 'Mô hình & Bộ nhớ',
    runtimeHelp: 'Chọn mô hình và bộ nhớ trợ lý dùng.',
    providers: 'Nhà cung cấp',
    providersHelp: 'Kết nối nhà cung cấp mô hình của riêng bạn.',
    connections: 'Kết nối',
    connectionsHelp: 'Dùng gói ChatGPT, khóa API hoặc mô hình chạy trên máy.',
    commandCenterHelp: 'Trạng thái, nhật ký và mức dùng.',
    starmapHelp: 'Những gì trợ lý đã học được.',
    mcp: 'Máy chủ MCP',
    mcpHelp: 'Kết nối công cụ bên ngoài.',
    opening: 'Đang mở…',
    unavailable: 'Chưa dùng được với trợ lý này.',
    failed: 'Chưa mở được trang này.',
    everywhere: 'Trợ lý này trả lời bằng AI của Atum trên mọi máy. Chưa dùng được tài khoản riêng (như ChatGPT) với trợ lý này.',
    hostUnavailable: 'Trang này cần trợ lý chạy trên máy Mac này.',
    retry: 'Thử lại',
    back: 'Quay lại Nơi làm việc',
    chat: 'Trò chuyện',
    backToChat: 'Quay lại cuộc trò chuyện',
    settings: 'Cài đặt',
    backToSettings: 'Quay lại Cài đặt',
    store: 'Cửa hàng',
    backToStore: 'Quay lại Cửa hàng'
  },
  ja: {
    title: 'ワークプレイス',
    intro: 'アシスタントのルーティン、ファイル、ストア。',
    chooseAgent: 'アシスタント',
    routines: 'ルーティン',
    routinesHelp: 'アシスタントがスケジュールどおりに行うこと。',
    drive: 'Atum Drive',
    driveHelp: 'あなたのファイルと、アシスタントが作ったファイル。',
    storeHelp: 'アシスタント用のスキルとアプリ。',
    forDevelopers: '開発者向け',
    scheduled: '定期タスク',
    scheduledHelp: 'アシスタントがスケジュールどおりに行うこと。',
    artifacts: 'アシスタントが作ったファイル',
    artifactsHelp: 'チャットから生まれた文書やファイル。',
    skills: 'スキル',
    skillsHelp: 'アシスタントにできることを確認してオンにします。',
    runtime: 'モデルとメモリ',
    runtimeHelp: '使うモデルとメモリを選びます。',
    providers: 'プロバイダー',
    providersHelp: '自分のモデルプロバイダーを接続します。',
    connections: '接続',
    connectionsHelp: 'ChatGPT のプラン、API キー、ローカルのモデルを使います。',
    commandCenterHelp: '状態、ログ、使用量。',
    starmapHelp: 'アシスタントが学んだこと。',
    mcp: 'MCP サーバー',
    mcpHelp: '外部ツールを接続します。',
    opening: '開いています…',
    unavailable: 'このアシスタントではまだ使えません。',
    failed: 'このページを開けませんでした。',
    everywhere: 'このアシスタントはどのパソコンでもAtumのAIで返答します。ご自身のアカウント（ChatGPTなど）はまだ使えません。',
    hostUnavailable: 'このページを使うには、このアシスタントがこのMacで動作している必要があります。',
    retry: '再試行',
    back: 'ワークプレイスに戻る',
    chat: 'チャット',
    backToChat: 'チャットに戻る',
    settings: '設定',
    backToSettings: '設定に戻る',
    store: 'ストア',
    backToStore: 'ストアに戻る'
  },
  zh: {
    title: '工作区',
    intro: '助手的定时任务、文件和商店。',
    chooseAgent: '助手',
    routines: '定时任务',
    routinesHelp: '助手按计划自动完成的事。',
    drive: 'Atum Drive',
    driveHelp: '你的文件，以及助手创建的文件。',
    storeHelp: '为助手提供技能和应用。',
    forDevelopers: '面向开发者',
    scheduled: '定时任务',
    scheduledHelp: '助手按计划自动完成的事。',
    artifacts: '助手创建的文件',
    artifactsHelp: '来自对话的文档和文件。',
    skills: '技能',
    skillsHelp: '查看并开启助手能做的事。',
    runtime: '模型与记忆',
    runtimeHelp: '选择助手使用的模型和记忆。',
    providers: '模型提供商',
    providersHelp: '连接你自己的模型提供商。',
    connections: '连接',
    connectionsHelp: '使用你的 ChatGPT 方案、API 密钥或本地模型。',
    commandCenterHelp: '状态、日志和用量。',
    starmapHelp: '助手学到的内容。',
    mcp: 'MCP 服务器',
    mcpHelp: '连接外部工具。',
    opening: '正在打开…',
    unavailable: '此助手暂时无法使用。',
    failed: '无法打开此页面。',
    everywhere: '此助手在每台电脑上都使用 Atum 的 AI 回答。暂时还不能为它使用您自己的账户（例如 ChatGPT）。',
    hostUnavailable: '此页面需要这个助手在这台 Mac 上运行。',
    retry: '重试',
    back: '返回工作区',
    chat: '对话',
    backToChat: '返回对话',
    settings: '设置',
    backToSettings: '返回设置',
    store: '商店',
    backToStore: '返回商店'
  },
  'zh-hant': {
    title: '工作區',
    intro: '助理的排程任務、檔案和商店。',
    chooseAgent: '助理',
    routines: '排程任務',
    routinesHelp: '助理依排程自動完成的事。',
    drive: 'Atum Drive',
    driveHelp: '你的檔案，以及助理建立的檔案。',
    storeHelp: '為助理提供技能和應用程式。',
    forDevelopers: '開發者專用',
    scheduled: '定時任務',
    scheduledHelp: '助理依排程自動完成的事。',
    artifacts: '助理建立的檔案',
    artifactsHelp: '來自對話的文件和檔案。',
    skills: '技能',
    skillsHelp: '查看並開啟助理能做的事。',
    runtime: '模型與記憶',
    runtimeHelp: '選擇助理使用的模型和記憶。',
    providers: '模型供應商',
    providersHelp: '連接你自己的模型供應商。',
    connections: '連接',
    connectionsHelp: '使用你的 ChatGPT 方案、API 金鑰或本機模型。',
    commandCenterHelp: '狀態、記錄和用量。',
    starmapHelp: '助理學到的內容。',
    mcp: 'MCP 伺服器',
    mcpHelp: '連接外部工具。',
    opening: '正在開啟…',
    unavailable: '此助理暫時無法使用。',
    failed: '無法開啟此頁面。',
    everywhere: '此助理在每台電腦上都使用 Atum 的 AI 回答。暫時還不能為它使用您自己的帳戶（例如 ChatGPT）。',
    hostUnavailable: '此頁面需要這個助理在這部 Mac 上執行。',
    retry: '再試一次',
    back: '返回工作區',
    chat: '對話',
    backToChat: '返回對話',
    settings: '設定',
    backToSettings: '返回設定',
    store: '商店',
    backToStore: '返回商店'
  }
}

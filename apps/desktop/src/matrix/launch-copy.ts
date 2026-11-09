import { type Locale, useI18n } from '@/i18n'

/**
 * The launch's own words (startup-screen.tsx, launch-notice.tsx): the quiet way out of a
 * launch that stops, and the assistant's warm-up shown in its chat once the window is open.
 * The step labels and the readiness reasons stay in `t.matrixShell` (readiness-copy.ts).
 */
interface LaunchCopy {
  /** The window opens with the person's chats; the assistant keeps getting ready in its own. */
  feedback: string
  signOut: string
  signInAgain: string
  download: string
  topUp: string
  /** An agent's executor being replaced on this Mac (agent-reenroll.ts). */
  reconnectingTitle: string
  reconnectingHelp: string
  /** One that needs the person's Reconnect; `reconnectShort` is its roster line. */
  reconnectTitle: string
  reconnectHelp: string
  reconnectShort: string
  reconnect: string
  /** A withdrawn executor, with Reconnect on offer. */
  withdrawnHelp: string
  /** The assistant answers with the person's own ChatGPT plan and its sign-in on this Mac ended
   * (`plan_sign_in`): the title, why, and the button that opens the account sign-in dialog. */
  planSignInTitle: string
  planSignInHelp: string
  planSignIn: string
  /** This Mac's own device lost its keys. */
  deviceDamagedTitle: string
  deviceDamagedHelp: string
  ownerRepairAction: string
  ownerRepairBusy: string
  ownerRepairPending: string
  ownerRepairRetry: string
  ownerRepairFailed: string
  ownerRepairMismatch: string
  deviceControlAction: string
  deviceControlLater: string
  /** An assistant's roster line while this Mac waits for its recovery key or approval. */
  waitingUnlock: string
  /** Its roster line when this Mac's own device lost its keys. */
  signInAgainShort: string
  /** The assistant's chat while it is still starting: its name, then the step it is on. */
  gettingReady: (name: string) => string
  /** Launch waits for the authoritative roster, then names every agent and its live step. */
  loadingAgents: string
  agentStatus: (name: string, status: string) => string
  agentReady: string
  agentElapsed: (seconds: number) => string
  /** Shown instead of "No chat open" while the default assistant is still starting. */
  gettingReadyPanel: string
  aiDownTitle: string
  aiDownHelp: string
  chatDownTitle: string
  /** Signed out, or the sign-in expired: a short title; the catalog's sentence becomes the help. */
  signedOutTitle: string
  chatDownHelp: string
  runtimeTitle: string
  runtimeHelp: string
  trustTitle: string
  trustHelp: string
  /** An agent whose identity is not made yet (`agent_initializing`), and another agent's own
   * trust step on the launch: still being set up, in plain words. */
  initializingTitle: string
  initializingHelp: string
  /** A saved account whose chats can't be reached at all (its engine did not start): the
   * person is still signed in, and Try again starts the session over. */
  unreachableTitle: string
  unreachableHelp: string
  /** The same when this Mac's own chat engine did not start or stopped
   * (`matrix_sdk_start_failed`, `matrix_sdk_stopped`): not the network, so no "check your
   * connection"; feedback is the way to tell Atum. */
  engineTitle: string
  engineHelp: string
  /** The same, because this Mac's disk is too full to save the sign-in's new token
   * (`matrix_disk_full`): freeing space is the fix, and the chats come back by themselves. */
  diskFullHelp: string
  /** A step marked as the one that stopped, for screen readers. */
  stepFailed: string
}

const copies: Record<Locale, LaunchCopy> = {
  en: {
    feedback: 'Send feedback',
    signOut: 'Sign out',
    signInAgain: 'Sign in again',
    download: 'Download latest Atum',
    topUp: 'Top up Protons',
    reconnectingTitle: 'Reconnecting…',
    reconnectingHelp: 'Atum is setting your assistant up again on this Mac. It takes about a minute.',
    reconnectTitle: 'Your assistant needs to reconnect on this Mac',
    reconnectHelp: 'Its chats and memory are kept.',
    reconnectShort: 'Needs to reconnect',
    reconnect: 'Reconnect',
    withdrawnHelp: 'Your chats and saved setup are kept. Reconnect to set it up on this Mac again.',
    planSignInTitle: 'Connect ChatGPT on this Mac',
    planSignInHelp:
      'This assistant is set to use your ChatGPT plan, but Atum cannot find a usable connection for this account on this Mac. Its chats and memory are kept.',
    planSignIn: 'Connect ChatGPT',
    deviceDamagedTitle: 'This device needs to be re-verified',
    deviceDamagedHelp: 'Sign in again with this same account. Your assistants and other devices stay as they are.',
    ownerRepairAction: 'Re-verify',
    ownerRepairBusy: 'Verifying…',
    ownerRepairPending: 'Signed in. Reconnecting…',
    ownerRepairRetry: 'Try again',
    ownerRepairFailed: "Couldn't verify. Try again later.",
    ownerRepairMismatch: "Sign in with the account you're already using.",
    deviceControlAction: 'Turn on',
    deviceControlLater: 'Not now',
    waitingUnlock: 'Waiting for this Mac to unlock',
    signInAgainShort: 'Needs you to sign in again',
    gettingReady: name => `${name} is getting ready…`,
    loadingAgents: 'Loading your assistants…',
    agentStatus: (name, status) => `${name} · ${status}`,
    agentReady: 'Ready',
    agentElapsed: seconds => `${seconds}s`,
    gettingReadyPanel: 'Your chats are ready. Your assistant will be in a moment.',
    aiDownTitle: 'Atum’s AI isn’t responding',
    aiDownHelp: 'Try again in a moment.',
    chatDownTitle: 'Can’t reach your chats right now',
    signedOutTitle: 'You’ve been signed out',
    chatDownHelp: 'Atum keeps trying on its own.',
    runtimeTitle: 'Part of Atum is missing on this Mac',
    runtimeHelp: 'Download the latest Atum, then open it again.',
    trustTitle: 'Your assistant couldn’t finish a security check',
    trustHelp: 'Check your connection and try again.',
    initializingTitle: 'Your assistant is still being set up',
    initializingHelp: 'Atum keeps trying on its own.',
    unreachableTitle: 'Can’t reach Atum right now',
    unreachableHelp: 'You’re still signed in on this Mac. Check your connection, then try again.',
    engineTitle: 'Couldn’t open your chats',
    engineHelp: 'You’re still signed in on this Mac. Try again — if it keeps happening, send us feedback.',
    diskFullHelp: 'This Mac’s disk is full. Free up some space and Atum reconnects on its own.',
    stepFailed: 'Stopped here'
  },
  vi: {
    feedback: 'Gửi phản hồi',
    signOut: 'Đăng xuất',
    signInAgain: 'Đăng nhập lại',
    download: 'Tải Atum mới nhất',
    topUp: 'Nạp Proton',
    reconnectingTitle: 'Đang kết nối lại…',
    reconnectingHelp: 'Atum đang thiết lập lại trợ lý trên Mac này. Việc này mất khoảng một phút.',
    reconnectTitle: 'Trợ lý cần kết nối lại trên Mac này',
    reconnectHelp: 'Các cuộc trò chuyện và trí nhớ của trợ lý vẫn được giữ.',
    reconnectShort: 'Cần kết nối lại',
    reconnect: 'Kết nối lại',
    withdrawnHelp:
      'Các cuộc trò chuyện và thiết lập đã lưu vẫn được giữ. Bấm Kết nối lại để thiết lập lại trên Mac này.',
    planSignInTitle: 'Kết nối ChatGPT trên Mac này',
    planSignInHelp:
      'Trợ lý này được đặt để dùng gói ChatGPT của bạn, nhưng Atum chưa tìm thấy kết nối dùng được cho tài khoản này trên Mac này. Các cuộc trò chuyện và trí nhớ vẫn được giữ.',
    planSignIn: 'Kết nối ChatGPT',
    deviceDamagedTitle: 'Thiết bị này cần xác minh lại',
    deviceDamagedHelp: 'Đăng nhập lại bằng chính tài khoản này. Các trợ lý và thiết bị khác giữ nguyên.',
    ownerRepairAction: 'Xác minh lại',
    ownerRepairBusy: 'Đang xác minh…',
    ownerRepairPending: 'Đã đăng nhập. Đang kết nối lại…',
    ownerRepairRetry: 'Thử lại',
    ownerRepairFailed: 'Không xác minh được. Thử lại sau.',
    ownerRepairMismatch: 'Hãy đăng nhập bằng đúng tài khoản đang dùng.',
    deviceControlAction: 'Cho phép',
    deviceControlLater: 'Để sau',
    waitingUnlock: 'Chờ mở khóa Mac này',
    signInAgainShort: 'Cần đăng nhập lại',
    gettingReady: name => `${name} đang khởi động…`,
    loadingAgents: 'Đang tải các trợ lý…',
    agentStatus: (name, status) => `${name} · ${status}`,
    agentReady: 'Sẵn sàng',
    agentElapsed: seconds => `${seconds} giây`,
    gettingReadyPanel: 'Các cuộc trò chuyện đã sẵn sàng. Trợ lý sẽ có mặt ngay.',
    aiDownTitle: 'AI của Atum chưa phản hồi',
    aiDownHelp: 'Hãy thử lại sau ít phút.',
    chatDownTitle: 'Chưa kết nối được với các cuộc trò chuyện',
    signedOutTitle: 'Bạn đã bị đăng xuất',
    chatDownHelp: 'Atum vẫn đang tự thử lại.',
    runtimeTitle: 'Mac này đang thiếu một phần của Atum',
    runtimeHelp: 'Hãy tải Atum mới nhất rồi mở lại.',
    trustTitle: 'Trợ lý chưa hoàn tất bước kiểm tra bảo mật',
    trustHelp: 'Kiểm tra kết nối rồi thử lại.',
    initializingTitle: 'Trợ lý vẫn đang được thiết lập',
    initializingHelp: 'Atum sẽ tự thử lại.',
    unreachableTitle: 'Chưa kết nối được với Atum',
    unreachableHelp: 'Tài khoản vẫn đăng nhập trên máy Mac này. Kiểm tra kết nối rồi thử lại.',
    engineTitle: 'Chưa mở được các cuộc trò chuyện',
    engineHelp: 'Tài khoản vẫn đăng nhập trên máy Mac này. Bấm Thử lại; nếu vẫn chưa được, hãy gửi phản hồi cho Atum.',
    diskFullHelp: 'Ổ đĩa của máy Mac này đã đầy. Hãy giải phóng bớt dung lượng, Atum sẽ tự kết nối lại.',
    stepFailed: 'Dừng ở bước này'
  },
  ja: {
    feedback: 'フィードバックを送信',
    signOut: 'ログアウト',
    signInAgain: 'もう一度ログイン',
    download: '最新の Atum をダウンロード',
    topUp: 'Protons をチャージ',
    reconnectingTitle: '再接続しています…',
    reconnectingHelp: 'Atum がこの Mac でアシスタントを設定し直しています。1 分ほどかかります。',
    reconnectTitle: 'この Mac でアシスタントの再接続が必要です',
    reconnectHelp: 'チャットと記憶はそのまま残ります。',
    reconnectShort: '再接続が必要です',
    reconnect: '再接続',
    withdrawnHelp: 'チャットと保存した設定は残っています。「再接続」でこの Mac にもう一度設定できます。',
    planSignInTitle: 'この Mac で ChatGPT に接続',
    planSignInHelp:
      'このアシスタントは ChatGPT プランを使う設定ですが、この Mac ではこのアカウントの利用可能な接続が見つかりません。チャットと記憶はそのまま残ります。',
    planSignIn: 'ChatGPT に接続',
    deviceDamagedTitle: 'このデバイスを再確認してください',
    deviceDamagedHelp: '今使っているアカウントで再度ログインしてください。アシスタントとほかのデバイスはそのままです。',
    ownerRepairAction: '再確認',
    ownerRepairBusy: '確認中…',
    ownerRepairPending: 'ログインしました。再接続中…',
    ownerRepairRetry: '再試行',
    ownerRepairFailed: '確認できませんでした。後でもう一度お試しください。',
    ownerRepairMismatch: '今使っているアカウントでログインしてください。',
    deviceControlAction: '許可する',
    deviceControlLater: '後で',
    waitingUnlock: 'この Mac のロック解除を待っています',
    signInAgainShort: 'もう一度ログインが必要です',
    gettingReady: name => `${name} を準備しています…`,
    loadingAgents: 'アシスタントを読み込んでいます…',
    agentStatus: (name, status) => `${name} · ${status}`,
    agentReady: '準備完了',
    agentElapsed: seconds => `${seconds}秒`,
    gettingReadyPanel: 'チャットは使えます。アシスタントもまもなく準備できます。',
    aiDownTitle: 'Atum の AI が応答していません',
    aiDownHelp: 'しばらくしてからもう一度お試しください。',
    chatDownTitle: 'いまチャットに接続できません',
    signedOutTitle: 'ログアウトされました',
    chatDownHelp: 'Atum が自動で再試行しています。',
    runtimeTitle: 'この Mac の Atum の一部が見つかりません',
    runtimeHelp: '最新の Atum をダウンロードして、もう一度開いてください。',
    trustTitle: 'アシスタントのセキュリティ確認が完了しませんでした',
    trustHelp: '接続を確認して、もう一度お試しください。',
    initializingTitle: 'アシスタントはまだ準備中です',
    initializingHelp: 'Atum が自動で再試行しています。',
    unreachableTitle: 'いま Atum に接続できません',
    unreachableHelp: 'この Mac ではログインしたままです。接続を確認して、もう一度お試しください。',
    engineTitle: 'チャットを開けませんでした',
    engineHelp:
      'この Mac ではログインしたままです。もう一度お試しください。繰り返し起きる場合はフィードバックをお送りください。',
    diskFullHelp: 'この Mac のディスクがいっぱいです。空き容量を増やすと、Atum が自動で再接続します。',
    stepFailed: 'ここで停止しました'
  },
  zh: {
    feedback: '发送反馈',
    signOut: '退出登录',
    signInAgain: '重新登录',
    download: '下载最新版 Atum',
    topUp: '充值 Protons',
    reconnectingTitle: '正在重新连接…',
    reconnectingHelp: 'Atum 正在这台 Mac 上重新设置你的助手，大约需要一分钟。',
    reconnectTitle: '你的助手需要在这台 Mac 上重新连接',
    reconnectHelp: '它的聊天和记忆都会保留。',
    reconnectShort: '需要重新连接',
    reconnect: '重新连接',
    withdrawnHelp: '你的聊天和已保存的设置都会保留。点“重新连接”可在这台 Mac 上重新设置。',
    planSignInTitle: '在这台 Mac 上连接 ChatGPT',
    planSignInHelp: '这个助理已设为使用你的 ChatGPT 套餐，但 Atum 在这台 Mac 上找不到此账户可用的连接。聊天和记忆都会保留。',
    planSignIn: '连接 ChatGPT',
    deviceDamagedTitle: '此设备需要重新验证',
    deviceDamagedHelp: '请使用当前账号重新登录。你的助手和其他设备保持不变。',
    ownerRepairAction: '重新验证',
    ownerRepairBusy: '正在验证…',
    ownerRepairPending: '已登录。正在重新连接…',
    ownerRepairRetry: '重试',
    ownerRepairFailed: '无法验证。请稍后重试。',
    ownerRepairMismatch: '请使用你当前正在使用的账号登录。',
    deviceControlAction: '允许',
    deviceControlLater: '以后再说',
    waitingUnlock: '等待这台 Mac 解锁',
    signInAgainShort: '需要重新登录',
    gettingReady: name => `${name} 正在准备…`,
    loadingAgents: '正在加载你的助手…',
    agentStatus: (name, status) => `${name} · ${status}`,
    agentReady: '已就绪',
    agentElapsed: seconds => `${seconds} 秒`,
    gettingReadyPanel: '聊天已可使用，助手马上就好。',
    aiDownTitle: 'Atum 的 AI 暂无响应',
    aiDownHelp: '请稍后再试。',
    chatDownTitle: '暂时无法连接到你的聊天',
    signedOutTitle: '你已退出登录',
    chatDownHelp: 'Atum 会自动重试。',
    runtimeTitle: '这台 Mac 上缺少 Atum 的一部分',
    runtimeHelp: '请下载最新版 Atum，然后重新打开。',
    trustTitle: '助手未能完成安全检查',
    trustHelp: '请检查连接后重试。',
    initializingTitle: '助手仍在设置中',
    initializingHelp: 'Atum 会自动重试。',
    unreachableTitle: '暂时无法连接到 Atum',
    unreachableHelp: '你在这台 Mac 上仍处于登录状态。请检查连接后重试。',
    engineTitle: '无法打开你的聊天',
    engineHelp: '你在这台 Mac 上仍处于登录状态。请重试；如果反复出现，请向我们发送反馈。',
    diskFullHelp: '这台 Mac 的磁盘已满。请释放一些空间，Atum 会自动重新连接。',
    stepFailed: '在此步骤停止'
  },
  'zh-hant': {
    feedback: '傳送意見回饋',
    signOut: '登出',
    signInAgain: '重新登入',
    download: '下載最新版 Atum',
    topUp: '儲值 Protons',
    reconnectingTitle: '正在重新連線…',
    reconnectingHelp: 'Atum 正在這台 Mac 上重新設定你的助理，大約需要一分鐘。',
    reconnectTitle: '你的助理需要在這台 Mac 上重新連線',
    reconnectHelp: '它的聊天和記憶都會保留。',
    reconnectShort: '需要重新連線',
    reconnect: '重新連線',
    withdrawnHelp: '你的聊天和已儲存的設定都會保留。點「重新連線」可在這台 Mac 上重新設定。',
    planSignInTitle: '在這台 Mac 上連接 ChatGPT',
    planSignInHelp: '這個助理已設為使用你的 ChatGPT 方案，但 Atum 在這台 Mac 上找不到此帳號可用的連接。聊天和記憶都會保留。',
    planSignIn: '連接 ChatGPT',
    deviceDamagedTitle: '此裝置需要重新驗證',
    deviceDamagedHelp: '請使用目前的帳號重新登入。你的助理和其他裝置維持不變。',
    ownerRepairAction: '重新驗證',
    ownerRepairBusy: '正在驗證…',
    ownerRepairPending: '已登入。正在重新連線…',
    ownerRepairRetry: '重試',
    ownerRepairFailed: '無法驗證。請稍後重試。',
    ownerRepairMismatch: '請使用你目前正在使用的帳號登入。',
    deviceControlAction: '允許',
    deviceControlLater: '稍後再說',
    waitingUnlock: '等待這台 Mac 解鎖',
    signInAgainShort: '需要重新登入',
    gettingReady: name => `${name} 正在準備…`,
    loadingAgents: '正在載入你的助理…',
    agentStatus: (name, status) => `${name} · ${status}`,
    agentReady: '已就緒',
    agentElapsed: seconds => `${seconds} 秒`,
    gettingReadyPanel: '聊天已可使用，助理馬上就好。',
    aiDownTitle: 'Atum 的 AI 暫無回應',
    aiDownHelp: '請稍後再試。',
    chatDownTitle: '暫時無法連線到你的聊天',
    signedOutTitle: '你已登出',
    chatDownHelp: 'Atum 會自動重試。',
    runtimeTitle: '這台 Mac 上缺少 Atum 的一部分',
    runtimeHelp: '請下載最新版 Atum，然後重新開啟。',
    trustTitle: '助理未能完成安全檢查',
    trustHelp: '請檢查連線後再試一次。',
    initializingTitle: '助理仍在設定中',
    initializingHelp: 'Atum 會自動重試。',
    unreachableTitle: '暫時無法連線到 Atum',
    unreachableHelp: '你在這台 Mac 上仍處於登入狀態。請檢查連線後再試一次。',
    engineTitle: '無法開啟你的聊天',
    engineHelp: '你在這台 Mac 上仍處於登入狀態。請再試一次；如果反覆發生，請傳送意見回饋給我們。',
    diskFullHelp: '這台 Mac 的磁碟已滿。請釋出一些空間，Atum 會自動重新連線。',
    stepFailed: '在此步驟停止'
  }
}

export function matrixLaunchCopy(locale: Locale): LaunchCopy {
  return copies[locale]
}

export function useLaunchCopy(): LaunchCopy {
  return matrixLaunchCopy(useI18n().locale)
}

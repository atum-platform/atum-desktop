interface CommandCenterCopy {
  title: string
  help: string
  status: string
  logs: string
  usage: string
  curator: string
  refresh: string
  close: string
  loading: string
  failed: string
  empty: string
  unknown: string
  version: string
  gateway: string
  running: string
  stopped: string
  activeSessions: string
  ok: string
  degraded: string
  dashboard: string
  storage: string
  platforms: string
  file: string
  level: string
  search: string
  truncated: string
  days: string
  sessions: string
  calls: string
  input: string
  output: string
  daily: string
  models: string
  usageHelp: string
  enabled: string
  paused: string
  yes: string
  no: string
  interval: string
  lastRun: string
  noLastRun: string
}
export const matrixCommandCenterCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', CommandCenterCopy> = {
  en: {
    title: 'Command center',
    help: 'Read this agent’s status, logs and recorded usage on this Mac.',
    status: 'Status',
    logs: 'Logs',
    usage: 'Usage',
    curator: 'Curator',
    refresh: 'Refresh',
    close: 'Close',
    loading: 'Loading…',
    failed: 'Could not load this local view. Refresh to try again.',
    empty: 'No records for this view.',
    unknown: 'Unknown',
    version: 'Runtime version',
    gateway: 'Messaging gateway',
    running: 'Running',
    stopped: 'Stopped',
    activeSessions: 'Active sessions',
    ok: 'Healthy',
    degraded: 'Degraded',
    dashboard: 'Management server',
    storage: 'Storage',
    platforms: 'Messaging platforms',
    file: 'Log file',
    level: 'Log level',
    search: 'Search these log lines',
    truncated: 'Some log lines were shortened.',
    days: 'Days',
    sessions: 'Recorded sessions',
    calls: 'API calls',
    input: 'Input tokens',
    output: 'Output tokens',
    daily: 'Daily tokens',
    models: 'Top models',
    usageHelp: 'Usage recorded by this local agent. This is not a wallet balance or bill.',
    enabled: 'Enabled',
    paused: 'Paused',
    yes: 'Yes',
    no: 'No',
    interval: 'Interval (hours)',
    lastRun: 'Last run',
    noLastRun: 'No recorded run'
  },
  vi: {
    title: 'Trung tâm điều hành',
    help: 'Xem trạng thái, nhật ký và mức dùng đã ghi của trợ lý trên máy Mac này.',
    status: 'Trạng thái',
    logs: 'Nhật ký',
    usage: 'Mức dùng',
    curator: 'Quản lý kỹ năng',
    refresh: 'Làm mới',
    close: 'Đóng',
    loading: 'Đang tải…',
    failed: 'Không tải được trang cục bộ này. Làm mới để thử lại.',
    empty: 'Chưa có bản ghi cho trang này.',
    unknown: 'Chưa rõ',
    version: 'Phiên bản môi trường',
    gateway: 'Cổng nhắn tin',
    running: 'Đang chạy',
    stopped: 'Đã dừng',
    activeSessions: 'Phiên đang hoạt động',
    ok: 'Ổn định',
    degraded: 'Suy giảm',
    dashboard: 'Máy chủ quản lý',
    storage: 'Lưu trữ',
    platforms: 'Nền tảng nhắn tin',
    file: 'Tệp nhật ký',
    level: 'Mức nhật ký',
    search: 'Tìm trong các dòng nhật ký này',
    truncated: 'Một số dòng nhật ký đã được rút ngắn.',
    days: 'Số ngày',
    sessions: 'Phiên đã ghi',
    calls: 'Lần gọi API',
    input: 'Token đầu vào',
    output: 'Token đầu ra',
    daily: 'Token theo ngày',
    models: 'Mô hình dùng nhiều',
    usageHelp: 'Mức dùng được trợ lý cục bộ ghi lại. Đây không phải số dư ví hay hóa đơn.',
    enabled: 'Đã bật',
    paused: 'Tạm dừng',
    yes: 'Có',
    no: 'Không',
    interval: 'Chu kỳ (giờ)',
    lastRun: 'Lần chạy gần nhất',
    noLastRun: 'Chưa ghi nhận lần chạy'
  },
  ja: {
    title: 'コマンドセンター',
    help: 'この Mac のエージェントの状態、ログ、記録された使用量を確認します。',
    status: '状態',
    logs: 'ログ',
    usage: '使用量',
    curator: 'スキル管理',
    refresh: '更新',
    close: '閉じる',
    loading: '読み込み中…',
    failed: 'ローカル情報を読み込めませんでした。更新して再試行してください。',
    empty: '記録はありません。',
    unknown: '不明',
    version: 'ランタイムのバージョン',
    gateway: 'メッセージゲートウェイ',
    running: '実行中',
    stopped: '停止',
    activeSessions: 'アクティブなセッション',
    ok: '正常',
    degraded: '一部に問題',
    dashboard: '管理サーバー',
    storage: 'ストレージ',
    platforms: 'メッセージサービス',
    file: 'ログファイル',
    level: 'ログレベル',
    search: '表示中のログを検索',
    truncated: '一部のログ行を短縮しました。',
    days: '日数',
    sessions: '記録されたセッション',
    calls: 'API 呼び出し',
    input: '入力トークン',
    output: '出力トークン',
    daily: '日別トークン',
    models: '主なモデル',
    usageHelp: 'ローカルエージェントが記録した使用量です。ウォレット残高や請求額ではありません。',
    enabled: '有効',
    paused: '一時停止',
    yes: 'はい',
    no: 'いいえ',
    interval: '間隔（時間）',
    lastRun: '最終実行',
    noLastRun: '実行記録なし'
  },
  zh: {
    title: '控制中心',
    help: '查看这台 Mac 上此智能体的状态、日志和已记录用量。',
    status: '状态',
    logs: '日志',
    usage: '用量',
    curator: '技能管理',
    refresh: '刷新',
    close: '关闭',
    loading: '正在加载…',
    failed: '无法加载本地视图，请刷新重试。',
    empty: '此视图暂无记录。',
    unknown: '未知',
    version: '运行时版本',
    gateway: '消息网关',
    running: '运行中',
    stopped: '已停止',
    activeSessions: '活跃会话',
    ok: '正常',
    degraded: '部分异常',
    dashboard: '管理服务器',
    storage: '存储',
    platforms: '消息平台',
    file: '日志文件',
    level: '日志级别',
    search: '搜索这些日志行',
    truncated: '部分日志行已缩短。',
    days: '天数',
    sessions: '已记录会话',
    calls: 'API 调用',
    input: '输入 token',
    output: '输出 token',
    daily: '每日 token',
    models: '常用模型',
    usageHelp: '本地智能体记录的用量，不代表钱包余额或账单。',
    enabled: '已启用',
    paused: '已暂停',
    yes: '是',
    no: '否',
    interval: '间隔（小时）',
    lastRun: '上次运行',
    noLastRun: '暂无运行记录'
  },
  'zh-hant': {
    title: '控制中心',
    help: '檢視此 Mac 上這個智慧代理的狀態、記錄和已記錄用量。',
    status: '狀態',
    logs: '記錄',
    usage: '用量',
    curator: '技能管理',
    refresh: '重新整理',
    close: '關閉',
    loading: '載入中…',
    failed: '無法載入本機檢視，請重新整理再試。',
    empty: '此檢視尚無記錄。',
    unknown: '未知',
    version: '執行階段版本',
    gateway: '訊息閘道',
    running: '執行中',
    stopped: '已停止',
    activeSessions: '作用中工作階段',
    ok: '正常',
    degraded: '部分異常',
    dashboard: '管理伺服器',
    storage: '儲存',
    platforms: '訊息平台',
    file: '記錄檔',
    level: '記錄等級',
    search: '搜尋這些記錄行',
    truncated: '部分記錄行已縮短。',
    days: '天數',
    sessions: '已記錄工作階段',
    calls: 'API 呼叫',
    input: '輸入 token',
    output: '輸出 token',
    daily: '每日 token',
    models: '常用模型',
    usageHelp: '本機智慧代理記錄的用量，不代表錢包餘額或帳單。',
    enabled: '已啟用',
    paused: '已暫停',
    yes: '是',
    no: '否',
    interval: '間隔（小時）',
    lastRun: '上次執行',
    noLastRun: '尚無執行記錄'
  }
}

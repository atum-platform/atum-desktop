export interface MatrixCompanyFundingCopy {
  title: string
  available: string
  held: string
  funding: string
  enabled: string
  taskLimit: string
  protons: string
  save: string
  loading: string
  unavailable: string
  authentication: string
  denied: string
  invalid: string
  policyUnknown: string
  checkoutUnavailable: string
  /** Names an example amount, written the way this locale writes numbers. */
  limitInvalid: (example: string) => string
}

const copy: Record<string, MatrixCompanyFundingCopy> = {
  en: {
    title: 'Shared spending', available: 'Available', held: 'Held for running tasks', funding: 'Spending settings',
    enabled: 'Let assistants spend company Protons', taskLimit: 'Limit per task', protons: 'Protons',
    save: 'Save spending settings', loading: 'Loading shared spending…',
    unavailable: 'Shared spending can’t load right now. Check your connection and refresh.',
    denied: 'You no longer have access to this company’s spending.',
    authentication: 'Sign in again to see shared spending.',
    invalid: 'Shared spending couldn’t be read. Refresh to try again.', policyUnknown: 'Checking the current settings…',
    checkoutUnavailable: 'Topping up company Protons isn’t available yet.',
    limitInvalid: example => `Enter a Proton amount, e.g. ${example}.`
  },
  vi: {
    title: 'Chi tiêu chung', available: 'Khả dụng', held: 'Đang tạm giữ cho việc đang chạy', funding: 'Cài đặt chi tiêu',
    enabled: 'Cho phép trợ lý dùng Proton của công ty', taskLimit: 'Giới hạn mỗi việc', protons: 'Proton',
    save: 'Lưu cài đặt chi tiêu', loading: 'Đang tải chi tiêu chung…',
    unavailable: 'Chưa tải được chi tiêu chung. Hãy kiểm tra kết nối rồi làm mới.',
    denied: 'Bạn không còn quyền xem chi tiêu của công ty này.',
    authentication: 'Đăng nhập lại để xem chi tiêu chung.',
    invalid: 'Chưa đọc được chi tiêu chung. Hãy làm mới để thử lại.', policyUnknown: 'Đang kiểm tra cài đặt hiện tại…',
    checkoutUnavailable: 'Chưa nạp được Proton cho công ty.',
    limitInvalid: example => `Nhập số Proton, ví dụ ${example}.`
  },
  ja: {
    title: '共有の支出', available: '利用可能', held: '実行中のタスク用に保留', funding: '支出の設定',
    enabled: 'アシスタントが会社の Proton を使えるようにする', taskLimit: 'タスクごとの上限', protons: 'Protons',
    save: '支出の設定を保存', loading: '共有の支出を読み込んでいます…',
    unavailable: '共有の支出を読み込めません。接続を確認して更新してください。',
    denied: 'この会社の支出にアクセスできなくなりました。',
    authentication: '共有の支出を表示するには再度サインインしてください。',
    invalid: '共有の支出を読み取れませんでした。更新して再試行してください。', policyUnknown: '現在の設定を確認しています…',
    checkoutUnavailable: '会社の Proton のチャージはまだ利用できません。',
    limitInvalid: example => `Proton の数を入力してください（例：${example}）。`
  },
  zh: {
    title: '共享支出', available: '可用', held: '为进行中的任务冻结', funding: '支出设置',
    enabled: '允许助手使用公司的 Proton', taskLimit: '每项任务上限', protons: 'Protons',
    save: '保存支出设置', loading: '正在加载共享支出…',
    unavailable: '暂时无法加载共享支出。请检查连接后刷新。',
    denied: '你已无权查看此公司的支出。',
    authentication: '请重新登录以查看共享支出。',
    invalid: '无法读取共享支出。请刷新后重试。', policyUnknown: '正在确认当前设置…',
    checkoutUnavailable: '暂不支持为公司充值 Proton。',
    limitInvalid: example => `请输入 Proton 数量，例如 ${example}。`
  },
  'zh-hant': {
    title: '共用支出', available: '可用', held: '為進行中的任務保留', funding: '支出設定',
    enabled: '允許助理使用公司的 Proton', taskLimit: '每項任務上限', protons: 'Protons',
    save: '儲存支出設定', loading: '正在載入共用支出…',
    unavailable: '暫時無法載入共用支出。請檢查連線後重新整理。',
    denied: '你已無權查看此公司的支出。',
    authentication: '請重新登入以查看共用支出。',
    invalid: '無法讀取共用支出。請重新整理後再試。', policyUnknown: '正在確認目前設定…',
    checkoutUnavailable: '暫不支援為公司儲值 Proton。',
    limitInvalid: example => `請輸入 Proton 數量，例如 ${example}。`
  }
}

export function matrixCompanyFundingCopy(locale: string): MatrixCompanyFundingCopy {
  return Object.hasOwn(copy, locale) ? copy[locale]! : copy.en
}

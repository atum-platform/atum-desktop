export interface MatrixWalletActivityCopy {
  label: string
  status: string
}

export interface MatrixWalletCopy {
  about: string
  activity: string
  activityEntry: (kind: string, status: string, amount: number) => MatrixWalletActivityCopy
  allowance: (kind: 'founding' | 'standard', amount: string, state: 'granted' | 'deferred') => string
  details: string
  earned: string
  held: string
  historyUnavailable: string
  loadMore: string
  paid: string
  promo: string
  /** The primary action wherever Protons are counted: the Store's top-up. */
  topUp: string
  /** The same action as a trailing word (the account menu). */
  topUpShort: string
  /** Where running out stopped something: "Top up Protons". */
  topUpMore: string
}

function activityEntry(
  kind: string,
  status: string,
  amount: number,
  knownKinds: Record<string, string>,
  knownStatuses: Record<string, string>,
  fallback: { credit: string; debit: string; activity: string; status: string }
): MatrixWalletActivityCopy {
  return {
    label: knownKinds[kind] ?? (amount > 0 ? fallback.credit : amount < 0 ? fallback.debit : fallback.activity),
    status: knownStatuses[status] ?? `${fallback.status}: ${status}`
  }
}

const english: MatrixWalletCopy = {
  about: 'About Protons',
  activity: 'Activity',
  activityEntry: (kind, status, amount) =>
    activityEntry(
      kind,
      status,
      amount,
      { usage: 'AI usage', purchase: 'Purchase', topup: 'Top up', grant: 'Grant', sale: 'Sale', reversal: 'Reversal', agent_hire: 'Assistant hire', agent_hire_renewal: 'Assistant renewal', company_transfer: 'Sent to company' },
      { pending: 'Pending', charged: 'Charged', released: 'Released', completed: 'Completed' },
      { credit: 'Credit', debit: 'Debit', activity: 'Activity', status: 'Status' }
    ),
  allowance: (kind, amount, state) =>
    `${kind === 'founding' ? 'Founding bonus' : 'Welcome bonus'}: ${amount} Protons${state === 'deferred' ? ' · on its way' : ''}`,
  details: 'Details',
  earned: 'Earned',
  held: 'Held for running tasks',
  historyUnavailable: 'Activity could not be loaded.',
  loadMore: 'Load more',
  paid: 'Topped up',
  promo: 'Bonus',
  topUp: 'Top up',
  topUpShort: 'Top up',
  topUpMore: 'Top up Protons'
}

const vietnamese: MatrixWalletCopy = {
  about: 'Về Proton',
  activity: 'Hoạt động',
  activityEntry: (kind, status, amount) =>
    activityEntry(
      kind,
      status,
      amount,
      { usage: 'Dùng AI', purchase: 'Mua', topup: 'Nạp', grant: 'Được tặng', sale: 'Bán', reversal: 'Hoàn lại', agent_hire: 'Thuê trợ lý', agent_hire_renewal: 'Gia hạn trợ lý', company_transfer: 'Nạp cho công ty' },
      { pending: 'Đang chờ', charged: 'Đã tính', released: 'Đã trả lại', completed: 'Hoàn tất' },
      { credit: 'Cộng', debit: 'Trừ', activity: 'Hoạt động', status: 'Trạng thái' }
    ),
  allowance: (kind, amount, state) =>
    `${kind === 'founding' ? 'Quà sáng lập' : 'Quà chào mừng'}: ${amount} Proton${state === 'deferred' ? ' · đang đến' : ''}`,
  details: 'Chi tiết',
  earned: 'Đã kiếm',
  held: 'Đang tạm giữ cho việc đang chạy',
  historyUnavailable: 'Không thể tải hoạt động.',
  loadMore: 'Tải thêm',
  paid: 'Đã nạp',
  promo: 'Được tặng',
  topUp: 'Nạp Proton',
  topUpShort: 'Nạp thêm',
  topUpMore: 'Nạp thêm Proton'
}

const japanese: MatrixWalletCopy = {
  about: 'Proton について',
  activity: 'アクティビティ',
  activityEntry: (kind, status, amount) =>
    activityEntry(
      kind,
      status,
      amount,
      { usage: 'AI の利用', purchase: '購入', topup: 'チャージ', grant: '付与', sale: '販売', reversal: '取り消し', agent_hire: 'アシスタント雇用', agent_hire_renewal: 'アシスタント更新', company_transfer: '会社へ移動' },
      { pending: '保留中', charged: '請求済み', released: '解放済み', completed: '完了' },
      { credit: '入金', debit: '出金', activity: 'アクティビティ', status: '状態' }
    ),
  allowance: (kind, amount, state) =>
    `${kind === 'founding' ? '創設メンバー特典' : 'ウェルカム特典'}: ${amount} Proton${state === 'deferred' ? ' · 付与待ち' : ''}`,
  details: '詳細',
  earned: '獲得',
  held: '実行中のタスク用に確保',
  historyUnavailable: 'アクティビティを読み込めませんでした。',
  loadMore: 'さらに読み込む',
  paid: 'チャージ済み',
  promo: '特典',
  topUp: 'チャージ',
  topUpShort: 'チャージ',
  topUpMore: 'Proton をチャージ'
}

const chinese: MatrixWalletCopy = {
  about: '关于 Proton',
  activity: '动态',
  activityEntry: (kind, status, amount) =>
    activityEntry(
      kind,
      status,
      amount,
      { usage: 'AI 使用', purchase: '购买', topup: '充值', grant: '赠送', sale: '销售', reversal: '退回', agent_hire: '聘请助手', agent_hire_renewal: '助手续期', company_transfer: '转给公司' },
      { pending: '处理中', charged: '已扣除', released: '已释放', completed: '已完成' },
      { credit: '入账', debit: '扣除', activity: '动态', status: '状态' }
    ),
  allowance: (kind, amount, state) =>
    `${kind === 'founding' ? '创始会员礼' : '欢迎礼'}：${amount} Proton${state === 'deferred' ? ' · 即将到账' : ''}`,
  details: '详情',
  earned: '已赚取',
  held: '为进行中的任务暂扣',
  historyUnavailable: '无法加载动态。',
  loadMore: '加载更多',
  paid: '已充值',
  promo: '赠送',
  topUp: '充值',
  topUpShort: '充值',
  topUpMore: '充值 Proton'
}

const traditionalChinese: MatrixWalletCopy = {
  about: '關於 Proton',
  activity: '動態',
  activityEntry: (kind, status, amount) =>
    activityEntry(
      kind,
      status,
      amount,
      { usage: 'AI 使用', purchase: '購買', topup: '儲值', grant: '贈送', sale: '銷售', reversal: '退回', agent_hire: '聘請助理', agent_hire_renewal: '助理續期', company_transfer: '轉給公司' },
      { pending: '處理中', charged: '已扣除', released: '已釋放', completed: '已完成' },
      { credit: '入帳', debit: '扣除', activity: '動態', status: '狀態' }
    ),
  allowance: (kind, amount, state) =>
    `${kind === 'founding' ? '創始會員禮' : '歡迎禮'}：${amount} Proton${state === 'deferred' ? ' · 即將入帳' : ''}`,
  details: '詳情',
  earned: '已賺取',
  held: '為進行中的任務暫扣',
  historyUnavailable: '無法載入動態。',
  loadMore: '載入更多',
  paid: '已儲值',
  promo: '贈送',
  topUp: '儲值',
  topUpShort: '儲值',
  topUpMore: '儲值 Proton'
}

export function matrixWalletCopy(locale: string): MatrixWalletCopy {
  const id = locale.toLowerCase()

  if (id.startsWith('vi')) {
    return vietnamese
  }

  if (id.startsWith('ja')) {
    return japanese
  }

  if (id === 'zh-hant' || id === 'zh-tw' || id === 'zh-hk') {
    return traditionalChinese
  }

  return id.startsWith('zh') ? chinese : english
}

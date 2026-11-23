/**
 * Words the Team Space revamp adds (search pane, settings sections, the right detail pane, readiness lines,
 * provisional suggestions). Short by rule: one line, no explainer paragraphs. Desktop only.
 */
export interface TeamSpaceRevampCopy {
  search: string
  searchMessagesFor: (query: string) => string
  searchFor: (query: string) => string
  settingsSections: string
  people: string
  workspace: string
  ai: string
  billing: string
  hiringPreparing: string
  companyWallet: string
  openWallet: string
  preparingChannel: string
  channelFailed: string
  tryAgain: string
  privateChiefOfStaff: string
  suggested: string
  suggestedHint: string
  showAllActivity: (count: number) => string
  showLessActivity: string
  boardViews: string
}

const copy: Record<string, TeamSpaceRevampCopy> = {
  en: {
    search: 'Search',
    searchFor: query => `Search “${query}”`,
    searchMessagesFor: query => `Search messages for “${query}”`,
    settingsSections: 'Settings sections',
    people: 'People',
    workspace: 'Workspace',
    ai: 'AI',
    billing: 'Billing',
    hiringPreparing: 'Company hiring is being prepared',
    companyWallet: 'Company wallet',
    openWallet: 'Open',
    preparingChannel: 'Preparing your channel…',
    channelFailed: 'Couldn’t open this channel.',
    tryAgain: 'Try again',
    privateChiefOfStaff: 'Private Chief of Staff',
    suggested: 'Suggested',
    suggestedHint: 'Not on the board until someone accepts it',
    showAllActivity: count => `Show all activity (${count})`,
    showLessActivity: 'Show less',
    boardViews: 'Board views'
  },
  vi: {
    search: 'Tìm kiếm',
    searchFor: query => `Tìm “${query}”`,
    searchMessagesFor: query => `Tìm tin nhắn có “${query}”`,
    settingsSections: 'Mục cài đặt',
    people: 'Thành viên',
    workspace: 'Không gian',
    ai: 'AI',
    billing: 'Thanh toán',
    hiringPreparing: 'Tính năng thuê cho công ty đang được chuẩn bị',
    companyWallet: 'Ví công ty',
    openWallet: 'Mở',
    preparingChannel: 'Đang chuẩn bị kênh…',
    channelFailed: 'Không mở được kênh này.',
    tryAgain: 'Thử lại',
    privateChiefOfStaff: 'Chief of Staff riêng',
    suggested: 'Đề xuất',
    suggestedHint: 'Chưa lên bảng cho đến khi có người chấp nhận',
    showAllActivity: count => `Xem toàn bộ hoạt động (${count})`,
    showLessActivity: 'Thu gọn',
    boardViews: 'Chế độ xem bảng'
  },
  ja: {
    search: '検索',
    searchFor: query => `「${query}」を検索`,
    searchMessagesFor: query => `「${query}」をメッセージから検索`,
    settingsSections: '設定セクション',
    people: 'メンバー',
    workspace: 'ワークスペース',
    ai: 'AI',
    billing: '支払い',
    hiringPreparing: '会社での採用は準備中です',
    companyWallet: '会社のウォレット',
    openWallet: '開く',
    preparingChannel: 'チャンネルを準備しています…',
    channelFailed: 'このチャンネルを開けませんでした。',
    tryAgain: 'もう一度',
    privateChiefOfStaff: '自分専用の Chief of Staff',
    suggested: '提案',
    suggestedHint: '誰かが承認するまでボードには載りません',
    showAllActivity: count => `すべてのアクティビティ (${count})`,
    showLessActivity: '閉じる',
    boardViews: 'ボードの表示'
  },
  zh: {
    search: '搜索',
    searchFor: query => `搜索“${query}”`,
    searchMessagesFor: query => `在消息中搜索“${query}”`,
    settingsSections: '设置分区',
    people: '成员',
    workspace: '工作区',
    ai: 'AI',
    billing: '账单',
    hiringPreparing: '公司招聘功能正在准备中',
    companyWallet: '公司钱包',
    openWallet: '打开',
    preparingChannel: '正在准备频道…',
    channelFailed: '无法打开此频道。',
    tryAgain: '重试',
    privateChiefOfStaff: '私人 Chief of Staff',
    suggested: '建议',
    suggestedHint: '有人接受后才会加入看板',
    showAllActivity: count => `查看全部动态（${count}）`,
    showLessActivity: '收起',
    boardViews: '看板视图'
  },
  'zh-hant': {
    search: '搜尋',
    searchFor: query => `搜尋「${query}」`,
    searchMessagesFor: query => `在訊息中搜尋「${query}」`,
    settingsSections: '設定分區',
    people: '成員',
    workspace: '工作區',
    ai: 'AI',
    billing: '帳單',
    hiringPreparing: '公司招聘功能正在準備中',
    companyWallet: '公司錢包',
    openWallet: '開啟',
    preparingChannel: '正在準備頻道…',
    channelFailed: '無法開啟此頻道。',
    tryAgain: '重試',
    privateChiefOfStaff: '私人 Chief of Staff',
    suggested: '建議',
    suggestedHint: '有人接受後才會加入看板',
    showAllActivity: count => `查看全部動態（${count}）`,
    showLessActivity: '收起',
    boardViews: '看板檢視'
  }
}

export function teamSpaceRevampCopy(locale: string): TeamSpaceRevampCopy {
  return Object.hasOwn(copy, locale) ? copy[locale]! : copy.en!
}

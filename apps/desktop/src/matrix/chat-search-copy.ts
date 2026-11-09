import { type Locale, useI18n } from '@/i18n'

/** The header's search in the open chat (launch night, 2026-10-04). */
const en = {
  search: 'Search this chat',
  older: 'Older match',
  newer: 'Newer match',
  close: 'Close search',
  noResults: 'No results',
  result: (index: number, count: number) => `Result ${index} of ${count}`,
  searching: (searched: number, bound: number) => `Searching ${searched} of ${bound} messages…`,
  searched: (searched: number, bound: number) => `Searched ${searched} of ${bound}`
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    search: 'Tìm trong cuộc trò chuyện',
    older: 'Kết quả cũ hơn',
    newer: 'Kết quả mới hơn',
    close: 'Đóng tìm kiếm',
    noResults: 'Không có kết quả',
    result: (index, count) => `Kết quả ${index} trên ${count}`,
    searching: (searched, bound) => `Đang tìm ${searched} trên ${bound} tin nhắn…`,
    searched: (searched, bound) => `Đã tìm ${searched} trên ${bound}`
  },
  ja: {
    search: 'このチャット内を検索',
    older: '前の一致',
    newer: '次の一致',
    close: '検索を閉じる',
    noResults: '一致なし',
    result: (index, count) => `${count}件中${index}件目`,
    searching: (searched, bound) => `${bound}件中${searched}件を検索中…`,
    searched: (searched, bound) => `${bound}件中${searched}件を検索済み`
  },
  zh: {
    search: '在此聊天中搜索',
    older: '更早的结果',
    newer: '更新的结果',
    close: '关闭搜索',
    noResults: '无结果',
    result: (index, count) => `第 ${index} 个结果，共 ${count} 个`,
    searching: (searched, bound) => `正在搜索 ${searched}/${bound} 条消息…`,
    searched: (searched, bound) => `已搜索 ${searched}/${bound}`
  },
  'zh-hant': {
    search: '在此聊天中搜尋',
    older: '更早的結果',
    newer: '更新的結果',
    close: '關閉搜尋',
    noResults: '無結果',
    result: (index, count) => `第 ${index} 個結果，共 ${count} 個`,
    searching: (searched, bound) => `正在搜尋 ${searched}/${bound} 則訊息…`,
    searched: (searched, bound) => `已搜尋 ${searched}/${bound}`
  }
}

export function chatSearchCopy(locale: Locale) {
  return copies[locale]
}

export function useChatSearchCopy() {
  return copies[useI18n().locale]
}

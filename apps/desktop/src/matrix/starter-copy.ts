export interface MatrixStarterCopy {
  retry: string
  title: string
  body: (chats: string) => string
}

const copy: Record<string, MatrixStarterCopy> = {
  en: {
    retry: 'Try again',
    title: 'Free to try',
    body: chats => `Enough for about ${chats} chats.`
  },
  vi: {
    retry: 'Thử lại',
    title: 'Dùng thử miễn phí',
    body: chats => `Đủ cho khoảng ${chats} cuộc trò chuyện.`
  },
  zh: {
    retry: '重试',
    title: '免费试用',
    body: chats => `大约够聊 ${chats} 次。`
  },
  'zh-hant': {
    retry: '再試一次',
    title: '免費試用',
    body: chats => `大約夠聊 ${chats} 次。`
  },
  ja: {
    retry: 'もう一度試す',
    title: '無料で試す',
    body: chats => `約${chats}回のチャットに使えます。`
  }
}

export function matrixStarterCopy(locale: string): MatrixStarterCopy {
  return copy[locale.toLowerCase()] ?? copy.en
}

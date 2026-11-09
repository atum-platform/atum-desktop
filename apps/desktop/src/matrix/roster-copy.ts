import { type Locale, useI18n } from '@/i18n'

/**
 * Words for the chat list's rows (launch night, Element's room list): what a preview line
 * says about a message that is not plain words, who wrote it, and what the badges mean to a
 * screen reader. Short on purpose: a preview is one line in a narrow column.
 */
const en = {
  /** "You: …" before your own latest message. */
  you: 'You',
  photo: '📷 Photo',
  video: '🎬 Video',
  audio: '🎵 Audio',
  sticker: 'Sticker',
  file: '📎 File',
  fileNamed: (name: string) => `📎 ${name}`,
  /** A message not decrypted (yet): Element's "Waiting for this message". */
  waiting: '🔒 Waiting for this message',
  /** Badges, as a screen reader says them. */
  mentions: 'Mentions you',
  newMessages: 'New messages',
  muted: 'Notifications off',
  comingSoon: 'Coming soon',
  /** Who wrote a message, before it: "Lan: see you at 7". */
  byline: (name: string, text: string) => `${name}: ${text}`
}

export type MatrixRosterCopy = typeof en

const copies: Record<Locale, MatrixRosterCopy> = {
  en,
  vi: {
    you: 'Bạn',
    photo: '📷 Ảnh',
    video: '🎬 Video',
    audio: '🎵 Âm thanh',
    sticker: 'Nhãn dán',
    file: '📎 Tệp',
    fileNamed: name => `📎 ${name}`,
    waiting: '🔒 Đang chờ tin nhắn',
    mentions: 'Nhắc đến bạn',
    newMessages: 'Có tin nhắn mới',
    muted: 'Đã tắt thông báo',
    comingSoon: 'Sắp ra mắt',
    byline: (name, text) => `${name}: ${text}`
  },
  ja: {
    you: 'あなた',
    photo: '📷 写真',
    video: '🎬 動画',
    audio: '🎵 音声',
    sticker: 'ステッカー',
    file: '📎 ファイル',
    fileNamed: name => `📎 ${name}`,
    waiting: '🔒 メッセージを待っています',
    mentions: 'あなたへのメンション',
    newMessages: '新着メッセージ',
    muted: '通知オフ',
    comingSoon: '近日公開',
    byline: (name, text) => `${name}: ${text}`
  },
  zh: {
    you: '你',
    photo: '📷 图片',
    video: '🎬 视频',
    audio: '🎵 音频',
    sticker: '贴纸',
    file: '📎 文件',
    fileNamed: name => `📎 ${name}`,
    waiting: '🔒 正在等待此消息',
    mentions: '提到了你',
    newMessages: '有新消息',
    muted: '已关闭通知',
    comingSoon: '即将推出',
    byline: (name, text) => `${name}：${text}`
  },
  'zh-hant': {
    you: '你',
    photo: '📷 照片',
    video: '🎬 影片',
    audio: '🎵 音訊',
    sticker: '貼圖',
    file: '📎 檔案',
    fileNamed: name => `📎 ${name}`,
    waiting: '🔒 正在等待此訊息',
    mentions: '提到了你',
    newMessages: '有新訊息',
    muted: '已關閉通知',
    comingSoon: '即將推出',
    byline: (name, text) => `${name}：${text}`
  }
}

export function matrixRosterCopy(locale: Locale): MatrixRosterCopy {
  return copies[locale]
}

export function useRosterCopy(): MatrixRosterCopy {
  return copies[useI18n().locale]
}

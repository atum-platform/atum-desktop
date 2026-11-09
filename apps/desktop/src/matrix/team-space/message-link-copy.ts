import { useI18n } from '@/i18n'

export interface MessageLinkCopy {
  copyLink: string
  notMember: string
  unavailable: string
}

const en: MessageLinkCopy = {
  copyLink: 'Copy link',
  notMember: 'You’re no longer a member of this channel.',
  unavailable: 'This message is unavailable.'
}

const vi: MessageLinkCopy = {
  copyLink: 'Sao chép liên kết',
  notMember: 'Bạn không còn là thành viên của kênh này.',
  unavailable: 'Không còn xem được tin nhắn này.'
}

const ja: MessageLinkCopy = {
  copyLink: 'リンクをコピー',
  notMember: 'このチャンネルのメンバーではなくなりました。',
  unavailable: 'このメッセージは表示できません。'
}

const zh: MessageLinkCopy = {
  copyLink: '复制链接',
  notMember: '你已不再是此频道的成员。',
  unavailable: '此消息不可用。'
}

const zhHant: MessageLinkCopy = {
  copyLink: '複製連結',
  notMember: '你已不再是此頻道的成員。',
  unavailable: '此訊息無法查看。'
}

export function messageLinkCopy(locale: string): MessageLinkCopy {
  return ({ vi, ja, zh, 'zh-hant': zhHant } as Record<string, MessageLinkCopy>)[locale.toLowerCase()] ?? en
}

export function useMessageLinkCopy(): MessageLinkCopy {
  return messageLinkCopy(useI18n().locale)
}

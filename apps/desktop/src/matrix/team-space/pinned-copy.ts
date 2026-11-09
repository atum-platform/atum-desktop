import { useI18n } from '@/i18n'

const en = {
  pinMessage: 'Pin message',
  unpinMessage: 'Unpin message',
  pinnedMessage: 'Pinned',
  pinnedMessages: 'Pinned messages',
  pinnedMessageCount: (count: number) => `${count} pinned ${count === 1 ? 'message' : 'messages'}`,
  noPinnedMessages: 'No pinned messages yet.',
  pinnedMessageUnavailable: 'This pinned message is unavailable.',
  showPinnedMessage: 'Jump to message',
  closePinnedMessages: 'Close pinned messages'
}

const vi: typeof en = {
  pinMessage: 'Ghim tin nhắn',
  unpinMessage: 'Bỏ ghim tin nhắn',
  pinnedMessage: 'Đã ghim',
  pinnedMessages: 'Tin nhắn đã ghim',
  pinnedMessageCount: count => `${count} tin nhắn đã ghim`,
  noPinnedMessages: 'Chưa có tin nhắn nào được ghim.',
  pinnedMessageUnavailable: 'Tin nhắn đã ghim này hiện không xem được.',
  showPinnedMessage: 'Đến tin nhắn',
  closePinnedMessages: 'Đóng tin nhắn đã ghim'
}

export function usePinnedMessagesCopy() {
  return useI18n().locale === 'vi' ? vi : en
}

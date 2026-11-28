import { type Locale, useI18n } from '@/i18n'

const en = {
  /** On the old room: it was replaced. */
  moved: 'This chat moved to a new room.',
  open: 'Open new room',
  join: 'Join new room',
  /** The replacement's create event names another room, or its state is not readable yet. */
  unconfirmed: 'This chat moved, but the new room can’t be confirmed.',
  /** Joining failed (not allowed, gone, offline). Earlier messages stay readable in this room. */
  unavailable: 'The new room isn’t available. Earlier messages stay here.',
  /** On the replacement: it continues an earlier room. */
  continues: 'This room continues an earlier one.',
  earlier: 'See earlier messages'
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    moved: 'Cuộc trò chuyện này đã chuyển sang phòng mới.',
    open: 'Mở phòng mới',
    join: 'Vào phòng mới',
    unconfirmed: 'Cuộc trò chuyện đã chuyển, nhưng chưa xác nhận được phòng mới.',
    unavailable: 'Không vào được phòng mới. Tin nhắn cũ vẫn ở đây.',
    continues: 'Phòng này tiếp nối một phòng trước.',
    earlier: 'Xem tin nhắn trước đó'
  },
  ja: {
    moved: 'この会話は新しいルームに移動しました。',
    open: '新しいルームを開く',
    join: '新しいルームに参加',
    unconfirmed: '会話は移動しましたが、新しいルームを確認できません。',
    unavailable: '新しいルームを利用できません。以前のメッセージはここに残ります。',
    continues: 'このルームは以前のルームの続きです。',
    earlier: '以前のメッセージを見る'
  },
  zh: {
    moved: '此对话已移至新房间。',
    open: '打开新房间',
    join: '加入新房间',
    unconfirmed: '对话已移动，但无法确认新房间。',
    unavailable: '无法使用新房间。更早的消息仍保留在此。',
    continues: '此房间延续自之前的房间。',
    earlier: '查看更早的消息'
  },
  'zh-hant': {
    moved: '此對話已移至新房間。',
    open: '開啟新房間',
    join: '加入新房間',
    unconfirmed: '對話已移動，但無法確認新房間。',
    unavailable: '無法使用新房間。更早的訊息仍保留於此。',
    continues: '此房間延續自先前的房間。',
    earlier: '查看更早的訊息'
  }
}

export function useRoomUpgradeCopy() {
  return copies[useI18n().locale]
}

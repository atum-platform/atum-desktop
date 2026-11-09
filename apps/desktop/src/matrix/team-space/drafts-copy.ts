import { useI18n } from '@/i18n'

export interface DraftsCopy {
  title: string
  emptyTitle: string
  emptyBody: string
  roomDraft: string
  threadDraft: string
  updated(value: string): string
  open(room: string): string
  failed: string
}

const en: DraftsCopy = {
  title: 'Drafts',
  emptyTitle: 'No drafts',
  emptyBody: 'Messages you start in Team space will appear here.',
  roomDraft: 'Message draft',
  threadDraft: 'Thread draft',
  updated: value => `Updated ${value}`,
  open: room => `Open draft in ${room}`,
  failed: 'Couldn’t open this draft. Try again.'
}

const vi: DraftsCopy = {
  title: 'Bản nháp',
  emptyTitle: 'Chưa có bản nháp',
  emptyBody: 'Tin nhắn bạn bắt đầu trong Không gian nhóm sẽ xuất hiện ở đây.',
  roomDraft: 'Bản nháp tin nhắn',
  threadDraft: 'Bản nháp chuỗi thảo luận',
  updated: value => `Cập nhật ${value}`,
  open: room => `Mở bản nháp trong ${room}`,
  failed: 'Không mở được bản nháp này. Hãy thử lại.'
}

const ja: DraftsCopy = {
  title: '下書き',
  emptyTitle: '下書きはありません',
  emptyBody: 'チームスペースで書き始めたメッセージがここに表示されます。',
  roomDraft: 'メッセージの下書き',
  threadDraft: 'スレッドの下書き',
  updated: value => `${value}に更新`,
  open: room => `${room} の下書きを開く`,
  failed: 'この下書きを開けませんでした。もう一度お試しください。'
}

const zh: DraftsCopy = {
  title: '草稿',
  emptyTitle: '暂无草稿',
  emptyBody: '你在团队空间中开始撰写的消息会显示在这里。',
  roomDraft: '消息草稿',
  threadDraft: '讨论串草稿',
  updated: value => `更新于 ${value}`,
  open: room => `打开 ${room} 中的草稿`,
  failed: '无法打开此草稿，请重试。'
}

const zhHant: DraftsCopy = {
  title: '草稿',
  emptyTitle: '暫無草稿',
  emptyBody: '你在團隊空間中開始撰寫的訊息會顯示在這裡。',
  roomDraft: '訊息草稿',
  threadDraft: '討論串草稿',
  updated: value => `更新於 ${value}`,
  open: room => `開啟 ${room} 中的草稿`,
  failed: '無法開啟此草稿，請再試一次。'
}

export function draftsCopy(locale: string): DraftsCopy {
  return ({ vi, ja, zh, 'zh-hant': zhHant } as Record<string, DraftsCopy>)[locale.toLowerCase()] ?? en
}

export function useDraftsCopy(): DraftsCopy {
  return draftsCopy(useI18n().locale)
}

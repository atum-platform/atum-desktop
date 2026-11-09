import { useI18n } from '@/i18n'

export interface ActivityCopy {
  title: string
  all: string
  mentions: string
  filterLabel: string
  mention: string
  threadReply: string
  unread: string
  emptyAllTitle: string
  emptyAllBody: string
  emptyMentionsTitle: string
  emptyMentionsBody: string
  loadMore: string
  open: (room: string) => string
  failed: string
  someone: string
}

const en: ActivityCopy = {
  title: 'Activity',
  all: 'All',
  mentions: 'Mentions',
  filterLabel: 'Filter activity',
  mention: 'Mentioned you',
  threadReply: 'Thread reply',
  unread: 'Unread',
  emptyAllTitle: 'No activity yet',
  emptyAllBody: 'Mentions and replies in your threads will appear here.',
  emptyMentionsTitle: 'No mentions yet',
  emptyMentionsBody: 'Messages that mention you will appear here.',
  loadMore: 'Load more',
  open: room => `Open in ${room}`,
  failed: 'Couldn’t open this message. Try again.',
  someone: 'Someone'
}

const vi: ActivityCopy = {
  title: 'Hoạt động',
  all: 'Tất cả',
  mentions: 'Lượt nhắc',
  filterLabel: 'Lọc hoạt động',
  mention: 'Đã nhắc đến bạn',
  threadReply: 'Trả lời trong luồng',
  unread: 'Chưa đọc',
  emptyAllTitle: 'Chưa có hoạt động',
  emptyAllBody: 'Lượt nhắc và câu trả lời trong luồng của bạn sẽ xuất hiện ở đây.',
  emptyMentionsTitle: 'Chưa có lượt nhắc',
  emptyMentionsBody: 'Tin nhắn nhắc đến bạn sẽ xuất hiện ở đây.',
  loadMore: 'Xem thêm',
  open: room => `Mở trong ${room}`,
  failed: 'Không mở được tin nhắn này. Hãy thử lại.',
  someone: 'Ai đó'
}

const ja: ActivityCopy = {
  title: 'アクティビティ',
  all: 'すべて',
  mentions: 'メンション',
  filterLabel: 'アクティビティを絞り込む',
  mention: 'あなたへのメンション',
  threadReply: 'スレッドの返信',
  unread: '未読',
  emptyAllTitle: 'まだアクティビティはありません',
  emptyAllBody: 'メンションや参加したスレッドへの返信がここに表示されます。',
  emptyMentionsTitle: 'まだメンションはありません',
  emptyMentionsBody: 'あなたをメンションしたメッセージがここに表示されます。',
  loadMore: 'さらに読み込む',
  open: room => `${room} で開く`,
  failed: 'このメッセージを開けませんでした。もう一度お試しください。',
  someone: '誰か'
}

const zh: ActivityCopy = {
  title: '活动',
  all: '全部',
  mentions: '提及',
  filterLabel: '筛选活动',
  mention: '提及了你',
  threadReply: '讨论串回复',
  unread: '未读',
  emptyAllTitle: '暂无活动',
  emptyAllBody: '提及和你参与的讨论串回复会显示在这里。',
  emptyMentionsTitle: '暂无提及',
  emptyMentionsBody: '提及你的消息会显示在这里。',
  loadMore: '加载更多',
  open: room => `在 ${room} 中打开`,
  failed: '无法打开此消息，请重试。',
  someone: '某人'
}

const zhHant: ActivityCopy = {
  title: '活動',
  all: '全部',
  mentions: '提及',
  filterLabel: '篩選活動',
  mention: '提及了你',
  threadReply: '討論串回覆',
  unread: '未讀',
  emptyAllTitle: '暫無活動',
  emptyAllBody: '提及和你參與的討論串回覆會顯示在這裡。',
  emptyMentionsTitle: '暫無提及',
  emptyMentionsBody: '提及你的訊息會顯示在這裡。',
  loadMore: '載入更多',
  open: room => `在 ${room} 中開啟`,
  failed: '無法開啟此訊息，請再試一次。',
  someone: '某人'
}

export function activityCopy(locale: string): ActivityCopy {
  return ({ vi, ja, zh, 'zh-hant': zhHant } as Record<string, ActivityCopy>)[locale.toLowerCase()] ?? en
}

export function useActivityCopy(): ActivityCopy {
  return activityCopy(useI18n().locale)
}

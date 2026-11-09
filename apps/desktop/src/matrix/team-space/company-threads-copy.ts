import { useI18n } from '@/i18n'

export interface CompanyThreadsCopy {
  title: string
  filterLabel: string
  recent: string
  following: string
  unread: string
  follow: string
  unfollow: string
  markRead: string
  replies(count: number): string
  lastReply(value: string): string
  emptyRecentTitle: string
  emptyRecentBody: string
  emptyFollowingTitle: string
  emptyFollowingBody: string
  emptyUnreadTitle: string
  emptyUnreadBody: string
  loadMore: string
  open(room: string): string
  actionFailed: string
  noPreview: string
}

const en: CompanyThreadsCopy = {
  title: 'Threads',
  filterLabel: 'Filter threads',
  recent: 'Recent',
  following: 'Following',
  unread: 'Unread',
  follow: 'Follow',
  unfollow: 'Unfollow',
  markRead: 'Mark read',
  replies: count => (count === 1 ? '1 reply' : `${count} replies`),
  lastReply: value => `Last reply ${value}`,
  emptyRecentTitle: 'No threads yet',
  emptyRecentBody: 'Threads from your company conversations will appear here.',
  emptyFollowingTitle: 'No followed threads',
  emptyFollowingBody: 'Threads you join or follow will appear here.',
  emptyUnreadTitle: 'No unread threads',
  emptyUnreadBody: 'You’re caught up on your threads.',
  loadMore: 'Load more',
  open: room => `Open thread in ${room}`,
  actionFailed: 'Couldn’t update this thread. Try again.',
  noPreview: 'Message unavailable'
}

const vi: CompanyThreadsCopy = {
  title: 'Chuỗi thảo luận',
  filterLabel: 'Lọc chuỗi thảo luận',
  recent: 'Gần đây',
  following: 'Đang theo dõi',
  unread: 'Chưa đọc',
  follow: 'Theo dõi',
  unfollow: 'Bỏ theo dõi',
  markRead: 'Đánh dấu đã đọc',
  replies: count => `${count} câu trả lời`,
  lastReply: value => `Trả lời gần nhất ${value}`,
  emptyRecentTitle: 'Chưa có chuỗi thảo luận',
  emptyRecentBody: 'Chuỗi thảo luận trong các cuộc trò chuyện công ty sẽ xuất hiện ở đây.',
  emptyFollowingTitle: 'Chưa theo dõi chuỗi nào',
  emptyFollowingBody: 'Chuỗi bạn tham gia hoặc theo dõi sẽ xuất hiện ở đây.',
  emptyUnreadTitle: 'Không có chuỗi chưa đọc',
  emptyUnreadBody: 'Bạn đã xem hết các chuỗi thảo luận.',
  loadMore: 'Xem thêm',
  open: room => `Mở chuỗi trong ${room}`,
  actionFailed: 'Không cập nhật được chuỗi thảo luận này. Hãy thử lại.',
  noPreview: 'Không xem được tin nhắn'
}

const ja: CompanyThreadsCopy = {
  title: 'スレッド',
  filterLabel: 'スレッドを絞り込む',
  recent: '最近',
  following: 'フォロー中',
  unread: '未読',
  follow: 'フォロー',
  unfollow: 'フォロー解除',
  markRead: '既読にする',
  replies: count => `${count}件の返信`,
  lastReply: value => `最終返信 ${value}`,
  emptyRecentTitle: 'まだスレッドはありません',
  emptyRecentBody: '会社の会話のスレッドがここに表示されます。',
  emptyFollowingTitle: 'フォロー中のスレッドはありません',
  emptyFollowingBody: '参加またはフォローしたスレッドがここに表示されます。',
  emptyUnreadTitle: '未読のスレッドはありません',
  emptyUnreadBody: 'すべてのスレッドを確認しました。',
  loadMore: 'さらに読み込む',
  open: room => `${room} のスレッドを開く`,
  actionFailed: 'このスレッドを更新できませんでした。もう一度お試しください。',
  noPreview: 'メッセージを表示できません'
}

const zh: CompanyThreadsCopy = {
  title: '讨论串',
  filterLabel: '筛选讨论串',
  recent: '最近',
  following: '正在关注',
  unread: '未读',
  follow: '关注',
  unfollow: '取消关注',
  markRead: '标为已读',
  replies: count => `${count} 条回复`,
  lastReply: value => `最后回复 ${value}`,
  emptyRecentTitle: '暂无讨论串',
  emptyRecentBody: '公司对话中的讨论串会显示在这里。',
  emptyFollowingTitle: '暂无关注的讨论串',
  emptyFollowingBody: '你参与或关注的讨论串会显示在这里。',
  emptyUnreadTitle: '没有未读讨论串',
  emptyUnreadBody: '你已读完所有讨论串。',
  loadMore: '加载更多',
  open: room => `打开 ${room} 中的讨论串`,
  actionFailed: '无法更新此讨论串，请重试。',
  noPreview: '消息不可用'
}

const zhHant: CompanyThreadsCopy = {
  title: '討論串',
  filterLabel: '篩選討論串',
  recent: '最近',
  following: '正在關注',
  unread: '未讀',
  follow: '關注',
  unfollow: '取消關注',
  markRead: '標示為已讀',
  replies: count => `${count} 則回覆`,
  lastReply: value => `最後回覆 ${value}`,
  emptyRecentTitle: '暫無討論串',
  emptyRecentBody: '公司對話中的討論串會顯示在這裡。',
  emptyFollowingTitle: '暫無關注的討論串',
  emptyFollowingBody: '你參與或關注的討論串會顯示在這裡。',
  emptyUnreadTitle: '沒有未讀討論串',
  emptyUnreadBody: '你已讀完所有討論串。',
  loadMore: '載入更多',
  open: room => `開啟 ${room} 中的討論串`,
  actionFailed: '無法更新此討論串，請再試一次。',
  noPreview: '訊息不可用'
}

export function companyThreadsCopy(locale: string): CompanyThreadsCopy {
  return ({ vi, ja, zh, 'zh-hant': zhHant } as Record<string, CompanyThreadsCopy>)[locale.toLowerCase()] ?? en
}

export function useCompanyThreadsCopy(): CompanyThreadsCopy {
  return companyThreadsCopy(useI18n().locale)
}

interface MatrixThreadCopy {
  thread: string
  threads: string
  openThreads: string
  closeThreads: string
  recent: string
  following: string
  unread: string
  follow: string
  unfollow: string
  replyInThread: string
  reply: string
  backToThreads: string
  noThreads: string
  noFilteredThreads: string
  threadUnavailable: string
  replies(count: number): string
  participants(count: number): string
  replyingIn(channel: string): string
  /** The thread line's muted half: when the last reply came ("Last reply 5 minutes ago"). */
  lastReply(when: string): string
  /** What the thread line says on hover, where Slack swaps in "View thread". */
  viewThread: string
  threadOptions: string
}

const copy: Record<string, MatrixThreadCopy> = {
  en: {
    thread: 'Thread',
    threads: 'Threads',
    openThreads: 'Open threads',
    closeThreads: 'Close threads',
    recent: 'Recent',
    following: 'Following',
    unread: 'Unread',
    follow: 'Follow',
    unfollow: 'Unfollow',
    replyInThread: 'Reply in thread',
    reply: 'Reply',
    backToThreads: 'Back to threads',
    noThreads: 'No threads yet.',
    noFilteredThreads: 'No threads here.',
    threadUnavailable: 'This thread is no longer available.',
    replies: count => (count === 1 ? '1 reply' : `${count} replies`),
    participants: count => (count === 1 ? '1 participant' : `${count} participants`),
    replyingIn: channel => `Replying in #${channel}`,
    lastReply: when => `Last reply ${when}`,
    viewThread: 'View thread',
    threadOptions: 'Thread options'
  },
  vi: {
    thread: 'Chuỗi thảo luận',
    threads: 'Chuỗi thảo luận',
    openThreads: 'Mở chuỗi thảo luận',
    closeThreads: 'Đóng chuỗi thảo luận',
    recent: 'Gần đây',
    following: 'Đang theo dõi',
    unread: 'Chưa đọc',
    follow: 'Theo dõi',
    unfollow: 'Bỏ theo dõi',
    replyInThread: 'Trả lời trong chuỗi',
    reply: 'Trả lời',
    backToThreads: 'Quay lại danh sách',
    noThreads: 'Chưa có chuỗi thảo luận.',
    noFilteredThreads: 'Không có chuỗi thảo luận ở đây.',
    threadUnavailable: 'Chuỗi thảo luận này không còn khả dụng.',
    replies: count => `${count} câu trả lời`,
    participants: count => `${count} người tham gia`,
    replyingIn: channel => `Đang trả lời trong #${channel}`,
    lastReply: when => `Trả lời gần nhất ${when}`,
    viewThread: 'Xem chuỗi thảo luận',
    threadOptions: 'Tùy chọn chuỗi thảo luận'
  },
  ja: {
    thread: 'スレッド',
    threads: 'スレッド',
    openThreads: 'スレッドを開く',
    closeThreads: 'スレッドを閉じる',
    recent: '最近',
    following: 'フォロー中',
    unread: '未読',
    follow: 'フォロー',
    unfollow: 'フォロー解除',
    replyInThread: 'スレッドで返信',
    reply: '返信',
    backToThreads: 'スレッド一覧に戻る',
    noThreads: 'スレッドはまだありません。',
    noFilteredThreads: 'ここにスレッドはありません。',
    threadUnavailable: 'このスレッドは利用できません。',
    replies: count => `${count} 件の返信`,
    participants: count => `${count} 人が参加`,
    replyingIn: channel => `#${channel} のスレッドに返信中`,
    lastReply: when => `最終返信 ${when}`,
    viewThread: 'スレッドを表示',
    threadOptions: 'スレッドのオプション'
  },
  zh: {
    thread: '讨论串',
    threads: '讨论串',
    openThreads: '打开讨论串',
    closeThreads: '关闭讨论串',
    recent: '最近',
    following: '已关注',
    unread: '未读',
    follow: '关注',
    unfollow: '取消关注',
    replyInThread: '在线程中回复',
    reply: '回复',
    backToThreads: '返回讨论串',
    noThreads: '暂无讨论串。',
    noFilteredThreads: '这里没有讨论串。',
    threadUnavailable: '此讨论串已不可用。',
    replies: count => `${count} 条回复`,
    participants: count => `${count} 位参与者`,
    replyingIn: channel => `正在 #${channel} 中回复`,
    lastReply: when => `最后回复 ${when}`,
    viewThread: '查看讨论串',
    threadOptions: '讨论串选项'
  },
  'zh-hant': {
    thread: '討論串',
    threads: '討論串',
    openThreads: '開啟討論串',
    closeThreads: '關閉討論串',
    recent: '最近',
    following: '已追蹤',
    unread: '未讀',
    follow: '追蹤',
    unfollow: '取消追蹤',
    replyInThread: '在討論串中回覆',
    reply: '回覆',
    backToThreads: '返回討論串',
    noThreads: '尚無討論串。',
    noFilteredThreads: '這裡沒有討論串。',
    threadUnavailable: '此討論串已無法使用。',
    replies: count => `${count} 則回覆`,
    participants: count => `${count} 位參與者`,
    replyingIn: channel => `正在 #${channel} 中回覆`,
    lastReply: when => `最後回覆 ${when}`,
    viewThread: '查看討論串',
    threadOptions: '討論串選項'
  }
}

export function matrixThreadCopy(locale: string): MatrixThreadCopy {
  return copy[locale] ?? copy.en!
}

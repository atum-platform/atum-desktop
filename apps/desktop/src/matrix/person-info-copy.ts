/** The conversation info panel's own words (a chat with people: who they are, what was shared). */
export interface MatrixPersonInfoCopy {
  /** The panel's tab and the header control that opens it, in a one-to-one chat. */
  conversationInfo: string
  /** The same, in a group of people. */
  groupInfo: string
  showInfo: string
  closeInfo: string
  teamSpaces: string
  conversation: string
  encrypted: string
  notEncrypted: string
  /** When the chat began (its room's creation), as a date. */
  started(date: string): string
  members(count: number): string
  muteNotifications: string
  lowPriority: string
  media: string
  files: string
  links: string
  seeAll: string
  seeAllMedia: string
  seeAllFiles: string
  seeAllLinks: string
  back: string
  loadMore: string
  loading: string
  failed: string
  tryAgain: string
  noMedia: string
  noFiles: string
  noLinks: string
  /** A section with nothing in the messages read so far, while older history is still unread. */
  noneRecent: string
  /** Older messages of an encrypted chat this Mac has no keys for: their files cannot be listed. */
  unreadable(count: number): string
  video: string
  openLink(url: string): string
  /** A photo's or video's tile: what it is and when it came. */
  mediaLabel(name: string, date: string): string
}

const copy: Record<string, MatrixPersonInfoCopy> = {
  en: {
    conversationInfo: 'Conversation info',
    groupInfo: 'Group info',
    showInfo: 'Show conversation info',
    closeInfo: 'Close conversation info',
    teamSpaces: 'Team spaces in common',
    conversation: 'Conversation',
    encrypted: 'End-to-end encrypted',
    notEncrypted: 'Not end-to-end encrypted',
    started: date => `Started ${date}`,
    members: count => (count === 1 ? '1 member' : `${count} members`),
    muteNotifications: 'Mute notifications',
    lowPriority: 'Low priority',
    media: 'Photos and videos',
    files: 'Files',
    links: 'Links',
    seeAll: 'See all',
    seeAllMedia: 'See all photos and videos',
    seeAllFiles: 'See all files',
    seeAllLinks: 'See all links',
    back: 'Back',
    loadMore: 'Load more',
    loading: 'Loading…',
    failed: 'Couldn’t load this.',
    tryAgain: 'Try again',
    noMedia: 'No photos or videos shared in this chat yet',
    noFiles: 'No files shared in this chat yet',
    noLinks: 'No links shared in this chat yet',
    noneRecent: 'None in recent messages. Older ones may be further back.',
    unreadable: count =>
      count === 1
        ? '1 older encrypted message can’t be read on this Mac.'
        : `${count} older encrypted messages can’t be read on this Mac.`,
    video: 'Video',
    openLink: url => `Open ${url}`,
    mediaLabel: (name, date) => `${name}, ${date}`
  },
  vi: {
    conversationInfo: 'Thông tin hội thoại',
    groupInfo: 'Thông tin nhóm',
    showInfo: 'Hiện thông tin hội thoại',
    closeInfo: 'Đóng thông tin hội thoại',
    teamSpaces: 'Không gian nhóm chung',
    conversation: 'Hội thoại',
    encrypted: 'Mã hóa đầu cuối',
    notEncrypted: 'Không mã hóa đầu cuối',
    started: date => `Bắt đầu ${date}`,
    members: count => `${count} thành viên`,
    muteNotifications: 'Tắt thông báo',
    lowPriority: 'Ưu tiên thấp',
    media: 'Ảnh và video',
    files: 'File',
    links: 'Link',
    seeAll: 'Xem tất cả',
    seeAllMedia: 'Xem tất cả ảnh và video',
    seeAllFiles: 'Xem tất cả file',
    seeAllLinks: 'Xem tất cả link',
    back: 'Quay lại',
    loadMore: 'Xem thêm',
    loading: 'Đang tải…',
    failed: 'Chưa tải được.',
    tryAgain: 'Thử lại',
    noMedia: 'Chưa có ảnh hay video được chia sẻ trong hội thoại này',
    noFiles: 'Chưa có file được chia sẻ trong hội thoại này',
    noLinks: 'Chưa có link được chia sẻ trong hội thoại này',
    noneRecent: 'Chưa thấy trong các tin nhắn gần đây. Có thể có ở tin cũ hơn.',
    unreadable: count => `${count} tin nhắn mã hóa cũ hơn không đọc được trên máy Mac này.`,
    video: 'Video',
    openLink: url => `Mở ${url}`,
    mediaLabel: (name, date) => `${name}, ${date}`
  },
  ja: {
    conversationInfo: 'チャット情報',
    groupInfo: 'グループ情報',
    showInfo: 'チャット情報を表示',
    closeInfo: 'チャット情報を閉じる',
    teamSpaces: '共通のチームスペース',
    conversation: 'チャット',
    encrypted: 'エンドツーエンドで暗号化',
    notEncrypted: 'エンドツーエンドで暗号化されていません',
    started: date => `${date} に開始`,
    members: count => `${count} 人のメンバー`,
    muteNotifications: '通知をオフ',
    lowPriority: '優先度を低く',
    media: '写真と動画',
    files: 'ファイル',
    links: 'リンク',
    seeAll: 'すべて表示',
    seeAllMedia: '写真と動画をすべて表示',
    seeAllFiles: 'ファイルをすべて表示',
    seeAllLinks: 'リンクをすべて表示',
    back: '戻る',
    loadMore: 'さらに表示',
    loading: '読み込み中…',
    failed: '読み込めませんでした。',
    tryAgain: '再試行',
    noMedia: 'このチャットで共有された写真や動画はまだありません',
    noFiles: 'このチャットで共有されたファイルはまだありません',
    noLinks: 'このチャットで共有されたリンクはまだありません',
    noneRecent: '最近のメッセージにはありません。もっと前にあるかもしれません。',
    unreadable: count => `以前の暗号化メッセージ ${count} 件はこの Mac では読めません。`,
    video: '動画',
    openLink: url => `${url} を開く`,
    mediaLabel: (name, date) => `${name}、${date}`
  },
  zh: {
    conversationInfo: '会话信息',
    groupInfo: '群组信息',
    showInfo: '显示会话信息',
    closeInfo: '关闭会话信息',
    teamSpaces: '共同的团队空间',
    conversation: '会话',
    encrypted: '端到端加密',
    notEncrypted: '未端到端加密',
    started: date => `开始于 ${date}`,
    members: count => `${count} 位成员`,
    muteNotifications: '关闭通知',
    lowPriority: '低优先级',
    media: '照片和视频',
    files: '文件',
    links: '链接',
    seeAll: '查看全部',
    seeAllMedia: '查看全部照片和视频',
    seeAllFiles: '查看全部文件',
    seeAllLinks: '查看全部链接',
    back: '返回',
    loadMore: '加载更多',
    loading: '正在加载…',
    failed: '无法加载。',
    tryAgain: '重试',
    noMedia: '此会话中还没有分享照片或视频',
    noFiles: '此会话中还没有分享文件',
    noLinks: '此会话中还没有分享链接',
    noneRecent: '最近的消息中没有。更早的消息里可能有。',
    unreadable: count => `${count} 条较早的加密消息无法在此 Mac 上读取。`,
    video: '视频',
    openLink: url => `打开 ${url}`,
    mediaLabel: (name, date) => `${name}，${date}`
  },
  'zh-hant': {
    conversationInfo: '對話資訊',
    groupInfo: '群組資訊',
    showInfo: '顯示對話資訊',
    closeInfo: '關閉對話資訊',
    teamSpaces: '共同的團隊空間',
    conversation: '對話',
    encrypted: '端對端加密',
    notEncrypted: '未端對端加密',
    started: date => `開始於 ${date}`,
    members: count => `${count} 位成員`,
    muteNotifications: '關閉通知',
    lowPriority: '低優先順序',
    media: '照片和影片',
    files: '檔案',
    links: '連結',
    seeAll: '查看全部',
    seeAllMedia: '查看全部照片和影片',
    seeAllFiles: '查看全部檔案',
    seeAllLinks: '查看全部連結',
    back: '返回',
    loadMore: '載入更多',
    loading: '正在載入…',
    failed: '無法載入。',
    tryAgain: '重試',
    noMedia: '此對話中還沒有分享照片或影片',
    noFiles: '此對話中還沒有分享檔案',
    noLinks: '此對話中還沒有分享連結',
    noneRecent: '最近的訊息中沒有。更早的訊息裡可能有。',
    unreadable: count => `${count} 則較早的加密訊息無法在此 Mac 上讀取。`,
    video: '影片',
    openLink: url => `開啟 ${url}`,
    mediaLabel: (name, date) => `${name}，${date}`
  }
}

export function matrixPersonInfoCopy(locale: string): MatrixPersonInfoCopy {
  return copy[locale] ?? copy.en!
}

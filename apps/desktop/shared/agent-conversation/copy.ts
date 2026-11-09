import type { DesktopLocale } from '../desktop-locale'

/** Copy shared by the renderer and native Earlier-room notice. It deliberately has no React dependency. */
const en = {
  newMessage: 'New message',
  choosePeople: 'Choose people to message',
  openConversation: 'Open conversation',
  mainConversation: 'Main conversation',
  open: 'Open',
  keep: 'Keep',
  change: 'Change',
  retry: 'Try again',
  stuck: 'Atum couldn’t finish setting up this conversation.',
  confirm: 'Confirm',
  checkingJobs: 'Checking scheduled jobs…',
  /** Used by the phone's recovery-key screen (through the copy export), not by desktop. */
  restoreFailed: 'Couldn’t restore this recovery key. Try again.',
  chooseConversation: 'Choose a conversation',
  conversation: (index: number) => `Conversation ${index}`,
  migrationTitle: (name: string, count: number) =>
    `Atum keeps one conversation with ${name}. ${count} earlier ${count === 1 ? 'chat is' : 'chats are'} kept.`,
  jobs: (count: number) =>
    `${count} scheduled ${count === 1 ? 'job will' : 'jobs will'} move to the main conversation.`,
  blocked: {
    cloud_not_ready: 'This assistant is not ready to keep Earlier conversations everywhere yet.',
    fleet_not_ready: 'Update your other Mac first.',
    turn_live: 'Wait for the current reply to finish, then try again.',
    chosen_not_writable: 'Atum cannot mark the selected conversation on this account.',
    read_unavailable: 'Atum cannot read every conversation it needs to mark.',
    rollback_pending: 'Atum is restoring the previous conversation setup.',
    effects_pending: 'Atum is finishing the move to the main conversation.',
    failed: 'Couldn’t mark these conversations.'
  },
  failed: (count: number) => `Couldn’t mark ${count} ${count === 1 ? 'room' : 'rooms'}. Try again.`,
  working: 'Updating your conversations…',
  earlierNotice: (name: string) => `This conversation is closed. Continue in your main conversation with ${name}.`,
  earlierCardNotice: 'This conversation is closed. Continue from your assistant card.'
}

type AgentConversationCopy = typeof en

const vi: AgentConversationCopy = {
  newMessage: 'Tin nhắn mới',
  choosePeople: 'Chọn người để nhắn tin',
  openConversation: 'Mở cuộc trò chuyện',
  mainConversation: 'Cuộc trò chuyện chính',
  open: 'Mở',
  keep: 'Giữ nguyên',
  change: 'Thay đổi',
  retry: 'Thử lại',
  stuck: 'Atum chưa thể hoàn tất việc thiết lập cuộc trò chuyện này.',
  confirm: 'Xác nhận',
  checkingJobs: 'Đang kiểm tra tác vụ đã lên lịch…',
  restoreFailed: 'Không thể khôi phục khóa này. Hãy thử lại.',
  chooseConversation: 'Chọn một cuộc trò chuyện',
  conversation: index => `Cuộc trò chuyện ${index}`,
  migrationTitle: (name, count) =>
    `Atum giữ một cuộc trò chuyện với ${name}. ${count} cuộc trò chuyện trước được giữ lại.`,
  jobs: count => `${count} tác vụ đã lên lịch sẽ chuyển sang cuộc trò chuyện chính.`,
  blocked: {
    cloud_not_ready: 'Trợ lý này chưa sẵn sàng để giữ các cuộc trò chuyện trước trên mọi nơi.',
    fleet_not_ready: 'Hãy cập nhật máy Mac khác của bạn trước.',
    turn_live: 'Đợi câu trả lời hiện tại hoàn tất rồi thử lại.',
    chosen_not_writable: 'Atum không thể đánh dấu cuộc trò chuyện đã chọn cho tài khoản này.',
    read_unavailable: 'Atum không thể đọc mọi cuộc trò chuyện cần đánh dấu.',
    rollback_pending: 'Atum đang khôi phục thiết lập cuộc trò chuyện trước đó.',
    effects_pending: 'Atum đang hoàn tất việc chuyển sang cuộc trò chuyện chính.',
    failed: 'Không thể đánh dấu các cuộc trò chuyện này.'
  },
  failed: count => `Không thể đánh dấu ${count} phòng. Hãy thử lại.`,
  working: 'Đang cập nhật các cuộc trò chuyện…',
  earlierNotice: name => `Cuộc trò chuyện này đã đóng. Hãy tiếp tục trong cuộc trò chuyện chính với ${name}.`,
  earlierCardNotice: 'Cuộc trò chuyện này đã đóng. Hãy tiếp tục từ thẻ trợ lý của bạn.'
}

const ja: AgentConversationCopy = {
  newMessage: '新しいメッセージ',
  choosePeople: 'メッセージを送る相手を選択',
  openConversation: '会話を開く',
  mainConversation: 'メインの会話',
  open: '開く',
  keep: 'このままにする',
  change: '変更',
  retry: 'もう一度試す',
  stuck: 'Atum はこの会話の設定を完了できませんでした。',
  confirm: '確認',
  checkingJobs: '予定ジョブを確認しています…',
  restoreFailed: 'このリカバリーキーを復元できませんでした。もう一度お試しください。',
  chooseConversation: '会話を選択',
  conversation: index => `会話 ${index}`,
  migrationTitle: (name, count) => `Atum は ${name} との会話を 1 つに保ちます。${count} 件の以前の会話は保持されます。`,
  jobs: count => `${count} 件の予定ジョブがメインの会話に移動します。`,
  blocked: {
    cloud_not_ready: 'このアシスタントは、以前の会話をどこでも扱う準備がまだできていません。',
    fleet_not_ready: '先に別の Mac をアップデートしてください。',
    turn_live: '現在の返信が終わってから、もう一度お試しください。',
    chosen_not_writable: 'Atum は選んだ会話をこのアカウントでマークできません。',
    read_unavailable: 'Atum はマークする必要があるすべての会話を読めません。',
    rollback_pending: 'Atum は以前の会話設定を復元しています。',
    effects_pending: 'Atum はメインの会話への移動を完了しています。',
    failed: '会話をマークできませんでした。'
  },
  failed: count => `${count} 件のルームをマークできませんでした。もう一度お試しください。`,
  working: '会話を更新しています…',
  earlierNotice: name => `この会話は終了しています。${name} とのメインの会話を続けてください。`,
  earlierCardNotice: 'この会話は終了しています。アシスタントカードから続けてください。'
}

const zh: AgentConversationCopy = {
  newMessage: '新消息',
  choosePeople: '选择要发消息的人',
  openConversation: '打开会话',
  mainConversation: '主会话',
  open: '打开',
  keep: '保留',
  change: '更改',
  retry: '重试',
  stuck: 'Atum 无法完成此会话的设置。',
  confirm: '确认',
  checkingJobs: '正在检查计划任务…',
  restoreFailed: '无法恢复此恢复密钥，请重试。',
  chooseConversation: '选择会话',
  conversation: index => `会话 ${index}`,
  migrationTitle: (name, count) => `Atum 会保留与 ${name} 的一个会话。将保留 ${count} 个较早的会话。`,
  jobs: count => `${count} 个计划任务将移至主会话。`,
  blocked: {
    cloud_not_ready: '此助理尚未准备好在所有地方保留较早的会话。',
    fleet_not_ready: '请先更新你的另一台 Mac。',
    turn_live: '请等待当前回复完成后再试。',
    chosen_not_writable: 'Atum 无法为此帐户标记所选会话。',
    read_unavailable: 'Atum 无法读取需要标记的所有会话。',
    rollback_pending: 'Atum 正在恢复之前的会话设置。',
    effects_pending: 'Atum 正在完成移至主会话的操作。',
    failed: '无法标记这些会话。'
  },
  failed: count => `无法标记 ${count} 个房间，请重试。`,
  working: '正在更新你的会话…',
  earlierNotice: name => `此会话已关闭。请在与 ${name} 的主会话中继续。`,
  earlierCardNotice: '此会话已关闭。请从你的助手卡片继续。'
}

const zhHant: AgentConversationCopy = {
  newMessage: '新訊息',
  choosePeople: '選擇要傳訊息的人',
  openConversation: '開啟對話',
  mainConversation: '主要對話',
  open: '開啟',
  keep: '保留',
  change: '變更',
  retry: '再試一次',
  stuck: 'Atum 無法完成此對話的設定。',
  confirm: '確認',
  checkingJobs: '正在檢查排程工作…',
  restoreFailed: '無法還原此復原金鑰，請再試一次。',
  chooseConversation: '選擇對話',
  conversation: index => `對話 ${index}`,
  migrationTitle: (name, count) => `Atum 會保留與 ${name} 的一個對話。將保留 ${count} 個較早的對話。`,
  jobs: count => `${count} 個排程工作將移至主要對話。`,
  blocked: {
    cloud_not_ready: '此助理尚未準備好在所有地方保留較早的對話。',
    fleet_not_ready: '請先更新你的另一台 Mac。',
    turn_live: '請等待目前的回覆完成後再試。',
    chosen_not_writable: 'Atum 無法為此帳戶標記所選對話。',
    read_unavailable: 'Atum 無法讀取需要標記的所有對話。',
    rollback_pending: 'Atum 正在還原先前的對話設定。',
    effects_pending: 'Atum 正在完成移至主要對話的作業。',
    failed: '無法標記這些對話。'
  },
  failed: count => `無法標記 ${count} 個房間，請再試一次。`,
  working: '正在更新你的對話…',
  earlierNotice: name => `此對話已關閉。請在與 ${name} 的主要對話中繼續。`,
  earlierCardNotice: '此對話已關閉。請從你的助理卡片繼續。'
}

const copies: Record<DesktopLocale, AgentConversationCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function agentConversationCopy(locale: DesktopLocale): AgentConversationCopy {
  return copies[locale] ?? en
}

/** Native host use: a fixed local notice, never a model-generated reply. */
export function earlierConversationNotice(locale: DesktopLocale, name?: string): string {
  return name?.trim() ? agentConversationCopy(locale).earlierNotice(name) : agentConversationCopy(locale).earlierCardNotice
}

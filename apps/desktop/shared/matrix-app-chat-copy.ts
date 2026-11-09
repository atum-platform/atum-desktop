const en = {
  newChat: 'New app chat',
  newGroup: 'New shared app conversation',
  groupName: 'Group name',
  groupInvite: 'Anyone in the group can invite others.',
  groupDisclosure: 'Only you can ask the app for help. Everyone in the group, including people added later, can read its replies.',
  withdraw: 'Remove app from chats',
  cancel: 'Cancel',
  actions: 'App actions',
  disclosure: 'Start a private chat with this app? It only sees what you send it, not your other chats or memories.',
  recipient: 'Send to',
  conversation: 'Conversation only',
  contextOff: 'Saved personal context: off · Agent instructions remain on',
  unavailable: 'App chat is unavailable. Check the connection and app enrollment.',
  published: 'App reply delivered.',
  pending: 'The reply is saved on this device but delivery is unconfirmed.',
  retry: 'Retry reply delivery',
  unknown: 'Your message was sent, but the app outcome is unconfirmed. Do not resend it automatically.',
  declined: 'Your message was sent. No app turn was started.'
  ,botStarting: (app: string) => `${app} is starting up. Messages will be answered when ${app} is ready.`
  ,botUnavailable: (app: string) => `${app} is resting. When ${app} is back, it answers messages sent up to 30 minutes earlier; please resend anything older.`
  ,botUntrusted: (app: string) => `${app} can't be reached safely right now.`
  ,botJoining: (app: string) => `${app} is joining the chat…`
  ,openBot: (app: string) => `Open ${app}`
  ,sharedMemoryHint: (app: string) => `${app} remembers both conversations.`
  ,addBot: (app: string) => `Add ${app} to the group`
  ,andyGroupNote: 'Andy chats one-on-one only. You can message Andy privately.'
  ,askAbout: (app: string) => `Ask ${app} about this`
  ,quotePreview: (app: string) => `${app} will see this quoted message.`
  ,plainReplyHint: (app: string) => `${app} won't see the message you're replying to.`
  ,removeQuote: 'Remove quote'
  ,startBot: 'Start'
  ,connectAccount: (app: string) => `Connect ${app} account`
  ,privateOutcome: 'Only you can see this'
  ,noTurn: (app: string) => `${app} hasn't answered this message. Make sure Atum is up to date, then try again in a few minutes.`
  ,stopUsing: (app: string) => `Stop using ${app} in chats`
  // Why a bot's chat did not open or a message to it did not go (shared/matrix-app-bot-failure.ts).
  ,botFailedStarting: (app: string) => `${app} is starting up. Try again in a few minutes.`
  ,botFailedPaused: (app: string) => `${app} is paused for now. Try again later.`
  ,botFailedResting: (app: string) => `${app} is temporarily unavailable. Try again in a few minutes.`
  ,botFailedChanged: (app: string) => `${app} was just updated. Try again.`
  ,botFailedSyncing: (app: string) => `The chat with ${app} is taking longer than usual to open. Try again.`
  ,botFailedUnavailable: (app: string) => `${app} isn't available right now. Try again in a few minutes.`
  ,botFallbackName: 'This app'
  // A bot's roster row: its label, and the warning while it is not active (atum-app-bots v1 §7.1).
  ,botRowLabel: 'App'
  ,botRowState: { starting: 'Starting up', paused: 'Paused', unavailable: 'Temporarily unavailable' }
}

type Copy = typeof en

const vi: Copy = {
  newChat: 'Trò chuyện mới với ứng dụng',
  newGroup: 'Cuộc trò chuyện nhóm mới với ứng dụng',
  groupName: 'Tên nhóm',
  groupInvite: 'Mọi người trong nhóm đều có thể mời thêm người khác.',
  groupDisclosure: 'Chỉ bạn mới có thể nhờ ứng dụng. Mọi người trong nhóm, kể cả người được thêm sau, đều đọc được câu trả lời của ứng dụng.',
  withdraw: 'Gỡ ứng dụng khỏi trò chuyện',
  cancel: 'Hủy',
  actions: 'Thao tác ứng dụng',
  disclosure: 'Bắt đầu trò chuyện riêng với ứng dụng này? Ứng dụng chỉ thấy những gì bạn gửi cho nó, không thấy các cuộc trò chuyện hay ký ức khác của bạn.',
  recipient: 'Gửi đến',
  conversation: 'Chỉ cuộc trò chuyện',
  contextOff: 'Ngữ cảnh cá nhân đã lưu: tắt · Hướng dẫn tác nhân vẫn bật',
  unavailable: 'Chưa thể trò chuyện với ứng dụng. Hãy kiểm tra kết nối và quyền tham gia.',
  published: 'Đã gửi phản hồi của ứng dụng.',
  pending: 'Phản hồi của ứng dụng đã được lưu trên máy này nhưng chưa gửi được vào cuộc trò chuyện. Bấm “Thử gửi lại phản hồi” để gửi.',
  retry: 'Thử gửi lại phản hồi',
  unknown: 'Tin nhắn đã đến ứng dụng nhưng Atum chưa nhận được kết quả, nên chưa biết ứng dụng đã trả lời hay đã tính lượt nhắn chưa. Atum không tự gửi lại để khỏi tính hai lần.',
  declined: 'Tin nhắn đã gửi. Chưa chạy lượt ứng dụng.'
  ,botStarting: app => `${app} đang khởi động. Tin nhắn sẽ được trả lời khi ${app} sẵn sàng.`
  ,botUnavailable: app => `${app} đang tạm nghỉ. Khi ${app} quay lại, tin nhắn gửi trong vòng 30 phút trước đó sẽ được trả lời; tin cũ hơn thì bạn gửi lại nhé.`
  ,botUntrusted: app => `Chưa thể trò chuyện an toàn với ${app} lúc này.`
  ,botJoining: app => `${app} đang vào cuộc trò chuyện…`
  ,openBot: app => `Mở ${app}`
  ,sharedMemoryHint: app => `${app} nhớ cả hai cuộc trò chuyện.`
  ,addBot: app => `Thêm ${app} vào nhóm`
  ,andyGroupNote: 'Andy chỉ trò chuyện riêng. Bạn có thể nhắn riêng cho Andy.'
  ,askAbout: app => `Hỏi ${app} về tin này`
  ,quotePreview: app => `${app} sẽ thấy tin nhắn được trích dẫn này.`
  ,plainReplyHint: app => `${app} sẽ không thấy tin bạn đang trả lời.`
  ,removeQuote: 'Bỏ trích dẫn'
  ,startBot: 'Bắt đầu'
  ,connectAccount: app => `Kết nối tài khoản ${app}`
  ,privateOutcome: 'Chỉ bạn thấy'
  ,noTurn: app => `${app} chưa trả lời tin này. Hãy kiểm tra Atum đã được cập nhật, rồi thử lại sau ít phút.`
  ,stopUsing: app => `Dừng dùng ${app} trong chat`
  ,botFailedStarting: app => `${app} đang khởi động. Bạn thử lại sau ít phút nhé.`
  ,botFailedPaused: app => `${app} đang tạm dừng. Bạn thử lại sau nhé.`
  ,botFailedResting: app => `${app} đang tạm gián đoạn. Bạn thử lại sau ít phút nhé.`
  ,botFailedChanged: app => `${app} vừa được cập nhật. Bạn thử lại nhé.`
  ,botFailedSyncing: app => `Cuộc trò chuyện với ${app} đang mở lâu hơn bình thường. Bạn thử lại nhé.`
  ,botFailedUnavailable: app => `${app} hiện chưa dùng được. Bạn thử lại sau ít phút nhé.`
  ,botFallbackName: 'Ứng dụng này'
  ,botRowLabel: 'Ứng dụng'
  ,botRowState: { starting: 'Đang khởi động', paused: 'Tạm dừng', unavailable: 'Tạm gián đoạn' }
}

const ja: Copy = {
  newChat: '新しいアプリチャット',
  newGroup: '新しい共有アプリチャット',
  groupName: 'グループ名',
  groupInvite: 'グループのメンバーは誰でも他の人を招待できます。',
  groupDisclosure: 'アプリに頼めるのはあなただけです。後から追加された人を含め、グループの全員がアプリの返信を読めます。',
  withdraw: 'チャットからアプリを外す',
  cancel: 'キャンセル',
  actions: 'アプリの操作',
  disclosure: 'このアプリとプライベートチャットを始めますか？アプリが見られるのはあなたが送った内容だけで、ほかのチャットや記憶は見られません。',
  recipient: '送信先',
  conversation: '会話のみ',
  contextOff: '保存済み個人コンテキスト：オフ · エージェントの指示：オン',
  unavailable: 'アプリチャットを利用できません。接続と参加登録を確認してください。',
  published: 'アプリの返信を配信しました。',
  pending: '返信は端末に保存されていますが、配信は未確認です。',
  retry: '返信の配信を再試行',
  unknown: 'メッセージは送信済みですが、アプリの結果は未確認です。自動再送しないでください。',
  declined: 'メッセージは送信済みです。アプリは実行されていません。'
  ,botStarting: app => `${app} は起動中です。準備ができるとメッセージに返信します。`
  ,botUnavailable: app => `${app} は一時的に利用できません。戻ったときは過去30分のメッセージに返信します。`
  ,botUntrusted: app => `現在 ${app} と安全に会話できません。`
  ,botJoining: app => `${app} がチャットに参加しています…`
  ,openBot: app => `${app} を開く`
  ,sharedMemoryHint: app => `${app} は両方の会話を覚えています。`
  ,addBot: app => `${app} をグループに追加`
  ,andyGroupNote: 'Andy は1対1のチャットのみ対応しています。Andy に直接メッセージできます。'
  ,askAbout: app => `このメッセージについて ${app} に聞く`
  ,quotePreview: app => `${app} はこの引用したメッセージを確認します。`
  ,plainReplyHint: app => `${app} には返信先のメッセージは表示されません。`
  ,removeQuote: '引用を外す'
  ,startBot: '開始'
  ,connectAccount: app => `${app} アカウントを接続`
  ,privateOutcome: 'あなただけに表示'
  ,noTurn: app => `${app} はこのメッセージにまだ返信していません。Atum を更新してから、しばらくしてもう一度お試しください。`
  ,stopUsing: app => `チャットで ${app} の利用を停止`
  ,botFailedStarting: app => `${app} は起動中です。数分後にもう一度お試しください。`
  ,botFailedPaused: app => `${app} は一時停止中です。しばらくしてからもう一度お試しください。`
  ,botFailedResting: app => `${app} は一時的に利用できません。数分後にもう一度お試しください。`
  ,botFailedChanged: app => `${app} が更新されました。もう一度お試しください。`
  ,botFailedSyncing: app => `${app} とのチャットを開くのに時間がかかっています。もう一度お試しください。`
  ,botFailedUnavailable: app => `現在 ${app} を利用できません。数分後にもう一度お試しください。`
  ,botFallbackName: 'このアプリ'
  ,botRowLabel: 'アプリ'
  ,botRowState: { starting: '起動中', paused: '一時停止中', unavailable: '一時的に利用不可' }
}

const zh: Copy = {
  newChat: '新建应用聊天',
  newGroup: '新建共享应用会话',
  groupName: '群组名称',
  groupInvite: '群组中的任何人都可以邀请其他人。',
  groupDisclosure: '只有你可以请应用帮忙。群组中的所有人（包括之后加入的人）都能看到应用的回复。',
  withdraw: '从聊天中移除应用',
  cancel: '取消',
  actions: '应用操作',
  disclosure: '与此应用开始私聊？它只能看到你发给它的内容，看不到你的其他聊天或记忆。',
  recipient: '发送给',
  conversation: '仅会话',
  contextOff: '已保存的个人上下文：关闭 · 智能体指令仍然开启',
  unavailable: '应用聊天不可用。请检查连接及应用参与授权。',
  published: '应用回复已送达。',
  pending: '回复已保存在本设备上，但尚未确认送达。',
  retry: '重试回复投递',
  unknown: '消息已发送，但应用结果尚未确认。请勿自动重发。',
  declined: '消息已发送。未启动应用处理。'
  ,botStarting: app => `${app} 正在启动。准备就绪后会回复消息。`
  ,botUnavailable: app => `${app} 暂时不可用。恢复后会回复过去30分钟内发送的消息。`
  ,botUntrusted: app => `目前无法安全地与 ${app} 聊天。`
  ,botJoining: app => `${app} 正在加入聊天…`
  ,openBot: app => `打开 ${app}`
  ,sharedMemoryHint: app => `${app} 会记住这两段对话。`
  ,addBot: app => `将 ${app} 添加到群组`
  ,andyGroupNote: 'Andy 目前仅支持一对一聊天。你可以私信 Andy。'
  ,askAbout: app => `向 ${app} 询问这条消息`
  ,quotePreview: app => `${app} 将看到这条引用的消息。`
  ,plainReplyHint: app => `${app} 不会看到您正在回复的消息。`
  ,removeQuote: '移除引用'
  ,startBot: '开始'
  ,connectAccount: app => `连接 ${app} 账户`
  ,privateOutcome: '仅你可见'
  ,noTurn: app => `${app} 尚未回复这条消息。请确认 Atum 已更新，然后稍后再试。`
  ,stopUsing: app => `停止在聊天中使用 ${app}`
  ,botFailedStarting: app => `${app} 正在启动。请几分钟后再试。`
  ,botFailedPaused: app => `${app} 已暂停。请稍后再试。`
  ,botFailedResting: app => `${app} 暂时不可用。请几分钟后再试。`
  ,botFailedChanged: app => `${app} 刚刚更新。请再试一次。`
  ,botFailedSyncing: app => `与 ${app} 的聊天打开得比平时慢。请再试一次。`
  ,botFailedUnavailable: app => `${app} 目前无法使用。请几分钟后再试。`
  ,botFallbackName: '此应用'
  ,botRowLabel: '应用'
  ,botRowState: { starting: '正在启动', paused: '已暂停', unavailable: '暂时不可用' }
}

const hant: Copy = {
  newChat: '新增應用程式聊天',
  newGroup: '新增共用應用程式對話',
  groupName: '群組名稱',
  groupInvite: '群組中的任何人都可以邀請其他人。',
  groupDisclosure: '只有你可以請應用程式幫忙。群組中的所有人（包括之後加入的人）都能看到應用程式的回覆。',
  withdraw: '從聊天中移除應用程式',
  cancel: '取消',
  actions: '應用程式操作',
  disclosure: '與此應用程式開始私人聊天？它只能看到你傳給它的內容，看不到你的其他聊天或記憶。',
  recipient: '傳送給',
  conversation: '僅對話',
  contextOff: '已儲存的個人脈絡：關閉 · 代理指令仍然開啟',
  unavailable: '應用程式聊天無法使用。請檢查連線及參與授權。',
  published: '應用程式回覆已送達。',
  pending: '回覆已儲存在本機，但尚未確認送達。',
  retry: '重試回覆傳遞',
  unknown: '訊息已傳送，但應用程式結果尚未確認。請勿自動重送。',
  declined: '訊息已傳送。未啟動應用程式處理。'
  ,botStarting: app => `${app} 正在啟動。準備就緒後會回覆訊息。`
  ,botUnavailable: app => `${app} 暫時無法使用。恢復後會回覆過去30分鐘內傳送的訊息。`
  ,botUntrusted: app => `目前無法安全地與 ${app} 聊天。`
  ,botJoining: app => `${app} 正在加入聊天…`
  ,openBot: app => `開啟 ${app}`
  ,sharedMemoryHint: app => `${app} 會記住這兩段對話。`
  ,addBot: app => `將 ${app} 加入群組`
  ,andyGroupNote: 'Andy 目前只支援一對一聊天。你可以私訊 Andy。'
  ,askAbout: app => `向 ${app} 詢問這則訊息`
  ,quotePreview: app => `${app} 將看到這則引用的訊息。`
  ,plainReplyHint: app => `${app} 不會看到您正在回覆的訊息。`
  ,removeQuote: '移除引用'
  ,startBot: '開始'
  ,connectAccount: app => `連結 ${app} 帳戶`
  ,privateOutcome: '僅你可見'
  ,noTurn: app => `${app} 尚未回覆這則訊息。請確認 Atum 已更新，然後稍後再試。`
  ,stopUsing: app => `停止在聊天中使用 ${app}`
  ,botFailedStarting: app => `${app} 正在啟動。請幾分鐘後再試。`
  ,botFailedPaused: app => `${app} 已暫停。請稍後再試。`
  ,botFailedResting: app => `${app} 暫時無法使用。請幾分鐘後再試。`
  ,botFailedChanged: app => `${app} 剛剛更新。請再試一次。`
  ,botFailedSyncing: app => `與 ${app} 的聊天開啟得比平常慢。請再試一次。`
  ,botFailedUnavailable: app => `${app} 目前無法使用。請幾分鐘後再試。`
  ,botFallbackName: '此應用程式'
  ,botRowLabel: '應用程式'
  ,botRowState: { starting: '正在啟動', paused: '已暫停', unavailable: '暫時無法使用' }
}

export const matrixAppChatCopy = { en, vi, ja, zh, 'zh-hant': hant }

export function appChatCopy(locale?: string): Copy {
  return typeof locale === 'string' && Object.hasOwn(matrixAppChatCopy, locale)
    ? matrixAppChatCopy[locale as keyof typeof matrixAppChatCopy]
    : en
}

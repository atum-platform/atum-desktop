/**
 * The words for public handles (spec/public-handles/v1), in Settings › Account and on an
 * assistant's card. Never "alias", "principal" or an error code. `_bot` is shown only as the
 * literal ending an assistant's handle has.
 */
interface AliasCopy {
  title: string; help: string
  /** An assistant's handle, in the create sheet and on its card: the field, why it exists, its states. */
  botName: string; botNameHelp: string; botNone: string; botCurrent: string; botChoose: string; botTry(handle: string): string
  target: string; person: string; assistant: string; none: string; loading: string; refresh: string
  handle: string; choose: string; change: string; cancel: string; save: string; checking: string
  available(handle: string): string; current: string; unavailable: string; reserved: string
  invalid: string; botRequired: string; botReserved: string; rule: string
  claimTitle: string; claimConfirm: string; claimTextSelf(handle: string): string; claimTextAgent(handle: string, name: string): string
  renameTitle: string; renameConfirm: string
  renameTextSelf(previous: string, next: string): string; renameTextAgent(previous: string, next: string, name: string): string
  saved: string; tooSoon(date: string): string; closed: string; pending: string; retry: string; assigned: string
  authentication: string; denied: string; missing: string; conflict: string; limit: string; failed: string; cancelled: string
}

const copy: Record<string, AliasCopy> = {
  en: {
    title: 'Public handle', help: 'How people find you on Atum. You can change it once every 30 days.',
    botName: 'Bot handle', botNameHelp: 'Others type this @name to find and mention the assistant.',
    botNone: 'No bot handle yet', botCurrent: 'In use', botChoose: 'Choose a bot handle', botTry: handle => `Use @${handle}`,
    target: 'For', person: 'Me', assistant: 'Assistant', none: 'No handle yet', loading: 'Checking…', refresh: 'Refresh',
    handle: 'Handle', choose: 'Choose a handle', change: 'Change', cancel: 'Cancel', save: 'Save', checking: 'Checking…',
    available: handle => `@${handle} is available.`, current: 'This is the current handle.', unavailable: 'This handle is taken.',
    reserved: 'This handle is reserved.', invalid: 'Use 3–32 letters, numbers or underscores, starting with a letter.',
    botRequired: 'An assistant’s handle ends in _bot.', botReserved: 'The _bot ending is for assistants.',
    rule: 'A handle can change once every 30 days.',
    claimTitle: 'Use this handle?', claimConfirm: 'Use handle',
    claimTextSelf: handle => `@${handle} becomes your handle. You can change it once every 30 days.`,
    claimTextAgent: (handle, name) => `@${handle} becomes ${name}’s bot handle. You can change it once every 30 days.`,
    renameTitle: 'Change this handle?', renameConfirm: 'Change',
    renameTextSelf: (previous, next) => `Your handle becomes @${next}. @${previous} stays yours for 30 days, and the next change is possible in 30 days.`,
    renameTextAgent: (previous, next, name) => `${name}’s bot handle becomes @${next}. @${previous} stays yours for 30 days, and the next change is possible in 30 days.`,
    saved: 'Saved.', tooSoon: date => `This handle changed recently. It can change again on ${date}.`,
    closed: 'Handles aren’t open yet. You’ll be able to choose one soon.',
    pending: 'An earlier change needs checking before another one.', retry: 'Check earlier change', assigned: 'Handle',
    authentication: 'Reconnect your Atum account to manage handles.', denied: 'Handles can’t be changed for this account right now.',
    missing: 'This assistant is no longer available.', conflict: 'The handle changed or was just taken. Check it again.',
    limit: 'Too many checks. Try again in a minute.', failed: 'Couldn’t reach handles. Try again.', cancelled: 'The account changed. Refresh to continue.'
  },
  vi: {
    title: 'Tên công khai', help: 'Cách mọi người tìm thấy bạn trên Atum. Bạn có thể đổi 30 ngày một lần.',
    botName: 'Tên bot', botNameHelp: 'Người khác gõ @tên này để tìm và nhắc đến trợ lý.',
    botNone: 'Chưa có tên bot', botCurrent: 'Đang dùng', botChoose: 'Chọn tên bot', botTry: handle => `Dùng @${handle}`,
    target: 'Dành cho', person: 'Tôi', assistant: 'Trợ lý', none: 'Chưa có tên công khai', loading: 'Đang kiểm tra…', refresh: 'Làm mới',
    handle: 'Tên công khai (@)', choose: 'Chọn tên công khai', change: 'Đổi', cancel: 'Hủy', save: 'Lưu', checking: 'Đang kiểm tra…',
    available: handle => `@${handle} còn trống.`, current: 'Đây là tên hiện tại.', unavailable: 'Tên này đã có người dùng.',
    reserved: 'Tên này được giữ riêng.', invalid: 'Dùng 3–32 chữ cái, chữ số hoặc dấu gạch dưới, bắt đầu bằng chữ cái.',
    botRequired: 'Tên bot luôn kết thúc bằng _bot.', botReserved: 'Đuôi _bot dành cho trợ lý.',
    rule: 'Mỗi tên chỉ đổi được 30 ngày một lần.',
    claimTitle: 'Dùng tên này?', claimConfirm: 'Dùng tên',
    claimTextSelf: handle => `@${handle} sẽ là tên công khai của bạn. Bạn có thể đổi 30 ngày một lần.`,
    claimTextAgent: (handle, name) => `@${handle} sẽ là tên bot của ${name}. Bạn có thể đổi 30 ngày một lần.`,
    renameTitle: 'Đổi tên này?', renameConfirm: 'Đổi',
    renameTextSelf: (previous, next) => `Tên công khai của bạn sẽ là @${next}. @${previous} vẫn được giữ cho bạn trong 30 ngày, và 30 ngày nữa mới đổi tiếp được.`,
    renameTextAgent: (previous, next, name) => `Tên bot của ${name} sẽ là @${next}. @${previous} vẫn được giữ cho bạn trong 30 ngày, và 30 ngày nữa mới đổi tiếp được.`,
    saved: 'Đã lưu.', tooSoon: date => `Tên này vừa được đổi. Có thể đổi lại vào ${date}.`,
    closed: 'Tên công khai chưa mở. Bạn sẽ sớm chọn được.',
    pending: 'Cần kiểm tra thay đổi trước đó trước khi đổi tiếp.', retry: 'Kiểm tra thay đổi trước', assigned: 'Tên công khai',
    authentication: 'Kết nối lại tài khoản Atum để quản lý tên.', denied: 'Tài khoản này hiện chưa đổi được tên.',
    missing: 'Trợ lý này không còn khả dụng.', conflict: 'Tên vừa thay đổi hoặc vừa có người dùng. Hãy kiểm tra lại.',
    limit: 'Kiểm tra quá nhiều lần. Hãy thử lại sau một phút.', failed: 'Không kết nối được. Hãy thử lại.', cancelled: 'Tài khoản đã thay đổi. Làm mới để tiếp tục.'
  },
  zh: {
    title: '公开用户名', help: '别人在 Atum 上找到你的方式。每 30 天可更改一次。',
    botName: '机器人用户名', botNameHelp: '别人输入这个 @用户名 来查找和提及助手。',
    botNone: '尚无机器人用户名', botCurrent: '使用中', botChoose: '选择机器人用户名', botTry: handle => `使用 @${handle}`,
    target: '对象', person: '我', assistant: '助手', none: '尚无公开用户名', loading: '正在检查…', refresh: '刷新',
    handle: '用户名', choose: '选择用户名', change: '更改', cancel: '取消', save: '保存', checking: '正在检查…',
    available: handle => `@${handle} 可用。`, current: '这是当前的用户名。', unavailable: '此用户名已被使用。',
    reserved: '此用户名已被保留。', invalid: '使用 3–32 个字母、数字或下划线，以字母开头。',
    botRequired: '助手的用户名以 _bot 结尾。', botReserved: '_bot 后缀仅供助手使用。',
    rule: '用户名每 30 天可更改一次。',
    claimTitle: '使用此用户名？', claimConfirm: '使用',
    claimTextSelf: handle => `@${handle} 将成为你的用户名。每 30 天可更改一次。`,
    claimTextAgent: (handle, name) => `@${handle} 将成为${name}的机器人用户名。每 30 天可更改一次。`,
    renameTitle: '更改此用户名？', renameConfirm: '更改',
    renameTextSelf: (previous, next) => `你的用户名将变为 @${next}。@${previous} 会为你保留 30 天，30 天后才能再次更改。`,
    renameTextAgent: (previous, next, name) => `${name}的机器人用户名将变为 @${next}。@${previous} 会为你保留 30 天，30 天后才能再次更改。`,
    saved: '已保存。', tooSoon: date => `此用户名最近已更改，可在 ${date} 再次更改。`,
    closed: '公开用户名尚未开放，很快就可以选择。',
    pending: '更改前，请先检查之前的更改。', retry: '检查之前的更改', assigned: '公开用户名',
    authentication: '请重新连接 Atum 账户以管理用户名。', denied: '此账户目前无法更改用户名。',
    missing: '此助手已不可用。', conflict: '用户名已变化或刚被使用，请重新检查。',
    limit: '检查次数过多，请一分钟后重试。', failed: '无法连接，请重试。', cancelled: '账户已变化，请刷新后继续。'
  },
  'zh-hant': {
    title: '公開使用者名稱', help: '別人在 Atum 上找到你的方式。每 30 天可更改一次。',
    botName: '機器人使用者名稱', botNameHelp: '別人輸入這個 @使用者名稱 來查找和提及助理。',
    botNone: '尚無機器人使用者名稱', botCurrent: '使用中', botChoose: '選擇機器人使用者名稱', botTry: handle => `使用 @${handle}`,
    target: '對象', person: '我', assistant: '助理', none: '尚無公開使用者名稱', loading: '正在檢查…', refresh: '重新整理',
    handle: '使用者名稱', choose: '選擇使用者名稱', change: '更改', cancel: '取消', save: '儲存', checking: '正在檢查…',
    available: handle => `@${handle} 可以使用。`, current: '這是目前的使用者名稱。', unavailable: '此使用者名稱已被使用。',
    reserved: '此使用者名稱已被保留。', invalid: '使用 3–32 個字母、數字或底線，以字母開頭。',
    botRequired: '助理的使用者名稱以 _bot 結尾。', botReserved: '_bot 後綴僅供助理使用。',
    rule: '使用者名稱每 30 天可更改一次。',
    claimTitle: '使用此使用者名稱？', claimConfirm: '使用',
    claimTextSelf: handle => `@${handle} 將成為你的使用者名稱。每 30 天可更改一次。`,
    claimTextAgent: (handle, name) => `@${handle} 將成為${name}的機器人使用者名稱。每 30 天可更改一次。`,
    renameTitle: '更改此使用者名稱？', renameConfirm: '更改',
    renameTextSelf: (previous, next) => `你的使用者名稱將變為 @${next}。@${previous} 會為你保留 30 天，30 天後才能再次更改。`,
    renameTextAgent: (previous, next, name) => `${name}的機器人使用者名稱將變為 @${next}。@${previous} 會為你保留 30 天，30 天後才能再次更改。`,
    saved: '已儲存。', tooSoon: date => `此使用者名稱最近已更改，可在 ${date} 再次更改。`,
    closed: '公開使用者名稱尚未開放，很快就能選擇。',
    pending: '更改前，請先檢查先前的更改。', retry: '檢查先前的更改', assigned: '公開使用者名稱',
    authentication: '請重新連接 Atum 帳戶以管理使用者名稱。', denied: '此帳戶目前無法更改使用者名稱。',
    missing: '此助理已無法使用。', conflict: '使用者名稱已改變或剛被使用，請重新檢查。',
    limit: '檢查次數過多，請一分鐘後再試。', failed: '無法連線，請再試一次。', cancelled: '帳戶已改變，請重新整理後繼續。'
  },
  ja: {
    title: '公開ハンドル', help: 'Atum でほかの人があなたを見つけるための名前です。30 日に 1 回変更できます。',
    botName: 'ボットのハンドル', botNameHelp: 'ほかの人はこの @ハンドル でアシスタントを見つけたり、メンションしたりできます。',
    botNone: 'ボットのハンドルはまだありません', botCurrent: '使用中', botChoose: 'ボットのハンドルを選ぶ', botTry: handle => `@${handle} を使う`,
    target: '対象', person: '自分', assistant: 'アシスタント', none: '公開ハンドルはまだありません', loading: '確認中…', refresh: '更新',
    handle: 'ハンドル', choose: 'ハンドルを選ぶ', change: '変更', cancel: 'キャンセル', save: '保存', checking: '確認中…',
    available: handle => `@${handle} は利用できます。`, current: '現在のハンドルです。', unavailable: 'このハンドルは使われています。',
    reserved: 'このハンドルは予約されています。', invalid: '英字で始まる 3–32 文字の英数字またはアンダースコアを使ってください。',
    botRequired: 'アシスタントのハンドルは _bot で終わります。', botReserved: '_bot はアシスタント専用です。',
    rule: 'ハンドルは 30 日に 1 回変更できます。',
    claimTitle: 'このハンドルを使いますか？', claimConfirm: '使う',
    claimTextSelf: handle => `@${handle} があなたのハンドルになります。30 日に 1 回変更できます。`,
    claimTextAgent: (handle, name) => `@${handle} が ${name} のボットのハンドルになります。30 日に 1 回変更できます。`,
    renameTitle: 'このハンドルを変更しますか？', renameConfirm: '変更',
    renameTextSelf: (previous, next) => `あなたのハンドルは @${next} になります。@${previous} は 30 日間あなたのために保持され、次の変更は 30 日後にできます。`,
    renameTextAgent: (previous, next, name) => `${name} のボットのハンドルは @${next} になります。@${previous} は 30 日間あなたのために保持され、次の変更は 30 日後にできます。`,
    saved: '保存しました。', tooSoon: date => `このハンドルは最近変更されました。${date} 以降に再度変更できます。`,
    closed: '公開ハンドルはまだ利用できません。まもなく選べるようになります。',
    pending: '次の変更の前に、以前の変更を確認してください。', retry: '以前の変更を確認', assigned: '公開ハンドル',
    authentication: 'ハンドルを管理するには Atum アカウントに再接続してください。', denied: 'このアカウントでは現在ハンドルを変更できません。',
    missing: 'このアシスタントは利用できなくなりました。', conflict: 'ハンドルが変わったか、使われたばかりです。もう一度確認してください。',
    limit: '確認が多すぎます。1 分後に再試行してください。', failed: '接続できませんでした。再試行してください。', cancelled: 'アカウントが変わりました。更新してください。'
  }
}

export type MatrixAliasCopy = AliasCopy

export const matrixAliasCopy = (locale: string): AliasCopy => copy[locale] ?? copy.en

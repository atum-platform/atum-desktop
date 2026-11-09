import { type Locale, useI18n } from '@/i18n'

const en = {
  title: 'Use on phone',
  description: 'Your Atum chats on your phone, with the free Element X app.',
  download: '1. Get Element X',
  downloadHelp: 'Scan with your phone’s camera, or open the download page.',
  qr: 'Scan to download Element X',
  qrFailed: 'The QR could not load. Use the download link instead.',
  openDownload: 'Open download page',
  connect: '2. Sign in with your Atum account',
  connectHelp: 'In Element X, choose another account provider and enter this address:',
  signInHelp: 'Then sign in with the same Google account or email you use for Atum.',
  copyServer: 'Copy server',
  copyHint: 'Copy',
  copied: 'Copied',
  moreHelp: 'More help',
  account: 'Your account',
  qrHelp: 'The QR only downloads the app. It never signs you in.',
  secureHelp:
    'Verify the phone with this Mac or your recovery key. Don’t reset your recovery key to fix missing messages.',
  finishingVerification: 'Finishing secure setup from your approved Mac…',
  localOnly:
    'This build uses a server on this computer only. A phone cannot connect to that address. Keep using the desktop until a reachable server is configured.',
  serverMissing:
    'This build has not provided its account server. Update Atum before connecting your phone; do not guess it from your account name.',
  actionFailed: 'That action did not complete. Please try again.'
}

const copy: Record<Locale, typeof en> = {
  en,
  vi: {
    title: 'Dùng trên điện thoại',
    description: 'Các cuộc trò chuyện Atum trên điện thoại, với ứng dụng miễn phí Element X.',
    download: '1. Tải Element X',
    downloadHelp: 'Quét bằng camera điện thoại, hoặc mở trang tải ứng dụng.',
    qr: 'Quét để tải Element X',
    qrFailed: 'Chưa tải được QR. Hãy dùng liên kết tải ứng dụng.',
    openDownload: 'Mở trang tải ứng dụng',
    connect: '2. Đăng nhập bằng tài khoản Atum',
    connectHelp: 'Trong Element X, chọn nhà cung cấp tài khoản khác và nhập địa chỉ này:',
    signInHelp: 'Sau đó đăng nhập bằng đúng tài khoản Google hoặc email bạn dùng cho Atum.',
    copyServer: 'Chép máy chủ',
    copyHint: 'Chép',
    copied: 'Đã chép',
    moreHelp: 'Trợ giúp thêm',
    account: 'Tài khoản của bạn',
    qrHelp: 'QR chỉ để tải ứng dụng. QR không bao giờ đăng nhập giúp bạn.',
    secureHelp:
      'Xác minh điện thoại bằng máy Mac này hoặc bằng khóa khôi phục. Đừng đặt lại khóa khôi phục để sửa lỗi thiếu tin nhắn.',
    finishingVerification: 'Đang hoàn tất thiết lập bảo mật từ máy Mac bạn đã phê duyệt…',
    localOnly:
      'Bản này dùng máy chủ chỉ trên máy tính hiện tại. Điện thoại không thể kết nối đến địa chỉ đó. Hãy tiếp tục dùng máy tính đến khi có máy chủ truy cập được.',
    serverMissing:
      'Bản này chưa cung cấp địa chỉ máy chủ tài khoản. Hãy cập nhật Atum trước khi kết nối điện thoại; đừng đoán địa chỉ từ tên tài khoản.',
    actionFailed: 'Chưa thực hiện được thao tác. Vui lòng thử lại.'
  },
  ja: {
    title: 'スマートフォンで使う',
    description: '無料アプリ Element X で、Atum のチャットをスマートフォンでも。',
    download: '1. Element X を入手',
    downloadHelp: 'スマートフォンのカメラでスキャンするか、ダウンロードページを開いてください。',
    qr: 'スキャンして Element X をダウンロード',
    qrFailed: 'QR を読み込めませんでした。ダウンロードリンクをご利用ください。',
    openDownload: 'ダウンロードページを開く',
    connect: '2. Atum アカウントでログイン',
    connectHelp: 'Element X で別のアカウントプロバイダーを選び、このアドレスを入力してください：',
    signInHelp: 'そのあと、Atum と同じ Google アカウントまたはメールでログインします。',
    copyServer: 'サーバーをコピー',
    copyHint: 'コピー',
    copied: 'コピーしました',
    moreHelp: 'その他のヘルプ',
    account: 'あなたのアカウント',
    qrHelp: 'この QR はアプリのダウンロード専用です。ログインは行いません。',
    secureHelp:
      'この Mac または復旧キーでスマートフォンを検証してください。メッセージが足りなくても、復旧キーはリセットしないでください。',
    finishingVerification: '承認した Mac から安全な設定を完了しています…',
    localOnly:
      'このビルドはこのコンピューター内だけのサーバーを使用しています。スマートフォンからは接続できません。接続可能なサーバーが設定されるまでデスクトップをご利用ください。',
    serverMissing:
      'このビルドからサーバー情報が提供されていません。スマートフォンを接続する前に Atum を更新してください。アカウント名から推測しないでください。',
    actionFailed: '操作を完了できませんでした。もう一度お試しください。'
  },
  zh: {
    title: '在手机上使用',
    description: '用免费的 Element X 应用，在手机上继续 Atum 聊天。',
    download: '1. 下载 Element X',
    downloadHelp: '用手机相机扫码，或打开下载页面。',
    qr: '扫码下载 Element X',
    qrFailed: '二维码未能加载。请使用下载链接。',
    openDownload: '打开下载页面',
    connect: '2. 用你的 Atum 账号登录',
    connectHelp: '在 Element X 中选择其他账号提供商，并输入这个地址：',
    signInHelp: '然后用你在 Atum 使用的同一个 Google 账号或邮箱登录。',
    copyServer: '复制服务器',
    copyHint: '复制',
    copied: '已复制',
    moreHelp: '更多帮助',
    account: '你的账号',
    qrHelp: '二维码只用于下载应用，绝不会替你登录。',
    secureHelp: '用这台 Mac 或恢复密钥验证手机。不要为了找回缺失的消息而重置恢复密钥。',
    finishingVerification: '正在从已批准的 Mac 完成安全设置…',
    localOnly: '此版本使用仅在本机运行的服务器，手机无法连接该地址。配置可访问的服务器之前，请继续使用桌面端。',
    serverMissing: '此版本未提供账号服务器地址。连接手机前请更新 Atum，不要从账号名称猜测地址。',
    actionFailed: '操作未完成，请重试。'
  },
  'zh-hant': {
    title: '在手機上使用',
    description: '用免費的 Element X 應用程式，在手機上繼續 Atum 聊天。',
    download: '1. 下載 Element X',
    downloadHelp: '用手機相機掃描，或開啟下載頁面。',
    qr: '掃碼下載 Element X',
    qrFailed: 'QR 碼未能載入。請使用下載連結。',
    openDownload: '開啟下載頁面',
    connect: '2. 用你的 Atum 帳號登入',
    connectHelp: '在 Element X 中選擇其他帳號提供者，並輸入這個位址：',
    signInHelp: '然後用你在 Atum 使用的同一個 Google 帳號或電子郵件登入。',
    copyServer: '拷貝伺服器',
    copyHint: '拷貝',
    copied: '已拷貝',
    moreHelp: '更多說明',
    account: '你的帳號',
    qrHelp: 'QR 碼只用於下載應用程式，絕不會替你登入。',
    secureHelp: '用這台 Mac 或復原金鑰驗證手機。不要為了找回缺失的訊息而重設復原金鑰。',
    finishingVerification: '正在從已核准的 Mac 完成安全設定…',
    localOnly: '此版本使用僅在本機執行的伺服器，手機無法連線到該位址。設定可存取的伺服器之前，請繼續使用桌面版。',
    serverMissing: '此版本未提供帳號伺服器位址。連接手機前請更新 Atum，不要從帳號名稱猜測位址。',
    actionFailed: '操作未完成，請重試。'
  }
}

export function useMobileCopy() {
  return copy[useI18n().locale]
}

// Phone-only shared material for P0; no desktop screen consumes this catalog.
// Purchase strings are resources only. M1 never renders purchase calls to action.
const phoneEn = {
  opening: 'Opening Atum',
  signingIn: 'Signing in',
  notificationsOn: 'On',
  notificationsOff: 'Off',
  signOutTitle: 'Sign out on this iPhone?',
  signOutBody: 'Your chats stay in your account.',
  restoreDone: 'Your old messages are back.',
  signInWithApple: 'Continue with Apple',
  trustThisPhone: 'Trust this iPhone',
  whoAnswers: 'Who answers',
  whoAnswersCloud: 'Your assistant answers in the cloud.',
  whoAnswersMac: 'Your assistant answers on your Mac.',
  offline: 'You’re offline. Your draft is kept.',
  notReady: 'Your assistant is not ready yet.',
  unverified: 'Verify this iPhone before sending.',
  undecryptable: 'This device needs recovery.',
  genericNotification: 'You have a new message',
  notificationTitle: 'Allow notifications?',
  notificationHelp: 'Get notified when a reply arrives. Notifications show no sender or message content.',
  recoveryTitle: 'Keep your recovery key safe',
  phoneFirstRecoveryHelp: 'Your recovery key is stored on this iPhone. You can save a copy after your first result.',
  saveRecoveryBeforeSignOut:
    'This key reopens your old messages next time you sign in. Save a copy somewhere safe first.',
  revocationUnconfirmed: 'Signed out here; remote revocation unconfirmed.',
  deletionTitle: 'Delete your account?',
  deletionHelp: 'Your account and personal content will be deleted. Required billing records may be retained.',
  aiConsentTitle: 'Allow AI providers to process your task?',
  aiConsentHelp:
    'Atum sends the messages and files you choose to third-party AI providers to answer and carry out your task.',
  allow: 'Allow',
  notNow: 'Not now',
  noPurchasesTitle: 'Purchases are not available yet',
  noPurchasesHelp: 'Your balance is available here.',
  purchaseTitle: 'Buy Protons',
  purchaseHelp: 'Payment uses your Apple Account payment method.',
  purchasePending: 'Your purchase is pending.',
  purchaseCancelled: 'Purchase cancelled.',
  purchaseCreditPending: 'Payment received. Your balance is still being confirmed.',
  purchaseComplete: 'Your Protons are ready.',
  restorePurchases: 'Recover balance',
  outOfProtons: 'You’re out of Protons. Your draft is kept.',
  retry: 'Try again',
  recoverOldMessages: 'Enter your recovery key to see older messages',
  newMessageNotification: 'New message',
  notificationPermissionHelp: 'Turn on notifications to know when your assistant replies.',
  storeEmpty: 'Nothing here yet.',
  photoLibraryAddUsage: 'Atum saves the photos you choose to your library.',
  microphoneUsage: 'Atum uses the microphone to turn your speech into text when you tap the mic.',
  speechRecognitionUsage: 'Atum uses speech recognition to turn what you say into text in the message box.',
  productPrice: (amount: string, price: string) => `${amount} Protons · ${price}`
}

export const mobilePhoneCopy: Record<Locale, typeof phoneEn> = {
  en: phoneEn,
  vi: {
    opening: 'Đang mở Atum',
    signingIn: 'Đang đăng nhập',
    notificationsOn: 'Đang bật',
    notificationsOff: 'Đang tắt',
    signOutTitle: 'Đăng xuất khỏi iPhone này?',
    signOutBody: 'Các cuộc trò chuyện vẫn nằm trong tài khoản của bạn.',
    restoreDone: 'Đã mở lại tin nhắn cũ.',
    signInWithApple: 'Tiếp tục với Apple',
    trustThisPhone: 'Tin cậy iPhone này',
    whoAnswers: 'Ai trả lời',
    whoAnswersCloud: 'Trợ lý trả lời trên đám mây.',
    whoAnswersMac: 'Trợ lý trả lời trên máy Mac của bạn.',
    offline: 'Bạn đang ngoại tuyến. Bản nháp được giữ lại.',
    notReady: 'Trợ lý chưa sẵn sàng.',
    unverified: 'Xác minh iPhone này trước khi gửi.',
    undecryptable: 'Thiết bị này cần khôi phục.',
    genericNotification: 'Bạn có tin nhắn mới',
    notificationTitle: 'Cho phép thông báo?',
    notificationHelp: 'Nhận thông báo khi có câu trả lời. Thông báo không hiện người gửi hay nội dung tin nhắn.',
    recoveryTitle: 'Giữ an toàn khóa khôi phục',
    phoneFirstRecoveryHelp: 'Khóa khôi phục được lưu trên iPhone này. Bạn có thể lưu một bản sao sau kết quả đầu tiên.',
    saveRecoveryBeforeSignOut:
      'Khóa này mở lại tin nhắn cũ khi bạn đăng nhập lần sau. Hãy lưu một bản ở nơi an toàn trước khi đăng xuất.',
    revocationUnconfirmed: 'Đã đăng xuất tại đây; chưa xác nhận thu hồi từ xa.',
    deletionTitle: 'Xóa tài khoản?',
    deletionHelp: 'Tài khoản và nội dung cá nhân sẽ bị xóa. Hồ sơ thanh toán bắt buộc có thể được giữ lại.',
    aiConsentTitle: 'Cho phép nhà cung cấp AI xử lý tác vụ?',
    aiConsentHelp:
      'Atum gửi các tin nhắn và tệp bạn chọn đến nhà cung cấp AI bên thứ ba để trả lời và thực hiện tác vụ của bạn.',
    allow: 'Cho phép',
    notNow: 'Để sau',
    noPurchasesTitle: 'Chưa thể mua hàng',
    noPurchasesHelp: 'Bạn có thể xem số dư tại đây.',
    purchaseTitle: 'Mua Proton',
    purchaseHelp: 'Thanh toán bằng phương thức thanh toán của Tài khoản Apple.',
    purchasePending: 'Giao dịch mua đang chờ xử lý.',
    purchaseCancelled: 'Đã hủy giao dịch mua.',
    purchaseCreditPending: 'Đã nhận thanh toán. Số dư vẫn đang được xác nhận.',
    purchaseComplete: 'Proton của bạn đã sẵn sàng.',
    restorePurchases: 'Khôi phục số dư',
    outOfProtons: 'Bạn đã hết Proton. Bản nháp được giữ lại.',
    retry: 'Thử lại',
    recoverOldMessages: 'Nhập khóa khôi phục để xem tin nhắn cũ',
    newMessageNotification: 'Tin nhắn mới',
    notificationPermissionHelp: 'Bật thông báo để biết khi trợ lý trả lời.',
    storeEmpty: 'Chưa có gì ở đây.',
    photoLibraryAddUsage: 'Atum lưu ảnh bạn chọn vào Thư viện ảnh.',
    microphoneUsage: 'Atum dùng micrô để chuyển giọng nói của bạn thành chữ khi bạn bấm nút micrô.',
    speechRecognitionUsage: 'Atum dùng nhận dạng giọng nói để chuyển lời bạn nói thành chữ trong khung soạn tin.',
    productPrice: (amount: string, price: string) => `${amount} Proton · ${price}`
  },
  ja: {
    opening: 'Atum を開いています',
    signingIn: 'ログインしています',
    notificationsOn: 'オン',
    notificationsOff: 'オフ',
    signOutTitle: 'この iPhone からサインアウトしますか？',
    signOutBody: 'チャットはアカウントに残ります。',
    restoreDone: '以前のメッセージを開けるようになりました。',
    signInWithApple: 'Apple で続ける',
    trustThisPhone: 'この iPhone を信頼する',
    whoAnswers: '応答する場所',
    whoAnswersCloud: 'アシスタントはクラウドで応答します。',
    whoAnswersMac: 'アシスタントはあなたの Mac で応答します。',
    offline: 'オフラインです。下書きは保存されています。',
    notReady: 'アシスタントはまだ準備ができていません。',
    unverified: '送信する前にこの iPhone を検証してください。',
    undecryptable: 'このデバイスには復旧が必要です。',
    genericNotification: '新しいメッセージがあります',
    notificationTitle: '通知を許可しますか？',
    notificationHelp: '返信が届くと通知します。送信者やメッセージの内容は表示しません。',
    recoveryTitle: '復旧キーを安全に保管',
    phoneFirstRecoveryHelp: '復旧キーはこの iPhone に保存されます。最初の結果の後にコピーを保存できます。',
    saveRecoveryBeforeSignOut:
      'このキーで、次回ログイン時に以前のメッセージを開けます。先に安全な場所へコピーを保存してください。',
    revocationUnconfirmed: 'この端末ではサインアウトしました。リモートでの取り消しは未確認です。',
    deletionTitle: 'アカウントを削除しますか？',
    deletionHelp: 'アカウントと個人コンテンツは削除されます。必要な請求記録は保持される場合があります。',
    aiConsentTitle: 'AI プロバイダーによるタスク処理を許可しますか？',
    aiConsentHelp:
      'Atum は選択したメッセージとファイルを第三者の AI プロバイダーに送り、回答やタスクの実行に使用します。',
    allow: '許可',
    notNow: 'あとで',
    noPurchasesTitle: '購入はまだ利用できません',
    noPurchasesHelp: 'ここで残高を確認できます。',
    purchaseTitle: 'Protons を購入',
    purchaseHelp: 'Apple Account のお支払い方法を使用します。',
    purchasePending: '購入は保留中です。',
    purchaseCancelled: '購入をキャンセルしました。',
    purchaseCreditPending: '支払いを受け取りました。残高を確認しています。',
    purchaseComplete: 'Protons が利用できます。',
    restorePurchases: '残高を復元',
    outOfProtons: 'Protons がありません。下書きは保存されています。',
    retry: '再試行',
    recoverOldMessages: '復旧キーを入力して以前のメッセージを表示',
    newMessageNotification: '新しいメッセージ',
    notificationPermissionHelp: '通知をオンにすると、アシスタントが返信したときにわかります。',
    storeEmpty: 'まだ何もありません。',
    photoLibraryAddUsage: 'Atum は選択した写真を写真ライブラリに保存します。',
    microphoneUsage: 'Atum は、マイクボタンをタップしたときに、音声をテキストに変換するためにマイクを使用します。',
    speechRecognitionUsage: 'Atum は、話した内容をメッセージ欄のテキストに変換するために音声認識を使用します。',
    productPrice: (amount: string, price: string) => `${amount} Protons · ${price}`
  },
  zh: {
    opening: '正在打开 Atum',
    signingIn: '正在登录',
    notificationsOn: '已开启',
    notificationsOff: '已关闭',
    signOutTitle: '要退出这台 iPhone 上的账号吗？',
    signOutBody: '聊天记录仍会保留在你的账号中。',
    restoreDone: '旧消息已恢复。',
    signInWithApple: '通过 Apple 继续',
    trustThisPhone: '信任这台 iPhone',
    whoAnswers: '谁会回答',
    whoAnswersCloud: '助手在云端回答。',
    whoAnswersMac: '助手在你的 Mac 上回答。',
    offline: '你已离线。草稿已保留。',
    notReady: '助手尚未准备好。',
    unverified: '发送前请验证这台 iPhone。',
    undecryptable: '这台设备需要恢复。',
    genericNotification: '你有新消息',
    notificationTitle: '允许通知？',
    notificationHelp: '收到回复时通知你。通知不显示发送者或消息内容。',
    recoveryTitle: '妥善保存恢复密钥',
    phoneFirstRecoveryHelp: '恢复密钥保存在这台 iPhone 上。首次获得结果后，你可以保存一份副本。',
    saveRecoveryBeforeSignOut: '此密钥可在你下次登录时重新打开旧消息。请先在安全的位置保存一份副本。',
    revocationUnconfirmed: '已在此设备退出登录；远程撤销尚未确认。',
    deletionTitle: '删除账号？',
    deletionHelp: '你的账号和个人内容将被删除。法律要求的账单记录可能会保留。',
    aiConsentTitle: '允许 AI 提供商处理你的任务？',
    aiConsentHelp: 'Atum 会将你选择的消息和文件发送给第三方 AI 提供商，用于回答和执行你的任务。',
    allow: '允许',
    notNow: '暂不',
    noPurchasesTitle: '暂时无法购买',
    noPurchasesHelp: '你可以在这里查看余额。',
    purchaseTitle: '购买 Proton',
    purchaseHelp: '使用 Apple 账户的付款方式支付。',
    purchasePending: '购买正在等待处理。',
    purchaseCancelled: '已取消购买。',
    purchaseCreditPending: '已收到付款。正在确认余额。',
    purchaseComplete: '你的 Proton 已到账。',
    restorePurchases: '恢复余额',
    outOfProtons: 'Proton 已用完。草稿已保留。',
    retry: '重试',
    recoverOldMessages: '输入恢复密钥以查看旧消息',
    newMessageNotification: '新消息',
    notificationPermissionHelp: '开启通知，助手回复时就能知道。',
    storeEmpty: '这里还没有内容。',
    photoLibraryAddUsage: 'Atum 会将你选择的照片保存到照片图库。',
    microphoneUsage: '当你点按麦克风按钮时，Atum 会使用麦克风将你的语音转换为文字。',
    speechRecognitionUsage: 'Atum 会使用语音识别将你说的话转换为消息框中的文字。',
    productPrice: (amount: string, price: string) => `${amount} Proton · ${price}`
  },
  'zh-hant': {
    opening: '正在開啟 Atum',
    signingIn: '正在登入',
    notificationsOn: '已開啟',
    notificationsOff: '已關閉',
    signOutTitle: '要在這台 iPhone 上登出嗎？',
    signOutBody: '聊天記錄仍會保留在你的帳號中。',
    restoreDone: '舊訊息已恢復。',
    signInWithApple: '透過 Apple 繼續',
    trustThisPhone: '信任這台 iPhone',
    whoAnswers: '誰會回答',
    whoAnswersCloud: '助理在雲端回答。',
    whoAnswersMac: '助理在你的 Mac 上回答。',
    offline: '你已離線。草稿已保留。',
    notReady: '助理尚未準備好。',
    unverified: '傳送前請驗證這台 iPhone。',
    undecryptable: '這台裝置需要復原。',
    genericNotification: '你有新訊息',
    notificationTitle: '允許通知？',
    notificationHelp: '收到回覆時通知你。通知不顯示傳送者或訊息內容。',
    recoveryTitle: '妥善保存復原金鑰',
    phoneFirstRecoveryHelp: '復原金鑰儲存在這台 iPhone 上。首次獲得結果後，你可以儲存一份副本。',
    saveRecoveryBeforeSignOut: '這把金鑰可在你下次登入時重新開啟舊訊息。請先在安全的位置儲存一份副本。',
    revocationUnconfirmed: '已在此裝置登出；遠端撤銷尚未確認。',
    deletionTitle: '刪除帳號？',
    deletionHelp: '你的帳號和個人內容將被刪除。法律要求的帳單記錄可能會保留。',
    aiConsentTitle: '允許 AI 供應商處理你的任務？',
    aiConsentHelp: 'Atum 會將你選擇的訊息和檔案傳送給第三方 AI 供應商，用於回答和執行你的任務。',
    allow: '允許',
    notNow: '暫不',
    noPurchasesTitle: '暫時無法購買',
    noPurchasesHelp: '你可以在這裡查看餘額。',
    purchaseTitle: '購買 Proton',
    purchaseHelp: '使用 Apple 帳號的付款方式支付。',
    purchasePending: '購買正在等待處理。',
    purchaseCancelled: '已取消購買。',
    purchaseCreditPending: '已收到付款。正在確認餘額。',
    purchaseComplete: '你的 Proton 已入帳。',
    restorePurchases: '恢復餘額',
    outOfProtons: 'Proton 已用完。草稿已保留。',
    retry: '重試',
    recoverOldMessages: '輸入復原金鑰以查看舊訊息',
    newMessageNotification: '新訊息',
    notificationPermissionHelp: '開啟通知，助理回覆時就能知道。',
    storeEmpty: '這裡還沒有內容。',
    photoLibraryAddUsage: 'Atum 會將你選擇的照片儲存到照片圖庫。',
    microphoneUsage: '當你點按麥克風按鈕時，Atum 會使用麥克風將你的語音轉換為文字。',
    speechRecognitionUsage: 'Atum 會使用語音辨識將你說的話轉換為訊息框中的文字。',
    productPrice: (amount: string, price: string) => `${amount} Proton · ${price}`
  }
}

// The iPhone chat revamp's first build (S1, atum-mobile plan 2026-10-10 §1 and §3.10). Only the
// words no exported table already says: the phone also reads chat-copy's message actions and
// delivery words, and a few shared i18n words. Which key shows where:
//  The keys the phone codes against are
// listed in packages/mobile-design-exports/phone-chat-keys.json, so none can vanish unseen.
// Chats feel like messaging: no working or status words here, and no purchase call to action.
const phoneChatEn = {
  // A small label under a message a person changed. Agent and bot edits show no label.
  edited: 'edited',
  // The long-press item on an answer that opens a sheet of selectable text.
  selectText: 'Select text',
  // The jump pill while scrolled up; with no new messages it is an arrow with this label.
  newMessages: (count: number) => (count === 1 ? '1 new message' : `${count} new messages`),
  jumpToLatest: 'Go to the latest message',
  // The quiet line where unread messages start.
  readMarker: 'New messages',
  // A message that cannot show its content, one line each (ChatItem.PlaceholderReason).
  placeholder: {
    unsupported: 'This kind of message can’t be shown yet.',
    redacted: 'This message was deleted.',
    undecryptableOldHistory: 'This older message isn’t on this iPhone.',
    undecryptable: 'This message can’t be opened.'
  },
  // What an image box and a file row are, for screen readers.
  photo: 'Photo',
  file: 'File',
  // Under my newest message in an assistant chat after 10 minutes with no answer.
  noAnswer: 'No reply yet.',
  composerPlaceholder: (name: string) => `Message ${name}`,
  // A quote whose original message cannot be loaded.
  quoteUnavailable: 'The original message isn’t available.',
  // A payment link tapped on iPhone: nothing opens, and nothing points to buying elsewhere.
  linkHeld: 'This link can’t be opened on iPhone yet.',
  // What VoiceOver says when a message arrives while following the chat.
  incomingAnnouncement: (name: string, text: string) => `${name}: ${text}`,
  home: {
    justNow: 'Just now',
    preview: {
      byline: (name: string, text: string) => `${name}: ${text}`,
      photo: '📷 Photo',
      video: '🎬 Video',
      audio: '🎵 Audio',
      file: '📎 File',
      fileNamed: (name: string) => `📎 ${name}`,
      sticker: 'Sticker',
      waiting: '🔒 Waiting for this message',
      invite: 'Invited you to chat'
    },
    declineInvite: 'Decline invitation',
    mentions: 'Mentions you',
    newMessages: 'New messages',
    muted: 'Notifications off',
    pinned: 'Pinned',
    emptyTitle: 'Your assistant will be here',
    emptyBody: 'Atum is setting up your assistant. It shows up here as soon as it’s ready.'
  },
  info: {
    open: 'Show details',
    kindAssistant: 'Your assistant',
    memberCount: (count: number) => `${count} members`,
    assistantAccessTitle: 'Your assistant can read',
    assistantAccessPlain:
      'Messages in this chat, including other people’s messages in groups, even while your phone and computer are off. Your model provider processes the content, and your assistant may remember it. You can end future reads for this chat whenever you like; that does not undo earlier reads.',
    assistantAccessEncrypted: 'Room details only, not message text. Turning this protection on does not undo earlier reads.'
  },
  media: {
    photoNumber: (n: number) => `Photo ${n}`,
    removePhoto: (n: number) => `Remove photo ${n}`,
    previewHint: 'Preview',
    openPhotoHint: 'View photo',
    openFileHint: 'Open file',
    share: 'Share',
    cancelUpload: 'Cancel',
    uploadProgress: (n: number) => `${n}% uploaded`,
    loadFailed: 'Couldn’t load. Tap to try again.',
    originalFailed: 'Couldn’t load the full photo.',
    tooLargePhoto: 'This photo is too large to send.',
    tooLargeFile: 'This file is too large to send. Choose a smaller file.',
    tooLargeSome: (n: number) => `${n} files were too large to add.`,
    tooMany: (n: number) => `Up to ${n} photos or files at a time.`,
    unreadable: 'Couldn’t open this file. Try another one.',
    kind: {
      pdf: 'PDF',
      document: 'Document',
      spreadsheet: 'Spreadsheet',
      presentation: 'Presentation',
      archive: 'Archive',
      video: 'Video',
      audio: 'Audio'
    }
  },
  appBot: {
    notice: {
      needs_setup: (app: string) => `${app} hasn’t answered because you haven’t started.`,
      needs_intake: (app: string) => `${app} needs your birth date, time and place first.`,
      allowance_exhausted: (app: string) => `You’ve used all your messages with ${app}.`,
      unverified_sender: (app: string) => `${app} couldn’t read this. Please resend.`,
      link_pending: (app: string) => `${app} is finishing your account connection. Please send again in a minute.`,
      busy: (app: string) => `${app} is still answering your previous message. Please send again in a few seconds.`,
      rate_limited: 'Too many messages just now. Please wait a few minutes and try again.',
      app_unavailable: (app: string) => `${app} is temporarily unavailable. Please try again in a few minutes.`,
      app_timeout: (app: string) => `${app} took longer than usual, so the answer could not be posted.`,
      outcome_unknown: (app: string) => `${app} may have received this message, but its answer didn't make it back here. The message may have been counted, and Atum is checking. If no answer reaches you, email support@atumplatform.com.`,
      missed_while_offline: (app: string) => `${app} was away when you sent this. Please send it again.`,
      sent_before_link: (app: string) => `${app} is now connected to your account. This message was sent before that, so please send it again.`,
      unsupported_content: (app: string) => `${app} can only read text messages for now.`,
      message_too_long: (app: string) => `That message is too long for ${app}. Please split it and send it again.`,
      cannot_read: (app: string) => `${app} couldn’t read this message. Please update Atum and send it again.`,
      andy_group_declined: 'Andy only chats one-on-one for now. You can message Andy here.',
      joined: (app: string) => `${app} is here. Mention @${app} or reply to ${app} to ask. ${app} uses only that message and one message you choose to quote; each question counts against the asker’s own ${app} messages.`,
      now_group: 'This is now a group. Moon answers only when mentioned or replied to, and uses no one’s chart or memory here.',
      andy_leaving: 'Andy only chats one-on-one, so Andy is leaving this chat. You can message Andy privately anytime.'
    },
      onboarding: {
        consent: (app: string) => `${app} will receive your name and the content you share in this conversation so it can answer you.`,
        connecting: (app: string) => `Connecting to ${app}…`,
        failure: (_app: string) => 'That didn’t work.',
        moonTermsURL: 'https://moon.atumplatform.com/chinh-sach/dieu-khoan-ai-va-du-lieu',
        andyTermsURL: 'https://andy.atumplatform.com/terms',
        birth: {
          preferredName: 'Preferred name',
          date: 'Birth date',
          time: 'Birth time',
          timeHelper: 'An approximate time is okay.',
          city: 'Birth city',
          gender: 'Gender',
          genderMale: 'Male',
          genderFemale: 'Female'
        },
        readings: 'Readings'
      },
      fillIn: 'Fill in details',
      continueOnMac: {
      title: 'Continue in Atum on your computer',
      setupBody: (app: string) => `Start in your ${app} chat on the computer; then chat here.`,
      routeBody: (app: string) => `This part of ${app} opens on your computer.`
    },
    gotIt: 'Got it',
    roomFailed: (app: string) => `Couldn’t open your chat with ${app}.`
  }
}

export const mobileChatCopy: Record<Locale, typeof phoneChatEn> = {
  en: phoneChatEn,
  vi: {
    edited: 'đã sửa',
    selectText: 'Chọn văn bản',
    newMessages: count => `${count} tin nhắn mới`,
    jumpToLatest: 'Đến tin nhắn mới nhất',
    readMarker: 'Tin nhắn mới',
    placeholder: {
      unsupported: 'Chưa hiển thị được loại tin nhắn này.',
      redacted: 'Tin nhắn đã bị xóa.',
      undecryptableOldHistory: 'Tin nhắn cũ không có trên iPhone này.',
      undecryptable: 'Không mở được tin nhắn này.'
    },
    photo: 'Ảnh',
    file: 'Tệp',
    noAnswer: 'Chưa có câu trả lời.',
    composerPlaceholder: name => `Nhắn cho ${name}`,
    quoteUnavailable: 'Không xem được tin nhắn gốc.',
    linkHeld: 'Liên kết này chưa mở được trên iPhone.',
    incomingAnnouncement: (name, text) => `${name}: ${text}`,
    home: {
      justNow: 'Vừa xong',
      preview: {
        byline: (name, text) => `${name}: ${text}`,
        photo: '📷 Ảnh',
        video: '🎬 Video',
        audio: '🎵 Âm thanh',
        file: '📎 Tệp',
        fileNamed: name => `📎 ${name}`,
        sticker: 'Nhãn dán',
        waiting: '🔒 Đang chờ tin nhắn',
        invite: 'Mời bạn trò chuyện'
      },
      declineInvite: 'Từ chối lời mời',
      mentions: 'Nhắc đến bạn',
      newMessages: 'Có tin nhắn mới',
      muted: 'Đã tắt thông báo',
      pinned: 'Đã ghim',
      emptyTitle: 'Trợ lý của bạn sẽ ở đây',
      emptyBody: 'Atum đang tạo trợ lý cho bạn. Trợ lý sẽ hiện ở đây ngay khi sẵn sàng.'
    },
    info: {
      open: 'Xem thông tin',
      kindAssistant: 'Trợ lý của bạn',
      memberCount: count => `${count} thành viên`,
      assistantAccessTitle: 'Trợ lý của bạn có thể đọc',
      assistantAccessPlain:
        'Tin nhắn trong cuộc trò chuyện này, gồm cả tin nhắn của người khác trong nhóm, kể cả khi điện thoại và máy tính của bạn đang tắt. Nhà cung cấp mô hình xử lý nội dung và trợ lý có thể ghi nhớ. Bạn có thể cho trợ lý ngừng đọc tin nhắn mới trong cuộc trò chuyện này bất cứ lúc nào; việc này không hoàn tác những gì đã đọc trước đó.',
      assistantAccessEncrypted:
        'Chỉ thông tin phòng, không phải nội dung tin nhắn. Bật bảo vệ không hoàn tác những gì đã đọc trước đó.'
    },
    media: {
      photoNumber: n => `Ảnh ${n}`,
      removePhoto: n => `Bỏ ảnh ${n}`,
      previewHint: 'Xem trước',
      openPhotoHint: 'Xem ảnh',
      openFileHint: 'Mở tệp',
      share: 'Chia sẻ',
      cancelUpload: 'Hủy gửi',
      uploadProgress: n => `Đã tải lên ${n}%`,
      loadFailed: 'Chưa tải được. Chạm để thử lại.',
      originalFailed: 'Chưa tải được ảnh gốc.',
      tooLargePhoto: 'Ảnh này lớn quá để gửi.',
      tooLargeFile: 'Tệp này lớn quá để gửi. Bạn chọn tệp nhỏ hơn nhé.',
      tooLargeSome: n => `${n} tệp lớn quá nên chưa được thêm.`,
      tooMany: n => `Mỗi lần gửi được tối đa ${n} ảnh hoặc tệp.`,
      unreadable: 'Chưa mở được tệp này. Bạn thử tệp khác nhé.',
      kind: {
        pdf: 'PDF',
        document: 'Tài liệu',
        spreadsheet: 'Bảng tính',
        presentation: 'Bản trình chiếu',
        archive: 'Tệp nén',
        video: 'Video',
        audio: 'Âm thanh'
      }
    },
    appBot: {
      notice: {
        needs_setup: app => `${app} chưa trả lời vì bạn chưa bắt đầu.`,
        needs_intake: app => `${app} cần ngày, giờ và nơi sinh của bạn trước khi trả lời.`,
        allowance_exhausted: app => `Bạn đã dùng hết lượt nhắn với ${app}.`,
        unverified_sender: app => `${app} chưa đọc được tin nhắn này. Bạn gửi lại nhé.`,
        link_pending: app => `${app} đang hoàn tất kết nối tài khoản của bạn. Bạn gửi lại sau một phút nhé.`,
        busy: app => `${app} vẫn đang trả lời tin trước của bạn. Bạn gửi lại sau ít giây nhé.`,
        rate_limited: 'Bạn đang nhắn hơi nhanh. Bạn đợi vài phút rồi gửi lại nhé.',
        app_unavailable: app => `${app} đang tạm gián đoạn. Bạn thử lại sau ít phút nhé.`,
        app_timeout: app => `${app} trả lời lâu hơn bình thường nên chưa gửi được câu trả lời. Nếu lượt nhắn đã bị trừ mà không có câu trả lời, hãy liên hệ support@atumplatform.com.`,
        outcome_unknown: app => `${app} có thể đã nhận tin này nhưng câu trả lời không về được đây. Lượt nhắn có thể đã được tính và Atum đang kiểm tra lại. Nếu bạn không nhận được câu trả lời, hãy báo support@atumplatform.com.`,
        missed_while_offline: app => `Xin lỗi, ${app} tạm vắng lúc bạn nhắn. Bạn gửi lại tin nhắn nhé.`,
        sent_before_link: app => `${app} đã kết nối với tài khoản của bạn. Tin này được gửi trước khi kết nối, bạn gửi lại nhé.`,
        unsupported_content: app => `${app} hiện chỉ đọc được tin nhắn chữ.`,
        message_too_long: app => `Tin nhắn dài quá để ${app} đọc. Bạn chia nhỏ rồi gửi lại nhé.`,
        cannot_read: app => `${app} chưa đọc được tin nhắn này. Bạn cập nhật Atum rồi gửi lại nhé.`,
        andy_group_declined: 'Andy chỉ trò chuyện riêng nên chưa thể vào nhóm. Bạn cứ nhắn cho Andy ở đây nhé.',
        joined: app => `${app} đã vào nhóm. Nhắc @${app} hoặc trả lời tin của ${app} để hỏi. ${app} chỉ dùng tin nhắn đó và một tin bạn chọn trích dẫn; mỗi câu hỏi tính vào lượt ${app} của chính người hỏi.`,
        now_group: 'Đây giờ là nhóm. Moon chỉ trả lời khi được nhắc hoặc khi bạn trả lời tin của Moon, và không dùng lá số hay ký ức của ai ở đây.',
        andy_leaving: 'Andy chỉ trò chuyện riêng nên sẽ rời cuộc trò chuyện này. Bạn có thể nhắn riêng cho Andy bất cứ lúc nào.'
      },
      onboarding: {
        consent: (app: string) => `${app} sẽ nhận tên và nội dung bạn chia sẻ trong cuộc trò chuyện này để trả lời bạn.`,
        connecting: (app: string) => `Đang kết nối với ${app}…`,
        failure: (_app: string) => 'Chưa kết nối được.',
        moonTermsURL: 'https://moon.atumplatform.com/chinh-sach/dieu-khoan-ai-va-du-lieu',
        andyTermsURL: 'https://andy.atumplatform.com/terms',
        birth: {
          preferredName: 'Tên gọi',
          date: 'Ngày sinh',
          time: 'Giờ sinh',
          timeHelper: 'Giờ gần đúng cũng được.',
          city: 'Nơi sinh',
          gender: 'Giới tính',
          genderMale: 'Nam',
          genderFemale: 'Nữ'
        },
        readings: 'Luận giải'
      },
      fillIn: 'Điền thông tin',
      continueOnMac: {
        title: 'Tiếp tục trên Atum cho máy tính',
        setupBody: app => `Mở chat với ${app} trên Atum cho máy tính để bắt đầu. Xong một lần, bạn nhắn với ${app} ngay trên iPhone.`,
        routeBody: app => `Phần này của ${app} mở trên Atum cho máy tính.`
      },
      gotIt: 'Đã hiểu',
      roomFailed: app => `Chưa mở được cuộc trò chuyện với ${app}.`
    }
  },
  ja: {
    edited: '編集済み',
    selectText: 'テキストを選択',
    newMessages: count => `新着メッセージ ${count} 件`,
    jumpToLatest: '最新のメッセージへ',
    readMarker: '新着メッセージ',
    placeholder: {
      unsupported: 'この種類のメッセージはまだ表示できません。',
      redacted: 'このメッセージは削除されました。',
      undecryptableOldHistory: 'この古いメッセージはこの iPhone にはありません。',
      undecryptable: 'このメッセージを開けません。'
    },
    photo: '写真',
    file: 'ファイル',
    noAnswer: 'まだ返信がありません。',
    composerPlaceholder: name => `${name} にメッセージ`,
    quoteUnavailable: '元のメッセージを表示できません。',
    linkHeld: 'このリンクはまだ iPhone では開けません。',
    incomingAnnouncement: (name, text) => `${name}：${text}`,
    home: {
      justNow: 'たった今',
      preview: {
        byline: (name, text) => `${name}：${text}`,
        photo: '📷 写真',
        video: '🎬 動画',
        audio: '🎵 音声',
        file: '📎 ファイル',
        fileNamed: name => `📎 ${name}`,
        sticker: 'スタンプ',
        waiting: '🔒 メッセージを待機中',
        invite: 'チャットに招待されました'
      },
      declineInvite: '招待を辞退',
      mentions: 'あなたへのメンション',
      newMessages: '新着メッセージあり',
      muted: '通知オフ',
      pinned: 'ピン留め済み',
      emptyTitle: 'あなたのアシスタントがここに表示されます',
      emptyBody: 'Atum がアシスタントを準備しています。準備ができると、ここに表示されます。'
    },
    info: {
      open: '詳細を表示',
      kindAssistant: 'あなたのアシスタント',
      memberCount: count => `${count} 人のメンバー`,
      assistantAccessTitle: 'アシスタントが読み取れる内容',
      assistantAccessPlain:
        'このチャットのメッセージ（グループ内のほかの人のメッセージを含む）は、スマートフォンやパソコンの電源が切れている間も読み取られることがあります。モデルプロバイダーが内容を処理し、アシスタントが記憶する場合があります。このチャットでは、いつでも新しいメッセージを読み取らないようにできます。それ以前の読み取りは取り消されません。',
      assistantAccessEncrypted:
        'メッセージ本文ではなく、ルームの詳細情報のみです。保護をオンにしても、それ以前の読み取りは取り消されません。'
    },
    media: {
      photoNumber: n => `写真 ${n}`,
      removePhoto: n => `写真 ${n} を削除`,
      previewHint: 'プレビュー',
      openPhotoHint: '写真を表示',
      openFileHint: 'ファイルを開く',
      share: '共有',
      cancelUpload: '送信を中止',
      uploadProgress: n => `${n}% アップロード済み`,
      loadFailed: '読み込めませんでした。タップして再試行してください。',
      originalFailed: '元の写真を読み込めませんでした。',
      tooLargePhoto: 'この写真は大きすぎて送信できません。',
      tooLargeFile: 'このファイルは大きすぎて送信できません。小さいファイルを選んでください。',
      tooLargeSome: n => `${n} 件のファイルは大きすぎて追加できませんでした。`,
      tooMany: n => `一度に送信できるのは最大 ${n} 件の写真またはファイルです。`,
      unreadable: 'このファイルを開けませんでした。別のファイルをお試しください。',
      kind: {
        pdf: 'PDF',
        document: '書類',
        spreadsheet: '表計算',
        presentation: 'プレゼンテーション',
        archive: 'アーカイブ',
        video: '動画',
        audio: '音声'
      }
    },
    appBot: {
      notice: {
        needs_setup: app => `${app} はまだ回答していません。始めてください。`,
        needs_intake: app => `${app} が回答するには生年月日、時刻、出生地が必要です。`,
        allowance_exhausted: app => `${app}のメッセージを使い切りました。`,
        unverified_sender: app => `${app} はこのメッセージを読めませんでした。もう一度送信してください。`,
        link_pending: app => `${app} はアカウント接続を完了しています。1分後にもう一度送信してください。`,
        busy: app => `${app} は前のメッセージに回答中です。少し待ってからもう一度送信してください。`,
        rate_limited: '送信が速すぎます。数分待ってからもう一度送信してください。',
        app_unavailable: app => `${app} は一時的に利用できません。数分後にもう一度お試しください。`,
        app_timeout: app => `${app} の回答に時間がかかり、グループに投稿できませんでした。`,
        outcome_unknown: app => `${app} がこのメッセージを受け取った可能性がありますが、回答がここに届きませんでした。メッセージ数に数えられた可能性があり、Atum が確認しています。回答が届かない場合は support@atumplatform.com までご連絡ください。`,
        missed_while_offline: app => `${app} はメッセージ送信時に不在でした。もう一度送信してください。`,
        sent_before_link: app => `${app} は現在アカウントに接続されています。このメッセージは接続前に送られました。`,
        unsupported_content: app => `${app} は現在テキストメッセージだけを読めます。`,
        message_too_long: app => `このメッセージは${app}が読むには長すぎます。分けて送信してください。`,
        cannot_read: app => `${app} はこのメッセージを読めませんでした。Atumを更新してもう一度送信してください。`,
        andy_group_declined: 'Andyは1対1のチャットのみ対応しています。ここでAndyにメッセージできます。',
        joined: app => `${app} が参加しました。@${app}へのメンションまたは${app}への返信で質問できます。${app} はそのメッセージと、あなたが選んだ引用1件だけを使います。`,
        now_group: 'このチャットはグループになりました。MoonはメンションまたはMoonへの返信にだけ答え、ここでは誰のチャートや記憶も使いません。',
        andy_leaving: 'Andyは1対1のチャットのみ対応しているため、このチャットを退出します。いつでもAndyに個別でメッセージできます。'
      },
      onboarding: {
        consent: (app: string) => `${app}は、あなたに回答するため、この会話で共有した名前と内容を受け取ります。`,
        connecting: (app: string) => `${app}に接続しています…`,
        failure: (_app: string) => '接続できませんでした。',
        moonTermsURL: 'https://moon.atumplatform.com/chinh-sach/dieu-khoan-ai-va-du-lieu',
        andyTermsURL: 'https://andy.atumplatform.com/terms',
        birth: {
          preferredName: '呼び名',
          date: '生年月日',
          time: '出生時刻',
          timeHelper: 'おおよその時刻でも構いません。',
          city: '出生地',
          gender: '性別',
          genderMale: '男性',
          genderFemale: '女性'
        },
        readings: 'リーディング'
      },
      fillIn: '情報を入力',
      continueOnMac: {
        title: 'コンピューターの Atum で続ける',
        setupBody: app => `コンピューターの ${app} チャットで始めてください。完了後はここで${app}とチャットできます。`,
        routeBody: app => `${app} のこの部分はコンピューターで開きます。`
      },
      gotIt: 'わかりました',
      roomFailed: app => `${app} とのチャットを開けませんでした。`
    }
  },
  zh: {
    edited: '已编辑',
    selectText: '选择文本',
    newMessages: count => `${count} 条新消息`,
    jumpToLatest: '转到最新消息',
    readMarker: '新消息',
    placeholder: {
      unsupported: '暂时无法显示这类消息。',
      redacted: '此消息已删除。',
      undecryptableOldHistory: '这条旧消息不在这台 iPhone 上。',
      undecryptable: '无法打开这条消息。'
    },
    photo: '照片',
    file: '文件',
    noAnswer: '还没有回复。',
    composerPlaceholder: name => `给 ${name} 发消息`,
    quoteUnavailable: '无法查看原消息。',
    linkHeld: '这个链接暂时无法在 iPhone 上打开。',
    incomingAnnouncement: (name, text) => `${name}：${text}`,
    home: {
      justNow: '刚刚',
      preview: {
        byline: (name, text) => `${name}：${text}`,
        photo: '📷 照片',
        video: '🎬 视频',
        audio: '🎵 音频',
        file: '📎 文件',
        fileNamed: name => `📎 ${name}`,
        sticker: '贴纸',
        waiting: '🔒 正在等待消息',
        invite: '邀请你聊天'
      },
      declineInvite: '拒绝邀请',
      mentions: '提到了你',
      newMessages: '有新消息',
      muted: '通知已关闭',
      pinned: '已置顶',
      emptyTitle: '你的助手会显示在这里',
      emptyBody: 'Atum 正在为你创建助手。准备就绪后，助手会显示在这里。'
    },
    info: {
      open: '查看详情',
      kindAssistant: '你的助手',
      memberCount: count => `${count} 位成员`,
      assistantAccessTitle: '你的助手可以读取',
      assistantAccessPlain:
        '此聊天中的消息（包括群组中其他人的消息）即使在你的手机或电脑关机时也可能被读取。模型提供方会处理内容，你的助手也可能会记住。你可以随时让这个聊天不再读取新消息；这不会撤销此前的读取。',
      assistantAccessEncrypted: '只能读取房间详情，不能读取消息正文。开启保护不会撤销此前的读取。'
    },
    media: {
      photoNumber: n => `照片 ${n}`,
      removePhoto: n => `移除照片 ${n}`,
      previewHint: '预览',
      openPhotoHint: '查看照片',
      openFileHint: '打开文件',
      share: '分享',
      cancelUpload: '停止发送',
      uploadProgress: n => `已上传 ${n}%`,
      loadFailed: '无法加载。轻点重试。',
      originalFailed: '无法加载原始照片。',
      tooLargePhoto: '这张照片太大，无法发送。',
      tooLargeFile: '这个文件太大，无法发送。请选择更小的文件。',
      tooLargeSome: n => `${n} 个文件太大，无法添加。`,
      tooMany: n => `一次最多发送 ${n} 张照片或文件。`,
      unreadable: '无法打开这个文件。请换一个文件试试。',
      kind: {
        pdf: 'PDF',
        document: '文档',
        spreadsheet: '电子表格',
        presentation: '演示文稿',
        archive: '压缩文件',
        video: '视频',
        audio: '音频'
      }
    },
    appBot: {
      notice: {
        needs_setup: app => `${app} 尚未回答，因为你还没有开始。`,
        needs_intake: app => `${app} 需要你的出生日期、时间和地点才能回答。`,
        allowance_exhausted: app => `你已用完与 ${app} 的消息额度。`,
        unverified_sender: app => `${app} 无法读取这条消息。请重新发送。`,
        link_pending: app => `${app} 正在完成账户连接。请一分钟后再发送。`,
        busy: app => `${app} 仍在回复你之前的消息。请稍后再发送。`,
        rate_limited: '你发送得太快了。请等待几分钟后再发送。',
        app_unavailable: app => `${app} 暂时不可用。请稍后再试。`,
        app_timeout: app => `${app} 回复时间过长，无法发布到群组。`,
        outcome_unknown: app => `${app} 可能已收到这条消息，但回答没有送达这里。这条消息可能已被计入，Atum 正在核查。若始终没有收到回答，请联系 support@atumplatform.com。`,
        missed_while_offline: app => `${app} 在你发送时离线。请再发送一次。`,
        sent_before_link: app => `${app} 现已连接到你的账户。这条消息在连接前发送。`,
        unsupported_content: app => `${app} 目前只能读取文字消息。`,
        message_too_long: app => `这条消息太长，${app} 无法读取。请拆分后再发送。`,
        cannot_read: app => `${app} 无法读取这条消息。请更新 Atum 后再发送。`,
        andy_group_declined: 'Andy 目前仅支持一对一聊天。您可以在这里私信 Andy。',
        joined: app => `${app} 已加入群组。提及 @${app} 或回复 ${app} 即可提问。${app} 只使用该消息和您选择引用的一条消息。`,
        now_group: '这里现在是群组。Moon 只会在被提及或收到回复时回答，并且不会使用任何人的星盘或记忆。',
        andy_leaving: 'Andy 仅支持一对一聊天，因此将离开这个聊天。你可以随时私信 Andy。'
      },
      onboarding: {
        consent: (app: string) => `${app} 会接收你的姓名和你在此对话中分享的内容，以便回复你。`,
        connecting: (app: string) => `正在连接 ${app}…`,
        failure: (_app: string) => '连接未完成。',
        moonTermsURL: 'https://moon.atumplatform.com/chinh-sach/dieu-khoan-ai-va-du-lieu',
        andyTermsURL: 'https://andy.atumplatform.com/terms',
        birth: {
          preferredName: '称呼',
          date: '出生日期',
          time: '出生时间',
          timeHelper: '大概时间也可以。',
          city: '出生城市',
          gender: '性别',
          genderMale: '男性',
          genderFemale: '女性'
        },
        readings: '解读'
      },
      fillIn: '填写信息',
      continueOnMac: {
        title: '在电脑上的 Atum 中继续',
        setupBody: app => `先在电脑上的 ${app} 聊天中开始；之后可在这里聊天。`,
        routeBody: app => `${app} 的这一部分会在你的电脑上打开。`
      },
      gotIt: '知道了',
      roomFailed: app => `无法打开与你和 ${app} 的聊天。`
    }
  },
  'zh-hant': {
    edited: '已編輯',
    selectText: '選取文字',
    newMessages: count => `${count} 則新訊息`,
    jumpToLatest: '前往最新訊息',
    readMarker: '新訊息',
    placeholder: {
      unsupported: '暫時無法顯示這類訊息。',
      redacted: '此訊息已刪除。',
      undecryptableOldHistory: '這則舊訊息不在這台 iPhone 上。',
      undecryptable: '無法開啟這則訊息。'
    },
    photo: '照片',
    file: '檔案',
    noAnswer: '還沒有回覆。',
    composerPlaceholder: name => `傳訊息給 ${name}`,
    quoteUnavailable: '無法查看原訊息。',
    linkHeld: '這個連結暫時無法在 iPhone 上開啟。',
    incomingAnnouncement: (name, text) => `${name}：${text}`,
    home: {
      justNow: '剛剛',
      preview: {
        byline: (name, text) => `${name}：${text}`,
        photo: '📷 照片',
        video: '🎬 影片',
        audio: '🎵 音訊',
        file: '📎 檔案',
        fileNamed: name => `📎 ${name}`,
        sticker: '貼圖',
        waiting: '🔒 正在等待訊息',
        invite: '邀請你聊天'
      },
      declineInvite: '拒絕邀請',
      mentions: '提到了你',
      newMessages: '有新訊息',
      muted: '通知已關閉',
      pinned: '已置頂',
      emptyTitle: '你的助理會顯示在這裡',
      emptyBody: 'Atum 正在為你建立助理。準備就緒後，助理會顯示在這裡。'
    },
    info: {
      open: '查看詳細資訊',
      kindAssistant: '你的助理',
      memberCount: count => `${count} 位成員`,
      assistantAccessTitle: '你的助理可以讀取',
      assistantAccessPlain:
        '此聊天中的訊息（包括群組中其他人的訊息）即使在你的手機或電腦關機時也可能被讀取。模型提供者會處理內容，你的助理也可能會記住。你可以隨時讓這個聊天室不再讀取新訊息；這不會撤銷先前的讀取。',
      assistantAccessEncrypted: '只能讀取聊天室詳細資訊，不能讀取訊息內容。開啟保護不會撤銷先前的讀取。'
    },
    media: {
      photoNumber: n => `照片 ${n}`,
      removePhoto: n => `移除照片 ${n}`,
      previewHint: '預覽',
      openPhotoHint: '查看照片',
      openFileHint: '開啟檔案',
      share: '分享',
      cancelUpload: '停止傳送',
      uploadProgress: n => `已上傳 ${n}%`,
      loadFailed: '無法載入。輕點以重試。',
      originalFailed: '無法載入原始照片。',
      tooLargePhoto: '這張照片太大，無法傳送。',
      tooLargeFile: '這個檔案太大，無法傳送。請選擇較小的檔案。',
      tooLargeSome: n => `${n} 個檔案太大，無法加入。`,
      tooMany: n => `一次最多傳送 ${n} 張照片或檔案。`,
      unreadable: '無法開啟這個檔案。請換一個檔案試試。',
      kind: {
        pdf: 'PDF',
        document: '文件',
        spreadsheet: '試算表',
        presentation: '簡報',
        archive: '壓縮檔',
        video: '影片',
        audio: '音訊'
      }
    },
    appBot: {
      notice: {
        needs_setup: app => `${app} 尚未回覆，因為你還沒有開始。`,
        needs_intake: app => `${app} 需要你的出生日期、時間和地點才能回答。`,
        allowance_exhausted: app => `你已用完與 ${app} 的訊息額度。`,
        unverified_sender: app => `${app} 無法讀取這則訊息。請重新傳送。`,
        link_pending: app => `${app} 正在完成帳戶連結。請一分鐘後再傳送。`,
        busy: app => `${app} 仍在回覆你之前的訊息。請稍後再傳送。`,
        rate_limited: '你傳送得太快了。請等待幾分鐘後再傳送。',
        app_unavailable: app => `${app} 暫時無法使用。請稍後再試。`,
        app_timeout: app => `${app} 回覆時間過長，無法發佈到群組。`,
        outcome_unknown: app => `${app} 可能已收到這則訊息，但回答沒有送達這裡。這則訊息可能已被計入，Atum 正在核查。若一直沒有收到回答，請聯絡 support@atumplatform.com。`,
        missed_while_offline: app => `${app} 在你傳送時離線。請再傳送一次。`,
        sent_before_link: app => `${app} 現已連結到你的帳戶。這則訊息在連結前傳送。`,
        unsupported_content: app => `${app} 目前只能讀取文字訊息。`,
        message_too_long: app => `這則訊息太長，${app} 無法讀取。請拆分後再傳送。`,
        cannot_read: app => `${app} 無法讀取這則訊息。請更新 Atum 後再傳送。`,
        andy_group_declined: 'Andy 目前只支援一對一聊天。您可以在這裡私訊 Andy。',
        joined: app => `${app} 已加入群組。提及 @${app} 或回覆 ${app} 即可提問。${app} 只使用該訊息和您選擇引用的一則訊息。`,
        now_group: '這裡現在是群組。Moon 只會在被提及或收到回覆時回答，並且不會使用任何人的星盤或記憶。',
        andy_leaving: 'Andy 只支援一對一聊天，因此將離開這個聊天。你可以隨時私訊 Andy。'
      },
      onboarding: {
        consent: (app: string) => `${app} 會接收你的姓名和你在此對話中分享的內容，以便回覆你。`,
        connecting: (app: string) => `正在連結 ${app}…`,
        failure: (_app: string) => '尚未完成連結。',
        moonTermsURL: 'https://moon.atumplatform.com/chinh-sach/dieu-khoan-ai-va-du-lieu',
        andyTermsURL: 'https://andy.atumplatform.com/terms',
        birth: {
          preferredName: '稱呼',
          date: '出生日期',
          time: '出生時間',
          timeHelper: '大概時間也可以。',
          city: '出生城市',
          gender: '性別',
          genderMale: '男性',
          genderFemale: '女性'
        },
        readings: '解讀'
      },
      fillIn: '填寫資料',
      continueOnMac: {
        title: '在電腦上的 Atum 中繼續',
        setupBody: app => `先在電腦上的 ${app} 聊天中開始；之後可在這裡聊天。`,
        routeBody: app => `${app} 的這一部分會在你的電腦上開啟。`
      },
      gotIt: '知道了',
      roomFailed: app => `無法開啟你與 ${app} 的聊天。`
    }
  }
}

// Words the phone's Kit screens show that no exported table says yet (Atum Kit boards FlowPhone,
// FlowPhone2 and FlowPhone3, ). Where the desktop already says the
// word somewhere the export cannot read, the wording is copied exactly and its source is named.
// The keys the phone codes against are listed in packages/mobile-design-exports/phone-chat-keys.json.
const phoneScreensEn = {
  // The short label of the Team space tab in the phone's tab bar.
  teamTab: 'Team',
  store: {
    // The Store's first shelf, chosen from what the assistant has learned.
    pickedForYou: 'Picked for you',
    popularSkills: 'Popular skills',
    // An item's button: the amount comes formatted ("4,000").
    getFor: (amount: string) => `Get for ${amount} Protons`,
    // Over an item's example requests (store/store-copy.ts `trySaying`).
    trySaying: 'Try saying'
  },
  drive: {
    // Drive's first group: files the assistants made for you.
    madeForYou: 'Made for you',
    // Under a file card in a chat, once the file is in Drive.
    savedToDrive: 'Saved to Drive'
  },
  // The Team tab's summary of what happened since you last looked.
  whileYouWereAway: 'While you were away',
  attach: {
    // The attach sheet's buttons (the sheet also reads Files and Drive elsewhere).
    photos: 'Photos',
    website: 'Website'
  },
  model: {
    // Beside the suggested model in the model sheet (i18n `matrixShell.surfaces.modelRecommended`).
    suggested: 'Suggested',
    // The Thinking row's choice that keeps the model's own level (i18n `models.effortDefaultLabel`).
    modelDefault: 'Model default'
  },
  // First run in the chat: the card where the assistant asks for the phone's permissions once.
  helpOnTheGo: 'Let me help on the go',
  // The message menu's item that asks the assistant about a message.
  askAboutMessage: 'Ask Atum about this'
}

export const mobileScreensCopy: Record<Locale, typeof phoneScreensEn> = {
  en: phoneScreensEn,
  vi: {
    teamTab: 'Nhóm',
    store: {
      pickedForYou: 'Chọn cho bạn',
      popularSkills: 'Kỹ năng phổ biến',
      getFor: (amount: string) => `Nhận với ${amount} Proton`,
      trySaying: 'Thử nói'
    },
    drive: {
      madeForYou: 'Tạo cho bạn',
      savedToDrive: 'Đã lưu vào Drive'
    },
    whileYouWereAway: 'Trong lúc bạn vắng',
    attach: {
      photos: 'Ảnh',
      website: 'Trang web'
    },
    model: {
      suggested: 'Đề xuất',
      modelDefault: 'Mặc định'
    },
    helpOnTheGo: 'Để mình giúp bạn cả khi ra ngoài',
    askAboutMessage: 'Hỏi Atum về tin này'
  },
  ja: {
    teamTab: 'チーム',
    store: {
      pickedForYou: 'あなたへのおすすめ',
      popularSkills: '人気のスキル',
      getFor: (amount: string) => `${amount} Proton で入手`,
      trySaying: 'こんなふうに頼めます'
    },
    drive: {
      madeForYou: 'あなたのために作成',
      savedToDrive: 'Drive に保存しました'
    },
    whileYouWereAway: '不在のあいだに',
    attach: {
      photos: '写真',
      website: 'ウェブサイト'
    },
    model: {
      suggested: 'おすすめ',
      modelDefault: '既定'
    },
    helpOnTheGo: '外出先でもお手伝いします',
    askAboutMessage: 'このメッセージについて Atum に聞く'
  },
  zh: {
    teamTab: '团队',
    store: {
      pickedForYou: '为你精选',
      popularSkills: '热门技能',
      getFor: (amount: string) => `用 ${amount} Proton 获取`,
      trySaying: '试着这样说'
    },
    drive: {
      madeForYou: '为你制作',
      savedToDrive: '已保存到 Drive'
    },
    whileYouWereAway: '你不在时',
    attach: {
      photos: '照片',
      website: '网站'
    },
    model: {
      suggested: '推荐',
      modelDefault: '默认'
    },
    helpOnTheGo: '出门在外，我也能帮你',
    askAboutMessage: '向 Atum 询问此消息'
  },
  'zh-hant': {
    teamTab: '團隊',
    store: {
      pickedForYou: '為你精選',
      popularSkills: '熱門技能',
      getFor: (amount: string) => `用 ${amount} Proton 取得`,
      trySaying: '試著這樣說'
    },
    drive: {
      madeForYou: '為你製作',
      savedToDrive: '已儲存到 Drive'
    },
    whileYouWereAway: '你不在時',
    attach: {
      photos: '照片',
      website: '網站'
    },
    model: {
      suggested: '建議',
      modelDefault: '預設'
    },
    helpOnTheGo: '出門在外，我也能幫你',
    askAboutMessage: '詢問 Atum 關於此訊息'
  }
}

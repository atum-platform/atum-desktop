/**
 * Moon/Andy onboarding words shared by Desktop and the pinned phone export.
 *
 * The short row is the consent presentation for Moon disclosure 3 and Andy
 * disclosure 2.  The complete, versioned terms remain available beside it;
 * older disclosure versions keep their existing reader in setup-card.tsx.
 */

interface AppTermsCopy {
  firstContact: string
  consent: string
  termsTitle: string
  termsVersion: string
  terms: string[]
}

interface IntakeCopy {
  birthTimeHelp: string
  invalid: {
    preferred_name: string
    dob: string
    birth_time: string
    birth_city: string
    gender: string
    generic: string
  }
}

interface AppOnboardingCopy {
  moon: AppTermsCopy
  andy: AppTermsCopy
  termsLink: string
  start: string
  cancel: string
  close: string
  retry: string
  failed: string
  timedOut: string
  checking: string
  checkAgain: string
  waiting: (app: string) => string
  working: (app: string) => string
  slow: (app: string) => string
  notReady: (app: string) => string
  authTitle: (app: string) => string
  authGoogleHint: string
  intake: IntakeCopy
}

const en: AppOnboardingCopy = {
  moon: {
    firstContact:
      'Hi, I’m Moon — I read birth charts and astrology maps for you. Link your Moon account to get started.',
    consent: 'Moon will receive your name and the content you share in this conversation so it can answer you.',
    termsTitle: 'Moon terms in Atum',
    termsVersion: 'Disclosure version 3',
    terms: [
      'Moon runs on Atum’s servers and answers every message you send in this private chat.',
      'In a group, Moon answers only when you mention @moon_bot or reply to Moon. Atum passes Moon only the message you send it and one message you choose to quote.',
      'In this private chat, Moon remembers your conversation, including what you have told Moon elsewhere. In groups, Moon uses no one’s chart, memory, or profile.',
      'Atum loads earlier private messages from your linked Moon account when you open this chat. They are not added to your Atum chat history.',
      'Each question uses messages from your own Moon account and is paid in Moon, not with Protons. No one pays for you, and you never pay for anyone else.',
      'Moon’s answers go to every device signed in to your account, including devices you have not verified.',
      'You can stop using Moon at any time in Atum Settings.'
    ]
  },
  andy: {
    firstContact: 'Hi, I’m Andy — I’m here to listen. Link your Andy account to get started.',
    consent: 'Andy will receive your name and the content you share in this conversation so it can answer you.',
    termsTitle: 'Andy terms in Atum',
    termsVersion: 'Disclosure version 2',
    terms: [
      'Andy runs on Atum’s servers and answers every message you send in this private chat.',
      'Andy chats one-on-one only.',
      'Andy remembers your private chat to support you better.',
      'Atum does not add messages from outside this conversation to your Atum chat history.',
      'Each question uses messages from your own Andy account and is paid in Andy, not with Protons. No one pays for you, and you never pay for anyone else.',
      'Andy’s answers go to every device signed in to your account, including devices you have not verified.',
      'You can stop using Andy at any time in Atum Settings.'
    ]
  },
  termsLink: 'Terms',
  start: 'Start',
  cancel: 'Cancel',
  close: 'Close',
  retry: 'Try again',
  failed: 'That didn’t work.',
  timedOut: 'That took too long. Try again.',
  checking: 'Finishing setup…',
  checkAgain: 'Check again',
  waiting: app => `Sign in to ${app} in the Atum sheet.`,
  working: app => `Connecting to ${app}…`,
  slow: app => `${app} is still getting ready. Check again in a little while.`,
  notReady: app => `${app} isn’t ready yet. Try again, or check later.`,
  authTitle: app => `Connect ${app}`,
  authGoogleHint: 'Google sign-in opens in your browser and returns here automatically.',
  intake: {
    birthTimeHelp: 'An approximate time is okay.',
    invalid: {
      preferred_name: 'Enter the name you want Moon to use.',
      dob: 'Choose a valid birth date.',
      birth_time: 'Enter a birth time in 24-hour HH:MM format. An approximate time is okay.',
      birth_city: 'Enter a city and country Moon can find.',
      gender: 'Choose one of the available options.',
      generic: 'Check this field and try again.'
    }
  }
}

const vi: AppOnboardingCopy = {
  moon: {
    firstContact:
      'Chào bạn, mình là Moon — mình đọc lá số và bản đồ sao cho bạn. Liên kết tài khoản Moon để bắt đầu nhé.',
    consent: 'Moon sẽ nhận tên và nội dung bạn chia sẻ trong cuộc trò chuyện này để trả lời bạn.',
    termsTitle: 'Điều khoản Moon trong Atum',
    termsVersion: 'Phiên bản công bố 3',
    terms: [
      'Moon chạy trên máy chủ của Atum và trả lời mọi tin nhắn bạn gửi trong chat riêng này.',
      'Trong nhóm, Moon chỉ trả lời khi bạn nhắc @moon_bot hoặc trả lời tin của Moon. Atum chỉ chuyển cho Moon tin bạn gửi và một tin bạn chọn trích dẫn.',
      'Trong chat riêng, Moon nhớ cuộc trò chuyện của bạn, kể cả những gì bạn đã nói với Moon ở nơi khác. Trong nhóm, Moon không dùng lá số, ký ức hay hồ sơ của ai.',
      'Atum tải các tin nhắn riêng trước đây từ tài khoản Moon đã liên kết khi bạn mở cuộc trò chuyện này. Những tin này không được thêm vào lịch sử trò chuyện Atum của bạn.',
      'Mỗi câu hỏi dùng lượt nhắn trong tài khoản Moon của chính bạn và thanh toán trong Moon, không dùng Proton. Không ai trả thay bạn, và bạn không trả thay ai.',
      'Câu trả lời của Moon được gửi tới mọi thiết bị đăng nhập vào tài khoản của bạn, kể cả thiết bị bạn chưa xác minh.',
      'Bạn có thể dừng dùng Moon bất cứ lúc nào trong Cài đặt Atum.'
    ]
  },
  andy: {
    firstContact: 'Chào bạn, mình là Andy — mình ở đây để lắng nghe. Liên kết tài khoản Andy để bắt đầu nhé.',
    consent: 'Andy sẽ nhận tên và nội dung bạn chia sẻ trong cuộc trò chuyện này để trả lời bạn.',
    termsTitle: 'Điều khoản Andy trong Atum',
    termsVersion: 'Phiên bản công bố 2',
    terms: [
      'Andy chạy trên máy chủ của Atum và trả lời mọi tin nhắn bạn gửi trong chat riêng này.',
      'Andy chỉ trò chuyện riêng.',
      'Andy nhớ cuộc trò chuyện riêng với bạn để đồng hành tốt hơn.',
      'Atum không thêm tin nhắn bên ngoài cuộc trò chuyện này vào lịch sử trò chuyện Atum của bạn.',
      'Mỗi câu hỏi dùng lượt nhắn trong tài khoản Andy của chính bạn và thanh toán trong Andy, không dùng Proton. Không ai trả thay bạn, và bạn không trả thay ai.',
      'Câu trả lời của Andy được gửi tới mọi thiết bị đăng nhập vào tài khoản của bạn, kể cả thiết bị bạn chưa xác minh.',
      'Bạn có thể dừng dùng Andy bất cứ lúc nào trong Cài đặt Atum.'
    ]
  },
  termsLink: 'Điều khoản',
  start: 'Bắt đầu',
  cancel: 'Hủy',
  close: 'Đóng',
  retry: 'Thử lại',
  failed: 'Chưa kết nối được.',
  timedOut: 'Đã chờ quá lâu. Bạn thử lại nhé.',
  checking: 'Đang hoàn tất thiết lập…',
  checkAgain: 'Kiểm tra lại',
  waiting: app => `Đăng nhập ${app} trong cửa sổ Atum.`,
  working: app => `Đang kết nối với ${app}…`,
  slow: app => `${app} vẫn đang chuẩn bị. Bạn kiểm tra lại sau ít phút nhé.`,
  notReady: app => `${app} chưa sẵn sàng. Bạn thử lại hoặc kiểm tra sau nhé.`,
  authTitle: app => `Kết nối ${app}`,
  authGoogleHint: 'Đăng nhập Google sẽ mở trong trình duyệt và tự quay lại đây.',
  intake: {
    birthTimeHelp: 'Giờ gần đúng cũng được.',
    invalid: {
      preferred_name: 'Nhập tên bạn muốn Moon dùng để gọi bạn.',
      dob: 'Chọn ngày sinh hợp lệ.',
      birth_time: 'Nhập giờ sinh theo dạng HH:MM (24 giờ). Giờ gần đúng cũng được.',
      birth_city: 'Nhập rõ thành phố và quốc gia nơi bạn sinh.',
      gender: 'Chọn một trong các mục có sẵn.',
      generic: 'Kiểm tra lại thông tin này rồi thử lại.'
    }
  }
}

const ja: AppOnboardingCopy = {
  moon: {
    firstContact: 'こんにちは、Moonです。出生図や占星術チャートを読み解きます。Moonアカウントを連携して始めましょう。',
    consent: 'Moonは、あなたに回答するため、この会話で共有した名前と内容を受け取ります。',
    termsTitle: 'AtumでのMoon利用条件',
    termsVersion: '開示バージョン3',
    terms: [
      'MoonはAtumのサーバーで動作し、このプライベートチャットで送信したすべてのメッセージに回答します。',
      'グループでは、@moon_botへのメンションまたはMoonへの返信にだけ回答します。AtumがMoonに渡すのは、あなたが送ったメッセージと、あなたが選んだ引用1件だけです。',
      'このプライベートチャットでは、Moonは他の場所で伝えたことを含め、あなたとの会話を覚えています。グループでは誰のチャート、記憶、プロフィールも使いません。',
      'このチャットを開くと、Atumは連携したMoonアカウントから以前のプライベートメッセージを読み込みます。Atumのチャット履歴には追加されません。',
      '各質問はあなた自身のMoonアカウントのメッセージを使い、ProtonではなくMoonで支払われます。誰もあなたの代わりに支払わず、あなたも他の人の代わりに支払いません。',
      'Moonの回答は、未確認の端末を含め、あなたのアカウントにサインインしているすべての端末に届きます。',
      'Atum設定からいつでもMoonの利用を停止できます。'
    ]
  },
  andy: {
    firstContact: 'こんにちは、Andyです。あなたの話を聞くためにここにいます。Andyアカウントを連携して始めましょう。',
    consent: 'Andyは、あなたに回答するため、この会話で共有した名前と内容を受け取ります。',
    termsTitle: 'AtumでのAndy利用条件',
    termsVersion: '開示バージョン2',
    terms: [
      'AndyはAtumのサーバーで動作し、このプライベートチャットで送信したすべてのメッセージに回答します。',
      'Andyは1対1のチャットのみ対応しています。',
      'Andyはより良く寄り添うため、あなたとのプライベートチャットを覚えています。',
      'Atumは、この会話の外にあるメッセージをAtumのチャット履歴へ追加しません。',
      '各質問はあなた自身のAndyアカウントのメッセージを使い、ProtonではなくAndyで支払われます。誰もあなたの代わりに支払わず、あなたも他の人の代わりに支払いません。',
      'Andyの回答は、未確認の端末を含め、あなたのアカウントにサインインしているすべての端末に届きます。',
      'Atum設定からいつでもAndyの利用を停止できます。'
    ]
  },
  termsLink: '利用条件',
  start: '始める',
  cancel: 'キャンセル',
  close: '閉じる',
  retry: '再試行',
  failed: '接続できませんでした。',
  timedOut: '時間がかかりすぎました。もう一度お試しください。',
  checking: '設定を完了しています…',
  checkAgain: '再確認',
  waiting: app => `Atumのシートで${app}にサインインしてください。`,
  working: app => `${app}に接続しています…`,
  slow: app => `${app}はまだ準備中です。しばらくしてから再確認してください。`,
  notReady: app => `${app}はまだ準備ができていません。再試行するか、後で確認してください。`,
  authTitle: app => `${app}を連携`,
  authGoogleHint: 'Googleへのサインインはブラウザで開き、完了後に自動で戻ります。',
  intake: {
    birthTimeHelp: 'おおよその時刻でも構いません。',
    invalid: {
      preferred_name: 'Moonに呼んでほしい名前を入力してください。',
      dob: '有効な生年月日を選択してください。',
      birth_time: '出生時刻を24時間表記のHH:MMで入力してください。おおよその時刻でも構いません。',
      birth_city: '都市名と国名を入力してください。',
      gender: '表示されている選択肢から選んでください。',
      generic: 'この項目を確認して、もう一度お試しください。'
    }
  }
}

const zh: AppOnboardingCopy = {
  moon: {
    firstContact: '你好，我是 Moon——我会为你解读命盘和星盘。关联 Moon 账户即可开始。',
    consent: 'Moon 会接收你的姓名和你在此对话中分享的内容，以便回复你。',
    termsTitle: 'Moon 在 Atum 中的条款',
    termsVersion: '披露版本 3',
    terms: [
      'Moon 在 Atum 的服务器上运行，并会回复你在这段私聊中发送的每条消息。',
      '在群组中，Moon 只会在你提及 @moon_bot 或回复 Moon 时回答。Atum 只会把你发送的消息及你选择引用的一条消息传给 Moon。',
      '在这段私聊中，Moon 会记住你的对话，包括你在其他地方告诉 Moon 的内容。在群组中，Moon 不使用任何人的星盘、记忆或个人资料。',
      '打开此聊天时，Atum 会从已关联的 Moon 账户加载过去的私聊消息。这些消息不会添加到你的 Atum 聊天记录。',
      '每个问题都会使用你自己的 Moon 账户中的消息额度，并在 Moon 中付费，不使用 Proton。没有人替你付费，你也不会替其他人付费。',
      'Moon 的回答会发送到所有登录你账户的设备，包括你尚未验证的设备。',
      '你可以随时在 Atum 设置中停止使用 Moon。'
    ]
  },
  andy: {
    firstContact: '你好，我是 Andy——我会在这里倾听。关联 Andy 账户即可开始。',
    consent: 'Andy 会接收你的姓名和你在此对话中分享的内容，以便回复你。',
    termsTitle: 'Andy 在 Atum 中的条款',
    termsVersion: '披露版本 2',
    terms: [
      'Andy 在 Atum 的服务器上运行，并会回复你在这段私聊中发送的每条消息。',
      'Andy 目前仅支持一对一聊天。',
      'Andy 会记住与你的私聊，以便更好地陪伴你。',
      'Atum 不会把此对话之外的消息添加到你的 Atum 聊天记录。',
      '每个问题都会使用你自己的 Andy 账户中的消息额度，并在 Andy 中付费，不使用 Proton。没有人替你付费，你也不会替其他人付费。',
      'Andy 的回答会发送到所有登录你账户的设备，包括你尚未验证的设备。',
      '你可以随时在 Atum 设置中停止使用 Andy。'
    ]
  },
  termsLink: '条款',
  start: '开始',
  cancel: '取消',
  close: '关闭',
  retry: '重试',
  failed: '连接未完成。',
  timedOut: '等待时间过长，请重试。',
  checking: '正在完成设置…',
  checkAgain: '再次检查',
  waiting: app => `请在 Atum 窗口中登录 ${app}。`,
  working: app => `正在连接 ${app}…`,
  slow: app => `${app} 仍在准备中，请稍后再检查。`,
  notReady: app => `${app} 还没准备好。请重试或稍后检查。`,
  authTitle: app => `连接 ${app}`,
  authGoogleHint: 'Google 登录会在浏览器中打开，完成后会自动返回这里。',
  intake: {
    birthTimeHelp: '大概时间也可以。',
    invalid: {
      preferred_name: '请输入希望 Moon 称呼你的名字。',
      dob: '请选择有效的出生日期。',
      birth_time: '请按 24 小时制 HH:MM 输入出生时间。大概时间也可以。',
      birth_city: '请输入可识别的出生城市和国家。',
      gender: '请从可用选项中选择一项。',
      generic: '请检查此项后重试。'
    }
  }
}

const hant: AppOnboardingCopy = {
  moon: {
    firstContact: '你好，我是 Moon——我會為你解讀命盤和星盤。連結 Moon 帳戶即可開始。',
    consent: 'Moon 會接收你的姓名和你在此對話中分享的內容，以便回覆你。',
    termsTitle: 'Moon 在 Atum 中的條款',
    termsVersion: '揭露版本 3',
    terms: [
      'Moon 在 Atum 的伺服器上執行，並會回覆你在這段私人聊天中傳送的每則訊息。',
      '在群組中，Moon 只會在你提及 @moon_bot 或回覆 Moon 時回答。Atum 只會把你傳送的訊息及你選擇引用的一則訊息傳給 Moon。',
      '在這段私人聊天中，Moon 會記住你的對話，包括你在其他地方告訴 Moon 的內容。在群組中，Moon 不使用任何人的星盤、記憶或個人資料。',
      '開啟此聊天時，Atum 會從已連結的 Moon 帳戶載入過去的私人訊息。這些訊息不會加入你的 Atum 聊天記錄。',
      '每個問題都會使用你自己的 Moon 帳戶中的訊息額度，並在 Moon 中付費，不使用 Proton。沒有人替你付費，你也不會替其他人付費。',
      'Moon 的回答會傳送到所有登入你帳戶的裝置，包括你尚未驗證的裝置。',
      '你可以隨時在 Atum 設定中停止使用 Moon。'
    ]
  },
  andy: {
    firstContact: '你好，我是 Andy——我會在這裡傾聽。連結 Andy 帳戶即可開始。',
    consent: 'Andy 會接收你的姓名和你在此對話中分享的內容，以便回覆你。',
    termsTitle: 'Andy 在 Atum 中的條款',
    termsVersion: '揭露版本 2',
    terms: [
      'Andy 在 Atum 的伺服器上執行，並會回覆你在這段私人聊天中傳送的每則訊息。',
      'Andy 目前只支援一對一聊天。',
      'Andy 會記住與你的私人聊天，以便更好地陪伴你。',
      'Atum 不會把此對話之外的訊息加入你的 Atum 聊天記錄。',
      '每個問題都會使用你自己的 Andy 帳戶中的訊息額度，並在 Andy 中付費，不使用 Proton。沒有人替你付費，你也不會替其他人付費。',
      'Andy 的回答會傳送到所有登入你帳戶的裝置，包括你尚未驗證的裝置。',
      '你可以隨時在 Atum 設定中停止使用 Andy。'
    ]
  },
  termsLink: '條款',
  start: '開始',
  cancel: '取消',
  close: '關閉',
  retry: '再試一次',
  failed: '尚未完成連結。',
  timedOut: '等待時間過長，請再試一次。',
  checking: '正在完成設定…',
  checkAgain: '再次檢查',
  waiting: app => `請在 Atum 視窗中登入 ${app}。`,
  working: app => `正在連結 ${app}…`,
  slow: app => `${app} 仍在準備中，請稍後再檢查。`,
  notReady: app => `${app} 還沒準備好。請再試一次或稍後檢查。`,
  authTitle: app => `連結 ${app}`,
  authGoogleHint: 'Google 登入會在瀏覽器中開啟，完成後會自動返回這裡。',
  intake: {
    birthTimeHelp: '大概時間也可以。',
    invalid: {
      preferred_name: '請輸入希望 Moon 稱呼你的名字。',
      dob: '請選擇有效的出生日期。',
      birth_time: '請按 24 小時制 HH:MM 輸入出生時間。大概時間也可以。',
      birth_city: '請輸入可辨識的出生城市和國家。',
      gender: '請從可用選項中選擇一項。',
      generic: '請檢查此欄位後再試一次。'
    }
  }
}

export const matrixAppOnboardingCopy = { en, vi, ja, zh, 'zh-hant': hant }

export function appOnboardingCopy(locale?: string): AppOnboardingCopy {
  return typeof locale === 'string' && Object.hasOwn(matrixAppOnboardingCopy, locale)
    ? matrixAppOnboardingCopy[locale as keyof typeof matrixAppOnboardingCopy]
    : en
}

function isAppTerms(value: unknown): value is AppTermsCopy {
  if (!value || typeof value !== 'object') {
    return false
  }

  const terms = value as Record<string, unknown>

  return (
    typeof terms.firstContact === 'string' &&
    typeof terms.consent === 'string' &&
    typeof terms.termsTitle === 'string' &&
    typeof terms.termsVersion === 'string' &&
    Array.isArray(terms.terms) &&
    terms.terms.every(term => typeof term === 'string')
  )
}

/**
 * The terms an app declares under its own slug for this locale. A slug with no
 * declared terms returns null, so an app this client has no code for shows the
 * shared disclosure and never another app's words.
 */
export function appOnboardingTerms(locale: string | undefined, app: string): AppTermsCopy | null {
  const copy: unknown = (appOnboardingCopy(locale) as unknown as Record<string, unknown>)[app]

  return isAppTerms(copy) ? copy : null
}

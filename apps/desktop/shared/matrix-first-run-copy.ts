import type { DesktopLocale } from './desktop-locale'

export interface MatrixFirstRunCopy {
  gettingReady: string
  greeting(firstName: string | undefined, assistantName: string): string
  intro: string
  connectCard: {
    title: string
    line: string
    google: string
    googleRead: string
    googleDetail: string
    messagesSafari: string
    messagesSafariRead: string
    messagesSafariDetail: string
    notNow: string
    continue: string
    loading: string
    done: string
    working: string
    notAllowed: string
    unavailable: string
    openSettings: string
    restart: string
    restartHelp: string
    failed: string
  }
  folderAccess: {
    denied: string
    openSettings: string
  }
}

const copies: Record<DesktopLocale, MatrixFirstRunCopy> = {
  en: {
    gettingReady: 'Getting Atum ready',
    greeting: (firstName, assistantName) =>
      firstName
        ? `Hi ${firstName}, I’m ${assistantName}. You can rename me anytime, just tell me what you’d like to call me.`
        : `Hi, I’m ${assistantName}. You can rename me anytime, just tell me what you’d like to call me.`,
    intro: 'To be useful from the start, I’d like to get to know your work.',
    connectCard: {
      title: 'Let me get to know your world',
      line: 'I work from the cloud and read these from your Mac. Uncheck any to keep them private.',
      google: 'Google',
      googleRead: 'Gmail, Calendar and Drive you share.',
      googleDetail: 'Atum reads shared mail, events and Drive files. Sending or changing anything still asks you first.',
      messagesSafari: 'Messages and Safari',
      messagesSafariRead: 'Who you message, recent themes, and Safari titles and domains.',
      messagesSafariDetail: 'Atum reads who you talk to, when and recent text only to learn themes; Safari provides titles, domains and visit counts. It never quotes messages or keeps full URLs.',
      notNow: 'Not now',
      continue: 'Continue',
      loading: 'Checking what is available…',
      done: 'Done',
      working: 'Opening…',
      notAllowed: 'Not allowed',
      unavailable: 'Not available',
      openSettings: 'Open Settings',
      restart: 'Restart Atum',
      restartHelp: 'Restart Atum to finish. macOS may apply this switch on the next launch.',
      failed: 'Couldn’t finish that. You can try again or choose Not now.'
    },
    folderAccess: {
      denied: 'macOS kept those folders closed.',
      openSettings: 'Open System Settings'
    }
  },
  vi: {
    gettingReady: 'Đang chuẩn bị Atum',
    greeting: (firstName, assistantName) =>
      firstName
        ? `Chào ${firstName}, mình là ${assistantName}. Bạn có thể đổi tên mình bất cứ lúc nào, chỉ cần nói tên bạn muốn gọi.`
        : `Chào bạn, mình là ${assistantName}. Bạn có thể đổi tên mình bất cứ lúc nào, chỉ cần nói tên bạn muốn gọi.`,
    intro: 'Để hữu ích ngay từ đầu, mình muốn tìm hiểu công việc của bạn.',
    connectCard: {
      title: 'Để mình hiểu thế giới của bạn',
      line: 'Mình làm việc trên đám mây và đọc các mục này từ máy Mac. Bỏ chọn mục bạn muốn giữ riêng.',
      google: 'Google',
      googleRead: 'Gmail, Lịch và Drive bạn chia sẻ.',
      googleDetail: 'Atum đọc thư, sự kiện và tệp Drive được chia sẻ. Mọi thao tác gửi hay thay đổi vẫn hỏi bạn trước.',
      messagesSafari: 'Tin nhắn và Safari',
      messagesSafariRead: 'Người bạn nhắn, chủ đề gần đây, tiêu đề và tên miền Safari.',
      messagesSafariDetail: 'Atum đọc bạn nói chuyện với ai, lúc nào và nội dung gần đây chỉ để tìm chủ đề; Safari cung cấp tiêu đề, tên miền và lượt truy cập. Atum không trích dẫn tin nhắn hay lưu URL đầy đủ.',
      notNow: 'Để sau',
      continue: 'Tiếp tục',
      loading: 'Đang kiểm tra các nguồn khả dụng…',
      done: 'Xong',
      working: 'Đang mở…',
      notAllowed: 'Chưa cho phép',
      unavailable: 'Chưa dùng được',
      openSettings: 'Mở Cài đặt',
      restart: 'Mở lại Atum',
      restartHelp: 'Mở lại Atum để hoàn tất. macOS có thể áp dụng công tắc này ở lần mở tiếp theo.',
      failed: 'Chưa hoàn tất được. Bạn có thể thử lại hoặc chọn Để sau.'
    },
    folderAccess: {
      denied: 'macOS chưa cho mở các thư mục đó.',
      openSettings: 'Mở Cài đặt hệ thống'
    }
  },
  ja: {
    gettingReady: 'Atum を準備しています',
    greeting: (firstName, assistantName) =>
      firstName
        ? `${firstName}さん、こんにちは。${assistantName}です。いつでも好きな名前に変えられるので、呼びたい名前を教えてください。`
        : `こんにちは。${assistantName}です。いつでも好きな名前に変えられるので、呼びたい名前を教えてください。`,
    intro: '最初から役に立てるように、あなたの仕事について知りたいです。',
    connectCard: {
      title: 'あなたの世界を教えてください',
      line: 'クラウドから作業し、これらをあなたの Mac から読み取ります。共有したくない項目はチェックを外してください。',
      google: 'Google',
      googleRead: '共有した Gmail、カレンダー、Drive。',
      googleDetail: 'Atum は共有されたメール、予定、Drive ファイルを読みます。送信や変更の前には必ず確認します。',
      messagesSafari: 'メッセージと Safari',
      messagesSafariRead: '相手、最近の話題、Safari のタイトルとドメイン。',
      messagesSafariDetail: 'Atum は相手、時刻、最近の文面から話題だけを学び、Safari のタイトル、ドメイン、訪問回数を読みます。メッセージを引用せず、完全な URL を保存しません。',
      notNow: '後で',
      continue: '続ける',
      loading: '利用できる情報源を確認しています…',
      done: '完了',
      working: '開いています…',
      notAllowed: '未許可',
      unavailable: '利用できません',
      openSettings: '設定を開く',
      restart: 'Atum を再起動',
      restartHelp: '完了するには Atum を再起動してください。macOS が次回起動時に反映することがあります。',
      failed: '完了できませんでした。もう一度試すか、「後で」を選べます。'
    },
    folderAccess: {
      denied: 'macOS でこれらのフォルダが閉じられています。',
      openSettings: 'システム設定を開く'
    }
  },
  zh: {
    gettingReady: '正在准备 Atum',
    greeting: (firstName, assistantName) =>
      firstName
        ? `${firstName}，你好，我是 ${assistantName}。你随时都可以给我改名，只要告诉我想怎么称呼我。`
        : `你好，我是 ${assistantName}。你随时都可以给我改名，只要告诉我想怎么称呼我。`,
    intro: '为了从一开始就帮上忙，我想先了解你的工作。',
    connectCard: {
      title: '让我了解你的世界',
      line: '我在云端工作，会从你的 Mac 读取这些内容。取消勾选即可保持私密。',
      google: 'Google',
      googleRead: '你共享的 Gmail、日历和云端硬盘。',
      googleDetail: 'Atum 会读取共享的邮件、日程和云端硬盘文件。发送或更改内容前仍会先征求你的确认。',
      messagesSafari: '信息与 Safari',
      messagesSafariRead: '联系人、近期主题，以及 Safari 标题和域名。',
      messagesSafariDetail: 'Atum 读取联系对象、时间和近期文本，只用于了解主题；Safari 提供标题、域名和访问次数。Atum 不引用信息，也不保留完整网址。',
      notNow: '以后再说',
      continue: '继续',
      loading: '正在检查可用来源…',
      done: '完成',
      working: '正在打开…',
      notAllowed: '未允许',
      unavailable: '不可用',
      openSettings: '打开设置',
      restart: '重新启动 Atum',
      restartHelp: '重新启动 Atum 以完成设置。macOS 可能会在下次启动时应用此开关。',
      failed: '未能完成。你可以重试或选择“以后再说”。'
    },
    folderAccess: {
      denied: 'macOS 尚未开放这些文件夹。',
      openSettings: '打开系统设置'
    }
  },
  'zh-hant': {
    gettingReady: '正在準備 Atum',
    greeting: (firstName, assistantName) =>
      firstName
        ? `${firstName}，你好，我是 ${assistantName}。你隨時都可以幫我改名，只要告訴我想怎麼稱呼我。`
        : `你好，我是 ${assistantName}。你隨時都可以幫我改名，只要告訴我想怎麼稱呼我。`,
    intro: '為了從一開始就幫上忙，我想先了解你的工作。',
    connectCard: {
      title: '讓我了解你的世界',
      line: '我在雲端工作，會從你的 Mac 讀取這些內容。取消勾選即可保持私密。',
      google: 'Google',
      googleRead: '你分享的 Gmail、行事曆和雲端硬碟。',
      googleDetail: 'Atum 會讀取分享的郵件、行程和雲端硬碟檔案。傳送或更改內容前仍會先徵求你的確認。',
      messagesSafari: '訊息與 Safari',
      messagesSafariRead: '聯絡對象、近期主題，以及 Safari 標題和網域。',
      messagesSafariDetail: 'Atum 讀取聯絡對象、時間和近期文字，只用來了解主題；Safari 提供標題、網域和瀏覽次數。Atum 不引用訊息，也不保留完整網址。',
      notNow: '稍後再說',
      continue: '繼續',
      loading: '正在檢查可用來源…',
      done: '完成',
      working: '正在開啟…',
      notAllowed: '未允許',
      unavailable: '無法使用',
      openSettings: '打開設定',
      restart: '重新啟動 Atum',
      restartHelp: '重新啟動 Atum 以完成設定。macOS 可能會在下次啟動時套用此開關。',
      failed: '未能完成。你可以再試一次或選擇「稍後再說」。'
    },
    folderAccess: {
      denied: 'macOS 尚未開放這些資料夾。',
      openSettings: '打開系統設定'
    }
  }
}

export function matrixFirstRunCopy(locale: DesktopLocale): MatrixFirstRunCopy {
  return copies[locale]
}

/** A short profile name for the greeting, never an address or a whole biography. */
export function matrixFirstRunName(displayName: string | undefined): string | undefined {
  const name = displayName?.trim()

  return name && !name.startsWith('@') && [...name].length <= 24 ? name : undefined
}

import type { Locale } from '@/i18n'

import type { MatrixCheckInAction, MatrixCheckInSource } from '../../shared/matrix-check-ins'

/**
 * Check-ins' words (plan  §2), in every
 * language Atum speaks. Product copy calls the heartbeat "check-ins" ("Nhắc nhở" in
 * Vietnamese); the cost is always said in Protons.
 */
export interface MatrixCheckInsCopy {
  /** The main assistant's card › Check-ins: the row's name and its one line. */
  title: string
  help: string
  brief: string
  briefOff: string
  /** "≈ 40 Protons a day, at most 1,060". */
  cost: (perDay: string, atMost: string) => string
  /** The person brought their own model: check-ins use it and its provider may charge. */
  ownModel: string
  failed: string
  readonly: string
  /** A nudge's one offer, its button. */
  actions: Record<MatrixCheckInAction, string>
  /** What a tap sends to the assistant, as the owner's own message. */
  request: Record<MatrixCheckInAction, (text: string) => string>
  sources: Record<MatrixCheckInSource, string>
  cardLabel: string
  less: string
  lessDone: string
  snooze: string
  snoozed: (time: string) => string
  /** After unanswered nudges: paused, and asking. */
  askTitle: string
  askHelp: string
  askKeep: string
  askOff: string
  /** The one-line first-run mention, with the brief's time (or none); the cost follows
   * on its own line (`cost`). */
  intro: (time: string | null) => string
  introChange: string
  introOff: string
  introDismiss: string
  /** After "stop checking in". */
  offNotice: string
  turnOn: string
}

export const matrixCheckInsCopy: Record<Locale, MatrixCheckInsCopy> = {
  en: {
    title: 'Check-ins',
    help: 'A short brief each morning, and a nudge only when something needs you. Your assistant only reads; it never acts for you.',
    brief: 'Morning brief',
    briefOff: 'Off',
    cost: (perDay, atMost) => `≈ ${perDay} Protons a day, at most ${atMost}`,
    ownModel: 'Uses your connected model. Provider charges may apply.',
    failed: 'Could not save this setting. Try again.',
    readonly: 'This setting needs a newer Atum version.',
    actions: { draft: 'Draft it', prepare: 'Prepare', review: 'Take a look' },
    request: {
      draft: text => `Draft this for me: ${text}`,
      prepare: text => `Help me prepare: ${text}`,
      review: text => `Take a look with me: ${text}`
    },
    sources: { files: 'Files', memory: 'Memory', calendar: 'Calendar', mail: 'Gmail' },
    cardLabel: 'A check-in from your assistant',
    less: 'Less like this',
    lessDone: 'Got it, fewer like this.',
    snooze: 'Snooze',
    snoozed: time => `I'll bring this back at ${time}.`,
    askTitle: 'Keep these coming?',
    askHelp: "You haven't answered the last few check-ins, so they're paused.",
    askKeep: 'Keep them coming',
    askOff: 'Turn off',
    intro: time =>
      `${time ? `Each morning at ${time} I'll send a short brief, and I'll` : "I'll"} nudge you only when something needs you.`,
    introChange: 'Change',
    introOff: 'Turn off',
    introDismiss: 'Got it',
    offNotice: 'Check-ins are off.',
    turnOn: 'Turn back on'
  },
  vi: {
    title: 'Nhắc nhở',
    help: 'Mỗi sáng một bản tóm tắt ngắn, và chỉ nhắc khi có việc cần bạn. Trợ lý chỉ đọc, không bao giờ tự làm thay bạn.',
    brief: 'Tóm tắt buổi sáng',
    briefOff: 'Tắt',
    cost: (perDay, atMost) => `≈ ${perDay} Proton/ngày, tối đa ${atMost}`,
    ownModel: 'Dùng mô hình bạn đã kết nối. Nhà cung cấp có thể tính phí.',
    failed: 'Chưa lưu được thiết lập. Hãy thử lại.',
    readonly: 'Thiết lập này cần phiên bản Atum mới hơn.',
    actions: { draft: 'Soạn', prepare: 'Chuẩn bị', review: 'Xem' },
    request: {
      draft: text => `Soạn giúp mình: ${text}`,
      prepare: text => `Giúp mình chuẩn bị: ${text}`,
      review: text => `Xem giúp mình: ${text}`
    },
    sources: { files: 'Tệp', memory: 'Ghi nhớ', calendar: 'Lịch', mail: 'Gmail' },
    cardLabel: 'Trợ lý nhắc bạn',
    less: 'Bớt kiểu này',
    lessDone: 'Đã hiểu, mình sẽ bớt kiểu này.',
    snooze: 'Nhắc sau',
    snoozed: time => `Mình sẽ nhắc lại lúc ${time}.`,
    askTitle: 'Vẫn gửi chứ?',
    askHelp: 'Mấy lần nhắc gần đây chưa được trả lời, nên mình tạm dừng.',
    askKeep: 'Vẫn gửi',
    askOff: 'Tắt nhắc nhở',
    intro: time =>
      `${time ? `Mỗi sáng ${time} mình gửi bản tóm tắt ngắn, và chỉ` : 'Mình chỉ'} nhắc khi có việc cần bạn.`,
    introChange: 'Đổi giờ',
    introOff: 'Tắt',
    introDismiss: 'Đã hiểu',
    offNotice: 'Đã tắt nhắc nhở.',
    turnOn: 'Bật lại'
  },
  ja: {
    title: 'チェックイン',
    help: '毎朝短いまとめを送り、対応が必要なときだけお知らせします。アシスタントは読むだけで、代わりに何かを実行することはありません。',
    brief: '朝のまとめ',
    briefOff: 'オフ',
    cost: (perDay, atMost) => `1日あたり約 ${perDay} Protons（最大 ${atMost}）`,
    ownModel: '接続したモデルを使用します。プロバイダー料金がかかる場合があります。',
    failed: '設定を保存できませんでした。もう一度お試しください。',
    readonly: 'この設定には新しい Atum が必要です。',
    actions: { draft: '下書きする', prepare: '準備する', review: '確認する' },
    request: {
      draft: text => `これの下書きをお願い: ${text}`,
      prepare: text => `これの準備を手伝って: ${text}`,
      review: text => `これを一緒に確認して: ${text}`
    },
    sources: { files: 'ファイル', memory: 'メモリー', calendar: 'カレンダー', mail: 'Gmail' },
    cardLabel: 'アシスタントからのチェックイン',
    less: 'このような通知を減らす',
    lessDone: '了解しました。このような通知を減らします。',
    snooze: 'あとで',
    snoozed: time => `${time} にもう一度お知らせします。`,
    askTitle: 'このまま続けますか？',
    askHelp: '最近のチェックインに返信がなかったため、一時停止しています。',
    askKeep: '続ける',
    askOff: 'オフにする',
    intro: time => `${time ? `毎朝 ${time} に短いまとめを送り、` : ''}対応が必要なときだけお知らせします。`,
    introChange: '変更',
    introOff: 'オフ',
    introDismiss: 'OK',
    offNotice: 'チェックインをオフにしました。',
    turnOn: 'オンに戻す'
  },
  zh: {
    title: '主动提醒',
    help: '每天早上一份简短摘要，只在有事需要你时才提醒。助理只读取信息，绝不代你操作。',
    brief: '早间摘要',
    briefOff: '关闭',
    cost: (perDay, atMost) => `每天约 ${perDay} Protons，最多 ${atMost}`,
    ownModel: '使用你连接的模型。提供商可能会收费。',
    failed: '无法保存此设置，请重试。',
    readonly: '此设置需要更新版本的 Atum。',
    actions: { draft: '起草', prepare: '准备', review: '看看' },
    request: {
      draft: text => `帮我起草：${text}`,
      prepare: text => `帮我准备：${text}`,
      review: text => `帮我看看：${text}`
    },
    sources: { files: '文件', memory: '记忆', calendar: '日历', mail: 'Gmail' },
    cardLabel: '来自助理的提醒',
    less: '少来这类',
    lessDone: '好的，以后少提醒这类。',
    snooze: '稍后提醒',
    snoozed: time => `${time} 再提醒你。`,
    askTitle: '还要继续吗？',
    askHelp: '最近几次提醒都没有回复，所以先暂停了。',
    askKeep: '继续',
    askOff: '关闭提醒',
    intro: time => `${time ? `每天早上 ${time} 我会发一份简短摘要，` : ''}只在有事需要你时才提醒。`,
    introChange: '更改',
    introOff: '关闭',
    introDismiss: '知道了',
    offNotice: '已关闭主动提醒。',
    turnOn: '重新开启'
  },
  'zh-hant': {
    title: '主動提醒',
    help: '每天早上一份簡短摘要，只在有事需要你時才提醒。助理只讀取資訊，絕不代你操作。',
    brief: '早間摘要',
    briefOff: '關閉',
    cost: (perDay, atMost) => `每天約 ${perDay} Protons，最多 ${atMost}`,
    ownModel: '使用你連接的模型。供應商可能會收費。',
    failed: '無法儲存此設定，請重試。',
    readonly: '此設定需要更新版本的 Atum。',
    actions: { draft: '起草', prepare: '準備', review: '看看' },
    request: {
      draft: text => `幫我起草：${text}`,
      prepare: text => `幫我準備：${text}`,
      review: text => `幫我看看：${text}`
    },
    sources: { files: '檔案', memory: '記憶', calendar: '日曆', mail: 'Gmail' },
    cardLabel: '來自助理的提醒',
    less: '少來這類',
    lessDone: '好的，以後少提醒這類。',
    snooze: '稍後提醒',
    snoozed: time => `${time} 再提醒你。`,
    askTitle: '還要繼續嗎？',
    askHelp: '最近幾次提醒都沒有回覆，所以先暫停了。',
    askKeep: '繼續',
    askOff: '關閉提醒',
    intro: time => `${time ? `每天早上 ${time} 我會傳一份簡短摘要，` : ''}只在有事需要你時才提醒。`,
    introChange: '更改',
    introOff: '關閉',
    introDismiss: '知道了',
    offNotice: '已關閉主動提醒。',
    turnOn: '重新開啟'
  }
}

/** A time of day the way the person's language writes it: "8:00 AM" in English, "8:00"
 * elsewhere (the sentences around it already say "morning"). */
export function matrixCheckInClock(value: number | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale.startsWith('en')
  }).format(value)
}

/** A brief time ("08:00"), written as `matrixCheckInClock` writes it. */
export function matrixCheckInTime(value: string, locale: string): string {
  const [hours, minutes] = value.split(':').map(Number)

  return matrixCheckInClock(new Date(2000, 0, 1, hours, minutes), locale)
}

/** A whole number of Protons, written the person's way. */
export function matrixCheckInProtons(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

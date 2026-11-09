import { type Locale, useI18n } from '@/i18n'

/**
 * The Founder chat's words (plan 
 * §5.5) and the verification marks' labels. The name "Founder" is the account's name and is
 * never translated; the subtitle is. The intro is the owner's own text in English and
 * Vietnamese, word for word. Nothing here names a person, shows a personal address or says
 * "Matrix": the one address offered is Atum's support mailbox.
 */
const en = {
  /** The account's name, in every language. */
  name: 'Founder',
  subtitle: 'Atum founder',
  /** The owner's words (2026-09-29), drawn by the app in the empty chat: not a message. */
  intro: 'Questions, ideas or problems? Message me here. I usually reply within a day.',
  /** The profile sheet's promise. */
  replyPromise: 'Usually replies within a day',
  /** The marks' labels: a filled check is run by Atum, a hollow one is verified by Atum. */
  officialAccount: 'Official Atum account',
  officialApp: 'Official Atum app',
  verified: 'Verified',
  /** The one line under the profile on what the filled mark means. */
  legendOfficial: 'Run by Atum',
  /** Settings › Account. */
  contactTitle: 'Contact us',
  emailSupport: 'Email support',
  emailSubject: 'Atum support',
  contactUnavailable: "Founder can't be reached right now. You can email us instead.",
  /** A send that would reach no device: on the person's side, then on the founder's. */
  unready: "Founder can't receive messages yet. Nothing was sent; try again in a little while.",
  recipientUnready: "This person can't receive your reply yet. Nothing was sent.",
  viewProfile: 'View profile',
  message: 'Message',
  close: 'Close'
}

export type FounderCopy = typeof en

export const FOUNDER_COPY: Record<Locale, FounderCopy> = {
  en,
  vi: {
    name: 'Founder',
    subtitle: 'Nhà sáng lập Atum',
    intro: 'Có câu hỏi, ý tưởng hay gặp sự cố? Nhắn cho tôi ở đây. Tôi thường trả lời trong vòng một ngày.',
    replyPromise: 'Thường trả lời trong vòng một ngày',
    officialAccount: 'Tài khoản chính thức của Atum',
    officialApp: 'Ứng dụng chính thức của Atum',
    verified: 'Đã xác minh',
    legendOfficial: 'Do Atum vận hành',
    contactTitle: 'Liên hệ',
    emailSupport: 'Gửi email hỗ trợ',
    emailSubject: 'Hỗ trợ Atum',
    contactUnavailable: 'Hiện chưa liên lạc được với Founder. Bạn có thể gửi email cho chúng tôi.',
    unready: 'Founder chưa nhận được tin nhắn lúc này. Tin nhắn chưa được gửi, bạn thử lại sau ít phút nhé.',
    recipientUnready: 'Người này chưa nhận được trả lời của bạn. Tin nhắn chưa được gửi.',
    viewProfile: 'Xem hồ sơ',
    message: 'Nhắn tin',
    close: 'Đóng'
  },
  ja: {
    name: 'Founder',
    subtitle: 'Atum 創業者',
    intro: '質問、アイデア、問題があれば、ここでメッセージしてください。通常1日以内に返信します。',
    replyPromise: '通常1日以内に返信',
    officialAccount: 'Atum 公式アカウント',
    officialApp: 'Atum 公式アプリ',
    verified: '確認済み',
    legendOfficial: 'Atum が運営',
    contactTitle: 'お問い合わせ',
    emailSupport: 'サポートにメール',
    emailSubject: 'Atum サポート',
    contactUnavailable: '現在 Founder に連絡できません。代わりにメールでお問い合わせください。',
    unready: 'Founder はまだメッセージを受け取れません。送信されていません。しばらくしてからもう一度お試しください。',
    recipientUnready: 'この相手はまだ返信を受け取れません。送信されていません。',
    viewProfile: 'プロフィールを見る',
    message: 'メッセージ',
    close: '閉じる'
  },
  zh: {
    name: 'Founder',
    subtitle: 'Atum 创始人',
    intro: '有问题、想法或遇到故障？在这里给我发消息。我通常会在一天内回复。',
    replyPromise: '通常在一天内回复',
    officialAccount: 'Atum 官方账号',
    officialApp: 'Atum 官方应用',
    verified: '已验证',
    legendOfficial: '由 Atum 运营',
    contactTitle: '联系我们',
    emailSupport: '发邮件给客服',
    emailSubject: 'Atum 支持',
    contactUnavailable: '暂时无法联系 Founder。你可以改为发邮件给我们。',
    unready: 'Founder 暂时无法接收消息。消息未发送，请稍后再试。',
    recipientUnready: '对方暂时无法接收你的回复。消息未发送。',
    viewProfile: '查看资料',
    message: '发消息',
    close: '关闭'
  },
  'zh-hant': {
    name: 'Founder',
    subtitle: 'Atum 創辦人',
    intro: '有問題、想法或遇到故障？在這裡傳訊息給我。我通常會在一天內回覆。',
    replyPromise: '通常在一天內回覆',
    officialAccount: 'Atum 官方帳號',
    officialApp: 'Atum 官方應用程式',
    verified: '已驗證',
    legendOfficial: '由 Atum 營運',
    contactTitle: '聯絡我們',
    emailSupport: '寄電子郵件給客服',
    emailSubject: 'Atum 支援',
    contactUnavailable: '目前無法聯絡 Founder。你可以改寄電子郵件給我們。',
    unready: 'Founder 暫時無法接收訊息。訊息未傳送，請稍後再試。',
    recipientUnready: '對方暫時無法接收你的回覆。訊息未傳送。',
    viewProfile: '查看個人檔案',
    message: '傳訊息',
    close: '關閉'
  }
}

/** The words for a language; English for one Atum does not speak. */
export function founderCopy(locale: string): FounderCopy {
  return FOUNDER_COPY[locale as Locale] ?? en
}

export function useFounderCopy(): FounderCopy {
  return founderCopy(useI18n().locale)
}

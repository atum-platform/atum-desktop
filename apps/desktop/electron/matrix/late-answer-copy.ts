import type { DesktopLocale } from '../../shared/desktop-locale'

/**
 * The assistant's own line (first person, an `m.notice` in its chat) when it answers a phone
 * message past that message's 15 minutes: it says it only just saw it, then the answer follows
 * (LB9, plan 6.1 A). Lateness is not distrust: nothing is refused. Fixed copy in the owner's
 * language, never words from the message. Lives here, not in `shared/matrix-action-copy.ts`
 * (where the assistant's other held-reply lines live), because that table is under a hold;
 * moving it there is a coordinator call.
 */
export const matrixLateAnswerCopy: Record<DesktopLocale, string> = {
  en: 'I just saw this message, sorry for the late reply. Working on it now.',
  vi: 'Mình vừa thấy tin này, xin lỗi vì trả lời muộn. Mình làm ngay đây.',
  zh: '我刚刚才看到这条消息，抱歉回复晚了。我这就处理。',
  'zh-hant': '我剛剛才看到這則訊息，抱歉回覆晚了。我這就處理。',
  ja: 'このメッセージを今見つけました。返信が遅くなってすみません。すぐ取りかかります。'
}

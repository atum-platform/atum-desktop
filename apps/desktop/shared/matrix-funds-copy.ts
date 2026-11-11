/**
 * The words of every place a person runs into money: out of Protons, an assistant's daily limit,
 * and a hire or renewal that needs more Protons. (A turn that fell back from the person's own
 * subscription is not a funds surface: its one subtle line belongs to the model-picker lane and never
 * shows a cost.)
 *
 * Owner rulings: out of Protons or a daily limit is one quiet Atum line with one button, never a
 * sentence that sends the person somewhere else to pay; no balance or numbers on a chat line; no
 * wall of text. The button opens the top-up in place (`src/matrix/funds`). Every locale changes
 * together; the phone reads the same strings through the design export.
 */
import type { DesktopLocale } from './desktop-locale'

interface MatrixFundsCopy {
  /** A message the assistant did not answer because the wallet is empty. */
  outOfProtons: string
  /** The chat's band while a cloud assistant cannot answer anything for lack of Protons. */
  outOfProtonsPaused: string
  /** The assistant's own daily limit (set on its card) stopped this answer. */
  dailyCap: string
  /** A third or later assistant could not be hired: the wallet is short of its monthly price. */
  hireShort: string
  /** A paused hire could not be renewed: the wallet is short of its monthly price. */
  renewShort: string
  /** Moving Protons from the person's wallet to a company's: the person's own wallet is short. */
  fundShort: string
  /** The one action of an out-of-Protons line; also the top-up sheet's title. */
  addProtons: string
  /** The one action of a daily-limit line: opens the assistant's card. */
  raiseLimit: string
  /** After a paid top-up opened from a chat or a sheet: back to where the person was. */
  backToChat: string
  /** A hire's monthly price, beside its Hire action. */
  hirePrice: (amount: string) => string
}

const COPY: Record<DesktopLocale, MatrixFundsCopy> = {
  vi: {
    outOfProtons: 'Bạn đã hết Proton nên tin này chưa được trả lời.',
    outOfProtonsPaused: 'Bạn đã hết Proton nên trợ lý đang tạm dừng.',
    dailyCap: 'Trợ lý này đã chạm hạn mức hôm nay.',
    hireShort: 'Không đủ Proton để thuê.',
    renewShort: 'Không đủ Proton để gia hạn.',
    fundShort: 'Ví của bạn không đủ Proton.',
    addProtons: 'Nạp Proton',
    raiseLimit: 'Nâng hạn mức',
    backToChat: 'Quay lại trò chuyện',
    hirePrice: amount => `${amount} Proton / 30 ngày`
  },
  en: {
    outOfProtons: 'You’re out of Protons, so this wasn’t answered.',
    outOfProtonsPaused: 'You’re out of Protons, so your assistant is paused.',
    dailyCap: 'This assistant reached today’s limit.',
    hireShort: 'Not enough Protons to hire.',
    renewShort: 'Not enough Protons to renew.',
    fundShort: 'Not enough Protons in your wallet.',
    addProtons: 'Add Protons',
    raiseLimit: 'Raise limit',
    backToChat: 'Back to chat',
    hirePrice: amount => `${amount} Protons / 30 days`
  },
  ja: {
    outOfProtons: 'Proton がなくなったため、このメッセージには返信できませんでした。',
    outOfProtonsPaused: 'Proton がなくなったため、アシスタントは一時停止中です。',
    dailyCap: 'このアシスタントは今日の上限に達しました。',
    hireShort: '採用するには Proton が足りません。',
    renewShort: '更新するには Proton が足りません。',
    fundShort: 'ウォレットの Proton が足りません。',
    addProtons: 'Proton をチャージ',
    raiseLimit: '上限を上げる',
    backToChat: 'チャットに戻る',
    hirePrice: amount => `${amount} Proton / 30 日`
  },
  zh: {
    outOfProtons: 'Proton 已用完，这条消息还没有回复。',
    outOfProtonsPaused: 'Proton 已用完，助手已暂停。',
    dailyCap: '这个助手已达到今天的上限。',
    hireShort: 'Proton 不足，无法聘请。',
    renewShort: 'Proton 不足，无法续订。',
    fundShort: '你的钱包 Proton 不足。',
    addProtons: '充值 Proton',
    raiseLimit: '提高上限',
    backToChat: '返回聊天',
    hirePrice: amount => `${amount} Proton / 30 天`
  },
  'zh-hant': {
    outOfProtons: 'Proton 已用完，這則訊息還沒有回覆。',
    outOfProtonsPaused: 'Proton 已用完，助理已暫停。',
    dailyCap: '這個助理已達到今天的上限。',
    hireShort: 'Proton 不足，無法聘請。',
    renewShort: 'Proton 不足，無法續訂。',
    fundShort: '你的錢包 Proton 不足。',
    addProtons: '儲值 Proton',
    raiseLimit: '提高上限',
    backToChat: '返回聊天',
    hirePrice: amount => `${amount} Proton / 30 天`
  }
}

export function matrixFundsCopy(locale: DesktopLocale): MatrixFundsCopy {
  return COPY[locale] ?? COPY.vi
}

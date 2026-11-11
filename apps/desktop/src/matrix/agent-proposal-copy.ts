import type { DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixAgentProposalOperation } from '../../shared/matrix-agent-proposals'

/** The words of the confirm card under a main agent's proposal (agent-proposal-card.tsx). */
export interface MatrixAgentProposalWords {
  /** The card's one question, naming the agent. */
  ask: Record<MatrixAgentProposalOperation, (name: string) => string>
  /** The one line under it, only when the change costs Protons; `amount` is already formatted. */
  price: (amount: string) => string
  confirm: string
  notNow: string
  tryAgain: string
  /** The quiet line the card settles into. */
  confirmed: Record<MatrixAgentProposalOperation, (name: string) => string>
  declined: Record<MatrixAgentProposalOperation, (name: string) => string>
  expired: string
  failed: string
  short: string
  /** For screen readers: what the card is. */
  label: string
}

export const matrixAgentProposalCopy: Record<DesktopLocale, MatrixAgentProposalWords> = {
  en: {
    ask: { create: name => `Create ${name}?`, hire: name => `Hire ${name}?`, retire: name => `Delete ${name}?` },
    price: amount => `${amount} Protons/month`,
    confirm: 'Confirm',
    notNow: 'Not now',
    tryAgain: 'Try again',
    confirmed: {
      create: name => `${name} is on its way`,
      hire: name => `${name} is on its way`,
      retire: name => `${name} deleted`
    },
    declined: { create: () => 'Not created', hire: () => 'Not hired', retire: name => `${name} stays` },
    expired: 'This request expired',
    failed: "Couldn't confirm",
    short: 'Not enough Protons',
    label: 'Confirm a change to your agents'
  },
  vi: {
    ask: { create: name => `Tạo ${name}?`, hire: name => `Thuê ${name}?`, retire: name => `Xóa ${name}?` },
    price: amount => `${amount} Proton/tháng`,
    confirm: 'Xác nhận',
    notNow: 'Để sau',
    tryAgain: 'Thử lại',
    confirmed: {
      create: name => `${name} đang được tạo`,
      hire: name => `${name} đang được thuê`,
      retire: name => `Đã xóa ${name}`
    },
    declined: { create: () => 'Chưa tạo', hire: () => 'Chưa thuê', retire: name => `Vẫn giữ ${name}` },
    expired: 'Yêu cầu này đã hết hạn',
    failed: 'Chưa xác nhận được',
    short: 'Không đủ Proton',
    label: 'Xác nhận thay đổi trợ lý'
  },
  zh: {
    ask: { create: name => `创建 ${name}？`, hire: name => `雇用 ${name}？`, retire: name => `删除 ${name}？` },
    price: amount => `每月 ${amount} Proton`,
    confirm: '确认',
    notNow: '暂不',
    tryAgain: '重试',
    confirmed: {
      create: name => `正在创建 ${name}`,
      hire: name => `正在雇用 ${name}`,
      retire: name => `已删除 ${name}`
    },
    declined: { create: () => '未创建', hire: () => '未雇用', retire: name => `保留 ${name}` },
    expired: '此请求已过期',
    failed: '未能确认',
    short: 'Proton 余额不足',
    label: '确认对助手的更改'
  },
  'zh-hant': {
    ask: { create: name => `建立 ${name}？`, hire: name => `僱用 ${name}？`, retire: name => `刪除 ${name}？` },
    price: amount => `每月 ${amount} Proton`,
    confirm: '確認',
    notNow: '暫不',
    tryAgain: '重試',
    confirmed: {
      create: name => `正在建立 ${name}`,
      hire: name => `正在僱用 ${name}`,
      retire: name => `已刪除 ${name}`
    },
    declined: { create: () => '未建立', hire: () => '未僱用', retire: name => `保留 ${name}` },
    expired: '此請求已過期',
    failed: '未能確認',
    short: 'Proton 餘額不足',
    label: '確認對助理的變更'
  },
  ja: {
    ask: {
      create: name => `${name} を作成しますか？`,
      hire: name => `${name} を雇いますか？`,
      retire: name => `${name} を削除しますか？`
    },
    price: amount => `月額 ${amount} Proton`,
    confirm: '確認',
    notNow: 'あとで',
    tryAgain: 'もう一度',
    confirmed: {
      create: name => `${name} を作成しています`,
      hire: name => `${name} を雇っています`,
      retire: name => `${name} を削除しました`
    },
    declined: { create: () => '作成しませんでした', hire: () => '雇いませんでした', retire: name => `${name} はそのままです` },
    expired: 'このリクエストは期限切れです',
    failed: '確認できませんでした',
    short: 'Proton が不足しています',
    label: 'アシスタントの変更を確認'
  }
}

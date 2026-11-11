/**
 * Which chat notices are about money, and which top-up pack fits a known need.
 *
 * A notice is a funds notice by its code (`io.atum.result.status` or the 1.5 `io.atum.status`), or,
 * for events with no code (scheduled posts from today's cloud controller, older history), by being
 * exactly one of the sentences Atum's senders have written for it, in any of Atum's languages.
 * Nothing else: a person typing the same words is never a system line, and the caller only asks
 * for the room's own agent's notices.
 */
import { DESKTOP_LOCALES } from './desktop-locale'
import { type MatrixAgentStatusCode, matrixAgentStatusText } from './matrix-agent-status-copy'
import type { MatrixTopUpPack } from './matrix-checkout'

export type MatrixFundsKind = 'out_of_protons' | 'daily_cap'

const KIND_BY_CODE: Partial<Record<MatrixAgentStatusCode, MatrixFundsKind>> = {
  unfunded: 'out_of_protons',
  // The cloud trial is gone (2026-11-10); an old "trial ended" notice is fixed the same way now.
  trial_expired: 'out_of_protons',
  daily_cap: 'daily_cap'
}

/**
 * The cloud controller's own fallback sentences (atum-app `packages/cloud-controller/src/agent/
 * status-copy.ts`, the unfunded reason followed by its remedy), which reach a chat with no code on
 * a scheduled post. Kept verbatim so they can be recognised; the app never shows them.
 */
const CONTROLLER_OUT_OF_PROTONS = [
  'Mình chưa trả lời được vì ví Proton đã hết. Các việc định kỳ cũng tạm dừng. Mở Protons để nạp thêm nhé.',
  'I can’t answer because your Proton wallet is empty. Scheduled tasks are paused too. Open Protons to top up.',
  'Proton ウォレットの残高がないため、返信できません。定期タスクも停止しています。 Protons を開いてチャージしてください。',
  '你的 Proton 钱包余额已用完，我暂时无法回复，定时任务也已暂停。 请打开 Protons 充值。',
  '你的 Proton 錢包餘額已用完，我暫時無法回覆，排程工作也已暫停。 請開啟 Protons 儲值。'
]

const LEGACY_BODIES: ReadonlyMap<string, MatrixFundsKind> = new Map([
  ...CONTROLLER_OUT_OF_PROTONS.map(body => [body, 'out_of_protons'] as const),
  ...(Object.entries(KIND_BY_CODE) as [MatrixAgentStatusCode, MatrixFundsKind][]).flatMap(([code, kind]) =>
    DESKTOP_LOCALES.map(locale => [matrixAgentStatusText(code, locale), kind] as const)
  )
])

/** The funds line a room's agent notice stands for, if it is one. */
export function matrixFundsKind(message: {
  body: string
  notice?: boolean
  scheduled?: boolean
  cloudStatus?: { code: MatrixAgentStatusCode }
  statusLine?: { code: MatrixAgentStatusCode }
}): MatrixFundsKind | undefined {
  const code = message.cloudStatus?.code ?? message.statusLine?.code

  if (code) {
    return KIND_BY_CODE[code]
  }

  // A scheduled post is a plain message when its notifications are on, so either marks it.
  return message.notice || message.scheduled ? LEGACY_BODIES.get(message.body.trim()) : undefined
}

const MICRO_PROTONS = 1_000_000

/**
 * The pack to offer first: the smallest one that covers a known need (whole Protons), else the
 * largest when none does; with no known need, the smallest. The packs, prices and bonuses are the
 * server's; this only chooses among them.
 */
export function matrixSuggestedTopUpPack(packs: readonly MatrixTopUpPack[], needProtons?: number): string | undefined {
  if (!packs.length) {
    return undefined
  }

  const bySize = [...packs].sort((a, b) => a.totalMicroProtons - b.totalMicroProtons)

  if (needProtons === undefined || !Number.isFinite(needProtons) || needProtons <= 0) {
    return bySize[0]!.id
  }

  const need = Math.ceil(needProtons) * MICRO_PROTONS

  return (bySize.find(pack => pack.totalMicroProtons >= need) ?? bySize[bySize.length - 1]!).id
}

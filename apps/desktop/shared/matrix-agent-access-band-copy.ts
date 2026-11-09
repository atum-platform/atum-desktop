/**
 * What the window itself adds while a cloud assistant's Atum access has ended (the parity plan's
 * T4): one calm band at the top of its chat and one quiet word on its roster row.
 *
 * The reason sentence and the one remedy are the assistant's own status copy
 * (`matrix-agent-status-copy.ts`, PR #620), shared with the in-chat notice so the app keeps one
 * source of truth for those words. Only the roster word, which the status notices never say,
 * lives here.
 *
 * Vietnamese is the source; every locale changes together. No raw codes, no Proton balance, and
 * no purchase path: the one remedy is messaging the Atum team.
 */
import type { DesktopLocale } from './desktop-locale'
import { matrixAgentStatusText } from './matrix-agent-status-copy'

interface MatrixAgentAccessBandCopy {
  /** The roster row's one quiet word; the full reason is in the chat's band. */
  paused: string
}

export const matrixAgentAccessBandCopy: Record<DesktopLocale, MatrixAgentAccessBandCopy> = {
  vi: { paused: 'Tạm dừng' },
  en: { paused: 'Paused' },
  ja: { paused: '一時停止' },
  zh: { paused: '已暂停' },
  'zh-hant': { paused: '已暫停' }
}

/**
 * The reason sentence plus the one remedy, in the assistant's own status copy. Every reason
 * other than an ended trial means the account has no allowance left, exactly as the controller's
 * access-mode mapping states it.
 */
export function matrixAgentAccessBandText(reason: string | undefined, locale: DesktopLocale): string {
  return matrixAgentStatusText(reason === 'trial_expired' ? 'trial_expired' : 'unfunded', locale)
}

/** The roster row's short state while access is gone. */
export function matrixAgentAccessPausedLabel(locale: DesktopLocale): string {
  return (matrixAgentAccessBandCopy[locale] ?? matrixAgentAccessBandCopy.vi).paused
}

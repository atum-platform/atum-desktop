import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { MATRIX_DEFAULT_MODEL, MATRIX_MODEL_LINEUP, matrixCloudModelAlias } from '../../../shared/matrix-models'
import type { WorkRelayLimit, WorkRelayPlan } from '../../../shared/matrix-work-relay'

import { WORK_RELAY_PLAN_NAMES, workRelayCopy, workRelayTurnText, workRelayUsageText } from './relay-copy'
import { type WorkRelayTurnChrome, workRelayUsage } from './relay-view'
import { setWorkActive } from './store'

/** The Atum model that answered instead, by its product name; Nguyệt Thực when the notice named none. */
export function workRelayServedByName(servedBy?: string): string {
  const alias = (servedBy ? matrixCloudModelAlias(servedBy) : undefined) ?? MATRIX_DEFAULT_MODEL

  return MATRIX_MODEL_LINEUP.find(row => row.id === alias)?.name ?? 'Nguyệt Thực'
}

/** Held states draw a soft dot, so a waiting message reads as alive, not broken. */
const LIVE = new Set<WorkRelayTurnChrome['kind']>(['waiting', 'needs_ok', 'limit', 'stopping'])

/**
 * The one line of a relay turn (plan §3.4, §3.6, O4, O12, O13): under the owner's message while it is held or stopped, or under
 * the reply for a fallback, a late answer or a run that ended without one. At most one action. UI chrome, never a message from
 * the assistant, never a cost. Nothing is drawn for a turn answered on the plan.
 */
export function WorkRelayTurnLine({
  chrome,
  className,
  now,
  onOpenWork,
  onStop,
  plan = 'codex',
  servedBy
}: {
  chrome: WorkRelayTurnChrome
  className?: string
  now?: number
  onOpenWork?: () => void
  onStop?: () => void
  plan?: WorkRelayPlan
  servedBy?: string
}) {
  const { locale, t } = useI18n()

  const line = workRelayTurnText(chrome, {
    words: workRelayCopy(locale),
    plan: WORK_RELAY_PLAN_NAMES[plan],
    model: workRelayServedByName(servedBy),
    now: now ?? Date.now(),
    locale
  })

  if (!line) {
    return null
  }

  const run = line.action?.kind === 'stop' ? onStop : line.action?.kind === 'open_work' ? onOpenWork : undefined

  let text = line.text

  if (chrome.kind === 'waiting' && chrome.waitingForAnswer) {
    text = chrome.invalidAnswer ? t.sidebar.row.invalidAnswer : t.sidebar.row.waitingForAnswer
  }

  return (
    <p
      className={cn(
        'flex w-fit max-w-full items-center gap-1.5 text-xs',
        chrome.kind === 'fallback' || chrome.kind === 'late' ? 'text-(--atum-ink-faint)' : 'text-(--atum-ink-muted)',
        className
      )}
      data-work-relay-line={chrome.kind}
      role={LIVE.has(chrome.kind) ? 'status' : 'note'}
    >
      {LIVE.has(chrome.kind) && <span aria-hidden className="ak-dot size-1.5 shrink-0 animate-pulse bg-(--ak-ink-3)" />}
      <span className="min-w-0 truncate">{text}</span>
      {line.action && run && (
        <>
          <span aria-hidden>·</span>
          <button
            className="shrink-0 font-medium text-(--atum-ink) underline-offset-2 hover:underline"
            data-work-relay-action={line.action.kind}
            onClick={run}
            type="button"
          >
            {line.action.label}
          </button>
        </>
      )}
    </p>
  )
}

/** The plan's usage, as one phrase for its Settings row. Shown, never blocking; never a cost or a balance. */
export function useWorkRelayUsageText(limit: WorkRelayLimit | undefined, now?: number): string {
  const { locale } = useI18n()

  const words = workRelayCopy(locale)

  return workRelayUsageText(limit?.usedPercent !== undefined
    ? { kind: 'used', percent: Math.round(limit.usedPercent), resetsAt: limit.resetsAt }
    : workRelayUsage(limit), { words, now: now ?? Date.now(), locale })
}

/** The transcript's relay line. Active turns use the composer's agent Stop. */
export function WorkRelayMessageLine({
  chrome,
  className,
  plan
}: {
  chrome: WorkRelayTurnChrome
  className?: string
  plan?: WorkRelayPlan
}) {
  return (
    <WorkRelayTurnLine
      chrome={chrome}
      className={className}
      onOpenWork={() => setWorkActive(true)}
      plan={plan}
    />
  )
}

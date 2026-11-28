import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useI18n } from '@/i18n'
import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'
import { SubscriptionConnectDialog } from '@/matrix/subscriptions'

import type { FirstRunLabels } from '../../../shared/first-run-labels'
import { type FirstRunProvider, firstRunTier } from '../../../shared/first-run-pick'

import { FIRST_RUN_PROVIDER_NAMES, firstRunConnectionsCopy, type FirstRunConnectionsWords } from './first-run-copy'
import { $firstRunJustReady, $firstRunLabels, $firstRunOpenCodeGo, requestFirstRunRepick } from './first-run-store'
import { $accountConnectProgress, type AccountConnectProgress, continueAccountConnect } from './store'

/** The owner's order (2026-11-27): ChatGPT, Claude, Antigravity, OpenCode. Ready rows rise to the top, as in T3's Agents list. */
const ROW_ORDER: readonly FirstRunProvider[] = ['codex', 'claude', 'antigravity', 'opencode']

const MARK_ID: Record<FirstRunProvider, string> = {
  codex: 'openai-codex',
  claude: 'claude-plan',
  antigravity: 'antigravity',
  opencode: 'opencode-go'
}

export interface FirstRunRow {
  provider: FirstRunProvider
  state: 'ready' | 'connect' | 'signing_in'
  /** Ready: the plan's name (free plans say they serve small tasks). Signing in: "Finish in your browser". */
  line?: string
}

/** Pure: this Mac's facts to the four rows, Ready first. */
export function firstRunRows(
  labels: FirstRunLabels | undefined,
  opencodeGo: boolean,
  progress: AccountConnectProgress | null,
  copy: FirstRunConnectionsWords
): FirstRunRow[] {
  const rows = ROW_ORDER.map((provider): FirstRunRow => {
    const fact = labels?.[provider]
    const ready = fact?.state === 'ready' || (provider === 'opencode' && opencodeGo)

    if (ready) {
      const label = provider === 'opencode' && opencodeGo ? 'OpenCode Go' : fact?.label
      const free = provider !== 'opencode' && firstRunTier(provider, fact?.label) === 'free'

      return { provider, state: 'ready', ...(label ? { line: free ? copy.freeLine(label) : label } : {}) }
    }

    if (progress?.plan === provider && progress.phase === 'signing_in') {
      return { provider, state: 'signing_in', line: copy.finishInBrowser }
    }

    return { provider, state: 'connect' }
  })

  return [...rows.filter(row => row.state === 'ready'), ...rows.filter(row => row.state !== 'ready')]
}

/**
 * The first chat's Connections block: T3's welcome "Agents" rows (geometry measured from T3 0.1.13, evidence
 * mockups-1127-r2/NOTES.md §1), in Kit colours. UI chrome under the assistant's greeting, never an agent message: it keeps role
 * alternation and the agent writes no canned text. It stays at the start of the chat and scrolls away with it.
 *
 * Connect opens the provider's own sign-in (the existing native path, `continueAccountConnect`), or the OpenCode Go key sheet.
 * When it finishes the row turns Ready with a brief tint and the default re-picks (first-run-store.ts); no toast.
 */
export function FirstRunConnections({
  className,
  connect = request => void continueAccountConnect(request)
}: {
  className?: string
  connect?: (request: { plan: 'codex' | 'claude' | 'antigravity'; mode: 'connect' }) => void
}) {
  const { locale } = useI18n()
  const copy = firstRunConnectionsCopy(locale)
  const labels = useStore($firstRunLabels)
  const opencodeGo = useStore($firstRunOpenCodeGo)
  const progress = useStore($accountConnectProgress)
  const justReady = useStore($firstRunJustReady)
  const [keySheet, setKeySheet] = useState(false)
  const rows = firstRunRows(labels, opencodeGo, progress, copy)

  const onConnect = (provider: FirstRunProvider) => {
    if (provider === 'opencode') {
      setKeySheet(true)
    } else {
      connect({ plan: provider, mode: 'connect' })
    }
  }

  return (
    <section
      aria-label={copy.header}
      className={cn(
        'grid w-full grid-cols-[6rem_minmax(0,1fr)] border-y border-(--ak-line) py-(--ak-s2) text-start',
        className
      )}
      data-atum-first-run-connections
    >
      <h3 className="pt-2.5 text-[0.875rem] leading-5 font-normal text-(--atum-ink-muted)">{copy.header}</h3>
      <ul className="flex min-w-0 flex-col">
        {rows.map(row => (
          <li
            className={cn(
              'flex min-h-10 items-center gap-(--ak-s2) rounded-[var(--ak-r-md)] px-2 py-1 transition-colors duration-500',
              justReady.has(row.provider) && 'bg-[color-mix(in_srgb,var(--ak-ok)_12%,transparent)]'
            )}
            data-atum-first-run-row={row.provider}
            data-atum-first-run-state={row.state}
            key={row.provider}
          >
            <ProviderMark provider={{ id: MARK_ID[row.provider], label: FIRST_RUN_PROVIDER_NAMES[row.provider] }} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[0.875rem] leading-5 font-medium text-(--atum-ink)">
                {FIRST_RUN_PROVIDER_NAMES[row.provider]}
              </span>
              {row.line && (
                <span className="truncate text-[0.8125rem] leading-[1.125rem] text-(--atum-ink-muted)" role={row.state === 'signing_in' ? 'status' : undefined}>
                  {row.line}
                </span>
              )}
            </span>
            {row.state === 'ready' ? (
              <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] font-medium text-(--ak-ok)" data-atum-first-run-ready>
                <Check aria-hidden className="size-3.5" />
                {justReady.has(row.provider) ? copy.connected : copy.ready}
              </span>
            ) : (
              <button
                className="ak-btn ak-btn--sm h-6 shrink-0 rounded-[0.5rem] px-2.5 text-[0.75rem] font-medium"
                data-atum-first-run-connect={row.provider}
                disabled={row.state === 'signing_in'}
                onClick={() => onConnect(row.provider)}
                type="button"
              >
                {copy.connect}
              </button>
            )}
          </li>
        ))}
      </ul>
      {keySheet && (
        <SubscriptionConnectDialog
          onClose={() => setKeySheet(false)}
          onConnected={() => requestFirstRunRepick()}
          open
          provider="opencode-go"
        />
      )}
    </section>
  )
}

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { Check, Laptop } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type FirstRunRowNote, type FirstRunRowState, type FirstRunSourceRow, type FirstRunSourcesBridge, isFirstRunAccountRow, useFirstRunSources } from '@/matrix/first-run-sources'
import { MatrixKnowledgeSourceIcon } from '@/matrix/knowledge-sources-settings'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'
import { useMatrixNativeMac } from '@/matrix/native-mac-reach'
import { useNoticePresented } from '@/matrix/notice-presented'
import { SubscriptionConnectDialog } from '@/matrix/subscriptions'

import type { FirstRunLabels } from '../../../shared/first-run-labels'
import { type FirstRunProvider, firstRunTier } from '../../../shared/first-run-pick'
import type { MatrixBrowserImportBridge } from '../../../shared/matrix-browser-import'
import type { MatrixGoogleAssistantAccess } from '../../../shared/matrix-google-tools'
import { matrixKnowledgeSourcesCopy } from '../../../shared/matrix-knowledge-sources-copy'
import type { MatrixNativeMacBridge, MatrixNativeSshAction, MatrixNativeSshView } from '../../../shared/matrix-native-mac'

import { $firstRunListOpen } from './first-run-controller'
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

/** This Mac's reach-down row (native Hermes over Remote Login), as one Connections row. Hidden when there is nothing to report. */
export interface FirstRunMacReachRow {
  state: FirstRunRowState
  note?: FirstRunRowNote
  /** What the row's button runs. */
  action?: MatrixNativeSshAction
}

/** Pure: the native Mac setup result to the row (connected and set up read Ready; Remote Login is the row's Connect). */
export function firstRunMacReachRow(
  facts: { view?: MatrixNativeSshView; manual: boolean; running?: MatrixNativeSshAction },
  skipped: boolean
): FirstRunMacReachRow | null {
  const status = facts.view?.status

  if (!status) {
    return null
  }

  if (facts.running && facts.running !== 'status' && facts.running !== 'refresh') {
    return { state: 'connecting', action: facts.running }
  }

  switch (status) {
    case 'connected':

    case 'set_up':
      return { state: 'ready' }

    case 'needs_remote_login':
      return facts.manual
        ? { state: 'settings', action: 'open_settings' }
        : { state: skipped ? 'skipped' : 'connect', action: 'enable_remote_login' }

    case 'needs_full_disk_access_hint':
      return { state: 'settings', note: 'fullDisk', action: 'open_settings' }

    case 'not_connected':
      return { state: skipped ? 'skipped' : 'connect', action: 'connect' }

    default:
      return { state: skipped ? 'skipped' : 'connect', note: 'unavailable', action: 'connect' }
  }
}

function planState(row: FirstRunRow, justReady: boolean, skipped: boolean): FirstRunRowState {
  if (row.state === 'ready') {
    return justReady ? 'connected' : 'ready'
  }

  if (row.state === 'signing_in') {
    return 'connecting'
  }

  return skipped ? 'skipped' : 'connect'
}

const ROW = 'flex min-h-10 items-center gap-(--ak-s2) rounded-[var(--ak-r-md)] px-2 py-1 transition-colors duration-500'

function RowEnd({
  actionId,
  copy,
  disabled,
  onAction,
  state
}: {
  /** The row's id on its button (`data-atum-first-run-connect`). */
  actionId?: string
  copy: FirstRunConnectionsWords
  disabled?: boolean
  onAction?: () => void
  state: FirstRunRowState
}) {
  if (state === 'ready' || state === 'connected') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] font-medium text-(--ak-ok)" data-atum-first-run-ready>
        <Check aria-hidden className="size-3.5" />
        {state === 'connected' ? copy.connected : copy.ready}
      </span>
    )
  }

  if (state === 'connecting') {
    return <span aria-label={copy.connecting} className="ak-spinner shrink-0" role="status" />
  }

  const label = state === 'settings' ? copy.openSettings : state === 'restart' ? copy.restart : copy.connect

  return (
    <button
      className={cn(
        'ak-btn ak-btn--sm h-6 shrink-0 rounded-[0.5rem] px-2.5 text-[0.75rem] font-medium',
        state === 'skipped' && 'ak-btn--plain'
      )}
      data-atum-first-run-action={state}
      data-atum-first-run-connect={actionId}
      disabled={disabled || !onAction}
      onClick={onAction}
      type="button"
    >
      {label}
    </button>
  )
}

function Row({
  actionId,
  children,
  copy,
  dataProps,
  line,
  mark,
  name,
  onAction,
  state,
  tint
}: {
  actionId?: string
  children?: ReactNode
  copy: FirstRunConnectionsWords
  dataProps: Record<string, string>
  line?: string
  mark: ReactNode
  name: string
  onAction?: () => void
  state: FirstRunRowState
  tint?: boolean
}) {
  const sub = state === 'skipped' ? copy.skipped : line

  return (
    <li
      className={cn(ROW, tint && 'bg-[color-mix(in_srgb,var(--ak-ok)_12%,transparent)]')}
      data-atum-first-run-state={state}
      {...dataProps}
    >
      <span className={cn('flex shrink-0', state === 'skipped' && 'opacity-55')}>{mark}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-[0.875rem] leading-5 font-medium text-(--atum-ink)', state === 'skipped' && 'opacity-55')}>
          {name}
        </span>
        {sub && (
          <span className="truncate text-[0.8125rem] leading-[1.125rem] text-(--atum-ink-muted)" role={state === 'connecting' ? 'status' : undefined}>
            {sub}
          </span>
        )}
      </span>
      {children ?? <RowEnd actionId={actionId} copy={copy} onAction={onAction} state={state} />}
    </li>
  )
}

function Group({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] [&+&]:mt-1 [&+&]:border-t [&+&]:border-(--ak-line) [&+&]:pt-1" data-atum-first-run-group>
      <h3 className="pt-2.5 text-[0.875rem] leading-5 font-normal text-(--atum-ink-muted)">{label}</h3>
      <ul className="flex min-w-0 flex-col">{children}</ul>
    </div>
  )
}

/**
 * The one Connections list (owner 2026-11-28; storyboard docs/mockups/new-user-flow/, frames 08–12). One data-driven list in
 * T3's Agents-row style under the assistant's welcome, in three groups:
 * - AI plans: ChatGPT, Claude, Antigravity, OpenCode (Ready ones first). Connect opens the provider's own sign-in in the browser
 *   (the existing native path, `continueAccountConnect`), or the OpenCode Go key sheet; the default re-picks (first-run-store.ts).
 * - Accounts: Google, one browser trip for mail, calendar and Drive.
 * - This Mac: the source descriptors (folders, Messages, browser, location, team spaces) and the reach-down row. macOS asks only
 *   from the row that needs it, one prompt at a time, never stacked over the list.
 *
 * One action per row: Connect → spinner → Connected (Ready when it was already on), or Skipped. "Skip the rest" closes it. UI
 * chrome, never an agent message: it keeps role alternation and the agent writes no canned text. It stays in the chat's history.
 * The first source that connects admits first learning (first-run-sources.ts).
 */
export function FirstRunConnections({
  assistantName = 'Atum',
  bridge = typeof window === 'undefined' ? undefined : window.atumMatrix,
  browserImport = typeof window === 'undefined' ? undefined : window.atumBrowserImport,
  className,
  connect = request => void continueAccountConnect(request),
  googleAssistant,
  learningOffered = false,
  nativeMac = typeof window === 'undefined' ? undefined : window.atumMatrix?.nativeMac,
  roomId,
  trackOpen = false
}: {
  assistantName?: string
  bridge?: FirstRunSourcesBridge
  browserImport?: MatrixBrowserImportBridge
  className?: string
  connect?: (request: { plan: 'codex' | 'claude' | 'antigravity'; mode: 'connect' }) => void
  googleAssistant?: MatrixGoogleAssistantAccess
  /** The first run still waits on the person's yes: the first Connect admits first learning, Skip the rest declines it. */
  learningOffered?: boolean
  nativeMac?: MatrixNativeMacBridge
  roomId?: string
  /** The first chat's own list: while rows are open, other first-chat notices wait (first-run-controller.ts). */
  trackOpen?: boolean
}) {
  const { locale } = useI18n()
  const copy = firstRunConnectionsCopy(locale)
  const sourceCopy = matrixKnowledgeSourcesCopy[locale] ?? matrixKnowledgeSourcesCopy.en
  const labels = useStore($firstRunLabels)
  const opencodeGo = useStore($firstRunOpenCodeGo)
  const progress = useStore($accountConnectProgress)
  const justReady = useStore($firstRunJustReady)
  const [keySheet, setKeySheet] = useState(false)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const list = useRef<HTMLElement | null>(null)
  const plans = firstRunRows(labels, opencodeGo, progress, copy)
  const sources = useFirstRunSources({ bridge, browserImport, googleAssistant, learningOffered, locale, roomId })
  const mac = useMatrixNativeMac(Boolean(nativeMac), nativeMac)
  const macRow = firstRunMacReachRow(mac, skipped.has('mac-reach'))

  const planStates = plans.map(row => planState(row, justReady.has(row.provider), skipped.has(row.provider)))
  const accountRows = sources.rows.filter(isFirstRunAccountRow)
  const macRows = sources.rows.filter(row => !isFirstRunAccountRow(row))
  const open = planStates.includes('connect') || sources.rows.some(row => row.state === 'connect') || macRow?.state === 'connect'

  useEffect(() => {
    if (!trackOpen) {
      return
    }

    $firstRunListOpen.set(open)

    return () => $firstRunListOpen.set(false)
  }, [open, trackOpen])

  // For a new account this list is the disclosure (its foot says the assistant reads from the cloud): a second on screen in a
  // focused window counts as presented, never as accepted.
  useNoticePresented(
    sources.rows.length > 0 && Boolean(bridge?.agentSources?.presented),
    () => void bridge?.agentSources?.presented?.().catch(() => undefined),
    list
  )

  const onPlan = (provider: FirstRunProvider) => {
    if (provider === 'opencode') {
      setKeySheet(true)
    } else {
      connect({ plan: provider, mode: 'connect' })
    }
  }

  const noteLine = (note: FirstRunRowNote | undefined) =>
    note === 'notAllowed' ? copy.notAllowed : note === 'unavailable' ? copy.unavailable : note === 'fullDisk' ? copy.fullDiskLine : undefined

  const sourceLine = (row: FirstRunSourceRow) =>
    noteLine(row.note) ??
    (row.folders
      ? row.folders.map(folder => folder.name ?? sourceCopy.folderAccess.names[folder.kind as keyof typeof sourceCopy.folderAccess.names] ?? folder.kind).join(', ')
      : row.description ?? sourceCopy.descriptions[row.kind])

  const sourceAction = (row: FirstRunSourceRow) =>
    row.state === 'settings'
      ? () => void sources.openFullDiskSettings()
      : row.state === 'restart'
        ? () => void sources.relaunch()
        : () => void sources.connect(row.gate)

  const sourceRow = (row: FirstRunSourceRow) => (
    <Row
      copy={copy}
      dataProps={{ 'data-atum-ask': row.gate }}
      key={row.key}
      line={sourceLine(row)}
      mark={<MatrixKnowledgeSourceIcon iconDataUrl={row.iconDataUrl} kind={row.kind} />}
      name={row.label ?? sourceCopy.names[row.kind]}
      onAction={sourceAction(row)}
      state={row.state}
    />
  )

  const skipRest = () => {
    setSkipped(new Set([
      ...plans.filter((_, index) => planStates[index] === 'connect').map(row => row.provider),
      ...(macRow?.state === 'connect' ? ['mac-reach'] : [])
    ]))
    void sources.skipRest()
  }

  return (
    <section
      aria-label={copy.header}
      className={cn('w-full border-y border-(--ak-line) py-(--ak-s2) text-start', className)}
      data-atum-first-run-connections
      ref={list}
    >
      <Group label={copy.groups.plans}>
        {plans.map((row, index) => (
          <Row
            actionId={row.provider}
            copy={copy}
            dataProps={{ 'data-atum-first-run-row': row.provider }}
            key={row.provider}
            line={row.line}
            mark={<ProviderMark provider={{ id: MARK_ID[row.provider], label: FIRST_RUN_PROVIDER_NAMES[row.provider] }} size="sm" />}
            name={FIRST_RUN_PROVIDER_NAMES[row.provider]}
            onAction={() => onPlan(row.provider)}
            state={planStates[index]!}
            tint={justReady.has(row.provider)}
          />
        ))}
      </Group>
      {accountRows.length > 0 && <Group label={copy.groups.accounts}>{accountRows.map(sourceRow)}</Group>}
      {(macRows.length > 0 || macRow) && (
        <Group label={copy.groups.mac}>
          {macRows.map(sourceRow)}
          {macRow && (
            <Row
              copy={copy}
              dataProps={{ 'data-atum-first-run-row': 'mac-reach' }}
              line={
                noteLine(macRow.note) ??
                (macRow.state === 'connecting' && macRow.action === 'enable_remote_login' ? copy.macReachPassword : copy.macReachLine)
              }
              mark={<span className="ak-appicon ak-appicon--sm flex items-center justify-center"><Laptop aria-hidden className="size-3.5" /></span>}
              name={copy.macReach(assistantName)}
              onAction={macRow.action ? () => mac.run(macRow.action!) : undefined}
              state={macRow.state}
            />
          )}
        </Group>
      )}
      {(sources.rows.length > 0 || open || sources.failed) && (
        <div className="flex items-center gap-(--ak-s2) px-2 pt-(--ak-s2)">
          <span className="min-w-0 flex-1 truncate text-[0.75rem] leading-4 text-(--atum-ink-muted)" role={sources.failed ? 'status' : undefined}>
            {sources.failed ? copy.failed : sources.rows.length > 0 ? copy.cloudLine(assistantName) : null}
          </span>
          {open && (
            <button className="ak-btn ak-btn--sm ak-btn--plain h-6 shrink-0 px-2.5 text-[0.75rem]" data-atum-first-run-skip onClick={skipRest} type="button">
              {copy.skipRest}
            </button>
          )}
        </div>
      )}
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

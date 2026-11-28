import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { Check, CheckCircle2, Laptop } from '@/lib/icons'
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

import {
  $firstRunAsk,
  $firstRunListOpen,
  claimFirstRunAutoPass,
  firstRunAskOpen,
  type FirstRunAskState,
  firstRunChoose,
  firstRunNotNow,
  type FirstRunSureStep,
  registerFirstRunAskRunner,
  runFirstRunGoogle,
  runFirstRunSure
} from './first-run-controller'
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

/** Pure: the steps Sure may still run, from the rows (Remote Login only as its own native prompt or a promptless setup). */
export function firstRunPendingSteps(
  rows: readonly Pick<FirstRunSourceRow, 'kind' | 'state'>[],
  macRow: FirstRunMacReachRow | null
): FirstRunSureStep[] {
  const open = (kind: FirstRunSourceRow['kind']) => rows.some(row => row.kind === kind && row.state === 'connect')

  return [
    ...(open('folders') ? (['folders'] as const) : []),
    ...(open('messages') ? (['messages'] as const) : []),
    ...(macRow?.state === 'connect' && (macRow.action === 'enable_remote_login' || macRow.action === 'connect') ? (['mac-reach'] as const) : []),
    ...(open('google') ? (['google'] as const) : [])
  ]
}

/** Names joined the way the locale joins a list ("Documents, Desktop and Messages": Atum's English has no serial comma). */
export function firstRunJoin(locale: string, names: readonly string[]): string {
  try {
    return new Intl.ListFormat(locale === 'en' ? 'en-GB' : locale, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** Pure: the one progress line while Sure runs ("Reading Documents and Desktop… · Messages next"). */
export function firstRunProgressLine(
  input: { step: FirstRunSureStep; next?: FirstRunSureStep; folders: readonly string[]; macAction?: MatrixNativeSshAction },
  copy: FirstRunConnectionsWords,
  names: Record<FirstRunSureStep, string>,
  locale: string
): string {
  const now =
    input.step === 'folders'
      ? copy.ask.reading(input.folders.length ? firstRunJoin(locale, input.folders) : names.folders)
      : input.step === 'messages'
        ? copy.ask.fullDisk
        : input.step === 'mac-reach'
          ? input.macAction === 'enable_remote_login' ? copy.macReachPassword : copy.connecting
          : copy.finishInBrowser

  return input.next ? `${now} · ${copy.ask.next(names[input.next])}` : now
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

const ASK_BUTTON = 'ak-btn ak-btn--sm h-7 shrink-0 rounded-[0.5rem] px-3.5 text-[0.8125rem] font-medium'
const ASK_LINE = 'min-w-0 truncate text-[0.8125rem] leading-[1.125rem] text-(--atum-ink-muted)'

/**
 * The one action row under the assistant's own ask (storyboard frames 08a–08h). UI chrome only: the assistant writes the
 * question in its welcome; this row answers it. One action and at most one line per state.
 */
function AskRow({
  copy,
  line,
  progress,
  state,
  summary
}: {
  copy: FirstRunConnectionsWords
  /** The quiet line under the row (the cloud disclosure, or what is connected so far). */
  line?: string
  progress?: string
  state: FirstRunAskState
  summary?: string
}) {
  const choose = (
    <button
      className="ak-btn ak-btn--sm ak-btn--plain ms-auto h-7 shrink-0 px-2 text-[0.8125rem] font-semibold"
      data-atum-first-run-choose
      onClick={firstRunChoose}
      type="button"
    >
      {copy.ask.choose}
    </button>
  )

  const phase = state.phase === 'done' && !summary ? 'later' : state.phase

  return (
    <div className="flex w-full flex-col gap-1" data-atum-first-run-ask={phase}>
      <div className="flex min-h-7 w-full items-center gap-(--ak-s2)">
        {phase === 'ask' && (
          <>
            <button className={cn(ASK_BUTTON, 'ak-btn--primary')} data-atum-first-run-sure onClick={() => void runFirstRunSure()} type="button">
              {copy.ask.sure}
            </button>
            <button className={cn(ASK_BUTTON, 'ak-btn--plain')} data-atum-first-run-not-now onClick={() => void firstRunNotNow()} type="button">
              {copy.ask.notNow}
            </button>
          </>
        )}
        {phase === 'google' && (
          <>
            <button className={cn(ASK_BUTTON, 'ak-btn--primary')} data-atum-first-run-google onClick={() => void runFirstRunGoogle()} type="button">
              {copy.ask.connectGoogle}
            </button>
            <button className={cn(ASK_BUTTON, 'ak-btn--plain')} data-atum-first-run-not-now onClick={() => void firstRunNotNow()} type="button">
              {copy.ask.notNow}
            </button>
          </>
        )}
        {phase === 'running' && (
          <span className="flex min-w-0 items-center gap-(--ak-s2)" role="status">
            <span aria-hidden className="ak-spinner size-3 shrink-0" />
            <span className={ASK_LINE}>{progress}</span>
          </span>
        )}
        {phase === 'done' && (
          <span className="flex min-w-0 items-center gap-(--ak-s2)" data-atum-first-run-summary>
            <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-(--ak-ok)" />
            <span className={ASK_LINE}>{summary}</span>
          </span>
        )}
        {choose}
      </div>
      {(phase === 'ask' || phase === 'google') && line && <span className={cn(ASK_LINE, 'px-0.5 text-[0.75rem]')}>{line}</span>}
    </div>
  )
}

/** Where the list is drawn: the full list, the ask row (the first run's welcome), or hidden while the welcome is written. */
export type FirstRunPresentation = 'list' | 'ask' | 'hidden'

/**
 * Pure: the ask row belongs to an open first run. Under an old welcome (the welcome closed in an earlier session) the plain list
 * shows instead; an ask answered in this window keeps its row while it runs, even though its first source closed the welcome.
 */
export function firstRunEffectivePresentation(
  presentation: FirstRunPresentation,
  learningOffered: boolean,
  phase: FirstRunAskState['phase']
): FirstRunPresentation {
  return presentation === 'ask' && !learningOffered && phase === 'ask' ? 'list' : presentation
}

/**
 * The one Connections list (owner 2026-11-28; storyboard docs/mockups/new-user-flow/, frames 08a–08i: the first run shows it as
 * the ask row, `presentation="ask"`, and as this list behind Choose what to connect). One data-driven list in
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
  presentation: requested = 'list',
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
  /**
   * `ask` and `hidden` are the first run's: Atum connects what needs no prompt as soon as the list mounts (hidden while the
   * welcome is written, so the welcome can name it), and the welcome's ask row runs the rest. `list` is the plain list.
   */
  presentation?: FirstRunPresentation
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
  const listOpen = planStates.includes('connect') || sources.rows.some(row => row.state === 'connect') || macRow?.state === 'connect'
  const ask = useStore($firstRunAsk)
  const presentation = firstRunEffectivePresentation(requested, learningOffered, ask.phase)
  const firstRun = presentation !== 'list'
  const asking = presentation === 'ask' && !ask.choosing
  const open = asking ? firstRunAskOpen(ask) : presentation === 'hidden' ? false : listOpen
  const pending = firstRunPendingSteps(sources.rows, macRow)

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
    presentation !== 'hidden' && sources.rows.length > 0 && Boolean(bridge?.agentSources?.presented),
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

    return sources.skipRest()
  }

  // The ask's runner reads this render's rows (first-run-controller.ts runs Sure even while the list moves).
  const latest = useRef({ pending, sources, mac, macRow, skipRest })
  latest.current = { pending, sources, mac, macRow, skipRest }

  useEffect(() => {
    if (!firstRun) {
      return
    }

    return registerFirstRunAskRunner({
      pending: () => latest.current.pending,
      run: async step => {
        const { mac: reach, macRow: reachRow, sources: now } = latest.current

        if (step === 'mac-reach') {
          if (reachRow?.action === 'enable_remote_login' || reachRow?.action === 'connect') {
            await reach.run(reachRow.action)
          }

          return
        }

        const kind = step === 'folders' ? 'folders' : step === 'messages' ? 'messages' : 'google'
        const row = now.rows.find(item => item.kind === kind && item.state === 'connect')

        if (row) {
          await now.connect(row.gate)
        }
      },
      admitLearning: () => latest.current.sources.admitLearning(),
      notNow: () => latest.current.skipRest()
    })
  }, [firstRun])

  // Automatic first: whatever needs no prompt connects as soon as the facts are read, once per window, while the first run is
  // open (a dismissed welcome already said Not now).
  useEffect(() => {
    if (firstRun && learningOffered && sources.settled && claimFirstRunAutoPass()) {
      void sources.autoConnect()
    }
  }, [firstRun, learningOffered, sources])

  if (presentation === 'hidden') {
    return null
  }

  if (asking) {
    const stepNames: Record<FirstRunSureStep, string> = {
      folders: sourceCopy.names.folders,
      messages: sourceCopy.names.messages,
      'mac-reach': copy.ask.thisMac,
      google: sourceCopy.names.google
    }

    const folderNames = (sources.rows.find(row => row.kind === 'folders')?.folders ?? []).map(
      folder => folder.name ?? sourceCopy.folderAccess.names[folder.kind as keyof typeof sourceCopy.folderAccess.names] ?? folder.kind
    )

    const connectedNames = [
      ...sources.rows
        .filter(row => row.state === 'connected')
        .flatMap(row => (row.kind === 'folders' && folderNames.length ? folderNames : [row.label ?? sourceCopy.names[row.kind]])),
      ...(ask.ran.includes('mac-reach') && macRow?.state === 'ready' ? [copy.ask.thisMac] : [])
    ]

    const summary = connectedNames.length ? copy.ask.connected(firstRunJoin(locale, connectedNames)) : undefined

    return (
      <section aria-label={copy.header} className={cn('w-full text-start', className)} data-atum-first-run-connections="ask" ref={list}>
        <AskRow
          copy={copy}
          line={ask.phase === 'google' ? summary : sources.rows.length > 0 ? copy.cloudLine(assistantName) : undefined}
          progress={
            ask.step
              ? firstRunProgressLine({ step: ask.step, next: ask.next, folders: folderNames, macAction: macRow?.action }, copy, stepNames, locale)
              : undefined
          }
          state={ask}
          summary={summary}
        />
      </section>
    )
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
              onAction={macRow.action ? () => void mac.run(macRow.action!) : undefined}
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
            <button className="ak-btn ak-btn--sm ak-btn--plain h-6 shrink-0 px-2.5 text-[0.75rem]" data-atum-first-run-skip onClick={() => void skipRest()} type="button">
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

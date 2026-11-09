import { useStore } from '@nanostores/react'
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import {
  ChevronLeft,
  Clock,
  Cloud,
  CloudCheck,
  CloudOff,
  Folder,
  FolderOpen,
  Info,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pause,
  RefreshCw,
  SearchIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import type {
  MatrixDriveBridge,
  MatrixDriveImportPlan,
  MatrixDriveRow,
  MatrixDriveView
} from '../../shared/matrix-drive'

import { matrixDriveCopy } from './drive-copy'
import { MatrixDriveFacts, MatrixDriveSkippedNote } from './drive-facts'
import { MatrixDriveImportSheet } from './drive-import'
import { matrixDriveImportCopy } from './drive-import-copy'
import {
  $matrixDriveTaskSelection,
  clearMatrixDriveTaskSelections,
  removeMatrixDriveTaskSelection,
  selectMatrixDriveCreate,
  selectMatrixDriveFile,
  setMatrixDriveTaskScope,
  validMatrixDriveLeafName
} from './drive-selection'
import type { MatrixDriveTaskScope } from './drive-selection'
import { MatrixFileGlyph } from './file-glyph'

const initial: MatrixDriveView = { state: 'unavailable', revision: 0, rows: [], canGoBack: false, truncated: false }

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

/** Finder decimal units; storage comparisons can share the total's unit. */
export function formatDriveSize(bytes: number, locale: string, unitFromBytes = bytes): string {
  let value = Math.max(0, bytes)
  let reference = Math.max(0, unitFromBytes)
  let unit = 0

  while (reference >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000
    reference /= 1000
    unit += 1
  }

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: SIZE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1
  }).format(value)
}

type DriveCopy = (typeof matrixDriveCopy)[Locale]

export type MatrixDriveDestination = 'recents' | 'all'

/** The local browser has no origin feed yet, so recency is the row's verified modified time. */
export function recentDriveRows(rows: readonly MatrixDriveRow[]): MatrixDriveRow[] {
  return [...rows].sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name))
}

export function MatrixDriveSidebar({
  compact,
  current,
  onSelect,
  windowControls
}: {
  compact: boolean
  current: MatrixDriveDestination
  onSelect(destination: MatrixDriveDestination): void
  windowControls: ReactNode
}) {
  const { locale } = useI18n()
  const copy = matrixDriveCopy[locale]
  const destinations = [
    { id: 'recents' as const, label: copy.browser.recents, icon: Clock },
    { id: 'all' as const, label: copy.browser.allFiles, icon: Folder }
  ]

  return (
    <aside
      className="atum-sidebar relative flex h-full w-(--atum-l-roster) shrink-0 flex-col overflow-hidden [-webkit-app-region:no-drag]"
      data-atum-drawer={compact ? 'true' : undefined}
      data-atum-roster
      data-matrix-drive-sidebar
    >
      <div
        className="flex h-(--atum-l-header) shrink-0 items-center px-(--ak-s3) [-webkit-app-region:drag]"
        data-atum-roster-header
      >
        {windowControls}
      </div>
      <nav aria-label={copy.title} className="min-h-0 flex-1 overflow-y-auto px-(--ak-s2) pb-(--ak-s3)">
        <p className="ak-section">{copy.title}</p>
        {/* Atum Kit Drive board: the places sit on the roster panel itself, a hairline between rows. */}
        <div className="flex flex-col" data-matrix-drive-places>
          {destinations.map(({ id, label, icon: Icon }) => (
            <button
              aria-current={current === id ? 'page' : undefined}
              className="ak-row atum-row w-full"
              data-current={current === id ? 'true' : undefined}
              key={id}
              onClick={() => onSelect(id)}
              type="button"
            >
              <Icon aria-hidden className="ak-icon ak-icon--sm" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  )
}

/** Where the page is, from the native facts alone: every phase but `files` is a calm, centred hero. */
export type MatrixDrivePhase =
  | 'off'
  | 'preparing'
  | 'folderRecovery'
  | 'notOn'
  | 'stopped'
  | 'cleanup_failed'
  | 'files'

export function matrixDrivePhase(
  view: Pick<MatrixDriveView, 'state' | 'problem' | 'waitingForBrowser' | 'signInNeeded'>
): MatrixDrivePhase {
  if (view.problem === 'folder_changed') {
    return 'folderRecovery'
  }

  switch (view.state) {
    case 'authorizing':

    case 'connecting':
      return 'preparing'

    case 'ready':

    case 'syncing':

    case 'paused':

    case 'offline':
      return 'files'

    case 'cleanup_failed':
      return 'cleanup_failed'

    case 'reauthenticate':

    case 'error':
      // No browser and no sign-in step: a stop is a status row with Try again.
      return view.problem ? 'notOn' : 'stopped'

    default:
      // `disconnected`: Drive is being set up, or a first setup stopped for a named reason.
      return view.problem ? 'notOn' : 'off'
  }
}

type DriveAction = 'connect' | 'chooseFolder' | 'disconnect'

interface DriveHeroSpec {
  title: string
  body?: string
  /** The body is a known problem: full ink, it says what to do. */
  problem?: boolean
  /** Atum is working on it: the spinner, no button to press for it. */
  working?: boolean
  primary?: { label: string; action: DriveAction }
  secondary?: { label: string; action: DriveAction }
  /** The quiet "Choose another folder…" link, for a folder that cannot be reused. */
  choose?: boolean
}

/** A folder problem that only another folder can fix. */
function folderNeedsAnother(problem: MatrixDriveView['problem']): boolean {
  return Boolean(problem?.startsWith('folder_') && problem !== 'folder_changed')
}

/** Every phase has its words and a way forward; setup itself has nothing to press. */
const HERO: Record<Exclude<MatrixDrivePhase, 'files'>, (copy: DriveCopy, view: MatrixDriveView) => DriveHeroSpec> = {
  off: copy => ({ title: copy.gettingReady, working: true }),
  // Drive is starting itself: nothing to press, and the minute is not a failure.
  preparing: copy => ({ title: copy.gettingReady, working: true }),
  folderRecovery: copy => ({
    title: copy.attention.folder_changed,
    body: copy.problem.folder_changed,
    problem: true,
    primary: { label: copy.chooseFolderAgain, action: 'chooseFolder' },
    secondary: { label: copy.forgetFolder, action: 'disconnect' }
  }),
  notOn: (copy, view) => ({
    title: copy.attention.notOn,
    body: view.problem ? copy.problem[view.problem] : copy.status.error,
    problem: true,
    primary: { label: copy.retry, action: 'connect' },
    ...(folderNeedsAnother(view.problem) ? { choose: true } : {})
  }),
  stopped: copy => ({
    title: copy.attention.stopped,
    body: copy.status.error,
    primary: { label: copy.retry, action: 'connect' }
  }),
  cleanup_failed: copy => ({
    title: copy.attention.cleanup_failed,
    body: copy.status.cleanup_failed,
    // Turning off is what didn't finish: Try again finishes it.
    primary: { label: copy.retry, action: 'disconnect' }
  })
}

function sameDay(a: number, b: number): boolean {
  const first = new Date(a)
  const second = new Date(b)

  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  )
}

/** "14:32" today, a date and time before today: when the last sync finished. */
export function formatDriveSyncTime(at: number, locale: string, now = Date.now()): string {
  return new Intl.DateTimeFormat(
    locale,
    sameDay(at, now) ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }
  ).format(at)
}

/** A file's time as Finder lists it: the time today, the date before. */
function formatModified(at: number, locale: string): string {
  return new Intl.DateTimeFormat(
    locale,
    sameDay(at, Date.now()) ? { timeStyle: 'short' } : { dateStyle: 'medium' }
  ).format(at)
}

/** The status line of a connected Drive: "Up to date · 14:32". */
export function matrixDriveStatusLine(
  view: Pick<MatrixDriveView, 'state' | 'lastSyncAt'>,
  copy: DriveCopy,
  _locale: string
): string {
  return copy.status[view.state]
}

/** Local scan freshness is deliberately separate from the sync engine's status. */
function matrixDriveListingLine(
  view: Pick<MatrixDriveView, 'listingStatus' | 'listedAt'>,
  copy: DriveCopy,
  locale: string
) {
  if (!view.listingStatus || (view.listingStatus === 'current' && !view.listedAt)) {
    return undefined
  }

  const label = copy.listing[view.listingStatus]

  return view.listingStatus === 'current' && view.listedAt
    ? `${label} · ${formatDriveSyncTime(view.listedAt, locale)}`
    : label
}

function DriveWhere({ copy, view }: { copy: DriveCopy; view: MatrixDriveView }) {
  return (
    <p
      className="truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-faint)"
      data-matrix-drive-where
    >
      {view.rootLocation ? copy.location.replace('{folder}', view.rootLocation) : copy.hero.where}
    </p>
  )
}

/** "About syncing": details and the alternate folder path behind one info popover. */
function DriveAbout({
  copy,
  className,
  onChooseFolder,
  where
}: {
  copy: DriveCopy
  className?: string
  onChooseFolder?: () => void
  where?: ReactNode
}) {
  return (
    <Popover>
      <section className={className} data-matrix-drive-notes>
        <Tip label={copy.about.title}>
          <PopoverTrigger asChild>
            <button aria-label={copy.about.title} className="atum-settings-tip" type="button">
              <Info aria-hidden className="size-3.5" />
            </button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent align="center" className="w-80 p-3">
          {where && <div className="mb-2">{where}</div>}
        <ul className="mt-2 space-y-1 text-(length:--atum-t-caption) leading-[1.5] text-(--atum-ink-muted)">
          <li className="text-(--atum-ink-soft)">{copy.about.private}</li>
          <li>{copy.about.running}</li>
          <li>{copy.about.quota}</li>
          <li>{copy.about.skipped}</li>
        </ul>
          {onChooseFolder && (
            <Button className="mt-2" onClick={onChooseFolder} size="sm" variant="text">
              {copy.chooseFolder}
            </Button>
          )}
        </PopoverContent>
      </section>
    </Popover>
  )
}

function DriveStatusMark({ copy, view }: { copy: DriveCopy; view: MatrixDriveView }) {
  const mark = 'size-5 text-(--atum-ink-soft)'

  if (view.factsStale && (view.state === 'ready' || view.state === 'syncing')) {
    return <Cloud aria-hidden className={mark} strokeWidth={1.6} />
  }

  switch (view.state) {
    case 'authorizing':

    case 'connecting':
      return <Loader className="size-5" label={copy.status[view.state]} size="sm" />

    case 'syncing':
      return <Loader className="size-5" label={copy.status.syncing} size="sm" />

    case 'offline':

    case 'reauthenticate':

    case 'error':

    case 'cleanup_failed':
      return <CloudOff aria-hidden className={mark} strokeWidth={1.6} />

    case 'paused':
      return <Pause aria-hidden className={mark} strokeWidth={1.6} />

    default:
      return <CloudCheck aria-hidden className={mark} strokeWidth={1.6} />
  }
}

export function MatrixDrive({
  bridge,
  destination = 'all',
  onDestinationChange,
  onPreview,
  onUseInConversation,
  taskScope
}: {
  bridge?: MatrixDriveBridge
  destination?: MatrixDriveDestination
  onDestinationChange?(destination: MatrixDriveDestination): void
  onPreview?(row: MatrixDriveRow): void
  onUseInConversation?: () => void
  taskScope?: MatrixDriveTaskScope
}) {
  const { locale } = useI18n()
  const copy = matrixDriveCopy[locale]
  const [view, setView] = useState(initial)
  const [loading, setLoading] = useState(Boolean(bridge))
  const [activeAction, setActiveAction] = useState<'refresh' | 'other' | null>(null)
  const [failed, setFailed] = useState(false)
  const [createInFolder, setCreateInFolder] = useState<string | null>(null)
  const [outputName, setOutputName] = useState('')
  const [importPlan, setImportPlan] = useState<Exclude<MatrixDriveImportPlan, { state: 'cancelled' }> | null>(null)
  const [importPicking, setImportPicking] = useState(false)
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [searchOpen, setSearchOpen] = useState(false)
  const [titleBar, setTitleBar] = useState<{ actions: HTMLElement; status: HTMLElement } | null>(null)

  // The title bar belongs to the page under it (STYLE.md §2): Drive's status and controls go
  // into its slots; without a title bar (tests, embeds) the page keeps its own header.
  useLayoutEffect(() => {
    const actions = document.querySelector<HTMLElement>('[data-atum-page-actions]')
    const status = document.querySelector<HTMLElement>('[data-atum-page-status]')
    setTitleBar(actions && status ? { actions, status } : null)
  }, [])
  const [query, setQuery] = useState('')
  const selection = useStore($matrixDriveTaskSelection)
  const alive = useRef(true)
  const request = useRef(0)
  const generation = useRef(0)
  const busy = activeAction !== null

  const accept = (next: MatrixDriveView) => {
    if (alive.current) {
      setView(previous => (next.revision >= previous.revision ? next : previous))
    }
  }

  useEffect(() => {
    alive.current = true
    const current = ++generation.current
    request.current++
    setView(initial)
    setActiveAction(null)
    setFailed(false)
    setLoading(Boolean(bridge))
    setImportPlan(null)
    setImportPicking(false)
    const active = () => alive.current && current === generation.current

    const receive = (next: MatrixDriveView) => {
      if (active()) {
        accept(next)
      }
    }

    const unsubscribe = bridge?.subscribe(receive)

    if (bridge) {
      void bridge
        .read()
        .then(receive)
        .catch(() => {
          if (active()) {
            setFailed(true)
          }
        })
        .finally(() => {
          if (active()) {
            setLoading(false)
          }
        })
    }

    return () => {
      alive.current = false
      unsubscribe?.()
    }
  }, [bridge])

  const run = async (
    action: () => Promise<MatrixDriveView | { cancelled: true } | void>,
    kind: 'refresh' | 'other' = 'other'
  ) => {
    const token = ++request.current
    setActiveAction(kind)
    setFailed(false)

    try {
      const next = await action()

      if (token === request.current && next && 'state' in next) {
        accept(next)
      }
    } catch {
      if (alive.current && token === request.current) {
        setFailed(true)
      }
    } finally {
      if (alive.current && token === request.current) {
        setActiveAction(null)
      }
    }
  }

  const perform = (action: DriveAction) => {
    if (bridge) {
      void run(() => bridge[action]())
    }
  }

  const chooseImport = async () => {
    if (!bridge?.importPlan || importPicking) {
      return
    }

    const current = generation.current
    setImportPicking(true)

    try {
      const plan = await bridge.importPlan()

      if (!alive.current || current !== generation.current) {
        if ('planId' in plan) {
          await bridge.importCancel?.(plan.planId)
        }
      } else if (plan.state !== 'cancelled') {
        setImportPlan(plan)
      }
    } catch {
      if (alive.current && current === generation.current) {
        setImportPlan({ state: 'refused', reason: 'unavailable' })
      }
    } finally {
      if (alive.current && current === generation.current) {
        setImportPicking(false)
      }
    }
  }

  const selected =
    taskScope &&
    selection.scope &&
    selection.revision === view.revision &&
    selection.scope.userId === taskScope.userId &&
    selection.scope.deviceId === taskScope.deviceId &&
    selection.scope.roomId === taskScope.roomId
      ? selection.selections
      : []

  const taskReady = Boolean(bridge && taskScope && view.state === 'ready')

  useEffect(() => {
    setMatrixDriveTaskScope(taskScope ?? null, taskScope && view.state === 'ready' ? view.revision : null)
  }, [taskScope, view.revision, view.state])

  const firstRead = loading && view.revision === initial.revision && view.state === initial.state

  // A build without Drive has nothing to show: one calm sentence, no controls, no sections.
  if (!loading && view.state === 'unavailable' && !view.canBrowseLocally) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-matrix-drive data-matrix-drive-state="unavailable">
        <h1 className="sr-only">{copy.title}</h1>
        <EmptyState className="m-auto p-8" description={copy.comingSoonHelp} title={copy.comingSoon} />
      </div>
    )
  }

  const phase = matrixDrivePhase(view)
  const failure = failed && <NoticeBand tone="notice">{copy.failed}</NoticeBand>
  // This is an explicit local-root capability. Its absence intentionally preserves the legacy
  // state-driven screen selection for older main processes.
  const browseLocally = view.canBrowseLocally === true
  const legacyFileSurface = view.canBrowseLocally === undefined && phase === 'files'

  if (firstRead || !bridge || (!browseLocally && !legacyFileSurface)) {
    const spec = firstRead || !bridge ? undefined : HERO[phase === 'files' ? 'off' : phase](copy, view)

    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto px-10 py-8"
        data-matrix-drive
        data-matrix-drive-phase={firstRead ? 'loading' : phase}
        data-matrix-drive-state={view.state}
      >
        <h1 className="sr-only">{copy.title}</h1>
        {!spec ? (
          <Loader className="m-auto size-8" label={copy.status.connecting} />
        ) : (
          <div className="m-auto flex w-full max-w-[28rem] flex-col items-center text-center" data-matrix-drive-hero>
            <div className="grid size-16 place-items-center rounded-(--atum-r-card) bg-(--atum-sunk)">
              {spec.working ? (
                <Loader className="size-8" label={spec.title} />
              ) : (
                <Cloud aria-hidden className="size-8 text-(--atum-ink-soft)" strokeWidth={1.4} />
              )}
            </div>
            <h2 className="mt-5 text-(length:--atum-t-heading) leading-(--atum-lh-heading) font-semibold tracking-[-0.015em] text-pretty text-(--atum-ink)">
              {spec.title}
            </h2>
            {spec.body && (
              <p
                className={cn(
                  'mt-2 max-w-[24rem] text-(length:--atum-t-ui) leading-[1.5] text-balance',
                  spec.problem ? 'text-(--atum-ink)' : 'text-(--atum-ink-muted)'
                )}
                data-matrix-drive-problem={view.problem}
                role={spec.problem ? 'status' : undefined}
              >
                {spec.body}
              </p>
            )}
            {(spec.primary || spec.secondary) && (
              <div className="mt-6 flex items-center gap-3">
                {spec.primary && (
                  <Button disabled={busy} onClick={() => perform(spec.primary!.action)} size="lg">
                    {spec.primary.label}
                  </Button>
                )}
                {spec.secondary && (
                  <Button disabled={busy} onClick={() => perform(spec.secondary!.action)} size="lg" variant="text">
                    {spec.secondary.label}
                  </Button>
                )}
              </div>
            )}
            {spec.choose && (
              <Button className="mt-3" disabled={busy} onClick={() => perform('chooseFolder')} size="sm" variant="text">
                {copy.chooseFolder}
              </Button>
            )}
            {failure && <div className="mt-5 w-full">{failure}</div>}
            <div className="mt-8 w-full">
              <DriveWhere copy={copy} view={view} />
            </div>
            <DriveAbout className="mt-3" copy={copy} />
          </div>
        )}
      </div>
    )
  }

  const statusLine =
    view.factsStale && (view.state === 'ready' || view.state === 'syncing')
      ? copy.facts.staleStatus
      : matrixDriveStatusLine(view, copy, locale)

  const listingLine = matrixDriveListingLine(view, copy, locale)
  const problemLine = view.problem ? copy.problem[view.problem] : undefined

  const atRoot = !view.canGoBack
  const matchingRows = view.rows.filter(row =>
    row.name.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))
  )
  const shownRows = destination === 'recents' ? recentDriveRows(matchingRows) : matchingRows
  const recentRows = recentDriveRows(matchingRows).slice(0, 4)

  const openRow = (row: MatrixDriveRow) => {
    if (row.kind === 'folder') {
      onDestinationChange?.('all')
      void run(() => bridge.enter(row.id))
    } else if (onPreview) {
      onPreview(row)
    } else {
      void run(() => bridge.open(row.id))
    }
  }

  // Preserve the old file-surface contract: importing is a sync operation, not an offline/local
  // browsing operation. It stays hidden in states that only retain local read access.
  const importAvailable =
    ['ready', 'syncing'].includes(view.state) && Boolean(bridge.importPlan && bridge.importRun && bridge.importCancel)

  const inlineRecovery =
    view.state === 'reauthenticate' || view.state === 'error'
      ? [{ label: copy.retry, action: 'connect' as const }]
      : view.state === 'paused'
        ? [{ label: copy.resume, action: 'connect' as const }]
        : view.state === 'cleanup_failed'
          ? [{ label: copy.retry, action: 'disconnect' as const }]
          : []

  const driveStatus = (
    <>
      <p className="flex items-center gap-(--ak-s1) [font:var(--ak-t-callout)] text-(--ak-ink-3)" role="status">
        <DriveStatusMark copy={copy} view={view} />
        <span>{statusLine}</span>
      </p>
      <MatrixDriveSkippedNote busy={busy} locale={locale} onReveal={() => void run(() => bridge.reveal())} view={view} />
      {inlineRecovery.map(({ label, action }, index) => (
        <Button
          disabled={busy}
          key={`${action}:${index}`}
          onClick={() => perform(action)}
          size="sm"
          variant={index === 0 ? 'secondary' : 'text'}
        >
          {label}
        </Button>
      ))}
    </>
  )

  const driveControls = (
    <div className="flex shrink-0 items-center gap-(--ak-s1)">
      {searchOpen && (
        <label className="ak-field ak-field--search">
          <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
          <input
            aria-label={copy.search}
            autoFocus
            onChange={event => setQuery(event.currentTarget.value)}
            placeholder={copy.search}
            value={query}
          />
        </label>
      )}
      <div aria-label={copy.viewMode} className="ak-seg ak-seg--sm" role="group">
        <Tip label={copy.listView}>
          <button
            aria-label={copy.listView}
            aria-pressed={layout === 'list'}
            className={layout === 'list' ? 'is-selected' : undefined}
            onClick={() => setLayout('list')}
            type="button"
          >
            <List aria-hidden className="ak-icon ak-icon--sm" />
          </button>
        </Tip>
        <Tip label={copy.gridView}>
          <button
            aria-label={copy.gridView}
            aria-pressed={layout === 'grid'}
            className={layout === 'grid' ? 'is-selected' : undefined}
            onClick={() => setLayout('grid')}
            type="button"
          >
            <LayoutGrid aria-hidden className="ak-icon ak-icon--sm" />
          </button>
      </Tip>
      </div>
      <Tip label={copy.search}>
        <button
          aria-label={copy.search}
          aria-pressed={searchOpen}
          className="ak-iconbtn"
          onClick={() => setSearchOpen(value => !value)}
          type="button"
        >
          <SearchIcon aria-hidden className="ak-icon" />
        </button>
      </Tip>
      <DropdownMenu>
        <Tip label={copy.more}>
          <DropdownMenuTrigger asChild>
            <button aria-label={copy.more} className="ak-iconbtn" type="button">
              <MoreHorizontal aria-hidden className="ak-icon" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy} onSelect={() => void run(() => bridge.reveal())}>
            <FolderOpen aria-hidden />
            {copy.reveal}
          </DropdownMenuItem>
          {importAvailable && (
            <DropdownMenuItem
              disabled={busy || importPicking || Boolean(importPlan)}
              onSelect={() => void chooseImport()}
            >
              {matrixDriveImportCopy[locale].title}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-10 py-6"
      data-matrix-drive
      data-matrix-drive-phase="files"
      data-matrix-drive-state={view.state}
    >
      <div className="mx-auto max-w-4xl">
        {titleBar ? (
          <>
            <h1 className="sr-only">{copy.title}</h1>
            {createPortal(
              <div className="flex min-w-0 items-center gap-(--ak-s3)" data-matrix-drive-status>
                {driveStatus}
              </div>,
              titleBar.status
            )}
            {createPortal(driveControls, titleBar.actions)}
          </>
        ) : (
          <header
            className="flex items-center justify-between gap-(--ak-s4) border-b border-(--ak-line) py-(--ak-s3)"
            data-matrix-drive-titlebar
          >
            <div className="flex min-w-0 items-center gap-(--ak-s3)">
              <h1 className="[font:var(--ak-t-display)] text-(--ak-ink)">{copy.title}</h1>
              {driveStatus}
            </div>
            {driveControls}
          </header>
        )}
        {(listingLine || problemLine) && (
          <div className="grid gap-(--ak-s1) py-(--ak-s2) [font:var(--ak-t-caption)] text-(--ak-ink-3)">
            {listingLine && <p data-matrix-drive-listing={view.listingStatus}>{listingLine}</p>}
            {problemLine && <p data-matrix-drive-problem={view.problem}>{problemLine}</p>}
          </div>
        )}
        <MatrixDriveFacts
          busy={busy}
          formatSize={bytes => formatDriveSize(bytes, locale, view.quota?.total)}
          locale={locale}
          onRefresh={() => void run(() => bridge.read(), 'refresh')}
          onRetry={() => perform('connect')}
          onReveal={() => void run(() => bridge.reveal())}
          view={view}
        />
        {importPlan && (
          <MatrixDriveImportSheet
            bridge={bridge}
            formatSize={bytes => formatDriveSize(bytes, locale)}
            key={'planId' in importPlan ? importPlan.planId : importPlan.reason}
            locale={locale}
            onChanged={() => {
              void bridge
                .read()
                .then(accept)
                .catch(() => {})
            }}
            onClose={() => setImportPlan(null)}
            plan={importPlan}
          />
        )}
        {failure && <div className="mt-4">{failure}</div>}
        {/* Choosing files for a chat only means something once there are files to choose. */}
        {taskReady && selected.length > 0 && (
          <section className="mt-5 border-t border-(--atum-line) pt-3" data-matrix-drive-task-selection>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium">{copy.selectedFiles}</span>
              <Button onClick={clearMatrixDriveTaskSelections} size="sm" variant="text">
                {copy.clearSelection}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {selected.map(selection => (
                <span className="flex items-center gap-1 text-xs" key={selection.id}>
                  {selection.name} ·{' '}
                  {selection.mode === 'read'
                    ? copy.useRead
                    : selection.mode === 'replace'
                      ? copy.replace
                      : copy.createOutput}
                  <Button
                    aria-label={`${copy.removeSelection} ${selection.name}`}
                    onClick={() => removeMatrixDriveTaskSelection(selection.id)}
                    size="icon"
                    type="button"
                    variant="text"
                  >
                    ×
                  </Button>
                </span>
              ))}
            </div>
            {selected.length >= 4 && <p className="mt-2 text-xs text-(--atum-ink-muted)">{copy.selectionLimit}</p>}
            {onUseInConversation && (
              <Button className="mt-2" onClick={onUseInConversation} size="sm" variant="secondary">
                {copy.useConversation}
              </Button>
            )}
          </section>
        )}
        {view.canGoBack && (
          <div className="mt-6 flex min-w-0 items-center gap-2 text-(length:--atum-t-ui)">
            <Button disabled={busy} onClick={() => void run(() => bridge.back())} size="sm" variant="text">
              <ChevronLeft aria-hidden />
              {copy.back}
            </Button>
            <Folder aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
            <span className="truncate font-medium text-(--atum-ink)">{view.folderLabel}</span>
          </div>
        )}
        {destination === 'recents' && recentRows.length > 0 && (
          <section className="mt-(--ak-s5)" data-matrix-drive-recents>
            {/* The page is named for where you are (Atum Kit Drive board: "Recents" in Display). */}
            <h2 className="[font:var(--ak-t-display)] text-(--ak-ink)">{copy.browser.recents}</h2>
            <div className="mt-(--ak-s3) grid grid-cols-[repeat(auto-fit,minmax(calc(var(--ak-h-lg)*3),1fr))] gap-(--ak-s3)">
              {recentRows.map(row => (
                <button
                  aria-label={row.name}
                  className="group min-w-0 text-left"
                  data-matrix-drive-recent={row.id}
                  disabled={busy}
                  key={row.id}
                  onClick={() => openRow(row)}
                  type="button"
                >
                  <span className="grid h-28 place-items-center rounded-(--ak-r-lg) border border-(--ak-line) bg-(--ak-fill-quiet) transition-colors group-hover:bg-(--ak-fill-hover)">
                    {row.kind === 'folder' ? (
                      <Folder aria-hidden className="ak-icon ak-icon--xl text-(--ak-ink-2)" />
                    ) : (
                      <MatrixFileGlyph className="ak-icon ak-icon--xl text-(--ak-ink-2)" name={row.name} />
                    )}
                  </span>
                  <span className="mt-(--ak-s2) block truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)">
                    {row.name}
                  </span>
                  <span className="block truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)">
                    {formatModified(row.modifiedAt, locale)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {shownRows.length ? layout === 'list' ? (
          <table className="mt-5 w-full text-left text-(length:--atum-t-ui)">
            <thead className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">
              <tr>
                <th className="pb-2 ps-2 font-normal">{copy.name}</th>
                <th className="pb-2 pe-5 font-normal">{copy.size}</th>
                <th className="pb-2 font-normal">{copy.modified}</th>
                <th className="pb-2 text-right font-normal">
                  <span className="sr-only">{copy.selectedFiles}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map(row => (
                <Fragment key={row.id}>
                  <tr className="group/row border-t border-(--atum-line) transition-colors hover:bg-(--ak-fill-quiet,var(--atum-hover))">
                    <td className="ps-2">
                      <button
                        className="flex w-full min-w-0 items-center gap-3 py-2.5 text-left text-(--atum-ink) outline-none focus-visible:underline"
                        disabled={busy}
                        onClick={() => openRow(row)}
                        type="button"
                      >
                        {row.kind === 'folder' ? (
                          <Folder
                            aria-hidden
                            className="size-[1.125rem] shrink-0 text-(--atum-ink-soft)"
                            strokeWidth={1.6}
                          />
                        ) : (
                          <MatrixFileGlyph
                            className="size-[1.125rem] shrink-0 text-(--atum-ink-muted)"
                            name={row.name}
                          />
                        )}
                        <span className="truncate">{row.name}</span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap pe-5 text-(length:--atum-t-caption) text-(--atum-ink-muted) tabular-nums">
                      {row.kind === 'file' ? formatDriveSize(row.size, locale) : '—'}
                    </td>
                    <td className="whitespace-nowrap text-(length:--atum-t-caption) text-(--atum-ink-muted) tabular-nums">
                      {formatModified(row.modifiedAt, locale)}
                    </td>
                    {/* A Finder list is calm: a row's actions show on hover or keyboard focus (Atum Kit 0.1). */}
                    <td className="whitespace-nowrap pe-2 text-right text-xs opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                      {taskReady && selected.length < 4 && row.kind === 'file' && (
                        <span className="inline-flex gap-1">
                          <Button
                            onClick={() => selectMatrixDriveFile(row.id, row.name, 'read')}
                            size="sm"
                            variant="text"
                          >
                            {copy.useRead}
                          </Button>
                          <Button
                            onClick={() => selectMatrixDriveFile(row.id, row.name, 'replace')}
                            size="sm"
                            variant="text"
                          >
                            {copy.replace}
                          </Button>
                        </span>
                      )}
                      {taskReady && selected.length < 4 && row.kind === 'folder' && (
                        <Button
                          onClick={() => {
                            setCreateInFolder(row.id)
                            setOutputName('')
                          }}
                          size="sm"
                          variant="text"
                        >
                          {copy.createOutput}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {taskReady && createInFolder === row.id && (
                    <tr className="border-t border-(--atum-line)" key={`${row.id}:create`}>
                      <td className="py-2" colSpan={4}>
                        <div className="flex items-center gap-2">
                          <Input
                            aria-label={copy.outputName}
                            className="min-w-0 flex-1"
                            onChange={event => setOutputName(event.target.value)}
                            placeholder={copy.outputName}
                            value={outputName}
                          />
                          <Button
                            disabled={!validMatrixDriveLeafName(outputName)}
                            onClick={() => {
                              selectMatrixDriveCreate(row.id, row.name, outputName)
                              setCreateInFolder(null)
                              setOutputName('')
                            }}
                            size="sm"
                          >
                            {copy.addOutput}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="mt-(--ak-s4) grid grid-cols-[repeat(auto-fill,minmax(calc(var(--ak-h-lg)*3),1fr))] gap-(--ak-s3)" data-matrix-drive-grid>
            {shownRows.map(row => (
              <button
                className="grid min-w-0 justify-items-center gap-(--ak-s2) rounded-(--ak-r-lg) bg-(--ak-fill-quiet) p-(--ak-s3) text-center [font:var(--ak-t-callout)] text-(--ak-ink)"
                disabled={busy}
                key={row.id}
                onClick={() => openRow(row)}
                type="button"
              >
                {row.kind === 'folder' ? (
                  <Folder aria-hidden className="ak-icon ak-icon--xl text-(--ak-ink-2)" />
                ) : (
                  <MatrixFileGlyph className="ak-icon ak-icon--xl text-(--ak-ink-2)" name={row.name} />
                )}
                <span className="max-w-full truncate">{row.name}</span>
              </button>
            ))}
          </div>
        ) : query.trim() ? (
          <EmptyState title={copy.searchEmpty} />
        ) : view.listingStatus && view.listingStatus !== 'current' ? (
          <div className="mt-16 flex flex-col items-center text-center" data-matrix-drive-local-listing-empty>
            {view.listingStatus === 'loading' ? (
              <Loader className="size-8" label={copy.listing.loading} />
            ) : (
              <>
                <CloudOff aria-hidden className="size-10 text-(--atum-ink-faint)" strokeWidth={1.3} />
                <Button
                  className="mt-5"
                  disabled={busy}
                  onClick={() => void run(() => bridge.read(), 'refresh')}
                  variant="secondary"
                >
                  <RefreshCw aria-hidden className="size-4" />
                  {copy.refresh}
                </Button>
              </>
            )}
          </div>
        ) : view.state === 'offline' ? (
          <div className="mt-16 flex flex-col items-center text-center" data-matrix-drive-offline-empty>
            <CloudOff aria-hidden className="size-10 text-(--atum-ink-faint)" strokeWidth={1.3} />
            <Button className="mt-5" disabled={busy} onClick={() => perform('connect')} variant="secondary">
              <RefreshCw aria-hidden className="size-4" />
              {copy.retry}
            </Button>
          </div>
        ) : atRoot ? (
          // The Drive folder itself, still empty: what to do, and the folder one click away.
          <div className="mt-16 flex flex-col items-center text-center" data-matrix-drive-empty>
            <FolderOpen aria-hidden className="size-10 text-(--atum-ink-faint)" strokeWidth={1.3} />
            <p className="mt-4 text-(length:--atum-t-title) font-medium text-(--atum-ink)">{copy.emptyRoot.title}</p>
            <p className="mt-1 text-(length:--atum-t-ui) text-(--atum-ink-muted)">{copy.emptyRoot.body}</p>
          </div>
        ) : (
          <EmptyState title={copy.empty} />
        )}
        {view.truncated && (
          <p className="mt-3 text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.truncated}</p>
        )}
        <DriveAbout className="mt-10" copy={copy} />
      </div>
    </div>
  )
}

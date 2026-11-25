import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  Clock,
  Cloud,
  CloudCheck,
  CloudOff,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutColumns,
  LayoutGallery,
  LayoutGrid,
  LayoutGroups,
  List,
  MoreHorizontal,
  Pause,
  RefreshCw,
  SearchIcon,
  Settings,
  Upload,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import type {
  MatrixDriveBridge,
  MatrixDriveImportPlan,
  MatrixDriveRow,
  MatrixDriveView
} from '../../shared/matrix-drive'

import { MatrixDriveBrowser, type MatrixDriveItemAction } from './drive-browser'
import { MatrixDriveColumns } from './drive-column-view'
import { type DriveColumn, driveColumns, type DriveColumnTarget, driveWalk } from './drive-columns'
import { matrixDriveCopy } from './drive-copy'
import { MatrixDriveFacts, MatrixDriveSkippedNote } from './drive-facts'
import {
  $matrixDriveGroupBy,
  $matrixDriveHeader,
  $matrixDriveIntent,
  $matrixDriveLayout,
  $matrixDriveListings,
  $matrixDriveLocation,
  $matrixDrivePageFacts,
  $matrixDrivePlaces,
  $matrixDriveQuery,
  currentDrivePlace,
  DRIVE_NAME_ORDER,
  DRIVE_RECENT_ORDER,
  learnMatrixDrivePlaces,
  type MatrixDriveIntent,
  type MatrixDriveLayout,
  type MatrixDriveSort,
  nextDriveSort,
  noteMatrixDriveLocation,
  observeMatrixDriveView,
  rememberMatrixDriveListing,
  requestMatrixDriveIntent,
  setMatrixDriveGroupBy,
  setMatrixDriveLayout,
  sortDriveRows
} from './drive-finder'
import { MatrixDriveGallery } from './drive-gallery-view'
import type { MatrixDriveGroupBy } from './drive-groups'
import { MatrixDriveImportSheet } from './drive-import'
import { matrixDriveImportCopy } from './drive-import-copy'
import { useDriveSearch } from './drive-search'
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
import { setMatrixNavLocal } from './navigation-history'
import { MatrixPlusMenu, type MatrixPlusMenuItem, plusMenuCopy } from './plus-menu'
import { useMatrixDriveRailView } from './rail-badges'
import { $matrixRightPanel, setMatrixRightPanel } from './right-panel'

const initial: MatrixDriveView = { state: 'unavailable', revision: 0, rows: [], canGoBack: false, truncated: false }

/** The bridge whose Drive the sidebar's Favorites were learned from. */
let placesBridge: MatrixDriveBridge | undefined

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
  onOpenSettings,
  onSelect,
  titleBarAction,
  windowControls
}: {
  compact: boolean
  current: MatrixDriveDestination
  /** The foot's gear. */
  onOpenSettings?(): void
  onSelect(destination: MatrixDriveDestination): void
  /** The title bar's ← →, while this column leads the window's row. */
  titleBarAction?: ReactNode
  windowControls: ReactNode
}) {
  const { locale } = useI18n()
  const copy = matrixDriveCopy[locale]
  const plus = plusMenuCopy(locale)
  const folders = useStore($matrixDrivePlaces)
  const place = currentDrivePlace(current, useStore($matrixDriveLocation))
  const query = useStore($matrixDriveQuery)
  // What the Drive page lists, else what Drive publishes; never a read of its own (a read activates Drive).
  const page = useStore($matrixDrivePageFacts)
  const published = useMatrixDriveRailView(window.atumMatrix?.drive)
  const bridge = window.atumMatrix?.drive
  const quota = page?.quota ?? published?.quota

  // Drive's plus menu (layout r2 §4): New folder ⇧⌘N, New document, then the uploads. Only what this
  // build's Drive can do, and only while it lists a folder.
  const browsable = page ? page.browsable : Boolean(published?.canBrowseLocally)

  const plusItems: MatrixPlusMenuItem[] = browsable
    ? [
        ...(bridge?.create
          ? [
              {
                id: 'folder',
                label: plus.newFolder,
                icon: <FolderPlus aria-hidden />,
                shortcut: '⇧⌘N',
                onSelect: () => {
                  onSelect('all')
                  requestMatrixDriveIntent({ kind: 'create', entry: 'folder', name: copy.untitledFolder })
                }
              },
              {
                id: 'document',
                label: plus.newDocument,
                icon: <FileText aria-hidden />,
                onSelect: () => {
                  onSelect('all')
                  requestMatrixDriveIntent({ kind: 'create', entry: 'document', name: copy.untitledDocument })
                }
              }
            ]
          : []),
        ...(bridge?.upload
          ? [
              {
                id: 'files',
                label: plus.uploadFiles,
                icon: <Upload aria-hidden />,
                separated: Boolean(bridge.create),
                onSelect: () => {
                  onSelect('all')
                  requestMatrixDriveIntent({ kind: 'upload', entry: 'files' })
                }
              },
              {
                id: 'upload-folder',
                label: plus.uploadFolder,
                icon: <FolderOpen aria-hidden />,
                onSelect: () => {
                  onSelect('all')
                  requestMatrixDriveIntent({ kind: 'upload', entry: 'folder' })
                }
              }
            ]
          : [])
      ]
    : []

  // ⇧⌘N makes a new folder, as in Finder; ⌘N runs the menu's first item (MatrixPlusMenu).
  const newFolder = plusItems.find(item => item.id === 'folder')?.onSelect
  const newFolderRef = useRef(newFolder)
  newFolderRef.current = newFolder

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === 'n' && newFolderRef.current) {
        event.preventDefault()
        newFolderRef.current()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const row = (key: string, label: string, Icon: typeof Clock, isCurrent: boolean, go: () => void) => (
    <button
      aria-current={isCurrent ? 'page' : undefined}
      className="ak-row atum-row w-full"
      data-current={isCurrent ? 'true' : undefined}
      key={key}
      onClick={go}
      type="button"
    >
      <Icon aria-hidden className="ak-icon ak-icon--sm" />
      <span className="truncate">{label}</span>
    </button>
  )

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
        <span className="flex-1" />
        {titleBarAction}
      </div>
      {/* D: Drive's search (it lists matches in the page) and New (layout r2 D, §4). */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-1 pb-2" data-matrix-drive-search-row>
        <label className="ak-field ak-field--search h-8 min-w-0 flex-1">
          <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
          <input
            aria-label={copy.search}
            data-matrix-drive-search
            onChange={event => $matrixDriveQuery.set(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                $matrixDriveQuery.set('')
              }
            }}
            placeholder={copy.search}
            value={query}
          />
        </label>
        <MatrixPlusMenu items={plusItems} label={plus.newMenu} screen="drive" />
      </div>
      {/* Finder's sidebar on the roster panel itself: Recents, the Drive's own folders as Favorites
          (the owner's and the ones assistants made alike), and the Drive under Locations. */}
      <nav aria-label={copy.title} className="min-h-0 flex-1 overflow-y-auto px-(--ak-s2) pb-(--ak-s3)">
        <div className="flex flex-col pt-(--ak-s2)" data-matrix-drive-places>
          {row('recents', copy.browser.recents, Clock, place?.kind === 'recents', () => {
            onSelect('recents')
            requestMatrixDriveIntent({ kind: 'root' })
          })}
        </div>
        {folders.length > 0 && (
          <>
            <p className="ak-section">{copy.browser.favorites}</p>
            <div className="flex flex-col" data-matrix-drive-favorites>
              {folders.map(name =>
                row(`folder:${name}`, name, Folder, place?.kind === 'folder' && place.name === name, () => {
                  onSelect('all')
                  requestMatrixDriveIntent({ kind: 'folder', name })
                })
              )}
            </div>
          </>
        )}
        <p className="ak-section">{copy.browser.locations}</p>
        <div className="flex flex-col" data-matrix-drive-locations>
          {row('root', copy.browser.drive, Cloud, place?.kind === 'root', () => {
            onSelect('all')
            requestMatrixDriveIntent({ kind: 'root' })
          })}
        </div>
      </nav>
      {/* The left panel's foot (layout r2 E, owner 2026-11-24): storage, then the gear. */}
      <div className="atum-panel-foot" data-matrix-drive-foot>
        {quota && quota.total > 0 ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1 px-2" data-matrix-drive-storage={quota.state}>
            <span className="truncate text-xs text-(--atum-ink-muted)">
              {plus.storage(formatDriveSize(quota.used, locale, quota.total), formatDriveSize(quota.total, locale))}
            </span>
            <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-(--atum-sunk)">
              <span
                className={
                  quota.state === 'critical' || quota.state === 'exceeded'
                    ? 'block h-full bg-(--atum-danger)'
                    : quota.state === 'nearing'
                      ? 'block h-full bg-(--atum-warn)'
                      : 'block h-full bg-(--atum-ink-muted)'
                }
                style={{ width: `${Math.min(100, Math.max(2, (quota.used / quota.total) * 100))}%` }}
              />
            </span>
          </div>
        ) : (
          <span className="flex-1" />
        )}
        {onOpenSettings && (
          <Tip label={plus.settings}>
            <button
              aria-label={plus.settings}
              className="ak-iconbtn ak-iconbtn--sm"
              data-matrix-drive-settings
              onClick={onOpenSettings}
              type="button"
            >
              <Settings aria-hidden className="ak-icon" />
            </button>
          </Tip>
        )}
      </div>
    </aside>
  )
}

/** The title bar's lead for Drive: the open place's name. Its own ‹ › gave way to the window's ← →
 * (layout r1/r2, owner 2026-11-24), which step through Drive's places as through every screen's. */
export function MatrixDriveTitle() {
  const { locale } = useI18n()
  const copy = matrixDriveCopy[locale]
  const header = useStore($matrixDriveHeader)

  return (
    <h1 className="truncate [font:var(--ak-t-headline)] text-(--ak-ink)" data-matrix-drive-nav>
      {header?.title ?? copy.title}
    </h1>
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
  const layout = useStore($matrixDriveLayout)
  const groupBy = useStore($matrixDriveGroupBy)
  const location = useStore($matrixDriveLocation)
  const listings = useStore($matrixDriveListings)
  const [selectedItem, setSelectedItem] = useState<{ place: string; id: string } | null>(null)

  const [sortChoice, setSortChoice] = useState<{ destination: MatrixDriveDestination; sort: MatrixDriveSort } | null>(
    null
  )

  const [titleBar, setTitleBar] = useState<{ actions: HTMLElement; status: HTMLElement } | null>(null)

  // The title bar belongs to the page under it (STYLE.md §2): Drive's status and controls go
  // into its slots; without a title bar (tests, embeds) the page keeps its own header.
  useLayoutEffect(() => {
    const actions = document.querySelector<HTMLElement>('[data-atum-page-actions]')
    const status = document.querySelector<HTMLElement>('[data-atum-page-status]')
    setTitleBar(actions && status ? { actions, status } : null)
  }, [])
  const query = useStore($matrixDriveQuery)
  const setQuery = (next: string) => $matrixDriveQuery.set(next)
  const folderInfoOpen = useStore($matrixRightPanel).drive
  const [searchScope, setSearchScope] = useState<'drive' | 'folder'>('drive')
  const search = useDriveSearch(bridge, view, query, searchScope)
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
  const unavailable = !loading && view.state === 'unavailable' && !view.canBrowseLocally
  const phase = matrixDrivePhase(view)
  // This is an explicit local-root capability. Its absence intentionally preserves the legacy
  // state-driven screen selection for older main processes.
  const browseLocally = view.canBrowseLocally === true
  const legacyFileSurface = view.canBrowseLocally === undefined && phase === 'files'
  const showsFiles = Boolean(bridge) && !firstRead && !unavailable && (browseLocally || legacyFileSurface)

  // The sidebar's Favorites and the followed path belong to one account's Drive.
  useEffect(() => {
    if (bridge !== placesBridge) {
      placesBridge = bridge
      learnMatrixDrivePlaces(null, locale)
    }
  }, [bridge, locale])

  useEffect(() => {
    if (firstRead) {
      return
    }

    if (showsFiles) {
      learnMatrixDrivePlaces(view, locale)
      observeMatrixDriveView(view)
    } else {
      learnMatrixDrivePlaces(null, locale)
    }

    // The left panel's plus menu and storage read what this page lists (it never reads Drive itself).
    $matrixDrivePageFacts.set({ browsable: Boolean(showsFiles && view.canBrowseLocally !== false), quota: view.quota })
  }, [firstRead, locale, showsFiles, view])

  useEffect(() => () => $matrixDrivePageFacts.set(null), [])

  const forwardName = location.forward.at(-1)
  const forwardRow = forwardName ? view.rows.find(row => row.kind === 'folder' && row.name === forwardName) : undefined

  const placeTitle =
    destination === 'recents'
      ? copy.browser.recents
      : view.canGoBack
        ? view.folderLabel || copy.browser.drive
        : copy.browser.drive

  useEffect(() => {
    $matrixDriveHeader.set(
      showsFiles ? { title: placeTitle, canBack: view.canGoBack, canForward: Boolean(forwardRow) } : null
    )
  }, [forwardRow, placeTitle, showsFiles, view.canGoBack])

  useEffect(() => () => $matrixDriveHeader.set(null), [])

  // The window's ← → step through Drive's own folders first, as Finder's ‹ › did (layout r2 §1), then
  // through the window's places.
  const canGoBack = showsFiles && view.canGoBack
  const canGoForward = showsFiles && Boolean(forwardRow)

  useEffect(() => {
    setMatrixNavLocal({
      back: canGoBack,
      forward: canGoForward,
      step: delta => requestMatrixDriveIntent({ kind: delta < 0 ? 'back' : 'forward' })
    })
  }, [canGoBack, canGoForward])

  useEffect(() => () => setMatrixNavLocal(null), [])

  const latestView = useRef(view)
  // The columns as they stood before a walk: its in-between listings never show.
  const steadyColumns = useRef<DriveColumn[]>([])
  const navigate = useRef<(intent: MatrixDriveIntent) => void>(() => {})

  // A selection belongs to the place it was made in.
  const placeKeyOf = (where: Pick<MatrixDriveView, 'canGoBack' | 'folderLabel'>) =>
    `${destination}\u0000${where.canGoBack}\u0000${where.folderLabel ?? ''}`

  const enterFolder = (row: MatrixDriveRow) => {
    if (!bridge) {
      return
    }

    if (row.folders) {
      // A search handle can enter a folder anywhere in Drive. Commit the learned location only
      // after main confirms its listing, never by guessing from a clicked result.
      noteMatrixDriveLocation({ type: 'walk' })
      onDestinationChange?.('all')
      void run(async () => {
        try {
          const next = await bridge.enter(row.id)
          const listed = next.listingStatus === 'current' || next.listingStatus === 'partial'
          noteMatrixDriveLocation({ type: 'arrive', path: listed ? [...row.folders!, row.name] : null })
          setQuery('')

          return next
        } catch (error) {
          noteMatrixDriveLocation({ type: 'arrive', path: null })
          throw error
        }
      })

      return
    }

    noteMatrixDriveLocation({ type: 'enter', name: row.name })

    onDestinationChange?.('all')
    void run(() => bridge.enter(row.id))
  }

  /** The sidebar's places: up to the Drive's root, then into the named top-level folder. */
  const jump = (name: string | null) => {
    if (!bridge) {
      return
    }

    noteMatrixDriveLocation({ type: 'jump' })
    void run(async () => {
      let next = latestView.current

      for (let step = 0; next.canGoBack && step < 64; step++) {
        next = await bridge.back()
      }

      observeMatrixDriveView(next)
      const folder = name ? next.rows.find(row => row.kind === 'folder' && row.name === name) : undefined

      if (!folder) {
        return next
      }

      noteMatrixDriveLocation({ type: 'enter', name: folder.name })

      return bridge.enter(folder.id)
    })
  }

  useEffect(() => {
    latestView.current = view

    navigate.current = intent => {
      if (!bridge || !showsFiles) {
        return
      }

      if (intent.kind === 'back') {
        if (view.canGoBack) {
          const from = view.folderLabel ?? ''
          noteMatrixDriveLocation({ type: 'back', from })
          void run(async () => {
            const next = await bridge.back()
            // As in Finder, the folder you came out of is the one selected.
            const came = next.rows.find(row => row.kind === 'folder' && row.name === from)

            if (came && alive.current) {
              setSelectedItem({ place: placeKeyOf(next), id: came.id })
            }

            return next
          })
        }
      } else if (intent.kind === 'forward') {
        if (forwardRow) {
          enterFolder(forwardRow)
        }
      } else if (intent.kind === 'create') {
        if (bridge.create) {
          const create = bridge.create
          void run(() => create(intent.entry, intent.name))
        }
      } else if (intent.kind === 'upload') {
        if (bridge.upload) {
          const upload = bridge.upload
          void run(() => upload(intent.entry))
        }
      } else {
        jump(intent.kind === 'folder' ? intent.name : null)
      }
    }
  })

  useEffect(() => $matrixDriveIntent.listen(intent => intent && navigate.current(intent)), [])

  const placeKey = placeKeyOf(view)
  const selectedId = selectedItem?.place === placeKey ? selectedItem.id : null
  const selectItem = (id: string | null) => setSelectedItem(id ? { place: placeKey, id } : null)

  // A build without Drive has nothing to show: one calm sentence, no controls, no sections.
  if (unavailable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-matrix-drive data-matrix-drive-state="unavailable">
        <h1 className="sr-only">{copy.title}</h1>
        <EmptyState className="m-auto p-8" description={copy.comingSoonHelp} title={copy.comingSoon} />
      </div>
    )
  }

  const failure = failed && <NoticeBand tone="notice">{copy.failed}</NoticeBand>

  if (!showsFiles || !bridge) {
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

  const matchingRows = search.enabled ? search.result?.rows ?? [] : view.rows.filter(row =>
    row.name.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))
  )

  const sort =
    sortChoice?.destination === destination
      ? sortChoice.sort
      : destination === 'recents'
        ? DRIVE_RECENT_ORDER
        : DRIVE_NAME_ORDER

  const shownRows = sortDriveRows(matchingRows, sort, locale)
  const selectedRow = shownRows.find(row => row.id === selectedId)

  const openRow = (row: MatrixDriveRow) => {
    if (row.kind === 'folder') {
      enterFolder(row)
    } else if (onPreview) {
      onPreview(row)
    } else {
      void run(() => bridge.open(row.id))
    }
  }

  // Search shows its matches as a list, as Finder does from the column view.
  const shownLayout: MatrixDriveLayout = query.trim() && (search.enabled || layout === 'column') ? 'list' : layout

  if (!location.walking && !query.trim()) {
    steadyColumns.current = driveColumns(location.path, shownRows, listings).map(column =>
      column.live ? column : { ...column, rows: sortDriveRows(column.rows, sort, locale) }
    )
  }

  const columns = steadyColumns.current

  /**
   * The column view's moves. The bridge lists one folder at a time, so another column's folder is
   * reached step by step: up to the folder both share, then down by name. Each listing on the way is
   * remembered for its column; then the target item is selected, or opened.
   */
  const walkTo = (target: DriveColumnTarget, then?: 'open') => {
    const from = location.path

    if (!from) {
      return
    }

    const steps = driveWalk(from, target.path)

    const land = (next: MatrixDriveView) => {
      const row = target.selected ? next.rows.find(item => item.kind === 'file' && item.name === target.selected) : undefined

      if (!alive.current) {
        return
      }

      setSelectedItem(row ? { place: placeKeyOf(next), id: row.id } : null)

      if (row && then === 'open') {
        openRow(row)
      }
    }

    if (target.path.length) {
      onDestinationChange?.('all')
    }

    if (!steps.back && !steps.enter.length) {
      land(latestView.current)

      return
    }

    noteMatrixDriveLocation({ type: 'walk' })
    void run(async () => {
      let next = latestView.current
      let at: string[] | null = [...from]

      // A step main couldn't list (a kept older listing) leaves the place unknown rather than guessed.
      const settled = (step: MatrixDriveView, place: string[]) => {
        next = step

        if (step.listingStatus !== 'stale' && step.listingStatus !== 'loading') {
          rememberMatrixDriveListing(place, step.rows)

          return place
        }

        return null
      }

      try {
        for (let step = 0; step < steps.back && at; step++) {
          at = settled(await bridge.back(), at.slice(0, -1))
        }

        for (const name of steps.enter) {
          const folder = at && next.rows.find(item => item.kind === 'folder' && item.name === name)

          if (!at || !folder) {
            break
          }

          at = settled(await bridge.enter(folder.id), [...at, name])
        }
      } finally {
        noteMatrixDriveLocation({ type: 'arrive', path: at })
      }

      if (at && at.length === target.path.length && at.every((name, index) => name === target.path[index])) {
        land(next)
      } else if (alive.current) {
        setSelectedItem(null)
      }

      return next
    })
  }

  // What the assistant may do with an item in this chat: read or edit a file, save a result into a folder.
  const taskActions = (row: MatrixDriveRow): MatrixDriveItemAction[] => {
    if (!taskReady || selected.length >= 4) {
      return []
    }

    return row.kind === 'file'
      ? [
          { label: copy.useRead, run: () => selectMatrixDriveFile(row.id, row.name, 'read') },
          { label: copy.replace, run: () => selectMatrixDriveFile(row.id, row.name, 'replace') }
        ]
      : [
          {
            label: copy.createOutput,
            run: () => {
              selectItem(row.id)
              setCreateInFolder(row.id)
              setOutputName('')
            }
          }
        ]
  }

  const selectedActions = selectedRow ? taskActions(selectedRow) : []

  const viewProps = {
    formatDate: (at: number) => formatModified(at, locale),
    formatSize: (bytes: number) => formatDriveSize(bytes, locale),
    itemActions: taskActions,
    locale,
    onNavigate: (direction: 'back' | 'forward') => navigate.current({ kind: direction }),
    onOpen: openRow,
    onQuickLook: onPreview,
    onSelect: selectItem,
    rows: shownRows,
    selectedId,
    view
  }

  const creating = Boolean(taskReady && selectedRow && createInFolder === selectedRow.id)

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

  const views = [
    { id: 'icon' as const, label: copy.gridView, icon: LayoutGrid },
    { id: 'list' as const, label: copy.listView, icon: List },
    { id: 'column' as const, label: copy.columnView, icon: LayoutColumns },
    { id: 'gallery' as const, label: copy.galleryView, icon: LayoutGallery }
  ]

  const groupings: { id: MatrixDriveGroupBy; label: string }[] = [
    { id: 'none', label: copy.groups.none },
    { id: 'kind', label: copy.groups.kind },
    { id: 'modified', label: copy.groups.modified },
    { id: 'size', label: copy.groups.size }
  ]

  // Finder groups icons and lists; columns and the gallery have their own order.
  const groupable = shownLayout === 'icon' || shownLayout === 'list'

  // Finder's toolbar, right side: the view switch and "…". Search is in the left panel (layout r2 D).
  const driveControls = (
    <div className="flex shrink-0 items-center gap-(--ak-s1)">
      <div aria-label={copy.viewMode} className="ak-seg ak-seg--sm" role="group">
        {views.map(({ id, label, icon: Icon }) => (
          <Tip key={id} label={label}>
            <button
              aria-label={label}
              aria-pressed={layout === id}
              className={layout === id ? 'is-selected' : undefined}
              onClick={() => setMatrixDriveLayout(id)}
              type="button"
            >
              <Icon aria-hidden className="ak-icon ak-icon--sm" />
            </button>
          </Tip>
        ))}
      </div>
      <DropdownMenu>
        <Tip label={copy.groups.title}>
          <DropdownMenuTrigger asChild disabled={!groupable}>
            <button
              aria-label={copy.groups.title}
              className="ak-iconbtn disabled:pointer-events-none disabled:opacity-38"
              data-matrix-drive-group-menu={groupBy}
              type="button"
            >
              <LayoutGroups aria-hidden className="ak-icon" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuLabel>{copy.groups.title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup onValueChange={value => setMatrixDriveGroupBy(value as MatrixDriveGroupBy)} value={groupBy}>
            {groupings.map(({ id, label }) => (
              <DropdownMenuRadioItem key={id} value={id}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
    <div className="flex min-h-0 flex-1 overflow-hidden" data-matrix-drive-row>
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-matrix-drive
      data-matrix-drive-phase="files"
      data-matrix-drive-state={view.state}
    >
      {titleBar ? (
        <>
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
          className="flex items-center justify-between gap-(--ak-s4) border-b border-(--ak-line) px-(--ak-s6) py-(--ak-s3)"
          data-matrix-drive-titlebar
        >
          <div className="flex min-w-0 items-center gap-(--ak-s3)">
            <MatrixDriveTitle />
            {driveStatus}
          </div>
          {driveControls}
        </header>
      )}
      {query.trim() && bridge.search && (
        <div
          className="flex items-center gap-(--ak-s3) border-b border-(--ak-line) px-(--ak-s6) py-(--ak-s2) [font:var(--ak-t-callout)] text-(--ak-ink-3)"
          data-matrix-drive-search-scope
        >
          <span>{copy.searchScope.title}</span>
          <div aria-label={copy.searchScope.title} className="ak-seg ak-seg--sm" role="group">
            {(['drive', 'folder'] as const).map(scope => (
              <button
                aria-pressed={searchScope === scope}
                className={searchScope === scope ? 'is-selected' : undefined}
                key={scope}
                onClick={() => setSearchScope(scope)}
                type="button"
              >
                {scope === 'drive' ? copy.searchScope.drive : view.folderLabel || copy.browser.drive}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className="flex min-h-full flex-1 flex-col px-(--ak-s6) pt-(--ak-s3) pb-(--ak-s5)"
        onClick={event => event.target === event.currentTarget && selectItem(null)}
      >
        {(listingLine || problemLine) && (
          <div className="grid gap-(--ak-s1) pb-(--ak-s2) [font:var(--ak-t-caption)] text-(--ak-ink-3)">
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
          <section className="mb-(--ak-s3) border-b border-(--ak-line) pb-(--ak-s3)" data-matrix-drive-task-selection>
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
        {search.loading ? (
          <Loader className="m-auto size-8" label={copy.searchScope.searching} />
        ) : search.failed ? (
          <NoticeBand tone="notice">{copy.failed}</NoticeBand>
        ) : shownLayout === 'column' && (shownRows.length > 0 || Boolean(location.path?.length)) ? (
          <MatrixDriveColumns
            {...viewProps}
            columns={columns}
            onPick={walkTo}
            path={location.path}
            rootLabel={destination === 'recents' ? copy.browser.recents : copy.browser.drive}
          />
        ) : shownRows.length && shownLayout === 'gallery' ? (
          <MatrixDriveGallery {...viewProps} bridge={bridge} />
        ) : shownRows.length ? (
          <MatrixDriveBrowser
            {...viewProps}
            groupBy={groupable ? groupBy : 'none'}
            layout={shownLayout === 'list' ? 'list' : 'icon'}
            onSort={key => setSortChoice({ destination, sort: nextDriveSort(sort, key) })}
            sort={sort}
          />
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
        {(search.enabled ? search.result?.truncated : view.truncated) && (
          <p className="mt-3 text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.truncated}</p>
        )}
        {/* In a chat, the selected item's actions float over the bottom of the page, Finder-calm. */}
        {selectedRow && (selectedActions.length > 0 || creating) && (
          <div
            className="pointer-events-none sticky bottom-(--ak-s4) z-10 mt-(--ak-s4) flex justify-center"
            data-matrix-drive-selection-bar
          >
            <div className="ak-glass pointer-events-auto flex max-w-full min-w-0 items-center gap-(--ak-s2) rounded-(--ak-r-full) py-(--ak-s1) ps-(--ak-s4) pe-(--ak-s1)">
              <span className="min-w-0 truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)">{selectedRow.name}</span>
              {creating ? (
                <>
                  <Input
                    aria-label={copy.outputName}
                    autoFocus
                    className="h-7 w-48"
                    onChange={event => setOutputName(event.target.value)}
                    placeholder={copy.outputName}
                    value={outputName}
                  />
                  <Button
                    disabled={!validMatrixDriveLeafName(outputName)}
                    onClick={() => {
                      selectMatrixDriveCreate(selectedRow.id, selectedRow.name, outputName)
                      setCreateInFolder(null)
                      setOutputName('')
                    }}
                    size="sm"
                  >
                    {copy.addOutput}
                  </Button>
                </>
              ) : (
                selectedActions.map(action => (
                  <Button key={action.label} onClick={action.run} size="sm" variant="text">
                    {action.label}
                  </Button>
                ))
              )}
            </div>
          </div>
        )}
        <DriveAbout className="mt-auto pt-(--ak-s8)" copy={copy} />
      </div>
    </div>
    {/* The neutral right panel (layout r2 §2): the open folder's info. Closed by default, remembered. */}
    {folderInfoOpen && (
      <MatrixDriveFolderInfo
        copy={copy}
        locale={locale}
        onClose={() => setMatrixRightPanel('drive', false)}
        onReveal={() => void run(() => bridge.reveal())}
        statusLine={statusLine}
        view={view}
      />
    )}
    </div>
  )
}

/** Five locales, changed together. */
const folderInfoCopies: Record<Locale, { title: string; close: string; items: (n: number) => string; size: string; where: string; changed: string; sync: string; reveal: string }> = {
  en: { title: 'Folder info', close: 'Close', items: n => `${n} ${n === 1 ? 'item' : 'items'}`, size: 'Size', where: 'Where', changed: 'Changed', sync: 'Sync', reveal: 'Show in Finder' },
  vi: { title: 'Thông tin thư mục', close: 'Đóng', items: n => `${n} mục`, size: 'Dung lượng', where: 'Vị trí', changed: 'Thay đổi', sync: 'Đồng bộ', reveal: 'Hiện trong Finder' },
  ja: { title: 'フォルダの情報', close: '閉じる', items: n => `${n} 項目`, size: 'サイズ', where: '場所', changed: '変更日', sync: '同期', reveal: 'Finder で表示' },
  zh: { title: '文件夹信息', close: '关闭', items: n => `${n} 项`, size: '大小', where: '位置', changed: '修改时间', sync: '同步', reveal: '在访达中显示' },
  'zh-hant': { title: '檔案夾資訊', close: '關閉', items: n => `${n} 項`, size: '大小', where: '位置', changed: '修改時間', sync: '同步', reveal: '在 Finder 中顯示' }
}

/**
 * Drive's neutral right panel (layout r2 §2, owner 2026-11-24): the open folder's size and count, where it
 * is, when it last changed, and its sync. Selecting a file opens its preview in the side panel instead.
 */
function MatrixDriveFolderInfo({
  copy,
  locale,
  onClose,
  onReveal,
  statusLine,
  view
}: {
  copy: DriveCopy
  locale: Locale
  onClose(): void
  onReveal(): void
  statusLine: ReactNode
  view: MatrixDriveView
}) {
  const words = folderInfoCopies[locale]
  const location = useStore($matrixDriveLocation)
  const size = view.rows.reduce((total, row) => total + (row.kind === 'file' ? row.size : 0), 0)
  const changed = view.rows.reduce((latest, row) => Math.max(latest, row.modifiedAt), 0)
  const name = view.folderLabel || copy.browser.drive
  const where = [copy.browser.drive, ...(location.path ?? [])].join(' › ')

  const fact = (label: string, value: ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-(--atum-ink-muted)">{label}</dt>
      <dd className="min-w-0 truncate text-end text-(--atum-ink)">{value}</dd>
    </div>
  )

  return (
    <aside aria-label={words.title} className="atum-neutral-panel" data-matrix-drive-folder-info>
      <header className="atum-neutral-panel-head">
        <Folder aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
        <h2 className="min-w-0 flex-1 truncate">{name}</h2>
        <Tip label={words.close}>
          <button aria-label={words.close} className="ak-iconbtn ak-iconbtn--sm" onClick={onClose} type="button">
            <X aria-hidden className="ak-icon" />
          </button>
        </Tip>
      </header>
      <div className="atum-neutral-panel-body">
        <dl className="atum-neutral-panel-card flex flex-col gap-2">
          {fact(words.size, `${formatDriveSize(size, locale)} · ${words.items(view.rows.length)}`)}
          {fact(words.where, where)}
          {changed > 0 &&
            fact(words.changed, new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(changed))}
          {fact(words.sync, statusLine)}
        </dl>
        <button className="ak-btn ak-btn--secondary ak-btn--sm self-start" data-matrix-drive-folder-reveal onClick={onReveal} type="button">
          <FolderOpen aria-hidden className="ak-icon ak-icon--sm" />
          {words.reveal}
        </button>
      </div>
    </aside>
  )
}

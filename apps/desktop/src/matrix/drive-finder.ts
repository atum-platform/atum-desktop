import { atom } from 'nanostores'

import type { MatrixDriveRow, MatrixDriveView } from '../../shared/matrix-drive'

import type { MatrixDriveGroupBy } from './drive-groups'

/** Finder's four views. */
export type MatrixDriveLayout = 'icon' | 'list' | 'column' | 'gallery'

const LAYOUTS: readonly MatrixDriveLayout[] = ['icon', 'list', 'column', 'gallery']
const GROUPINGS: readonly MatrixDriveGroupBy[] = ['none', 'kind', 'modified', 'size']
const LAYOUT_KEY = 'io.atum.drive.layout'
const GROUP_KEY = 'io.atum.drive.group'

/** A stored view, or icons (as Finder opens) for anything else. */
export function parseDriveLayout(value: string | null): MatrixDriveLayout {
  return LAYOUTS.find(layout => layout === value) ?? 'icon'
}

/** A stored grouping, or none (Finder's default) for anything else. */
export function parseDriveGroupBy(value: string | null): MatrixDriveGroupBy {
  return GROUPINGS.find(group => group === value) ?? 'none'
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage off: the choice lasts for this window.
  }
}

/** Icons by default, as Finder opens; the person's choice is kept on this Mac. */
export const $matrixDriveLayout = atom<MatrixDriveLayout>(parseDriveLayout(stored(LAYOUT_KEY)))

export function setMatrixDriveLayout(layout: MatrixDriveLayout): void {
  $matrixDriveLayout.set(layout)
  store(LAYOUT_KEY, layout)
}

/** Finder's Group By, off by default and kept on this Mac like the view. */
export const $matrixDriveGroupBy = atom<MatrixDriveGroupBy>(parseDriveGroupBy(stored(GROUP_KEY)))

export function setMatrixDriveGroupBy(group: MatrixDriveGroupBy): void {
  $matrixDriveGroupBy.set(group)
  store(GROUP_KEY, group)
}

export type MatrixDriveSortKey = 'name' | 'modified' | 'size'

export interface MatrixDriveSort {
  key: MatrixDriveSortKey
  direction: 'asc' | 'desc'
}

export const DRIVE_NAME_ORDER: MatrixDriveSort = { key: 'name', direction: 'asc' }
export const DRIVE_RECENT_ORDER: MatrixDriveSort = { key: 'modified', direction: 'desc' }

/** Finder's order: names as a person reads them ("Report 2" before "Report 10"), folders mixed in. */
export function sortDriveRows(rows: readonly MatrixDriveRow[], sort: MatrixDriveSort, locale: string): MatrixDriveRow[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const sign = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    if (sort.key === 'modified' && a.modifiedAt !== b.modifiedAt) {
      return sign * (a.modifiedAt - b.modifiedAt)
    }

    if (sort.key === 'size') {
      // A folder has no size of its own; it sorts below the smallest file.
      const left = a.kind === 'folder' ? -1 : a.size
      const right = b.kind === 'folder' ? -1 : b.size

      if (left !== right) {
        return sign * (left - right)
      }
    }

    return (sort.key === 'name' ? sign : 1) * collator.compare(a.name, b.name)
  })
}

/** A header click: the same column flips; a new one starts where Finder starts it (dates newest first). */
export function nextDriveSort(current: MatrixDriveSort, key: MatrixDriveSortKey): MatrixDriveSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }

  return { key, direction: key === 'name' ? 'asc' : 'desc' }
}

/** An item's badge: synced, waiting to sync, or not syncing while Drive can't. */
export type MatrixDriveItemSync = 'synced' | 'pending' | 'paused'

/**
 * The engine reports Drive-wide facts, not a status per file. An item that has not changed since
 * Drive last finished syncing is synced; one changed later is still waiting. Stale facts show no
 * badge rather than a guess.
 */
export function driveItemSync(
  row: Pick<MatrixDriveRow, 'modifiedAt'>,
  view: Pick<MatrixDriveView, 'state' | 'lastSyncAt' | 'factsStale'>
): MatrixDriveItemSync | null {
  if (view.factsStale) {
    return null
  }

  const settled = view.lastSyncAt === undefined ? view.state === 'ready' : row.modifiedAt <= view.lastSyncAt

  if (view.state === 'ready' || view.state === 'syncing') {
    return settled ? 'synced' : 'pending'
  }

  return settled && view.lastSyncAt !== undefined ? 'synced' : 'paused'
}

/**
 * The next item for an arrow key, Home or End, or null when the key does not move. `columns` is
 * how many items one row of the icon grid holds (1 in the list). Down into a shorter last row
 * lands on its last item, as Finder does.
 */
export function moveDriveSelection(count: number, index: number, key: string, columns: number): number | null {
  if (count === 0) {
    return null
  }

  if (index < 0) {
    return ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home'].includes(key) ? 0 : key === 'End' ? count - 1 : null
  }

  const across = Math.max(1, columns)

  switch (key) {
    case 'Home':
      return 0

    case 'End':
      return count - 1

    case 'ArrowLeft':
      return across > 1 ? Math.max(0, index - 1) : null

    case 'ArrowRight':
      return across > 1 ? Math.min(count - 1, index + 1) : null

    case 'ArrowUp':
      return index - across >= 0 ? index - across : index
    case 'ArrowDown': {
      if (index + across < count) {
        return index + across
      }

      return Math.floor((count - 1) / across) > Math.floor(index / across) ? count - 1 : index
    }

    default:
      return null
  }
}

/** Type a name's first letters to jump to it. */
export function typeSelectDriveRow(rows: readonly Pick<MatrixDriveRow, 'name'>[], typed: string, locale: string): number {
  const prefix = typed.toLocaleLowerCase(locale)

  return prefix ? rows.findIndex(row => row.name.toLocaleLowerCase(locale).startsWith(prefix)) : -1
}

function graphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(part => part.segment)
  }

  return Array.from(value)
}

/** Finder cuts a long name in the middle, so its start and its type both stay readable. */
export function middleTruncateDriveName(name: string, max: number): string {
  const characters = graphemes(name)

  if (characters.length <= max) {
    return name
  }

  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)

  return `${characters.slice(0, head).join('').trimEnd()}…${characters.slice(-tail).join('').trimStart()}`
}

/** The Drive's top-level folders, learned from its root listing: the sidebar's Favorites. Memory only. */
export const $matrixDrivePlaces = atom<readonly string[]>([])

/**
 * Where the open folder is, as far as this window has followed it: `path` is the folder names from
 * the root (null when Drive was already deep in a folder this window never saw it enter), and
 * `forward` holds the folders Back left, for Forward.
 */
export interface MatrixDriveLocation {
  path: readonly string[] | null
  forward: readonly string[]
  pending: { kind: 'enter'; name: string } | { kind: 'back' } | null
  /** A multi-step walk (the column view) is under way: its in-between views say nothing. */
  walking?: true
}

export type MatrixDriveLocationEvent =
  | { type: 'enter'; name: string }
  | { type: 'back'; from: string }
  | { type: 'jump' }
  | { type: 'walk' }
  | { type: 'arrive'; path: readonly string[] | null }
  | { type: 'view'; view: Pick<MatrixDriveView, 'canGoBack' | 'folderLabel' | 'listingStatus'> }

export const DRIVE_AT_ROOT: MatrixDriveLocation = { path: [], forward: [], pending: null }

/**
 * Follows navigation from the views main sends back. A view can arrive before or after the call that
 * caused it resolves, so a step is only counted when a view shows where it led.
 */
export function reduceDriveLocation(state: MatrixDriveLocation, event: MatrixDriveLocationEvent): MatrixDriveLocation {
  switch (event.type) {
    case 'enter': {
      const forward = state.forward.at(-1) === event.name ? state.forward.slice(0, -1) : []

      return { ...state, forward, pending: { kind: 'enter', name: event.name } }
    }

    case 'back':
      return { ...state, forward: [...state.forward, event.from], pending: { kind: 'back' } }

    case 'jump':
      return { path: state.path, forward: [], pending: null }

    case 'walk':
      return { ...state, forward: [], pending: null, walking: true }

    // The walk knows where each of its steps led; it says where it ended.
    case 'arrive':
      return { path: event.path, forward: [], pending: null }
    case 'view': {
      const { view } = event

      // A scan in flight still describes the folder being left.
      if (view.listingStatus === 'loading' || state.walking) {
        return state
      }

      if (!view.canGoBack) {
        // The root's own refresh can arrive while a folder is still opening.
        return { ...state, path: [], pending: state.pending?.kind === 'enter' ? state.pending : null }
      }

      const label = view.folderLabel ?? ''
      const path = state.path

      if (state.pending?.kind === 'enter' && label === state.pending.name) {
        return { ...state, path: path ? [...path, label] : null, pending: null }
      }

      if (state.pending?.kind === 'back' && path && path.length >= 2 && path.at(-2) === label) {
        return { ...state, path: path.slice(0, -1), pending: null }
      }

      if (path?.at(-1) === label) {
        return state
      }

      return { ...state, path: null, pending: null }
    }
  }
}

export const $matrixDriveLocation = atom<MatrixDriveLocation>(DRIVE_AT_ROOT)

export function noteMatrixDriveLocation(event: MatrixDriveLocationEvent): void {
  $matrixDriveLocation.set(reduceDriveLocation($matrixDriveLocation.get(), event))
}

/** A place in the Drive as a key: its folder names from the root. */
export function driveListingKey(path: readonly string[]): string {
  return path.join('\u0000')
}

const LISTINGS_KEPT = 64

/**
 * The folders this window has listed, under their place in the Drive: the column view draws the
 * folders on the open path from these. Memory only, a bounded few, the newest kept. Their item ids
 * expire with the listing; only names are used to walk back to them.
 */
export const $matrixDriveListings = atom<ReadonlyMap<string, readonly MatrixDriveRow[]>>(new Map())

export function rememberMatrixDriveListing(path: readonly string[], rows: readonly MatrixDriveRow[]): void {
  const next = new Map($matrixDriveListings.get())
  const key = driveListingKey(path)
  next.delete(key)
  next.set(key, rows)

  for (const oldest of next.keys()) {
    if (next.size <= LISTINGS_KEPT) {
      break
    }

    next.delete(oldest)
  }

  $matrixDriveListings.set(next)
}

/** Follow a view main sent back, and remember its listing once its place in the Drive is known. */
export function observeMatrixDriveView(view: Pick<MatrixDriveView, 'canGoBack' | 'folderLabel' | 'listingStatus' | 'rows'>): void {
  noteMatrixDriveLocation({ type: 'view', view })
  const { path, walking } = $matrixDriveLocation.get()

  if (path && !walking && view.listingStatus !== 'loading') {
    rememberMatrixDriveListing(path, view.rows)
  }
}

/** Learn the Favorites from a root listing; forget them when Drive is no longer browsable here. */
export function learnMatrixDrivePlaces(
  view: Pick<MatrixDriveView, 'canGoBack' | 'rows' | 'listingStatus' | 'truncated'> | null,
  locale: string
): void {
  if (!view) {
    $matrixDrivePlaces.set([])
    $matrixDriveLocation.set(DRIVE_AT_ROOT)
    $matrixDriveListings.set(new Map())

    return
  }

  if (view.canGoBack || view.listingStatus === 'loading') {
    return
  }

  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })

  const folders = view.rows
    .filter(row => row.kind === 'folder')
    .map(row => row.name)
    .sort(collator.compare)

  const current = $matrixDrivePlaces.get()

  if (folders.length !== current.length || folders.some((name, index) => name !== current[index])) {
    $matrixDrivePlaces.set(folders)
  }
}

/** What the title bar draws for Drive: the place's name and whether ‹ › can move. Null: plain "Drive". */
export interface MatrixDriveHeader {
  title: string
  canBack: boolean
  canForward: boolean
}

export const $matrixDriveHeader = atom<MatrixDriveHeader | null>(null)

export type MatrixDriveIntent =
  | { kind: 'back' | 'forward' | 'root' }
  | { kind: 'folder'; name: string }

/** A request from the title bar or the sidebar, carried out by the Drive page that owns the bridge. */
export const $matrixDriveIntent = atom<(MatrixDriveIntent & { serial: number }) | null>(null)

export function requestMatrixDriveIntent(intent: MatrixDriveIntent): void {
  $matrixDriveIntent.set({ ...intent, serial: ($matrixDriveIntent.get()?.serial ?? 0) + 1 })
}

/** Which sidebar place is the open one, as Finder marks it: the place itself, never a folder inside it. */
export function currentDrivePlace(
  destination: 'recents' | 'all',
  location: Pick<MatrixDriveLocation, 'path'>
): { kind: 'recents' } | { kind: 'root' } | { kind: 'folder'; name: string } | null {
  if (destination === 'recents') {
    return { kind: 'recents' }
  }

  if (location.path?.length === 0) {
    return { kind: 'root' }
  }

  return location.path?.length === 1 ? { kind: 'folder', name: location.path[0]! } : null
}

/**
 * The side panel is showing a Drive PDF, whose pages need its preview lease kept alive. Main holds
 * one lease at a time, so the gallery doesn't take one for its own preview meanwhile.
 */
export const $matrixDrivePdfLease = atom(false)

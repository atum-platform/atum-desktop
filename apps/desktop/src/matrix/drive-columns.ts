import type { MatrixDriveRow } from '../../shared/matrix-drive'

import { driveListingKey, moveDriveSelection } from './drive-finder'

/**
 * The column view, Finder's Miller columns, on a bridge that lists one folder at a time. The open
 * folder is the live listing; the folders on the path to it are drawn from this window's remembered
 * listings. Moving to another column walks the bridge there by folder names.
 */
export interface DriveColumn {
  /** The folder this column lists, from the root; null when that place is unknown. */
  path: readonly string[] | null
  rows: readonly MatrixDriveRow[]
  /** The folder on the open path that this column shows open. */
  open: string | null
  /** The open folder itself: its item ids are current and its badges can be drawn. */
  live: boolean
}

/** Where a column move or click leads: the folder to open and the item to select in it. */
export interface DriveColumnTarget {
  path: string[]
  selected: string | null
}

/** The steps from one folder to another: up to the folder both are in, then down by name. */
export function driveWalk(from: readonly string[], to: readonly string[]): { back: number; enter: string[] } {
  let shared = 0

  while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
    shared += 1
  }

  return { back: from.length - shared, enter: to.slice(shared) }
}

/**
 * The columns: each folder on the path that this window has listed, then the open folder. A folder
 * it never listed ends the run there rather than being invented.
 */
export function driveColumns(
  path: readonly string[] | null,
  live: readonly MatrixDriveRow[],
  memory: ReadonlyMap<string, readonly MatrixDriveRow[]>
): DriveColumn[] {
  if (!path) {
    return [{ path: null, rows: live, open: null, live: true }]
  }

  const columns: DriveColumn[] = [{ path, rows: live, open: null, live: true }]

  for (let depth = path.length - 1; depth >= 0; depth--) {
    const place = path.slice(0, depth)
    const rows = memory.get(driveListingKey(place))

    if (!rows) {
      break
    }

    columns.unshift({ path: place, rows, open: path[depth]!, live: false })
  }

  return columns
}

/**
 * Which column has the keyboard: the open folder when an item in it is selected, otherwise its
 * parent, where the open folder itself is the selection (Finder's "folder selected, contents shown").
 */
export function driveColumnFocus(path: readonly string[] | null, selected: string | null): 'leaf' | 'parent' {
  return selected || !path?.length ? 'leaf' : 'parent'
}

/** Clicking an item in a column: a folder opens beside it, a file is selected where it is. */
export function driveColumnPick(
  place: readonly string[],
  row: Pick<MatrixDriveRow, 'kind' | 'name'>
): DriveColumnTarget {
  return row.kind === 'folder'
    ? { path: [...place, row.name], selected: null }
    : { path: [...place], selected: row.name }
}

/**
 * The arrow keys as Finder's column view has them: Up and Down move in the column with the keyboard
 * and open a folder as they land on it; Right goes into the open folder; Left goes back out.
 */
export function driveColumnMove(
  columns: readonly DriveColumn[],
  path: readonly string[] | null,
  selected: string | null,
  key: string
): DriveColumnTarget | null {
  const live = columns.at(-1)

  if (!path || !live) {
    return null
  }

  if (driveColumnFocus(path, selected) === 'leaf') {
    if (key === 'ArrowLeft') {
      return path.length && selected ? { path: [...path], selected: null } : null
    }

    if (key === 'ArrowRight') {
      return null
    }

    const index = live.rows.findIndex(row => row.name === selected)
    const next = moveDriveSelection(live.rows.length, index, key, 1)

    return next === null || next === index ? null : driveColumnPick(path, live.rows[next]!)
  }

  if (key === 'ArrowRight') {
    const first = live.rows[0]

    return first ? driveColumnPick(path, first) : null
  }

  if (key === 'ArrowLeft') {
    return path.length >= 2 ? { path: path.slice(0, -1), selected: null } : null
  }

  const parent = columns.at(-2)

  if (!parent) {
    return null
  }

  const index = parent.rows.findIndex(row => row.kind === 'folder' && row.name === path.at(-1))
  const next = moveDriveSelection(parent.rows.length, index, key, 1)

  return next === null || next === index ? null : driveColumnPick(path.slice(0, -1), parent.rows[next]!)
}

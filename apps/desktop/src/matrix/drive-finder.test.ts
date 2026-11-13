import { afterEach, describe, expect, it } from 'vitest'

import type { MatrixDriveRow } from '../../shared/matrix-drive'

import {
  $matrixDriveLocation,
  $matrixDrivePlaces,
  currentDrivePlace,
  DRIVE_AT_ROOT,
  DRIVE_NAME_ORDER,
  DRIVE_RECENT_ORDER,
  driveItemSync,
  learnMatrixDrivePlaces,
  middleTruncateDriveName,
  moveDriveSelection,
  nextDriveSort,
  parseDriveGroupBy,
  parseDriveLayout,
  reduceDriveLocation,
  sortDriveRows,
  typeSelectDriveRow
} from './drive-finder'

const file = (name: string, size: number, modifiedAt: number): MatrixDriveRow => ({
  id: name,
  name,
  kind: 'file',
  size,
  modifiedAt
})

const folder = (name: string, modifiedAt = 0): MatrixDriveRow => ({ id: name, name, kind: 'folder', size: 0, modifiedAt })

afterEach(() => learnMatrixDrivePlaces(null, 'en'))

describe('sorting', () => {
  it('orders names as a person reads them, folders mixed in, as Finder does by default', () => {
    const rows = [file('Report 10.docx', 1, 0), folder('Reports'), file('report 2.docx', 1, 0), file('Agenda.md', 1, 0)]

    expect(sortDriveRows(rows, DRIVE_NAME_ORDER, 'en').map(row => row.name)).toEqual([
      'Agenda.md',
      'report 2.docx',
      'Report 10.docx',
      'Reports'
    ])
  })

  it('puts the newest first for Recents and breaks a tie by name', () => {
    const rows = [file('b.txt', 1, 10), file('a.txt', 1, 10), file('new.txt', 1, 30)]

    expect(sortDriveRows(rows, DRIVE_RECENT_ORDER, 'en').map(row => row.name)).toEqual(['new.txt', 'a.txt', 'b.txt'])
  })

  it('sorts folders below the smallest file by size, since a folder has no size of its own', () => {
    const rows = [file('big.bin', 900, 0), folder('Folder'), file('small.bin', 3, 0)]

    expect(sortDriveRows(rows, { key: 'size', direction: 'asc' }, 'en').map(row => row.name)).toEqual([
      'Folder',
      'small.bin',
      'big.bin'
    ])
  })

  it('flips the same column and starts a new one where Finder starts it', () => {
    expect(nextDriveSort(DRIVE_NAME_ORDER, 'name')).toEqual({ key: 'name', direction: 'desc' })
    expect(nextDriveSort(DRIVE_NAME_ORDER, 'modified')).toEqual({ key: 'modified', direction: 'desc' })
    expect(nextDriveSort(DRIVE_RECENT_ORDER, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })
})

describe('sync badges', () => {
  const lastSyncAt = 1_000

  it('marks an unchanged item synced and a later change waiting while Drive runs', () => {
    for (const state of ['ready', 'syncing'] as const) {
      expect(driveItemSync({ modifiedAt: 900 }, { state, lastSyncAt })).toBe('synced')
      expect(driveItemSync({ modifiedAt: 1_500 }, { state, lastSyncAt })).toBe('pending')
    }
  })

  it('treats everything as synced when an up-to-date Drive has no finish time yet, and waiting while it syncs', () => {
    expect(driveItemSync({ modifiedAt: 5 }, { state: 'ready' })).toBe('synced')
    expect(driveItemSync({ modifiedAt: 5 }, { state: 'syncing' })).toBe('pending')
  })

  it('keeps the last synced copies marked while Drive cannot sync, and marks newer changes as not syncing', () => {
    for (const state of ['offline', 'paused', 'error', 'reauthenticate', 'connecting'] as const) {
      expect(driveItemSync({ modifiedAt: 900 }, { state, lastSyncAt })).toBe('synced')
      expect(driveItemSync({ modifiedAt: 1_500 }, { state, lastSyncAt })).toBe('paused')
      expect(driveItemSync({ modifiedAt: 900 }, { state })).toBe('paused')
    }
  })

  it('shows no badge on stale facts rather than a guess', () => {
    expect(driveItemSync({ modifiedAt: 900 }, { state: 'ready', lastSyncAt, factsStale: true })).toBeNull()
  })

  it('local-only takes precedence, even while offline or stale', () => {
    expect(driveItemSync({ modifiedAt: 900, localOnly: true, syncStatus: 'error' }, { state: 'offline', factsStale: true })).toBe('localOnly')
  })

  it('uses real states only with the capability and never guesses a missing per-file fact', () => {
    for (const syncStatus of ['conflict', 'error', 'uploading'] as const) {
      const row = { modifiedAt: 900, syncStatus }
      expect(driveItemSync(row, { state: 'ready', fileStatusAvailable: true })).toBe(syncStatus)
      expect(driveItemSync(row, { state: 'ready', fileStatusAvailable: true, factsStale: true })).toBeNull()
      expect(driveItemSync(row, { state: 'ready' })).not.toBe(syncStatus)
    }

    expect(driveItemSync({ modifiedAt: 900 }, { state: 'ready', fileStatusAvailable: true })).toBeNull()
  })
})

describe('keyboard movement', () => {
  it('moves through the icon grid by rows and columns, landing on the last item of a shorter last row', () => {
    // 10 items, 4 across: rows 0–3, 4–7, 8–9.
    expect(moveDriveSelection(10, 1, 'ArrowRight', 4)).toBe(2)
    expect(moveDriveSelection(10, 1, 'ArrowLeft', 4)).toBe(0)
    expect(moveDriveSelection(10, 0, 'ArrowLeft', 4)).toBe(0)
    expect(moveDriveSelection(10, 1, 'ArrowDown', 4)).toBe(5)
    expect(moveDriveSelection(10, 5, 'ArrowUp', 4)).toBe(1)
    expect(moveDriveSelection(10, 1, 'ArrowUp', 4)).toBe(1)
    expect(moveDriveSelection(10, 6, 'ArrowDown', 4)).toBe(9)
    expect(moveDriveSelection(10, 9, 'ArrowDown', 4)).toBe(9)
    expect(moveDriveSelection(10, 4, 'End', 4)).toBe(9)
    expect(moveDriveSelection(10, 4, 'Home', 4)).toBe(0)
  })

  it('moves only up and down in the list', () => {
    expect(moveDriveSelection(3, 0, 'ArrowDown', 1)).toBe(1)
    expect(moveDriveSelection(3, 2, 'ArrowDown', 1)).toBe(2)
    expect(moveDriveSelection(3, 1, 'ArrowUp', 1)).toBe(0)
    expect(moveDriveSelection(3, 1, 'ArrowRight', 1)).toBeNull()
  })

  it('starts at the first item when nothing is selected, and ignores other keys', () => {
    expect(moveDriveSelection(3, -1, 'ArrowDown', 1)).toBe(0)
    expect(moveDriveSelection(3, -1, 'End', 1)).toBe(2)
    expect(moveDriveSelection(3, 0, 'a', 1)).toBeNull()
    expect(moveDriveSelection(0, -1, 'ArrowDown', 1)).toBeNull()
  })

  it('jumps to the first name that starts with what was typed', () => {
    const rows = [{ name: 'Agenda.md' }, { name: 'Báo cáo quý' }, { name: 'budget.xlsx' }]

    expect(typeSelectDriveRow(rows, 'b', 'vi')).toBe(1)
    expect(typeSelectDriveRow(rows, 'BU', 'vi')).toBe(2)
    expect(typeSelectDriveRow(rows, 'z', 'vi')).toBe(-1)
  })
})

describe('icon labels', () => {
  it('cuts a long name in the middle so its start and its type stay readable', () => {
    const cut = middleTruncateDriveName('Impromptu Google Meeting (3).docx', 22)

    expect(cut.startsWith('Impromptu G')).toBe(true)
    expect(cut.endsWith('(3).docx')).toBe(true)
    expect(cut).toContain('…')
    expect([...cut].length).toBeLessThanOrEqual(22)
    expect(middleTruncateDriveName('Kế hoạch.docx', 26)).toBe('Kế hoạch.docx')
  })

  it('never splits a Vietnamese letter from its tone mark', () => {
    const decomposed = 'Ngân sách năm hai nghìn không trăm hai mươi sáu.xlsx'.normalize('NFD')
    const [head, tail] = middleTruncateDriveName(decomposed, 20).split('…')

    expect(/^\p{M}/u.test(tail!)).toBe(false)
    expect(decomposed.startsWith(head!)).toBe(true)
    expect(decomposed.endsWith(tail!)).toBe(true)
  })
})

describe('following the open folder', () => {
  const at = (folderLabel?: string) => ({
    type: 'view' as const,
    view: { canGoBack: folderLabel !== undefined, folderLabel, listingStatus: 'current' as const }
  })

  it('counts a step only when a view shows where it led, whichever arrives first', () => {
    let state = reduceDriveLocation(DRIVE_AT_ROOT, { type: 'enter', name: 'Reports' })
    // The root's own refresh, or a scan still in flight, does not count as the step.
    state = reduceDriveLocation(state, at())
    expect(state.path).toEqual([])
    state = reduceDriveLocation(state, { type: 'view', view: { canGoBack: false, listingStatus: 'loading' } })
    expect(state.pending).toEqual({ kind: 'enter', name: 'Reports' })
    state = reduceDriveLocation(state, at('Reports'))
    expect(state.path).toEqual(['Reports'])
    state = reduceDriveLocation(reduceDriveLocation(state, { type: 'enter', name: '2026' }), at('2026'))
    expect(state.path).toEqual(['Reports', '2026'])
    state = reduceDriveLocation(reduceDriveLocation(state, { type: 'back', from: '2026' }), at('Reports'))
    expect(state.path).toEqual(['Reports'])
    expect(state.forward).toEqual(['2026'])
  })

  it('offers Forward only until another folder is chosen', () => {
    let state = reduceDriveLocation({ path: ['A'], forward: [], pending: null }, { type: 'back', from: 'A' })
    state = reduceDriveLocation(state, at())
    expect(state).toMatchObject({ path: [], forward: ['A'] })
    expect(reduceDriveLocation(state, { type: 'enter', name: 'A' }).forward).toEqual([])
    expect(reduceDriveLocation(state, { type: 'enter', name: 'B' }).forward).toEqual([])
    expect(reduceDriveLocation(state, { type: 'jump' }).forward).toEqual([])
  })

  it('admits it does not know the path when Drive was already deep in a folder', () => {
    expect(reduceDriveLocation(DRIVE_AT_ROOT, at('Somewhere')).path).toBeNull()
  })

  it('marks the sidebar place itself, never a folder inside it', () => {
    expect(currentDrivePlace('recents', { path: ['A'] })).toEqual({ kind: 'recents' })
    expect(currentDrivePlace('all', { path: [] })).toEqual({ kind: 'root' })
    expect(currentDrivePlace('all', { path: ['A'] })).toEqual({ kind: 'folder', name: 'A' })
    expect(currentDrivePlace('all', { path: ['A', 'B'] })).toBeNull()
    expect(currentDrivePlace('all', { path: null })).toBeNull()
  })

  it('learns the Favorites from the root listing only, and forgets them with the Drive', () => {
    const rows = [folder('Reports'), file('notes.txt', 1, 0), folder('Agent Reports')]

    learnMatrixDrivePlaces({ canGoBack: true, rows, truncated: false }, 'en')
    expect($matrixDrivePlaces.get()).toEqual([])
    learnMatrixDrivePlaces({ canGoBack: false, rows, truncated: false, listingStatus: 'loading' }, 'en')
    expect($matrixDrivePlaces.get()).toEqual([])
    learnMatrixDrivePlaces({ canGoBack: false, rows, truncated: false }, 'en')
    expect($matrixDrivePlaces.get()).toEqual(['Agent Reports', 'Reports'])
    $matrixDriveLocation.set({ path: ['Reports'], forward: [], pending: null })
    learnMatrixDrivePlaces(null, 'en')
    expect($matrixDrivePlaces.get()).toEqual([])
    expect($matrixDriveLocation.get()).toEqual(DRIVE_AT_ROOT)
  })
})

describe('kept view choices', () => {
  it('reads all four views back and opens anything else as icons', () => {
    for (const layout of ['icon', 'list', 'column', 'gallery'] as const) {
      expect(parseDriveLayout(layout)).toBe(layout)
    }

    expect(parseDriveLayout(null)).toBe('icon')
    expect(parseDriveLayout('cover-flow')).toBe('icon')
  })

  it('reads the grouping back and treats anything else as no groups', () => {
    for (const group of ['none', 'kind', 'modified', 'size'] as const) {
      expect(parseDriveGroupBy(group)).toBe(group)
    }

    expect(parseDriveGroupBy('tags')).toBe('none')
    expect(parseDriveGroupBy(null)).toBe('none')
  })
})

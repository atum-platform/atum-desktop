import { afterEach, describe, expect, it } from 'vitest'

import type { MatrixDriveRow, MatrixDriveView } from '../../shared/matrix-drive'

import { driveColumnFocus, driveColumnMove, driveColumnPick, driveColumns, driveWalk } from './drive-columns'
import {
  $matrixDriveListings,
  $matrixDriveLocation,
  DRIVE_AT_ROOT,
  learnMatrixDrivePlaces,
  observeMatrixDriveView,
  reduceDriveLocation
} from './drive-finder'

const file = (name: string): MatrixDriveRow => ({ id: `id:${name}`, name, kind: 'file', size: 1, modifiedAt: 1 })
const folder = (name: string): MatrixDriveRow => ({ id: `id:${name}`, name, kind: 'folder', size: 0, modifiedAt: 1 })

const view = (rows: MatrixDriveRow[], folderLabel?: string, extra: Partial<MatrixDriveView> = {}): MatrixDriveView => ({
  state: 'ready',
  revision: 1,
  rows,
  truncated: false,
  canGoBack: Boolean(folderLabel),
  folderLabel,
  listingStatus: 'current',
  ...extra
})

afterEach(() => learnMatrixDrivePlaces(null, 'en'))

// root: Docs/, Photos/, a.txt   Docs: Work/, notes.md, z.pdf   Docs/Work: plan.docx
const root = [folder('Docs'), folder('Photos'), file('a.txt')]
const docs = [folder('Work'), file('notes.md'), file('z.pdf')]
const work = [file('plan.docx')]

describe('walking the Drive one folder at a time', () => {
  it('goes up to the shared folder, then down by name', () => {
    expect(driveWalk(['Docs', 'Work'], ['Photos'])).toEqual({ back: 2, enter: ['Photos'] })
    expect(driveWalk(['Docs'], ['Docs', 'Work'])).toEqual({ back: 0, enter: ['Work'] })
    expect(driveWalk(['Docs', 'Work'], ['Docs'])).toEqual({ back: 1, enter: [] })
    expect(driveWalk([], [])).toEqual({ back: 0, enter: [] })
  })

  it('ignores the views of the steps in between and lands where the walk ended', () => {
    let state = reduceDriveLocation({ ...DRIVE_AT_ROOT, path: ['Docs', 'Work'] }, { type: 'walk' })
    state = reduceDriveLocation(state, { type: 'view', view: view(docs, 'Docs') })
    state = reduceDriveLocation(state, { type: 'view', view: view(root) })

    expect(state.path).toEqual(['Docs', 'Work'])

    state = reduceDriveLocation(state, { type: 'arrive', path: ['Photos'] })
    expect(state).toEqual({ path: ['Photos'], forward: [], pending: null })
    expect('walking' in state).toBe(false)

    // The walk's own last view, arriving after, agrees with where it landed.
    expect(reduceDriveLocation(state, { type: 'view', view: view([], 'Photos') }).path).toEqual(['Photos'])
  })
})

describe('remembering the folders this window has listed', () => {
  it('keeps each listing under its place in the Drive and replaces it on the next listing', () => {
    observeMatrixDriveView(view(root))
    expect($matrixDriveLocation.get().path).toEqual([])
    expect(
      $matrixDriveListings
        .get()
        .get('')
        ?.map(row => row.name)
    ).toEqual(['Docs', 'Photos', 'a.txt'])

    $matrixDriveLocation.set({ ...$matrixDriveLocation.get(), pending: { kind: 'enter', name: 'Docs' } })
    observeMatrixDriveView(view(docs, 'Docs'))
    expect(
      $matrixDriveListings
        .get()
        .get('Docs')
        ?.map(row => row.name)
    ).toEqual(['Work', 'notes.md', 'z.pdf'])

    observeMatrixDriveView(view([folder('Work')], 'Docs'))
    expect(
      $matrixDriveListings
        .get()
        .get('Docs')
        ?.map(row => row.name)
    ).toEqual(['Work'])
  })

  it('skips a listing still loading, one during a walk, and one whose place is unknown', () => {
    observeMatrixDriveView(view(root, undefined, { listingStatus: 'loading' }))
    expect($matrixDriveListings.get().size).toBe(0)

    $matrixDriveLocation.set({ ...DRIVE_AT_ROOT, walking: true })
    observeMatrixDriveView(view(root))
    expect($matrixDriveListings.get().size).toBe(0)

    // Drive was already deep in a folder this window never saw it enter.
    $matrixDriveLocation.set(DRIVE_AT_ROOT)
    observeMatrixDriveView(view(docs, 'Somewhere'))
    expect($matrixDriveLocation.get().path).toBeNull()
    expect($matrixDriveListings.get().size).toBe(0)
  })

  it('forgets everything when Drive is no longer browsable', () => {
    observeMatrixDriveView(view(root))
    learnMatrixDrivePlaces(null, 'en')

    expect($matrixDriveListings.get().size).toBe(0)
  })
})

describe('the columns', () => {
  const memory = new Map([
    ['', root],
    ['Docs', docs]
  ])

  it('draws the folders on the path, then the open folder from its live listing', () => {
    const live = [file('plan.docx')]
    const columns = driveColumns(['Docs', 'Work'], live, memory)

    expect(columns.map(column => column.path)).toEqual([[], ['Docs'], ['Docs', 'Work']])
    expect(columns.map(column => column.open)).toEqual(['Docs', 'Work', null])
    expect(columns[2]!.rows).toBe(live)
    expect(columns.map(column => column.live)).toEqual([false, false, true])
  })

  it('starts after a folder it never listed rather than invent one', () => {
    const columns = driveColumns(['Docs', 'Work'], work, new Map([['Docs', docs]]))

    expect(columns.map(column => column.path)).toEqual([['Docs'], ['Docs', 'Work']])
  })

  it('is the open folder alone when the place is unknown', () => {
    expect(driveColumns(null, work, memory).map(column => column.path)).toEqual([null])
  })
})

describe('column keys, as in Finder', () => {
  const columns = (path: string[]) =>
    driveColumns(
      path,
      path.length ? (path.at(-1) === 'Work' ? work : docs) : root,
      new Map([
        ['', root],
        ['Docs', docs]
      ])
    )

  it('has the keyboard in the open folder when an item there is selected, else on the folder in its parent', () => {
    expect(driveColumnFocus(['Docs'], 'notes.md')).toBe('leaf')
    expect(driveColumnFocus(['Docs'], null)).toBe('parent')
    expect(driveColumnFocus([], null)).toBe('leaf')
  })

  it('opens a folder as the arrow lands on it, and selects a file in place', () => {
    // In the Drive with a.txt selected: up onto Photos opens it.
    expect(driveColumnMove(columns([]), [], 'a.txt', 'ArrowUp')).toEqual({ path: ['Photos'], selected: null })
    // In Docs with notes.md selected: up onto Work opens it; down selects z.pdf.
    expect(driveColumnMove(columns(['Docs']), ['Docs'], 'notes.md', 'ArrowUp')).toEqual({
      path: ['Docs', 'Work'],
      selected: null
    })
    expect(driveColumnMove(columns(['Docs']), ['Docs'], 'notes.md', 'ArrowDown')).toEqual({
      path: ['Docs'],
      selected: 'z.pdf'
    })
  })

  it('moves between siblings in the parent column while a folder is open', () => {
    // Docs is open (nothing selected inside): down moves to Photos and opens it, down again selects a.txt.
    expect(driveColumnMove(columns(['Docs']), ['Docs'], null, 'ArrowDown')).toEqual({
      path: ['Photos'],
      selected: null
    })
    expect(driveColumnMove(columns(['Photos']), ['Photos'], null, 'ArrowDown')).toEqual({ path: [], selected: 'a.txt' })
  })

  it('goes right into the open folder’s first item and left back to the folder', () => {
    expect(driveColumnMove(columns(['Docs']), ['Docs'], null, 'ArrowRight')).toEqual({
      path: ['Docs', 'Work'],
      selected: null
    })
    expect(driveColumnMove(columns(['Docs', 'Work']), ['Docs', 'Work'], null, 'ArrowRight')).toEqual({
      path: ['Docs', 'Work'],
      selected: 'plan.docx'
    })
    // Left from a selected file keeps its folder open and puts the keyboard back on the folder.
    expect(driveColumnMove(columns(['Docs', 'Work']), ['Docs', 'Work'], 'plan.docx', 'ArrowLeft')).toEqual({
      path: ['Docs', 'Work'],
      selected: null
    })
    // Left from an open folder closes it and goes to its parent.
    expect(driveColumnMove(columns(['Docs', 'Work']), ['Docs', 'Work'], null, 'ArrowLeft')).toEqual({
      path: ['Docs'],
      selected: null
    })
  })

  it('stops at the edges', () => {
    expect(driveColumnMove(columns(['Docs']), ['Docs'], null, 'ArrowLeft')).toBeNull()
    expect(driveColumnMove(columns([]), [], 'a.txt', 'ArrowDown')).toBeNull()
    expect(driveColumnMove(columns([]), [], 'a.txt', 'ArrowRight')).toBeNull()
    expect(driveColumnMove(columns([]), [], null, 'ArrowLeft')).toBeNull()
    expect(driveColumnMove(columns([]), [], null, 'Tab')).toBeNull()
  })

  it('starts at the first item in the Drive with nothing selected', () => {
    expect(driveColumnMove(columns([]), [], null, 'ArrowDown')).toEqual({ path: ['Docs'], selected: null })
  })

  it('opens a clicked folder from any column and selects a clicked file there', () => {
    expect(driveColumnPick([], folder('Photos'))).toEqual({ path: ['Photos'], selected: null })
    expect(driveColumnPick(['Docs'], file('z.pdf'))).toEqual({ path: ['Docs'], selected: 'z.pdf' })
  })
})

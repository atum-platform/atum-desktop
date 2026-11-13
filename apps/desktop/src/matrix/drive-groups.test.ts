import { describe, expect, it } from 'vitest'

import type { MatrixDriveRow } from '../../shared/matrix-drive'

import { matrixDriveCopy } from './drive-copy'
import { driveGalleryPreview, driveKindFamily, groupDriveRows, moveDriveSelectionInGroups } from './drive-groups'

const NOW = new Date(2026, 10, 13, 15, 0).getTime()
const DAY = 86_400_000

const file = (name: string, size = 1, modifiedAt = NOW): MatrixDriveRow => ({
  id: name,
  name,
  kind: 'file',
  size,
  modifiedAt
})

const folder = (name: string, modifiedAt = NOW): MatrixDriveRow => ({
  id: name,
  name,
  kind: 'folder',
  size: 0,
  modifiedAt
})

const options = { now: NOW, locale: 'en', copy: matrixDriveCopy.en.groups }

describe('group by kind', () => {
  it('puts every image format in one family and folders in their own, as Finder does', () => {
    expect(driveKindFamily(file('a.jpg'))).toBe('image')
    expect(driveKindFamily(file('b.PNG'))).toBe('image')
    expect(driveKindFamily(file('c.heic'))).toBe('image')
    expect(driveKindFamily(folder('Photos.jpg'))).toBe('folder')
    expect(driveKindFamily(file('README'))).toBe('other')
    expect(driveKindFamily(file('notes.md'))).toBe('text')
    expect(driveKindFamily(file('script.py'))).toBe('code')
  })

  it('orders the groups by their names, with Other last, and keeps the sort inside each group', () => {
    const rows = [
      file('z.png'),
      file('Budget.xlsx'),
      folder('Reports'),
      file('a.png'),
      file('README'),
      file('Lease.pdf')
    ]

    const groups = groupDriveRows(rows, 'kind', options)

    expect(groups.map(group => group.label)).toEqual(['Folders', 'Images', 'PDF Documents', 'Spreadsheets', 'Other'])
    expect(groups[1]!.rows.map(row => row.name)).toEqual(['z.png', 'a.png'])
  })
})

describe('group by date modified', () => {
  it('uses Today, Yesterday, Previous 7 Days, Previous 30 Days, this year’s months, then years, newest first', () => {
    const rows = [
      file('old.txt', 1, new Date(2024, 2, 1).getTime()),
      file('march.txt', 1, new Date(2026, 2, 9).getTime()),
      file('today.txt', 1, NOW - 60_000),
      file('month.txt', 1, NOW - 20 * DAY),
      file('yesterday.txt', 1, NOW - DAY),
      file('week.txt', 1, NOW - 4 * DAY),
      file('august.txt', 1, new Date(2026, 7, 20).getTime()),
      file('last-year.txt', 1, new Date(2025, 11, 30).getTime())
    ]

    const groups = groupDriveRows(rows, 'modified', options)

    expect(groups.map(group => group.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 Days',
      'Previous 30 Days',
      'August',
      'March',
      '2025',
      '2024'
    ])
    expect(groups.map(group => group.rows.map(row => row.name))).toEqual([
      ['today.txt'],
      ['yesterday.txt'],
      ['week.txt'],
      ['month.txt'],
      ['august.txt'],
      ['march.txt'],
      ['last-year.txt'],
      ['old.txt']
    ])
  })

  it('counts a time just after midnight as today and a clock set ahead as today, never a future group', () => {
    const midnight = new Date(2026, 10, 13, 0, 1).getTime()
    const groups = groupDriveRows([file('early', 1, midnight), file('ahead', 1, NOW + DAY)], 'modified', options)

    expect(groups.map(group => [group.label, group.rows.length])).toEqual([['Today', 2]])
  })

  it('names the months in the reader’s language', () => {
    const rows = [file('a', 1, new Date(2026, 7, 2).getTime())]
    const groups = groupDriveRows(rows, 'modified', { ...options, locale: 'vi' })

    expect(groups[0]!.label).toBe(new Intl.DateTimeFormat('vi', { month: 'long' }).format(new Date(2026, 7, 2)))
  })
})

describe('group by size', () => {
  it('uses Finder’s bands, biggest first, then empty files, then folders', () => {
    const rows = [
      folder('Folder'),
      file('empty', 0),
      file('tiny', 4_000),
      file('kb', 400_000),
      file('mb', 4_000_000),
      file('tens', 40_000_000),
      file('hundreds', 400_000_000),
      file('huge', 4_000_000_000)
    ]

    expect(groupDriveRows(rows, 'size', options).map(group => group.label)).toEqual([
      'More than 1 GB',
      '100 MB to 1 GB',
      '10 to 100 MB',
      '1 to 10 MB',
      '100 KB to 1 MB',
      'Less than 100 KB',
      'Empty',
      'Folders'
    ])
  })
})

it('gives one unlabelled group when grouping is off, so the views draw a single run', () => {
  const rows = [file('b'), file('a')]

  expect(groupDriveRows(rows, 'none', options)).toEqual([{ id: 'all', label: '', rows }])
  expect(groupDriveRows([], 'kind', options)).toEqual([])
})

describe('arrow keys across groups in the icon grid', () => {
  // Two groups on a grid four across: [0 1 2 3][4] then [5 6 7].
  const sizes = [5, 3]

  it('moves down into the next group’s row in the same column, or its last item', () => {
    expect(moveDriveSelectionInGroups(sizes, 1, 'ArrowDown', 4)).toBe(4)
    expect(moveDriveSelectionInGroups(sizes, 4, 'ArrowDown', 4)).toBe(5)
    expect(moveDriveSelectionInGroups(sizes, 2, 'ArrowDown', 4)).toBe(4)
    expect(moveDriveSelectionInGroups([4, 3], 3, 'ArrowDown', 4)).toBe(6)
  })

  it('moves up into the previous group’s last row', () => {
    expect(moveDriveSelectionInGroups(sizes, 5, 'ArrowUp', 4)).toBe(4)
    expect(moveDriveSelectionInGroups(sizes, 7, 'ArrowUp', 4)).toBe(4)
    expect(moveDriveSelectionInGroups([4, 3], 6, 'ArrowUp', 4)).toBe(2)
    expect(moveDriveSelectionInGroups(sizes, 0, 'ArrowUp', 4)).toBe(0)
  })

  it('steps left and right through the reading order, across a group edge', () => {
    expect(moveDriveSelectionInGroups(sizes, 4, 'ArrowRight', 4)).toBe(5)
    expect(moveDriveSelectionInGroups(sizes, 5, 'ArrowLeft', 4)).toBe(4)
    expect(moveDriveSelectionInGroups(sizes, 7, 'End', 4)).toBe(7)
    expect(moveDriveSelectionInGroups(sizes, 7, 'Home', 4)).toBe(0)
  })

  it('is a plain list in one column and starts at the first item with nothing selected', () => {
    expect(moveDriveSelectionInGroups(sizes, 4, 'ArrowDown', 1)).toBe(5)
    expect(moveDriveSelectionInGroups(sizes, -1, 'ArrowDown', 4)).toBe(0)
    expect(moveDriveSelectionInGroups(sizes, 3, 'ArrowLeft', 1)).toBeNull()
    expect(moveDriveSelectionInGroups([], -1, 'ArrowDown', 4)).toBeNull()
  })
})

it('asks for a gallery preview only where one can be drawn inline: pictures and text', () => {
  expect(driveGalleryPreview(file('Hồ Tuyền Lâm.jpg'))).toBe('image')
  expect(driveGalleryPreview(file('notes.md'))).toBe('text')
  expect(driveGalleryPreview(file('data.csv'))).toBe('text')
  expect(driveGalleryPreview(file('photo.heic'))).toBeNull()
  expect(driveGalleryPreview(file('Lease.pdf'))).toBeNull()
  expect(driveGalleryPreview(file('Plan.docx'))).toBeNull()
  expect(driveGalleryPreview(folder('Photos.jpg'))).toBeNull()
})

import { consumerFileExtension, consumerFileKind } from '@/app/atum/consumer-file-icon'

import type { MatrixDriveRow } from '../../shared/matrix-drive'

import { moveDriveSelection } from './drive-finder'

/** Finder's broad kinds: a JPEG, a PNG and a HEIC photo are all Images. */
export type DriveKindFamily =
  | 'folder'
  | 'image'
  | 'pdf'
  | 'document'
  | 'text'
  | 'spreadsheet'
  | 'presentation'
  | 'movie'
  | 'music'
  | 'archive'
  | 'code'
  | 'other'

const FAMILY: Record<ReturnType<typeof consumerFileKind>, DriveKindFamily> = {
  archive: 'archive',
  audio: 'music',
  code: 'code',
  data: 'code',
  document: 'document',
  folder: 'folder',
  image: 'image',
  markdown: 'text',
  pdf: 'pdf',
  presentation: 'presentation',
  spreadsheet: 'spreadsheet',
  text: 'text',
  unknown: 'other',
  video: 'movie'
}

export function driveKindFamily(row: Pick<MatrixDriveRow, 'name' | 'kind'>): DriveKindFamily {
  return FAMILY[consumerFileKind(row.name, row.kind === 'folder')]
}

// The pictures and text main's preview lease returns inline (`consumerFileOpenKind`); anything else
// would only spend the lease to come back unsupported.
const INLINE_IMAGES = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

/** What the gallery can draw large for an item from a preview: a picture, text, or nothing. */
export function driveGalleryPreview(row: Pick<MatrixDriveRow, 'name' | 'kind'>): 'image' | 'text' | null {
  if (row.kind === 'folder') {
    return null
  }

  if (INLINE_IMAGES.has(consumerFileExtension(row.name))) {
    return 'image'
  }

  return ['text', 'markdown', 'code', 'data'].includes(consumerFileKind(row.name, false)) ||
    consumerFileExtension(row.name) === '.csv'
    ? 'text'
    : null
}

/** The group-by choices Drive has data for: Finder's Kind, Date Modified and Size. */
export type MatrixDriveGroupBy = 'none' | 'kind' | 'modified' | 'size'

type DatePeriod = 'today' | 'yesterday' | 'week' | 'month'
type SizeBand = 'gb' | 'hundredsMb' | 'tensMb' | 'mb' | 'hundredsKb' | 'small' | 'empty' | 'folders'

export interface MatrixDriveGroupsCopy {
  kinds: Record<DriveKindFamily, string>
  dates: Record<DatePeriod, string>
  sizes: Record<SizeBand, string>
}

export interface DriveGroup {
  id: string
  label: string
  rows: MatrixDriveRow[]
}

const SIZE_BANDS: readonly [SizeBand, number][] = [
  ['gb', 1e9],
  ['hundredsMb', 1e8],
  ['tensMb', 1e7],
  ['mb', 1e6],
  ['hundredsKb', 1e5],
  ['small', 1]
]

function sizeBand(row: MatrixDriveRow): SizeBand {
  if (row.kind === 'folder') {
    return 'folders'
  }

  return SIZE_BANDS.find(([, floor]) => row.size >= floor)?.[0] ?? 'empty'
}

function startOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)

  return day.getTime()
}

/** Today, Yesterday, the previous 7 and 30 days, then each month of this year and each earlier year. */
function dateGroup(at: number, now: number): { id: string; order: number } {
  const today = startOfDay(now)
  const daysAgo = Math.round((today - startOfDay(Math.min(at, now))) / 86_400_000)

  const period: DatePeriod | null =
    daysAgo <= 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo <= 7 ? 'week' : daysAgo <= 30 ? 'month' : null

  if (period) {
    return { id: period, order: ['today', 'yesterday', 'week', 'month'].indexOf(period) }
  }

  const date = new Date(at)
  const thisYear = new Date(now).getFullYear()

  return date.getFullYear() === thisYear
    ? { id: `month:${date.getMonth()}`, order: 100 + (11 - date.getMonth()) }
    : { id: `year:${date.getFullYear()}`, order: 1000 + (thisYear - date.getFullYear()) }
}

/**
 * Split rows, already in their sort order, into Finder's groups. Each group keeps that order inside
 * it. With grouping off there is one unlabelled group.
 */
export function groupDriveRows(
  rows: readonly MatrixDriveRow[],
  by: MatrixDriveGroupBy,
  { now, locale, copy }: { now: number; locale: string; copy: MatrixDriveGroupsCopy }
): DriveGroup[] {
  if (rows.length === 0) {
    return []
  }

  if (by === 'none') {
    return [{ id: 'all', label: '', rows: [...rows] }]
  }

  // Groups sort by rank, then by name: kinds by name with Other last, sizes and dates by rank alone.
  const groups = new Map<string, { label: string; rank: number; rows: MatrixDriveRow[] }>()

  const add = (id: string, label: () => string, rank: number, row: MatrixDriveRow) => {
    let group = groups.get(id)

    if (!group) {
      group = { label: label(), rank, rows: [] }
      groups.set(id, group)
    }

    group.rows.push(row)
  }

  for (const row of rows) {
    if (by === 'kind') {
      const family = driveKindFamily(row)
      add(family, () => copy.kinds[family], family === 'other' ? 1 : 0, row)
    } else if (by === 'size') {
      const band = sizeBand(row)
      add(band, () => copy.sizes[band], [...SIZE_BANDS.map(([id]) => id), 'empty', 'folders'].indexOf(band), row)
    } else {
      const { id, order } = dateGroup(row.modifiedAt, now)

      const label = () => {
        if (!id.includes(':')) {
          return copy.dates[id as DatePeriod]
        }

        const date = new Date(row.modifiedAt)

        return id.startsWith('month:')
          ? new Intl.DateTimeFormat(locale, { month: 'long' }).format(date)
          : new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(date)
      }

      add(id, label, order, row)
    }
  }

  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })

  return [...groups.entries()]
    .sort(([, a], [, b]) => a.rank - b.rank || (by === 'kind' ? collator.compare(a.label, b.label) : 0))
    .map(([id, group]) => ({ id, label: group.label, rows: group.rows }))
}

/**
 * Arrow keys over grouped items. Each group starts a new row of the icon grid, so Up and Down move to
 * the same column in the row above or below, or that row's last item when it is shorter. Left and
 * Right follow the reading order across a group's edge. `index` counts through the groups in order.
 */
export function moveDriveSelectionInGroups(
  sizes: readonly number[],
  index: number,
  key: string,
  columns: number
): number | null {
  const count = sizes.reduce((total, size) => total + size, 0)
  const across = Math.max(1, columns)

  if (count === 0) {
    return null
  }

  if (index < 0 || across === 1 || !['ArrowUp', 'ArrowDown'].includes(key)) {
    return moveDriveSelection(count, index, key, across)
  }

  // The grid's rows: each is [first index, length].
  const rows: [number, number][] = []
  let start = 0

  for (const size of sizes) {
    for (let offset = 0; offset < size; offset += across) {
      rows.push([start + offset, Math.min(across, size - offset)])
    }

    start += size
  }

  const row = rows.findIndex(([first, length]) => index >= first && index < first + length)
  const target = rows[key === 'ArrowUp' ? row - 1 : row + 1]

  if (row < 0 || !target) {
    return index
  }

  const column = index - rows[row]![0]

  return target[0] + Math.min(column, target[1] - 1)
}

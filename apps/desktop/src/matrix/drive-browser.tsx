import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef } from 'react'

import { ConsumerFileGlyph } from '@/app/atum/consumer-file-icon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { Locale } from '@/i18n'
import { CheckCircle2, ChevronDown, ChevronUp, CloudOff, Folder, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixDriveRow, MatrixDriveView } from '../../shared/matrix-drive'

import { matrixDriveCopy } from './drive-copy'
import {
  driveItemSync,
  type MatrixDriveItemSync,
  type MatrixDriveLayout,
  type MatrixDriveSort,
  type MatrixDriveSortKey,
  middleTruncateDriveName,
  moveDriveSelection,
  typeSelectDriveRow
} from './drive-finder'
import { MatrixFileGlyph } from './file-glyph'

/** Finder's icon labels: two short lines before the middle is cut. */
const ICON_LABEL_LENGTH = 22
const TYPE_SELECT_PAUSE_MS = 900

export interface MatrixDriveItemAction {
  label: string
  run(): void
}

export interface MatrixDriveBrowserProps {
  rows: readonly MatrixDriveRow[]
  layout: MatrixDriveLayout
  view: Pick<MatrixDriveView, 'state' | 'lastSyncAt' | 'factsStale'>
  locale: Locale
  selectedId: string | null
  sort: MatrixDriveSort
  formatSize(bytes: number): string
  formatDate(at: number): string
  onSort(key: MatrixDriveSortKey): void
  onSelect(id: string | null): void
  onOpen(row: MatrixDriveRow): void
  /** Space, as Finder's Quick Look: absent when this surface has no preview. */
  onQuickLook?(row: MatrixDriveRow): void
  onNavigate(direction: 'back' | 'forward'): void
  /** What an assistant may do with this item in the open chat, for its right-click menu. */
  itemActions?(row: MatrixDriveRow): MatrixDriveItemAction[]
}

const BADGE: Record<MatrixDriveItemSync, { icon: typeof CheckCircle2; tone: string }> = {
  synced: { icon: CheckCircle2, tone: 'text-(--ak-ok)' },
  pending: { icon: RefreshCw, tone: 'text-(--ak-ink-3)' },
  paused: { icon: CloudOff, tone: 'text-(--ak-ink-4)' }
}

function DriveSyncBadge({ className, id, label, sync }: { className?: string; id: string; label: string; sync: MatrixDriveItemSync }) {
  const { icon: Icon, tone } = BADGE[sync]

  return (
    <span
      className={cn('grid size-4 shrink-0 place-items-center rounded-full bg-(--ak-surface)', tone, className)}
      data-matrix-drive-sync={sync}
      id={id}
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  )
}

function columnsOf(items: readonly HTMLElement[]): number {
  if (items.length === 0) {
    return 1
  }

  const top = items[0]!.offsetTop
  const wrap = items.findIndex(item => item.offsetTop !== top)

  return wrap < 0 ? items.length : wrap
}

/** The icon grid or the list: click selects, double-click opens, the keyboard moves as Finder's does. */
export function MatrixDriveBrowser({
  rows,
  layout,
  view,
  locale,
  selectedId,
  sort,
  formatSize,
  formatDate,
  onSort,
  onSelect,
  onOpen,
  onQuickLook,
  onNavigate,
  itemActions
}: MatrixDriveBrowserProps) {
  const copy = matrixDriveCopy[locale]
  const listRef = useRef<HTMLDivElement>(null)
  const focusAfterMove = useRef<string | null>(null)
  const typed = useRef({ text: '', at: 0 })
  const baseId = useId()
  const selectedIndex = rows.findIndex(row => row.id === selectedId)

  useEffect(() => {
    if (focusAfterMove.current && focusAfterMove.current === selectedId) {
      focusAfterMove.current = null
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-matrix-drive-item]') ?? [])]
      items.find(item => item.dataset.matrixDriveItem === selectedId)?.focus()
    }
  }, [selectedId])

  const moveTo = (index: number) => {
    const row = rows[index]

    if (row) {
      focusAfterMove.current = row.id
      onSelect(row.id)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selected = rows[selectedIndex]

    if (event.metaKey || event.ctrlKey) {
      const command =
        event.key === '[' || event.key === 'ArrowUp'
          ? 'back'
          : event.key === ']'
            ? 'forward'
            : event.key === 'ArrowDown' || event.key.toLowerCase() === 'o'
              ? 'open'
              : null

      if (!command) {
        return
      }

      event.preventDefault()

      if (command === 'open') {
        if (selected) {
          onOpen(selected)
        }
      } else {
        onNavigate(command)
      }

      return
    }

    if (event.altKey) {
      return
    }

    if (event.key === 'Enter') {
      if (selected) {
        event.preventDefault()
        onOpen(selected)
      }

      return
    }

    if (event.key === ' ') {
      event.preventDefault()

      if (selected?.kind === 'file' && onQuickLook) {
        onQuickLook(selected)
      }

      return
    }

    if (event.key === 'Escape') {
      if (selectedId) {
        event.preventDefault()
        onSelect(null)
      }

      return
    }

    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-matrix-drive-item]') ?? [])]
    const next = moveDriveSelection(rows.length, selectedIndex, event.key, layout === 'icon' ? columnsOf(items) : 1)

    if (next !== null) {
      event.preventDefault()
      moveTo(next)

      return
    }

    if (event.key.length === 1 && event.key.trim()) {
      const now = Date.now()
      const text = now - typed.current.at > TYPE_SELECT_PAUSE_MS ? event.key : typed.current.text + event.key
      typed.current = { text, at: now }
      const match = typeSelectDriveRow(rows, text, locale)

      if (match >= 0) {
        event.preventDefault()
        moveTo(match)
      }
    }
  }

  // A click on the empty space between items clears the selection, as in Finder.
  const clearOnBackground = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onSelect(null)
    }
  }

  const item = (row: MatrixDriveRow, index: number) => {
    const selected = row.id === selectedId
    const sync = driveItemSync(row, view)
    const badgeId = `${baseId}-${index}`
    const focusable = selectedIndex >= 0 ? selected : index === 0
    const actions = itemActions?.(row) ?? []
    const quickLook = row.kind === 'file' && onQuickLook

    const element =
      layout === 'icon' ? (
        <div
          aria-describedby={sync ? badgeId : undefined}
          aria-label={row.name}
          aria-selected={selected}
          className="ak-focusable flex min-w-0 cursor-default flex-col items-center gap-(--ak-s1) rounded-(--ak-r-md) pb-(--ak-s1) select-none"
          data-matrix-drive-item={row.id}
          data-matrix-drive-kind={row.kind}
          onClick={() => onSelect(row.id)}
          onContextMenu={() => onSelect(row.id)}
          onDoubleClick={() => onOpen(row)}
          role="option"
          tabIndex={focusable ? 0 : -1}
        >
          <span
            className={cn(
              'relative grid h-[4.75rem] w-[5.5rem] place-items-center rounded-(--ak-r-md)',
              selected && 'bg-(--ak-fill-selected)'
            )}
          >
            <ConsumerFileGlyph isDirectory={row.kind === 'folder'} name={row.name} />
            {sync && (
              <DriveSyncBadge
                className="absolute end-1.5 bottom-1.5"
                id={badgeId}
                label={copy.sync[sync]}
                sync={sync}
              />
            )}
          </span>
          <span
            className={cn(
              'max-w-full rounded-(--ak-r-xs) px-(--ak-s1) text-center [font:var(--ak-t-body)] break-words text-(--ak-ink)',
              selected ? 'bg-(--ak-fill-selected)' : 'line-clamp-2'
            )}
            title={row.name}
          >
            {selected ? row.name : middleTruncateDriveName(row.name, ICON_LABEL_LENGTH)}
          </span>
        </div>
      ) : (
        <div
          aria-describedby={sync ? badgeId : undefined}
          aria-label={row.name}
          aria-selected={selected}
          className={cn(
            'ak-focusable grid h-7 cursor-default grid-cols-[minmax(0,1fr)_11rem_6rem] items-center gap-(--ak-s3) rounded-(--ak-r-sm) px-(--ak-s2) [font:var(--ak-t-body)] select-none',
            // The kit's selected row: the selected fill and strong words, never a colour.
            selected && 'bg-(--ak-fill-selected)'
          )}
          data-matrix-drive-item={row.id}
          data-matrix-drive-kind={row.kind}
          onClick={() => onSelect(row.id)}
          onContextMenu={() => onSelect(row.id)}
          onDoubleClick={() => onOpen(row)}
          role="option"
          tabIndex={focusable ? 0 : -1}
        >
          <span className="flex min-w-0 items-center gap-(--ak-s2) text-(--ak-ink)">
            {row.kind === 'folder' ? (
              <Folder aria-hidden className="size-4 shrink-0 text-(--ak-ink-2)" />
            ) : (
              <MatrixFileGlyph className="size-4 shrink-0 text-(--ak-ink-2)" name={row.name} />
            )}
            <span className={cn('truncate', selected && 'font-semibold')}>{row.name}</span>
            {sync && <DriveSyncBadge className="bg-transparent" id={badgeId} label={copy.sync[sync]} sync={sync} />}
          </span>
          <span className="truncate [font:var(--ak-t-callout)] text-(--ak-ink-3) tabular-nums">
            {formatDate(row.modifiedAt)}
          </span>
          <span className="truncate text-end [font:var(--ak-t-callout)] text-(--ak-ink-3) tabular-nums">
            {row.kind === 'file' ? formatSize(row.size) : '—'}
          </span>
        </div>
      )

    return (
      <ContextMenu key={row.id}>
        <ContextMenuTrigger asChild>{element}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => onOpen(row)}>{copy.preview.open}</ContextMenuItem>
          {quickLook && <ContextMenuItem onSelect={() => onQuickLook(row)}>{copy.quickLook}</ContextMenuItem>}
          {actions.length > 0 && <ContextMenuSeparator />}
          {actions.map(action => (
            <ContextMenuItem key={action.label} onSelect={action.run}>
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const header = (key: MatrixDriveSortKey, label: string, className?: string) => {
    const current = sort.key === key
    const Caret = sort.direction === 'asc' ? ChevronUp : ChevronDown

    return (
      <button
        aria-pressed={current}
        className={cn(
          'ak-focusable flex min-w-0 cursor-default items-center gap-(--ak-s1) rounded-(--ak-r-xs) [font:var(--ak-t-callout)] hover:text-(--ak-ink-2)',
          current ? 'text-(--ak-ink-2)' : 'text-(--ak-ink-3)',
          className
        )}
        onClick={() => onSort(key)}
        type="button"
      >
        <span className={cn('truncate', current && 'font-semibold')}>{label}</span>
        {current && <Caret aria-hidden className="size-3 shrink-0" />}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-matrix-drive-browser={layout}>
      {layout === 'list' && (
        <div className="grid grid-cols-[minmax(0,1fr)_11rem_6rem] items-center gap-(--ak-s3) border-b border-(--ak-line) px-(--ak-s2) pb-(--ak-s1)">
          {header('name', copy.name)}
          {header('modified', copy.modified)}
          {header('size', copy.size, 'justify-end')}
        </div>
      )}
      <div
        aria-label={copy.title}
        className={cn(
          'min-h-0 flex-1',
          layout === 'icon'
            ? 'grid content-start grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-x-(--ak-s2) gap-y-(--ak-s4) pt-(--ak-s2)'
            : 'flex flex-col pt-(--ak-s1)'
        )}
        data-matrix-drive-items
        onClick={clearOnBackground}
        onKeyDown={onKeyDown}
        ref={listRef}
        role="listbox"
      >
        {rows.map(item)}
      </div>
    </div>
  )
}

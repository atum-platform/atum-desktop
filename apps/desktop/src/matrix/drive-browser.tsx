import { type KeyboardEvent, type MouseEvent, type ReactElement, useEffect, useId, useRef } from 'react'

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
  type MatrixDriveSort,
  type MatrixDriveSortKey,
  middleTruncateDriveName,
  typeSelectDriveRow
} from './drive-finder'
import { groupDriveRows, type MatrixDriveGroupBy, moveDriveSelectionInGroups } from './drive-groups'
import { MatrixFileGlyph } from './file-glyph'

/** Finder's icon labels: two short lines before the middle is cut. */
const ICON_LABEL_LENGTH = 22
const TYPE_SELECT_PAUSE_MS = 900

export interface MatrixDriveItemAction {
  label: string
  run(): void
}

/** What every Drive view shares: the items' place, their facts, and what can be done with them. */
export interface MatrixDriveViewProps {
  rows: readonly MatrixDriveRow[]
  view: Pick<MatrixDriveView, 'state' | 'lastSyncAt' | 'factsStale'>
  locale: Locale
  selectedId: string | null
  formatSize(bytes: number): string
  formatDate(at: number): string
  onSelect(id: string | null): void
  onOpen(row: MatrixDriveRow): void
  /** Space, as Finder's Quick Look: absent when this surface has no preview. */
  onQuickLook?(row: MatrixDriveRow): void
  onNavigate(direction: 'back' | 'forward'): void
  /** What an assistant may do with this item in the open chat, for its right-click menu. */
  itemActions?(row: MatrixDriveRow): MatrixDriveItemAction[]
}

export interface MatrixDriveBrowserProps extends MatrixDriveViewProps {
  layout: 'icon' | 'list'
  groupBy: MatrixDriveGroupBy
  sort: MatrixDriveSort
  onSort(key: MatrixDriveSortKey): void
}

const BADGE: Record<MatrixDriveItemSync, { icon: typeof CheckCircle2; tone: string }> = {
  synced: { icon: CheckCircle2, tone: 'text-(--ak-ok)' },
  pending: { icon: RefreshCw, tone: 'text-(--ak-ink-3)' },
  paused: { icon: CloudOff, tone: 'text-(--ak-ink-4)' }
}

export function DriveSyncBadge({
  className,
  id,
  label,
  sync
}: {
  className?: string
  id: string
  label: string
  sync: MatrixDriveItemSync
}) {
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

/** An item's right-click menu: Open, Quick Look, then what the assistant may do with it. */
export function DriveItemMenu({
  children,
  locale,
  onOpen,
  onQuickLook,
  actions
}: {
  children: ReactElement
  locale: Locale
  onOpen(): void
  onQuickLook?: () => void
  actions: readonly MatrixDriveItemAction[]
}) {
  const copy = matrixDriveCopy[locale]

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={onOpen}>{copy.preview.open}</ContextMenuItem>
        {onQuickLook && <ContextMenuItem onSelect={onQuickLook}>{copy.quickLook}</ContextMenuItem>}
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

/**
 * The keys every view handles alike: ⌘[ ⌘] ⌘↑ to move between folders, Return or ⌘↓ or ⌘O to open,
 * Space for Quick Look and Esc to clear. True when the key was one of them.
 */
export function driveCommandKey(
  event: KeyboardEvent<HTMLElement>,
  selected: MatrixDriveRow | undefined,
  { onOpen, onQuickLook, onNavigate, onClear }: Pick<MatrixDriveViewProps, 'onOpen' | 'onQuickLook' | 'onNavigate'> & {
    onClear?: () => void
  }
): boolean {
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
      return false
    }

    event.preventDefault()

    if (command === 'open') {
      if (selected) {
        onOpen(selected)
      }
    } else {
      onNavigate(command)
    }

    return true
  }

  if (event.altKey) {
    return true
  }

  if (event.key === 'Enter') {
    if (selected) {
      event.preventDefault()
      onOpen(selected)
    }

    return true
  }

  if (event.key === ' ') {
    event.preventDefault()

    if (selected?.kind === 'file' && onQuickLook) {
      onQuickLook(selected)
    }

    return true
  }

  if (event.key === 'Escape') {
    if (selected && onClear) {
      event.preventDefault()
      onClear()
    }

    return true
  }

  return false
}

/** Type a name's first letters to jump to it: the index of the match, or -1. */
export function useDriveTypeSelect(locale: Locale) {
  const typed = useRef({ text: '', at: 0 })

  return (key: string, rows: readonly Pick<MatrixDriveRow, 'name'>[]): number => {
    if (key.length !== 1 || !key.trim()) {
      return -1
    }

    const now = Date.now()
    const text = now - typed.current.at > TYPE_SELECT_PAUSE_MS ? key : typed.current.text + key
    typed.current = { text, at: now }

    return typeSelectDriveRow(rows, text, locale)
  }
}

function columnsOf(list: HTMLElement | null): number {
  const grid = list?.querySelector<HTMLElement>('[data-matrix-drive-grid]')
  const template = grid ? getComputedStyle(grid).gridTemplateColumns : ''
  const tracks = template && template !== 'none' ? template.split(' ').filter(Boolean).length : 0

  if (tracks > 0) {
    return tracks
  }

  // No layout to read (a test's document): count the first row of items as they sit.
  const items = [...(grid?.querySelectorAll<HTMLElement>('[data-matrix-drive-item]') ?? [])]

  if (items.length === 0) {
    return 1
  }

  const top = items[0]!.offsetTop
  const wrap = items.findIndex(item => item.offsetTop !== top)

  return wrap < 0 ? items.length : wrap
}

const LIST_COLUMNS = 'grid-cols-[minmax(0,1fr)_11rem_6rem]'

/** The icon grid or the list: click selects, double-click opens, the keyboard moves as Finder's does. */
export function MatrixDriveBrowser({
  rows,
  layout,
  groupBy,
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
  const typeSelect = useDriveTypeSelect(locale)
  const baseId = useId()
  const groups = groupDriveRows(rows, groupBy, { now: Date.now(), locale, copy: copy.groups })
  const ordered = groups.flatMap(group => group.rows)
  const grouped = groups.length > 0 && groups[0]!.label !== ''
  const selectedIndex = ordered.findIndex(row => row.id === selectedId)

  useEffect(() => {
    if (focusAfterMove.current && focusAfterMove.current === selectedId) {
      focusAfterMove.current = null
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-matrix-drive-item]') ?? [])]
      items.find(item => item.dataset.matrixDriveItem === selectedId)?.focus()
    }
  }, [selectedId])

  const moveTo = (index: number) => {
    const row = ordered[index]

    if (row) {
      focusAfterMove.current = row.id
      onSelect(row.id)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selected = ordered[selectedIndex]

    if (driveCommandKey(event, selected, { onOpen, onQuickLook, onNavigate, onClear: () => onSelect(null) })) {
      return
    }

    const columns = layout === 'icon' ? columnsOf(listRef.current) : 1

    const next = moveDriveSelectionInGroups(
      groups.map(group => group.rows.length),
      selectedIndex,
      event.key,
      columns
    )

    if (next !== null) {
      event.preventDefault()
      moveTo(next)

      return
    }

    const match = typeSelect(event.key, ordered)

    if (match >= 0) {
      event.preventDefault()
      moveTo(match)
    }
  }

  // A click on the empty space between items clears the selection, as in Finder.
  const clearOnBackground = (event: MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) {
      onSelect(null)
    }
  }

  const item = (row: MatrixDriveRow) => {
    const index = ordered.indexOf(row)
    const selected = row.id === selectedId
    const sync = driveItemSync(row, view)
    const badgeId = `${baseId}-${index}`
    const focusable = selectedIndex >= 0 ? selected : index === 0

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
            'ak-focusable grid h-7 cursor-default items-center gap-(--ak-s3) rounded-(--ak-r-sm) px-(--ak-s2) [font:var(--ak-t-body)] select-none',
            LIST_COLUMNS,
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
      <DriveItemMenu
        actions={itemActions?.(row) ?? []}
        key={row.id}
        locale={locale}
        onOpen={() => onOpen(row)}
        onQuickLook={row.kind === 'file' && onQuickLook ? () => onQuickLook(row) : undefined}
      >
        {element}
      </DriveItemMenu>
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

  const run = (items: readonly MatrixDriveRow[]) => (
    <div
      className={
        layout === 'icon'
          ? 'grid content-start grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-x-(--ak-s2) gap-y-(--ak-s4)'
          : 'flex flex-col'
      }
      data-matrix-drive-grid={layout === 'icon' ? '' : undefined}
      onClick={clearOnBackground}
    >
      {items.map(item)}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-matrix-drive-browser={layout} data-matrix-drive-group={groupBy}>
      {layout === 'list' && (
        <div className={cn('grid items-center gap-(--ak-s3) border-b border-(--ak-line) px-(--ak-s2) pb-(--ak-s1)', LIST_COLUMNS)}>
          {header('name', copy.name)}
          {header('modified', copy.modified)}
          {header('size', copy.size, 'justify-end')}
        </div>
      )}
      <div
        aria-label={copy.title}
        className={cn('min-h-0 flex-1', layout === 'icon' ? 'pt-(--ak-s2)' : 'pt-(--ak-s1)', grouped && 'flex flex-col gap-(--ak-s4)')}
        data-matrix-drive-items
        onClick={clearOnBackground}
        onKeyDown={onKeyDown}
        ref={listRef}
        role="listbox"
      >
        {grouped
          ? groups.map(group => (
              // Finder's group: its title over a hairline, then its items in the view's own layout.
              <div aria-label={group.label} data-matrix-drive-group-id={group.id} key={group.id} role="group">
                <p
                  aria-hidden
                  className={cn(
                    'flex items-baseline gap-(--ak-s2) border-b border-(--ak-line) px-(--ak-s2) pb-(--ak-s1) [font:var(--ak-t-callout)] font-semibold text-(--ak-ink-2)',
                    layout === 'icon' ? 'mb-(--ak-s3)' : 'mb-(--ak-s1)'
                  )}
                  data-matrix-drive-group-title
                >
                  <span className="truncate">{group.label}</span>
                  <span className="font-normal text-(--ak-ink-3) tabular-nums">{group.rows.length}</span>
                </p>
                {run(group.rows)}
              </div>
            ))
          : run(ordered)}
      </div>
    </div>
  )
}

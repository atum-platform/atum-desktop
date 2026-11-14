import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef } from 'react'

import { ConsumerFileGlyph } from '@/app/atum/consumer-file-icon'
import { ChevronRight, Folder } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixDriveRow } from '../../shared/matrix-drive'

import {
  driveCommandKey,
  DriveItemMenu,
  DriveSyncBadge,
  type MatrixDriveViewProps,
  useDriveTypeSelect
} from './drive-browser'
import {
  type DriveColumn,
  driveColumnFocus,
  driveColumnMove,
  driveColumnPick,
  type DriveColumnTarget
} from './drive-columns'
import { matrixDriveCopy } from './drive-copy'
import { driveItemSync, middleTruncateDriveName, moveDriveSelection } from './drive-finder'
import { driveKindFamily } from './drive-groups'
import { MatrixFileGlyph } from './file-glyph'

/** A column's names are cut in the middle, as Finder's are, so "Meeting (1)" and "(2)" stay apart. */
const COLUMN_NAME_LENGTH = 23

export interface MatrixDriveColumnsProps extends MatrixDriveViewProps {
  /** The columns, each already in the page's sort order; the last is the open folder. */
  columns: readonly DriveColumn[]
  /** The open folder's place in the Drive; null when this window never saw how it got there. */
  path: readonly string[] | null
  rootLabel: string
  /** Go to another column's folder or item; `open` opens the file once it is reached. */
  onPick(target: DriveColumnTarget, then?: 'open'): void
}

/**
 * Finder's column view: the folders on the open path side by side, the open folder last, and a
 * preview of the selected file after it. Arrows move as Finder's do; a folder opens as it is selected.
 */
export function MatrixDriveColumns({
  columns,
  path,
  rootLabel,
  view,
  locale,
  selectedId,
  formatSize,
  formatDate,
  onSelect,
  onOpen,
  onQuickLook,
  onNavigate,
  onPick,
  itemActions
}: MatrixDriveColumnsProps) {
  const copy = matrixDriveCopy[locale]
  const scroller = useRef<HTMLDivElement>(null)
  const focusActive = useRef(false)
  const typeSelect = useDriveTypeSelect(locale)
  const baseId = useId()
  const live = columns.at(-1)!
  const selected = live.rows.find(row => row.id === selectedId)
  const focus = driveColumnFocus(path, selected?.name ?? null)
  const activeColumn = focus === 'leaf' ? columns.length - 1 : columns.length - 2
  const activeKey = `${path?.join('/') ?? ''}\u0000${selected?.id ?? ''}`
  const activeRows = columns[activeColumn]?.rows ?? []

  const activeAt =
    focus === 'leaf'
      ? live.rows.findIndex(item => item.id === selectedId)
      : activeRows.findIndex(item => item.kind === 'folder' && item.name === path?.at(-1))

  // One tab stop: the selection the keyboard is on, else the first item it can reach.
  const tabStop: [number, number] =
    activeAt >= 0 ? [activeColumn, activeAt] : activeRows.length ? [activeColumn, 0] : [columns.length - 1, 0]

  const previewed = selected?.kind === 'file' ? selected : undefined
  const previewing = Boolean(previewed)

  // The newest column is in view, as Finder scrolls to it.
  useLayoutEffect(() => {
    const element = scroller.current

    if (element) {
      element.scrollLeft = element.scrollWidth
    }
  }, [columns.length, previewing])

  useEffect(() => {
    const active = scroller.current?.querySelector<HTMLElement>('[data-matrix-drive-column-active]')
    active?.scrollIntoView?.({ block: 'nearest' })

    if (focusActive.current && active) {
      focusActive.current = false
      active.focus()
    }
  }, [activeKey])

  const go = (target: DriveColumnTarget, then?: 'open') => {
    focusActive.current = true
    onPick(target, then)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (driveCommandKey(event, selected, { onOpen, onQuickLook, onNavigate, onClear: () => onSelect(null) })) {
      return
    }

    if (!path) {
      // The open folder alone: a list to move through; Return opens a folder.
      const index = live.rows.findIndex(row => row.id === selectedId)
      const next = moveDriveSelection(live.rows.length, index, event.key, 1)

      if (next !== null) {
        event.preventDefault()
        focusActive.current = true
        onSelect(live.rows[next]!.id)
      }

      return
    }

    const target = driveColumnMove(columns, path, selected?.name ?? null, event.key)

    if (target) {
      event.preventDefault()
      go(target)

      return
    }

    if (event.key.startsWith('Arrow')) {
      event.preventDefault()

      return
    }

    const column = columns[activeColumn]
    const match = column ? typeSelect(event.key, column.rows) : -1

    if (column?.path && match >= 0) {
      event.preventDefault()
      go(driveColumnPick(column.path, column.rows[match]!))
    }
  }

  const row = (column: DriveColumn, index: number, item: MatrixDriveRow, at: number) => {
    const isSelected = column.live ? item.id === selectedId : item.kind === 'folder' && item.name === column.open
    // The keyboard's own column shows its selection in full; a folder further back shows it quietly.
    const active = isSelected && index === activeColumn
    const sync = column.live ? driveItemSync(item, view) : null
    const badgeId = `${baseId}-${index}-${at}`
    const tabbable = tabStop[0] === index && tabStop[1] === at

    const pick = () => {
      if (column.live && (item.kind === 'file' || !column.path)) {
        onSelect(item.id)
      } else if (column.path) {
        go(driveColumnPick(column.path, item))
      }
    }

    const element = (
      <div
        aria-describedby={sync ? badgeId : undefined}
        aria-label={item.name}
        aria-selected={isSelected}
        className={cn(
          'ak-focusable flex h-7 shrink-0 cursor-default items-center gap-(--ak-s2) rounded-(--ak-r-sm) px-(--ak-s2) [font:var(--ak-t-body)] text-(--ak-ink) select-none',
          active ? 'bg-(--ak-fill-selected)' : isSelected && 'bg-(--ak-fill-quiet)'
        )}
        data-matrix-drive-column-active={active ? '' : undefined}
        data-matrix-drive-item={column.live ? item.id : undefined}
        data-matrix-drive-kind={item.kind}
        key={`${item.kind}:${item.name}`}
        onClick={pick}
        onContextMenu={column.live ? () => onSelect(item.id) : undefined}
        onDoubleClick={() => {
          if (item.kind !== 'file') {
            if (!column.path && column.live) {
              onOpen(item)
            }

            return
          }

          if (column.live) {
            onOpen(item)
          } else if (column.path) {
            go(driveColumnPick(column.path, item), 'open')
          }
        }}
        role="option"
        tabIndex={tabbable ? 0 : -1}
      >
        {item.kind === 'folder' ? (
          <Folder aria-hidden className="size-4 shrink-0 text-(--ak-ink-2)" />
        ) : (
          <MatrixFileGlyph className="size-4 shrink-0 text-(--ak-ink-2)" name={item.name} />
        )}
        <span className={cn('min-w-0 flex-1 truncate', active && 'font-semibold')} title={item.name}>
          {middleTruncateDriveName(item.name, COLUMN_NAME_LENGTH)}
        </span>
        {sync && <DriveSyncBadge className="bg-transparent" id={badgeId} label={copy.sync[sync]} sync={sync} />}
        {item.kind === 'folder' && <ChevronRight aria-hidden className="size-3 shrink-0 text-(--ak-ink-3)" />}
      </div>
    )

    // Only the open folder's items have current ids for Open and the assistant's actions.
    return column.live ? (
      <DriveItemMenu
        actions={itemActions?.(item) ?? []}
        key={`${item.kind}:${item.name}`}
        locale={locale}
        onOpen={() => onOpen(item)}
        onQuickLook={item.kind === 'file' && onQuickLook ? () => onQuickLook(item) : undefined}
      >
        {element}
      </DriveItemMenu>
    ) : (
      element
    )
  }

  return (
    <div
      className="flex h-0 min-h-[18rem] flex-1 overflow-x-auto overflow-y-hidden border-t border-(--ak-line)"
      data-matrix-drive-browser="column"
      onKeyDown={onKeyDown}
      ref={scroller}
    >
      {columns.map((column, index) => {
        const label = column.path === null ? '' : (column.path.at(-1) ?? rootLabel)

        return (
          <div
            aria-label={label || rootLabel}
            className="flex w-[14.5rem] shrink-0 flex-col gap-px overflow-y-auto border-e border-(--ak-line) p-(--ak-s1)"
            data-matrix-drive-column={column.path?.join('/') ?? ''}
            data-matrix-drive-column-live={column.live ? '' : undefined}
            // A click below a column's items leaves only that column's folder open, as in Finder.
            key={column.path?.join('\u0000') ?? 'open'}
            onClick={event => {
              if (event.target === event.currentTarget && column.path) {
                go({ path: [...column.path], selected: null })
              }
            }}
            role="listbox"
          >
            {column.rows.map((item, at) => row(column, index, item, at))}
          </div>
        )
      })}
      {previewed && (
        <div
          className="flex min-w-[16rem] flex-1 flex-col items-center justify-center gap-(--ak-s2) p-(--ak-s6) text-center"
          data-matrix-drive-column-preview
          onDoubleClick={() => onOpen(previewed)}
        >
          <span aria-hidden className="mb-(--ak-s6) grid h-24 place-items-center [&>*]:scale-150">
            <ConsumerFileGlyph isDirectory={false} name={previewed.name} />
          </span>
          <p className="max-w-full [font:var(--ak-t-body-strong)] break-words text-(--ak-ink)">{previewed.name}</p>
          <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">
            {copy.itemKinds[driveKindFamily(previewed)]} · {formatSize(previewed.size)}
          </p>
          <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">
            {copy.preview.modified} {formatDate(previewed.modifiedAt)}
          </p>
        </div>
      )}
    </div>
  )
}

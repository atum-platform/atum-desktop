import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'

import { ConsumerFileGlyph } from '@/app/atum/consumer-file-icon'
import { cn } from '@/lib/utils'

import type { MatrixDriveBridge } from '../../shared/matrix-drive'

import {
  driveCommandKey,
  DriveItemMenu,
  DriveSyncBadge,
  type MatrixDriveViewProps,
  useDriveTypeSelect
} from './drive-browser'
import { matrixDriveCopy } from './drive-copy'
import { $matrixDrivePdfLease, driveItemSync, middleTruncateDriveName, moveDriveSelection } from './drive-finder'
import { driveGalleryPreview, driveKindFamily } from './drive-groups'

/** How long the selection rests before the gallery asks main for its preview. */
const PREVIEW_SETTLE_MS = 120
/** The text a page shows: enough to fill it, never the whole file. */
const PAGE_TEXT_LENGTH = 4000

export interface MatrixDriveGalleryProps extends MatrixDriveViewProps {
  /** Main's one bounded preview lease; absent when this build has none. */
  bridge?: Pick<MatrixDriveBridge, 'preview' | 'closePreview'>
}

type Shown = { id: string; kind: 'image'; dataUrl: string } | { id: string; kind: 'text'; text: string }

/**
 * Finder's gallery: the selected item large, its name and facts under it, and every item in a strip
 * along the bottom. Pictures and text come from main's preview lease; anything else is its glyph.
 */
export function MatrixDriveGallery({
  rows,
  view,
  locale,
  selectedId,
  formatSize,
  formatDate,
  onSelect,
  onOpen,
  onQuickLook,
  onNavigate,
  itemActions,
  bridge
}: MatrixDriveGalleryProps) {
  const copy = matrixDriveCopy[locale]
  const strip = useRef<HTMLDivElement>(null)
  const focusAfterMove = useRef<string | null>(null)
  const typeSelect = useDriveTypeSelect(locale)
  const baseId = useId()
  const pdfLeaseHeld = useStore($matrixDrivePdfLease)
  const [shown, setShown] = useState<Shown | null>(null)
  const selectedIndex = rows.findIndex(row => row.id === selectedId)
  const selected = rows[selectedIndex]

  // The gallery always shows something: the first item until another is chosen, as in Finder.
  useEffect(() => {
    if (!selected && rows[0]) {
      onSelect(rows[0].id)
    }
  }, [onSelect, rows, selected])

  const selectedPreview = selected ? driveGalleryPreview(selected) : null
  const selectedRowId = selected?.id

  useEffect(() => {
    if (!selectedRowId || !selectedPreview || pdfLeaseHeld || !bridge?.preview) {
      return
    }

    let disposed = false

    const timer = setTimeout(() => {
      void bridge.preview!(selectedRowId)
        .then(value => {
          // Pictures and text arrive whole: the lease is given back at once.
          void bridge.closePreview?.(value.token).catch(() => {})

          if (disposed) {
            return
          }

          if (value.kind === 'image') {
            setShown({ id: selectedRowId, kind: 'image', dataUrl: value.dataUrl })
          } else if (value.kind === 'text') {
            setShown({ id: selectedRowId, kind: 'text', text: value.text.slice(0, PAGE_TEXT_LENGTH) })
          }
        })
        .catch(() => {})
    }, PREVIEW_SETTLE_MS)

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [bridge, pdfLeaseHeld, selectedPreview, selectedRowId])

  useEffect(() => {
    const items = [...(strip.current?.querySelectorAll<HTMLElement>('[data-matrix-drive-item]') ?? [])]
    const item = items.find(element => element.dataset.matrixDriveItem === selectedId)
    item?.scrollIntoView?.({ block: 'nearest', inline: 'center' })

    // The strip keeps the keyboard on the item it moved to.
    if (item && focusAfterMove.current === selectedId) {
      focusAfterMove.current = null
      item.focus()
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
    if (driveCommandKey(event, selected, { onOpen, onQuickLook, onNavigate })) {
      return
    }

    // One row of items: Left and Right move; Up and Down stay, as Finder's strip does.
    const next = moveDriveSelection(rows.length, selectedIndex, event.key, rows.length)

    if (next !== null) {
      event.preventDefault()
      moveTo(next)

      return
    }

    const match = typeSelect(event.key, rows)

    if (match >= 0) {
      event.preventDefault()
      moveTo(match)
    }
  }

  const current = shown && shown.id === selected?.id ? shown : null
  const sync = selected ? driveItemSync(selected, view) : null

  return (
    <div className="flex h-0 min-h-[22rem] flex-1 flex-col" data-matrix-drive-browser="gallery">
      {selected && (
        <div
          className="flex min-h-0 flex-1 flex-col items-center gap-(--ak-s3) px-(--ak-s6) pt-(--ak-s2) pb-(--ak-s4)"
          data-matrix-drive-gallery-stage={current?.kind ?? 'glyph'}
          onDoubleClick={() => onOpen(selected)}
        >
          <div className="flex min-h-0 w-full flex-1 items-center justify-center">
            {current?.kind === 'image' ? (
              <img
                alt={selected.name}
                className="h-full w-full object-contain"
                draggable={false}
                src={current.dataUrl}
              />
            ) : current?.kind === 'text' ? (
              // A page of the document, as Finder draws text in its gallery.
              <div className="relative aspect-[0.77] h-full max-h-[26rem] max-w-full overflow-hidden rounded-[0.5rem] bg-(--atum-page) p-(--ak-s5) shadow-(--atum-shadow-tile)">
                <pre className="font-mono text-[0.625rem] leading-[1.5] break-words whitespace-pre-wrap text-(--atum-page-ink)">
                  {current.text}
                </pre>
              </div>
            ) : (
              <span aria-hidden className="grid size-40 place-items-center [&>*]:scale-[2.2]">
                <ConsumerFileGlyph isDirectory={selected.kind === 'folder'} name={selected.name} />
              </span>
            )}
          </div>
          <div className="flex max-w-full shrink-0 flex-col items-center gap-px text-center">
            <p className="flex max-w-full items-center gap-(--ak-s1) [font:var(--ak-t-body-strong)] text-(--ak-ink)">
              <span className="truncate" title={selected.name}>
                {selected.name}
              </span>
              {sync && (
                <DriveSyncBadge className="bg-transparent" id={`${baseId}-stage`} label={copy.sync[sync]} sync={sync} />
              )}
            </p>
            <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3) tabular-nums">
              {[
                copy.itemKinds[driveKindFamily(selected)],
                selected.kind === 'file' ? formatSize(selected.size) : null,
                formatDate(selected.modifiedAt)
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
      )}
      <div
        aria-label={copy.title}
        aria-orientation="horizontal"
        className="flex shrink-0 gap-(--ak-s1) overflow-x-auto border-t border-(--ak-line) px-(--ak-s2) pt-(--ak-s2) pb-(--ak-s1)"
        data-matrix-drive-filmstrip
        onKeyDown={onKeyDown}
        ref={strip}
        role="listbox"
      >
        {rows.map((row, index) => {
          const isSelected = row.id === selectedId
          const badge = driveItemSync(row, view)
          const badgeId = `${baseId}-${index}`

          return (
            <DriveItemMenu
              actions={itemActions?.(row) ?? []}
              key={row.id}
              locale={locale}
              onOpen={() => onOpen(row)}
              onQuickLook={row.kind === 'file' && onQuickLook ? () => onQuickLook(row) : undefined}
            >
              <div
                aria-describedby={badge ? badgeId : undefined}
                aria-label={row.name}
                aria-selected={isSelected}
                className={cn(
                  'ak-focusable relative grid size-[4.5rem] shrink-0 cursor-default place-items-center rounded-(--ak-r-md) select-none',
                  isSelected && 'bg-(--ak-fill-selected)'
                )}
                data-matrix-drive-item={row.id}
                data-matrix-drive-kind={row.kind}
                onClick={() => onSelect(row.id)}
                onContextMenu={() => onSelect(row.id)}
                onDoubleClick={() => onOpen(row)}
                role="option"
                tabIndex={(selectedIndex >= 0 ? isSelected : index === 0) ? 0 : -1}
                title={middleTruncateDriveName(row.name, 40)}
              >
                <span aria-hidden className="grid place-items-center [&>*]:scale-[0.72]">
                  <ConsumerFileGlyph isDirectory={row.kind === 'folder'} name={row.name} />
                </span>
                {badge && (
                  <DriveSyncBadge
                    className="absolute end-1 bottom-1"
                    id={badgeId}
                    label={copy.sync[badge]}
                    sync={badge}
                  />
                )}
              </div>
            </DriveItemMenu>
          )
        })}
      </div>
    </div>
  )
}

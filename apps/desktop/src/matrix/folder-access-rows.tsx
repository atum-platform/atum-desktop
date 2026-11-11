import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Switch } from '@/components/ui/switch'
import { Cloud, Download, FileText, Folder, FolderPlus, Monitor, X } from '@/lib/icons'

import type { MatrixFolderAccessRow, MatrixFolderKind } from '../../shared/matrix-folder-access'
import type { MatrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'

import { SettingsRow } from './settings-row'

type FolderCopy = MatrixKnowledgeSourcesCopy['folderAccess']

const GLYPHS: Record<MatrixFolderKind, (className: string) => ReactNode> = {
  desktop: className => <Monitor aria-hidden className={className} />,
  documents: className => <FileText aria-hidden className={className} />,
  downloads: className => <Download aria-hidden className={className} />,
  icloud: className => <Cloud aria-hidden className={className} />,
  added: className => <Folder aria-hidden className={className} />
}

export function matrixFolderAccessName(row: MatrixFolderAccessRow, copy: FolderCopy): string {
  return row.kind === 'added' ? (row.name ?? '') : copy.names[row.kind]
}

/**
 * First run: the folders under the Mac folders row, each ticked by default, then "Add a folder…".
 * One label per row; the reason for each macOS prompt waits behind the parent row's tip.
 */
export function MatrixFirstRunFolderRows({
  copy,
  disabled,
  folders,
  onAdd,
  onToggle,
  selected,
  status
}: {
  copy: FolderCopy
  disabled: boolean
  folders: readonly MatrixFolderAccessRow[]
  onAdd?: () => void
  onToggle(id: string, enabled: boolean): void
  selected: ReadonlySet<string>
  /** A row's settled outcome after Continue ("Done", "Not allowed"); a checkbox until then. */
  status(row: MatrixFolderAccessRow): string | null
}) {
  return (
    <ConsentBoundary><div className="grid grid-cols-[minmax(0,1fr)]" data-matrix-first-run-folders role="group">
      {folders.map(row => {
        const name = matrixFolderAccessName(row, copy)
        const checked = selected.has(row.id)
        const label = status(row)

        return (
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-(--ak-s3)"
            data-matrix-first-run-folder={row.id}
            key={row.id}
            style={{ minHeight: 28 }}
          >
            <span className="flex min-w-0 items-center gap-(--ak-s2)">
              {GLYPHS[row.kind]('size-3.5 shrink-0 text-(--ak-ink-3)')}
              <span className="truncate" style={{ font: 'var(--ak-t-body)', color: 'var(--ak-ink)' }}>
                {name}
              </span>
            </span>
            {label ? (
              <span className="ak-row-meta shrink-0" role="status">
                {label}
              </span>
            ) : (
              <Checkbox
                aria-label={name}
                checked={checked}
                className={`ak-check shrink-0 focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-(--ak-focus) ${checked ? 'is-on' : ''}`}
                disabled={disabled}
                onCheckedChange={enabled => onToggle(row.id, enabled === true)}
              />
            )}
          </div>
        )
      })}
      {onAdd && (
        <div style={{ minHeight: 28 }}>
          <Button
            className="ak-btn ak-btn--plain ak-btn--sm"
            data-matrix-first-run-folder-add
            disabled={disabled}
            onClick={onAdd}
            size="sm"
            // The capsule's own padding sits outside the column, so the glyph lines up with the rows above.
            style={{ marginInlineStart: -11 }}
            variant="text"
          >
            <FolderPlus aria-hidden className="size-3.5" />
            {copy.add}
          </Button>
        </div>
      )}
    </div></ConsentBoundary>
  )
}

/** Settings › Connections: the same list, one switch per standard folder, Remove for added ones. */
export function MatrixSettingsFolderRows({
  busy,
  copy,
  folders,
  onAdd,
  onOpenSettings,
  onRemove,
  onToggle
}: {
  busy: boolean
  copy: FolderCopy
  folders: readonly MatrixFolderAccessRow[]
  onAdd?: () => void
  onOpenSettings?: (id: string) => void
  onRemove(id: string): void
  onToggle(id: string, enabled: boolean): void
}) {
  return (
    <ConsentBoundary><>
      {folders.map(row => {
        const name = matrixFolderAccessName(row, copy)
        const closed = row.kind !== 'added' && row.shared && row.mac === 'denied'

        return (
          <SettingsRow
            className="atum-settings-row-sub"
            control={
              row.kind === 'added' ? (
                <Button
                  aria-label={`${copy.remove} ${name}`}
                  className="ak-btn ak-btn--plain ak-btn--sm"
                  disabled={busy}
                  onClick={() => onRemove(row.id)}
                  size="sm"
                  variant="text"
                >
                  <X aria-hidden className="size-3.5" />
                  {copy.remove}
                </Button>
              ) : (
                // macOS refusing a folder never takes away the owner's own switch: they can still
                // turn it off here, so a later macOS grant can't open it without a new yes.
                <span className="flex items-center gap-(--ak-s2)">
                  {closed && onOpenSettings && (
                    <Button disabled={busy} onClick={() => onOpenSettings(row.id)} size="sm" variant="secondary">
                      {copy.openSettings}
                    </Button>
                  )}
                  <Switch
                    aria-label={name}
                    checked={row.shared}
                    disabled={busy}
                    onCheckedChange={enabled => onToggle(row.id, enabled)}
                  />
                </span>
              )
            }
            data-matrix-settings-folder={row.id}
            help={closed ? copy.closed : undefined}
            key={row.id}
            lead={GLYPHS[row.kind]('size-4')}
            title={name}
          />
        )
      })}
      {onAdd && (
        <div className="atum-settings-row atum-settings-row-sub">
          <Button
            className="ak-btn ak-btn--plain ak-btn--sm"
            data-matrix-settings-folder-add
            disabled={busy}
            onClick={onAdd}
            size="sm"
            // The capsule's own padding sits outside the column, so the glyph lines up with the rows above.
            style={{ marginInlineStart: -11 }}
            variant="text"
          >
            <FolderPlus aria-hidden className="size-4" />
            {copy.add}
          </Button>
        </div>
      )}
    </></ConsentBoundary>
  )
}

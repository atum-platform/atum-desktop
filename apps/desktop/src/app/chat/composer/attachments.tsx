import { useStore } from '@nanostores/react'

import { ConsumerFileIcon } from '@/app/atum/consumer-file-icon'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { AlertCircle, FileText, FolderOpen, ImageIcon, Link, Loader2, MoreVertical, Terminal } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import { $actionPanelOwner } from '@/store/action-panel-owner'
import type { ComposerAttachment } from '@/store/composer'
import {
  bringLinkedWordToFront,
  reconnectContextLink,
  removeContextLink,
  showLinkedDocument,
  useAutomaticContext
} from '@/store/context-link-actions'
import { $contextLinkError, $conversationContextLink } from '@/store/conversation-context-links'
import { $documentContext, suppressDocumentContext } from '@/store/document-context'
import { notifyError } from '@/store/notifications'
import { setCurrentSessionPreviewTarget } from '@/store/preview'
import { $currentCwd } from '@/store/session'

import { openContextLinkPickerFrom } from './context-link-picker'
import { useComposerScope } from './scope'

export function AttachmentList({
  attachments,
  onRemove,
  onSendWithoutDocument,
  sendWithoutDocumentDisabled = false
}: {
  attachments: ComposerAttachment[]
  onRemove?: (id: string) => void
  onSendWithoutDocument?: () => boolean
  sendWithoutDocumentDisabled?: boolean
}) {
  const { t } = useI18n()
  const linkError = useStore($contextLinkError)
  const scope = useComposerScope()
  const currentDocument = useStore($documentContext)
  const documentContext = scope.target === 'main' ? currentDocument : null
  const link = useStore($conversationContextLink)

  const hasLink = scope.target === 'main' && link.mode === 'linked'
  const contextPaused = scope.target === 'main' && link.mode === 'removed'

  if (attachments.filter(Boolean).length === 0 && !documentContext && !hasLink && !contextPaused) {
    return null
  }

  return (
    <div className="flex max-w-full flex-wrap gap-1.5 px-1 pt-1" data-slot="composer-attachments">
      {hasLink ? <LinkedDocumentContextPill onSendWithoutDocument={onSendWithoutDocument} sendWithoutDocumentDisabled={sendWithoutDocumentDisabled} /> : documentContext && <DocumentContextPill />}
      {contextPaused && <NoticeBand className="w-full" role="status">
        {t.composer.contextPaused}
        <Button className="ms-1" onClick={useAutomaticContext} size="xs" type="button" variant="ghost">{t.composer.useAutomaticContext}</Button>
      </NoticeBand>}
      {hasLink && linkError?.startsWith('CONTEXT_LINK_SHOW_FAILED') && (
        <NoticeBand className="w-full" role="status">
          {t.composer.linkedCouldNotShowBeside}
          <Button className="ms-1" onClick={() => void showLinkedDocument()} size="xs" type="button" variant="ghost">{t.composer.showBeside}</Button>
        </NoticeBand>
      )}
      {attachments.filter(Boolean).map(attachment => (
        <AttachmentPill attachment={attachment} key={attachment.id} onRemove={onRemove} />
      ))}
    </div>
  )
}

function DocumentContextPill() {
  const { t } = useI18n()
  const item = useStore($documentContext)
  const owner = useStore($actionPanelOwner)

  if (!item) {
    return null
  }

  const detail = !owner ? t.composer.contextNotIncluded : item.selection
    ? t.composer.documentSelectedLines(item.selection.endLine - item.selection.startLine + 1)
    : item.state === 'unavailable'
      ? t.composer.documentOutsideWorkspace
      : undefined

  const statuses = [
    item.selection?.truncated ? t.composer.documentTruncated : undefined,
    item.state === 'changed' ? t.composer.documentChanged : undefined,
    item.state === 'refused' ? t.composer.documentRefused : undefined
  ].filter((value): value is string => Boolean(value))

  const status = statuses.join(' · ') || undefined

  // The chip is a slip of paper clipped to the message, not a card: one line,
  // the document's own type glyph, and its name. "Working with · " said what
  // the chip's presence already says, and cost the filename the width it
  // needed. Everything else — the path, the selected range, a changed or
  // refused document — is a tooltip and the screen-reader label, so the chip
  // stays one line tall however much state it is carrying.
  const label = t.composer.workingWithDocument(item.identity.name)
  const tip = [item.identity.path, detail, status].filter(Boolean).join(' · ')

  return (
    <Tip label={tip}>
      <div
        aria-label={[label, detail, status].filter(Boolean).join('. ')}
        className="group/attachment relative min-w-0 shrink-0"
      >
        <button
          aria-label={[label, t.composer.automatic, detail, status].filter(Boolean).join('. ')}
          className={cn(
            'flex h-6 max-w-56 items-center gap-1.5 rounded-md border border-(--atum-line) bg-(--atum-sunk) ps-1.5 pe-2',
            // Anything the user should notice about the document — it changed
            // under us, it was refused, it is out of the workspace — warms the
            // hairline rather than adding a second line of copy.
            (status || item.state === 'unavailable') && 'border-(--atum-warn)'
          )}
          data-slot="composer-document-context"
          onClick={event => openContextLinkPickerFrom(event.currentTarget)}
          type="button"
        >
          <ConsumerFileIcon className="size-3.5 shrink-0" isDirectory={false} name={item.identity.name} />
          <span className="min-w-0 truncate text-[0.6875rem] leading-none text-(--atum-ink-soft)">
            {item.identity.name}
          </span>
          <span className="text-[0.625rem] text-(--atum-ink-soft)">{t.composer.automatic}</span>
        </button>
        <Tip label={t.composer.suppressDocumentContext}>
          <button
            aria-label={t.composer.suppressDocumentContext}
            className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full border border-(--atum-line-strong) bg-(--atum-bg-high) text-(--atum-ink-muted) opacity-0 shadow-xs transition hover:text-(--atum-ink) group-hover/attachment:opacity-100 focus-visible:opacity-100"
            onClick={() => suppressDocumentContext(item.scopeKey, item.identity.path)}
            type="button"
          >
            <Codicon name="close" size="0.625rem" />
          </button>
        </Tip>
      </div>
    </Tip>
  )
}

function LinkedDocumentContextPill({ onSendWithoutDocument, sendWithoutDocumentDisabled }: { onSendWithoutDocument?: () => boolean; sendWithoutDocumentDisabled?: boolean }) {
  const { t } = useI18n()
  const link = useStore($conversationContextLink)

  if (link.mode !== 'linked' || !link.target) {return null}
  const target = link.target

  const access = link.state === 'unavailable'
    ? t.composer.unavailable
    : target.kind === 'word'
      ? t.composer.liveWordText
      : target.kind === 'saved-file'
        ? t.composer.savedFile
        : t.composer.readWhenYouSend

  const tip = [target.path, t.composer.linked, access].filter(Boolean).join(' · ')

  return (
    <Tip label={tip}>
      <div className="group/attachment relative flex min-w-0 shrink-0 items-center">
        <button
          aria-label={[t.composer.workingWithDocument(target.name), t.composer.linked, access].join('. ')}
          className={cn(
            'flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-s-md border border-(--atum-line) bg-(--atum-sunk) ps-1.5 pe-1.5 text-left hover:bg-(--chrome-action-hover) focus-visible:outline-none',
            link.state === 'unavailable' && 'border-(--atum-warn)'
          )}
          data-slot="composer-linked-document-context"
          onClick={event => openContextLinkPickerFrom(event.currentTarget)}
          type="button"
        >
          <ConsumerFileIcon className="size-3.5 shrink-0" isDirectory={false} name={target.name} />
          <span className="min-w-0 truncate text-[0.6875rem] leading-none text-(--atum-ink-soft)">{target.name}</span>
          <span className="shrink-0 text-[0.625rem] text-(--atum-ink-soft)">{t.composer.linked}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={t.composer.changeContext}
              className={cn(
                'grid h-6 w-6 place-items-center rounded-e-md border border-s-0 border-(--atum-line) bg-(--atum-sunk) text-(--atum-ink-muted) hover:bg-(--chrome-action-hover) hover:text-(--atum-ink) focus-visible:outline-none',
                link.state === 'unavailable' && 'border-(--atum-warn)'
              )}
              type="button"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={event => openContextLinkPickerFrom(event.currentTarget as HTMLElement)}>{t.composer.changeContext}</DropdownMenuItem>
            {onSendWithoutDocument && <DropdownMenuItem disabled={sendWithoutDocumentDisabled} onSelect={() => onSendWithoutDocument()}>{t.composer.sendWithoutDocument}</DropdownMenuItem>}
            {link.state === 'unavailable' && <DropdownMenuItem onSelect={() => void reconnectContextLink()}>{t.composer.reconnect}</DropdownMenuItem>}
            {link.state === 'ready' && <DropdownMenuItem onSelect={() => void showLinkedDocument()}>{t.composer.showBeside}</DropdownMenuItem>}
            {target.kind === 'word' && link.state === 'ready' && <DropdownMenuItem onSelect={() => void bringLinkedWordToFront()}>{t.composer.bringWordToFront}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={useAutomaticContext}>{t.composer.useAutomaticContext}</DropdownMenuItem>
            <DropdownMenuItem onSelect={removeContextLink} variant="destructive">{t.composer.removeContext}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Tip>
  )
}

function AttachmentPill({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove?: (id: string) => void }) {
  const { t } = useI18n()
  const c = t.composer
  const Icon = { folder: FolderOpen, url: Link, image: ImageIcon, file: FileText, terminal: Terminal }[attachment.kind]
  const cwd = useStore($currentCwd)
  const isUploading = attachment.uploadState === 'uploading'
  const hasUploadError = attachment.uploadState === 'error'
  const canPreview = attachment.kind !== 'folder' && attachment.kind !== 'terminal' && !isUploading
  const detail = attachment.detail && attachment.detail !== attachment.label ? attachment.detail : undefined

  async function openPreview() {
    if (!canPreview) {
      return
    }

    const rawTarget =
      attachment.path ||
      attachment.detail ||
      attachment.refText?.replace(/^@(file|image|url):/, '') ||
      attachment.label ||
      ''

    const target = rawTarget.replace(/^`|`$/g, '')

    if (!target) {
      return
    }

    try {
      const preview = await normalizeOrLocalPreviewTarget(target, cwd || undefined)

      if (!preview) {
        throw new Error(c.couldNotPreview(attachment.label))
      }

      // We already hold the image bytes (the card thumbnail) — render those
      // directly so a screenshot/clipboard image previews even when its only
      // on-disk copy is a transient path the renderer can't re-read.
      const withBytes =
        attachment.kind === 'image' && attachment.previewUrl
          ? { ...preview, dataUrl: attachment.previewUrl, previewKind: 'image' as const }
          : preview

      setCurrentSessionPreviewTarget(withBytes, 'manual', target)
    } catch (error) {
      notifyError(error, c.previewUnavailable)
    }
  }

  return (
    <Tip label={attachment.path || attachment.detail || attachment.label}>
      <div className="group/attachment relative min-w-0 shrink-0">
        <button
          aria-busy={isUploading || undefined}
          aria-label={canPreview ? c.previewLabel(attachment.label) : attachment.label}
          className={cn(
            'flex max-w-56 items-center gap-2 rounded-2xl border bg-background/50 px-2 py-1.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-colors disabled:cursor-default',
            hasUploadError
              ? 'border-destructive/45 hover:border-destructive/60'
              : 'border-border/60 hover:border-primary/35 hover:bg-accent/45'
          )}
          disabled={!canPreview}
          onClick={() => void openPreview()}
          type="button"
        >
          <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border/55 bg-muted/35 text-muted-foreground">
            {attachment.previewUrl && attachment.kind === 'image' ? (
              <img
                alt={attachment.label}
                className="size-full object-cover"
                draggable={false}
                src={attachment.previewUrl}
              />
            ) : (
              <Icon className="size-3.5" />
            )}
            {isUploading && (
              <span className="absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-[1px]">
                <Loader2 className="size-3.5 animate-spin text-foreground/75" />
              </span>
            )}
            {hasUploadError && (
              <span className="absolute inset-0 grid place-items-center bg-destructive/15">
                <AlertCircle className="size-3.5 text-destructive" />
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[0.72rem] font-medium leading-4 text-foreground/90">
              {attachment.label}
            </span>
            {detail && (
              <span
                className={cn(
                  'block truncate text-[0.62rem] leading-3.5',
                  hasUploadError ? 'text-destructive/80' : 'text-muted-foreground/65'
                )}
              >
                {detail}
              </span>
            )}
          </span>
        </button>
        {onRemove && (
          <button
            aria-label={c.removeAttachment(attachment.label)}
            className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full border border-border/70 bg-background text-muted-foreground opacity-0 shadow-xs transition hover:bg-accent hover:text-foreground group-hover/attachment:opacity-100 focus-visible:opacity-100"
            onClick={() => onRemove(attachment.id)}
            type="button"
          >
            <Codicon name="close" size="0.625rem" />
          </button>
        )}
      </div>
    </Tip>
  )
}

import { type ComponentType, type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ArrowBackUp,
  Bookmark,
  BookmarkFilled,
  Checklist,
  Download,
  File,
  Flag,
  Info,
  Messages,
  MoodSmile,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Refresh,
  Search,
  Share,
  Trash2
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixReaction } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { MatrixReportDialog } from './report-dialog'
import { useMessageLinkCopy } from './team-space/message-link-copy'
import { usePinnedMessagesCopy } from './team-space/pinned-copy'

/**
 * The quiet controls around a message (launch night): the floating toolbar every message shows
 * on hover or focus (React, Reply, and a "…" with Copy, Read aloud, Retry, Edit, Delete or
 * Report), reactions under a message, a send that failed and a received file. Matrix's own features, Element X's simplicity. Presentation only: every action is the
 * caller's existing path.
 */

/** The quick reactions, in Element X's order. A reaction from another app shows as it is. */
export const MATRIX_QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

/** React: the quick reactions in a small popover. Each one toggles yours. `align`: the side
 * of the trigger the row lines up with (the end inside a message's toolbar, so it stays in the
 * transcript's column). */
export function MatrixReactionPicker({
  align = 'start',
  disabled,
  onReact,
  reactions
}: {
  align?: 'end' | 'start'
  disabled?: boolean
  onReact(key: string, reacted: boolean): void
  reactions?: readonly MatrixReaction[]
}) {
  const copy = useChatCopy()
  const [open, setOpen] = useState(false)
  const mine = new Set((reactions ?? []).filter(reaction => reaction.own).map(reaction => reaction.key))

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tip label={copy.react}>
        <PopoverTrigger asChild>
          <Button
            aria-label={copy.react}
            data-matrix-react
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <MoodSmile aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        align={align}
        className="w-auto p-1"
        data-matrix-reaction-picker
        onOpenAutoFocus={event => event.preventDefault()}
        side="top"
      >
        <div aria-label={copy.react} className="flex items-center gap-0.5" role="group">
          {MATRIX_QUICK_REACTIONS.map(key => (
            <button
              aria-label={copy.reactWith(key)}
              aria-pressed={mine.has(key)}
              className="grid size-8 place-items-center rounded-(--atum-r-control) text-lg leading-none transition-transform duration-100 hover:scale-110 hover:bg-(--atum-hover) aria-pressed:bg-(--atum-pressed) motion-reduce:transition-none motion-reduce:hover:scale-100"
              key={key}
              onClick={() => {
                setOpen(false)
                onReact(key, !mine.has(key))
              }}
              type="button"
            >
              <span aria-hidden>{key}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Reply: the message goes into the box as the one you are answering. */
function ReplyButton({ disabled, onReply }: { disabled?: boolean; onReply(): void }) {
  const copy = useChatCopy()

  return (
    <Tip label={copy.reply}>
      <Button
        aria-label={copy.reply}
        data-matrix-reply
        disabled={disabled}
        onClick={onReply}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ArrowBackUp aria-hidden />
      </Button>
    </Tip>
  )
}

function ThreadButton({ label, onThread }: { label: string; onThread(): void }) {
  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        data-matrix-thread-reply
        onClick={onThread}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Messages aria-hidden />
      </Button>
    </Tip>
  )
}

function ForwardButton({ onForward }: { onForward(): void }) {
  const copy = useChatCopy()

  return (
    <Tip label={copy.forward}>
      <Button aria-label={copy.forward} data-matrix-forward onClick={onForward} size="icon-sm" type="button" variant="ghost">
        <Share aria-hidden />
      </Button>
    </Tip>
  )
}

/**
 * The toolbar every message shows on hover or keyboard focus (and keeps while one of its menus
 * is open, or while its answer is being read aloud): React, Reply, "…". Beside your own bubble
 * (`inline`), or in the top corner of someone else's message or an answer (`corner`), never
 * over the words you sent.
 */
export function MatrixMessageToolbar({
  menu,
  onForward,
  onReply,
  onThread,
  placement,
  react,
  reading,
  time,
  threadLabel
}: {
  menu?: ReactNode
  onForward?: () => void
  onReply?: () => void
  onThread?: () => void
  placement: 'corner' | 'inline'
  react?: ReactNode
  /** The answer is being read aloud: the toolbar stays, so the way to stop it is in view. */
  reading?: boolean
  /** A middle bubble's own timestamp is the first quiet item in its hover toolbar. */
  time?: ReactNode
  threadLabel?: string
}) {
  if (!menu && !onForward && !onReply && !onThread && !react && !time) {
    return null
  }

  return (
    <div
      className={cn(
        'pointer-events-none flex items-center gap-0.5 rounded-(--atum-r-button) border border-(--atum-line) bg-(--atum-main-bg,var(--atum-card)) p-0.5 opacity-0 shadow-md transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none',
        reading && 'pointer-events-auto opacity-100',
        placement === 'corner' ? 'absolute top-0 right-0 z-10' : 'shrink-0 self-start'
      )}
      data-matrix-message-toolbar={placement}
      data-reading={reading || undefined}
    >
      {time}
      {react}
      {onReply && <ReplyButton onReply={onReply} />}
      {onForward && <ForwardButton onForward={onForward} />}
      {onThread && threadLabel && <ThreadButton label={threadLabel} onThread={onThread} />}
      {menu}
    </div>
  )
}

/** Read aloud as a menu item: the state lives with the answer (a closed menu must not stop the
 * audio), so the menu only shows it and starts or stops it. */
export interface MatrixMessageReadAloud {
  Icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  busy: boolean
  label: string
  onSelect(): void
  preparing: boolean
}

export interface MatrixMessageSavedAction {
  active: boolean
  busy: boolean
  label: string
  onSelect(): void
}

/** "Turn into task": the message becomes a company board task that links back to it. */
export interface MatrixMessageToCardAction {
  busy: boolean
  label: string
  onSelect(): void
}

/**
 * The "…" of a message: Copy, Edit and Delete for yours (and Retry, Find the answer in your
 * assistant's chat), Copy and Report for someone else's, Copy, Read aloud and Retry for an
 * answer. Delete and Report each ask first. Right-clicking the message opens it too (`open`).
 */
export function MatrixMessageMenu({
  link,
  deleteNote,
  findDisabled,
  kind,
  label,
  onDelete,
  onEdit,
  onFindAnswer,
  onForward,
  onOpenChange,
  onPin,
  onReport,
  onRetry,
  open,
  pinned,
  pinning,
  readAloud,
  reported,
  retryDisabled,
  saved,
  text,
  toCard
}: {
  /** Said in Delete's confirmation, after what deleting does (your assistant may remember). */
  deleteNote?: string
  findDisabled?: boolean
  kind: 'answer' | 'own' | 'report'
  label: string
  /** Stable Team space identifier link. Absent outside company channels. */
  link?: string
  /** Rejects when the message could not be deleted; the dialog says so and stays open. */
  onDelete?: () => Promise<void>
  onEdit?: () => void
  onFindAnswer?: () => void
  onForward?: () => void
  onOpenChange?: (open: boolean) => void
  onPin?: () => void
  /** Rejects when the report could not be sent; the dialog says so and stays open. `reason`:
   * the person's own optional words. */
  onReport?: (reason?: string) => Promise<void>
  onRetry?: () => void
  open?: boolean
  pinned?: boolean
  pinning?: boolean
  readAloud?: MatrixMessageReadAloud
  reported?: boolean
  retryDisabled?: boolean
  saved?: MatrixMessageSavedAction
  text: string
  toCard?: MatrixMessageToCardAction
}) {
  const copy = useChatCopy()
  const messageLink = useMessageLinkCopy()
  const pinnedCopy = usePinnedMessagesCopy()
  const [confirming, setConfirming] = useState<'delete' | 'report' | null>(null)

  if (!text && !link && !onEdit && !onDelete && !onReport && !onRetry && !onFindAnswer && !onForward && !onPin && !readAloud && !saved && !toCard) {
    return null
  }

  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange} open={open}>
        <Tip label={copy.messageOptions}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={label}
              className="atum-icon-btn size-7"
              data-matrix-answer-menu={kind === 'answer' || undefined}
              data-matrix-message-actions={kind === 'own' || undefined}
              data-matrix-report-message={kind === 'report' || undefined}
              type="button"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="min-w-44">
          {text && <CopyButton appearance="menu-item" haptic={false} text={text} />}
          {onForward && (
            <DropdownMenuItem onSelect={onForward}>
              <Share aria-hidden />
              {copy.forward}
            </DropdownMenuItem>
          )}
          {link && <CopyButton appearance="menu-item" haptic={false} label={messageLink.copyLink} text={link} />}
          {saved && (
            <DropdownMenuItem disabled={saved.busy} onSelect={saved.onSelect}>
              {saved.active ? <BookmarkFilled aria-hidden /> : <Bookmark aria-hidden />}
              {saved.label}
            </DropdownMenuItem>
          )}
          {toCard && (
            <DropdownMenuItem data-matrix-turn-into-task disabled={toCard.busy} onSelect={toCard.onSelect}>
              <Checklist aria-hidden />
              {toCard.label}
            </DropdownMenuItem>
          )}
          {onPin && (
            <DropdownMenuItem disabled={pinning} onSelect={onPin}>
              {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {pinned ? pinnedCopy.unpinMessage : pinnedCopy.pinMessage}
            </DropdownMenuItem>
          )}
          {readAloud && (
            <DropdownMenuItem disabled={readAloud.busy} onSelect={readAloud.onSelect}>
              <readAloud.Icon aria-hidden className={readAloud.preparing ? 'animate-spin' : undefined} />
              {readAloud.label}
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil aria-hidden />
              {copy.edit}
            </DropdownMenuItem>
          )}
          {onRetry && (
            <DropdownMenuItem disabled={retryDisabled} onSelect={onRetry}>
              <Refresh aria-hidden />
              {copy.retry}
            </DropdownMenuItem>
          )}
          {onFindAnswer && (
            <DropdownMenuItem disabled={findDisabled} onSelect={onFindAnswer}>
              <Search aria-hidden />
              {copy.findAnswer}
            </DropdownMenuItem>
          )}
          {onReport && (
            <DropdownMenuItem disabled={reported} onSelect={() => setConfirming('report')}>
              <Flag aria-hidden />
              {copy.report}
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirming('delete')} variant="destructive">
                <Trash2 aria-hidden />
                {copy.delete}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onDelete && (
        <ConfirmDialog
          cancelLabel={copy.cancel}
          confirmLabel={copy.delete}
          description={deleteNote ? `${copy.deleteMessageBody} ${deleteNote}` : copy.deleteMessageBody}
          destructive
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await onDelete()
            } catch {
              throw new Error(copy.errorGeneric)
            }
          }}
          open={confirming === 'delete'}
          title={copy.deleteMessageTitle}
        />
      )}
      {onReport && (
        <MatrixReportDialog
          body={copy.reportBody}
          onOpenChange={value => !value && setConfirming(null)}
          onReport={onReport}
          open={confirming === 'report'}
          title={copy.reportTitle}
        />
      )}
    </>
  )
}

/** A message's reactions: one chip per key with its count, yours highlighted; a chip toggles
 * your own. Who reacted is in its tip. */
export function MatrixReactionChips({
  disabled,
  nameOf,
  onToggle,
  reactions
}: {
  disabled?: boolean
  nameOf(userId: string): string
  onToggle(key: string, reacted: boolean): void
  reactions: readonly MatrixReaction[]
}) {
  return (
    <div className="flex flex-wrap gap-1" data-matrix-reactions>
      {reactions.map(reaction => (
        <Tip key={reaction.key} label={reaction.senders.map(nameOf).join(', ')}>
          <button
            aria-label={`${reaction.key} ${reaction.count}`}
            aria-pressed={reaction.own}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-(length:--atum-t-caption) leading-none transition-colors duration-100 disabled:cursor-default disabled:opacity-60',
              reaction.own
                ? 'border-(--atum-line-strong) bg-(--atum-pressed) text-(--atum-ink)'
                : 'border-(--atum-line) bg-transparent text-(--atum-ink-soft) hover:bg-(--atum-hover)'
            )}
            data-matrix-reaction={reaction.key}
            disabled={disabled}
            onClick={() => onToggle(reaction.key, !reaction.own)}
            type="button"
          >
            <span aria-hidden className="text-sm">
              {reaction.key}
            </span>
            <span aria-hidden className="font-medium tabular-nums">
              {reaction.count}
            </span>
          </button>
        </Tip>
      ))}
    </div>
  )
}

/** A deleted message keeps its place as one quiet line. */
export function MatrixDeletedMessage() {
  const copy = useChatCopy()

  return (
    <p
      className="flex items-center gap-1.5 py-1 text-sm text-(--atum-ink-muted) italic"
      data-matrix-message-deleted
    >
      <Trash2 aria-hidden className="size-3.5 shrink-0" />
      <span>{copy.messageDeleted}</span>
    </p>
  )
}

/** A message that didn't send: one quiet line and one immediate retry. Delete stays in "…". */
export function MatrixFailedSend({
  disabled,
  onRetry
}: {
  disabled?: boolean
  onRetry(): void
}) {
  const copy = useChatCopy()

  return (
    <div className="flex items-center gap-(--ak-s2) [font:var(--ak-t-caption)] text-(--ak-ink-3)" data-matrix-send-failed role="status">
      <Info aria-hidden className="ak-icon ak-icon--sm text-(--ak-ink-4)" />
      <span>{copy.notSentOffline}</span>
      <button className="ak-btn ak-btn--plain ak-btn--sm" disabled={disabled} onClick={onRetry} type="button">
        {copy.tryNow}
      </button>
    </div>
  )
}

/** A size the way a file manager writes it, in the person's locale. */
export function matrixFileSize(bytes: number, locale: string): string {
  const [value, unit] =
    bytes < 1024
      ? [bytes, 'byte']
      : bytes < 1024 * 1024
        ? [Math.max(1, Math.round(bytes / 1024)), 'kilobyte']
        : [Math.round((bytes / (1024 * 1024)) * 10) / 10, 'megabyte']

  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(
    value
  )
}

/** A file: its name and size on a card, and Save (received) or Remove (staged). */
export function MatrixFileCard({
  action,
  name,
  size
}: {
  action?: ReactNode
  name: string
  size?: number
}) {
  const { locale } = useI18n()

  return (
    <div
      className="atum-file-card flex max-w-80 min-w-56 items-center gap-2.5 py-2 ps-2.5 pe-1.5"
      data-matrix-file-card
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-(--ak-r-md) bg-(--ak-sunk,var(--atum-sunk)) text-(--atum-ink-muted)">
        <File aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-(length:--atum-t-control) font-semibold text-(--atum-ink)">{name}</span>
        {size !== undefined && (
          <span className="block text-(length:--atum-t-label) text-(--atum-ink-muted)">
            {matrixFileSize(size, locale)}
          </span>
        )}
      </span>
      {action}
    </div>
  )
}

/** Save a received file: the card's one action. */
export function MatrixFileSave({ name, onSave }: { name: string; onSave(): void }) {
  const copy = useChatCopy()

  return (
    <Tip label={copy.saveFile(name)}>
      <Button aria-label={copy.saveFile(name)} onClick={onSave} size="icon-sm" type="button" variant="ghost">
        <Download aria-hidden />
      </Button>
    </Tip>
  )
}

/** Who starts a run of messages in a group: their name, above their first bubble, set in from
 * the bubble's edge as on the phone (face gutter 28 px + gap 8 px + 8 px). */
export function MatrixSenderLine({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 ps-11" data-matrix-sender>
      <span className="truncate text-(length:--atum-t-control) font-medium text-(--atum-ink)">{name}</span>
    </span>
  )
}

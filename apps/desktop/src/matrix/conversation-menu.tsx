import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Eye,
  Flag,
  LogOut,
  Mail,
  MailOpened,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  PinOff,
  SlidersHorizontal,
  Trash2,
  Users
} from '@/lib/icons'

import { MATRIX_CHAT_TITLE_MAX, type MatrixRoom, type MatrixSnapshot } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'
import { MatrixReportDialog } from './report-dialog'
import { MATRIX_PIN_LIMIT } from './room-navigation'
import { lowPriorityEligible, personalChatActions, personalGroupDetails, reportablePerson } from './roster-model'
import { runMatrixCommand } from './text-document-actions'

/**
 * A synced room flag changed from here: shown at once, held through ordinary sync, and given
 * back to the SDK's own state if sync does not confirm it in time (the favourite tag and the
 * mute rule both arrive by sync, never fabricated).
 */
export function useRoomFlag(synced: boolean) {
  const [pending, setPending] = useState<{ value: boolean; saved: boolean } | null>(null)

  useEffect(() => {
    if (!pending?.saved) {
      return
    }

    if (synced === pending.value) {
      setPending(null)

      return
    }

    const timer = setTimeout(() => setPending(null), 5000)

    return () => clearTimeout(timer)
  }, [pending, synced])

  return {
    value: pending?.value ?? synced,
    // Until sync confirms it (or gives up), the change is not offered again.
    busy: pending !== null,
    change(value: boolean, write: () => Promise<unknown>, fail: (cause?: unknown) => void) {
      setPending({ value, saved: false })
      void write().then(
        () => setPending(current => current && { ...current, saved: true }),
        cause => {
          setPending(null)
          fail(cause)
        }
      )
    }
  }
}

/** Your own name for a chat, private to you: one line, saved as the room's account data. The
 * chat and the name it starts from are the ones the dialog opened with, kept while it is open.
 * `shared`: a personal group whose power levels let you rename it. Rename then names the group
 * for everyone in it (standard `m.room.name`, never empty), not only for you. */
export function MatrixRenameChat({
  current,
  onOpenChange,
  open,
  roomId,
  shared = false
}: {
  current: string
  onOpenChange(open: boolean): void
  open: boolean
  roomId: string
  shared?: boolean
}) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const [name, setName] = useState(current)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (open) {
      setName(current)
      setFailed(false)
    }
  }, [current, open])

  const empty = shared && !name.trim()

  const save = () => {
    if (pending || empty) {
      return
    }

    setPending(true)
    setFailed(false)
    void runMatrixCommand(
      shared ? { kind: 'groupName', roomId, name: name.trim() } : { kind: 'chatTitle', roomId, title: name.trim() }
    )
      .then(() => onOpenChange(false))
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <Dialog onOpenChange={value => !pending && onOpenChange(value)} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-sm"
        data-matrix-rename
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader
          description={shared ? chat.renameGroupHelp : chat.renameHelp}
          title={shared ? chat.renameGroupTitle : chat.renameTitle}
        />
        <form
          id={`matrix-rename-${roomId}`}
          onSubmit={event => {
            event.preventDefault()
            save()
          }}
        >
          <Input
            aria-label={chat.renameLabel}
            className="atum-input"
            disabled={pending}
            maxLength={MATRIX_CHAT_TITLE_MAX}
            onChange={event => setName(event.target.value)}
            onFocus={event => event.currentTarget.select()}
            value={name}
          />
        </form>
        {failed && (
          <NoticeBand className="mt-3" role="alert" tone="failure">
            {chat.errorGeneric}
          </NoticeBand>
        )}
        <DialogFooter>
          <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={pending || empty} form={`matrix-rename-${roomId}`} type="submit">
            {chat.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Room-level disclosure for the owner's awareness reader. Every room kind is
 * described by the same rule: unencrypted message text is readable, while an
 * encrypted room exposes metadata only. This is deliberately information, not
 * the retired exclusion toggle or a per-room approval.
 */
export function MatrixChatAwarenessDisclosure({ encrypted }: { encrypted: boolean }) {
  const { t } = useI18n()
  const copy = t.atum.awareness.roomInfo

  return (
    <DropdownMenuLabel
      className="max-w-80 whitespace-normal px-2 py-1.5 font-normal"
      data-matrix-chat-awareness={encrypted ? 'metadata-only' : 'messages-readable'}
    >
      <span className="flex items-center gap-2 font-medium text-foreground">
        <Eye aria-hidden className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
        {copy.title}
      </span>
      <span className="mt-1 block pl-[1.375rem] text-[0.6875rem] leading-snug text-(--ui-text-tertiary)">
        {encrypted ? copy.encrypted : copy.plain}
      </span>
    </DropdownMenuLabel>
  )
}

/**
 * What a personal chat lets you do to it, wherever it is offered (the "…" menu, the conversation
 * info panel): low priority and mute (synced flags, shown at once), report and block the person,
 * then leave or delete the chat behind one confirmation. `dialogs` must be rendered once by the
 * caller; every dialog acts on the chat and person it opened for, never on whatever is open later.
 */
export function useMatrixChatActions(room: MatrixRoom, snapshot: MatrixSnapshot, fail: (cause?: unknown) => void) {
  const chat = useChatCopy()

  const [ending, setEnding] = useState<{
    open: boolean
    roomId: string
    kind: 'delete' | 'leave' | 'block'
    userId?: string
  }>({
    open: false,
    roomId: room.id,
    kind: 'delete'
  })

  // Report acts on the chat and person it opened for.
  const [reporting, setReporting] = useState({ open: false, roomId: room.id, userId: '' })
  const low = useRoomFlag(Boolean(room.lowPriority))
  const mute = useRoomFlag(Boolean(room.muted))
  const ready = snapshot.state === 'ready'
  const actions = personalChatActions(room, snapshot)
  const blocked = Boolean(actions.person && snapshot.ignoredUsers?.includes(actions.person))
  const reportable = reportablePerson(room, snapshot, actions.person)
  const lowable = lowPriorityEligible(room, snapshot)

  const confirm = (kind: 'delete' | 'leave' | 'block') =>
    setEnding({ open: true, roomId: room.id, kind, userId: actions.person })

  const dialogs = (
    <>
      <MatrixReportDialog
        body={chat.reportPersonBody}
        onOpenChange={value => setReporting(previous => ({ ...previous, open: value }))}
        onReport={reason =>
          runMatrixCommand({
            kind: 'reportUser',
            roomId: reporting.roomId,
            userId: reporting.userId,
            ...(reason ? { reason } : {})
          })
        }
        open={reporting.open}
        title={chat.reportPersonTitle}
      />
      <ConfirmDialog
        cancelLabel={chat.cancel}
        confirmLabel={ending.kind === 'block' ? chat.blockPerson : ending.kind === 'leave' ? chat.leave : chat.delete}
        description={
          ending.kind === 'block'
            ? chat.blockPersonBody
            : ending.kind === 'leave'
              ? chat.leaveBody
              : chat.deleteChatBody
        }
        destructive
        onClose={() => setEnding(previous => ({ ...previous, open: false }))}
        onConfirm={async () => {
          try {
            // The chat this confirmation opened for, by its id: never the chat that happens
            // to be open, nor one that took its place.
            await runMatrixCommand(
              ending.kind === 'block'
                ? { kind: 'ignore', userId: ending.userId!, ignored: true }
                : { kind: 'forget', roomId: ending.roomId }
            )
          } catch {
            throw new Error(chat.errorGeneric)
          }
        }}
        open={ending.open}
        title={
          ending.kind === 'block'
            ? chat.blockPersonTitle
            : ending.kind === 'leave'
              ? chat.leaveTitle
              : chat.deleteChatTitle
        }
      />
    </>
  )

  return {
    actions,
    blocked,
    confirm,
    dialogs,
    low: {
      ...low,
      toggle: () =>
        low.change(
          !low.value,
          () => runMatrixCommand({ kind: 'lowPriority', roomId: room.id, lowPriority: !low.value }),
          fail
        )
    },
    lowable,
    mute: {
      ...mute,
      toggle: () =>
        mute.change(!mute.value, () => runMatrixCommand({ kind: 'mute', roomId: room.id, muted: !mute.value }), fail)
    },
    ready,
    report: () => {
      if (actions.person) {
        setReporting({ open: true, roomId: room.id, userId: actions.person })
      }
    },
    reportable,
    unblock: () => void runMatrixCommand({ kind: 'ignore', userId: actions.person!, ignored: false }).catch(fail)
  }
}

interface MatrixChatMenuProps {
  fail(cause?: unknown): void
  onBackground?: () => void
  onMembers?: () => void
  onReplySettings?: () => void
  room: MatrixRoom
  snapshot: MatrixSnapshot
  /** The name the chat goes by on screen (the rename dialog starts from it). */
  title: string
  variant?: 'header' | 'row'
}

/**
 * One conversation menu for every kind of chat (launch night): Reply settings (your
 * assistant's chat), Members (a group), Mark as read or unread (on a roster row), Rename,
 * Pin, Mute notifications, then Leave (a group) and Delete chat. Delete chat is Matrix's own:
 * you leave the room and forget it, so it leaves your list on every device, while everyone
 * else in it keeps their copy. The same menu sits in the chat's header and on its row in the
 * roster (`row`: shown on hover or focus).
 */
export function MatrixChatMenu(props: MatrixChatMenuProps) {
  // Everything the menu holds (an open dialog, a pin or mute on its way) belongs to one chat:
  // another chat in the same place starts over, so nothing reaches the wrong chat.
  return <MatrixChatMenuFor key={props.room.id} {...props} />
}

function MatrixChatMenuFor({
  fail,
  onBackground,
  onMembers,
  onReplySettings,
  room,
  snapshot,
  title,
  variant = 'header'
}: MatrixChatMenuProps) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // A dialog acts on the chat it opened for (captured when it opens), and keeps its words
  // while it closes.
  const [renaming, setRenaming] = useState({ open: false, roomId: room.id, current: '', shared: false })

  const { actions, blocked, confirm, dialogs, low, lowable, mute, ready, report, reportable, unblock } =
    useMatrixChatActions(room, snapshot, fail)

  const pin = useRoomFlag(Boolean(room.favourite))
  // Unread is the server's count or the person's own mark (m.marked_unread).
  const unread = useRoomFlag((room.unreadNotifications ?? 0) > 0 || Boolean(room.markedUnread))
  const pinCount = snapshot.rooms.filter(value => value.membership === 'join' && value.favourite).length
  const pinLimited = !pin.value && pinCount >= MATRIX_PIN_LIMIT
  // A group you may rename is renamed for everyone in it; any other chat gets your own name.
  const sharedName = Boolean(personalGroupDetails(room, snapshot)?.name)
  // A row offers Mark as read on an unread chat, Mark as unread on any other but the one open.
  const markable = variant === 'row' && (unread.value || room.id !== snapshot.roomId)
  const label = variant === 'row' ? chat.agentOptions(title) : chat.conversationOptions

  if (room.membership !== 'join') {
    return null
  }

  return (
    <>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <Tip label={label}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={label}
              className="atum-icon-btn size-7 shrink-0"
              data-matrix-chat-menu={variant}
              type="button"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="min-w-52">
          {onReplySettings && (
            <DropdownMenuItem onSelect={onReplySettings}>
              <SlidersHorizontal aria-hidden />
              {chat.replySettings}
            </DropdownMenuItem>
          )}
          {onMembers && (
            <DropdownMenuItem onSelect={onMembers}>
              <Users aria-hidden />
              {chat.members}
            </DropdownMenuItem>
          )}
          <MatrixChatAwarenessDisclosure encrypted={room.encrypted} />
          <DropdownMenuSeparator />
          {markable && (
            <DropdownMenuItem
              data-matrix-mark-unread={unread.value ? 'read' : 'unread'}
              disabled={!ready || unread.busy}
              onSelect={() =>
                unread.change(
                  !unread.value,
                  () => runMatrixCommand({ kind: 'markUnread', roomId: room.id, unread: !unread.value }),
                  fail
                )
              }
            >
              {unread.value ? <MailOpened aria-hidden /> : <Mail aria-hidden />}
              {unread.value ? chat.markRead : chat.markUnread}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!ready}
            onSelect={() =>
              setRenaming({ open: true, roomId: room.id, current: room.title ?? title, shared: sharedName })
            }
          >
            <Pencil aria-hidden />
            {chat.rename}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready || pin.busy || pinLimited}
            onSelect={() =>
              pin.change(
                !pin.value,
                () => runMatrixCommand({ kind: 'favourite', roomId: room.id, favourite: !pin.value }),
                fail
              )
            }
          >
            {pin.value ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            {pinLimited ? t.atum.roster.pinLimit : pin.value ? chat.unpin : chat.pin}
          </DropdownMenuItem>
          {lowable && (
            <DropdownMenuItem
              data-matrix-low-priority={low.value ? 'remove' : 'mark'}
              disabled={!ready || low.busy}
              onSelect={() => low.toggle()}
            >
              {low.value ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
              {low.value ? chat.removeLowPriority : chat.lowPriority}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!ready || mute.busy} onSelect={() => mute.toggle()}>
            {mute.value ? <Bell aria-hidden /> : <BellOff aria-hidden />}
            {mute.value ? chat.unmute : chat.mute}
          </DropdownMenuItem>
          {onBackground && (
            <DropdownMenuItem onSelect={onBackground}>
              <Palette aria-hidden />
              {chat.background}
            </DropdownMenuItem>
          )}
          {reportable && (
            <DropdownMenuItem data-matrix-report-person disabled={!ready} onSelect={report}>
              <Flag aria-hidden />
              {chat.reportPerson}
            </DropdownMenuItem>
          )}
          {actions.person && (
            <DropdownMenuItem
              disabled={!ready}
              onSelect={() => (blocked ? unblock() : confirm('block'))}
              variant="destructive"
            >
              <Users aria-hidden />
              {blocked ? chat.unblockPerson : chat.blockPerson}
            </DropdownMenuItem>
          )}
          {actions.end && <DropdownMenuSeparator />}
          {actions.end === 'leave' && (
            <DropdownMenuItem disabled={!ready} onSelect={() => confirm('leave')} variant="destructive">
              <LogOut aria-hidden />
              {chat.leave}
            </DropdownMenuItem>
          )}
          {actions.end === 'delete' && (
            <DropdownMenuItem disabled={!ready} onSelect={() => confirm('delete')} variant="destructive">
              <Trash2 aria-hidden />
              {chat.deleteChat}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <MatrixRenameChat
        current={renaming.current}
        onOpenChange={value => setRenaming(previous => ({ ...previous, open: value }))}
        open={renaming.open}
        roomId={renaming.roomId}
        shared={renaming.shared}
      />
      {dialogs}
    </>
  )
}

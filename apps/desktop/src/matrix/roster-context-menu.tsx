import { createContext, type ReactElement, type ReactNode, useContext, useRef, useState } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useI18n } from '@/i18n'
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Flag,
  Info,
  LogOut,
  Mail,
  MailOpened,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  UserCircle
} from '@/lib/icons'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isAssistantNameLocked } from '../../shared/matrix-assistant-name'

import { RetireAgent } from './agent-roster'
import { useAssistantCardCopy } from './assistant-card/copy'
import { useChatCopy } from './chat-copy'
import { MatrixRenameChat, useRoomFlag } from './conversation-menu'
import { MatrixReportDialog } from './report-dialog'
import { MATRIX_PIN_LIMIT } from './room-navigation'
import { lowPriorityEligible, personalChatActions, personalGroupDetails, reportablePerson } from './roster-model'
import { matrixRoomHasUnread } from './roster-preview'
import { runMatrixCommand } from './text-document-actions'

/**
 * The chat list's actions live in each row's context menu (launch night, owner: "make it
 * right-click access instead"): a right-click, the context-menu key or Shift-F10 on a row, or
 * a long press on a touch screen. The items are the ones the rows' "…" menus held.
 *
 * Dialogs a menu opens live once, here, for the whole list: each takes the room (or the
 * assistant) it was opened for at that moment, so a dialog never acts on whatever chat a row
 * shows later, and a row that leaves the list (sync, a search) never drops a dialog half-way.
 */

interface RosterMenuHostActions {
  /** `shared`: a personal group you may rename, renamed for everyone in it. */
  rename(room: MatrixRoom, title: string, shared?: boolean): void
  /** `botName`: the room is an official bot's chat (Moon, Andy), which Delete chat keeps. */
  end(room: MatrixRoom, kind: 'delete' | 'leave' | 'block', returnTo?: HTMLElement | null, userId?: string): void
  retire(agent: MatrixAgentView, name: string, returnTo?: HTMLElement | null): void
  /** Report a person in this chat (Matrix user report). */
  report(room: MatrixRoom, userId: string, returnTo?: HTMLElement | null): void
}

const RosterMenuContext = createContext<RosterMenuHostActions | null>(null)

/** Gives focus back to the row a keyboard menu was opened from, once its dialog closes. */
function refocus(element: HTMLElement | null | undefined) {
  return (event: Event) => {
    if (element?.isConnected) {
      event.preventDefault()
      element.focus()
    }
  }
}

export function RosterMenuHost({ children }: { children: ReactNode }) {
  const chat = useChatCopy()
  // Each dialog keeps the target it was opened for while it closes, so its words stay: the
  // chat's id and the name it starts from, captured when it opens (as the header's menu).
  const [renaming, setRenaming] = useState<{ roomId: string; current: string; shared: boolean } | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)

  const [ending, setEnding] = useState<{
    roomId: string
    kind: 'delete' | 'leave' | 'block'
    returnTo?: HTMLElement | null
    userId?: string
  } | null>(null)

  const [endOpen, setEndOpen] = useState(false)

  const [retiring, setRetiring] = useState<{
    agent: MatrixAgentView
    name: string
    returnTo?: HTMLElement | null
  } | null>(null)

  const [retireOpen, setRetireOpen] = useState(false)

  const [reporting, setReporting] = useState<{
    roomId: string
    userId: string
    returnTo?: HTMLElement | null
  } | null>(null)

  const [reportOpen, setReportOpen] = useState(false)

  const host: RosterMenuHostActions = {
    rename(room, title, shared = false) {
      setRenaming({ roomId: room.id, current: room.title ?? title, shared })
      setRenameOpen(true)
    },
    end(room, kind, returnTo, userId) {
      setEnding({ roomId: room.id, kind, returnTo, userId })
      setEndOpen(true)
    },
    retire(agent, name, returnTo) {
      setRetiring({ agent, name, returnTo })
      setRetireOpen(true)
    },
    report(room, userId, returnTo) {
      setReporting({ roomId: room.id, userId, returnTo })
      setReportOpen(true)
    }
  }

  return (
    <RosterMenuContext value={host}>
      {children}
      {renaming && (
        <MatrixRenameChat
          current={renaming.current}
          onOpenChange={setRenameOpen}
          open={renameOpen}
          roomId={renaming.roomId}
          shared={renaming.shared}
        />
      )}
      <ConfirmDialog
        cancelLabel={chat.cancel}
        confirmLabel={ending?.kind === 'block' ? chat.blockPerson : ending?.kind === 'leave' ? chat.leave : chat.delete}
        description={
          ending?.kind === 'block'
            ? chat.blockPersonBody
            : ending?.kind === 'leave'
              ? chat.leaveBody
              : chat.deleteChatBody
        }
        destructive
        onClose={() => setEndOpen(false)}
        onCloseAutoFocus={refocus(ending?.returnTo)}
        onConfirm={async () => {
          if (!ending) {
            return
          }

          try {
            // The room this dialog was opened for, by its id: never the chat on screen.
            await runMatrixCommand(
              ending.kind === 'block'
                ? { kind: 'ignore', userId: ending.userId!, ignored: true }
                : { kind: 'forget', roomId: ending.roomId }
            )
          } catch {
            throw new Error(chat.errorGeneric)
          }
        }}
        open={endOpen}
        title={
          ending?.kind === 'block'
            ? chat.blockPersonTitle
            : ending?.kind === 'leave'
              ? chat.leaveTitle
              : chat.deleteChatTitle
        }
      />
      {reporting && (
        <MatrixReportDialog
          body={chat.reportPersonBody}
          onCloseAutoFocus={refocus(reporting.returnTo)}
          onOpenChange={setReportOpen}
          onReport={reason =>
            runMatrixCommand({
              kind: 'reportUser',
              roomId: reporting.roomId,
              userId: reporting.userId,
              ...(reason ? { reason } : {})
            })
          }
          open={reportOpen}
          title={chat.reportPersonTitle}
        />
      )}
      {retiring && (
        <RetireAgent
          agent={retiring.agent}
          name={retiring.name}
          onClose={() => setRetireOpen(false)}
          onCloseAutoFocus={refocus(retiring.returnTo)}
          open={retireOpen}
        />
      )}
    </RosterMenuContext>
  )
}

function useRosterMenuHost(): RosterMenuHostActions {
  const host = useContext(RosterMenuContext)

  if (!host) {
    throw new Error('RosterMenuHost missing')
  }

  return host
}

/** What a menu item needs to open one of the list's dialogs. */
interface RosterMenuAction {
  /** The row's own button, to give focus back to when the menu was opened by keyboard. */
  returnTo(): HTMLElement | null
  /** Call before opening a dialog: the dialog, not the row, takes focus. */
  opensDialog(): void
}

/**
 * One row's context menu: a right-click opens it at the pointer; the context-menu key or
 * Shift-F10 opens it under the row; a long press opens it on a touch screen (and the tap that
 * ends the press does not also open the chat).
 */
function RosterContextMenu({
  children,
  items
}: {
  children: ReactElement
  items(action: RosterMenuAction): ReactNode
}) {
  const row = useRef<HTMLSpanElement>(null)
  // How the open menu was opened: focus goes back to the row only for the keyboard.
  const keyboard = useRef(false)
  const openingByKeyboard = useRef(false)
  const dialog = useRef(false)
  const touch = useRef(false)
  const swallowClick = useRef(false)

  const action: RosterMenuAction = {
    returnTo: () => (keyboard.current ? (row.current?.querySelector<HTMLElement>('[data-roster-row]') ?? null) : null),
    opensDialog: () => {
      dialog.current = true
    }
  }

  return (
    <ContextMenu
      onOpenChange={open => {
        // A long press opened it: the tap that ends the press is not a click on the row.
        swallowClick.current = open && touch.current
      }}
    >
      <ContextMenuTrigger
        asChild
        onClickCapture={event => {
          if (swallowClick.current) {
            swallowClick.current = false
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onContextMenu={() => {
          keyboard.current = openingByKeyboard.current
          openingByKeyboard.current = false
        }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
            return
          }

          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          openingByKeyboard.current = true
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              // Under the row, from where its words begin.
              clientX: rect.left + Math.min(48, rect.width / 2),
              clientY: rect.bottom - 4
            })
          )
        }}
        onPointerDown={event => {
          touch.current = event.pointerType === 'touch' || event.pointerType === 'pen'
          swallowClick.current = false
        }}
        ref={row}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-52"
        data-matrix-roster-menu
        onCloseAutoFocus={event => {
          // A dialog takes focus itself; a pointer leaves focus where it was.
          if (dialog.current || !keyboard.current) {
            event.preventDefault()
          }

          dialog.current = false
        }}
      >
        {items(action)}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * A chat's context menu, everywhere it is listed (a person, a group, an assistant's history):
 * Mark as read or unread (never Mark as unread on the chat you are reading), Rename (private),
 * Pin, Mute notifications, then Leave (a group) and Delete chat, each behind a confirmation.
 */
export function RosterRoomMenu({
  children,
  fail,
  profile,
  room,
  snapshot,
  title
}: {
  children: ReactElement
  fail(cause?: unknown): void
  /** A chat with someone whose profile the app draws (the Founder): View profile comes first. */
  profile?: { label: string; open(): void }
  room: MatrixRoom
  snapshot: MatrixSnapshot
  /** The name the chat goes by on screen (the rename dialog starts from it). */
  title: string
}) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const host = useRosterMenuHost()
  // Held here, outside the menu: a change shows at once and stays shown until sync agrees.
  const pin = useRoomFlag(Boolean(room.favourite))
  const low = useRoomFlag(Boolean(room.lowPriority))
  const mute = useRoomFlag(Boolean(room.muted))
  const unread = useRoomFlag(matrixRoomHasUnread(room))

  if (room.membership !== 'join') {
    return children
  }

  const ready = snapshot.state === 'ready'
  const pinCount = snapshot.rooms.filter(value => value.membership === 'join' && value.favourite).length
  const pinLimited = !pin.value && pinCount >= MATRIX_PIN_LIMIT
  const actions = personalChatActions(room, snapshot)
  const blocked = Boolean(actions.person && snapshot.ignoredUsers?.includes(actions.person))
  const reportable = reportablePerson(room, snapshot, actions.person)
  const lowable = lowPriorityEligible(room, snapshot)
  const markable = unread.value || room.id !== snapshot.roomId
  const roomId = room.id

  return (
    <RosterContextMenu
      items={action => (
        <>
          {profile && (
            <>
              <ContextMenuItem
                data-matrix-view-profile
                onSelect={() => {
                  action.opensDialog()
                  profile.open()
                }}
              >
                <UserCircle aria-hidden />
                {profile.label}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {markable && (
            <ContextMenuItem
              data-matrix-mark-unread={unread.value ? 'read' : 'unread'}
              disabled={!ready || unread.busy}
              onSelect={() =>
                unread.change(
                  !unread.value,
                  () => runMatrixCommand({ kind: 'markUnread', roomId, unread: !unread.value }),
                  fail
                )
              }
            >
              {unread.value ? <MailOpened aria-hidden /> : <Mail aria-hidden />}
              {unread.value ? chat.markRead : chat.markUnread}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={!ready}
            onSelect={() => {
              action.opensDialog()
              host.rename(room, title, Boolean(personalGroupDetails(room, snapshot)?.name))
            }}
          >
            <Pencil aria-hidden />
            {chat.rename}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!ready || pin.busy || pinLimited}
            onSelect={() =>
              pin.change(!pin.value, () => runMatrixCommand({ kind: 'favourite', roomId, favourite: !pin.value }), fail)
            }
          >
            {pin.value ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            {pinLimited ? t.atum.roster.pinLimit : pin.value ? chat.unpin : chat.pin}
          </ContextMenuItem>
          {lowable && (
            <ContextMenuItem
              data-matrix-low-priority={low.value ? 'remove' : 'mark'}
              disabled={!ready || low.busy}
              onSelect={() =>
                low.change(
                  !low.value,
                  () => runMatrixCommand({ kind: 'lowPriority', roomId, lowPriority: !low.value }),
                  fail
                )
              }
            >
              {low.value ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
              {low.value ? chat.removeLowPriority : chat.lowPriority}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={!ready || mute.busy}
            onSelect={() =>
              mute.change(!mute.value, () => runMatrixCommand({ kind: 'mute', roomId, muted: !mute.value }), fail)
            }
          >
            {mute.value ? <Bell aria-hidden /> : <BellOff aria-hidden />}
            {mute.value ? chat.unmute : chat.mute}
          </ContextMenuItem>
          {reportable && (
            <ContextMenuItem
              data-matrix-report-person
              disabled={!ready}
              onSelect={() => {
                action.opensDialog()
                host.report(room, actions.person!, action.returnTo())
              }}
            >
              <Flag aria-hidden />
              {chat.reportPerson}
            </ContextMenuItem>
          )}
          {actions.person && (
            <ContextMenuItem
              disabled={!ready}
              onSelect={() => {
                if (blocked) {
                  void runMatrixCommand({ kind: 'ignore', userId: actions.person!, ignored: false }).catch(fail)
                } else {
                  action.opensDialog()
                  host.end(room, 'block', action.returnTo(), actions.person)
                }
              }}
              variant="destructive"
            >
              <UserCircle aria-hidden />
              {blocked ? chat.unblockPerson : chat.blockPerson}
            </ContextMenuItem>
          )}
          {actions.end && <ContextMenuSeparator />}
          {actions.end === 'leave' && (
            <ContextMenuItem
              disabled={!ready}
              onSelect={() => {
                action.opensDialog()
                host.end(room, 'leave', action.returnTo())
              }}
              variant="destructive"
            >
              <LogOut aria-hidden />
              {chat.leave}
            </ContextMenuItem>
          )}
          {actions.end === 'delete' && (
            <ContextMenuItem
              disabled={!ready}
              onSelect={() => {
                action.opensDialog()
                host.end(room, 'delete', action.returnTo())
              }}
              variant="destructive"
            >
              <Trash2 aria-hidden />
              {chat.deleteChat}
            </ContextMenuItem>
          )}
        </>
      )}
    >
      {children}
    </RosterContextMenu>
  )
}

/** An assistant's context menu: its card, renaming and (not Atum) deleting it. */
export function RosterAgentMenu({
  agent,
  children,
  name,
  onEditAgent,
  ready
}: {
  agent: MatrixAgentView
  children: ReactElement
  name: string
  onEditAgent?(agent: MatrixAgentView, focus?: 'name'): void
  ready: boolean
}) {
  const { t } = useI18n()
  const card = useAssistantCardCopy()
  const host = useRosterMenuHost()

  return (
    <RosterContextMenu
      items={action => (
        <>
          {onEditAgent && (
            <ContextMenuItem
              aria-label={`${card.menuEdit} ${name}`}
              data-matrix-edit-agent
              onSelect={() => {
                action.opensDialog()
                onEditAgent(agent)
              }}
            >
              <UserCircle aria-hidden />
              {card.menuEdit}
            </ContextMenuItem>
          )}
          {onEditAgent && !isAssistantNameLocked(agent) && (
            <ContextMenuItem
              aria-label={`${card.menuRename} ${name}`}
              data-matrix-rename-agent
              disabled={!ready}
              onSelect={() => {
                action.opensDialog()
                onEditAgent(agent, 'name')
              }}
            >
              <Pencil aria-hidden />
              {card.menuRename}
            </ContextMenuItem>
          )}
          {!agent.isDefault && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!ready}
                onSelect={() => {
                  action.opensDialog()
                  host.retire(agent, name, action.returnTo())
                }}
                variant="destructive"
              >
                <Trash2 aria-hidden />
                {t.matrixShell.agentRetireAction(name)}
              </ContextMenuItem>
            </>
          )}
        </>
      )}
    >
      {children}
    </RosterContextMenu>
  )
}

/** An official app's row (Moon, Andy): its read-only card, "Info". */
export function RosterAppMenu({ children, onInfo }: { children: ReactElement; onInfo?(): void }) {
  const card = useAssistantCardCopy()

  if (!onInfo) {
    return children
  }

  return (
    <RosterContextMenu
      items={action => (
        <ContextMenuItem
          data-matrix-app-info
          onSelect={() => {
            action.opensDialog()
            onInfo()
          }}
        >
          <Info aria-hidden />
          {card.menuInfo}
        </ContextMenuItem>
      )}
    >
      <div>{children}</div>
    </RosterContextMenu>
  )
}

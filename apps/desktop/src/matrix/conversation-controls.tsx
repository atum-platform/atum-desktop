import { useEffect, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { VerifiedMark } from '@/components/verified-mark'
import { useI18n } from '@/i18n'
import { AlertCircle, EyeOff, Flag, MoreHorizontal, Plus, Trash2, Users } from '@/lib/icons'

import { appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixCommand, MatrixMember, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { accountVerificationTier } from '../../shared/verification'

import { MatrixAddMembers } from './add-members'
import { useAppCopy } from './app-copy'
import { useChatCopy } from './chat-copy'
import { matrixChatTitle } from './chat-title'
import { useConversationCopy } from './conversation-copy'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'
import { type MatrixGroupDetailField, MatrixGroupDetailsHeader } from './group-details'
import { useGroupPickerCopy } from './group-picker-copy'
import { useModerationCopy } from './moderation-copy'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { useMatrixHandles } from './person-handles'
import { matrixMemberLabel } from './person-name'
import { MatrixReportDialog } from './report-dialog'
import { personalGroupDetails, reportablePerson } from './roster-model'
import { runMatrixCommand } from './text-document-actions'

// These controls are keyed by account/room. No completion from an old scope
// can erase the new scope's input or publish its error into another conversation.
export function useConversationAction() {
  const live = useRef(true)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const run = (command: MatrixCommand, done: () => void = () => {}) => {
    if (busy.current) {
      return
    }

    busy.current = true
    setPending(true)
    setError(false)
    void runMatrixCommand(command)
      .then(() => {
        if (live.current) {
          done()
        }
      })
      .catch(() => {
        if (live.current) {
          setError(true)
        }
      })
      .finally(() => {
        busy.current = false

        if (live.current) {
          setPending(false)
        }
      })
  }

  return { pending, error, run }
}

function ClosedActionError({ visible }: { visible: boolean }) {
  const copy = useConversationCopy()

  return visible ? (
    <Tip label={copy.error}>
      <span className="inline-flex text-destructive" role="status">
        <AlertCircle aria-hidden className="size-4" />
        <span className="sr-only">{copy.error}</span>
      </span>
    </Tip>
  ) : null
}

/** Official bots are offered separately from people.  The bridge pins the catalog
 * device and issues the same ordinary Matrix invite command used for a person. */
function MatrixAppBotInvites({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const { locale } = useI18n()
  const appCopy = useAppCopy()
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const apps = (snapshot.apps?.apps ?? []).filter(
    app =>
      app.bot &&
      !room.participants?.some(
        member => member.userId === app.bot!.user_id && ['join', 'invite'].includes(member.membership)
      )
  )

  // Encrypted or plain groups alike (0.20); only an encrypted one pins the bot's device (main).
  if (apps.length === 0 || room.membership !== 'join' || !room.canInvite) {
    return null
  }

  return (
    <section className="mt-4" data-app-bot-member-add>
      <h3 className="text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)">{appCopy.title}</h3>
      <div className="mt-2 flex flex-col gap-2">
        {apps.map(app => {
          const bot = app.bot!

          const available =
            snapshot.apps?.state === 'ready' &&
            bot.state === 'active' &&
            Boolean(bot.device) &&
            bot.groups &&
            bot.consent === 'accepted' &&
            app.link.state === 'linked'

          const label = appCopy.addToGroup(appLocalizedCopy(app.name, locale, bot.display_name))

          return (
            <div className="flex items-center gap-2" key={app.app_id}>
              <span className="min-w-0 flex-1 truncate text-sm">{bot.display_name}</span>
              <Button
                disabled={!available || pending !== null}
                onClick={() => {
                  setPending(app.app_id)
                  setFailed(false)
                  void window.atumMatrix.apps
                    ?.botInvite(app.app_id, room.id)
                    .catch(() => setFailed(true))
                    .finally(() => setPending(null))
                }}
                size="sm"
                type="button"
              >
                {label}
              </Button>
              {!available && (
                <span className="text-xs text-(--atum-ink-muted)">
                  {bot.groups ? appCopy.groupSetupNeeded : appCopy.groupUnavailable}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {failed && (
        <NoticeBand className="mt-2" role="alert" tone="failure">
          {appCopy.groupAddFailed}
        </NoticeBand>
      )}
    </section>
  )
}

/** An invitation, answered right in the conversation; a room you left says so. */
export function ConversationMembership({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const copy = useConversationCopy()
  const action = useConversationAction()
  const [declining, setDeclining] = useState(false)
  const ready = snapshot.state === 'ready' && !action.pending

  if (room.membership !== 'invite') {
    return <NoticeBand tone="notice">{copy.noMembership}</NoticeBand>
  }

  return (
    <section aria-label={copy.invited} className="flex flex-col gap-2 px-4 py-2" data-matrix-membership>
      <Button disabled={!ready} onClick={() => action.run({ kind: 'join', roomId: room.id })}>
        {copy.accept}
      </Button>
      {declining ? (
        <div className="flex gap-2">
          <Button
            disabled={!ready}
            onClick={() => action.run({ kind: 'leave', roomId: room.id })}
            size="sm"
            variant="destructive"
          >
            {copy.confirmDecline}
          </Button>
          <Button disabled={action.pending} onClick={() => setDeclining(false)} size="sm" variant="text">
            {copy.cancel}
          </Button>
        </div>
      ) : (
        <Button disabled={!ready} onClick={() => setDeclining(true)} size="sm" variant="text">
          {copy.decline}
        </Button>
      )}
      {action.error && (
        <NoticeBand role="alert" tone="failure">
          {copy.error}
        </NoticeBand>
      )}
    </section>
  )
}

type MemberAction = { kind: 'ignore' | 'ban' | 'unban' | 'remove'; userId: string; membership: string }

/** Who can be counted as in the chat: joined and invited, not those banned from it. */
export function matrixMemberCount(snapshot: MatrixSnapshot) {
  return (snapshot.members ?? []).filter(member => member.membership !== 'ban').length
}

/**
 * The people in a chat (launch night): one line each — initial, name, handle — and one "…"
 * with what can be done about them, each behind a short confirmation that says what it
 * does. "Add members" at the bottom opens the group picker (`add-members.tsx`), which keeps its
 * own draft and says its own failures; a moderation action's late failure outlives the dialog
 * (the header shows it beside its button).
 */
export function MatrixMembers({
  onOpenChange,
  open,
  room,
  snapshot
}: {
  onOpenChange(open: boolean): void
  open: boolean
  room: MatrixRoom
  snapshot: MatrixSnapshot
}) {
  const copy = useConversationCopy()
  const moderation = useModerationCopy()
  const chat = useChatCopy()
  const { locale, t } = useI18n()
  const action = useConversationAction()
  const pickerCopy = useGroupPickerCopy()
  const [adding, setAdding] = useState(false)
  // A personal group's sheet is the group's own: its name and topic head it.
  const details = personalGroupDetails(room, snapshot)
  const [editing, setEditing] = useState<MatrixGroupDetailField | null>(null)
  const [confirm, setConfirm] = useState<MemberAction | null>(null)
  // The person a report opened for, in this chat; it keeps its words while it closes.
  const [reporting, setReporting] = useState<{ open: boolean; userId: string }>({ open: false, userId: '' })
  const ready = snapshot.state === 'ready' && !action.pending
  const joined = room.membership === 'join'
  const members: readonly MatrixMember[] = snapshot.members ?? []
  const owner = snapshot.identity?.userId
  const people = { handles: useMatrixHandles(owner), members, ownerUserId: owner, unnamed: copy.unnamed }
  // The members sheet is a list of people: each one's @handle on the line under their name.
  useMatrixHandleContacts(owner, open ? members.map(member => member.userId) : [], Boolean(snapshot.domainEnabled))
  const target = confirm ? members.find(member => member.userId === confirm.userId) : undefined

  const targetAllowed =
    confirm &&
    target &&
    joined &&
    (confirm.kind === 'ignore' ||
      (confirm.kind === 'ban' ? target.canBan : confirm.kind === 'unban' ? target.canUnban : target.canRemove))

  // A confirmation is for the person as they were when it was asked: if they leave, change
  // membership or the power to act goes, it closes and must be asked again.
  useEffect(() => {
    if (confirm && (!targetAllowed || target?.membership !== confirm.membership)) {
      setConfirm(null)
    }
  }, [confirm, targetAllowed, target?.membership])

  // Adding belongs to this opening of Members: closed from outside (another chat, Escape on
  // Members itself), it doesn't come back open by itself next time. The picker's draft stays.
  useEffect(() => {
    if (!open) {
      setAdding(false)
      setEditing(null)
    }
  }, [open])

  // An edit is for someone the room still allows: losing the power level closes it.
  useEffect(() => {
    if (editing && !details?.[editing]) {
      setEditing(null)
    }
  }, [details, editing])

  const title = `${copy.members} (${matrixMemberCount(snapshot)})`
  const targetName = target ? matrixMemberLabel(target, people).name : ''

  const confirmation =
    confirm &&
    {
      ignore: { title: chat.memberIgnoreTitle(targetName), description: moderation.notice, label: moderation.ignore },
      ban: { title: chat.memberBanTitle(targetName), description: moderation.banNotice, label: moderation.ban },
      unban: { title: chat.memberUnbanTitle(targetName), description: undefined, label: moderation.unban },
      remove: { title: chat.memberRemoveTitle(targetName), description: chat.memberRemoveBody, label: copy.remove }
    }[confirm.kind]

  return (
    <>
      <Dialog
        onOpenChange={value => {
          onOpenChange(value)

          if (!value) {
            setConfirm(null)
          }
        }}
        open={open}
      >
        <DialogContent
          aria-describedby={undefined}
          className="atum-sheet max-w-md"
          data-matrix-membership
          onEscapeKeyDown={event => {
            // Escape first puts back the line being edited; only then does it close the sheet.
            if (editing) {
              event.preventDefault()
              setEditing(null)
            }
          }}
          onOpenAutoFocus={focusDialogField}
          showCloseButton={false}
        >
          {details ? (
            <>
              <MatrixGroupDetailsHeader
                details={details}
                editing={editing}
                onEditing={setEditing}
                room={room}
                title={matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })}
              />
              <h3
                className="mb-1 text-(length:--atum-t-label) font-semibold text-(--atum-ink-muted)"
                data-matrix-members-label
              >
                {title}
              </h3>
            </>
          ) : (
            <MatrixDialogHeader title={title} />
          )}
          <ul className="-mx-2 flex flex-col">
            {members.map(member => {
              const label = matrixMemberLabel(member, people)
              const ignored = snapshot.ignoredUsers?.includes(member.userId)
              const own = member.userId === owner

              return (
                <li
                  className="atum-row flex min-h-10 items-center gap-2.5 px-2 py-1"
                  data-matrix-member={member.userId}
                  key={member.userId}
                >
                  <AtumAssistantAvatar
                    className="size-6 shrink-0 rounded-(--atum-r-avatar-sm,6px) text-[0.6875rem] leading-none"
                    id={member.userId}
                    name={label.name}
                  />
                  <span className="min-w-0 flex-1" data-matrix-member-name>
                    <span className="block truncate text-(length:--atum-t-control)">
                      <span className="font-medium text-(--atum-ink)">{label.name}</span>
                      {/* Someone Atum marks, by their exact id (an official or verified account). */}
                      <VerifiedMark
                        className="ms-1 align-[-0.125rem]"
                        tier={accountVerificationTier(snapshot.officialAccounts, member.userId)}
                      />
                    </span>
                    {/* Their @handle (or another server's address, or a short mark between two
                        people who share a name) on the quiet line under it. */}
                    {label.address && (
                      <span className="block truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-person-handle>
                        {label.address}
                      </span>
                    )}
                  </span>
                  {(own || member.membership !== 'join' || ignored) && (
                    <span className="shrink-0 text-(length:--atum-t-label) text-(--atum-ink-muted)">
                      {own
                        ? t.dm.you
                        : member.membership === 'ban'
                          ? moderation.banned
                          : member.membership === 'invite'
                            ? copy.invited
                            : chat.ignored}
                    </span>
                  )}
                  {!own && joined && (
                    <DropdownMenu>
                      <Tip label={chat.memberOptions(label.name)}>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label={chat.memberOptions(label.name)}
                            className="atum-icon-btn size-7 shrink-0"
                            disabled={!ready}
                            type="button"
                          >
                            <MoreHorizontal aria-hidden className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                      </Tip>
                      {/* Above the dialog it opens from (the app's menu-in-dialog layer). */}
                      <DropdownMenuContent align="end" className="z-[140] min-w-44">
                        {ignored ? (
                          // Undoing an ignore needs no warning.
                          <DropdownMenuItem
                            onSelect={() => action.run({ kind: 'ignore', userId: member.userId, ignored: false })}
                          >
                            <EyeOff aria-hidden />
                            {moderation.unignore}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onSelect={() =>
                              setConfirm({ kind: 'ignore', userId: member.userId, membership: member.membership })
                            }
                          >
                            <EyeOff aria-hidden />
                            {moderation.ignore}
                          </DropdownMenuItem>
                        )}
                        {reportablePerson(room, snapshot, member.userId) && (
                          <DropdownMenuItem
                            data-matrix-report-person
                            onSelect={() => setReporting({ open: true, userId: member.userId })}
                          >
                            <Flag aria-hidden />
                            {chat.reportPerson}
                          </DropdownMenuItem>
                        )}
                        {(member.canBan || member.canUnban) && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setConfirm({
                                kind: member.canUnban ? 'unban' : 'ban',
                                userId: member.userId,
                                membership: member.membership
                              })
                            }
                            variant={member.canUnban ? 'default' : 'destructive'}
                          >
                            <AlertCircle aria-hidden />
                            {member.canUnban ? moderation.unban : moderation.ban}
                          </DropdownMenuItem>
                        )}
                        {member.canRemove && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setConfirm({ kind: 'remove', userId: member.userId, membership: member.membership })
                            }
                            variant="destructive"
                          >
                            <Trash2 aria-hidden />
                            {copy.remove}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              )
            })}
          </ul>
          {joined && <MatrixAppBotInvites room={room} snapshot={snapshot} />}
          {joined && room.canInvite && (
            <button
              className="atum-row mt-3 -mx-2 flex h-10 items-center gap-2.5 px-2 text-left text-(length:--atum-t-control) font-medium text-(--atum-ink) disabled:opacity-45"
              data-matrix-add-members-open
              disabled={!ready}
              onClick={() => setAdding(true)}
              type="button"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-(--atum-r-avatar-sm,6px) bg-(--atum-sunk) text-(--atum-ink-muted)">
                <Plus aria-hidden className="size-4" />
              </span>
              {pickerCopy.addMembers}
            </button>
          )}
          {action.error && (
            <NoticeBand className="mt-3" role="alert" tone="failure">
              {copy.error}
            </NoticeBand>
          )}
        </DialogContent>
      </Dialog>
      {/* The same picker that makes a group; it keeps its draft while the members stay open. */}
      {joined && room.canInvite && (
        <MatrixAddMembers
          members={members}
          onOpenChange={setAdding}
          open={open && adding}
          room={room}
          snapshot={snapshot}
        />
      )}
      <ClosedActionError visible={!open && action.error} />
      <MatrixReportDialog
        body={chat.reportPersonBody}
        onOpenChange={value => setReporting(previous => ({ ...previous, open: value }))}
        onReport={reason =>
          runMatrixCommand({
            kind: 'reportUser',
            roomId: room.id,
            userId: reporting.userId,
            ...(reason ? { reason } : {})
          })
        }
        open={open && reporting.open}
        title={chat.reportPersonTitle}
      />
      {confirm && confirmation && (
        <ConfirmDialog
          cancelLabel={copy.cancel}
          confirmLabel={confirmation.label}
          description={confirmation.description}
          destructive={confirm.kind === 'ban' || confirm.kind === 'remove'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const command: MatrixCommand =
              confirm.kind === 'ignore'
                ? { kind: 'ignore', userId: confirm.userId, ignored: true }
                : confirm.kind === 'remove'
                  ? { kind: 'removeMember', roomId: room.id, userId: confirm.userId }
                  : { kind: confirm.kind, roomId: room.id, userId: confirm.userId }

            try {
              await runMatrixCommand(command)
            } catch {
              throw new Error(copy.error)
            }
          }}
          open
          title={confirmation.title}
        />
      )}
    </>
  )
}

/** The header's people button for a group: their count in its tip, the members dialog. */
export function MatrixMembersButton({ onOpen, snapshot }: { onOpen(): void; snapshot: MatrixSnapshot }) {
  const copy = useConversationCopy()
  const label = `${copy.members} (${matrixMemberCount(snapshot)})`
  const owner = snapshot.identity?.userId
  const people = (snapshot.members ?? []).filter(member => member.membership === 'join' && member.userId !== owner)
  const visible = people.slice(0, 3)
  const extra = Math.max(0, people.length - visible.length)

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className="atum-icon-btn atum-members-stack flex h-7 min-w-7 items-center justify-center rounded-full px-1"
        data-matrix-members
        onClick={onOpen}
        type="button"
      >
        {visible.length ? (
          <span aria-hidden className="flex -space-x-1.5" data-matrix-member-avatars>
            {visible.map(member => (
              <AtumAssistantAvatar
                className="size-5 shrink-0 rounded-full text-[0.5625rem]"
                id={member.userId}
                key={member.userId}
                name={member.name}
              />
            ))}
            {extra > 0 && (
              <span className="atum-avatar grid size-5 place-items-center bg-(--atum-sunk) text-[0.5rem] font-semibold text-(--atum-ink-muted)">
                +{extra}
              </span>
            )}
          </span>
        ) : (
          <Users aria-hidden className="size-4" />
        )}
      </button>
    </Tip>
  )
}

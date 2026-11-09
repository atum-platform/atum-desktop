import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { Plus, UserCircle } from '@/lib/icons'

import type { MatrixRoom } from '../../../shared/matrix'
import { matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import { matrixCompanyPrivateCosCopy, matrixCompanyPrivateCosRowCopy } from '../../../shared/matrix-company-private-cos-copy'
import type { MatrixNotesSelfScopeSnapshot } from '../../../shared/matrix-notes-self'
import { CompanyAIAvatar } from '../company-ai-status'
import { companyRoomBadge } from '../company-chrome'
import { MatrixTeammateAvatar } from '../member-avatar'
import { RosterBadge } from '../roster-badge'
import { TeamSpaceSidebarRow, TeamSpaceSidebarSection } from '../team-space-sidebar'

import { ConversationGroupAvatar } from './conversation-chrome'
import { useTeamSpaceCopy } from './copy'
import { type CompanyPrivateCosRowStatus, companyPrivateCosRowStatus, type CompanyPrivateCosState } from './private-cos-store'
import { type CompanyConversationView, conversationPeople, conversationTitle } from './views'

export interface ConversationSectionProps {
  conversations: readonly CompanyConversationView[]
  rooms: readonly MatrixRoom[]
  /** The viewer's own member ref: a DM is named for the other person. */
  selfMemberRef?: string
  activeRoomId?: string | null
  showingOverview: boolean
  /** A room is being opened: no second open starts. */
  openingRoomId?: string
  /** A change is in flight or waiting on its Retry: hide, unhide and New message wait for it. */
  busy: boolean
  loading: boolean
  failed: boolean
  onOpen(view: CompanyConversationView): void
  /** This company's notes shortcut; independent of company mutations and pagination. */
  notesSelf?: MatrixNotesSelfScopeSnapshot
  notesSelfAvatar?: ReactNode
  notesAccountKey?: string
  onOpenNotesSelf?: () => Promise<void>
  privateCos?: CompanyPrivateCosState
  /**
   * The row's honest state, also before the platform serves a view (still asking, or not available
   * yet). Absent with no served view: no row.
   */
  privateCosStatus?: CompanyPrivateCosRowStatus
  privateCosAccountKey?: string
  onOpenPrivateCos?: () => Promise<void>
  /** Asks again for the private Chief of Staff (the row's action when it is not available yet). */
  onRetryPrivateCos?: () => Promise<void>
  onNew?: () => void
  query?: string
}

const byRecent = (rooms: Map<string, MatrixRoom>) => (view: CompanyConversationView) =>
  view.room.state === 'ready' ? (rooms.get(view.room.roomId)?.lastActiveAt ?? 0) : 0

/**
 * The company's "Direct messages" (Mattermost's sidebar group for DMs and group messages): every
 * conversation the platform lists for this person, newest first, with "+" for a New message. A
 * conversation's name is the other people in it; a DM row shows the person's face and a group's how many
 * are in it (Slack's), and "+ Add teammates" ends the section where this person may invite. Hidden
 * conversations are folded away under their own heading, and opening one shows it again.
 *
 * Whether a conversation is read-only, still being set up or ready is the platform's word, not Matrix's.
 */
export function ConversationSections({
  activeRoomId,
  busy,
  conversations,
  failed,
  loading,
  notesAccountKey = '',
  notesSelf,
  notesSelfAvatar,
  privateCos,
  privateCosAccountKey = '',
  privateCosStatus,
  onNew,
  onOpenNotesSelf,
  onOpenPrivateCos,
  onRetryPrivateCos,
  onOpen,
  query = '',
  rooms,
  selfMemberRef,
  showingOverview
}: ConversationSectionProps) {
  const { company, locale, team } = useTeamSpaceCopy()
  const boardCopy = matrixCompanyBoardCopy(locale)
  const privateCopy = matrixCompanyPrivateCosCopy[locale]
  const privateRowCopy = matrixCompanyPrivateCosRowCopy[locale]
  const [openingNotes, setOpeningNotes] = useState(false)
  const [notesError, setNotesError] = useState(false)
  const [openingPrivateCos, setOpeningPrivateCos] = useState(false)
  const [privateCosError, setPrivateCosError] = useState(false)

  useEffect(() => {
    setOpeningNotes(false)
    setNotesError(false)
  }, [notesAccountKey])
  useEffect(() => {
    setOpeningPrivateCos(false)
    setPrivateCosError(false)
  }, [privateCosAccountKey])
  const roomsById = new Map(rooms.map(room => [room.id, room]))
  const recent = byRecent(roomsById)
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const titleOf = (view: CompanyConversationView) => conversationTitle(view, selfMemberRef, company.someone)

  const sorted = [...conversations].sort(
    (left, right) => recent(right) - recent(left) || collator.compare(titleOf(left), titleOf(right))
  )

  const needle = query.trim().toLocaleLowerCase()
  const notesShown = !needle || [team.you, team.personalNotes].some(value => value.toLocaleLowerCase().includes(needle))

  const chiefStatus = privateCosStatus ?? (privateCos ? companyPrivateCosRowStatus(privateCos, undefined) : undefined)
  const chiefRetry = chiefStatus === 'not_available' || chiefStatus === 'paused'

  const chiefLine = chiefStatus === 'setting_up'
    ? privateRowCopy.settingUp
    : chiefStatus === 'paused'
      ? privateCopy.paused
      : chiefStatus === 'not_available'
        ? privateRowCopy.notAvailable
        : undefined

  // Ready opens; not available asks again; a served pair still setting up may be opened (it re-ensures).
  const chiefAction = chiefRetry
    ? onRetryPrivateCos ?? onOpenPrivateCos
    : chiefStatus === 'ready' || privateCos ? onOpenPrivateCos : undefined

  const privateCosShown = chiefStatus && (
    !needle || boardCopy.chiefOfStaff.toLocaleLowerCase().includes(needle) ||
    Boolean(chiefLine?.toLocaleLowerCase().includes(needle))
  )

  const shown = sorted.filter(view => !view.hidden && (!needle || titleOf(view).toLocaleLowerCase().includes(needle)))
  const hidden = sorted.filter(view => view.hidden)

  const row = (view: CompanyConversationView) => {
    const title = titleOf(view)
    const roomId = view.room.state === 'ready' ? view.room.roomId : undefined
    const ready = roomId !== undefined
    const room = roomId ? roomsById.get(roomId) : undefined
    const selected = ready && roomId === activeRoomId && !showingOverview
    const badge = room ? companyRoomBadge(room) : null
    const people = conversationPeople(view, selfMemberRef)
    const first = people[0]

    // A DM shows the person's face; a group shows two overlapping round faces.
    const icon = view.kind === 'dm' && first ? (
      <MatrixTeammateAvatar className="size-5 text-[0.625rem] leading-none"
        name={first.displayName ?? first.handle ?? company.someone} person={first} />
    ) : (
      <ConversationGroupAvatar people={people} small />
    )

    const trailing =
      view.state === 'read_only'
        ? team.conversationReadOnlyTag
        : !ready || view.state === 'provisioning'
          ? team.conversationSettingUp
          : badge
            ? <RosterBadge badge={badge} />
            : undefined

    return (
      <div data-conversation-kind={view.kind} data-conversation-state={view.state} data-matrix-company-conversation-row key={view.id}>
        <TeamSpaceSidebarRow
          ariaLabel={ready ? team.openConversation(title) : undefined}
          disabled={!ready || (view.hidden && busy)}
          icon={icon}
          label={title}
          onSelect={() => onOpen(view)}
          selected={selected}
          trailing={trailing}
          unread={badge !== null}
        />
      </div>
    )
  }

  return (
    <div data-matrix-company-conversations>
      <TeamSpaceSidebarSection
        action={onNew ? (
          <Tip label={team.newMessage}>
            <Button
              aria-label={team.newMessage}
              data-matrix-company-new-message
              disabled={busy}
              onClick={onNew}
              size="icon-xs"
              variant="ghost"
            >
              <Plus aria-hidden />
            </Button>
          </Tip>
        ) : undefined}
        title={team.directMessages}
      >
        {notesShown && (
          <div data-matrix-company-notes-self-row>
            <TeamSpaceSidebarRow
              ariaLabel={team.personalNotes}
              disabled={!onOpenNotesSelf || openingNotes}
              icon={(
                notesSelfAvatar ?? (
                  <span className="grid size-5 place-items-center rounded-(--atum-r-avatar) bg-(--atum-sunk) text-(--atum-ink-muted)">
                    <UserCircle aria-hidden className="size-3.5" />
                  </span>
                )
              )}
              label={team.you}
              onSelect={() => {
                if (!onOpenNotesSelf || openingNotes) {
                  return
                }

                setOpeningNotes(true)
                setNotesError(false)
                void onOpenNotesSelf()
                  .catch(() => setNotesError(true))
                  .finally(() => setOpeningNotes(false))
              }}
              selected={notesSelf?.state === 'ready' && notesSelf.roomId === activeRoomId && !showingOverview}
              trailing={openingNotes ? team.working : undefined}
            />
            {notesError && (
              <p className="px-8 py-1 text-xs text-destructive" data-matrix-company-notes-error role="alert">
                {team.conversationOpenFailed}
              </p>
            )}
          </div>
        )}
        {privateCosShown && (
          <div data-company-private-cos-row data-company-private-cos-state={chiefStatus}>
            <TeamSpaceSidebarRow
              ariaLabel={chiefRetry && chiefAction
                ? `${boardCopy.chiefOfStaff} · ${privateRowCopy.retry}`
                : boardCopy.chiefOfStaff}
              disabled={!chiefAction || openingPrivateCos || Boolean(privateCos?.loading)}
              icon={(
                <CompanyAIAvatar
                  className="size-5 text-[0.625rem] leading-none"
                  name={boardCopy.chiefOfStaff}
                  principal={!privateCos
                    ? privateCosAccountKey
                    : 'binding' in privateCos.view
                      ? privateCos.view.binding.agentPrincipal
                      : privateCos.view.pair.membershipIncarnation}
                />
              )}
              label={boardCopy.chiefOfStaff}
              onSelect={() => {
                if (!chiefAction || openingPrivateCos) {return}
                setOpeningPrivateCos(true)
                setPrivateCosError(false)
                void chiefAction()
                  .catch(() => setPrivateCosError(true))
                  .finally(() => setOpeningPrivateCos(false))
              }}
              selected={privateCos?.view.state === 'ready' &&
                privateCos.view.binding.roomId === activeRoomId && !showingOverview}
              trailing={openingPrivateCos && chiefRetry ? privateRowCopy.settingUp : chiefLine}
            />
            {privateCosError && (
              <p className="px-8 py-1 text-xs text-destructive" data-company-private-cos-error role="alert">
                {team.conversationOpenFailed}
              </p>
            )}
          </div>
        )}
        {shown.map(row)}
        {loading && shown.length === 0 && (
          <p className="px-2 py-1 text-xs text-(--atum-ink-muted)" role="status">{team.conversationsLoading}</p>
        )}
        {failed && (
          <p className="px-2 py-1 text-xs text-destructive" role="alert">{team.conversationsFailed}</p>
        )}
      </TeamSpaceSidebarSection>
      {hidden.length > 0 && (
        <div data-matrix-company-conversations-hidden>
          <TeamSpaceSidebarSection defaultOpen={false} title={team.hiddenConversations}>
            {hidden.map(row)}
          </TeamSpaceSidebarSection>
        </div>
      )}
    </div>
  )
}

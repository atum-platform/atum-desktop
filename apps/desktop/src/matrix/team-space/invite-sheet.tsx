import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { Check, Mail, SearchIcon, X } from '@/lib/icons'

import type { MatrixCompanyBridge, MatrixCompanyMutation } from '../../../shared/matrix-company'
import {
  type CompanyEmailMailStatus,
  CompanyInviteEmailSchema,
  type CompanyMemberAdd112Response,
  type CompanyRole13
} from '../../../shared/matrix-company-team-space'
import type { MatrixPeopleSearchPerson } from '../../../shared/matrix-people-search'
import { MatrixTeammateAvatar } from '../member-avatar'
import { searchPeopleDirectory } from '../people'
import { useMatrixHandleContacts } from '../person-handle-contacts'
import { PersonHandleLine } from '../person-handle-line'
import { $matrixHandles } from '../person-handles'

import type { CompanyAbilities, TeamSpaceProfile } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { useEmailMailStatus } from './email-mail-status'
import { InviteLinks } from './invite-links'
import { type MemberAddReadiness, useMemberAddReadiness } from './member-add-readiness'
import type { MutationOutcome, TeamSpaceMutate } from './outcome'
import { companyErrorText } from './outcome'
import { type EmailInvitationRow, type InvitationAction, PendingInvitationList } from './pending-invitations'
import type { InvitationRow, RosterMember } from './views'

const HANDLE_INPUT = /^@?[a-z][a-z0-9_]{2,31}$/iu
const newRequestId = () => globalThis.crypto.randomUUID()

/** A complete email address as the platform takes it (trimmed, lowercased), or undefined. */
export function inviteEmailOf(query: string): string | undefined {
  const value = query.trim().toLowerCase()

  return CompanyInviteEmailSchema.safeParse(value).success ? value : undefined
}

/** The handle a query names exactly, lowercased without its @, or undefined. */
export function inviteHandleOf(query: string): string | undefined {
  const value = query.trim()

  return HANDLE_INPUT.test(value) ? value.replace(/^@/u, '').toLowerCase() : undefined
}

/** Where one person already stands with this company, by the handles the screen knows. */
export type InviteStanding = 'member' | 'invited' | 'none'

export function inviteStanding(
  handle: string | undefined,
  roster: readonly RosterMember[],
  invitations: readonly InvitationRow[]
): InviteStanding {
  if (!handle) {
    return 'none'
  }

  if (roster.some(member => member.state === 'active' && member.handle?.toLowerCase() === handle)) {
    return 'member'
  }

  return invitations.some(invitation => !invitation.expired && invitation.targetHandle === handle) ? 'invited' : 'none'
}

type Search =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; people: readonly MatrixPeopleSearchPerson[] }
  | { state: 'failed' }

/** The people directory (names, exact handles, exact email) for what is typed, debounced, latest answer only. */
function usePeopleSearch(query: string, disabled: boolean): Search {
  const [search, setSearch] = useState<Search>({ state: 'idle' })
  const generation = useRef(0)

  useEffect(() => {
    const text = query.trim()
    const mine = ++generation.current
    const bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.people

    if (disabled || !bridge || [...text].length < 2) {
      setSearch({ state: 'idle' })

      return
    }

    setSearch({ state: 'loading' })
    const timer = setTimeout(() => {
      void searchPeopleDirectory(bridge, text).then(
        people => {
          if (generation.current === mine) {setSearch({ state: 'done', people })}
        },
        () => {
          if (generation.current === mine) {setSearch({ state: 'failed' })}
        }
      )
    }, 250)

    return () => clearTimeout(timer)
  }, [disabled, query])

  return search
}

type Candidate =
  | { key: string; kind: 'person'; person: MatrixPeopleSearchPerson; handle?: string; standing: InviteStanding; invitable: boolean }
  | { key: string; kind: 'handle'; handle: string; typed: string; standing: InviteStanding }
  | { key: string; kind: 'email'; email: string }

type RowState = { state: 'sending' } | { state: 'invited' } | { state: 'added' } | { state: 'member' } | { state: 'failed' }

/**
 * What Add does in this company. `add`: a direct add (1.12, the readiness said `allowed`). `invite`: the readiness said
 * `invite_only`, so the button says Invite. `legacy`: no direct add on this server, so Add is the one-press invite it was.
 * `checking`: the readiness is being read; Add waits. `none`: the readiness said `not_allowed`.
 */
export type AddMode = 'add' | 'invite' | 'legacy' | 'checking' | 'none'

export function addModeOf(readiness: MemberAddReadiness): AddMode {
  switch (readiness.state) {
    case 'off':
    case 'unsupported':
      return 'legacy'

    case 'checking':
      return 'checking'

    case 'ready':
      return readiness.value.directAdd === 'allowed' ? 'add' : readiness.value.directAdd === 'invite_only' ? 'invite' : 'none'
  }
}

/** What one direct-add answer means for its row and for the sheet's one line. */
export interface AddResult {
  row: RowState | undefined
  tone: 'ok' | 'error'
  /** The readiness may have moved (policy, roster): read it again. */
  reload: boolean
}

export function memberAddResult(value: CompanyMemberAdd112Response): AddResult {
  switch (value.outcome) {
    case 'added':
      return { row: { state: 'added' }, tone: 'ok', reload: true }

    case 'already_member':
      return { row: { state: 'member' }, tone: 'ok', reload: false }

    case 'invited':
      return { row: { state: 'invited' }, tone: 'ok', reload: false }

    // The caller may still invite (admins only), or grant member instead of admin: the row's button stays, with a new
    // request ID on the next press.
    case 'not_allowed':
      return { row: undefined, tone: 'error', reload: true }

    case 'roster_full':
      return { row: { state: 'failed' }, tone: 'error', reload: true }

    case 'unknown_user':
      return { row: { state: 'failed' }, tone: 'error', reload: false }
  }
}

export interface InviteSheetProps {
  bridge: MatrixCompanyBridge
  companyId: string
  companyName: string
  abilities: CompanyAbilities
  profile: TeamSpaceProfile
  viewer: CompanyRole13 | undefined
  roster: readonly RosterMember[]
  invitations: readonly InvitationRow[]
  nowSeconds: number
  /** Another change is running or waits for its Retry: nothing new may start. */
  blocked: boolean
  /** The viewer's standing no longer allows inviting. */
  notAllowed: boolean
  /** An invitation whose answer was lost, kept by the workspace's journal. Its Retry replays the same request. */
  retry?: MatrixCompanyMutation
  onRetry(): Promise<MutationOutcome | undefined>
  dialogInstance: number
  replayedLinkIds: ReadonlySet<string>
  mutate: TeamSpaceMutate
  onInvitationAction(action: InvitationAction, invitation: InvitationRow): void
  onClose(): void
}

/**
 * Add people (Slack's "Invite people to …", Mattermost's "Add members"): one field for a name, @username or
 * email; every person found is a row with their circle, name and @handle (and the email when that is what was
 * typed), and one Add that invites them at once. Someone already in the company or already invited says so
 * on their row instead. An email with no match is one more row, when the server takes email invitations.
 * Below sit the share link (when this person may make one) and the invitations still waiting.
 *
 * A pick never leaves its company: the sheet is keyed by company and opening, and every Add names the
 * company it was drawn for. An "accepted" email invitation is said as invited, never as sent mail.
 */
export function InviteSheet({
  abilities,
  blocked,
  bridge,
  companyId,
  companyName,
  dialogInstance,
  invitations,
  mutate,
  notAllowed,
  nowSeconds,
  onClose,
  onInvitationAction,
  onRetry,
  profile,
  replayedLinkIds,
  retry,
  roster,
  viewer
}: InviteSheetProps) {
  const { company, locale, team } = useTeamSpaceCopy()
  const copy = team.inviteSheet
  const handleState=useStore($matrixHandles)
  const handles=handleState.byUser
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map())
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'error'; note?: string; mailFor?: string }>()
  const [emailInvitations, setEmailInvitations] = useState<readonly EmailInvitationRow[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const memberAdd = useMemberAddReadiness(bridge, companyId, abilities.directAdd)
  const mode = addModeOf(memberAdd.readiness)
  const readiness = memberAdd.readiness.state === 'ready' ? memberAdd.readiness.value : undefined
  const mailStatuses = useEmailMailStatus(bridge, companyId, emailInvitations.map(row => row.invitationId), abilities.mailStatus)
  const full = mode === 'add' && readiness?.rosterRemaining === 0
  const disabled = blocked || notAllowed || mode === 'none'
  /**
   * The one guard every way of acting goes through (the row's button, its click, Enter): nothing is sent while the
   * readiness is being read (Add might mean add or invite), when the company is full, or when nothing is allowed.
   */
  const actionsHeld = disabled || mode === 'checking' || full
  // Handlers read the latest render's choice, so an action never uses a mode the readiness has since replaced.
  const gate = useRef({ mode, actionsHeld })
  gate.current = { mode, actionsHeld }
  const search = usePeopleSearch(query, notAllowed || mode === 'none')
  const email = inviteEmailOf(query)
  const typedHandle = inviteHandleOf(query)
  // With 1.12 the platform says which roles this viewer may grant; before it, the owner alone grants admin.
  const grantsAdmin = readiness ? readiness.assignableRoles.includes('admin') && abilities.inviteAdmin : abilities.inviteAdmin
  const inviteRole = grantsAdmin ? role : 'member'
  const people = search.state === 'done' ? search.people : []
  useMatrixHandleContacts(handleState.owner,people.map(person=>person.userId))
  const settled = search.state === 'done' || search.state === 'failed' || search.state === 'idle'

  const candidates: Candidate[] = people.map(person => {
    const handle = person.handle ?? handles[person.userId] ?? undefined
    const exact = typedHandle !== undefined && handle === typedHandle

    return {
      key: `person:${person.userId}`,
      kind: 'person',
      person,
      ...(handle ? { handle } : {}),
      standing: inviteStanding(handle, roster, invitations),
      // A direct add names the person by the Matrix ID the directory answered with. Without 1.10 only the person whose
      // exact handle was typed can be invited (by that handle).
      invitable: mode === 'add' || abilities.inviteDirectory || exact
    }
  })

  // A typed handle the directory did not show (undiscoverable, or no directory here) still gets its row: when it was
  // typed as a handle (with its @), when no one at all answered to it as a name, or when a handle is the only way to
  // invite here (no directory invitations).
  const handleTyped = typedHandle !== undefined &&
    (query.trim().startsWith('@') || people.length === 0 || !abilities.inviteDirectory)

  if (typedHandle && handleTyped && settled &&
    !candidates.some(candidate => candidate.kind === 'person' && candidate.handle === typedHandle)) {
    candidates.push({ key: `handle:${typedHandle}`, kind: 'handle', handle: typedHandle, typed: query.trim(),
      standing: inviteStanding(typedHandle, roster, invitations) })
  }

  // An address no one answered to: invite it by email when the server takes email invitations (members only).
  const emailRow = email && settled && people.length === 0 && abilities.inviteEmail && inviteRole === 'member'

  if (emailRow) {
    candidates.push({ key: `email:${email}`, kind: 'email', email })
  }

  const actionable = candidates.filter(candidate =>
    candidate.kind === 'email' || (candidate.standing === 'none' && (candidate.kind === 'handle' || candidate.invitable)))

  const mutationFor = (candidate: Candidate): MatrixCompanyMutation | undefined => {
    if (candidate.kind === 'email') {
      return { action: 'email-invitation-create', companyId, requestId: newRequestId(), email: candidate.email,
        locale: locale.startsWith('vi') ? 'vi' : 'en' }
    }

    // 1.12: the person joins at once. An address is never added (only invited), and a typed handle without a directory
    // answer has no Matrix ID to name, so both keep their invitation below.
    if (candidate.kind === 'person' && gate.current.mode === 'add') {
      return { action: 'member-add', companyId, requestId: newRequestId(),
        target: { kind: 'matrixUser', memberMatrixUser: candidate.person.userId }, role: inviteRole }
    }

    if (candidate.kind === 'person' && abilities.inviteDirectory) {
      // 1.10: the platform resolves the person from the Matrix user ID the directory answered with.
      return { action: 'invitation-create-directory', companyId, requestId: newRequestId(),
        memberMatrixUser: candidate.person.userId, role: inviteRole }
    }

    const memberHandle = candidate.kind === 'handle' ? candidate.typed : candidate.handle

    if (!memberHandle) {
      return undefined
    }

    // C1's durable seven-day invitation by handle; before it, the 1.1 invitation (members only).
    return profile.admin
      ? { action: 'invitation-create', companyId, requestId: newRequestId(), memberHandle, role: inviteRole }
      : { action: 'invite', companyId, requestId: newRequestId(), memberHandle, role: 'member' }
  }

  const failureText = (outcome: Extract<MutationOutcome, { ok: false }>, mutation?: MatrixCompanyMutation): string => {
    if (outcome.notAllowed) {
      return team.noLongerAllowed
    }

    // The 1.1 invitation by handle answers 404 for a handle no one holds: say that, as the 1.1 client did.
    if (mutation?.action === 'invite' && outcome.error === 'missing') {
      return company.inviteUnavailable
    }

    if (outcome.reason === 'invitation_unavailable' || outcome.reason === 'invite_target_unavailable') {
      return copy.cantInvite
    }

    if (outcome.reason) {
      return team.refusal[outcome.reason]
    }

    if (outcome.error === 'denied') {
      return copy.notAllowed
    }

    if (outcome.error === 'missing') {
      return copy.cantInvite
    }

    return outcome.error === 'limit' ? company.inviteLimited : companyErrorText(outcome.error, company)
  }

  const nameOf = (candidate: Candidate) =>
    candidate.kind === 'email' ? candidate.email : candidate.kind === 'handle' ? `@${candidate.handle}` : candidate.person.name

  const add = async (candidate: Candidate) => {
    if (gate.current.actionsHeld || rows.get(candidate.key)?.state === 'sending') {
      return
    }

    const mutation = mutationFor(candidate)

    if (!mutation) {
      return
    }

    setRows(previous => new Map(previous).set(candidate.key, { state: 'sending' }))
    setStatus(undefined)
    const outcome = await mutate(mutation)

    if (!mounted.current) {
      return
    }

    if (!outcome) {
      setRows(previous => {
        const next = new Map(previous)
        next.delete(candidate.key)

        return next
      })

      return
    }

    if (!outcome.ok) {
      setRows(previous => new Map(previous).set(candidate.key, { state: 'failed' }))
      setStatus({ text: failureText(outcome, mutation), tone: 'error' })

      return
    }

    if (mutation.action === 'member-add') {
      showMemberAdd(outcome.value as CompanyMemberAdd112Response, candidate.key, nameOf(candidate))

      return
    }

    setRows(previous => new Map(previous).set(candidate.key, { state: 'invited' }))

    if (candidate.kind === 'email' && 'invitationId' in outcome.value && 'expiresAt' in outcome.value && 'mailStatus' in outcome.value) {
      noteEmailInvitation(candidate.email, outcome.value.invitationId, outcome.value.expiresAt)

      return
    }

    setStatus({ text: copy.invited(nameOf(candidate)), tone: 'ok' })
  }

  /** One short line for a direct add's answer, its row, and a fresh look at the readiness when it may have moved. */
  const showMemberAdd = (value: CompanyMemberAdd112Response, key: string, name: string) => {
    const result = memberAddResult(value)

    setRows(previous => {
      const next = new Map(previous)

      if (result.row) {
        next.set(key, result.row)
      } else {
        next.delete(key)
      }

      return next
    })

    const text = value.outcome === 'added'
      ? copy.added(name)
      : value.outcome === 'already_member'
        ? copy.alreadyMemberLine(name)
        : value.outcome === 'invited'
          ? copy.emailInvited(name)
          : value.outcome === 'not_allowed'
            ? value.reason === 'owner_only_role' ? copy.ownerOnlyRole : copy.adminsOnly
            : value.outcome === 'roster_full' ? copy.rosterFull : copy.cantAdd

    setStatus({ text, tone: result.tone })

    // An add moved the roster: read again quietly. A refusal said the old answer no longer holds: hold actions until
    // the new one, so the next press uses it (an admins-only refusal turns Add into Invite).
    if (result.reload) {
      memberAdd.reload({ hold: value.outcome !== 'added' })
    }
  }

  /** An email invitation made here: listed below, and its mail state said truthfully once the server can tell it. */
  const noteEmailInvitation = (address: string, invitationId: string, expiresAt: number) => {
    setEmailInvitations(previous => previous.some(row => row.invitationId === invitationId)
      ? previous
      : [{ invitationId, email: address, expiresAt }, ...previous])
    // `accepted` is durable acceptance, never sent mail. Without the mail-state read, say no email goes out yet.
    setStatus(abilities.mailStatus
      ? { text: copy.emailInvited(address), tone: 'ok', mailFor: invitationId }
      : { text: copy.emailInvited(address), tone: 'ok', note: abilities.inviteLink ? copy.emailNotSent : copy.emailNotSentNoLink })
  }

  // The workspace's journal replays the exact request whose answer was lost; this only says what came of it.
  const runRetry = async (mutation: MatrixCompanyMutation) => {
    setStatus(undefined)
    const outcome = await onRetry()

    if (!mounted.current || !outcome) {
      return
    }

    if (!outcome.ok) {
      setStatus({ text: failureText(outcome, mutation), tone: 'error' })

      return
    }

    if (mutation.action === 'member-add' && mutation.target.kind === 'matrixUser') {
      const userId = mutation.target.memberMatrixUser
      const person = people.find(candidate => candidate.userId === userId)

      showMemberAdd(outcome.value as CompanyMemberAdd112Response, `person:${userId}`, person?.name ?? userId)

      return
    }

    if (mutation.action === 'email-invitation-create' && 'invitationId' in outcome.value && 'expiresAt' in outcome.value && 'mailStatus' in outcome.value) {
      noteEmailInvitation(mutation.email, outcome.value.invitationId, outcome.value.expiresAt)

      return
    }

    setStatus({ text: company.inviteSent, tone: 'ok' })
  }

  const mailText = (mailStatus: CompanyEmailMailStatus | undefined) => mailStatus === 'sent'
    ? copy.mailSent
    : mailStatus === 'failed'
      ? abilities.inviteLink ? `${copy.mailFailed}. ${copy.emailFailedNote}` : copy.mailFailed
      : mailStatus === 'cancelled' ? copy.mailCancelled : mailStatus === 'queued' ? copy.mailQueued : undefined
  const statusNote = status?.mailFor ? mailText(mailStatuses.get(status.mailFor)) : status?.note

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter adds only when exactly one person can be added: two people with one name are never guessed between.
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()

    if (gate.current.actionsHeld) {
      return
    }

    const pending = actionable.filter(candidate => !rows.has(candidate.key))

    if (pending.length === 1) {
      void add(pending[0]!)
    }
  }

  const emptyLine = (() => {
    if (search.state === 'loading' || candidates.length > 0) {
      return undefined
    }

    if (search.state === 'failed') {
      return company.unavailable
    }

    if (search.state !== 'done') {
      return undefined
    }

    // An address with no match, where email invitations are off: the link is the way in.
    if (email && !abilities.inviteEmail && abilities.inviteLink) {
      return copy.emailOff
    }

    return email ? team.peopleNoMatch : copy.notFound
  })()

  return (
    <div
      aria-label={copy.title(companyName)}
      aria-modal="true"
      className="atum-sheet relative grid max-h-[min(40rem,calc(100dvh-2rem))] w-full max-w-md grid-rows-[auto_minmax(0,1fr)] gap-4 p-5"
      data-matrix-company-invite
      role="dialog"
    >
      <button aria-label={company.close} className="atum-icon-btn absolute top-3 right-3 size-7" onClick={onClose} type="button">
        <X aria-hidden className="size-4" />
      </button>
      <h2 className="pe-8 text-(length:--atum-t-section) font-semibold tracking-tight text-(--atum-ink)">{copy.title(companyName)}</h2>

      <div className="grid min-h-0 content-start gap-4 overflow-y-auto">
        {mode === 'none' && (
          <p className="text-sm text-(--atum-ink-muted)" data-matrix-company-add-none role="status">{copy.notAllowed}</p>
        )}
        <div className={mode === 'none' ? 'hidden' : 'grid gap-2'}>
          <label className="ak-field ak-field--search">
            <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
            <input
              aria-label={copy.search}
              autoFocus
              disabled={notAllowed || mode === 'none'}
              onChange={event => {
                setQuery(event.currentTarget.value)
                setStatus(undefined)
              }}
              onKeyDown={onKeyDown}
              placeholder={copy.search}
              value={query}
            />
          </label>
          {grantsAdmin && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-(--atum-ink-muted)">{team.inviteRoleLabel}</span>
              <AtumSegmented<'admin' | 'member'>
                disabled={disabled}
                label={team.inviteRoleLabel}
                onChange={setRole}
                options={[{ id: 'member', label: team.member }, { id: 'admin', label: team.admin }]}
                value={role}
              />
            </div>
          )}
        </div>

        {notAllowed && <p className="text-sm text-destructive" data-matrix-company-not-allowed role="alert">{team.noLongerAllowed}</p>}
        {mode === 'add' && readiness && readiness.rosterRemaining <= 5 && (
          <p className="text-xs text-(--atum-ink-muted)" data-matrix-company-roster-room>
            {readiness.rosterRemaining === 0 ? copy.rosterFull : copy.roomFor(readiness.rosterRemaining)}
          </p>
        )}

        <div className="grid gap-2 empty:hidden">
          {search.state === 'loading' && candidates.length === 0 && (
            <p className="text-xs text-(--atum-ink-muted)" role="status">{team.working}</p>
          )}
          {emptyLine && <p className="text-xs text-(--atum-ink-muted)" data-matrix-company-invite-empty role="status">{emptyLine}</p>}
          {candidates.length > 0 && (
            <ul aria-label={copy.title(companyName)} className="grid gap-0.5" data-matrix-company-invite-directory>
              {candidates.map(candidate => (
                <InviteCandidateRow
                  candidate={candidate}
                  disabled={actionsHeld}
                  email={email}
                  inviteLabel={mode === 'invite'}
                  key={candidate.key}
                  onAdd={() => void add(candidate)}
                  state={rows.get(candidate.key)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Always in the accessibility tree, so a result is announced; it takes no room until it has something to say. */}
        <div aria-live="polite" className={status ? '-mt-2 grid gap-0.5' : 'sr-only'} role="status">
          {status && (
            <p className={status.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-(--atum-ink)'} data-matrix-company-invite-status>
              {status.text}
              {statusNote && <span className="text-(--atum-ink-muted)" data-matrix-company-invite-mail> {statusNote}</span>}
            </p>
          )}
        </div>
        {retry && (
          <div className="flex justify-end">
            <Button disabled={notAllowed} onClick={() => void runRetry(retry)} size="sm" type="button" variant="secondary">
              {company.retry}
            </Button>
          </div>
        )}

        {/* A viewer the platform lets neither add nor invite here gets no link either: a link is an invitation. */}
        {abilities.inviteLink && mode !== 'none' && (
          <InviteLinks
            blocked={blocked}
            bridge={bridge}
            canRevoke={abilities.revokeInviteLink}
            companyId={companyId}
            dialogInstance={dialogInstance}
            key={`${companyId}:${dialogInstance}`}
            mutate={mutate}
            replayedLinkIds={replayedLinkIds}
          />
        )}

        <PendingInvitationList
          blocked={blocked}
          compact
          emailInvitations={emailInvitations.map(row => {
            const mailStatus = mailStatuses.get(row.invitationId)

            return mailStatus ? { ...row, mailStatus } : row
          })}
          invitations={invitations}
          nowSeconds={nowSeconds}
          onInvitationAction={onInvitationAction}
          profile={profile}
          viewer={viewer}
        />
      </div>
    </div>
  )
}

function InviteCandidateRow({ candidate, disabled, email, inviteLabel, onAdd, state }: {
  candidate: Candidate
  disabled: boolean
  /** The viewer may invite but not add here: the button says what it does. */
  inviteLabel: boolean
  /** The email that was typed: an exact-email match shows it under the name, so two "Lan Nguyễn" stay apart. */
  email: string | undefined
  onAdd(): void
  state: RowState | undefined
}) {
  const { team } = useTeamSpaceCopy()
  const copy = team.inviteSheet

  const name = candidate.kind === 'email'
    ? copy.emailRow(candidate.email)
    : candidate.kind === 'handle' ? `@${candidate.handle}` : candidate.person.name

  const standing = candidate.kind === 'email' ? 'none' : candidate.standing
  const invitable = candidate.kind !== 'person' || candidate.invitable

  const trailing = state?.state === 'added'
    ? (
        <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-muted)" data-invite-row-state="added">
          <Check aria-hidden className="size-3.5" />
          {copy.addedRow}
        </span>
      )
    : state?.state === 'invited' || standing === 'invited'
    ? (
        <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-muted)" data-invite-row-state="invited">
          <Check aria-hidden className="size-3.5" />
          {candidate.kind === 'email' && state?.state === 'invited' ? copy.byEmail : copy.alreadyInvited}
        </span>
      )
    : standing === 'member' || state?.state === 'member'
      ? <span className="text-xs text-(--atum-ink-muted)" data-invite-row-state="member">{copy.alreadyMember}</span>
      : invitable
        ? (
            <Button
              aria-label={`${inviteLabel ? copy.invite : copy.add} ${candidate.kind === 'email' ? candidate.email : name}`}
              disabled={disabled || state?.state === 'sending'}
              onClick={onAdd}
              size="sm"
              type="button"
              variant="secondary"
            >
              {state?.state === 'sending' ? team.working : inviteLabel ? copy.invite : copy.add}
            </Button>
          )
        : null

  return (
    <li
      className="flex min-h-11 items-center gap-2.5 rounded-(--atum-r-control) px-2 py-1"
      data-invite-row={candidate.kind}
      data-invite-row-result={state?.state}
    >
      {candidate.kind === 'email' ? (
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-(--atum-line) text-(--atum-ink-muted)">
          <Mail className="size-4" />
        </span>
      ) : (
        <MatrixTeammateAvatar
          className="size-8 shrink-0 rounded-full text-[0.6875rem] leading-none"
          name={candidate.kind === 'person' ? candidate.person.name : candidate.handle}
          person={{ memberRef: candidate.kind === 'person' ? candidate.person.userId : `handle:${candidate.handle}`,
            displayName: candidate.kind === 'person' ? candidate.person.name : candidate.handle }}
        />
      )}
      <span className="min-w-0 flex-1 text-start">
        <span className="block truncate text-sm text-(--atum-ink)">{name}</span>
        {candidate.kind === 'person' && (
          <>
            <PersonHandleLine handle={candidate.handle} name={candidate.person.name} />
            {email && <span className="block truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)">{email}</span>}
          </>
        )}
      </span>
      {trailing}
    </li>
  )
}

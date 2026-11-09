import type {
  MatrixCompanyChannelItem,
  MatrixCompanyMember11,
  MatrixCompanyRoom,
  MatrixCompanySnapshot11
} from '../../../shared/matrix-company'
import type {
  CompanyAdminSnapshot13Response,
  CompanyChannelAction14,
  CompanyChannelAdmissionState14,
  CompanyChannelAdmittedSnapshot14,
  CompanyChannelPublicSummary14,
  CompanyChannelPublicSummary16,
  CompanyConversation15,
  CompanyRole13
} from '../../../shared/matrix-company-team-space'

import type { ChannelFacts } from './abilities'

/**
 * The shapes the Team Space screens draw from. Each normalises the 1.1 company-wide wire, the 1.3
 * administration snapshot and the 1.4 channel wire into one model, so a screen never branches on a
 * wire version: it asks the abilities module what is allowed and draws what is here.
 */

export interface ChannelAdmissionView {
  memberRef: string
  state: CompanyChannelAdmissionState14
  epoch: number
  generation: number
}

export interface CompanyChannelView {
  id: string
  companyId: string
  displayName: string
  systemKey?: 'default'
  /** The 1.1 company-wide channel reads as public: every member was in it, and it stays so. */
  visibility: 'public' | 'private'
  state: 'provisioning' | 'active' | 'archived'
  topic: string
  purpose: string
  memberCount: number
  room: MatrixCompanyRoom
  projectId: string | null
  channelGeneration: number
  /** Where this row came from; the 1.1 wire never carries privacy, admission or actions. */
  wire: '1.1' | '1.4'
  admission?: ChannelAdmissionView
  ownerMemberRef?: string
  actions: readonly CompanyChannelAction14[] | null
}

export const isDefaultChannel = (channel: Pick<CompanyChannelView, 'systemKey'>) => channel.systemKey === 'default'

/** The facts about a channel that decide what its viewer may do in it (`channelAbilities`). */
export function channelFactsOf(view: CompanyChannelView): ChannelFacts {
  return {
    ...(view.systemKey ? { systemKey: view.systemKey } : {}),
    visibility: view.visibility,
    state: view.state,
    actions: view.actions,
    ownedByViewer: Boolean(view.ownerMemberRef && view.ownerMemberRef === view.admission?.memberRef)
  }
}

export function channelViewFromLegacy(item: MatrixCompanyChannelItem): CompanyChannelView {
  const { channel } = item

  return {
    id: channel.id,
    companyId: channel.companyId,
    displayName: channel.displayName,
    ...('systemKey' in channel && channel.systemKey ? { systemKey: channel.systemKey } : {}),
    visibility: 'public',
    state: channel.state,
    topic: '',
    purpose: '',
    memberCount: 'memberPrincipals' in item ? item.memberPrincipals.length : item.memberCount,
    room: item.room,
    projectId: channel.projectId,
    channelGeneration: channel.channelGeneration,
    wire: '1.1',
    actions: null
  }
}

export function channelViewFrom14(item: CompanyChannelAdmittedSnapshot14): CompanyChannelView {
  const { channel, selfAdmission } = item

  return {
    id: channel.id,
    companyId: channel.companyId,
    displayName: channel.displayName,
    ...(channel.systemKey ? { systemKey: channel.systemKey } : {}),
    visibility: channel.visibility,
    state: channel.state,
    topic: channel.topic,
    purpose: channel.purpose,
    memberCount: item.memberCount,
    room: item.room,
    // The 1.4 channel carries no project link; the project hub reads the 1.1 projection for that.
    projectId: null,
    channelGeneration: channel.channelGeneration,
    wire: '1.4',
    admission: {
      memberRef: selfAdmission.memberRef,
      state: selfAdmission.state,
      epoch: selfAdmission.admissionEpoch,
      generation: selfAdmission.admissionGeneration
    },
    ownerMemberRef: channel.ownerMemberRef,
    actions: item.actions
  }
}

export interface PublicChannelView {
  id: string
  displayName: string
  systemKey?: 'default'
  topic: string
  purpose: string
  state: 'provisioning' | 'active' | 'archived'
  memberCount: number
  joined: boolean
  /** Present on the 1.6 joinable browse; absent on the read-only 1.4 fallback. */
  channelGeneration?: number
}

export function publicChannelView(summary: CompanyChannelPublicSummary14 | CompanyChannelPublicSummary16): PublicChannelView {
  return {
    id: summary.id,
    displayName: summary.displayName,
    ...(summary.systemKey ? { systemKey: summary.systemKey } : {}),
    topic: summary.topic,
    purpose: summary.purpose,
    state: summary.state,
    memberCount: summary.memberCount,
    joined: summary.joined,
    ...('channelGeneration' in summary ? { channelGeneration: summary.channelGeneration } : {})
  }
}

/** #general first, then by name in the person's language (the server's order is by id). */
export function sortChannels<T extends { displayName: string; systemKey?: 'default' }>(
  channels: readonly T[],
  locale: string
): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })

  return [...channels].sort((left, right) => {
    if (isDefaultChannel(left) !== isDefaultChannel(right)) {
      return isDefaultChannel(left) ? -1 : 1
    }

    return collator.compare(left.displayName, right.displayName)
  })
}

export interface RosterMember {
  memberRef: string
  role: CompanyRole13
  state: 'active' | 'invited' | 'revoking'
  self: boolean
  handle: string | null
  displayName: string | null
  avatarUri?: string
  /** Incremented on every readmission (1.3); a removed person's old grants never return. */
  admissionEpoch?: number
}

const RANK: Record<CompanyRole13, number> = { owner: 0, admin: 1, member: 2 }

export const rosterName = (member: Pick<RosterMember, 'displayName' | 'handle'>, fallback: string) =>
  member.displayName ?? (member.handle ? `@${member.handle}` : fallback)

/**
 * The company roster: profiles from the 1.1 snapshot, authority from the 1.3 administration
 * snapshot when there is one. Without it (an older server, or C1 inactive) the roles are the 1.1
 * `admin | member`, with no owner. A removed person is never listed; with 1.3 a pending invitee is
 * not a member (they are in the invitation list), so the 1.1 `invited` rows drop out.
 */
export function rosterMembers(
  snapshot: MatrixCompanySnapshot11,
  admin: CompanyAdminSnapshot13Response | undefined,
  locale: string
): RosterMember[] {
  const authority = new Map(admin?.members.map(member => [member.memberRef, member]))
  const rows = new Map<string, RosterMember>()

  const profile = (member: MatrixCompanyMember11, state: RosterMember['state']): RosterMember => ({
    memberRef: member.memberRef,
    role: member.role,
    state,
    self: member.self,
    handle: member.handle,
    displayName: member.displayName,
    ...(member.avatarUri ? { avatarUri: member.avatarUri } : {})
  })

  for (const member of snapshot.members) {
    if (member.state === 'removed' || (admin && member.state === 'invited')) {
      continue
    }

    const row = profile(member, member.state)
    const granted = authority.get(member.memberRef)

    if (granted && granted.state !== 'removed') {
      row.role = granted.role
      // A removal in flight never un-shows because the other read is a moment older.
      row.state = granted.state === 'revoking' || row.state === 'revoking' ? 'revoking' : granted.state
      row.admissionEpoch = granted.admissionEpoch
    }

    rows.set(row.memberRef, row)
  }

  // A person the authority lists but the profile read did not (the two reads raced).
  for (const granted of admin?.members ?? []) {
    if (granted.state !== 'removed' && !rows.has(granted.memberRef)) {
      rows.set(granted.memberRef, {
        memberRef: granted.memberRef,
        role: granted.role,
        state: granted.state,
        self: false,
        handle: null,
        displayName: null,
        admissionEpoch: granted.admissionEpoch
      })
    }
  }

  const collator = new Intl.Collator(locale, { sensitivity: 'base' })

  return [...rows.values()].sort(
    (left, right) =>
      RANK[left.role] - RANK[right.role] ||
      collator.compare(rosterName(left, ''), rosterName(right, ''))
  )
}

export interface InvitationRow {
  id: string
  targetHandle: string
  role: 'admin' | 'member'
  createdAt: number
  expiresAt: number
  inviter: { handle: string | null; displayName: string | null }
  /** The seven days ran out. The server applies expiry on every read; this is the same clock. */
  expired: boolean
}

/** Pending direct invitations, newest first. Terminal attempts are history, not a to-do. */
export function pendingInvitations(admin: CompanyAdminSnapshot13Response | undefined, nowSeconds: number): InvitationRow[] {
  return (admin?.invitations ?? [])
    .filter(invitation => invitation.state === 'pending')
    .map(invitation => ({
      id: invitation.id,
      targetHandle: invitation.targetHandle,
      role: invitation.role,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      inviter: invitation.inviter,
      expired: invitation.expiresAt <= nowSeconds
    }))
    .sort((left, right) => right.createdAt - left.createdAt)
}

/** Whole days left, never negative: "0" reads as "today". */
export const invitationDaysLeft = (expiresAt: number, nowSeconds: number) =>
  Math.max(0, Math.ceil((expiresAt - nowSeconds) / 86_400))

/* ------------------------------------------------------------------ 1.5: company DMs and group DMs */

export interface ConversationParticipantView {
  memberRef: string
  handle: string | null
  displayName: string | null
}

/**
 * One company conversation as the platform's directory lists it for this person. `readOnly` is the
 * platform's own state (a participant left the company, or a DM lost its other half): terminal for
 * this participant set, so the conversation keeps its history and takes no new messages.
 */
export interface CompanyConversationView {
  id: string
  companyId: string
  kind: 'dm' | 'group_dm'
  state: 'provisioning' | 'active' | 'read_only'
  participants: readonly ConversationParticipantView[]
  hidden: boolean
  room: MatrixCompanyRoom
  conversationGeneration: number
}

export function conversationViewFrom15(conversation: CompanyConversation15): CompanyConversationView {
  return {
    id: conversation.id,
    companyId: conversation.companyId,
    kind: conversation.kind,
    state: conversation.state,
    participants: conversation.participants.map(({ displayName, handle, memberRef }) => ({ memberRef, handle, displayName })),
    hidden: conversation.hidden,
    room: conversation.room,
    conversationGeneration: conversation.conversationGeneration
  }
}

const participantName = (participant: ConversationParticipantView, fallback: string) =>
  participant.displayName ?? (participant.handle ? `@${participant.handle}` : fallback)

/** The people other than the viewer: a DM is named for the one other person, a group for all the others. */
export function conversationPeople(view: Pick<CompanyConversationView, 'participants'>, selfMemberRef: string | undefined) {
  const others = view.participants.filter(participant => participant.memberRef !== selfMemberRef)

  // Before the viewer's own ref is known the whole set is shown rather than guessing who to leave out.
  return others.length > 0 ? others : view.participants
}

export function conversationTitle(
  view: Pick<CompanyConversationView, 'participants'>,
  selfMemberRef: string | undefined,
  fallback: string
): string {
  return conversationPeople(view, selfMemberRef)
    .map(participant => participantName(participant, fallback))
    .join(', ')
}

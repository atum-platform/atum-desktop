import type {
  CompanyCapabilities13Response,
  CompanyChannelAction14,
  CompanyChannelVisibility14,
  CompanyInviteReadiness,
  CompanyMembershipPolicy12,
  CompanyRole13
} from '../../../shared/matrix-company-team-space'

/**
 * What the server lets this person do, decided in one place. Every Team Space control asks this
 * module and nothing else: the server stays decisive (a refused action says so), but a control the
 * discovery or the person's role says cannot work is not drawn at all.
 *
 * "Old or unknown servers mean today's behaviour": no discovery, a 404/400 from a server that
 * predates it, or a failed read all resolve to the `legacy` profile, which is exactly the 1.1
 * client (admin-only invites and channel creation, company-wide channels, no roles, no privacy).
 * Privacy never widens: nothing below turns a missing answer into a permission.
 */

/** The discovery the client holds: not asked yet, an older server, or the server's own answer. */
export type TeamSpaceDiscovery =
  | { state: 'unknown' }
  | { state: 'legacy' }
  | { state: 'discovered'; capabilities: CompanyCapabilities13Response }

export const LEGACY_DISCOVERY: TeamSpaceDiscovery = { state: 'legacy' }

export interface TeamSpaceProfile {
  /** C1 (wire 1.3, invite links 1.2): single owner, roles, invitation attempts, policy. */
  admin: boolean
  /** C2 (wire 1.4): public and private channels, browse, admission. */
  channels: boolean
  /** The hosted room controller is ready, so a new admission can become a room. */
  rooms: boolean
  /** C3 (wire 1.5): company DMs and group DMs. Advertised only when the server's flags are on. */
  conversations: boolean
}

const NONE: TeamSpaceProfile = { admin: false, channels: false, rooms: false, conversations: false }

/** A feature button is drawn only when the server supports it AND this tenant has it active. */
export function teamSpaceProfile(discovery: TeamSpaceDiscovery): TeamSpaceProfile {
  if (discovery.state !== 'discovered') {
    return NONE
  }

  const { activation, controller, features, supportedWireVersions } = discovery.capabilities
  const speaks = (wire: string) => supportedWireVersions.includes(wire as never)

  return {
    admin: speaks('1.3') && features.ownership && features.invitationLifecycle && activation.teamAdmin === 'active',
    channels: speaks('1.4') && features.channelAdmission && activation.channelAdmission === 'active',
    rooms: controller.roomReconciliation === 'ready',
    // Both signals: the wire is named in the supported prefix, and the feature is on for this tenant.
    // A server that says either one is off has no "Direct messages" section and no 1.5 request is sent.
    conversations: speaks('1.5') && features.companyConversations && activation.companyConversations === 'active'
  }
}

export type CompanyChannelCreationPolicy = 'members' | 'admins_only'

/** The viewer's standing in one company. `role` is `owner` only on the 1.3 projection. */
export interface CompanyStanding {
  role: CompanyRole13
  policy: CompanyChannelCreationPolicy
  /** Who may invite (company policy 1.2); undefined when the server did not say, which keeps invites to owners and admins. */
  invitations?: CompanyMembershipPolicy12
}

const isModerator = (role: CompanyRole13) => role === 'owner' || role === 'admin'

export interface CompanyAbilities {
  /** The Add people sheet (by handle at least). Owners and admins; every member too when policy 1.2 says `members`. */
  invite: boolean
  /** Inviting someone as an admin is the owner's alone. */
  inviteAdmin: boolean
  /** Picking anyone the people directory found (1.10), not only an exact handle. */
  inviteDirectory: boolean
  /** Inviting one email address (1.9), only when the server says email creation is ready. */
  inviteEmail: boolean
  /** Making a share link. Revoking one stays with owners and admins. */
  inviteLink: boolean
  /**
   * The install serves direct add (invites 3 says `directAdd: ready`). Whether this viewer may add in a company is the
   * company's own readiness read (`allowed` / `invite_only` / `not_allowed`), never this flag alone.
   */
  directAdd: boolean
  /** The mail state of an email invitation can be read (invites 2 or later), so the sheet says queued / sent / failed. */
  mailStatus: boolean
  revokeInviteLink: boolean
  changeRoles: boolean
  transferOwnership: boolean
  editPolicy: boolean
  /** Creating a channel at all (legacy: admins; 1.4: the policy, once the controller is ready). */
  createChannel: boolean
  /** Private channels exist only when channel admission is active. */
  createPrivateChannel: boolean
  browseChannels: boolean
  /** Why creation is unavailable, for the one honest line in the browser. */
  creationBlocked: 'none' | 'restricted' | 'rooms'
}

const NO_COMPANY: CompanyAbilities = {
  invite: false,
  inviteAdmin: false,
  inviteDirectory: false,
  inviteEmail: false,
  inviteLink: false,
  directAdd: false,
  mailStatus: false,
  revokeInviteLink: false,
  changeRoles: false,
  transferOwnership: false,
  editPolicy: false,
  createChannel: false,
  createPrivateChannel: false,
  browseChannels: false,
  creationBlocked: 'none'
}

/**
 * `readiness` is company-invites/1, 2 or 3: undefined for a server that predates it, which keeps today's methods
 * (directory and link for owners and admins, no email). Ready only widens what policy and role already allow.
 */
export function companyAbilities(
  profile: TeamSpaceProfile,
  standing: CompanyStanding | undefined,
  readiness?: CompanyInviteReadiness
): CompanyAbilities {
  if (!standing) {
    return NO_COMPANY
  }

  const { policy, role } = standing
  const moderator = isModerator(role)
  // Slack and Mattermost let members invite unless an admin restricts it; 1.2 says which this company chose.
  const invite = moderator || (profile.admin && standing.invitations === 'members')
  const admin = profile.admin && invite
  // The 1.1 projection knows admin and member only; the owner of a 1.3 company is an admin there.
  const creationOpen = profile.channels ? policy === 'members' || moderator : moderator
  const createChannel = creationOpen && (!profile.channels || profile.rooms)

  return {
    invite,
    inviteAdmin: profile.admin && role === 'owner',
    inviteDirectory: readiness ? admin && readiness.directoryInvite === 'ready' : profile.admin && moderator,
    inviteEmail: Boolean(readiness) && admin && readiness?.emailCreation === 'ready',
    inviteLink: readiness ? admin && readiness.inviteLink === 'ready' : profile.admin && moderator,
    directAdd: profile.admin && readiness?.schemaVersion === 3 && readiness.directAdd === 'ready',
    mailStatus: Boolean(readiness) && admin && readiness!.schemaVersion >= 2 && readiness!.emailCreation === 'ready',
    revokeInviteLink: profile.admin && moderator,
    changeRoles: profile.admin && role === 'owner',
    transferOwnership: profile.admin && role === 'owner',
    editPolicy: profile.admin && moderator,
    createChannel,
    createPrivateChannel: profile.channels && createChannel,
    browseChannels: profile.channels,
    creationBlocked: createChannel ? 'none' : creationOpen ? 'rooms' : 'restricted'
  }
}

export interface MemberTarget {
  memberRef: string
  role: CompanyRole13
  state: 'active' | 'revoking' | 'invited'
  self: boolean
}

export interface MemberAbilities {
  makeAdmin: boolean
  makeMember: boolean
  makeOwner: boolean
  remove: boolean
  /** Leave the company. The owner leaves only after handing the company over. */
  leave: boolean
  /** The owner cannot leave: the reason is offered instead of a button that can only fail. */
  leaveBlockedByOwnership: boolean
}

const NO_MEMBER: MemberAbilities = {
  makeAdmin: false,
  makeMember: false,
  makeOwner: false,
  remove: false,
  leave: false,
  leaveBlockedByOwnership: false
}

/**
 * What the viewer may do to one roster row. Rank grants authority over people below it only: an
 * admin cannot touch the owner or another admin, and nobody changes the owner's role (ownership
 * moves by the explicit transfer).
 */
export function memberAbilities(
  profile: TeamSpaceProfile,
  viewer: CompanyRole13 | undefined,
  target: MemberTarget,
  activeMembers: number
): MemberAbilities {
  if (!viewer || target.state === 'revoking') {
    return NO_MEMBER
  }

  if (target.self) {
    const owner = target.role === 'owner'
    const alone = activeMembers <= 1

    return {
      ...NO_MEMBER,
      // An owner with other people in the company must hand it over first; alone, leaving retires it.
      leave: target.state === 'active' && (!owner || alone),
      leaveBlockedByOwnership: target.state === 'active' && owner && !alone
    }
  }

  if (target.state !== 'active') {
    return NO_MEMBER
  }

  const owner = viewer === 'owner'
  const targetRank = target.role

  // Before C1 an admin removes any other member (the server still protects the last admin); with it,
  // rank decides: the owner removes admins and members, an admin only members, nobody the owner.
  const remove = profile.admin
    ? owner
      ? targetRank !== 'owner'
      : viewer === 'admin' && targetRank === 'member'
    : viewer === 'admin' || owner

  return {
    ...NO_MEMBER,
    makeAdmin: profile.admin && owner && targetRank === 'member',
    makeMember: profile.admin && owner && targetRank === 'admin',
    makeOwner: profile.admin && owner,
    remove
  }
}

export interface InvitationAbilities {
  cancel: boolean
  resend: boolean
}

/** The owner manages every pending invitation; an admin only the member invitations. */
export function invitationAbilities(
  profile: TeamSpaceProfile,
  viewer: CompanyRole13 | undefined,
  invitationRole: 'admin' | 'member'
): InvitationAbilities {
  const allowed = profile.admin && Boolean(viewer) && (viewer === 'owner' || (viewer === 'admin' && invitationRole === 'member'))

  return { cancel: allowed, resend: allowed }
}

/** The facts about one channel the abilities depend on. */
export interface ChannelFacts {
  systemKey?: 'default'
  visibility: CompanyChannelVisibility14
  state: 'provisioning' | 'active' | 'archived'
  /** The server's own list of what this admitted person may do; null on the 1.1 wire. */
  actions: readonly CompanyChannelAction14[] | null
  /** The viewer created the channel (its immutable owner). */
  ownedByViewer: boolean
}

export interface ChannelAbilities {
  leave: boolean
  archive: boolean
  restore: boolean
  edit: boolean
  addPeople: boolean
  removeMembers: boolean
  /** The member list is read by the channel's owner and the company's owner and admins only. */
  seeMembers: boolean
}

export const NO_CHANNEL_ABILITIES: ChannelAbilities = {
  leave: false,
  archive: false,
  restore: false,
  edit: false,
  addPeople: false,
  removeMembers: false,
  seeMembers: false
}

/**
 * Channel controls come from the server's `actions` for this admitted person, narrowed by the
 * contract's own rules: `#general` is public, auto-joined and can be neither left nor archived;
 * only a private channel is joined by invitation; an archived channel changes nothing but restore.
 */
export function channelAbilities(
  profile: TeamSpaceProfile,
  viewer: CompanyRole13 | undefined,
  channel: ChannelFacts
): ChannelAbilities {
  if (!profile.channels || !channel.actions) {
    return NO_CHANNEL_ABILITIES
  }

  const can = (action: CompanyChannelAction14) => channel.actions!.includes(action)
  const archived = channel.state === 'archived'
  const protectedDefault = channel.systemKey === 'default'

  return {
    leave: can('leave') && !protectedDefault && !archived,
    archive: can('archive') && !protectedDefault && !archived,
    restore: can('restore') && archived,
    edit: can('update_metadata'),
    addPeople: can('invite') && channel.visibility === 'private' && !archived && profile.rooms,
    removeMembers: can('remove') && !protectedDefault && !archived,
    seeMembers: Boolean(viewer) && (channel.ownedByViewer || viewer === 'owner' || viewer === 'admin')
  }
}

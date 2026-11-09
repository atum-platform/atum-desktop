import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom } from '../../../shared/matrix'
import type {
  MatrixCompanyBridge,
  MatrixCompanyMember11,
  MatrixCompanyRequest,
  MatrixCompanyResult
} from '../../../shared/matrix-company'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../../shared/matrix-company-channel-room'
import type {
  CompanyAdminSnapshot13Response,
  CompanyCapabilities13Response,
  CompanyChannelAction14,
  CompanyChannelAdmittedSnapshot14,
  CompanyConversation15,
  CompanyEmailMailStatus,
  CompanyInviteReadiness,
  CompanyMemberAddReadiness112Response
} from '../../../shared/matrix-company-team-space'
import { $companySpacePreferences } from '../company-space-store'
import { MatrixCompanyWorkspace } from '../company-workspace'

import { clearCompanyAdmin } from './admin-store'
import { clearCompanyChannels } from './channels-store'
import { clearCompanyConversations, clearCompanySelfRefs } from './conversations-store'
import { clearTeamSpaceDiscovery } from './discovery-store'
import { resetCompanyInviteInbox } from './invite-inbox'
import { $matrixInviteJoinRequest } from './invite-join'

/**
 * A scripted platform for the Team Space tests: the 1.1 company and roster, the discovery answer,
 * the 1.3 administration snapshot and the 1.4 channel directory, with every mutation recorded.
 * Answers are the frozen wire shapes, so a screen under test sees what a deployed platform sends.
 */
export const COMPANY_ID = '00000000-0000-4000-8000-72805976e3a7'
export const REFS = {
  owner: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  admin: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  member: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
  other: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ'
}
export const CHANNEL_IDS = {
  general: '00000000-0000-4000-8000-f19cafd05964',
  ops: '00000000-0000-4000-8000-266cf79454ab',
  leadership: '00000000-0000-4000-8000-be9a925bf429',
  old: '00000000-0000-4000-8000-38fdf4747966',
  xam: '00000000-0000-4000-8000-64fb6f26b8db'
}

export type Viewer = 'owner' | 'admin' | 'member'
/** `inactive`: discovery answers but neither family is on. `missing`: a server that predates discovery. */
export type Discovery = 'full' | 'admin-only' | 'channels-only' | 'inactive' | 'missing' | 'unavailable'

const NAMES: Record<keyof typeof REFS, { handle: string; displayName: string }> = {
  owner: { handle: 'minh', displayName: 'Minh' },
  admin: { handle: 'bao', displayName: 'Bảo' },
  member: { handle: 'lan_nguyen', displayName: 'Lan Nguyễn' },
  other: { handle: 'tu', displayName: 'Tú' }
}

/**
 * `conversations`: the server has company-workspace 1.5 on: it names the wire, flags the feature and activates it. Left
 * `false` (the default) the answer is today's 1.4 server, exactly as before 1.5 existed.
 */
export const capabilities = (
  discovery: Discovery,
  rooms: 'ready' | 'not_ready' = 'ready',
  conversations: boolean | 'wire-only' = false
): CompanyCapabilities13Response => ({
  schemaVersion: 4,
  wireVersion: '1.3',
  supportedWireVersions: conversations ? ['1', '1.1', '1.2', '1.3', '1.4', '1.5'] : ['1', '1.1', '1.2', '1.3', '1.4'],
  features: {
    ownership: true,
    invitationLifecycle: true,
    capabilityDiscovery: true,
    channelAdmission: true,
    companyConversations: conversations === true
  },
  activation: {
    teamAdmin: discovery === 'full' || discovery === 'admin-only' ? 'active' : 'inactive',
    channelAdmission: discovery === 'full' || discovery === 'channels-only' ? 'active' : 'inactive',
    companyConversations: conversations === true ? 'active' : 'inactive'
  },
  controller: { roomReconciliation: rooms }
})

export interface ScriptedChannel {
  id: string
  name: string
  visibility?: 'public' | 'private'
  state?: 'active' | 'archived' | 'provisioning'
  systemKey?: 'default'
  topic?: string
  purpose?: string
  actions?: CompanyChannelAction14[]
  ownerRef?: string
  memberCount?: number
  generation?: number
  admissionGeneration?: number
  admission?: 'active' | 'invited'
  ready?: boolean
}

/** A company DM or group DM in the scripted directory. `others` are the people besides the viewer. */
export interface ScriptedConversation {
  id: string
  others: Array<keyof typeof REFS>
  state?: 'active' | 'read_only' | 'provisioning'
  hidden?: boolean
  /** The room is not made yet. */
  ready?: boolean
}

export const CONVERSATION_IDS = {
  dm: '00000000-0000-4000-8000-f6c6b8bb709f',
  group: '00000000-0000-4000-8000-8a4e23bab81e',
  third: '00000000-0000-4000-8000-f9ae298d66d3',
  next: (index: number) => `15000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`
}

/** The Matrix room id a scripted conversation lives in. */
export const conversationRoomId = (conversationId: string) => `!c${conversationId.slice(-3)}:atum.example`

/** A company the directory lists; by default there is the one, `Atum Studio`. */
export interface ScriptedCompany {
  id: string
  displayName: string
  role?: 'admin' | 'member'
}

export const OTHER_COMPANY_ID = '00000000-0000-4000-8000-4ddf7748f9cd'

export interface Script {
  /** The companies the directory lists; the scripted people, channels and links belong to whichever is asked about. */
  companies: ScriptedCompany[]
  /** Whether the directory says this person may create another company. */
  canCreate: boolean
  viewer: Viewer
  discovery: Discovery
  rooms: 'ready' | 'not_ready'
  policy: 'members' | 'admins_only'
  members: Array<{ key: keyof typeof REFS; role: 'owner' | 'admin' | 'member'; state?: 'active' | 'revoking' | 'invited' }>
  invitations: CompanyAdminSnapshot13Response['invitations']
  channels: ScriptedChannel[]
  /** Whether the server has company-workspace 1.5 on (named, flagged and activated). Off by default. */
  conversationsOn: boolean | 'wire-only'
  conversations: ScriptedConversation[]
  /** What the platform answers to a mutation; defaults to a valid receipt. */
  mutations: Partial<Record<string, (input: MatrixCompanyRequest) => MatrixCompanyResult>>
  links: Array<{ id: string; uses: number; maxUses: number; expiresAt: number }>
  authorityGeneration: number
  /**
   * Company policy 1.2 (who may invite). Unset is a server before #794: the 1.2 read is refused (400) and the
   * workspace keeps the 1.3 snapshot, so only owners and admins invite.
   */
  invitePolicy?: 'members' | 'admins'
  /**
   * Invite readiness (company-invites/1, 2 or 3). The server answers its own profile and refuses a newer one (400), as a
   * real one does. Unset is a server before #794: every readiness read is refused (400).
   */
  inviteReadiness?: CompanyInviteReadiness
  /** Company policy 1.3 (who may add directly). Unset is a server before #801: the 1.3 read is refused (400). */
  directMemberAdd?: 'members' | 'admins'
  /** The 1.12 readiness for the viewer. Unset is a server before #801: the read answers 404. */
  memberAdd?: Pick<CompanyMemberAddReadiness112Response, 'directAdd'> & Partial<CompanyMemberAddReadiness112Response>
  /** The mail state each email invitation reads as (invites 2); `queued` when unnamed. */
  mailStatus?: CompanyEmailMailStatus
}

export function script(over: Partial<Script> = {}): Script {
  const { mutations = {}, ...data } = {
    companies: [{ id: COMPANY_ID, displayName: 'Atum Studio' }],
    canCreate: false,
    viewer: 'owner' as const,
    discovery: 'full' as const,
    rooms: 'ready' as const,
    policy: 'members' as const,
    members: [
      { key: 'owner' as const, role: 'owner' as const },
      { key: 'admin' as const, role: 'admin' as const },
      { key: 'member' as const, role: 'member' as const }
    ],
    invitations: [],
    channels: [{ id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }],
    conversationsOn: false as boolean | 'wire-only',
    conversations: [] as ScriptedConversation[],
    mutations: {},
    links: [],
    authorityGeneration: 7,
    ...over
  }

  // A scenario owns its data: a handler that archives a channel must not archive it for the next test.
  return { ...structuredClone(data), mutations }
}

/** What a server holding a newer readiness profile answers to an older one. */
function downgradeReadiness(held: CompanyInviteReadiness, asked: number): CompanyInviteReadiness {
  const { directAdd: _directAdd, ...profile2 } = { directAdd: undefined, ...held }

  if (asked === 2) {
    return { ...profile2, schemaVersion: 2 } as CompanyInviteReadiness
  }

  return { schemaVersion: 1, directoryInvite: held.directoryInvite, emailCreation: held.emailCreation, inviteLink: held.inviteLink,
    emailInvite: held.emailCreation === 'ready' ? 'delivery_unavailable' : held.emailCreation, emailDelivery: 'not_implemented',
    emailAutoClaim: held.emailAutoClaim }
}

const viewerKey = (viewer: Viewer): keyof typeof REFS => (viewer === 'owner' ? 'owner' : viewer === 'admin' ? 'admin' : 'member')

/** The listed company a request is about; the first when it names none. */
const companyOf = (state: Script, companyId: string | undefined): ScriptedCompany =>
  state.companies.find(company => company.id === companyId) ?? state.companies[0] ?? { id: COMPANY_ID, displayName: 'Atum Studio' }

const roleOf = (state: Script, company: ScriptedCompany): 'admin' | 'member' =>
  company.role ?? (state.viewer === 'member' ? 'member' : 'admin')

export function scriptedAdmin(state: Script, companyId?: string): CompanyAdminSnapshot13Response {
  const listed = companyOf(state, companyId)

  return {
    schemaVersion: 4,
    company: {
      id: listed.id,
      displayName: listed.displayName,
      role: state.viewer,
      ownerMemberRef: REFS.owner,
      authorityGeneration: state.authorityGeneration,
      policy: { channelCreation: state.policy }
    },
    members: state.members
      .filter(member => member.state !== 'invited')
      .map((member, index) => ({
        memberRef: REFS[member.key],
        role: member.role,
        state: member.state === 'revoking' ? ('revoking' as const) : ('active' as const),
        admissionEpoch: index + 1
      })),
    invitations: state.invitations
  }
}

export function scriptedRoster11(state: Script): MatrixCompanyMember11[] {
  const self = viewerKey(state.viewer)

  return state.members.map(member => ({
    memberRef: REFS[member.key],
    // The 1.1 projection knows admin and member only: the owner reads as an admin there.
    role: member.role === 'member' ? ('member' as const) : ('admin' as const),
    state: member.state ?? 'active',
    self: member.key === self,
    handle: NAMES[member.key].handle,
    displayName: NAMES[member.key].displayName
  }))
}

function admitted(channel: ScriptedChannel, state: Script): CompanyChannelAdmittedSnapshot14 {
  const visibility = channel.visibility ?? 'public'

  return {
    schemaVersion: 5,
    channel: {
      id: channel.id,
      companyId: COMPANY_ID,
      displayName: channel.name,
      visibility,
      topic: channel.topic ?? '',
      purpose: channel.purpose ?? '',
      state: channel.state ?? 'active',
      ownerMemberRef: channel.ownerRef ?? REFS.owner,
      ...(channel.systemKey ? { systemKey: channel.systemKey } : {}),
      authorityGeneration: state.authorityGeneration,
      channelGeneration: channel.generation ?? 7,
      metadataRevision: 1
    },
    selfAdmission: {
      memberRef: REFS[viewerKey(state.viewer)],
      state: channel.admission ?? 'active',
      admissionEpoch: 1,
      admissionGeneration: channel.admissionGeneration ?? 4
    },
    memberCount: channel.memberCount ?? 3,
    room:
      channel.ready === false || channel.admission === 'invited'
        ? { state: 'provisioning', roomId: null }
        : { state: 'ready', roomId: `!${channel.name}:atum.example` },
    actions: channel.actions ?? ['leave', 'invite', 'update_metadata', 'archive']
  }
}

const NAMES_BY_REF = (ref: string) => Object.entries(REFS).find(([, value]) => value === ref)?.[0] as keyof typeof REFS | undefined

function wireConversation(conversation: ScriptedConversation, state: Script, companyId = COMPANY_ID): CompanyConversation15 {
  const refs = [...new Set([REFS[viewerKey(state.viewer)], ...conversation.others.map(key => REFS[key])])].sort()
  const ready = conversation.ready !== false && (conversation.state ?? 'active') !== 'provisioning'

  return {
    id: conversation.id,
    companyId,
    kind: refs.length === 2 ? 'dm' : 'group_dm',
    state: conversation.state ?? (ready ? 'active' : 'provisioning'),
    participants: refs.map((ref, index) => {
      const key = NAMES_BY_REF(ref)!

      return { memberRef: ref, admissionEpoch: index + 1, handle: NAMES[key].handle, displayName: NAMES[key].displayName }
    }),
    participantSetDigest: '0'.repeat(64),
    authorityGeneration: state.authorityGeneration,
    conversationGeneration: 1,
    room: ready ? { state: 'ready', roomId: conversationRoomId(conversation.id) } : { state: 'provisioning', roomId: null },
    hidden: conversation.hidden ?? false
  }
}

/** The scripted conversation with exactly these people (the viewer included), if the directory has one. */
function conversationWith(state: Script, refs: readonly string[]): ScriptedConversation | undefined {
  const wanted = [...new Set(refs)].sort().join()

  return state.conversations.find(conversation =>
    [...new Set([REFS[viewerKey(state.viewer)], ...conversation.others.map(key => REFS[key])])].sort().join() === wanted)
}

export interface Platform {
  state: Script
  bridge: MatrixCompanyBridge
  request: ReturnType<typeof vi.fn>
  /** Every request, in order, minus the ones a screen makes silently (reads). */
  mutations(): MatrixCompanyRequest[]
  calls(action: string): MatrixCompanyRequest[]
}

const READS = new Set(['capabilities', 'invite-readiness', 'administration', 'administration-policy', 'member-add-readiness',
  'email-invitation-status', 'invite-links', 'browse-channels', 'browse-joinable-channels', 'admitted-channels',
  'read-admitted-channel', 'channel-members', 'invite-link-preview', 'conversations', 'read-conversation',
  'list', 'read', 'list-channels', 'read-channel', 'wallet'])

export function platform(over: Partial<Script> = {}, hooks: {
  pending?: MatrixCompanyBridge['pending']
  uploadAvatar?: NonNullable<MatrixCompanyBridge['uploadAvatar']>
  avatar?: NonNullable<MatrixCompanyBridge['avatar']>
  browse?: unknown
  joinableBrowse?: unknown
  members?: unknown
} = {}): Platform {
  const state = script(over)

  const answer = (input: MatrixCompanyRequest): MatrixCompanyResult => {
    const custom = state.mutations[input.action]

    if (custom) {
      return custom(input)
    }

    switch (input.action) {
      case 'capabilities':
        if (state.discovery === 'missing') {return { ok: false, error: 'missing' }}

        if (state.discovery === 'unavailable') {return { ok: false, error: 'unavailable' }}

        return { ok: true, value: capabilities(state.discovery, state.rooms, state.conversationsOn) }

      case 'administration':
        return { ok: true, value: scriptedAdmin(state, input.companyId) }

      case 'administration-policy': {
        if (!state.invitePolicy || (input.profile === '1.3' && !state.directMemberAdd)) {return { ok: false, error: 'invalid' }}

        const admin = scriptedAdmin(state, input.companyId)

        return { ok: true, value: { ...admin, company: { ...admin.company, policy: { channelCreation: state.policy,
          publicChannelMembership: 'members', privateChannelMembership: 'members', companyInvitations: state.invitePolicy,
          ...(input.profile === '1.3' ? { directMemberAdd: state.directMemberAdd! } : {}) } } } }
      }

      case 'invite-readiness': {
        const held = state.inviteReadiness
        const asked = input.profile === undefined ? 1 : Number(input.profile)

        return held && held.schemaVersion >= asked
          ? { ok: true, value: asked === held.schemaVersion ? held : downgradeReadiness(held, asked) }
          : { ok: false, error: 'invalid' }
      }

      case 'member-add-readiness': {
        const held = state.memberAdd

        if (!held) {return { ok: false, error: 'missing' }}

        const roles = held.directAdd === 'not_allowed' ? [] : state.viewer === 'owner' ? ['member', 'admin'] as const : ['member'] as const

        return { ok: true, value: { schemaVersion: 12, companyId: input.companyId, policy: state.directMemberAdd ?? 'members',
          assignableRoles: [...roles], rosterRemaining: 97, ...held } }
      }

      case 'member-add':
        return input.target.kind === 'email'
          ? { ok: true, value: { schemaVersion: 12, outcome: 'invited', invitationId: '00000000-0000-4000-8000-d3c5fd5cac8c',
              expiresAt: 1_800_000_000 + 86_400 * 7, replayed: false } }
          : { ok: true, value: { schemaVersion: 12, outcome: 'added', companyId: input.companyId, memberRef: 'D'.repeat(43), role: input.role,
              invitationId: '00000000-0000-4000-8000-9ead0f7cb564', authorityGeneration: state.authorityGeneration + 1, replayed: false } }

      case 'email-invitation-status': {
        const mailStatus = state.mailStatus ?? 'queued'

        return { ok: true, value: { schemaVersion: 10, invitationId: input.invitationId, mailStatus,
          sentAt: mailStatus === 'sent' ? 1_800_000_100 : null, failure: mailStatus === 'failed' ? 'rejected' : null } }
      }

      case 'list':
        return { ok: true, value: { schemaVersion: 2, canCreate: state.canCreate, invitations: [],
          companies: state.companies.map(listed => ({ id: listed.id, displayName: listed.displayName, role: roleOf(state, listed), authorityGeneration: state.authorityGeneration })) } }

      case 'read': {
        const listed = companyOf(state, input.companyId)

        return { ok: true, value: { schemaVersion: 2, defaultChannelId: CHANNEL_IDS.general, projects: [],
          company: { id: listed.id, displayName: listed.displayName, role: roleOf(state, listed), authorityGeneration: state.authorityGeneration },
          members: scriptedRoster11(state) } }
      }

      case 'list-channels':
        return { ok: true, value: { schemaVersion: 2, channels: state.channels
          .filter(channel => (channel.visibility ?? 'public') === 'public' && (channel.admission ?? 'active') === 'active')
          .map(channel => ({ schemaVersion: 2 as const,
            channel: { id: channel.id, companyId: COMPANY_ID, displayName: channel.name, visibility: 'company' as const,
              state: channel.state ?? 'active', projectId: null, authorityGeneration: 1, channelGeneration: channel.generation ?? 7,
              ...(channel.systemKey ? { systemKey: channel.systemKey } : {}) },
            memberCount: channel.memberCount ?? 3,
            room: channel.ready === false ? { state: 'provisioning' as const, roomId: null } : { state: 'ready' as const, roomId: `!${channel.name}:atum.example` } })) } }

      case 'admitted-channels':
        return { ok: true, value: { schemaVersion: 5, channels: state.channels.map(channel => admitted(channel, state)) } }

      case 'read-admitted-channel': {
        const channel = state.channels.find(candidate => candidate.id === input.channelId)

        return channel ? { ok: true, value: admitted(channel, state) } : { ok: false, error: 'missing' }
      }

      case 'browse-channels':
        return { ok: true, value: hooks.browse ?? { schemaVersion: 5, channels: [] } } as MatrixCompanyResult

      case 'browse-joinable-channels':
        return hooks.joinableBrowse === undefined
          ? { ok: false, error: 'missing' }
          : { ok: true, value: hooks.joinableBrowse } as MatrixCompanyResult

      case 'channel-members':
        return { ok: true, value: hooks.members ?? { schemaVersion: 5, channelId: input.channelId, channelGeneration: 7, members: [] } } as MatrixCompanyResult

      case 'invite-links':
        return { ok: true, value: { schemaVersion: 3, links: state.links.map(link => ({ id: link.id, role: 'member' as const, state: 'active' as const,
          createdAt: 1_800_000_000, expiresAt: link.expiresAt, maxUses: link.maxUses, uses: link.uses })) } }

      case 'invite-link-create':
        // Each company's link reads differently, so a test can tell whose text is on screen.
        return { ok: true, value: { schemaVersion: 3, replayed: false, link: { id: '00000000-0000-4000-8000-05d9ec66b6d2', companyId: input.companyId,
          role: 'member' as const, state: 'active' as const, createdAt: 1_800_000_000, expiresAt: 1_800_000_000 + 86_400 * 7, maxUses: 10, uses: 0,
          url: `https://atum.app/j/${(input.companyId === COMPANY_ID ? 'A' : 'B').repeat(43)}` } } }

      case 'role-change':
        return { ok: true, value: { schemaVersion: 4, companyId: COMPANY_ID, memberRef: input.memberRef, role: input.role,
          ownerMemberRef: REFS.owner, authorityGeneration: state.authorityGeneration + 1, replayed: false } }

      case 'ownership-transfer':
        return { ok: true, value: { schemaVersion: 4, companyId: COMPANY_ID, previousOwnerMemberRef: REFS.owner,
          ownerMemberRef: input.targetMemberRef, previousOwnerRole: 'admin' as const, authorityGeneration: state.authorityGeneration + 1, replayed: false } }

      case 'policy-update':
        return { ok: true, value: { schemaVersion: 4, companyId: COMPANY_ID, policy: input.policy,
          authorityGeneration: state.authorityGeneration + 1, replayed: false } }

      case 'channel-command': {
        const { command } = input

        if (command.operation === 'create') {
          const existing = state.channels.find(channel => channel.name.toLocaleLowerCase('vi') === command.displayName.toLocaleLowerCase('vi'))
          const channelId = existing?.id ?? (command.displayName === 'xam' ? CHANNEL_IDS.xam : CHANNEL_IDS.ops)

          if (!existing) {
            state.channels.push({ id: channelId, name: command.displayName, visibility: command.visibility,
              topic: command.topic, purpose: command.purpose })
          }

          // Company channel command 1.1: the creator and every pick, all active at once.
          if ('initialMemberRefs' in command) {
            const admitted = [...new Set([REFS[viewerKey(state.viewer)], ...command.initialMemberRefs])].sort()

            return { ok: true, value: { schemaVersion: 6, operation: 'create', channelId, authorityGeneration: state.authorityGeneration,
              channelGeneration: 1, admissions: admitted.map(memberRef => ({ memberRef, state: 'active' as const, admissionEpoch: 1, admissionGeneration: 1 })),
              replayed: Boolean(existing) } }
          }

          return { ok: true, value: { schemaVersion: 5, operation: 'create', channelId,
            authorityGeneration: state.authorityGeneration, channelGeneration: 1, admission: null, replayed: Boolean(existing) } }
        }

        if (command.operation === 'add') {
          return { ok: true, value: { schemaVersion: 6, operation: 'add', channelId: input.channelId ?? CHANNEL_IDS.ops,
            authorityGeneration: state.authorityGeneration, channelGeneration: 8,
            admissions: [{ memberRef: command.memberRef, state: 'active' as const, admissionEpoch: 1, admissionGeneration: 1 }], replayed: false } }
        }

        if (command.operation === 'invite' || command.operation === 'decline' || command.operation === 'cancel') {
          return { ok: true, value: { schemaVersion: 5, replayed: false, channelGeneration: 8,
            invitation: { id: '00000000-0000-4000-8000-7d510ee23b52', channelId: input.channelId ?? CHANNEL_IDS.ops,
              memberRef: REFS.member, state: 'pending' as const, createdAt: 1_800_000_000, expiresAt: 1_800_604_800 } } }
        }

        return { ok: true, value: { schemaVersion: 5, operation: command.operation, channelId: input.channelId ?? CHANNEL_IDS.ops,
          authorityGeneration: state.authorityGeneration, channelGeneration: 8, admission: null, replayed: false } }
      }

      case 'conversations':
        return { ok: true, value: { schemaVersion: 6, conversations: state.conversations.map(item => wireConversation(item, state, input.companyId)) } }

      case 'set-avatar':
        return { ok: true, value: { schemaVersion: 8, operation: 'set_avatar', companyId: input.companyId,
          avatarUri: input.avatarUri, avatarRevision: 1, replayed: false } }

      case 'read-conversation': {
        const found = state.conversations.find(item => item.id === input.conversationId)

        return found ? { ok: true, value: { schemaVersion: 6, replayed: false, conversation: wireConversation(found, state, input.companyId) } } : { ok: false, error: 'missing' }
      }

      // The same people always open the same conversation, however often and in whatever order (1.5, "Atomic open").
      case 'conversation-open':
      case 'conversation-expand': {
        const existing = conversationWith(state, input.participantMemberRefs)

        const opened: ScriptedConversation = existing ?? {
          id: CONVERSATION_IDS.next(state.conversations.length + 1),
          others: input.participantMemberRefs
            .filter(ref => ref !== REFS[viewerKey(state.viewer)])
            .map(ref => NAMES_BY_REF(ref)!)
        }

        if (!existing) {state.conversations.push(opened)}

        return { ok: true, value: { schemaVersion: 6, replayed: Boolean(existing), conversation: wireConversation(opened, state, input.companyId) } }
      }

      case 'conversation-hidden': {
        const found = state.conversations.find(item => item.id === input.conversationId)

        if (!found) {return { ok: false, error: 'missing' }}

        found.hidden = input.hidden

        return { ok: true, value: { schemaVersion: 6, conversationId: found.id, hidden: input.hidden, replayed: false } }
      }

      case 'remove-member':
        return { ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, memberRef: input.memberRef, state: 'revoking' as const,
          authorityGeneration: state.authorityGeneration + 1 } }

      case 'create-channel': {
        const existing = state.channels.find(channel => channel.name.toLocaleLowerCase('vi') === input.displayName.toLocaleLowerCase('vi'))
        const channelId = existing?.id ?? (input.displayName === 'xam' ? CHANNEL_IDS.xam : CHANNEL_IDS.ops)

        if (!existing) {state.channels.push({ id: channelId, name: input.displayName })}

        return { ok: true, value: { schemaVersion: 2, channel: {
          id: channelId, companyId: input.companyId, displayName: input.displayName, visibility: 'company', state: 'active',
          projectId: input.projectId ?? null, authorityGeneration: state.authorityGeneration, channelGeneration: 1
        }, memberCount: state.members.length, room: { state: 'ready', roomId: `!${input.displayName}:atum.example` } } }
      }

      default:
        return { ok: false, error: 'unavailable' }
    }
  }

  const request = vi.fn(async (input: MatrixCompanyRequest) => answer(input))

  const bridge: MatrixCompanyBridge = {
    pending: hooks.pending ?? (async () => ({ ok: true as const, request: null })),
    request: request as MatrixCompanyBridge['request'],
    uploadAvatar: hooks.uploadAvatar ?? (async () => 'mxc://matrix.atum.app/company-logo'),
    avatar: hooks.avatar ?? (async () => null)
  }

  return {
    state,
    bridge,
    request,
    mutations: () => request.mock.calls.map(([input]) => input as MatrixCompanyRequest).filter(input => !READS.has(input.action)),
    calls: action => request.mock.calls.map(([input]) => input as MatrixCompanyRequest).filter(input => input.action === action)
  }
}

export class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

export function resetTeamSpace(): void {
  $matrixInviteJoinRequest.set(null)
  resetCompanyInviteInbox()
  clearTeamSpaceDiscovery()
  clearCompanyAdmin('account-a')
  clearCompanyChannels('account-a')
  clearCompanyConversations('account-a')
  clearCompanySelfRefs('account-a')
  $companySpacePreferences.set({})
  // The company last open is remembered on the device: one test's choice must not open the next one's.
  window.localStorage.clear()
}

function workspace(source: Platform, props: Partial<ComponentProps<typeof MatrixCompanyWorkspace>>, locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale as never}>
      <MatrixCompanyWorkspace accountKey="account-a" bridge={source.bridge} ensureDefaultChannels={false}
        onOpenChannel={vi.fn(async () => {})} overviewFallback {...props} />
    </I18nProvider>
  )
}

export function renderTeamSpace(
  source: Platform,
  props: Partial<ComponentProps<typeof MatrixCompanyWorkspace>> = {},
  locale = 'en'
) {
  return render(workspace(source, props, locale))
}

/** The same workspace again with other props: what a notification or an opened channel does to a running window. */
export function rerenderTeamSpace(
  view: ReturnType<typeof renderTeamSpace>,
  source: Platform,
  props: Partial<ComponentProps<typeof MatrixCompanyWorkspace>>
) {
  view.rerender(workspace(source, props))
}

/** The Matrix room of a directory channel, as a confirmed company channel the window holds. */
export function channelRoom(channelId: string, name: string, over: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id: `!${name}:atum.example`,
    name,
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_CHANNEL_TYPE,
    companyChannel: { companyId: COMPANY_ID, channelId },
    ...over
  }
}

/** The Matrix room of a directory conversation, as the window holds it: a company conversation, bound to its company. */
export function conversationRoom(conversationId: string, over: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id: conversationRoomId(conversationId),
    name: 'conversation',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    companyConversation: { companyId: COMPANY_ID, conversationId },
    ...over
  }
}

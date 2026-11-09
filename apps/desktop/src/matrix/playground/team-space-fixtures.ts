import type { MatrixMessage, MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge, MatrixCompanyMember11, MatrixCompanyRequest, MatrixCompanyResult } from '../../../shared/matrix-company'
import type { MatrixCompanyActivityItem } from '../../../shared/matrix-company-activity'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../../shared/matrix-company-channel-room'

/**
 * `?company=team`: a company on today's wire (1.4 channels with topics, 1.5 direct messages), for the
 * Slack-style Team Space layout. Channels: general, launch (the scenario's company room), design
 * with something unread, and a private one; a DM with Lan, one with Chi waiting, a group of three.
 * `?company=team2` also lists Beta Works, so the company menu's switching is drawn with no rail.
 */
export const TEAM_COMPANY_ID = '00000000-0000-4000-8000-2aaeca158aeb'
export const TEAM_COMPANY_B_ID = '00000000-0000-4000-8000-5c42c29ff6ed'
export const TEAM_PROJECT_ID = '00000000-0000-4000-8000-bd674f59504c'
export const TEAM_COS_USER_ID = '@chief-of-staff:atum.example'
export const TEAM_COMPANY_AVATAR_MXC = 'mxc://playground/atum-studio-logo'

const TEAM_COMPANY_AVATAR_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#16243a"/><path d="M48 18 78 74H64l-6-13H38l-6 13H18L48 18Zm0 22-6 12h12L48 40Z" fill="#f4f7fb"/><circle cx="74" cy="22" r="8" fill="#77a9ff"/></svg>'
)}`

const ME = '@minh:atum.chat'
const LAN = '@lan:example.invalid'
const QUAN = '@quan:example.invalid'
const CHI = '@chi:example.invalid'

const PLAYGROUND_NEW_CHANNEL = '00000000-0000-4000-8000-47f93d02c87b'

const REFS = {
  self: 'RiUVmyo5zEPwmNwDTzUkOZ9pssoNpuFAbofjwAsJyS8',
  lan: 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew',
  quan: 'DBmU8tVC5nRl7iK9TD1_HUAMix4-Oxfk7bPM6--O_T8',
  chi: 'Qb4yOWEGhKxrTtmzGJA-6CVFxwxjxoEvcX3R2mHddaU'
}

const PEOPLE = {
  self: { handle: 'minh', displayName: 'Minh' },
  lan: { handle: 'lan_nguyen', displayName: 'Lan Nguyễn' },
  quan: { handle: 'quan', displayName: 'Quân' },
  chi: { handle: 'chi', displayName: 'Chi' }
}

interface TeamChannel {
  id: string
  name: string
  roomId: string
  topic?: string
  /** The channel's description; general keeps the localized default line, leadership has none. */
  purpose?: string
  /** The channel's maker; the viewer unless said. */
  owner?: keyof typeof REFS
  visibility?: 'public' | 'private'
  systemKey?: 'default'
  memberCount: number
}

export function teamChannels(launchRoomId: string, launchChannelId: string): TeamChannel[] {
  return [
    { id: '00000000-0000-4000-8000-360ec2ee68dc', name: 'general', roomId: '!general-company:example.invalid', systemKey: 'default',
      topic: 'Cả công ty', memberCount: 4 },
    { id: '00000000-0000-4000-8000-dbe46f90abb1', name: 'xam', roomId: '!xam-company:example.invalid',
      topic: 'Chuyện linh tinh và những điều vui', memberCount: 4 },
    { id: launchChannelId, name: 'launch', roomId: launchRoomId, topic: 'Ra mắt 0.21 — lịch, việc còn lại, ai lo gì',
      purpose: 'Mọi việc cho bản 0.21: lịch phát hành, việc còn lại và ai lo phần nào.', owner: 'lan', memberCount: 4 },
    { id: '00000000-0000-4000-8000-2d83f6003672', name: 'design', roomId: '!design-company:example.invalid',
      purpose: 'Giao diện, trải nghiệm và bản vẽ trước khi code.', memberCount: 3 },
    { id: '00000000-0000-4000-8000-6fd6bdf737fb', name: 'leadership', roomId: '!leadership-company:example.invalid',
      visibility: 'private', memberCount: 2 }
  ]
}

interface TeamConversation {
  id: string
  roomId: string
  others: Array<keyof typeof REFS>
}

const CONVERSATIONS: TeamConversation[] = [
  { id: '00000000-0000-4000-8000-7983649001b9', roomId: '!dm-lan:example.invalid', others: ['lan'] },
  { id: '00000000-0000-4000-8000-db901737f0df', roomId: '!dm-chi:example.invalid', others: ['chi'] },
  { id: '00000000-0000-4000-8000-98cad33e982f', roomId: '!dm-group:example.invalid', others: ['lan', 'quan'] }
]

export function teamCompanyBridge(
  launchRoomId: string,
  launchChannelId: string,
  secondCompany = false,
  viewerRole: 'admin' | 'member' = 'admin'
): MatrixCompanyBridge {
  const company = { id: TEAM_COMPANY_ID, displayName: 'Atum Studio', role: viewerRole, authorityGeneration: 7 }
  const beta = { id: TEAM_COMPANY_B_ID, displayName: 'Beta Works', role: 'admin' as const, authorityGeneration: 1 }
  const companies = secondCompany ? [company, beta] : [company]
  const channels = teamChannels(launchRoomId, launchChannelId)

  const members: MatrixCompanyMember11[] = (Object.keys(REFS) as Array<keyof typeof REFS>).map(key => ({
    memberRef: REFS[key],
    role: key === 'self' ? viewerRole : ('member' as const),
    state: 'active' as const,
    self: key === 'self',
    ...PEOPLE[key]
  }))

  const projects = [{
    id: TEAM_PROJECT_ID,
    displayName: 'Release B',
    memberRefs: members.filter(member => member.state === 'active').map(member => member.memberRef),
    collaboration: 'not_provisioned' as const
  }]

  const admitted = (channel: TeamChannel) => ({
    schemaVersion: 5 as const,
    channel: {
      id: channel.id,
      companyId: TEAM_COMPANY_ID,
      displayName: channel.name,
      visibility: channel.visibility ?? ('public' as const),
      topic: channel.topic ?? '',
      purpose: channel.purpose ?? '',
      state: 'active' as const,
      ownerMemberRef: REFS[channel.owner ?? 'self'],
      ...(channel.systemKey ? { systemKey: channel.systemKey } : {}),
      authorityGeneration: 7,
      channelGeneration: 7,
      metadataRevision: 1,
      projectId: channel.name === 'launch' ? TEAM_PROJECT_ID : null
    },
    selfAdmission: { memberRef: REFS.self, state: 'active' as const, admissionEpoch: 1, admissionGeneration: 4 },
    memberCount: channel.memberCount,
    room: { state: 'ready' as const, roomId: channel.roomId },
    actions: ['leave' as const, 'invite' as const, 'update_metadata' as const, 'archive' as const]
  })

  const conversation = (item: TeamConversation) => {
    const refs = [REFS.self, ...item.others.map(key => REFS[key])].sort()

    return {
      id: item.id,
      companyId: TEAM_COMPANY_ID,
      kind: refs.length === 2 ? ('dm' as const) : ('group_dm' as const),
      state: 'active' as const,
      participants: refs.map((ref, index) => {
        const key = (Object.keys(REFS) as Array<keyof typeof REFS>).find(name => REFS[name] === ref)!

        return { memberRef: ref, admissionEpoch: index + 1, ...PEOPLE[key] }
      }),
      participantSetDigest: '0'.repeat(64),
      authorityGeneration: 7,
      conversationGeneration: 1,
      room: { state: 'ready' as const, roomId: item.roomId },
      hidden: false
    }
  }

  // `&teamAdmin=1`: the 1.3 admin profile with #794's invite readiness and who-may-invite policy, so the Add people
  // sheet draws every state. `&invitePolicy=admins`, `&email=off`, `&denied=1` (the platform refuses every Add) and
  // `&invited=1` (an invitation waits for the viewer, for the rail badge and the join banner) vary it.
  const search = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
  const teamAdmin = search.has('teamAdmin')
  const invitePolicy = search.get('invitePolicy') === 'admins' ? 'admins' : 'members'
  const emailOff = search.get('email') === 'off'
  const denied = search.has('denied')
  const invitedHere = search.has('invited')
  // `&directAdd=allowed|invite_only|not_allowed`: an install with direct add (invites 3, policy 1.3, wire 1.12) and this
  // viewer's readiness. `&addOutcome=` picks what an add answers (added by default; already_member, unknown_user,
  // roster_full, admins_only, owner_only_role, limited). `&mail=queued|sent|failed|cancelled`: an email invitation's mail state.
  const directAdd = search.get('directAdd') as 'allowed' | 'invite_only' | 'not_allowed' | null
  const addOutcome = search.get('addOutcome') ?? 'added'
  const mail = search.get('mail') as 'queued' | 'sent' | 'failed' | 'cancelled' | null
  const rosterRemaining = Number(search.get('room') ?? 93)
  const nowSeconds = Math.floor(NOW / 1000)

  const adminSnapshot = (withPolicy: boolean) => ({ schemaVersion: 4,
    company: { id: company.id, displayName: company.displayName, role: viewerRole === 'member' ? 'member' : 'owner', ownerMemberRef:
      viewerRole === 'member' ? REFS.lan : REFS.self, authorityGeneration: 7,
      policy: withPolicy ? { channelCreation: 'members', publicChannelMembership: 'members', privateChannelMembership: 'members',
        companyInvitations: invitePolicy, ...(directAdd ? { directMemberAdd: 'members' } : {}) } : { channelCreation: 'members' } },
    members: (Object.keys(REFS) as Array<keyof typeof REFS>).map((key, index) => ({ memberRef: REFS[key],
      role: (viewerRole === 'member' ? key === 'lan' : key === 'self') ? 'owner' : 'member', state: 'active', admissionEpoch: index + 1 })),
    invitations: [{ id: '00000000-0000-4000-8000-7983649001b9', companyId: company.id, targetHandle: 'bao_tran', role: 'member',
      state: 'pending', createdAt: nowSeconds - 86_400, expiresAt: nowSeconds + 6 * 86_400, inviter: { handle: 'minh', displayName: 'Minh' } }] })

  const answer = (input: MatrixCompanyRequest): MatrixCompanyResult => {
    const companyId = 'companyId' in input ? input.companyId : undefined
    const onBeta = companyId === beta.id

    if (teamAdmin) {
      switch (input.action) {
        case 'administration':
        case 'administration-policy':
          // Policy 1.3 only where direct add is on; elsewhere this server refuses the 1.3 read, as #794's does.
          if (input.action === 'administration-policy' && input.profile === '1.3' && !directAdd) {return { ok: false, error: 'invalid' }}

          return { ok: true, value: adminSnapshot(input.action === 'administration-policy') } as unknown as MatrixCompanyResult

        case 'invite-readiness':
          if (directAdd || mail) {
            if (input.profile === undefined) {break}

            const profile2 = { directoryInvite: 'ready', emailInvite: emailOff ? 'not_configured' : 'delivery_unavailable',
              emailCreation: emailOff ? 'not_configured' : 'ready', emailDelivery: 'not_configured', inviteLink: 'ready',
              emailAutoClaim: 'verification_required' } as const

            return { ok: true, value: input.profile === '3'
              ? { schemaVersion: 3, ...profile2, directAdd: directAdd ? 'ready' : 'inactive' }
              : { schemaVersion: 2, ...profile2 } } as MatrixCompanyResult
          }

          return { ok: true, value: { schemaVersion: 1, directoryInvite: 'ready', emailInvite: emailOff ? 'not_configured' : 'delivery_unavailable',
            emailCreation: emailOff ? 'not_configured' : 'ready', emailDelivery: 'not_implemented', inviteLink: 'ready',
            emailAutoClaim: 'verification_required' } }

        case 'member-add-readiness':
          return directAdd
            ? { ok: true, value: { schemaVersion: 12, companyId: input.companyId, directAdd, policy: 'members',
                assignableRoles: directAdd === 'not_allowed' ? [] : viewerRole === 'member' ? ['member'] : ['member', 'admin'], rosterRemaining } }
            : { ok: false, error: 'missing' }

        case 'member-add': {
          if (addOutcome === 'limited') {return { ok: false, error: 'limit', reason: 'member_add_limited' }}

          const base = { schemaVersion: 12, replayed: false } as const
          const value = addOutcome === 'already_member'
            ? { ...base, outcome: 'already_member', companyId: input.companyId, memberRef: REFS.lan }
            : addOutcome === 'unknown_user' ? { ...base, outcome: 'unknown_user' }
              : addOutcome === 'roster_full' ? { ...base, outcome: 'roster_full', limit: 100 }
                : addOutcome === 'admins_only' || addOutcome === 'owner_only_role' ? { ...base, outcome: 'not_allowed', reason: addOutcome }
                  : { ...base, outcome: 'added', companyId: input.companyId, memberRef: REFS.lan, role: input.role,
                      invitationId: globalThis.crypto.randomUUID(), authorityGeneration: 8 }

          return { ok: true, value } as MatrixCompanyResult
        }

        case 'email-invitation-status':
          return mail
            ? { ok: true, value: { schemaVersion: 10, invitationId: input.invitationId, mailStatus: mail,
                sentAt: mail === 'sent' ? nowSeconds : null, failure: mail === 'failed' ? 'rejected' : null } } as MatrixCompanyResult
            : { ok: false, error: 'missing' }

        case 'invite-links':
          return { ok: true, value: { schemaVersion: 3, links: [] } } as MatrixCompanyResult

        case 'invite-link-create':
          return { ok: true, value: { schemaVersion: 3, replayed: false, link: { id: '00000000-0000-4000-8000-05d9ec66b6d2',
            companyId: company.id, role: 'member', state: 'active', createdAt: nowSeconds, expiresAt: nowSeconds + 86_400 * 7, maxUses: 10,
            uses: 0, url: `https://atum.app/j/${'A'.repeat(43)}` } } } as MatrixCompanyResult

        case 'invitation-create-directory':
        case 'invitation-create':
          return (denied ? { ok: false, error: 'denied' } : { ok: true, value: { schemaVersion: input.action === 'invitation-create' ? 4 : 11,
            replayed: false, authorityGeneration: 7, invitation: { id: globalThis.crypto.randomUUID(), companyId: company.id,
              targetHandle: input.action === 'invitation-create' ? input.memberHandle.replace(/^@/u, '').toLowerCase() : null,
              role: input.role, state: 'pending', createdAt: nowSeconds, expiresAt: nowSeconds + 7 * 86_400,
              inviter: { handle: 'minh', displayName: 'Minh' } } } }) as MatrixCompanyResult

        case 'email-invitation-create':
          return { ok: true, value: { schemaVersion: 10, invitationId: globalThis.crypto.randomUUID(), state: 'accepted',
            mailStatus: 'accepted', expiresAt: nowSeconds + 7 * 86_400, replayed: false } }

        default:
          break
      }
    }

    switch (input.action) {
      case 'capabilities':
        return { ok: true, value: {
          schemaVersion: 4,
          wireVersion: '1.3',
          supportedWireVersions: ['1', '1.1', '1.2', '1.3', '1.4', '1.5'],
          features: { ownership: true, invitationLifecycle: true, capabilityDiscovery: true, channelAdmission: true,
            companyConversations: true },
          activation: { teamAdmin: teamAdmin ? 'active' : 'inactive', channelAdmission: 'active', companyConversations: 'active' },
          controller: { roomReconciliation: 'ready' }
        } } as MatrixCompanyResult

      case 'list':
        return { ok: true, value: { schemaVersion: 2, canCreate: true, companies, invitations: invitedHere
          ? [{ id: '00000000-0000-4000-8000-75701fd81641', companyId: '00000000-0000-4000-8000-5683b005addd', displayName: 'Moon Travel',
              role: 'member', inviter: { handle: 'chi', displayName: 'Chi' } }]
          : [] } }

      case 'read':
        return (onBeta
          ? { ok: true, value: { schemaVersion: 2, company: beta, members: [members[0]!], projects: [], defaultChannelId: null } }
          : { ok: true, value: { schemaVersion: 2, company, members, projects, defaultChannelId: channels[0]!.id } }) as MatrixCompanyResult

      case 'admitted-channels':
        return { ok: true, value: { schemaVersion: 5, channels: onBeta ? [] : channels.map(admitted) } } as MatrixCompanyResult
      case 'read-admitted-channel': {
        const channel = onBeta
          ? undefined
          : input.channelId === PLAYGROUND_NEW_CHANNEL
            ? { id: PLAYGROUND_NEW_CHANNEL, name: 'new', roomId: '!playground-new:atum.example', visibility: 'private' as const, memberCount: 1 }
            : channels.find(candidate => candidate.id === input.channelId)

        return (channel ? { ok: true, value: admitted(channel) } : { ok: false, error: 'missing' }) as MatrixCompanyResult
      }

      case 'conversations':
        return { ok: true, value: { schemaVersion: 6,
          conversations: onBeta ? [] : CONVERSATIONS.map(conversation) } } as MatrixCompanyResult
      case 'read-conversation': {
        const found = onBeta ? undefined : CONVERSATIONS.find(item => item.id === input.conversationId)

        return (found
          ? { ok: true, value: { schemaVersion: 6, replayed: false, conversation: conversation(found) } }
          : { ok: false, error: 'missing' }) as MatrixCompanyResult
      }

      case 'browse-channels':
        return { ok: true, value: { schemaVersion: 5, channels: [] } } as MatrixCompanyResult

      case 'browse-joinable-channels':
        return { ok: true, value: { schemaVersion: 7, channels: [] } } as MatrixCompanyResult
      case 'channel-command': {
        // Create a channel with its people: the new channel is admitted, and Chi's invitation is refused so the sheet's
        // partial-failure state can be looked at. Nothing is kept; the directory stays the fixture's.
        const { command } = input

        if (command.operation === 'create') {
          return { ok: true, value: { schemaVersion: 5, operation: 'create', channelId: PLAYGROUND_NEW_CHANNEL, authorityGeneration: 7,
            channelGeneration: 1, admission: { memberRef: REFS.self, state: 'active', admissionEpoch: 1, admissionGeneration: 1 },
            replayed: false } } as MatrixCompanyResult
        }

        if (command.operation === 'invite') {
          return (command.memberRef === REFS.chi
            ? { ok: false, error: 'conflict', reason: 'channel_invitation_unavailable' }
            : { ok: true, value: { schemaVersion: 5, replayed: false, channelGeneration: 2, invitation: {
              id: globalThis.crypto.randomUUID(), channelId: input.channelId, memberRef: command.memberRef, state: 'pending',
              createdAt: Math.floor(NOW / 1000), expiresAt: Math.floor(NOW / 1000) + 604_800 } } }) as MatrixCompanyResult
        }

        return { ok: false, error: 'unavailable' }
      }

      default:
        return { ok: false, error: 'unavailable' }
    }
  }

  return {
    pending: async () => ({ ok: true, request: null }),
    request: async input => answer(input),
    uploadAvatar: async () => TEAM_COMPANY_AVATAR_MXC,
    avatar: async roomId => ({ roomId, avatarMxc: TEAM_COMPANY_AVATAR_MXC, avatarUrl: TEAM_COMPANY_AVATAR_URL }),
    // The sidebar's search pill shows where search is wired; the fixture finds nothing.
    search: async input => ({ ok: true, value: { schemaVersion: 1, companyId: input.companyId, query: input.query,
      coverage: { eligibleRooms: 4, searchedRooms: 4, truncated: false }, results: [] } }),
    open: async () => ({ ok: true })
  }
}

const NOW = Date.now()
const minutes = (count: number) => NOW - count * 60_000

/** The window's rooms for the team company: every channel and conversation, bound to it. */
export function teamRooms(launch: MatrixRoom | undefined, launchRoomId: string, launchChannelId: string): MatrixRoom[] {
  const channelRooms = teamChannels(launchRoomId, launchChannelId).map((channel, index): MatrixRoom => {
    const base = channel.roomId === launchRoomId && launch ? launch : undefined

    return {
      ...(base ?? {}),
      id: channel.roomId,
      name: channel.name,
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: TEAM_COMPANY_ID, channelId: channel.id },
      roomAvatarMxc: TEAM_COMPANY_AVATAR_MXC,
      canInvite: true,
      createdAt: base?.createdAt ?? NOW - (12 - index) * 86_400_000,
      lastActiveAt: base?.lastActiveAt ?? minutes(30 + index * 40),
      ...(channel.name === 'design' ? { unread: true, unreadNotifications: 2 } : {})
    }
  })

  const conversationRooms = CONVERSATIONS.map((item, index): MatrixRoom => ({
    id: item.roomId,
    name: 'conversation',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    companyConversation: { companyId: TEAM_COMPANY_ID, conversationId: item.id },
    lastActiveAt: minutes(5 + index * 20),
    ...(item.others.join() === 'chi' ? { unread: true, unreadNotifications: 1, highlights: 1 } : {})
  }))

  return [...channelRooms, ...conversationRooms]
}

const said = (sender: string, id: string, body: string, minutesAgo: number, extra: Partial<MatrixMessage> = {}): MatrixMessage => ({
  id,
  sender,
  body,
  timestamp: minutes(minutesAgo),
  own: sender === ME,
  encrypted: false,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false,
  ...extra
})

/** What the direct messages hold when opened in the playground. */
export const TEAM_MESSAGES: Record<string, MatrixMessage[]> = {
  '!dm-lan:example.invalid': [
    said(LAN, '$dm-lan-1', 'Anh xem giúp em bản nháp email gửi khách hàng nhé?', 26 * 60),
    said(LAN, '$dm-lan-2', 'Em để trong kênh **#launch** rồi ạ.', 26 * 60 - 1),
    said(ME, '$dm-lan-3', 'Ok, sáng mai anh xem. Phần giá giữ nguyên nhé.', 25 * 60),
    said(LAN, '$dm-lan-4', 'Dạ, em sửa lại tiêu đề rồi:\n- Ngắn hơn\n- Có ngày ra mắt', 42, {
      reactions: [{ key: '👍', count: 1, own: true, senders: [ME] }]
    }),
    said(ME, '$dm-lan-5', 'Đẹp rồi, gửi đi em.', 40)
  ],
  '!dm-chi:example.invalid': [said(CHI, '$dm-chi-1', '@Minh anh duyệt giúp em hoá đơn tháng 10 với ạ.', 6)],
  '!dm-group:example.invalid': [
    said(QUAN, '$dm-group-1', 'Chiều nay họp nhanh 15 phút về biểu đồ cho nhà đầu tư nhé.', 90),
    said(LAN, '$dm-group-2', 'Em ok, 3 giờ được không?', 85),
    said(ME, '$dm-group-3', '3 giờ được.', 80)
  ]
}

export const TEAM_MEMBERS = [
  { userId: ME, name: 'Minh', membership: 'join' as const, canRemove: false },
  { userId: LAN, name: 'Lan Nguyễn', membership: 'join' as const, canRemove: true },
  { userId: QUAN, name: 'Quân', membership: 'join' as const, avatarMxc: 'mxc://playground/quan', canRemove: true },
  { userId: CHI, name: 'Chi', membership: 'join' as const, canRemove: true },
  { userId: TEAM_COS_USER_ID, name: 'Chief of Staff', membership: 'join' as const, canRemove: false }
]

/** Observed m.presence for the Team Space people, so every face that carries a dot draws one: Minh and
 * Quân online, Lan away, Chi on do-not-disturb. */
export const TEAM_PRESENCE = {
  users: [
    { userId: ME, state: 'online' as const, displayName: 'Minh' },
    { userId: LAN, state: 'away' as const, displayName: 'Lan Nguyễn' },
    { userId: QUAN, state: 'online' as const, displayName: 'Quân' },
    { userId: CHI, state: 'online' as const, displayName: 'Chi', status: { dnd: true, text: 'Focusing' } }
  ]
}

/** Team Space Activity for the playground: one unread mention in #design and an older thread reply, so the Activity
 * icon beside the company switcher shows its badge. */
export function teamActivity(): MatrixCompanyActivityItem[] {
  return [
    { companyId: TEAM_COMPANY_ID, roomId: '!design-company:example.invalid', eventId: '$playground-mention', kind: 'mention',
      body: '@Minh can you check the new channel sheet?', senderId: QUAN, senderName: 'Quân', sentAt: minutes(12), unread: true },
    { companyId: TEAM_COMPANY_ID, roomId: '!general-company:example.invalid', eventId: '$playground-reply', kind: 'thread_reply',
      body: 'Done, the dates are in.', senderId: LAN, senderName: 'Lan Nguyễn', sentAt: minutes(90), unread: false,
      threadRootId: '$playground-root' }
  ]
}

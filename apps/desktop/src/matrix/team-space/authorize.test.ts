import { describe, expect, it } from 'vitest'

import type { MatrixCompanyMutation } from '../../../shared/matrix-company'
import type { CompanyChannelAction14, CompanyRole13 } from '../../../shared/matrix-company-team-space'

import { companyAbilities, type CompanyChannelCreationPolicy, type TeamSpaceProfile } from './abilities'
import { mayStillSend, type SendingStanding, sendVerdict } from './authorize'
import type { CompanyChannelView, InvitationRow, RosterMember } from './views'

const COMPANY = '00000000-0000-4000-8000-72805976e3a7'
const OTHER_COMPANY = '00000000-0000-4000-8000-4ddf7748f9cd'
const REQUEST = '00000000-0000-4000-8000-24ec437dbdf3'
const INVITATION = '00000000-0000-4000-8000-2aaeca158aeb'
const CHANNEL = '00000000-0000-4000-8000-266cf79454ab'
const DEFAULT_CHANNEL = '00000000-0000-4000-8000-f19cafd05964'

const FULL: TeamSpaceProfile = { admin: true, channels: true, rooms: true, conversations: false }
const ref = (letter: string) => letter.repeat(43)

const member = (key: string, role: CompanyRole13, over: Partial<RosterMember> = {}): RosterMember => ({
  memberRef: ref(key), role, state: 'active', self: false, handle: key, displayName: key, ...over
})

const invitation = (role: 'admin' | 'member'): InvitationRow => ({
  id: INVITATION, targetHandle: 'x', role, createdAt: 1, expiresAt: 2, inviter: { handle: null, displayName: null }, expired: false
})

const channel = (over: Partial<CompanyChannelView> = {}): CompanyChannelView => ({
  id: CHANNEL, companyId: COMPANY, displayName: 'ops', visibility: 'public', state: 'active', topic: '', purpose: '', memberCount: 3,
  room: { state: 'ready', roomId: '!ops:test' }, projectId: null, channelGeneration: 1, wire: '1.4',
  admission: { memberRef: ref('v'), state: 'active', epoch: 1, generation: 1 },
  actions: ['leave', 'invite', 'remove', 'update_metadata', 'archive'], ...over
})

/** The standing of `role` in a company of an owner `o`, an admin `a`, a member `m`, and the viewer `v` (the viewer's own row). */
function standing(role: CompanyRole13 | undefined, over: Partial<SendingStanding> & { policy?: CompanyChannelCreationPolicy } = {}): SendingStanding {
  const { policy = 'members', ...rest } = over

  const roster = [
    member('o', 'owner'),
    member('a', 'admin'),
    member('m', 'member'),
    ...(role ? [member('v', role, { self: true })] : [])
  ]

  return {
    companyId: COMPANY,
    profile: FULL,
    viewerRole: role,
    abilities: companyAbilities(FULL, role ? { role, policy } : undefined),
    roster,
    invitations: [invitation('member')],
    channels: [channel()],
    ...rest
  }
}

const send = (mutation: Record<string, unknown>) => ({ companyId: COMPANY, requestId: REQUEST, ...mutation }) as MatrixCompanyMutation
const roleName = (role: CompanyRole13 | undefined) => role ?? 'unknown'

describe('what a change is checked against as it is sent', () => {
  it('does not deny an ordinary or self-service change it knows nothing about: an unknown standing, another company, a row it has not read', () => {
    expect(mayStillSend(send({ action: 'role-change', memberRef: ref('m'), role: 'admin', expectedAuthorityGeneration: 1 }), standing(undefined))).toBe(true)
    expect(mayStillSend(send({ action: 'invite-link-create', role: 'member' }), standing(undefined))).toBe(true)
    expect(mayStillSend(send({ action: 'role-change', companyId: OTHER_COMPANY, memberRef: ref('m'), role: 'admin', expectedAuthorityGeneration: 1 }), standing('member'))).toBe(true)
    expect(mayStillSend(send({ action: 'invitation-cancel', invitationId: '00000000-0000-4000-8000-3d2ed3af722e' }), standing('member'))).toBe(true)
    expect(mayStillSend(send({ action: 'channel-command', channelId: '00000000-0000-4000-8000-4b37da97c68d', command: { requestId: REQUEST, operation: 'update_metadata', expectedChannelGeneration: 1 } }), standing('member'))).toBe(true)
    expect(mayStillSend(send({ action: 'channel-command', channelId: '00000000-0000-4000-8000-4b37da97c68d', command: { requestId: REQUEST, operation: 'join' } }), standing('member'))).toBe(true)
    // The ones with no standing to lose.
    expect(mayStillSend(send({ action: 'accept', invitationId: INVITATION }), standing('member'))).toBe(true)
    expect(mayStillSend({ action: 'create', requestId: REQUEST, displayName: 'New' }, standing('member'))).toBe(true)
  })

  const UNKNOWN_CHANNEL = '00000000-0000-4000-8000-4b37da97c68d'
  const command = (operation: string, channelId = UNKNOWN_CHANNEL) =>
    send({ action: 'channel-command', channelId, command: { requestId: REQUEST, operation, expectedChannelGeneration: 1 } })

  it.each<[string, MatrixCompanyMutation]>([
    ['hand over ownership with no standing read', send({ action: 'ownership-transfer', targetMemberRef: ref('m'), expectedAuthorityGeneration: 1 })],
    ['remove a person with no standing read', send({ action: 'remove-member', memberRef: ref('m') })],
    ['leave the company with no standing read', send({ action: 'leave' })],
    ['archive a channel with no standing read', command('archive', CHANNEL)],
    ['leave a channel with no standing read', command('leave', CHANNEL)]
  ])('does not send what cannot be taken back on a guess: %s', (_name, mutation) => {
    expect(mayStillSend(mutation, standing(undefined))).toBe(false)
    expect(sendVerdict(mutation, standing(undefined))).toBe('unknown')
  })

  it('does not send a destructive change aimed at another company than the standing held, or at a target it has not read', () => {
    const owner = standing('owner')
    const other = send({ action: 'ownership-transfer', companyId: OTHER_COMPANY, targetMemberRef: ref('m'), expectedAuthorityGeneration: 1 })

    expect(sendVerdict(other, owner)).toBe('unknown')
    expect(sendVerdict(send({ action: 'remove-member', memberRef: ref('z') }), owner)).toBe('unknown')
    expect(sendVerdict(send({ action: 'leave' }), standing('owner', { roster: [member('o', 'owner')] }))).toBe('unknown')
    expect(sendVerdict(command('archive'), owner)).toBe('unknown')
    expect(sendVerdict(command('leave'), owner)).toBe('unknown')
    expect(sendVerdict(command('remove'), owner)).toBe('unknown')
    expect(sendVerdict(command('archive'), standing('owner', { channels: undefined }))).toBe('unknown')
  })

  it('still sends a destructive change whose authority and target are read and allowed, and says "changed" when they are not', () => {
    expect(sendVerdict(send({ action: 'ownership-transfer', targetMemberRef: ref('m'), expectedAuthorityGeneration: 1 }), standing('owner'))).toBe('allowed')
    expect(sendVerdict(send({ action: 'remove-member', memberRef: ref('m') }), standing('admin'))).toBe('allowed')
    expect(sendVerdict(command('archive', CHANNEL), standing('owner'))).toBe('allowed')
    expect(sendVerdict(send({ action: 'ownership-transfer', targetMemberRef: ref('m'), expectedAuthorityGeneration: 1 }), standing('admin'))).toBe('changed')
    expect(sendVerdict(send({ action: 'remove-member', memberRef: ref('o') }), standing('admin'))).toBe('changed')
  })

  it.each<[string, Record<string, unknown>, Array<CompanyRole13>]>([
    ['hand over ownership', { action: 'ownership-transfer', targetMemberRef: ref('m'), expectedAuthorityGeneration: 1 }, ['owner']],
    ['change a role', { action: 'role-change', memberRef: ref('m'), role: 'admin', expectedAuthorityGeneration: 1 }, ['owner']],
    ['set the channel-creation policy', { action: 'policy-update', policy: { channelCreation: 'admins_only' }, expectedAuthorityGeneration: 1 }, ['owner', 'admin']],
    ['invite a member by handle', { action: 'invitation-create', memberHandle: 'lan', role: 'member' }, ['owner', 'admin']],
    ['invite an admin by handle', { action: 'invitation-create', memberHandle: 'lan', role: 'admin' }, ['owner']],
    ['invite on the 1.1 wire', { action: 'invite', memberHandle: 'lan', role: 'member' }, ['owner', 'admin']],
    ['make an invite link', { action: 'invite-link-create', role: 'member' }, ['owner', 'admin']],
    ['revoke an invite link', { action: 'invite-link-revoke', linkId: '00000000-0000-4000-8000-05d9ec66b6d2' }, ['owner', 'admin']],
    ['remove an ordinary member', { action: 'remove-member', memberRef: ref('m') }, ['owner', 'admin']],
    ['remove an admin', { action: 'remove-member', memberRef: ref('a') }, ['owner']],
    ['remove the owner', { action: 'remove-member', memberRef: ref('o') }, []],
    ['cancel a member invitation', { action: 'invitation-cancel', invitationId: INVITATION }, ['owner', 'admin']],
    ['resend a member invitation', { action: 'invitation-resend', invitationId: INVITATION }, ['owner', 'admin']]
  ])('lets only the roles that may %s send it', (_name, mutation, allowed) => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(mayStillSend(send(mutation), standing(role)), `${roleName(role)} ${JSON.stringify(mutation.action)}`).toBe(allowed.includes(role))
    }
  })

  it('leaves an admin invitation to the owner', () => {
    const adminInvite = { invitations: [invitation('admin')] }

    expect(mayStillSend(send({ action: 'invitation-cancel', invitationId: INVITATION }), standing('admin', adminInvite))).toBe(false)
    expect(mayStillSend(send({ action: 'invitation-cancel', invitationId: INVITATION }), standing('owner', adminInvite))).toBe(true)
  })

  it('cancels a person invited and not yet joined for those who may invite, not for a member', () => {
    const invited = (role: CompanyRole13) => standing(role, { roster: [member('p', 'member', { state: 'invited' }), member('v', role, { self: true })] })
    const cancel = send({ action: 'remove-member', memberRef: ref('p') })

    expect(mayStillSend(cancel, invited('admin'))).toBe(true)
    expect(mayStillSend(cancel, invited('member'))).toBe(false)
  })

  it('lets a member or an admin leave', () => {
    const leave = send({ action: 'leave' })

    expect(mayStillSend(leave, standing('member'))).toBe(true)
    expect(mayStillSend(leave, standing('admin'))).toBe(true)
  })

  it('stops an owner who has company from leaving it, and lets one alone leave', () => {
    const owner = standing('owner', { roster: [member('v', 'owner', { self: true }), member('m', 'member')] })
    const alone = standing('owner', { roster: [member('v', 'owner', { self: true })] })

    expect(mayStillSend(send({ action: 'leave' }), owner)).toBe(false)
    expect(mayStillSend(send({ action: 'leave' }), alone)).toBe(true)
  })
})

describe('channel changes', () => {
  const command = (body: Record<string, unknown>, channelId: string | undefined = CHANNEL) =>
    send({ action: 'channel-command', ...(channelId ? { channelId } : {}), command: { requestId: REQUEST, ...body } })

  it('lets a member create a channel while everyone may, and not once creation is restricted to the owner and admins', () => {
    const create = command({ operation: 'create', displayName: 'ops', visibility: 'public' }, undefined)

    expect(mayStillSend(create, standing('member'))).toBe(true)
    expect(mayStillSend(create, standing('member', { policy: 'admins_only' }))).toBe(false)
    expect(mayStillSend(create, standing('admin', { policy: 'admins_only' }))).toBe(true)
  })

  it('refuses a private channel when private channels have gone, and any channel while rooms cannot be made', () => {
    const create = command({ operation: 'create', displayName: 'ops', visibility: 'private' }, undefined)
    const noPrivate = { profile: { admin: true, channels: false, rooms: true, conversations: false } }
    const noRooms = { profile: { admin: true, channels: true, rooms: false, conversations: false } }

    const under = (profile: TeamSpaceProfile) => ({
      profile, abilities: companyAbilities(profile, { role: 'owner', policy: 'members' })
    })

    expect(mayStillSend(create, standing('owner'))).toBe(true)
    expect(mayStillSend(create, standing('owner', under(noPrivate.profile)))).toBe(false)
    expect(mayStillSend(command({ operation: 'create', displayName: 'ops', visibility: 'public' }, undefined), standing('owner', under(noRooms.profile)))).toBe(false)
  })

  it.each<[string, Record<string, unknown>, CompanyChannelAction14[], boolean]>([
    ['leave', { operation: 'leave', expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }, ['leave'], true],
    ['leave', { operation: 'leave', expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }, ['update_metadata'], false],
    ['archive', { operation: 'archive', expectedChannelGeneration: 1 }, ['archive'], true],
    ['archive', { operation: 'archive', expectedChannelGeneration: 1 }, ['leave'], false],
    ['edit', { operation: 'update_metadata', expectedChannelGeneration: 1, topic: 'x' }, ['update_metadata'], true],
    ['edit', { operation: 'update_metadata', expectedChannelGeneration: 1, topic: 'x' }, ['leave'], false],
    ['remove a person', { operation: 'remove', memberRef: ref('m'), expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }, ['remove'], true],
    ['remove a person', { operation: 'remove', memberRef: ref('m'), expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }, ['leave'], false]
  ])('lets %s through only while the platform’s own list for this person has it (%j → %j)', (_name, body, actions, allowed) => {
    expect(mayStillSend(command(body), standing('owner', { channels: [channel({ actions })] }))).toBe(allowed)
  })

  it('lets someone be added to a private channel only, while the platform allows inviting', () => {
    const add = command({ operation: 'invite', memberRef: ref('m'), expectedChannelGeneration: 1 })

    expect(mayStillSend(add, standing('owner', { channels: [channel({ visibility: 'private' })] }))).toBe(true)
    expect(mayStillSend(add, standing('owner', { channels: [channel({ visibility: 'public' })] }))).toBe(false)
    expect(mayStillSend(add, standing('owner', { channels: [channel({ visibility: 'private', actions: ['leave'] })] }))).toBe(false)
  })

  it('lets nothing but a restore through on an archived channel, and never lets the default channel be left or archived', () => {
    const archived = standing('owner', { channels: [channel({ state: 'archived', actions: ['restore', 'archive', 'leave', 'update_metadata'] })] })

    expect(mayStillSend(command({ operation: 'restore', expectedChannelGeneration: 1 }), archived)).toBe(true)
    expect(mayStillSend(command({ operation: 'archive', expectedChannelGeneration: 1 }), archived)).toBe(false)
    expect(mayStillSend(command({ operation: 'leave', expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }), archived)).toBe(false)

    const general = standing('owner', { channels: [channel({ id: DEFAULT_CHANNEL, systemKey: 'default' })] })

    expect(mayStillSend(command({ operation: 'archive', expectedChannelGeneration: 1 }, DEFAULT_CHANNEL), general)).toBe(false)
    expect(mayStillSend(command({ operation: 'leave', expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 }, DEFAULT_CHANNEL), general)).toBe(false)
  })

  it('leaves joining and answering one’s own invitation to the platform', () => {
    for (const body of [
      { operation: 'join', expectedChannelGeneration: 1 },
      { operation: 'accept', expectedChannelGeneration: 1, expectedAdmissionGeneration: 1 },
      { operation: 'decline', invitationId: INVITATION, expectedChannelGeneration: 1 }
    ]) {
      expect(mayStillSend(command(body), standing('member', { channels: [channel({ actions: [] })] }))).toBe(true)
    }
  })
})

describe('conversation changes', () => {
  const ON: TeamSpaceProfile = { ...FULL, conversations: true }
  const CONVERSATION = '00000000-0000-4000-8000-f6c6b8bb709f'

  const changes: Array<[string, MatrixCompanyMutation]> = [
    ['open', send({ action: 'conversation-open', participantMemberRefs: [ref('o'), ref('v')] })],
    ['expand', send({ action: 'conversation-expand', sourceConversationId: CONVERSATION, participantMemberRefs: [ref('o'), ref('m'), ref('v')] })],
    ['hide', send({ action: 'conversation-hidden', conversationId: CONVERSATION, hidden: true })]
  ]

  it.each(changes)('%s: the person’s own for every role while company DMs are on, and not sent once they are switched off', (_name, mutation) => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(mayStillSend(mutation, standing(role, { profile: ON }))).toBe(true)
      // A rollback while a picker was open: nothing leaves the app.
      expect(mayStillSend(mutation, standing(role, { profile: FULL }))).toBe(false)
    }
  })
})

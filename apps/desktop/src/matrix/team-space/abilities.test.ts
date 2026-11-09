import { describe, expect, it } from 'vitest'

import type { CompanyCapabilities13Response, CompanyChannelAction14 } from '../../../shared/matrix-company-team-space'

import {
  channelAbilities,
  type ChannelFacts,
  companyAbilities,
  invitationAbilities,
  LEGACY_DISCOVERY,
  memberAbilities,
  type MemberTarget,
  teamSpaceProfile
} from './abilities'

const capabilities = (over: {
  versions?: CompanyCapabilities13Response['supportedWireVersions']
  admin?: 'active' | 'inactive'
  channels?: 'active' | 'inactive'
  channelFeature?: boolean
  rooms?: 'ready' | 'not_ready'
  conversationFeature?: boolean
  conversations?: 'active' | 'inactive'
} = {}): CompanyCapabilities13Response => ({
  schemaVersion: 4,
  wireVersion: '1.3',
  supportedWireVersions: over.versions ?? ['1', '1.1', '1.2', '1.3', '1.4'],
  features: {
    ownership: true,
    invitationLifecycle: true,
    capabilityDiscovery: true,
    channelAdmission: over.channelFeature ?? true,
    companyConversations: over.conversationFeature ?? false
  },
  activation: {
    teamAdmin: over.admin ?? 'active',
    channelAdmission: over.channels ?? 'active',
    companyConversations: over.conversations ?? 'inactive'
  },
  controller: { roomReconciliation: over.rooms ?? 'ready' }
})

const discovered = (over: Parameters<typeof capabilities>[0] = {}) =>
  teamSpaceProfile({ state: 'discovered', capabilities: capabilities(over) })

describe('the discovery profile', () => {
  it('draws nothing before an answer, and nothing for a server that predates discovery', () => {
    expect(teamSpaceProfile({ state: 'unknown' })).toEqual({ admin: false, channels: false, rooms: false, conversations: false })
    expect(teamSpaceProfile(LEGACY_DISCOVERY)).toEqual({ admin: false, channels: false, rooms: false, conversations: false })
  })

  it('needs both support and activation, per family', () => {
    expect(discovered()).toEqual({ admin: true, channels: true, rooms: true, conversations: false })
    expect(discovered({ admin: 'inactive' })).toMatchObject({ admin: false, channels: true })
    expect(discovered({ channels: 'inactive' })).toMatchObject({ admin: true, channels: false })
    // Active in the tenant but not spoken by the server (or not featured) is not a feature.
    expect(discovered({ versions: ['1', '1.1', '1.2', '1.3'] })).toMatchObject({ admin: true, channels: false })
    expect(discovered({ channelFeature: false })).toMatchObject({ channels: false })
    expect(discovered({ versions: ['1', '1.1', '1.2'] })).toMatchObject({ admin: false, channels: false })
  })

  it('reads company DMs and group DMs (1.5) only when the wire is named and the feature is on and active', () => {
    const v15: CompanyCapabilities13Response['supportedWireVersions'] = ['1', '1.1', '1.2', '1.3', '1.4', '1.5']
    const on = { versions: v15, conversationFeature: true, conversations: 'active' as const }

    expect(discovered(on)).toMatchObject({ conversations: true })
    // 1.5 is advertised only when the server's flags are on; any one signal missing leaves the section out.
    expect(discovered({ ...on, versions: ['1', '1.1', '1.2', '1.3', '1.4'] })).toMatchObject({ conversations: false })
    expect(discovered({ ...on, conversationFeature: false })).toMatchObject({ conversations: false })
    expect(discovered({ ...on, conversations: 'inactive' })).toMatchObject({ conversations: false })
    expect(discovered({ versions: v15 })).toMatchObject({ conversations: false })
    // It stands on its own: conversations do not need channel admission or the room controller to be read.
    expect(discovered({ ...on, channels: 'inactive', rooms: 'not_ready' })).toMatchObject({ channels: false, conversations: true })
  })

  it('reads the room controller separately: a feature can be active before rooms can be made', () => {
    expect(discovered({ rooms: 'not_ready' })).toEqual({ admin: true, channels: true, rooms: false, conversations: false })
  })
})

const legacy = teamSpaceProfile(LEGACY_DISCOVERY)
const full = discovered()

describe('company abilities', () => {
  it('before C1/C2 an admin invites and creates company-wide channels, a member does neither', () => {
    expect(companyAbilities(legacy, { role: 'admin', policy: 'members' })).toEqual({
      invite: true,
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
      createChannel: true,
      createPrivateChannel: false,
      browseChannels: false,
      creationBlocked: 'none'
    })
    expect(companyAbilities(legacy, { role: 'member', policy: 'members' })).toMatchObject({
      invite: false,
      createChannel: false,
      creationBlocked: 'restricted'
    })
  })

  it('lets every member invite as a member when policy 1.2 says members, and only owners and admins under admins', () => {
    expect(companyAbilities(full, { role: 'member', policy: 'members', invitations: 'members' })).toMatchObject({
      invite: true,
      inviteAdmin: false,
      revokeInviteLink: false
    })
    expect(companyAbilities(full, { role: 'member', policy: 'members', invitations: 'admins' }).invite).toBe(false)
    expect(companyAbilities(full, { role: 'admin', policy: 'members', invitations: 'admins' }).invite).toBe(true)
    // An older server never said: invites stay with owners and admins, and before C1 nobody's policy applies at all.
    expect(companyAbilities(full, { role: 'member', policy: 'members' }).invite).toBe(false)
    expect(companyAbilities(legacy, { role: 'member', policy: 'members', invitations: 'members' }).invite).toBe(false)
  })

  it('offers each invite method only when the server says it is ready, within what policy and role allow', () => {
    const ready = { schemaVersion: 1 as const, directoryInvite: 'ready' as const, emailInvite: 'delivery_unavailable' as const,
      emailCreation: 'ready' as const, emailDelivery: 'not_implemented' as const, inviteLink: 'ready' as const,
      emailAutoClaim: 'verification_required' as const }

    expect(companyAbilities(full, { role: 'member', policy: 'members', invitations: 'members' }, ready)).toMatchObject({
      inviteDirectory: true,
      inviteEmail: true,
      inviteLink: true,
      revokeInviteLink: false
    })
    expect(companyAbilities(full, { role: 'owner', policy: 'members' }, { ...ready, emailCreation: 'not_configured',
      inviteLink: 'not_configured' })).toMatchObject({ inviteDirectory: true, inviteEmail: false, inviteLink: false, revokeInviteLink: true })
    // Ready never widens past policy: a member under `admins` gets nothing.
    expect(companyAbilities(full, { role: 'member', policy: 'members', invitations: 'admins' }, ready)).toMatchObject({
      invite: false, inviteDirectory: false, inviteEmail: false, inviteLink: false
    })
    // Without readiness (an older server) there is no email method.
    expect(companyAbilities(full, { role: 'owner', policy: 'members' }).inviteEmail).toBe(false)
  })

  it('says direct add is served only on invites profile 3 with directAdd ready, and mail state from profile 2', () => {
    const profile2 = { schemaVersion: 2 as const, directoryInvite: 'ready' as const, emailInvite: 'delivery_unavailable' as const,
      emailCreation: 'ready' as const, emailDelivery: 'not_configured' as const, inviteLink: 'ready' as const,
      emailAutoClaim: 'verification_required' as const }
    const profile3 = { ...profile2, schemaVersion: 3 as const, directAdd: 'ready' as const }
    const owner = { role: 'owner' as const, policy: 'members' as const }

    expect(companyAbilities(full, owner, profile3)).toMatchObject({ directAdd: true, mailStatus: true })
    expect(companyAbilities(full, owner, { ...profile3, directAdd: 'inactive' })).toMatchObject({ directAdd: false, mailStatus: true })
    expect(companyAbilities(full, owner, profile2)).toMatchObject({ directAdd: false, mailStatus: true })
    // Profile 1 has no mail state; no email creation means no mail to ask about; before C1 nothing at all.
    expect(companyAbilities(full, owner, { ...profile2, schemaVersion: 1, emailDelivery: 'not_implemented' } as never))
      .toMatchObject({ directAdd: false, mailStatus: false })
    expect(companyAbilities(full, owner, { ...profile3, emailCreation: 'not_configured' })).toMatchObject({ mailStatus: false })
    expect(companyAbilities(legacy, { role: 'admin', policy: 'members' }, profile3)).toMatchObject({ directAdd: false })
    // A member who may not invite gets neither (the per-company readiness would say not_allowed too).
    expect(companyAbilities(full, { role: 'member', policy: 'members', invitations: 'admins' }, profile3)).toMatchObject({ mailStatus: false })
  })

  it('has nothing to offer without a standing', () => {
    expect(Object.values(companyAbilities(full, undefined)).filter(value => value === true)).toEqual([])
  })

  it('the owner holds ownership, roles, policy, links and admin invitations', () => {
    expect(companyAbilities(full, { role: 'owner', policy: 'members' })).toEqual({
      invite: true,
      inviteAdmin: true,
      inviteDirectory: true,
      inviteEmail: false,
      inviteLink: true,
      directAdd: false,
      mailStatus: false,
      revokeInviteLink: true,
      changeRoles: true,
      transferOwnership: true,
      editPolicy: true,
      createChannel: true,
      createPrivateChannel: true,
      browseChannels: true,
      creationBlocked: 'none'
    })
  })

  it('an admin manages members and policy but neither ownership, roles nor admin invitations', () => {
    expect(companyAbilities(full, { role: 'admin', policy: 'admins_only' })).toMatchObject({
      invite: true,
      inviteAdmin: false,
      inviteLink: true,
      changeRoles: false,
      transferOwnership: false,
      editPolicy: true,
      createChannel: true
    })
  })

  it('a member creates channels by default and only while the policy and the room controller allow', () => {
    expect(companyAbilities(full, { role: 'member', policy: 'members' })).toMatchObject({
      invite: false,
      createChannel: true,
      createPrivateChannel: true,
      browseChannels: true
    })
    expect(companyAbilities(full, { role: 'member', policy: 'admins_only' })).toMatchObject({
      createChannel: false,
      createPrivateChannel: false,
      creationBlocked: 'restricted',
      browseChannels: true
    })
    expect(companyAbilities(discovered({ rooms: 'not_ready' }), { role: 'member', policy: 'members' })).toMatchObject({
      createChannel: false,
      creationBlocked: 'rooms'
    })
  })

  it('never offers a private channel on a server whose channel admission is not active', () => {
    const profile = discovered({ channels: 'inactive' })

    expect(companyAbilities(profile, { role: 'owner', policy: 'members' })).toMatchObject({
      createChannel: true,
      createPrivateChannel: false,
      browseChannels: false
    })
  })
})

const person = (over: Partial<MemberTarget>): MemberTarget => ({
  memberRef: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  role: 'member',
  state: 'active',
  self: false,
  ...over
})

describe('member abilities', () => {
  it('the owner promotes, demotes, transfers to and removes people below the owner', () => {
    expect(memberAbilities(full, 'owner', person({ role: 'member' }), 3)).toEqual({
      makeAdmin: true,
      makeMember: false,
      makeOwner: true,
      remove: true,
      leave: false,
      leaveBlockedByOwnership: false
    })
    expect(memberAbilities(full, 'owner', person({ role: 'admin' }), 3)).toMatchObject({
      makeAdmin: false,
      makeMember: true,
      makeOwner: true,
      remove: true
    })
  })

  it('an admin removes ordinary members only, never an admin and never the owner', () => {
    expect(memberAbilities(full, 'admin', person({ role: 'member' }), 3)).toMatchObject({
      remove: true,
      makeAdmin: false,
      makeOwner: false
    })
    expect(memberAbilities(full, 'admin', person({ role: 'admin' }), 3).remove).toBe(false)
    expect(memberAbilities(full, 'admin', person({ role: 'owner' }), 3).remove).toBe(false)
    expect(memberAbilities(full, 'member', person({ role: 'member' }), 3).remove).toBe(false)
  })

  it('before C1 an admin removes any other member, as the 1.1 client always did', () => {
    expect(memberAbilities(legacy, 'admin', person({ role: 'admin' }), 3).remove).toBe(true)
    expect(memberAbilities(legacy, 'member', person({ role: 'member' }), 3).remove).toBe(false)
    expect(memberAbilities(legacy, 'admin', person({ role: 'member' }), 3).makeOwner).toBe(false)
  })

  it('an owner with other people must hand the company over first; alone, leaving retires it', () => {
    expect(memberAbilities(full, 'owner', person({ role: 'owner', self: true }), 3)).toMatchObject({
      leave: false,
      leaveBlockedByOwnership: true
    })
    expect(memberAbilities(full, 'owner', person({ role: 'owner', self: true }), 1)).toMatchObject({
      leave: true,
      leaveBlockedByOwnership: false
    })
    expect(memberAbilities(full, 'member', person({ role: 'member', self: true }), 3).leave).toBe(true)
  })

  it('a row that is leaving, or a person who is not active, offers nothing', () => {
    expect(Object.values(memberAbilities(full, 'owner', person({ state: 'revoking' }), 3)).filter(Boolean)).toEqual([])
    expect(Object.values(memberAbilities(full, 'owner', person({ state: 'invited' }), 3)).filter(Boolean)).toEqual([])
    expect(Object.values(memberAbilities(full, undefined, person({}), 3)).filter(Boolean)).toEqual([])
  })
})

describe('invitation abilities', () => {
  it('the owner manages every pending invitation; an admin only member invitations; nobody else any', () => {
    expect(invitationAbilities(full, 'owner', 'admin')).toEqual({ cancel: true, resend: true })
    expect(invitationAbilities(full, 'admin', 'member')).toEqual({ cancel: true, resend: true })
    expect(invitationAbilities(full, 'admin', 'admin')).toEqual({ cancel: false, resend: false })
    expect(invitationAbilities(full, 'member', 'member')).toEqual({ cancel: false, resend: false })
    expect(invitationAbilities(legacy, 'admin', 'member')).toEqual({ cancel: false, resend: false })
  })
})

const channel = (over: Partial<ChannelFacts> & { actions?: readonly CompanyChannelAction14[] | null } = {}): ChannelFacts => ({
  visibility: 'public',
  state: 'active',
  ownedByViewer: false,
  actions: ['leave', 'invite', 'remove', 'update_metadata', 'archive'],
  ...over
})

describe('channel abilities', () => {
  it('reads the server’s actions, narrowed by the contract’s own rules', () => {
    expect(channelAbilities(full, 'member', channel({ ownedByViewer: true }))).toEqual({
      leave: true,
      archive: true,
      restore: false,
      edit: true,
      // Invitation is how a private channel is joined; a public one is joined, not invited to.
      addPeople: false,
      removeMembers: true,
      seeMembers: true
    })
    expect(channelAbilities(full, 'member', channel({ visibility: 'private' })).addPeople).toBe(true)
  })

  it('#general is public, auto-joined and can be neither left nor archived, whatever the actions say', () => {
    const general = channelAbilities(full, 'owner', channel({ systemKey: 'default' }))

    expect(general).toMatchObject({ leave: false, archive: false, removeMembers: false, edit: true })
  })

  it('an archived channel offers restore and nothing that changes who is in it', () => {
    const archived = channelAbilities(
      full,
      'admin',
      channel({ state: 'archived', actions: ['restore'], visibility: 'private' })
    )

    expect(archived).toMatchObject({ restore: true, leave: false, archive: false, addPeople: false, removeMembers: false })
  })

  it('shows the member list to the channel’s owner and the company’s owner and admins only', () => {
    expect(channelAbilities(full, 'member', channel()).seeMembers).toBe(false)
    expect(channelAbilities(full, 'member', channel({ ownedByViewer: true })).seeMembers).toBe(true)
    expect(channelAbilities(full, 'admin', channel()).seeMembers).toBe(true)
    expect(channelAbilities(full, 'owner', channel()).seeMembers).toBe(true)
    expect(channelAbilities(full, undefined, channel({ ownedByViewer: true })).seeMembers).toBe(false)
  })

  it('offers nothing on the 1.1 wire, and no new admission while the room controller is not ready', () => {
    expect(Object.values(channelAbilities(legacy, 'admin', channel())).filter(Boolean)).toEqual([])
    expect(Object.values(channelAbilities(full, 'admin', channel({ actions: null }))).filter(Boolean)).toEqual([])
    expect(
      channelAbilities(discovered({ rooms: 'not_ready' }), 'admin', channel({ visibility: 'private' })).addPeople
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  assistantBlocked,
  assistantCommand,
  assistantInviteAdoptionEnabled,
  assistantInviteCoexistences,
  assistantRoomInvalidated,
  assistantRooms,
  matrixExplicitInvocationRefusal,
  MatrixInvocationFlights,
  projectAssistantRooms
} from './assistant-policy'

const assistant = { userId: '@agent:test', deviceId: 'AGENT' }

const room = {
  id: '!pair:test',
  name: 'Private',
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: '@owner:test', membership: 'join' },
    { userId: assistant.userId, membership: 'join' }
  ]
}

describe('native assistant boundary independent of SDK liveness', () => {
  it('keeps enrolled rooms labeled when the SDK is down, including rooms with another reader', () => {
    expect(assistantRooms([room], assistant)[0].assistant).toBe(true)
    expect(
      assistantRooms(
        [{ ...room, participants: [...room.participants, { userId: '@third:test', membership: 'join' }] }],
        assistant
      )[0].assistant
    ).toBe(true)
    expect(
      assistantRooms(
        [
          {
            ...room,
            roomType: undefined,
            participants: [room.participants[0], { userId: '@human:test', membership: 'join' }]
          }
        ],
        assistant
      )[0].assistant
    ).toBe(false)
    expect(assistantRooms([room], undefined)[0].assistant).toBe(true)
    expect(assistantRooms([room], { userId: '@replacement:test', deviceId: 'NEW' })[0].assistant).toBe(true)
    expect(assistantRooms([{ ...room, roomType: undefined, assistant: true }], undefined)[0].assistant).toBe(false)
  })
  it("names each private room's agent, and only its owner's private room with that agent", () => {
    const alfred = { principal: 'alfred-principal', userId: '@alfred:test' }
    const agents = [{ principal: 'default-principal', userId: assistant.userId }, alfred]

    const alfredRoom = {
      ...room,
      id: '!alfred:test',
      participants: [room.participants[0], { userId: alfred.userId, membership: 'invite' }]
    }

    const named = assistantRooms([room, alfredRoom], assistant, agents, '@owner:test')
    expect(named.map(each => each.agentPrincipal)).toEqual(['default-principal', 'alfred-principal'])
    expect(named.every(each => each.assistant)).toBe(true)

    // A third member, another owner, or no owner: not a private room of that agent.
    const group = { ...room, participants: [...room.participants, { userId: '@third:test', membership: 'join' }] }
    expect(assistantRooms([group], assistant, agents, '@owner:test')[0].agentPrincipal).toBeUndefined()
    expect(assistantRooms([room], assistant, agents, '@someone:test')[0].agentPrincipal).toBeUndefined()
    expect(assistantRooms([room], assistant, agents)[0].agentPrincipal).toBeUndefined()
    // Without agents, rooms are as before.
    expect(assistantRooms([room], assistant)).toEqual([{ ...room, assistant: true }])
  })
  it('does not promote an unsolicited typed invitation to joined assistant history', () => {
    expect(assistantRooms([{ ...room, membership: 'invite' }])[0].assistant).toBe(false)
  })
  it('hides a known agent-created invite instead of listing a second Invited chat for Founder', () => {
    const founder = '@user-founder:test'

    const invitation = {
      ...room,
      id: '!controller-bootstrap:test',
      membership: 'invite',
      encrypted: false,
      plainAgent: true,
      direct: true,
      participants: [
        { userId: founder, membership: 'invite' },
        { userId: assistant.userId, membership: 'join' }
      ]
    }

    const joined = {
      ...room,
      id: '!owner-main:test',
      participants: [
        { userId: founder, membership: 'join' },
        { userId: assistant.userId, membership: 'join' }
      ]
    }

    expect(
      assistantRooms(
        [invitation, joined],
        assistant,
        [{ principal: 'default-principal', userId: assistant.userId }],
        founder
      ).map(value => value.id)
    ).toEqual(['!owner-main:test'])
    expect(
      assistantInviteCoexistences(
        [invitation, joined],
        assistantRooms(
          [invitation, joined],
          assistant,
          [{ principal: 'default-principal', userId: assistant.userId }],
          founder
        ),
        [{ principal: 'default-principal', userId: assistant.userId }],
        founder
      )
    ).toBe(1)
    expect(
      projectAssistantRooms(
        [invitation, joined],
        invitation.id,
        assistant,
        [{ principal: 'default-principal', userId: assistant.userId }],
        founder
      )
    ).toMatchObject({
      roomId: null,
      rooms: [{ id: joined.id }],
      hiddenInvite: {
        agentId: assistant.userId,
        hiddenRoomId: invitation.id,
        mainRoomId: joined.id
      }
    })
  })
  it('adopts invitations for roster-cloud and placed cloud-only agents', () => {
    expect(assistantInviteAdoptionEnabled({ cloud: true, cloudOnly: false })).toBe(true)
    expect(assistantInviteAdoptionEnabled({ cloud: false, cloudOnly: true })).toBe(true)
    expect(assistantInviteAdoptionEnabled({ cloud: false, cloudOnly: false })).toBe(false)
  })
  it('rejects new assistant creation during enrollment changes without blocking human chats', () => {
    expect(() =>
      assistantCommand({ kind: 'create', name: '', direct: true, invite: [assistant.userId] }, assistant.userId, true)
    ).toThrow('matrix_not_ready')
    expect(
      assistantCommand({ kind: 'create', name: 'Human', direct: true, invite: ['@human:test'] }, assistant.userId, true)
        .kind
    ).toBe('create')
  })
  it('routes invites through full room checks even when no agent host is running', () => {
    expect(assistantCommand({ kind: 'invite', roomId: room.id, userId: '@human:test' }, assistant.userId)).toEqual({
      kind: 'inviteHuman',
      roomId: room.id,
      userId: '@human:test',
      agentId: assistant.userId,
      agentIds: [assistant.userId]
    })
    // A group with the owner's assistant is a group the assistant joins, never a person invite.
    expect(
      assistantCommand({ kind: 'create', name: 'Group', direct: false, invite: [assistant.userId] }, assistant.userId)
    ).toEqual({ kind: 'createGroup', name: 'Group', invite: [], agents: [assistant.userId] })
    expect(() =>
      assistantCommand(
        { kind: 'create', name: '', direct: true, invite: [assistant.userId, '@other:test'] },
        assistant.userId
      )
    ).toThrow()
    expect(
      assistantCommand({ kind: 'create', name: '', direct: true, invite: [assistant.userId] }, assistant.userId).kind
    ).toBe('createAssistant')
    expect(assistantCommand({ kind: 'invite', roomId: room.id, userId: '@human:test' })).toEqual({
      kind: 'inviteHuman',
      roomId: room.id,
      userId: '@human:test',
      agentId: undefined,
      agentIds: []
    })
    expect(
      assistantCommand({ kind: 'create', name: 'Human', direct: true, invite: ['@human:test'] }, assistant.userId).kind
    ).toBe('create')
  })
  it('creates the same private typed pair for every enrolled agent, independent of the primary', () => {
    const named = '@alfred:test'
    const create = { kind: 'create' as const, name: '', direct: true, invite: [named] }
    expect(assistantCommand(create, assistant.userId, false, [named])).toEqual({ ...create, kind: 'createAssistant' })
    expect(assistantCommand(create, undefined, false, [named]).kind).toBe('createAssistant')
    expect(assistantCommand(create, assistant.userId, false, [named], [named])).toEqual({
      ...create,
      kind: 'createAssistant',
      adoptAgentInvite: true
    })
    expect(() => assistantCommand(create, assistant.userId, true, [named])).toThrow('matrix_not_ready')
    expect(assistantCommand({ ...create, direct: false }, assistant.userId, false, [named])).toEqual({
      kind: 'createGroup',
      name: '',
      invite: [],
      agents: [named]
    })
    expect(() =>
      assistantCommand({ ...create, invite: [named, '@human:test'] }, assistant.userId, false, [named])
    ).toThrow('matrix_private_assistant_room_required')
    // Native supplies only its current enrollments; a removed/unknown target is
    // still an ordinary human chat and never gets the assistant marker by name.
    expect(assistantCommand(create, assistant.userId, false, []).kind).toBe('create')
  })
  it('adds the owner’s own assistants to groups as members, at most five, never as people', () => {
    const own = ['@alfred:test', '@bea:test', '@cy:test', '@di:test', '@eli:test']
    const people = ['@linh:test', '@quan:test']

    // People are invited as before; the assistants are named apart, for main to have each join.
    expect(
      assistantCommand(
        { kind: 'create', name: 'Trip', direct: false, invite: [...people, own[0]!, assistant.userId] },
        assistant.userId,
        false,
        own
      )
    ).toEqual({ kind: 'createGroup', name: 'Trip', invite: people, agents: [own[0], assistant.userId] })
    // Five is the most; a sixth refuses the whole group rather than leaving one out.
    expect(
      assistantCommand({ kind: 'create', name: 'Five', direct: false, invite: own }, assistant.userId, false, own)
    ).toMatchObject({ kind: 'createGroup', agents: own })
    expect(() =>
      assistantCommand(
        { kind: 'create', name: 'Crowd', direct: false, invite: [...own, assistant.userId] },
        assistant.userId,
        false,
        own
      )
    ).toThrow('matrix_group_agents_full')
    // The same group during an enrollment change waits, like a private room would.
    expect(() =>
      assistantCommand({ kind: 'create', name: 'Trip', direct: false, invite: [own[0]!] }, assistant.userId, true, own)
    ).toThrow('matrix_not_ready')
    // Adding one to an existing group is the agent path, checked by the SDK; a person is not.
    expect(
      assistantCommand({ kind: 'invite', roomId: '!group:test', userId: own[1]! }, assistant.userId, false, own)
    ).toEqual({ kind: 'inviteAgent', roomId: '!group:test', userId: own[1], agentIds: [assistant.userId, ...own] })
    expect(
      assistantCommand({ kind: 'invite', roomId: '!group:test', userId: people[0]! }, assistant.userId, false, own)
    ).toMatchObject({ kind: 'inviteHuman', agentIds: [assistant.userId, ...own] })
    // Someone else's assistant (not enrolled here) is just another account to invite.
    expect(
      assistantCommand({ kind: 'invite', roomId: '!group:test', userId: '@theirs:test' }, assistant.userId, false, own)
        .kind
    ).toBe('inviteHuman')
  })
  it('lists a group the default assistant is in as a group, not as the assistant’s own chat', () => {
    const group = {
      id: '!group:test',
      name: 'Trip',
      membership: 'join',
      encrypted: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: assistant.userId, membership: 'join' },
        { userId: '@linh:test', membership: 'join' }
      ]
    }

    expect(assistantRooms([group], assistant, [], '@owner:test')[0]!.assistant).toBe(false)
    // Even a group of just the owner and the assistant: a group, not a direct chat.
    expect(
      assistantRooms([{ ...group, participants: group.participants.slice(0, 2) }], assistant, [], '@owner:test')[0]!
        .assistant
    ).toBe(false)
    // An older private chat (direct, just the two of them, before the room type) still is one.
    expect(
      assistantRooms(
        [{ ...group, direct: true, participants: group.participants.slice(0, 2) }],
        assistant,
        [],
        '@owner:test'
      )[0]!.assistant
    ).toBe(true)
  })
  it('never makes a company private Chief of Staff room a personal assistant chat: the company marker wins', () => {
    const agents = [{ principal: 'default-principal', userId: assistant.userId }]
    // The private-CoS room uses the assistant room type, plain, the owner and the company's agent.
    const privateCos = {
      ...room,
      id: '!private-cos:test',
      name: 'Chief of Staff',
      encrypted: false,
      plainAgent: true,
      companyPrivateCos: {
        v: 1 as const,
        classification: 'company_private_cos' as const,
        companyId: '00000000-0000-4000-8000-72805976e3a7',
        membershipIncarnation: '00000000-0000-4000-8000-4ddf7748f9cd',
        executorId: '00000000-0000-4000-8000-3570bef6c8ca'
      },
      participants: [room.participants[0], { userId: '@cos:test', membership: 'join' }]
    }

    const [exact] = assistantRooms([privateCos], assistant, agents, '@owner:test')
    expect(exact!.assistant).toBe(false)
    expect(exact!.agentPrincipal).toBeUndefined()

    // A malformed claim is quarantined the same way, and so is a stale personal label from an older projection.
    const claim = { ...privateCos, companyPrivateCos: undefined, companyPrivateCosClaim: true as const }
    expect(assistantRooms([claim], assistant, agents, '@owner:test')[0]!.assistant).toBe(false)
    const stale = { ...privateCos, assistant: true, agentPrincipal: 'default-principal' }
    const [restated] = assistantRooms([stale], assistant, agents, '@owner:test')
    expect(restated!.assistant).toBe(false)
    expect(restated!.agentPrincipal).toBeUndefined()

    // Even when the company's agent is the same Matrix user as one of the person's own: never their private room.
    const sameUser = { ...privateCos, participants: [room.participants[0], { userId: assistant.userId, membership: 'join' }] }
    const [shared] = assistantRooms([sameUser], assistant, agents, '@owner:test')
    expect(shared!.assistant).toBe(false)
    expect(shared!.agentPrincipal).toBeUndefined()
    expect(assistantRoomInvalidated([sameUser], sameUser.id, '@owner:test', assistant.userId)).toBe(true)

    // The ordinary private room beside it keeps its agent.
    expect(assistantRooms([privateCos, room], assistant, agents, '@owner:test')[1]).toMatchObject({
      assistant: true,
      agentPrincipal: 'default-principal'
    })
  })
  it('excludes explicit dispatch from listening and every active native operation', () => {
    const idle = {
      operation: false,
      domainOperation: false,
      invocation: false,
      closing: false,
      ready: true,
      agentReady: true,
      listening: false
    }

    expect(assistantBlocked(idle)).toBe(false)

    for (const flag of ['operation', 'domainOperation', 'invocation', 'closing', 'listening']) {
      expect(assistantBlocked({ ...idle, [flag]: true })).toBe(true)
    }

    for (const flag of ['ready', 'agentReady']) {
      expect(assistantBlocked({ ...idle, [flag]: false })).toBe(true)
    }

    expect(assistantBlocked({ ...idle, listening: true, fromListener: true })).toBe(false)
    expect(assistantBlocked({ ...idle, invocation: true, listening: true, fromListener: true })).toBe(true)
  })
  it('invalidates the protected run when membership is lost or widened', () => {
    expect(assistantRoomInvalidated([room], room.id, '@owner:test', assistant.userId)).toBe(false)
    expect(assistantRoomInvalidated([], room.id, '@owner:test', assistant.userId)).toBe(true)
    expect(
      assistantRoomInvalidated(
        [{ ...room, participants: [...room.participants, { userId: '@other:test', membership: 'leave' }] }],
        room.id,
        '@owner:test',
        assistant.userId
      )
    ).toBe(true)
    expect(assistantRoomInvalidated([], undefined, '@owner:test', assistant.userId)).toBe(false)
  })
})

describe('running one of your messages in place (invokeHermes)', () => {
  const owner = '@owner:test'

  const message = (id: string, extra: Partial<MatrixMessage> = {}): MatrixMessage => ({
    id,
    sender: owner,
    body: 'Plan a trip',
    timestamp: 1,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...extra
  })

  const answer = (replyTo: string): MatrixMessage =>
    message('$answer', { own: false, sender: assistant.userId, body: 'Here', replyTo })

  const ask = (overrides: Partial<Parameters<typeof matrixExplicitInvocationRefusal>[0]> = {}) =>
    matrixExplicitInvocationRefusal({
      roomId: room.id,
      eventId: '$question',
      ownerUserId: owner,
      agentUserId: assistant.userId,
      selectedRoomId: room.id,
      rooms: [room],
      messages: [message('$question')],
      ...overrides
    })

  it('admits your own unanswered message, a file too, in your private chat with that agent', () => {
    expect(ask()).toBeNull()
    expect(ask({ messages: [message('$question', { attachment: true, body: 'notes.pdf' })] })).toBeNull()
    // Another question's answer is not this one's.
    expect(ask({ messages: [message('$older'), answer('$older'), message('$question')] })).toBeNull()
  })

  it('refuses a message that is already answered', () => {
    expect(ask({ messages: [message('$question'), answer('$question')] })).toBe('matrix_invocation_answered')
    expect(
      ask({ messages: [message('$question'), { ...answer('$other'), resultFor: '$question' }] })
    ).toBe('matrix_invocation_answered')
  })

  it('still admits a message the agent only held: its notice is status, not an answer', () => {
    // "I couldn't read the message you replied to…": running it again re-reads the quote.
    expect(ask({ messages: [message('$question'), { ...answer('$question'), notice: true }] })).toBeNull()
  })

  it("refuses anyone else's message, an unknown one, and one that isn't settled or readable", () => {
    expect(ask({ messages: [message('$question', { own: false, sender: assistant.userId })] })).toBe(
      'matrix_invocation_untrusted'
    )
    expect(ask({ messages: [message('$question', { sender: '@mallory:test' })] })).toBe('matrix_invocation_untrusted')
    expect(ask({ messages: [] })).toBe('matrix_invocation_untrusted')

    for (const flag of ['pending', 'failed', 'redacted', 'decryptionFailed'] as const) {
      expect(ask({ messages: [message('$question', { [flag]: true })] })).toBe('matrix_invocation_untrusted')
    }

    // A local-path question runs once, through this device's local-turn engine only.
    expect(ask({ messages: [message('$question', { turn: '00000000-0000-4000-8000-31f949766961' })] })).toBe(
      'matrix_invocation_untrusted'
    )
  })

  it('refuses anywhere but your private chat with that agent, open on screen', () => {
    const group = { ...room, participants: [...room.participants, { userId: '@third:test', membership: 'join' }] }

    expect(ask({ rooms: [group] })).toBe('matrix_private_assistant_room_required')
    expect(ask({ rooms: [{ ...room, roomType: undefined }] })).toBe('matrix_private_assistant_room_required')
    expect(ask({ agentUserId: '@alfred:test' })).toBe('matrix_private_assistant_room_required')
    expect(ask({ rooms: [] })).toBe('matrix_private_assistant_room_required')
    expect(ask({ selectedRoomId: '!elsewhere:test' })).toBe('matrix_not_ready')
    expect(ask({ selectedRoomId: null })).toBe('matrix_not_ready')
  })

  it('holds a message while its run goes on: a second request for it is refused, not queued', () => {
    const flights = new MatrixInvocationFlights()
    const release = flights.take(room.id, '$question')

    expect(release).toBeTypeOf('function')
    expect(flights.take(room.id, '$question')).toBeNull()
    // Other messages are not held by it.
    const other = flights.take(room.id, '$other')
    expect(other).toBeTypeOf('function')

    release!()
    // Releasing twice frees nothing else.
    release!()
    expect(flights.take(room.id, '$other')).toBeNull()

    const again = flights.take(room.id, '$question')
    expect(again).toBeTypeOf('function')
    again!()
    other!()
  })
})

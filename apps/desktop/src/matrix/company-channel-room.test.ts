import { createClient, EventType, MatrixEvent, Preset, Room } from 'matrix-js-sdk'
import type { IStateEventWithRoomId, MatrixClient } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  companyChannelRoomBinding,
  companyRoomTargetBinding,
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_BINDING,
  MATRIX_COMPANY_CONVERSATION_TYPE,
  type MatrixCompanyChannelRoomBinding,
  type MatrixCompanyChannelRoomTarget,
  type MatrixCompanyRoomTargetBinding,
  type MatrixCompanyRoomTargetInput
} from '../../shared/matrix-company-channel-room'

import {
  createCompanyChannelRoom,
  createCompanyRoomTarget,
  findCompanyChannelRoom,
  findCompanyRoomTarget,
  readCompanyChannelRoom,
  reconcileCompanyChannelRoom,
  reconcileCompanyRoomTarget
} from './company-channel-room'

const ROOM_ID = '!team-space:test'
const OTHER_ROOM_ID = '!other-team-space:test'
const MANAGER = '@manager:test'
const MEMBER = '@member:test'
const OUTSIDER = '@outsider:test'
const FORMER = '@former:test'

const binding: MatrixCompanyChannelRoomBinding = {
  companyId: '00000000-0000-4000-8000-bd7662a5eeb4',
  channelId: '00000000-0000-4000-8000-b454f82c5857',
  managerUserId: MANAGER
}

const channelTarget: MatrixCompanyChannelRoomTarget = {
  ...binding,
  roomId: ROOM_ID,
  memberUserIds: [MEMBER],
  bannedUserIds: [],
  posting: 'open'
}
const conversationBinding: MatrixCompanyRoomTargetBinding = {
  companyId: binding.companyId,
  target: {kind:'conversation',conversationId:'00000000-0000-4000-8000-f6222a1106ee',conversationKind:'dm',
    participantSetDigest:'d'.repeat(64)},
  managerUserId: MANAGER
}
const conversationTarget: MatrixCompanyRoomTargetInput = {
  ...conversationBinding,roomId:ROOM_ID,memberUserIds:[MEMBER],bannedUserIds:[],posting:'open',
  displayName:'Direct message',topic:''
}

let sequence = 0

function state(
  type: string,
  stateKey: string,
  content: Record<string, unknown>,
  sender = MANAGER,
  roomId = ROOM_ID
): IStateEventWithRoomId {
  sequence += 1

  return {
    type,
    state_key: stateKey,
    room_id: roomId,
    content,
    event_id: `$company-channel-state-${sequence}`,
    sender,
    origin_server_ts: sequence
  }
}

function member(userId: string, membership: string) {
  return state(EventType.RoomMember, userId, { membership })
}

function validState(members: IStateEventWithRoomId[] = [member(MEMBER, 'join')]): IStateEventWithRoomId[] {
  return [
    state(EventType.RoomCreate, '', {
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: binding.companyId, channelId: binding.channelId }
    }),
    state(EventType.RoomPowerLevels, '', {
      users: { [MANAGER]: 100 },
      users_default: 0,
      events: { [EventType.RoomPinnedEvents]: 0 },
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      notifications: { room: 100 }
    }),
    state(EventType.RoomHistoryVisibility, '', { history_visibility: 'shared' }),
    state(EventType.RoomJoinRules, '', { join_rule: 'invite' }),
    state(EventType.RoomGuestAccess, '', { guest_access: 'forbidden' }),
    member(MANAGER, 'join'),
    ...members
  ]
}

function validConversationState(eventsDefault=0,members:IStateEventWithRoomId[]=[member(MEMBER,'join')]) {
  const target=conversationBinding.target as Extract<typeof conversationBinding.target,{kind:'conversation'}>

  return [
    state(EventType.RoomCreate,'',{type:MATRIX_COMPANY_CONVERSATION_TYPE,room_version:MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
      [MATRIX_COMPANY_CONVERSATION_BINDING]:{companyId:conversationBinding.companyId,conversationId:target.conversationId,
        conversationKind:target.conversationKind,participantSetDigest:target.participantSetDigest}}),
    state(EventType.RoomPowerLevels,'',{users:{[MANAGER]:100},users_default:0,
      events:{[EventType.RoomPinnedEvents]:0},events_default:eventsDefault,
      state_default:100,invite:100,kick:100,ban:100,redact:100,notifications:{room:100}}),
    state(EventType.RoomHistoryVisibility,'',{history_visibility:'shared'}),
    state(EventType.RoomJoinRules,'',{join_rule:'invite'}),
    state(EventType.RoomGuestAccess,'',{guest_access:'forbidden'}),
    state(EventType.RoomName,'',{name:'Direct message'}),
    state(EventType.RoomTopic,'',{topic:''}),
    member(MANAGER,'join'),...members
  ]
}

function client(userId = MANAGER, events = validState()): MatrixClient {
  const value = createClient({ baseUrl: 'https://matrix.test', userId })
  vi.spyOn(value.http, 'authedRequest').mockResolvedValue(events)

  return value
}

function discoveryClient(rooms: Record<string, IStateEventWithRoomId[]>) {
  const value = client()
  vi.spyOn(value, 'getJoinedRooms').mockResolvedValue({ joined_rooms: Object.keys(rooms) })
  vi.spyOn(value, 'getRoom').mockReturnValue(null)
  vi.spyOn(value, 'roomState').mockImplementation(async roomId => rooms[roomId] ?? [])

  return value
}

describe('company channel room creation and immutable recovery', () => {
  it('creates exactly a plain v11, shared-history, invite-only no-guests room under manager custody', async () => {
    const value = client()
    const create = vi.spyOn(value, 'createRoom').mockResolvedValue({ room_id: ROOM_ID } as never)

    await expect(createCompanyChannelRoom(value, { ...binding, name: 'Engineering' })).resolves.toBe(ROOM_ID)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      name: 'Engineering',
      preset: Preset.PrivateChat,
      room_version: '11',
      creation_content: {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: binding.companyId, channelId: binding.channelId }
      },
      power_level_content_override: {
        users: { [MANAGER]: 100 }, users_default: 0,
        events: { [EventType.RoomPinnedEvents]: 0 }, events_default: 0, state_default: 100,
        invite: 100, kick: 100, ban: 100, redact: 100, notifications: { room: 100 }
      },
      initial_state: [
        { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
        { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
        { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
      ]
    })
  })

  it('accepts 1–80 Unicode code points and rejects malformed names before a create POST', async () => {
    const value = client()
    const create = vi.spyOn(value, 'createRoom').mockResolvedValue({ room_id: ROOM_ID } as never)
    const eighty = '🧠'.repeat(80)

    await expect(createCompanyChannelRoom(value, { ...binding, name: '名' })).resolves.toBe(ROOM_ID)
    await expect(createCompanyChannelRoom(value, { ...binding, name: eighty })).resolves.toBe(ROOM_ID)

    for (const name of ['', ' channel', 'channel ', 'a\nchannel', `channel${String.fromCharCode(127)}`, '🧠'.repeat(81)]) {
      await expect(createCompanyChannelRoom(value, { ...binding, name })).rejects.toThrow('matrix_company_channel_room_required')
    }

    expect(create).toHaveBeenCalledTimes(2)
  })

  it('recovers only an exact immutable create binding and treats duplicate matches as a conflict', async () => {
    await expect(findCompanyChannelRoom(discoveryClient({ [ROOM_ID]: validState() }), binding)).resolves.toMatchObject({
      roomId: ROOM_ID
    })
    await expect(findCompanyChannelRoom(discoveryClient({
      [ROOM_ID]: validState(), [OTHER_ROOM_ID]: validState()
    }), binding)).rejects.toThrow('matrix_company_channel_room_conflict')

    const drift = validState()
    Reflect.set(drift[0]!.content[MATRIX_COMPANY_CHANNEL_BINDING] as object, 'channelId', binding.companyId)
    await expect(findCompanyChannelRoom(discoveryClient({ [ROOM_ID]: drift }), binding)).resolves.toBeNull()
  })

  it('parses the shared create binding only at the pinned room semantics', () => {
    const creation = validState()[0]!
    expect(companyChannelRoomBinding(creation.content, MANAGER)).toEqual(binding)
    expect(companyChannelRoomBinding({ ...creation.content, room_version: '12' }, MANAGER)).toBeUndefined()
    expect(companyChannelRoomBinding({
      ...creation.content,
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: binding.companyId, channelId: binding.channelId, surprise: true }
    }, MANAGER)).toBeUndefined()
  })
})

describe('company channel room current state and authority', () => {
  it('upgrades an older room so ordinary joined members may write only shared pin state', async () => {
    const legacy = validState()
    legacy[1]!.content.events = {}
    const upgraded = validState()
    const value = client()

    const roomState = vi.spyOn(value, 'roomState').mockResolvedValueOnce(legacy).mockResolvedValueOnce(upgraded)
      .mockResolvedValueOnce(upgraded)

    const send = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyChannelRoom(value, channelTarget)).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(send).toHaveBeenCalledExactlyOnceWith(ROOM_ID, EventType.RoomPowerLevels,
      expect.objectContaining({events:{[EventType.RoomPinnedEvents]:0},state_default:100}),'')
    expect(roomState).toHaveBeenCalledTimes(3)
  })

  it('adds shared-pin permission before closing an older channel, without reopening its message path', async () => {
    const legacy = validState()
    legacy[1]!.content.events = {}
    const upgraded = validState()
    const archived = validState()
    archived[1]!.content.events_default = 100
    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValueOnce(legacy).mockResolvedValueOnce(upgraded)
      .mockResolvedValueOnce(archived).mockResolvedValueOnce(archived)
    const sent: Record<string, unknown>[] = []
    vi.spyOn(value, 'sendStateEvent').mockImplementation(async (_roomId, type, content) => {
      if (type === EventType.RoomPowerLevels) {sent.push(content as Record<string, unknown>)}

      return {} as never
    })

    await reconcileCompanyChannelRoom(value, { ...channelTarget, posting: 'archived_read_only' })
    expect(sent).toEqual([
      expect.objectContaining({events:{[EventType.RoomPinnedEvents]:0},events_default:0}),
      expect.objectContaining({events:{[EventType.RoomPinnedEvents]:0},events_default:100})
    ])
  })

  it('requires manager custody for every operation', async () => {
    const outsider = client(OUTSIDER)
    const create = vi.spyOn(outsider, 'createRoom')
    const rooms = vi.spyOn(outsider, 'getJoinedRooms')
    const reconcile = vi.spyOn(outsider, 'ban')

    await expect(createCompanyChannelRoom(outsider, { ...binding, name: 'Engineering' })).rejects.toThrow(
      'matrix_company_channel_room_required'
    )
    await expect(findCompanyChannelRoom(outsider, binding)).rejects.toThrow('matrix_company_channel_room_required')
    await expect(readCompanyChannelRoom(outsider, channelTarget)).rejects.toThrow('matrix_company_channel_room_required')
    await expect(reconcileCompanyChannelRoom(outsider, channelTarget)).rejects.toThrow('matrix_company_channel_room_required')
    expect(create).not.toHaveBeenCalled()
    expect(rooms).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('requires exact current members and an explicit ban witness for each removed person', async () => {
    const witnessed = validState([member(MEMBER, 'invite'), member(FORMER, 'ban')])
    const removedWitness = { ...channelTarget, memberUserIds: [MEMBER], bannedUserIds: [FORMER] }

    await expect(readCompanyChannelRoom(client(MANAGER, witnessed), removedWitness)).resolves.toMatchObject({ roomId: ROOM_ID })

    const noWitness = validState([member(MEMBER, 'invite'), member(FORMER, 'leave')])
    await expect(readCompanyChannelRoom(client(MANAGER, noWitness), removedWitness)).rejects.toThrow(
      'matrix_company_channel_room_required'
    )

    for (const membership of ['join', 'invite', 'knock']) {
      await expect(readCompanyChannelRoom(client(MANAGER, validState([
        member(MEMBER, 'join'), member(OUTSIDER, membership)
      ])), channelTarget)).rejects.toThrow('matrix_company_channel_room_required')
    }
  })

  it('admits the combined human plus service-member ceiling used by reader reconciliation', async () => {
    const members = Array.from({length:101},(_,index)=>`@combined-${String(index+1).padStart(3,'0')}:test`)
    const target = {...channelTarget,memberUserIds:members}
    await expect(readCompanyChannelRoom(client(MANAGER,validState(members.map(id=>member(id,'invite')))),target))
      .resolves.toMatchObject({roomId:ROOM_ID})
  })

  it('bans outsiders, records removed-member bans, unbans and invites active members, then strictly rereads', async () => {
    const before = validState([member(MEMBER, 'ban'), member(OUTSIDER, 'join'), member(FORMER, 'leave')])
    const after = validState([member(MEMBER, 'invite'), member(OUTSIDER, 'ban'), member(FORMER, 'ban')])
    const input = { ...channelTarget, bannedUserIds: [FORMER, OUTSIDER] }
    const value = client()
    const roomState = vi.spyOn(value, 'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const ban = vi.spyOn(value, 'ban').mockResolvedValue({})
    const unban = vi.spyOn(value, 'unban').mockResolvedValue({})
    const invite = vi.spyOn(value, 'invite').mockResolvedValue({})

    await expect(reconcileCompanyChannelRoom(value, input)).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(ban).toHaveBeenCalledWith(ROOM_ID, OUTSIDER)
    expect(ban).toHaveBeenCalledWith(ROOM_ID, FORMER)
    expect(unban).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(invite).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(roomState).toHaveBeenCalledTimes(2)
  })

  it('returns membership and join-event observations from the final strict Matrix read', async () => {
    const joined = member(MEMBER, 'join')
    const banned = member(FORMER, 'ban')
    const invited = member(OUTSIDER, 'invite')
    const target = {...channelTarget, memberUserIds: [MEMBER, OUTSIDER], bannedUserIds: [FORMER]}

    await expect(reconcileCompanyChannelRoom(client(MANAGER, validState([joined, banned, invited])), target))
      .resolves.toMatchObject({
        roomId: ROOM_ID,
        membershipObservations: [
          {userId: FORMER, membership: 'ban', joinEventId: null},
          {userId: MEMBER, membership: 'join', joinEventId: joined.event_id},
          {userId: OUTSIDER, membership: 'invite', joinEventId: null}
        ]
      })
  })

  it('changes posting solely through events_default and reads the archived policy back strictly', async () => {
    const archived = validState()
    archived[1]!.content.events_default = 100
    const archivedTarget = { ...channelTarget, posting: 'archived_read_only' as const }
    const value = client()

    // Initial read (open), the strict readback that proves the closure, then the final strict read.
    const roomState = vi.spyOn(value, 'roomState').mockResolvedValueOnce(validState()).mockResolvedValueOnce(archived)
      .mockResolvedValueOnce(archived)

    const setPower = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyChannelRoom(value, archivedTarget)).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(setPower).toHaveBeenCalledWith(ROOM_ID, EventType.RoomPowerLevels, expect.objectContaining({ events_default: 100 }), '')
    expect(roomState).toHaveBeenCalledTimes(3)
    await expect(readCompanyChannelRoom(client(MANAGER, archived), archivedTarget)).resolves.toMatchObject({ roomId: ROOM_ID })
    await expect(readCompanyChannelRoom(client(MANAGER, archived), channelTarget)).rejects.toThrow(
      'matrix_company_channel_room_required'
    )
  })

  it.each(['encrypted', 'history', 'binding', 'power'])(
    'denies %s drift rather than accepting a lookalike room',
    async drift => {
      const events = validState()

      if (drift === 'encrypted') {
        events.push(state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }))
      }

      if (drift === 'history') {events[2]!.content.history_visibility = 'joined'}

      if (drift === 'binding') {
        Reflect.set(events[0]!.content[MATRIX_COMPANY_CHANNEL_BINDING] as object, 'companyId', binding.channelId)
      }

      if (drift === 'power') {(events[1]!.content.users as Record<string, unknown>)[MEMBER] = 100}

      await expect(readCompanyChannelRoom(client(MANAGER, events), channelTarget)).rejects.toThrow(
        'matrix_company_channel_room_required'
      )
    }
  )

  it('denies predecessor/additional-creator metadata, duplicate state keys, and oversized member state', async () => {
    for (const field of ['predecessor', 'additional_creators'] as const) {
      const events = validState()
      events[0]!.content[field] = field === 'predecessor' ? { room_id: OTHER_ROOM_ID } : [OUTSIDER]
      await expect(readCompanyChannelRoom(client(MANAGER, events), channelTarget)).rejects.toThrow(
        'matrix_company_channel_room_required'
      )
    }

    await expect(readCompanyChannelRoom(client(MANAGER, validState([
      member(MEMBER, 'join'), member(MEMBER, 'invite')
    ])), channelTarget)).rejects.toThrow('matrix_company_channel_room_required')

    const oversized = validState(Array.from({ length: 1001 }, (_, index) =>
      member(`@member-${index}:test`, 'knock')))

    await expect(readCompanyChannelRoom(client(MANAGER, oversized), channelTarget)).rejects.toThrow(
      'matrix_company_channel_room_required'
    )
  })

  it('denies a stale callback after a server read and emits deterministic hexadecimal witnesses', async () => {
    let active = true
    const stale = client()
    vi.spyOn(stale, 'roomState').mockImplementation(async () => {
      active = false

      return validState()
    })
    await expect(readCompanyChannelRoom(stale, channelTarget, () => active)).rejects.toThrow(
      'matrix_company_channel_room_required'
    )

    const witness = await readCompanyChannelRoom(client(), channelTarget)
    expect(witness).toEqual({
      roomId: ROOM_ID,
      roomDigest: '1412b5f2d98b7e5c20d58b843791d4087845ad3305c44ae1b4d23eef12e9a165',
      policyWitness: '942e393bc7cd524e57f5a8fa6cab685defdebc231d29ef1ad89ecddbbbff502e'
    })
    expect(witness.roomDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(witness.policyWitness).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('company-channel-rooms/1.1 manager effects', () => {
  const WITHDRAWN = '@withdrawn:test'
  const UNCERTAIN = '@uncertain:test'

  it('grants only the exact room-mention set power 50 while every moderation threshold stays 100', async () => {
    const before = validState()
    const after = before.map(event =>
      event.type === EventType.RoomPowerLevels
        ? state(EventType.RoomPowerLevels, '', {
            ...event.content,
            users: { [MANAGER]: 100, [MEMBER]: 50 },
            notifications: { room: 50 }
          })
        : event
    )
    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const send = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    await expect(
      reconcileCompanyChannelRoom(value, { ...channelTarget, roomMentionUserIds: [MEMBER] })
    ).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(send).toHaveBeenCalledWith(
      ROOM_ID,
      EventType.RoomPowerLevels,
      expect.objectContaining({
        users: { [MANAGER]: 100, [MEMBER]: 50 },
        state_default: 100,
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 100,
        notifications: { room: 50 }
      }),
      ''
    )
  })

  it('bans every exclusion and possible grant, including an invitation that never produced a member event', async () => {
    const before = validState([member(MEMBER, 'join'), member(WITHDRAWN, 'invite'), member(FORMER, 'join')])

    const after = validState([
      member(MEMBER, 'join'), member(WITHDRAWN, 'ban'), member(FORMER, 'ban'), member(UNCERTAIN, 'ban')
    ])

    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const ban = vi.spyOn(value, 'ban').mockResolvedValue({})
    const invite = vi.spyOn(value, 'invite').mockResolvedValue({})

    // WITHDRAWN: issued invite; FORMER: acknowledged join; UNCERTAIN: reply lost, no member event at all.
    await expect(reconcileCompanyChannelRoom(value, {
      ...channelTarget, bannedUserIds: [FORMER, WITHDRAWN, UNCERTAIN]
    })).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(ban.mock.calls.map(call => call[1]).sort()).toEqual([FORMER, UNCERTAIN, WITHDRAWN])
    expect(invite).not.toHaveBeenCalled()
  })

  it('never reports a possible grant witnessed when the readback still shows it joined or invited', async () => {
    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValue(validState([member(MEMBER, 'join'), member(UNCERTAIN, 'invite')]))
    vi.spyOn(value, 'ban').mockResolvedValue({})

    await expect(reconcileCompanyChannelRoom(value, { ...channelTarget, bannedUserIds: [UNCERTAIN] })).rejects.toThrow(
      'matrix_company_channel_room_required'
    )
  })

  it('unbans the old-epoch identity before inviting the new epoch (#general readmission)', async () => {
    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValueOnce(validState([member(MEMBER, 'ban')]))
      .mockResolvedValueOnce(validState([member(MEMBER, 'invite')]))
    const unban = vi.spyOn(value, 'unban').mockResolvedValue({})
    const invite = vi.spyOn(value, 'invite').mockResolvedValue({})

    await reconcileCompanyChannelRoom(value, channelTarget)
    expect(unban).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(invite).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(unban.mock.invocationCallOrder[0]!).toBeLessThan(invite.mock.invocationCallOrder[0]!)
  })

  it('applies name and topic through manager power and reads them back strictly', async () => {
    const named = validState()
    const metadata = { displayName: 'Engineering', topic: 'Ship it\nweekly' }

    const after = [...named, state(EventType.RoomName, '', { name: 'Engineering' }),
      state(EventType.RoomTopic, '', { topic: 'Ship it\nweekly' })]

    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValueOnce(named).mockResolvedValueOnce(after)
    const send = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyChannelRoom(value, { ...channelTarget, ...metadata })).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(send).toHaveBeenCalledWith(ROOM_ID, EventType.RoomName, { name: 'Engineering' }, '')
    expect(send).toHaveBeenCalledWith(ROOM_ID, EventType.RoomTopic, { topic: 'Ship it\nweekly' }, '')
    await expect(readCompanyChannelRoom(client(MANAGER, after), { ...channelTarget, ...metadata })).resolves.toMatchObject({
      roomId: ROOM_ID
    })
    await expect(readCompanyChannelRoom(client(MANAGER, after), { ...channelTarget, displayName: 'Other' })).rejects.toThrow(
      'matrix_company_channel_room_required'
    )
    // An unset topic is the empty string; nothing is written when it already matches.
    const quiet = client()
    vi.spyOn(quiet, 'roomState').mockResolvedValue(validState())
    const none = vi.spyOn(quiet, 'sendStateEvent').mockResolvedValue({} as never)

    await reconcileCompanyChannelRoom(quiet, { ...channelTarget, topic: '' })
    expect(none).not.toHaveBeenCalled()
  })

  it('writes the company m.room.avatar and reads the exact MXC URI back before returning', async () => {
    const avatarUri = 'mxc://matrix.atum.app/company-logo'
    const after = [...validState(), state(EventType.RoomAvatar, '', { url: avatarUri })]
    const value = client()
    const roomState = vi.spyOn(value, 'roomState').mockResolvedValueOnce(validState()).mockResolvedValueOnce(after)
    const send = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyChannelRoom(value, { ...channelTarget, avatarUri }))
      .resolves.toMatchObject({ roomId: ROOM_ID })
    expect(send).toHaveBeenCalledWith(ROOM_ID, EventType.RoomAvatar, { url: avatarUri }, '')
    expect(roomState).toHaveBeenCalledTimes(2)
    await expect(readCompanyChannelRoom(client(MANAGER, after), { ...channelTarget, avatarUri }))
      .resolves.toMatchObject({ roomId: ROOM_ID })
  })

  it('refuses malformed metadata before any Matrix write', async () => {
    const value = client()
    const send = vi.spyOn(value, 'sendStateEvent').mockResolvedValue({} as never)

    for (const bad of [{ displayName: '' }, { displayName: ' padded' }, { displayName: 'x'.repeat(81) },
      { topic: 'x'.repeat(251) }, { topic: 'bell\u0007' }, { avatarUri: 'https://cdn.atum.app/logo.png' }]) {
      await expect(reconcileCompanyChannelRoom(value, { ...channelTarget, ...bad })).rejects.toThrow(
        'matrix_company_channel_room_required'
      )
    }

    expect(send).not.toHaveBeenCalled()
  })

  it('accepts the full exclusion plus possible-grant ban set a 100-person channel can carry', async () => {
    const banned = Array.from({ length: 300 }, (_, index) => `@gone-${String(index).padStart(3, '0')}:test`)
    const value = client()
    vi.spyOn(value, 'roomState').mockResolvedValue(validState([member(MEMBER, 'join'), ...banned.map(id => member(id, 'ban'))]))

    await expect(readCompanyChannelRoom(value, { ...channelTarget, bannedUserIds: banned })).resolves.toMatchObject({
      roomId: ROOM_ID
    })
  })
})

describe('company conversation room targets',()=>{
  it('creates and recovers only the exact immutable company/conversation/digest binding',async()=>{
    const value=client(MANAGER,validConversationState())
    const create=vi.spyOn(value,'createRoom').mockResolvedValue({room_id:ROOM_ID} as never)

    await expect(createCompanyRoomTarget(value,{...conversationBinding,name:'Direct message'})).resolves.toBe(ROOM_ID)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({room_version:'11',
      power_level_content_override:expect.objectContaining({events:{[EventType.RoomPinnedEvents]:0}}),
      creation_content:{type:MATRIX_COMPANY_CONVERSATION_TYPE,[MATRIX_COMPANY_CONVERSATION_BINDING]:{
        companyId:conversationBinding.companyId,
        conversationId:(conversationBinding.target as {conversationId:string}).conversationId,
        conversationKind:'dm',participantSetDigest:'d'.repeat(64)}}}))
    const recovered=discoveryClient({[ROOM_ID]:validConversationState()})
    await expect(findCompanyRoomTarget(recovered,conversationBinding)).resolves.toMatchObject({roomId:ROOM_ID})
    const creation=validConversationState()[0]!
    expect(companyRoomTargetBinding(creation.content,MANAGER)).toEqual(conversationBinding)
    Reflect.set(creation.content[MATRIX_COMPANY_CONVERSATION_BINDING] as object,'participantSetDigest','e'.repeat(64))
    await expect(findCompanyRoomTarget(discoveryClient({[ROOM_ID]:validConversationState().map((event,index)=>
      index===0?creation:event)}),conversationBinding)).resolves.toBeNull()
  })

  it('upgrades an existing company conversation with the same shared-pin permission',async()=>{
    const legacy=validConversationState();legacy[1]!.content.events={}
    const upgraded=validConversationState()
    const value=client()
    vi.spyOn(value,'roomState').mockResolvedValueOnce(legacy).mockResolvedValueOnce(upgraded).mockResolvedValueOnce(upgraded)
    const send=vi.spyOn(value,'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyRoomTarget(value,conversationTarget)).resolves.toMatchObject({roomId:ROOM_ID})
    expect(send).toHaveBeenCalledExactlyOnceWith(ROOM_ID,EventType.RoomPowerLevels,
      expect.objectContaining({events:{[EventType.RoomPinnedEvents]:0}}),'')
  })

  it('closes a participant-read-only conversation before membership work and proves the policy on readback',async()=>{
    const before=validConversationState(0)
    const closed=validConversationState(100)
    const value=client()
    const roomState=vi.spyOn(value,'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(closed)
      .mockResolvedValueOnce(closed)
    const send=vi.spyOn(value,'sendStateEvent').mockResolvedValue({} as never)

    await expect(reconcileCompanyRoomTarget(value,{...conversationTarget,posting:'participant_read_only'}))
      .resolves.toMatchObject({roomId:ROOM_ID})
    expect(send).toHaveBeenCalledWith(ROOM_ID,EventType.RoomPowerLevels,
      expect.objectContaining({events_default:100}),'')
    expect(roomState).toHaveBeenCalledTimes(3)
  })

  it('bans an excluded participant in a conversation room and proves the ban on readback',async()=>{
    const before=validConversationState(0,[member(MEMBER,'join'),member(FORMER,'leave')])
    const after=validConversationState(0,[member(MEMBER,'join'),member(FORMER,'ban')])
    const value=client()
    vi.spyOn(value,'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const ban=vi.spyOn(value,'ban').mockResolvedValue({})

    await expect(reconcileCompanyRoomTarget(value,{...conversationTarget,bannedUserIds:[FORMER]}))
      .resolves.toMatchObject({roomId:ROOM_ID})
    expect(ban).toHaveBeenCalledWith(ROOM_ID,FORMER)
  })

  it('stops between Matrix membership effects when the manager term is lost mid-pass',async()=>{
    const value=client(MANAGER,validConversationState(0,[
      member(MEMBER,'join'),member(OUTSIDER,'join'),member(FORMER,'leave')
    ]))
    let live=true
    const ban=vi.spyOn(value,'ban').mockImplementation(async()=>{live=false;return {}})

    await expect(reconcileCompanyRoomTarget(value,{...conversationTarget,bannedUserIds:[FORMER]},()=>live))
      .rejects.toThrow('matrix_company_channel_room_required')
    expect(ban.mock.calls).toEqual([[ROOM_ID,OUTSIDER]])
  })
})

describe('company channel room discovery beyond 1,000 joined rooms', () => {
  const stranger = (index: number) => [state(EventType.RoomCreate, '', { type: 'm.space', room_version: '11' },
    MANAGER, `!stranger-${index}:test`)]

  it('finds the bound room among thousands of joined rooms without a ceiling, classifying each room once', async () => {
    const rooms: Record<string, IStateEventWithRoomId[]> = {}

    for (let index = 0; index < 2500; index++) {rooms[`!stranger-${String(index).padStart(4, '0')}:test`] = stranger(index)}
    rooms[ROOM_ID] = validState()
    const value = discoveryClient(rooms)
    const read = vi.mocked(value.roomState)

    await expect(findCompanyChannelRoom(value, binding)).resolves.toMatchObject({ roomId: ROOM_ID })
    const first = read.mock.calls.length

    expect(first).toBeGreaterThanOrEqual(2501)
    // Immutable create events are remembered: a repeat pass reads only the one matching room.
    await expect(findCompanyChannelRoom(value, binding)).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(read.mock.calls.length - first).toBe(1)
  })

  it('skips rooms the synced cache already knows are not channel rooms without reading their state', async () => {
    const rooms: Record<string, IStateEventWithRoomId[]> = { [ROOM_ID]: validState() }

    for (let index = 0; index < 1200; index++) {rooms[`!other-${index}:test`] = []}
    const value = discoveryClient(rooms)
    vi.spyOn(value, 'getRoom').mockImplementation(id => (id === ROOM_ID ? null : { getType: () => 'm.space' }) as never)
    const read = vi.mocked(value.roomState)

    await expect(findCompanyChannelRoom(value, binding)).resolves.toMatchObject({ roomId: ROOM_ID })
    // One classification of the unknown room, one strict policy read of the match; none of the 1,200 others.
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never calls a room missing while its state is incomplete, so no duplicate is created, and finds it once it is complete', async () => {
    // Joined, but its create event has not arrived: the synced cache has no type and the server answer has no create.
    const rooms: Record<string, IStateEventWithRoomId[]> = { [ROOM_ID]: [] }
    const value = discoveryClient(rooms)
    vi.spyOn(value, 'getRoom').mockReturnValue({ getType: () => undefined } as never)
    const create = vi.spyOn(value, 'createRoom')

    // "Not found" would let the manager's next create attempt make a second room carrying the same binding.
    await expect(findCompanyChannelRoom(value, binding)).rejects.toThrow('matrix_company_channel_room_required')
    await expect(findCompanyChannelRoom(value, binding)).rejects.toThrow('matrix_company_channel_room_required')
    expect(create).not.toHaveBeenCalled()

    // Nothing was remembered about it, so the same room is read again, found, and bound as itself.
    rooms[ROOM_ID] = validState()
    await expect(findCompanyChannelRoom(value, binding)).resolves.toMatchObject({ roomId: ROOM_ID })
    expect(create).not.toHaveBeenCalled()
  })

  it('does not let a stale local room type hide the manager\'s own room for good', async () => {
    const value = discoveryClient({ [ROOM_ID]: validState() })
    const local = vi.spyOn(value, 'getRoom').mockReturnValue({ getType: () => 'm.space' } as never)

    // The cache wrongly says it is some other kind of room: skipped this pass, but nothing is recorded.
    await expect(findCompanyChannelRoom(value, binding)).resolves.toBeNull()
    local.mockReturnValue({ getType: () => MATRIX_COMPANY_CHANNEL_TYPE } as never)
    await expect(findCompanyChannelRoom(value, binding)).resolves.toMatchObject({ roomId: ROOM_ID })
  })

  it('stops paging when authority is withdrawn and keeps the conflict rule across pages', async () => {
    let active = true
    const rooms: Record<string, IStateEventWithRoomId[]> = {}

    for (let index = 0; index < 400; index++) {rooms[`!stranger-${index}:test`] = stranger(index)}
    const value = discoveryClient(rooms)
    vi.mocked(value.roomState).mockImplementation(async () => {
      active = false

      return []
    })
    await expect(findCompanyChannelRoom(value, binding, () => active)).rejects.toThrow('matrix_company_channel_room_required')

    const twins: Record<string, IStateEventWithRoomId[]> = { [ROOM_ID]: validState(), [OTHER_ROOM_ID]: validState() }

    for (let index = 0; index < 1100; index++) {twins[`!stranger-${index}:test`] = stranger(index)}
    await expect(findCompanyChannelRoom(discoveryClient(twins), binding)).rejects.toThrow(
      'matrix_company_channel_room_conflict'
    )
  })
})

describe('company channel room discovery with a joined room that will not answer', () => {
  const STUCK = '!stuck:test'
  const OTHER_CHANNEL = '00000000-0000-4000-8000-f6222a1106ee'

  afterEach(() => { vi.useRealTimers() })

  /**
   * A joined room whose state answer has no create event. The client's synced copy of the room is a real `Room`: its
   * create event says who made it, for which channel (or, for `unsynced`, it has none yet).
   */
  function stuckRoom(made: 'foreign' | 'sibling' | 'target' | 'unsynced') {
    const value = discoveryClient({ [STUCK]: [] })
    const room = new Room(STUCK, value, MANAGER)

    if (made !== 'unsynced') {
      room.currentState.setStateEvents([new MatrixEvent(state(EventType.RoomCreate, '', {
        type: MATRIX_COMPANY_CHANNEL_TYPE,
        room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
        [MATRIX_COMPANY_CHANNEL_BINDING]: {
          companyId: binding.companyId, channelId: made === 'target' ? binding.channelId : OTHER_CHANNEL
        }
      }, made === 'foreign' ? OUTSIDER : MANAGER, STUCK))])
    }

    vi.spyOn(value, 'getRoom').mockReturnValue(room)

    return { value, leave: vi.spyOn(value, 'leave').mockResolvedValue({}), create: vi.spyOn(value, 'createRoom') }
  }

  it('answers "none" for a room somebody else made, so creation proceeds, and leaves it once it has stayed unreadable a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { value, leave, create } = stuckRoom('foreign')

    for (const at of [0, 30_000, 59_999]) {
      vi.setSystemTime(at)
      await expect(findCompanyChannelRoom(value, binding)).resolves.toBeNull()
    }

    expect(leave).not.toHaveBeenCalled()
    vi.setSystemTime(60_000)
    await expect(findCompanyChannelRoom(value, binding)).resolves.toBeNull()
    expect(leave).toHaveBeenCalledTimes(1)
    expect(leave).toHaveBeenCalledWith(STUCK)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses, and never leaves, a room whose create event has not synced either', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { value, leave, create } = stuckRoom('unsynced')

    for (let at = 0; at <= 600_000; at += 60_000) {
      vi.setSystemTime(at)
      await expect(findCompanyChannelRoom(value, binding)).rejects.toThrow('matrix_company_channel_room_required')
    }

    expect(leave).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('never leaves its own room for another channel, which may be bound, and does not let it stop this channel\'s creation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { value, leave } = stuckRoom('sibling')

    for (let at = 0; at <= 600_000; at += 60_000) {
      vi.setSystemTime(at)
      await expect(findCompanyChannelRoom(value, binding)).resolves.toBeNull()
    }

    expect(leave).not.toHaveBeenCalled()
  })

  it('refuses, and never leaves, a room it made for this very channel that it cannot read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { value, leave, create } = stuckRoom('target')

    for (let at = 0; at <= 600_000; at += 60_000) {
      vi.setSystemTime(at)
      await expect(findCompanyChannelRoom(value, binding)).rejects.toThrow('matrix_company_channel_room_required')
    }

    expect(leave).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('archive and restore are ordered so an interrupted pass never leaves the wrong room writable', () => {
  const NEWBIE = '@newbie:test'
  type Step = 'ban' | 'unban' | 'invite' | 'name' | 'topic' | 'power'

  interface Live { eventsDefault: number, members: Record<string, string>, name: string, topic: string }

  // The room the server holds. Every Matrix write below mutates it, so each assertion is about the room's real posting
  // policy at the moment a pass died, not about which mocks happened to be called.
  function liveState(model: Live): IStateEventWithRoomId[] {
    const events = validState(Object.entries(model.members).map(([id, membership]) => member(id, membership)))

    events[1]!.content.events_default = model.eventsDefault
    events.push(state(EventType.RoomName, '', { name: model.name }), state(EventType.RoomTopic, '', { topic: model.topic }))

    return events
  }

  function liveRoom(model: Live, options: { fail?: Step, stuckPower?: boolean } = {}) {
    const value = client()
    const log: string[] = []

    const attempt = (step: Step, entry: string) => {
      log.push(entry)

      if (options.fail === step) {throw new Error(`injected ${step} failure`)}
    }

    vi.spyOn(value, 'roomState').mockImplementation(async () => {
      log.push('read')

      return liveState(model)
    })
    vi.spyOn(value, 'ban').mockImplementation(async (_room, id) => {
      attempt('ban', `ban:${id}`)
      model.members[id] = 'ban'

      return {}
    })
    vi.spyOn(value, 'unban').mockImplementation(async (_room, id) => {
      attempt('unban', `unban:${id}`)
      model.members[id] = 'leave'

      return {}
    })
    vi.spyOn(value, 'invite').mockImplementation(async (_room, id) => {
      attempt('invite', `invite:${id}`)
      model.members[id] = 'invite'

      return {}
    })
    vi.spyOn(value, 'sendStateEvent').mockImplementation((async (_room: string, type: string, content: Record<string, unknown>) => {
      if (type === EventType.RoomPowerLevels) {
        attempt('power', `power:${String(content.events_default)}`)

        if (!options.stuckPower) {model.eventsDefault = Number(content.events_default)}
      } else if (type === EventType.RoomName) {
        attempt('name', 'name')
        model.name = String(content.name)
      } else {
        attempt('topic', 'topic')
        model.topic = String(content.topic)
      }

      return {}
    }) as never)

    return { client: value, log }
  }

  const writes = (log: string[]) => log.filter(entry => entry !== 'read')
  const metadataWrite = (entry: string) => ['name', 'topic'].includes(entry)

  describe('archive (open to read-only)', () => {
    const archive = { ...channelTarget, memberUserIds: [MEMBER, NEWBIE], bannedUserIds: [FORMER],
      posting: 'archived_read_only' as const, displayName: 'Old plans', topic: 'closed' }

    const openRoom = (): Live => ({ eventsDefault: 0, name: 'Plans', topic: '',
      members: { [MEMBER]: 'join', [OUTSIDER]: 'join', [FORMER]: 'join' } })

    it('closes the room first, proves it closed with a strict readback, and only then changes membership and metadata', async () => {
      const model = openRoom()
      const room = liveRoom(model)

      await expect(reconcileCompanyChannelRoom(room.client, archive)).resolves.toMatchObject({ roomId: ROOM_ID })
      expect(writes(room.log)[0]).toBe('power:100')
      // initial read, [closure], strict readback, ... membership and metadata ..., final strict read
      expect(room.log.slice(0, 3)).toEqual(['read', 'power:100', 'read'])
      expect(room.log.filter(entry => entry === 'read')).toHaveLength(3)
      expect(writes(room.log).slice(1).some(entry => entry.startsWith('power'))).toBe(false)
      expect(model).toMatchObject({ eventsDefault: 100, name: 'Old plans', topic: 'closed',
        members: { [MEMBER]: 'join', [OUTSIDER]: 'ban', [FORMER]: 'ban', [NEWBIE]: 'invite' } })
    })

    it.each(['ban', 'invite', 'name', 'topic'] as const)(
      'leaves the room read-only when the pass fails at %s after the closure',
      async step => {
        const model = openRoom()
        const room = liveRoom(model, { fail: step })

        await expect(reconcileCompanyChannelRoom(room.client, archive)).rejects.toThrow(`injected ${step} failure`)
        expect(model.eventsDefault).toBe(100)
        const attempted = room.log.findIndex(entry => entry === step || entry.startsWith(`${step}:`))

        expect(attempted).toBeGreaterThan(room.log.indexOf('power:100'))
      }
    )

    it('changes nothing else when the closure itself fails', async () => {
      const model = openRoom()
      const room = liveRoom(model, { fail: 'power' })

      await expect(reconcileCompanyChannelRoom(room.client, archive)).rejects.toThrow('injected power failure')
      expect(writes(room.log)).toEqual(['power:100'])
      expect(model).toMatchObject({ eventsDefault: 0, name: 'Plans', topic: '',
        members: { [MEMBER]: 'join', [OUTSIDER]: 'join', [FORMER]: 'join' } })
    })

    it('stops before touching membership when the readback shows the room is still writable', async () => {
      const model = openRoom()
      const room = liveRoom(model, { stuckPower: true })

      await expect(reconcileCompanyChannelRoom(room.client, archive)).rejects.toThrow('matrix_company_channel_room_required')
      expect(writes(room.log)).toEqual(['power:100'])
      expect(model.members).toEqual({ [MEMBER]: 'join', [OUTSIDER]: 'join', [FORMER]: 'join' })
    })

    it('resumes an interrupted archive without closing the room a second time', async () => {
      const model = openRoom()

      await expect(reconcileCompanyChannelRoom(liveRoom(model, { fail: 'ban' }).client, archive)).rejects.toThrow('injected ban failure')
      expect(model.eventsDefault).toBe(100)
      const resumed = liveRoom(model)

      await expect(reconcileCompanyChannelRoom(resumed.client, archive)).resolves.toMatchObject({ roomId: ROOM_ID })
      expect(writes(resumed.log).some(entry => entry.startsWith('power'))).toBe(false)
      expect(model).toMatchObject({ eventsDefault: 100, name: 'Old plans', topic: 'closed',
        members: { [MEMBER]: 'join', [OUTSIDER]: 'ban', [FORMER]: 'ban', [NEWBIE]: 'invite' } })
    })
  })

  describe('restore (read-only to open)', () => {
    const restore = { ...channelTarget, memberUserIds: [MEMBER, NEWBIE], bannedUserIds: [OUTSIDER],
      posting: 'open' as const, displayName: 'Plans', topic: 'back' }

    const closedRoom = (): Live => ({ eventsDefault: 100, name: 'Old plans', topic: 'closed',
      members: { [MEMBER]: 'ban', [OUTSIDER]: 'join' } })

    it('reopens posting last, after every ban, invite and metadata write', async () => {
      const model = closedRoom()
      const room = liveRoom(model)

      await expect(reconcileCompanyChannelRoom(room.client, restore)).resolves.toMatchObject({ roomId: ROOM_ID })
      const done = writes(room.log)

      expect(done.at(-1)).toBe('power:0')
      expect(done.filter(entry => entry.startsWith('power'))).toEqual(['power:0'])
      expect(done.slice(0, -1).some(entry => entry.startsWith('ban:'))).toBe(true)
      expect(done.slice(0, -1).some(metadataWrite)).toBe(true)
      expect(model).toMatchObject({ eventsDefault: 0, name: 'Plans', topic: 'back',
        members: { [MEMBER]: 'invite', [OUTSIDER]: 'ban', [NEWBIE]: 'invite' } })
    })

    it.each(['ban', 'unban', 'invite', 'name', 'topic'] as const)(
      'is not yet writable when the pass fails at %s before the reopening',
      async step => {
        const model = closedRoom()
        const room = liveRoom(model, { fail: step })

        await expect(reconcileCompanyChannelRoom(room.client, restore)).rejects.toThrow(`injected ${step} failure`)
        expect(model.eventsDefault).toBe(100)
        expect(room.log.includes('power:0')).toBe(false)
      }
    )

    it('is still read-only, with all membership work done, when the final reopening fails', async () => {
      const model = closedRoom()
      const room = liveRoom(model, { fail: 'power' })

      await expect(reconcileCompanyChannelRoom(room.client, restore)).rejects.toThrow('injected power failure')
      expect(writes(room.log).at(-1)).toBe('power:0')
      expect(model).toMatchObject({ eventsDefault: 100, name: 'Plans', topic: 'back',
        members: { [MEMBER]: 'invite', [OUTSIDER]: 'ban', [NEWBIE]: 'invite' } })
    })

    it('resumes an interrupted restore and reopens only once everything else has landed', async () => {
      const model = closedRoom()

      await expect(reconcileCompanyChannelRoom(liveRoom(model, { fail: 'invite' }).client, restore)).rejects.toThrow(
        'injected invite failure'
      )
      expect(model.eventsDefault).toBe(100)
      const resumed = liveRoom(model)

      await expect(reconcileCompanyChannelRoom(resumed.client, restore)).resolves.toMatchObject({ roomId: ROOM_ID })
      expect(writes(resumed.log).filter(entry => entry.startsWith('power'))).toEqual(['power:0'])
      expect(model).toMatchObject({ eventsDefault: 0, members: { [MEMBER]: 'invite', [NEWBIE]: 'invite', [OUTSIDER]: 'ban' } })
    })
  })

  it('never rewrites posting when it already matches', async () => {
    const open = liveRoom({ eventsDefault: 0, name: 'Plans', topic: '', members: { [MEMBER]: 'join' } })

    await reconcileCompanyChannelRoom(open.client, channelTarget)
    expect(writes(open.log)).toEqual([])
    const archived = liveRoom({ eventsDefault: 100, name: 'Plans', topic: '', members: { [MEMBER]: 'join' } })

    await reconcileCompanyChannelRoom(archived.client, { ...channelTarget, posting: 'archived_read_only' })
    expect(writes(archived.log)).toEqual([])
  })
})

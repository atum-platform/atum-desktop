import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import {
  type AgentTaskBinding,
  agentTaskBindingWire,
  MATRIX_AGENT_TASK_COORDINATOR_TYPE,
  MATRIX_AGENT_TASK_KEY,
  MATRIX_AGENT_TASK_ROOM_TYPE,
  MATRIX_AGENT_TASK_START_TYPE
} from '../../shared/agent-task'
import { MATRIX_APP_GROUP_BINDING, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'

import {
  matrixNoticeTransaction,
  publishMatrixGroupNotice,
  publishMatrixNotice,
  publishMatrixResult
} from './publish-result'

it.each(['group-app', 'group-human', 'private', 'hermes', 'unknown', 'malformed'])(
  'shares to joined unverified devices only for the bound group app: %s',
  async mode => {
    const client = createClient({
      baseUrl: 'https://matrix.test',
      userId: mode === 'group-human' ? '@owner:test' : '@app:test'
    })

    const room = new Room('!group:test', client, client.getSafeUserId())

    const content = mode.startsWith('group')
      ? { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app: '@app:test' } }
      : mode === 'private'
        ? {}
        : {
            type:
              mode === 'hermes'
                ? 'io.atum.assistant'
                : mode === 'malformed'
                  ? MATRIX_APP_GROUP_TYPE
                  : 'io.atum.app_group.v2'
          }

    room.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomCreate,
        state_key: '',
        room_id: room.roomId,
        event_id: '$create',
        sender: '@owner:test',
        content
      }),
      new MatrixEvent({
        type: EventType.RoomEncryption,
        state_key: '',
        room_id: room.roomId,
        event_id: '$encryption',
        sender: '@owner:test',
        content: { algorithm: 'm.megolm.v1.aes-sha2' }
      })
    ])
    room.updateMyMembership('join')
    client.store.storeRoom(room)

    const send = vi.spyOn(client, 'sendEvent').mockImplementation(async () => {
      expect(room.getBlacklistUnverifiedDevices()).toBe(mode === 'group-app' ? false : null)

      return { event_id: '$reply' }
    })

    const command = {
      kind: 'publishResult' as const,
      roomId: room.roomId,
      eventId: '$request',
      body: 'Reply',
      invocationId: 'invocation',
      transactionId: 'transaction'
    }

    expect(await publishMatrixResult(client, command)).toBe('$reply')
    expect(await publishMatrixResult(client, command)).toBe('$reply')
    expect(send).toHaveBeenCalledTimes(2)
    room.updateMyMembership('leave')
    await expect(publishMatrixResult(client, command)).rejects.toThrow('matrix_encrypted_room_required')
    expect(send).toHaveBeenCalledTimes(2)
  }
)

it('marks a local-path answer and posts a standard reply under its own fixed transaction ID', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$answer' })
  const turnId = '00000000-0000-4000-8000-31f949766961'

  const command = {
    kind: 'publishResult' as const,
    roomId: room.roomId,
    eventId: '$question',
    body: 'Answer',
    invocationId: turnId,
    transactionId: `atum-a-${turnId}`,
    turnId,
    matrixTransactionId: `atum-a-${turnId}`
  }

  expect(await publishMatrixResult(client, command)).toBe('$answer')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    expect.objectContaining({
      body: 'Answer',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
      'io.atum.turn': turnId
    }),
    `atum-a-${turnId}`
  )
  await expect(publishMatrixResult(client, { ...command, turnId: 'not-a-turn' })).rejects.toThrow(
    'matrix_command_invalid'
  )

  // An answer by an assistant latched to Google carries the provenance mark the cloud
  // companion refuses (spec/awareness/v1 §3.7); an ordinary answer carries none.
  expect(send.mock.calls[0]![2]).not.toHaveProperty('io.atum.provenance')
  await publishMatrixResult(client, { ...command, google: true })
  expect(send.mock.lastCall![2]).toMatchObject({ 'io.atum.provenance': { v: 1, google: true } })
})

it('marks one part of a split answer with its position, under that part’s own transaction, and refuses a bad one', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$part' })
  const turnId = '00000000-0000-4000-8000-31f949766961'

  const command = {
    kind: 'publishResult' as const,
    roomId: room.roomId,
    eventId: '$question',
    body: 'The second part of a long answer',
    invocationId: turnId,
    transactionId: `atum-a-${turnId}`,
    turnId,
    matrixTransactionId: `atum-a-${turnId}-p1`,
    part: { index: 1, count: 3 }
  }

  expect(await publishMatrixResult(client, command)).toBe('$part')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    expect.objectContaining({
      body: 'The second part of a long answer',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
      'io.atum.turn': turnId,
      'io.atum.part': { index: 1, count: 3 },
      'io.atum.result': { invocation: turnId, transaction: `atum-a-${turnId}` }
    }),
    `atum-a-${turnId}-p1`
  )

  for (const part of [{ index: 3, count: 3 }, { index: 0, count: 1 }, { index: -1, count: 2 }]) {
    await expect(publishMatrixResult(client, { ...command, part })).rejects.toThrow('matrix_command_invalid')
  }

  // A one-message answer carries no position at all.
  const { part: _part, ...whole } = command
  await publishMatrixResult(client, whole)
  expect(send.mock.lastCall![2]).not.toHaveProperty('io.atum.part')
  expect(send).toHaveBeenCalledTimes(2)
})

it('keeps task completion separate from a cosmetic answer status', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@target:test' })
  const room = new Room('!task:test', client, client.getSafeUserId())
  const now = Date.now()
  const binding: AgentTaskBinding = {
    v: 1,
    taskId: '00000000-0000-4000-8000-bd7662a5eeb4',
    owner: '@owner:test',
    originPrincipal: '00000000-0000-4000-8000-b454f82c5857',
    originUser: '@origin:test',
    targetPrincipal: '00000000-0000-4000-8000-f6222a1106ee',
    targetUser: '@target:test',
    mainPrincipal: '00000000-0000-4000-8000-f1d11edf5c5c',
    mainUser: '@main:test',
    createdAt: now - 1_000,
    expiresAt: now + 60_000
  }
  const create = new MatrixEvent({
    type: EventType.RoomCreate,
    state_key: '',
    room_id: room.roomId,
    event_id: '$create:test',
    sender: binding.originUser,
    content: { type: MATRIX_AGENT_TASK_ROOM_TYPE, [MATRIX_AGENT_TASK_KEY]: agentTaskBindingWire(binding) }
  })
  room.currentState.setStateEvents([create])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  vi.spyOn(client, 'getCrypto').mockReturnValue({ isEncryptionEnabledInRoom: async () => false } as never)
  vi.spyOn(client, 'roomState').mockResolvedValue([
    { type: EventType.RoomCreate, state_key: '', sender: binding.originUser,
      content: { type: MATRIX_AGENT_TASK_ROOM_TYPE, [MATRIX_AGENT_TASK_KEY]: agentTaskBindingWire(binding) } },
    { type: EventType.RoomHistoryVisibility, state_key: '', sender: binding.originUser,
      content: { history_visibility: 'invited' } },
    { type: EventType.RoomPowerLevels, state_key: '', sender: binding.originUser,
      content: {
        users: { [binding.owner]: 100, [binding.originUser]: 50 }, users_default: 0,
        events: { [MATRIX_AGENT_TASK_START_TYPE]: 50, [MATRIX_AGENT_TASK_COORDINATOR_TYPE]: 100 },
        events_default: 0, state_default: 100, invite: 50, kick: 100, ban: 100, redact: 100,
        notifications: { room: 100 }
      } },
    ...[binding.owner, binding.originUser, binding.targetUser, binding.mainUser].map(userId => ({
      type: EventType.RoomMember, state_key: userId, sender: userId, content: { membership: 'join' }
    }))
  ] as never)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$result:test' })
  const command = {
    kind: 'publishResult' as const,
    roomId: room.roomId,
    eventId: '$start:test',
    body: 'Complete, but memory was not saved.',
    invocationId: '00000000-0000-4000-8000-fbfe405ca65f',
    transactionId: '00000000-0000-4000-8000-a9703d75e616',
    task: true as const,
    taskOutcome: 'completed' as const,
    status: 'memory_not_saved'
  }

  await expect(publishMatrixResult(client, command)).resolves.toBe('$result:test')
  expect(send.mock.calls[0]![2]).toMatchObject({
    [MATRIX_AGENT_TASK_KEY]: expect.objectContaining({ kind: 'completed' }),
    'io.atum.result': expect.objectContaining({ status: 'memory_not_saved' })
  })
  await expect(publishMatrixResult(client, { ...command, taskOutcome: undefined })).rejects.toThrow('matrix_command_invalid')

  const ordinary = createClient({ baseUrl: 'https://matrix.test', userId: '@target:test' })
  const ordinaryRoom = new Room('!ordinary:test', ordinary, ordinary.getSafeUserId())
  ordinaryRoom.updateMyMembership('join')
  ordinary.store.storeRoom(ordinaryRoom)
  await expect(publishMatrixResult(ordinary, { ...command, roomId: ordinaryRoom.roomId })).rejects.toThrow(
    'matrix_command_invalid'
  )
})

it("posts the agent's line about a held message as a notice replying to it, under one transaction per message", async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$notice' })

  const command = {
    kind: 'publishNotice' as const,
    roomId: room.roomId,
    eventId: '$held',
    body: 'I couldn’t read the message you replied to — could you say it again?'
  }

  // A notice (automated status, never a turn or an answer) that names the message it is about.
  expect(await publishMatrixNotice(client, command)).toBe('$notice')
  expect(send).toHaveBeenLastCalledWith(
    room.roomId,
    EventType.RoomMessage,
    { msgtype: 'm.notice', body: command.body, 'm.relates_to': { 'm.in_reply_to': { event_id: '$held' } } },
    matrixNoticeTransaction('$held')
  )

  // Sent again, it is the same transaction: the server keeps one line per message.
  await publishMatrixNotice(client, command)
  expect(send.mock.calls[1][3]).toBe(send.mock.calls[0][3])
  expect(matrixNoticeTransaction('$other')).not.toBe(matrixNoticeTransaction('$held'))
  // Older rooms' ids carry other characters; two ids never share a transaction.
  expect(matrixNoticeTransaction('$a+b:server')).not.toBe(matrixNoticeTransaction('$a/b:server'))
  expect(matrixNoticeTransaction('$a.2b')).not.toBe(matrixNoticeTransaction('$a+'))

  for (const bad of [
    { eventId: 'held' },
    { eventId: `$${'a'.repeat(255)}` },
    { body: ' ' },
    { body: 'x'.repeat(1001) }
  ]) {
    await expect(publishMatrixNotice(client, { ...command, ...bad })).rejects.toThrow('matrix_command_invalid')
  }

  room.updateMyMembership('leave')
  await expect(publishMatrixNotice(client, command)).rejects.toThrow('matrix_encrypted_room_required')
  expect(send).toHaveBeenCalledTimes(2)
})

const member = (userId: string, content: Record<string, unknown> = {}, eventId = `$join-${userId.slice(1, 3)}`) =>
  new MatrixEvent({
    type: EventType.RoomMember,
    state_key: userId,
    room_id: '!room:test',
    event_id: eventId,
    sender: userId,
    content: { membership: 'join', ...content }
  })

/** An agent's SDK with one joined, encrypted room of the given create content: by default a
 * group of its owner, another person and the agent. */
function agentRoom(
  content: Record<string, unknown>,
  members = [member('@owner:test'), member('@linh:test'), member('@agent:test', {}, '$join-agent')]
) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!room:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    ...members,
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: room.roomId,
      event_id: '$create',
      sender: '@owner:test',
      content
    }),
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)

  const sharing: Array<boolean | null> = []

  const send = vi.spyOn(client, 'sendEvent').mockImplementation(async () => {
    sharing.push(room.getBlacklistUnverifiedDevices())

    return { event_id: '$sent' }
  })

  return { client, room, send, sharing }
}

const answer = (group?: true) => ({
  kind: 'publishResult' as const,
  roomId: '!room:test',
  eventId: '$request',
  body: 'Reply',
  invocationId: 'invocation',
  transactionId: 'transaction',
  ...(group ? { group } : {})
})

it('shares a group answer’s keys with every member’s device, only in an ordinary group', async () => {
  const group = agentRoom({})
  expect(await publishMatrixResult(group.client, answer(true))).toBe('$sent')
  expect(group.sharing).toEqual([false])

  // Never in its private room (or any typed room), even if asked: nothing is sent there.
  for (const type of ['io.atum.assistant', 'io.atum.app_group.v1', 'io.atum.company_project.v1']) {
    const typed = agentRoom({ type })
    await expect(publishMatrixResult(typed.client, answer(true))).rejects.toThrow('matrix_group_room_required')
    expect(typed.send).not.toHaveBeenCalled()
    expect(typed.room.getBlacklistUnverifiedDevices()).toBeNull()
  }

  // An older private chat (made direct, before private rooms had their type) is not a group,
  // with only its two people in it: its keys keep the private rule and nothing is sent.
  const older = agentRoom({}, [member('@owner:test'), member('@agent:test', { is_direct: true })])
  await expect(publishMatrixResult(older.client, answer(true))).rejects.toThrow('matrix_group_room_required')
  expect(older.send).not.toHaveBeenCalled()
  expect(older.room.getBlacklistUnverifiedDevices()).toBeNull()

  // An answer that isn't a group's leaves the account-wide rule alone.
  const plain = agentRoom({})
  await publishMatrixResult(plain.client, answer())
  expect(plain.sharing).toEqual([null])
})

it('publishes disclosure with its stable audience transaction and refuses malformed overrides before key sharing', async () => {
  const group = agentRoom({})
  const first = `atum-gd-${'a'.repeat(64)}`
  const second = `atum-gd-${'b'.repeat(64)}`
  const command = { kind: 'publishGroupNotice' as const, roomId: '!room:test', body: 'I’m an AI assistant.' }
  await publishMatrixGroupNotice(group.client, { ...command, transactionId: first })
  expect(group.send).toHaveBeenLastCalledWith(
    '!room:test',
    EventType.RoomMessage,
    { msgtype: 'm.notice', body: command.body },
    first
  )
  await publishMatrixGroupNotice(group.client, { ...command, transactionId: second })
  expect(group.send).toHaveBeenLastCalledWith(
    '!room:test',
    EventType.RoomMessage,
    { msgtype: 'm.notice', body: command.body },
    second
  )

  for (const transactionId of ['atum-g-old-join', 'atum-n-owner', 'atum-gd-short']) {
    const refused = agentRoom({})
    await expect(publishMatrixGroupNotice(refused.client, { ...command, transactionId })).rejects.toThrow(
      'matrix_command_invalid'
    )
    expect(refused.send).not.toHaveBeenCalled()
    expect(refused.sharing).toEqual([])
  }
})

it('says once, as a notice, what an assistant added to a group is, sharing that room’s keys', async () => {
  const group = agentRoom({})
  const body = 'I’m an AI assistant.'
  expect(await publishMatrixGroupNotice(group.client, { kind: 'publishGroupNotice', roomId: '!room:test', body })).toBe(
    '$sent'
  )
  expect(group.send).toHaveBeenCalledExactlyOnceWith(
    '!room:test',
    EventType.RoomMessage,
    { msgtype: 'm.notice', body },
    'atum-g-room.003atestjoin-agent'
  )
  expect(group.sharing).toEqual([false])

  // Removed and added back, it says it again: a new join, a new transaction.
  group.room.currentState.setStateEvents([member('@agent:test', {}, '$join-again')])
  await publishMatrixGroupNotice(group.client, { kind: 'publishGroupNotice', roomId: '!room:test', body })
  expect(group.send).toHaveBeenLastCalledWith(
    '!room:test',
    EventType.RoomMessage,
    { msgtype: 'm.notice', body },
    'atum-g-room.003atestjoin-again'
  )

  const typed = agentRoom({ type: 'io.atum.assistant' })
  await expect(
    publishMatrixGroupNotice(typed.client, { kind: 'publishGroupNotice', roomId: '!room:test', body })
  ).rejects.toThrow('matrix_group_room_required')
  await expect(
    publishMatrixGroupNotice(group.client, { kind: 'publishGroupNotice', roomId: '!room:test', body: ' ' })
  ).rejects.toThrow('matrix_command_invalid')
})

it('carries a cloud status notice’s closed code under io.atum.result, and refuses anything else', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$status' })
  const transactionId = '00000000-0000-4000-8000-63ead4593b89'

  const command = {
    kind: 'publishResult' as const,
    roomId: room.roomId,
    eventId: '$question',
    body: 'Đã dừng.',
    invocationId: '00000000-0000-4000-8000-f9b799160fa7',
    transactionId,
    status: 'stopped'
  }

  expect(await publishMatrixResult(client, command)).toBe('$status')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    expect.objectContaining({
      'io.atum.result': { invocation: command.invocationId, transaction: transactionId, status: 'stopped' }
    }),
    transactionId
  )
  await expect(publishMatrixResult(client, { ...command, status: 'Stopped!' })).rejects.toThrow(
    'matrix_command_invalid'
  )
  await expect(publishMatrixResult(client, { ...command, status: 'bogus_code' })).rejects.toThrow(
    'matrix_command_invalid'
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it('publishes a failed turn as system notice metadata, never as canned assistant text', async () => {
  const fixture = agentRoom({ type: 'io.atum.assistant' })
  const command = {
    ...answer(),
    body: 'Atum couldn’t complete this request. Please try again.',
    status: 'failed' as const
  }

  await publishMatrixResult(fixture.client, command)

  expect(fixture.send).toHaveBeenCalledWith(
    fixture.room.roomId,
    EventType.RoomMessage,
    expect.objectContaining({
      msgtype: 'm.notice',
      'io.atum.result': expect.objectContaining({ status: 'failed' })
    }),
    command.transactionId
  )
})

it('publishes a resumed turn’s synthetic Stop event and rejects an ended or owner-message target', async () => {
  const fixture = agentRoom({ type: 'io.atum.assistant' })
  const stopEvent = '$atum-followup-00000000-0000-4000-8000-342ace7df588.00000000-0000-4000-8000-f6c057d86785'
  await publishMatrixResult(fixture.client, { ...answer(), status: 'resuming_on_device', stopEvent })
  expect(fixture.send.mock.calls[0]![2]).toMatchObject({
    'io.atum.result': { status: 'resuming_on_device', stopEvent }
  })

  for (const invalid of [
    { status: 'stopped', stopEvent },
    { status: 'resuming_on_device', stopEvent: '$owner-message' }
  ]) {
    await expect(publishMatrixResult(fixture.client, { ...answer(), ...invalid })).rejects.toThrow(
      'matrix_command_invalid'
    )
  }

  expect(fixture.send).toHaveBeenCalledTimes(1)
})

it('publishes the native chain stamp and literal own mentions through the existing group SDK send path', async () => {
  const f = agentRoom({}, [member('@owner:test'), member('@agent:test'), member('@peer:test')])

  const chain = {
    origin: '$request',
    parent: '$request',
    depth: 1,
    recipients: [{ userId: '@peer:test', name: 'Bình' }]
  }

  await expect(
    publishMatrixResult(f.client, { ...answer(true), body: '@Bình please add your view', chain })
  ).resolves.toBe('$sent')
  const content = f.send.mock.calls[0]?.[2]
  expect(content).toMatchObject({
    'io.atum.chain': { origin: '$request', parent: '$request', depth: 1 },
    'm.mentions': { user_ids: ['@peer:test'] },
    'm.relates_to': { 'm.in_reply_to': { event_id: '$request' } }
  })
  expect(content).toHaveProperty('m.mentions', { user_ids: ['@peer:test'] })
})

it('a split meeting answer hands the meeting to whoever the whole answer names, with its last part', async () => {
  const f = agentRoom({}, [member('@owner:test'), member('@agent:test'), member('@peer:test'), member('@third:test')])

  const chain = {
    origin: '$request',
    parent: '$request',
    depth: 1,
    recipients: [
      { userId: '@peer:test', name: 'Bình' },
      { userId: '@third:test', name: 'Lan' }
    ]
  }

  await publishMatrixResult(f.client, {
    ...answer(true),
    body: 'and that is the plan. @Lan, over to you.',
    part: { index: 1, count: 2 },
    matrixTransactionId: 'txn-p1',
    mentionsFrom: '@Bình, first the numbers…\n\nand that is the plan. @Lan, over to you.',
    chain
  })

  const content = f.send.mock.calls[0]?.[2]
  expect(content).toMatchObject({ body: 'and that is the plan. @Lan, over to you.' })
  expect(content).toHaveProperty('m.mentions', { user_ids: ['@peer:test', '@third:test'] })
  // The whole answer is read for names only, never posted.
  expect(JSON.stringify(content)).not.toContain('first the numbers')
})

it('the private publication path cannot inherit a supplied group chain or recipient list', async () => {
  const f = agentRoom({})
  await publishMatrixResult(f.client, {
    ...answer(),
    body: '@Bình',
    chain: {
      origin: '$request',
      parent: '$request',
      depth: 1,
      recipients: [{ userId: '@peer:test', name: 'Bình' }]
    }
  })
  const content = f.send.mock.calls[0]?.[2]
  expect(content).not.toHaveProperty('io.atum.chain')
  expect(content).not.toHaveProperty('m.mentions')
})


it('the default-off product build omits even a forced valid pet completion', async () => {
  const f = agentRoom({ type: 'io.atum.assistant' }, [member('@owner:test'), member('@agent:test')])
  await publishMatrixResult(f.client, { ...answer(), pet: { v: 1, intents: [{ action: 'wave' }] } })
  expect(f.send.mock.calls[0][2]).not.toHaveProperty('io.atum.pet')
})

it('publishes a daily Earlier notice under the same bounded room/day transaction for different owner messages', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!old:test', client, '@agent:test')
  room.currentState.setStateEvents([new MatrixEvent({ type: EventType.RoomEncryption, state_key: '', room_id: room.roomId,
    sender: '@owner:test', content: { algorithm: 'm.megolm.v1.aes-sha2' } })])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$notice' })
  const transactionId = `atum-earlier-2026-10-07-${'a'.repeat(64)}`

  for (const eventId of ['$one', '$two']) {
    await publishMatrixNotice(client, { kind: 'publishNotice', roomId: room.roomId, eventId, body: 'Continue in your main conversation.', transactionId })
  }

  expect(send.mock.calls.map(call => call[3])).toEqual([transactionId, transactionId])
  expect(send.mock.calls[0][2]).toMatchObject({ msgtype: 'm.notice' })
  await expect(publishMatrixNotice(client, { kind: 'publishNotice', roomId: room.roomId, eventId: '$three', body: 'Notice', transactionId: 'arbitrary' })).rejects.toThrow('matrix_command_invalid')
  expect(send).toHaveBeenCalledTimes(2)
})

it('publishes one group-routing failure under its bounded cross-device transaction', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!group:test', client, '@agent:test')
  room.currentState.setStateEvents([new MatrixEvent({ type: EventType.RoomEncryption, state_key: '', room_id: room.roomId,
    sender: '@owner:test', content: { algorithm: 'm.megolm.v1.aes-sha2' } })])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$notice' })
  const transactionId = `atum-grf-${'a'.repeat(64)}`

  const command = { kind: 'publishNotice' as const, roomId: room.roomId, eventId: '$owner',
    body: 'I could not decide which bot should answer.', group: true as const, transactionId }

  await publishMatrixNotice(client, command)
  await publishMatrixNotice(client, command)
  expect(send.mock.calls.map(call => call[3])).toEqual([transactionId, transactionId])
  expect(send.mock.calls[0][2]).toMatchObject({ msgtype: 'm.notice' })

  for (const bad of [
    { group: undefined },
    { statusLine: true as const },
    { transactionId: `atum-grf-${'A'.repeat(64)}` },
    { transactionId: 'atum-grf-short' }
  ]) {
    await expect(publishMatrixNotice(client, { ...command, ...bad })).rejects.toThrow('matrix_command_invalid')
  }

  expect(send).toHaveBeenCalledTimes(2)
})

it('keeps cloud status notice transactions independent of the daily Earlier transaction', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!main:test', client, '@agent:test')
  room.currentState.setStateEvents([new MatrixEvent({ type: EventType.RoomEncryption, state_key: '', room_id: room.roomId,
    sender: '@owner:test', content: { algorithm: 'm.megolm.v1.aes-sha2' } })])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$status' })
  const transactionId = `atum-cn-${'b'.repeat(64)}`
  await publishMatrixNotice(client, { kind: 'publishNotice', roomId: room.roomId, eventId: '$owner',
    body: 'Working', statusLine: true, transactionId })
  expect(send.mock.calls[0][3]).toBe(transactionId)
  await expect(publishMatrixNotice(client, { kind: 'publishNotice', roomId: room.roomId, eventId: '$owner',
    body: 'Continue', statusLine: true, transactionId: `atum-earlier-2026-10-07-${'a'.repeat(64)}` }))
    .rejects.toThrow('matrix_command_invalid')
  expect(send).toHaveBeenCalledOnce()
})

/**
 * A 0.20 room: no encryption state; `type` is its room type (the agent's chat, or none). `store`
 * is the crypto store's record of it: plain (false), encrypted (true: a room whose encryption
 * state has not synced here yet), or no answer (an error).
 */
function plainRoomClient(type?: string, store: boolean | Error = false) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    isEncryptionEnabledInRoom: async () => {
      if (store instanceof Error) {
        throw store
      }

      return store
    }
  } as unknown as ReturnType<typeof client.getCrypto>)
  const room = new Room('!plain:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: room.roomId,
      event_id: '$create',
      sender: '@owner:test',
      content: type ? { type } : {}
    }),
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: client.getSafeUserId(),
      room_id: room.roomId,
      event_id: '$join',
      sender: client.getSafeUserId(),
      content: { membership: 'join' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$posted' })

  return { client, room, send }
}

const result = {
  kind: 'publishResult' as const,
  roomId: '!plain:test',
  eventId: '$question',
  body: 'Answer',
  invocationId: 'invocation',
  transactionId: 'transaction'
}

const notice = { kind: 'publishNotice' as const, roomId: '!plain:test', eventId: '$question', body: 'Status' }

// 0.20 shave-down: the agent's own chat is plain; matrix-js-sdk sends plaintext there by itself.
it('publishes an answer and a status notice into the agent’s plain chat', async () => {
  const f = plainRoomClient('io.atum.assistant')
  expect(await publishMatrixResult(f.client, result)).toBe('$posted')
  expect(await publishMatrixNotice(f.client, notice)).toBe('$posted')
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('refuses an agent’s answer or notice in a plain room that is not its chat or a group post', async () => {
  for (const type of [undefined, 'io.atum.other']) {
    const f = plainRoomClient(type)
    await expect(publishMatrixResult(f.client, result)).rejects.toThrow('matrix_encrypted_room_required')
    await expect(publishMatrixNotice(f.client, notice)).rejects.toThrow('matrix_encrypted_room_required')
    expect(f.send).not.toHaveBeenCalled()
  }
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
it('publishes a group answer, a group notice and the disclosure into a plain group', async () => {
  const f = plainRoomClient()
  // Three members: an ordinary group, never a private chat.
  f.room.currentState.setStateEvents(
    ['@owner:test', '@friend:test'].map(
      userId =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          room_id: f.room.roomId,
          event_id: `$member-${userId}`,
          sender: userId,
          content: { membership: 'join' }
        })
    )
  )
  expect(await publishMatrixResult(f.client, { ...result, group: true })).toBe('$posted')
  expect(await publishMatrixNotice(f.client, { ...notice, group: true })).toBe('$posted')
  expect(
    await publishMatrixGroupNotice(f.client, { kind: 'publishGroupNotice', roomId: f.room.roomId, body: 'Hi' })
  ).toBe('$posted')
  // A group post never goes into the agent's private chat.
  const own = plainRoomClient('io.atum.assistant')
  await expect(publishMatrixResult(own.client, { ...result, group: true })).rejects.toThrow(
    'matrix_group_room_required'
  )
})

// 0.20: an app without a bot answers in its plain pair or its plain app group; main has just
// re-read the room with readAppRoom and marks the answer as an app's (`app`).
it('publishes an app’s answer in its plain pair and its own plain app group, never elsewhere', async () => {
  const appGroup = (app: string) => {
    const f = plainRoomClient()
    f.room.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomCreate,
        state_key: '',
        room_id: f.room.roomId,
        event_id: '$create',
        sender: '@owner:test',
        content: { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app } }
      })
    ])

    return f
  }

  const pair = plainRoomClient()
  expect(await publishMatrixResult(pair.client, { ...result, app: true })).toBe('$posted')
  const own = appGroup('@assistant:test')
  expect(await publishMatrixResult(own.client, { ...result, app: true })).toBe('$posted')

  // Another app's group, a plain room of another type, or a post not marked as an app's.
  const other = appGroup('@other:test')
  await expect(publishMatrixResult(other.client, { ...result, app: true })).rejects.toThrow(
    'matrix_encrypted_room_required'
  )
  const typed = plainRoomClient('io.atum.other')
  await expect(publishMatrixResult(typed.client, { ...result, app: true })).rejects.toThrow(
    'matrix_encrypted_room_required'
  )
  const unmarked = plainRoomClient()
  await expect(publishMatrixResult(unmarked.client, result)).rejects.toThrow('matrix_encrypted_room_required')
  expect([other, typed, unmarked].some(f => f.send.mock.calls.length > 0)).toBe(false)
})

// The synced view can lack a room's encryption state while the crypto store knows it: still an
// encrypted room, so the post is admitted and left to the SDK, which sends it encrypted within a
// session and refuses to send at all after a restart from a stale cached sync, until sync catches
// up (both shown with real crypto in notice-edit.integration.test.ts). Never plaintext.
it('takes a room the crypto store has as encrypted as an encrypted room, whatever the synced view shows', async () => {
  for (const type of [undefined, 'io.atum.assistant', 'io.atum.other']) {
    const f = plainRoomClient(type, true)
    expect(await publishMatrixResult(f.client, result)).toBe('$posted')
    expect(await publishMatrixNotice(f.client, notice)).toBe('$posted')
    expect(f.send).toHaveBeenCalledTimes(2)
  }
})

// No answer from the store: a post goes only where a plain post may go anyway (the agent's own
// chat, a group). Anywhere else, including an app's plain pair (plain only when the store agrees),
// nothing is sent and the failure is a passing one, so the caller keeps the post and tries again;
// never the refusal callers treat as final.
it('holds a room the crypto store cannot answer for to the plain rule, and keeps an app answer for a retry', async () => {
  const pair = plainRoomClient(undefined, new Error('store unavailable'))
  await expect(publishMatrixResult(pair.client, { ...result, app: true })).rejects.toThrow('matrix_operation_failed')
  await expect(publishMatrixNotice(pair.client, notice)).rejects.toThrow('matrix_operation_failed')
  expect(pair.send).not.toHaveBeenCalled()

  const own = plainRoomClient('io.atum.assistant', new Error('store unavailable'))
  expect(await publishMatrixResult(own.client, result)).toBe('$posted')
})

// A follow-up sweep's offer is the cloud controller's standalone form: the system job's cron
// marker and no reply target, while an ordinary answer keeps its m.in_reply_to.
it('publishes a sweep offer standalone under the system sweep job marker', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@assistant:test' })
  const room = new Room('!assistant:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomEncryption,
      state_key: '',
      room_id: room.roomId,
      event_id: '$encryption',
      sender: '@owner:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$offer' })
  const occurrenceId = '00000000-0000-4000-8000-149a1ef8d82f'

  expect(
    await publishMatrixResult(client, {
      kind: 'publishResult',
      roomId: room.roomId,
      body: 'Lan needs an answer. Shall I draft a reply?',
      invocationId: occurrenceId,
      transactionId: occurrenceId,
      matrixTransactionId: `atum-sweep-${occurrenceId}`,
      ledger: true,
      sweep: true
    })
  ).toBe('$offer')
  expect(send).toHaveBeenCalledWith(
    room.roomId,
    EventType.RoomMessage,
    expect.objectContaining({
      body: 'Lan needs an answer. Shall I draft a reply?',
      'io.atum.cron': { run: occurrenceId, job: 'sys_followup_sweep_v1' }
    }),
    `atum-sweep-${occurrenceId}`
  )
  expect(send.mock.calls[0]![2]).not.toHaveProperty('m.relates_to')
  expect(send.mock.calls[0]![2]).not.toHaveProperty('io.atum.result')

  await expect(
    publishMatrixResult(client, {
      kind: 'publishResult',
      roomId: room.roomId,
      body: 'Not a sweep.',
      invocationId: 'not-a-uuid',
      transactionId: occurrenceId,
      sweep: true
    })
  ).rejects.toThrow('matrix_command_invalid')
  expect(send).toHaveBeenCalledOnce()
})

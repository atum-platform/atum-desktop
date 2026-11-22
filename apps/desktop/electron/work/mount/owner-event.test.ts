import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../../shared/matrix'

import { createOwnerEventVerifier, createSdkOwnerEventSource, type OwnerEventSource } from './owner-event'

const OWNER = '@owner:example.org'
const AGENT_USER = '@luna:example.org'
const ROOM = '!room:example.org'
const EVENT = '$eventAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PRINCIPAL = '67000000-0000-4000-8000-00000000000a'

function plain(overrides: Partial<MatrixInvocationMessage> = {}): MatrixInvocationMessage {
  return {
    roomId: ROOM,
    eventId: EVENT,
    wireType: 'm.room.message',
    roomPlain: true,
    sender: OWNER,
    senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
    senderVerified: true,
    timestamp: 1_700_000_000_000,
    related: false,
    content: { msgtype: 'm.text', body: 'Tidy my Downloads folder' },
    ...overrides
  }
}

function encrypted(overrides: Partial<MatrixInvocationMessage> = {}): MatrixInvocationMessage {
  return plain({ wireType: 'm.room.encrypted', roomPlain: undefined, senderDevice: 'OWNERDEVICE', ...overrides })
}

function source(read: () => Promise<MatrixInvocationMessage> | MatrixInvocationMessage, extra: Partial<OwnerEventSource> = {}): OwnerEventSource {
  return {
    ownerUserId: () => OWNER,
    agentUserId: async () => AGENT_USER,
    assistantRoom: async () => ROOM,
    readEvent: async () => read(),
    ...extra
  }
}

const fetchWith = (s: OwnerEventSource) => createOwnerEventVerifier(s).fetch({ agentPrincipal: PRINCIPAL, eventId: EVENT })

describe('owner event verifier', () => {
  it('accepts the owner’s plain text in the owner’s room with that agent and returns the words and the server time', async () => {
    expect(await fetchWith(source(() => plain()))).toEqual({ kind: 'ok', body: 'Tidy my Downloads folder', originServerTs: 1_700_000_000_000, roomId: ROOM, encrypted: false })
  })

  it('accepts a message decrypted from a device the owner’s crypto trusts', async () => {
    expect(await fetchWith(source(() => encrypted()))).toMatchObject({ kind: 'ok' })
  })

  it('accepts a pure reply, which still names its target', async () => {
    const reply = plain({ related: true, content: { msgtype: 'm.text', body: 'yes, that one', replyTo: '$other' } })

    expect(await fetchWith(source(() => reply))).toMatchObject({ kind: 'ok' })
  })

  it('binds a question answer to an assistant-authored reply to the original relay event', async () => {
    const reply = plain({ related: true, content: { msgtype: 'm.text', body: 'Sea blue', replyTo: '$question' } })

    const prompt = plain({ eventId: '$question', sender: AGENT_USER, related: true,
      content: { msgtype: 'm.text', body: 'Which color?', replyTo: '$original' } })

    const verify = (candidate: MatrixInvocationMessage) => createOwnerEventVerifier(source(() => reply, {
      readEvent: async ({ eventId }) => eventId === '$question' ? candidate : reply
    })).fetch({ agentPrincipal: PRINCIPAL, eventId: EVENT, question: { eventId: '$question', originalEventId: '$original' } })

    expect(await verify(prompt)).toMatchObject({ kind: 'ok', body: 'Sea blue', questionReply: true })
    expect(await verify({ ...prompt, sender: OWNER })).toMatchObject({ questionReply: false })
    expect(await verify({ ...prompt, content: { ...prompt.content, replyTo: '$another' } })).toMatchObject({ questionReply: false })
  })

  it('asks for the room from the account’s agent record, never from the caller', async () => {
    const assistantRoom = vi.fn(async () => ROOM)
    const readEvent = vi.fn(async () => plain())
    const agentUserId = vi.fn(async () => AGENT_USER)

    await fetchWith(source(readEvent, { assistantRoom, agentUserId }))

    expect(agentUserId).toHaveBeenCalledWith(PRINCIPAL)
    expect(assistantRoom).toHaveBeenCalledWith({ ownerId: OWNER, agentId: AGENT_USER })
    expect(readEvent).toHaveBeenCalled()
  })

  it('refuses a sender who is not the owner', async () => {
    expect(await fetchWith(source(() => plain({ sender: '@stranger:example.org' })))).toEqual({ kind: 'invalid', reason: 'owner_event_not_owner' })
    expect(await fetchWith(source(() => plain({ sender: AGENT_USER })))).toEqual({ kind: 'invalid', reason: 'owner_event_not_owner' })
  })

  it('refuses when the agent is not one of the owner’s agents, or the owner has no room with it', async () => {
    expect(await fetchWith(source(() => plain(), { agentUserId: async () => null }))).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })
    expect(await fetchWith(source(() => plain(), { assistantRoom: async () => null }))).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })
  })

  it('refuses an answer about a different event or room than the one asked for', async () => {
    expect(await fetchWith(source(() => plain({ roomId: '!elsewhere:example.org' })))).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })
    expect(await fetchWith(source(() => plain({ eventId: '$another' })))).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })
  })

  it('refuses an encrypted event from an untrusted device and a plaintext event that claims an encrypted room', async () => {
    expect(await fetchWith(source(() => encrypted({ senderVerified: false })))).toEqual({ kind: 'invalid', reason: 'owner_event_device_not_owner' })
    expect(await fetchWith(source(() => encrypted({ senderDevice: undefined })))).toEqual({ kind: 'invalid', reason: 'owner_event_device_not_owner' })
    expect(await fetchWith(source(() => plain({ roomPlain: undefined })))).toEqual({ kind: 'invalid', reason: 'owner_event_device_not_owner' })
    expect(await fetchWith(source(() => plain({ senderVerified: false })))).toEqual({ kind: 'invalid', reason: 'owner_event_device_not_owner' })
  })

  it('refuses what is not the owner’s own plain request: edits, threads, forwards, protected content, other types', async () => {
    const body = { msgtype: 'm.text', body: 'x' }

    expect(await fetchWith(source(() => plain({ related: true })))).toMatchObject({ kind: 'invalid' })
    expect(await fetchWith(source(() => plain({ thread: true })))).toMatchObject({ kind: 'invalid' })
    expect(await fetchWith(source(() => plain({ content: { ...body, forwarded: true } })))).toEqual({ kind: 'invalid', reason: 'owner_event_not_owner' })
    expect(await fetchWith(source(() => plain({ content: { ...body, googleProtected: true } })))).toEqual({ kind: 'invalid', reason: 'owner_event_not_owner' })
    expect(await fetchWith(source(() => plain({ content: { msgtype: 'm.image', body: 'a.png' } })))).toMatchObject({ kind: 'invalid' })
    expect(await fetchWith(source(() => plain({ content: { msgtype: 'm.text', body: '   ' } })))).toMatchObject({ kind: 'invalid' })
  })

  it('maps the SDK’s stable refusals and treats every other failure as unreachable', async () => {
    const failing = (error: unknown) => fetchWith(source(() => Promise.reject(error)))

    expect(await failing(Object.assign(new Error('Not found'), { httpStatus: 404, errcode: 'M_NOT_FOUND' }))).toEqual({ kind: 'invalid', reason: 'owner_event_not_found' })
    expect(await failing(new Error('matrix_invocation_untrusted'))).toEqual({ kind: 'invalid', reason: 'owner_event_undecryptable' })
    expect(await failing(new Error('matrix_encrypted_room_required'))).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })

    // a homeserver outage, a rate limit, a server error, a client that is not ready, a store that did not answer
    expect(await failing(new Error('fetch failed'))).toEqual({ kind: 'unreachable' })
    expect(await failing(Object.assign(new Error('slow down'), { httpStatus: 429 }))).toEqual({ kind: 'unreachable' })
    expect(await failing(Object.assign(new Error('boom'), { httpStatus: 502 }))).toEqual({ kind: 'unreachable' })
    expect(await failing(new Error('matrix_not_ready'))).toEqual({ kind: 'unreachable' })
    expect(await failing(new Error('matrix_operation_failed'))).toEqual({ kind: 'unreachable' })
    expect(await failing('not an error')).toEqual({ kind: 'unreachable' })
  })

  it('is unreachable, not a refusal, while no owner is signed in or the roster cannot be read', async () => {
    expect(await fetchWith(source(() => plain(), { ownerUserId: () => undefined }))).toEqual({ kind: 'unreachable' })
    expect(await fetchWith(source(() => plain(), { agentUserId: async () => Promise.reject(new Error('roster_unavailable')) }))).toEqual({ kind: 'unreachable' })
  })

  it('discards an answer when the signed-in account changed while the read was in flight', async () => {
    let current: string | undefined = OWNER

    const result = await fetchWith(
      source(
        () => {
          current = '@other:example.org'

          return plain()
        },
        { ownerUserId: () => current }
      )
    )

    expect(result).toEqual({ kind: 'unreachable' })
  })

  it('does not even look for an event id that is not a Matrix event id', async () => {
    const readEvent = vi.fn(async () => plain())
    const result = await createOwnerEventVerifier(source(readEvent)).fetch({ agentPrincipal: PRINCIPAL, eventId: 'not an id' })

    expect(result).toEqual({ kind: 'invalid', reason: 'owner_event_not_found' })
    expect(readEvent).not.toHaveBeenCalled()
  })
})

describe('owner event source over the SDK command queue', () => {
  it('issues only findAssistantRoom and readInvocation on the owner host', async () => {
    const commands: unknown[] = []

    const host = {
      userId: OWNER,
      command: async (command: { kind: string }) => {
        commands.push(command)

        return command.kind === 'findAssistantRoom' ? ROOM : plain()
      }
    }

    const verifier = createOwnerEventVerifier(createSdkOwnerEventSource({ owner: () => host, agentMatrixUser: async () => AGENT_USER }))

    expect(await verifier.fetch({ agentPrincipal: PRINCIPAL, eventId: EVENT })).toMatchObject({ kind: 'ok' })
    expect(commands).toEqual([
      { kind: 'findAssistantRoom', ownerId: OWNER, agentId: AGENT_USER },
      { kind: 'readInvocation', roomId: ROOM, eventId: EVENT }
    ])
  })

  it('is unreachable when the owner host is not ready, and a room the SDK does not know is a wrong room', async () => {
    const down = createOwnerEventVerifier(createSdkOwnerEventSource({ owner: () => undefined, agentMatrixUser: async () => AGENT_USER }))

    expect(await down.fetch({ agentPrincipal: PRINCIPAL, eventId: EVENT })).toEqual({ kind: 'unreachable' })

    const none = createOwnerEventVerifier(
      createSdkOwnerEventSource({ owner: () => ({ userId: OWNER, command: async () => null }), agentMatrixUser: async () => AGENT_USER })
    )

    expect(await none.fetch({ agentPrincipal: PRINCIPAL, eventId: EVENT })).toEqual({ kind: 'invalid', reason: 'owner_event_wrong_room' })
  })
})

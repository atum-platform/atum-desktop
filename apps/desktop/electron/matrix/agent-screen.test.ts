import type { IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_AGENT_SCREEN_IPC, type MatrixAgentScreenBridge } from '../../shared/matrix-agent-screen'
import { createAgentScreenTransport } from '../../src/matrix/agent-screen/transport'

import handbackFrame from './__fixtures__/agent-screen/handback.json'
import handbackResult from './__fixtures__/agent-screen/handback.result.json'
import openResult from './__fixtures__/agent-screen/open.result.json'
import redeemFrame from './__fixtures__/agent-screen/redeem.json'
import statusResult from './__fixtures__/agent-screen/status.json'
import statusFrame from './__fixtures__/agent-screen/status.request.json'
import takeoverFrame from './__fixtures__/agent-screen/takeover.json'
import watchFrame from './__fixtures__/agent-screen/watch.json'
import { registerMatrixAgentScreenIpc } from './agent-screen'

const { ownerPrincipal, agentPrincipal, accessToken } = watchFrame
const { roomId, transactionId, askEventId } = handbackResult.continuation
const { sessionId, viewerDeviceId: deviceId, binding: { ownerUserId: userId }, ticket } = openResult.viewer
const binding = { agentPrincipal, roomId }
const id = '55555555-1111-4111-8111-abcdef123456'

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn()

  connect() {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  reply(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

function setup() {
  const handle = vi.fn()
  const on = vi.fn()
  const sockets: FakeSocket[] = []
  const dial = vi.fn(() => {
    const socket = new FakeSocket()
    sockets.push(socket)
    queueMicrotask(() => socket.connect())

    return socket as unknown as WebSocket
  })
  const device = { userId, deviceId, accessToken }
  const credentials = vi.fn(async (): Promise<typeof device & { ownerPrincipal: string } | undefined> => ({ ownerPrincipal, ...device }))
  const matrixDevice = vi.fn(() => device)
  const continuation = vi.fn(async (_input: unknown, _transactionId: string) => {})
  const sender = { isDestroyed: () => false, once: vi.fn(), off: vi.fn(), send: vi.fn() }
  const event = { sender }
  const stop = registerMatrixAgentScreenIpc({ handle, on } as unknown as IpcMain, {
    assertSender: (provided: unknown) => {
      if (provided !== event) {throw new Error('untrusted sender')}
    },
    credentials,
    matrixDevice,
    continue: continuation,
    dial,
    scope: () => 'fixture-scope'
  })
  const request = handle.mock.calls.find(([name]) => name === MATRIX_AGENT_SCREEN_IPC.request)![1]
  const stream = handle.mock.calls.find(([name]) => name === MATRIX_AGENT_SCREEN_IPC.stream)![1]
  const bridge: MatrixAgentScreenBridge = {
    request: input => request(event, input),
    connect: async (requestTicket, streamId) => stream(event, requestTicket, streamId),
    send: vi.fn(),
    acknowledge: vi.fn(),
    disconnect: vi.fn(),
    subscribe: () => () => {}
  }

  const respond = async (wire: object, result: unknown, index = 0) => {
    await vi.waitFor(() => expect(sockets[index]?.send).toHaveBeenCalledWith(expect.any(String)))
    const socket = sockets[index]!
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual(wire)
    socket.reply(result)
  }

  return { bridge, continuation, credentials, dial, matrixDevice, request, respond, sender, sockets, stop }
}

function freshOpen() {
  const issuedAt = Date.now()

  return { ...openResult, viewer: { ...openResult.viewer, issuedAt, expiresAt: issuedAt + 30_000 } }
}

describe('owner screen bridge and transport', () => {
  it('sends the contract status with the owner’s native grant and exact session field', async () => {
    const { bridge, credentials, respond } = setup()
    const request = createAgentScreenTransport(bridge).status(binding, sessionId)
    await respond(statusFrame, statusResult)
    expect(await request).toEqual(statusResult)
    expect(credentials).toHaveBeenCalledExactlyOnceWith({ roomId, request: { op: 'status', agentPrincipal, sessionId } })
  })

  it('redeems the watch fixture once for the same device and forwards binary RFB', async () => {
    const { bridge, matrixDevice, respond, sender, sockets, stop } = setup()
    const open = freshOpen()
    const request = createAgentScreenTransport(bridge).observe(binding)
    await respond(watchFrame, open)
    expect(await request).toEqual(open)

    matrixDevice.mockReturnValueOnce({ userId, deviceId: 'FOREIGN', accessToken })
    expect(await bridge.connect(ticket, id)).toBe(false)
    expect(await bridge.connect(ticket, id)).toBe(true)
    expect(await bridge.connect(ticket, '66666666-1111-4111-8111-abcdef123456')).toBe(false)
    const stream = sockets[1]!
    expect(JSON.parse(stream.send.mock.calls[0]![0])).toEqual(redeemFrame)

    const bytes = new Uint8Array([82, 70, 66]).buffer
    stream.dispatchEvent(new MessageEvent('message', { data: bytes }))
    expect(sender.send).toHaveBeenLastCalledWith(MATRIX_AGENT_SCREEN_IPC.data, id, { kind: 'frame', bytes, sequence: 1 })
    stop()
  })

  it('declines a mismatched viewer binding', async () => {
    const { bridge, respond } = setup()
    const request = createAgentScreenTransport(bridge).observe(binding)
    const rejected = expect(request).rejects.toMatchObject({ reason: 'forbidden' })
    const open = freshOpen()
    await respond(watchFrame, { ...open, viewer: { ...open.viewer, viewerDeviceId: 'FOREIGN' } })
    await rejected
    expect(await bridge.connect(ticket, id)).toBe(false)
  })

  it('translates takeover with revision zero and preserves all contract refusals', async () => {
    const { bridge, respond } = setup()
    const transport = createAgentScreenTransport(bridge)
    const refusals = ['forbidden', 'stale_revision', 'invalid_request', 'unavailable']
    for (const [index, reason] of refusals.entries()) {
      const request = transport.acquire(binding, { sessionId, expectedControlRevision: 0 })
      const rejected = expect(request).rejects.toMatchObject({ reason })
      await respond(takeoverFrame, { error: reason }, index)
      await rejected
    }
  })

  it('sends only after a confirmed release and uses the same transaction on send retry', async () => {
    const { bridge, continuation, respond } = setup()
    continuation.mockRejectedValueOnce(new Error('matrix_offline'))
    const transport = createAgentScreenTransport(bridge)
    const input = { sessionId, expectedControlRevision: handbackFrame.expectedControlRevision, askEventId }

    const first = transport.handback(binding, input)
    const rejected = expect(first).rejects.toMatchObject({ reason: 'unavailable' })
    expect(continuation).not.toHaveBeenCalled()
    await respond(handbackFrame, handbackResult)
    await rejected
    const second = transport.handback(binding, input)
    await respond(handbackFrame, handbackResult, 1)
    expect(await second).toEqual(handbackResult)
    expect(continuation.mock.calls.map(call => call[1])).toEqual([transactionId, transactionId])
  })

  it('rejects a confirmation for another room and an unconfirmed release', async () => {
    const { bridge, continuation, respond } = setup()
    const transport = createAgentScreenTransport(bridge)
    const input = { sessionId, expectedControlRevision: handbackFrame.expectedControlRevision, askEventId }
    const first = transport.handback(binding, input)
    const wrongRoom = expect(first).rejects.toMatchObject({ reason: 'forbidden' })
    await respond(handbackFrame, { ...handbackResult, continuation: { ...handbackResult.continuation, roomId: '!foreign:example.test' } })
    await wrongRoom
    const second = transport.handback(binding, input)
    const unconfirmed = expect(second).rejects.toMatchObject({ reason: 'unavailable' })
    await respond(handbackFrame, { ...handbackResult, released: false }, 1)
    await unconfirmed
    expect(continuation).not.toHaveBeenCalled()
  })

  it('rejects an ineligible caller, untrusted sender and renderer-supplied credentials', async () => {
    const { bridge, credentials, dial, request } = setup()
    credentials.mockResolvedValueOnce(undefined)
    const status = { op: 'status' as const, agentPrincipal }
    expect(await bridge.request({ roomId, request: status })).toEqual({ error: 'forbidden' })
    expect(await bridge.request({ roomId, request: { ...status, accessToken } as never })).toEqual({ error: 'invalid_request' })
    await expect(request({ sender: {} }, { roomId, request: status })).rejects.toThrow('untrusted sender')
    expect(dial).not.toHaveBeenCalled()
  })
})

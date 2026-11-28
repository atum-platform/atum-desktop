import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  agentScreenHandback,
  agentScreenOpen,
  type AgentScreenOpen,
  agentScreenRefusal,
  agentScreenRelease,
  type AgentScreenReply,
  agentScreenRequest,
  type AgentScreenRequest,
  agentScreenStatus,
  type AgentScreenStreamEvent,
  agentScreenTicket,
  MATRIX_AGENT_SCREEN_IPC
} from '../../shared/matrix-agent-screen'

import { deviceHubUrl } from './device/connection'

const FRAME_LIMIT = 256 * 1024
const BUFFER_LIMIT = 8 * FRAME_LIMIT
const DEADLINE_MS = 27_000
const MAX_STREAMS = 4
const UNAVAILABLE = { error: 'unavailable' } as const
const FORBIDDEN = { error: 'forbidden' } as const
const INVALID = { error: 'invalid_request' } as const

interface ScreenOwner {
  ownerPrincipal: string
  userId: string
  deviceId: string
  accessToken: string
}

async function requestAgentScreen(
  dial: () => WebSocket,
  owner: ScreenOwner,
  request: AgentScreenRequest['request']
): Promise<AgentScreenReply> {
  return new Promise(resolve => {
    const socket = dial()
    let settled = false
    const finish = (reply: AgentScreenReply) => {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      resolve(reply)
      socket.close()
    }
    const timer = setTimeout(() => finish(UNAVAILABLE), DEADLINE_MS)

    socket.addEventListener('open', () => {
      if (settled) {return}
      socket.send(JSON.stringify({ ...request, ownerPrincipal: owner.ownerPrincipal, accessToken: owner.accessToken }))
    }, { once: true })
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 8192) {
          finish(UNAVAILABLE)

          return
        }

        const value: unknown = JSON.parse(event.data)
        const refusal = agentScreenRefusal.safeParse(value)
        const schema = request.op === 'status' ? agentScreenStatus : request.op === 'open' ? agentScreenOpen :
          request.op === 'handback' ? agentScreenHandback : agentScreenRelease

        finish(refusal.success ? refusal.data : schema.parse(value))
      } catch {
        finish(UNAVAILABLE)
      }
    }, { once: true })
    socket.addEventListener('close', event => finish(event.code === 4401 ? FORBIDDEN : UNAVAILABLE), { once: true })
    socket.addEventListener('error', () => finish(UNAVAILABLE), { once: true })
  })
}

interface ScreenOptions {
  assertSender(event: IpcMainEvent | IpcMainInvokeEvent): void
  scope(): string | undefined
  credentials(input: AgentScreenRequest): Promise<ScreenOwner | undefined>
  matrixDevice(): { userId: string; deviceId: string; accessToken: string }
  continue(input: AgentScreenRequest, transactionId: string): Promise<void>
  dial?: () => WebSocket
}

interface Grant {
  scope: string
  sender: WebContents
  viewer: AgentScreenOpen['viewer']
}

interface Stream {
  close(clean: boolean): void
  send(bytes: ArrayBuffer): void
  acknowledge(sequence: number): void
  sender: WebContents
}

export function registerMatrixAgentScreenIpc(ipc: IpcMain, options: ScreenOptions): () => void {
  const dial = options.dial ?? (() => new WebSocket(`${deviceHubUrl(process.env.ATUM_DEVICE_HUB_URL)}/display`))
  const grants = new Map<string, Grant>()
  const streams = new Map<string, Stream>()
  const active = new Set<string>()
  const stop = () => {
    grants.clear()
    for (const stream of streams.values()) {
      stream.close(false)
    }
  }

  ipc.handle(MATRIX_AGENT_SCREEN_IPC.request, async (event, raw: unknown) => {
    options.assertSender(event)
    const parsed = agentScreenRequest.safeParse(raw)
    const scope = options.scope()
    if (!parsed.success) {return INVALID}
    if (!scope) {return FORBIDDEN}

    const input = parsed.data
    const { request } = input
    const key = `${scope}:${request.agentPrincipal}`

    // The controller accepts one outstanding operation per agent. Let the pane retry a busy call.
    if (active.has(key)) {return UNAVAILABLE}
    active.add(key)

    try {
      const owner = await options.credentials(input)
      if (!owner || options.scope() !== scope) {return FORBIDDEN}

      const result = await requestAgentScreen(dial, owner, request)
      if (options.scope() !== scope || event.sender.isDestroyed()) {return FORBIDDEN}

      if ('viewer' in result) {
        const { viewer, status } = result
        if (
          request.op !== 'open' || viewer.mode !== request.mode ||
          (request.sessionId && viewer.sessionId !== request.sessionId) ||
          viewer.binding.ownerUserId !== owner.userId || viewer.binding.agentPrincipal !== request.agentPrincipal ||
          viewer.viewerDeviceId !== owner.deviceId || viewer.expiresAt <= Date.now() ||
          (viewer.mode === 'control' && (!status.viewerHasControl || status.holder !== 'human'))
        ) {return FORBIDDEN}

        for (const [ticket, grant] of grants) {
          if (grant.viewer.expiresAt <= Date.now() || grant.scope !== scope ||
              grant.viewer.sessionId === viewer.sessionId) {grants.delete(ticket)}
        }

        if (grants.size >= MAX_STREAMS) {return UNAVAILABLE}
        grants.set(viewer.ticket, { scope, viewer, sender: event.sender })
      }

      if ('continuation' in result) {
        if (
          request.op !== 'handback' || !result.released || result.status.holder !== 'agent' ||
          result.status.viewerHasControl || result.status.controlRevision !== request.expectedControlRevision + 1 ||
          result.continuation.roomId !== input.roomId || result.continuation.askEventId !== request.askEventId
        ) {return FORBIDDEN}

        await options.continue(input, result.continuation.transactionId)
        if (options.scope() !== scope) {return FORBIDDEN}
      }

      return result
    } catch {
      return UNAVAILABLE
    } finally {
      active.delete(key)
    }
  })

  ipc.handle(MATRIX_AGENT_SCREEN_IPC.stream, (event, ticket: unknown, id: unknown) => {
    options.assertSender(event)
    if (
      !agentScreenTicket.safeParse(ticket).success || typeof ticket !== 'string' ||
      typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id) || streams.has(id) || streams.size >= MAX_STREAMS
    ) {return false}

    const streamId = id
    const grant = grants.get(ticket)
    if (!grant || grant.sender !== event.sender || grant.scope !== options.scope() ||
        grant.viewer.expiresAt <= Date.now()) {return false}

    const device = options.matrixDevice()
    if (device.userId !== grant.viewer.binding.ownerUserId || device.deviceId !== grant.viewer.viewerDeviceId) {return false}

    grants.delete(ticket)
    const socket = dial()
    socket.binaryType = 'arraybuffer'
    const sender = event.sender
    const pending = new Map<number, number>()
    let sequence = 0
    let bytesPending = 0
    let ended = false
    const timer = setTimeout(() => {
      emit({ kind: 'close', code: 4408, clean: false })
      close(false)
    }, DEADLINE_MS)
    const destroy = () => close(false)
    const live = () => !sender.isDestroyed() && options.scope() === grant.scope
    const emit = (value: AgentScreenStreamEvent) => {
      if (live()) {sender.send(MATRIX_AGENT_SCREEN_IPC.data, streamId, value)}
    }

    function close(clean: boolean) {
      if (ended) {return}
      ended = true
      streams.delete(streamId)
      clearTimeout(timer)
      sender.off('destroyed', destroy)
      socket.close(clean ? 1000 : 4001)
    }

    sender.once('destroyed', destroy)
    socket.addEventListener('open', () => {
      if (ended) {return}
      if (!live()) {close(false); return}
      socket.send(JSON.stringify({ op: 'redeem', accessToken: device.accessToken, ticket }))
      emit({ kind: 'open' })
    }, { once: true })
    socket.addEventListener('message', event => {
      if (ended) {return}
      const bytes = event.data
      if (!live() || !(bytes instanceof ArrayBuffer) || bytes.byteLength > FRAME_LIMIT ||
          bytesPending + bytes.byteLength > BUFFER_LIMIT || pending.size >= 64) {
        emit({ kind: 'close', code: 1013, clean: false })
        close(false)

        return
      }

      clearTimeout(timer)
      bytesPending += bytes.byteLength
      pending.set(++sequence, bytes.byteLength)
      emit({ kind: 'frame', bytes, sequence })
    })
    socket.addEventListener('close', event => {
      if (!ended) {
        emit({ kind: 'close', code: event.code, clean: event.wasClean && event.code === 1000 })
        close(false)
      }
    }, { once: true })
    socket.addEventListener('error', () => {
      if (!ended) {
        emit({ kind: 'close', code: 1006, clean: false })
        close(false)
      }
    }, { once: true })

    streams.set(streamId, {
      sender,
      close,
      send(bytes) {
        if (!live()) {close(false); return}
        if (socket.readyState !== WebSocket.OPEN || !(bytes instanceof ArrayBuffer) ||
            !bytes.byteLength || bytes.byteLength > FRAME_LIMIT) {return}
        if (socket.bufferedAmount + bytes.byteLength > BUFFER_LIMIT) {
          emit({ kind: 'close', code: 1013, clean: false })
          close(false)

          return
        }

        socket.send(bytes)
      },
      acknowledge(sequence) {
        bytesPending -= pending.get(sequence) ?? 0
        pending.delete(sequence)
      }
    })

    return true
  })

  ipc.on(MATRIX_AGENT_SCREEN_IPC.data, (event, id: string, kind: string, value: unknown) => {
    try {options.assertSender(event)} catch {return}
    const stream = streams.get(id)
    if (stream?.sender !== event.sender) {return}
    if (kind === 'send' && value instanceof ArrayBuffer) {stream?.send(value)}
    if (kind === 'ack' && typeof value === 'number') {stream?.acknowledge(value)}
    if (kind === 'close') {stream?.close(value === true)}
  })

  return stop
}

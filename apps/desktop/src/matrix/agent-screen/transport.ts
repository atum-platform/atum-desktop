import type { RfbChannel as AgentScreenChannel } from '@novnc/novnc'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type {
  AgentScreenHandback,
  AgentScreenOpen,
  AgentScreenRelease,
  AgentScreenReply,
  AgentScreenRequest,
  AgentScreenStatus,
  MatrixAgentScreenBridge
} from '../../../shared/matrix-agent-screen'

export type { AgentScreenChannel }
export type { AgentScreenStatus } from '../../../shared/matrix-agent-screen'

export interface AgentScreenBinding {
  agentPrincipal: string
  roomId: string
}

export interface AgentScreenControl {
  sessionId: string
  expectedControlRevision: number
}

export class AgentScreenError extends Error {
  constructor(readonly reason: Extract<AgentScreenReply, { error: string }>['error']) {
    super(`agent_screen_${reason}`)
  }
}

export interface AgentScreenTransport {
  status(binding: AgentScreenBinding, sessionId?: string): Promise<AgentScreenStatus>
  observe(binding: AgentScreenBinding, sessionId?: string): Promise<AgentScreenOpen>
  acquire(binding: AgentScreenBinding, input: AgentScreenControl): Promise<AgentScreenOpen>
  release(binding: AgentScreenBinding, input: AgentScreenControl): Promise<AgentScreenRelease>
  handback(binding: AgentScreenBinding, input: AgentScreenControl & { askEventId: string }): Promise<AgentScreenHandback>
  forceRelease(binding: AgentScreenBinding, expectedControlRevision: number): Promise<AgentScreenRelease>
  connect(ticket: string): AgentScreenChannel | null
}

export function createAgentScreenTransport(bridge: MatrixAgentScreenBridge): AgentScreenTransport {
  const request = async <T>(roomId: string, value: AgentScreenRequest['request']): Promise<T> => {
    const result = await bridge.request({ roomId, request: value })

    if ('error' in result) {
      throw new AgentScreenError(result.error)
    }

    // Main validates each reply against the schema for the request's operation.
    return result as T
  }

  return {
    status: ({ agentPrincipal, roomId }, sessionId) => request(roomId, { op: 'status', agentPrincipal, sessionId }),
    observe: ({ agentPrincipal, roomId }, sessionId) => request(roomId, { op: 'open', mode: 'watch', agentPrincipal, sessionId }),
    acquire: ({ agentPrincipal, roomId }, input) => request(roomId, { op: 'open', mode: 'control', agentPrincipal, ...input }),
    release: ({ agentPrincipal, roomId }, input) => request(roomId, { op: 'release', agentPrincipal, ...input }),
    handback: ({ agentPrincipal, roomId }, input) => request(roomId, { op: 'handback', agentPrincipal, ...input }),
    forceRelease: ({ agentPrincipal, roomId }, expectedControlRevision) =>
      request(roomId, { op: 'force_release', agentPrincipal, expectedControlRevision }),
    connect: ticket => openAgentScreenChannel(bridge, ticket)
  }
}

const transports = new WeakMap<MatrixAgentScreenBridge, AgentScreenTransport>()

let playgroundTransport: AgentScreenTransport | null = null

/** Installed only by the standalone playground entry. Electron supplies the preload instead. */
export function installPlaygroundAgentScreen(transport: AgentScreenTransport): void {
  playgroundTransport = transport
}

export function agentScreenTransport(): AgentScreenTransport | null {
  const bridge = (globalThis as { atumMatrix?: MatrixUiBridge }).atumMatrix?.agentScreen
  if (!bridge) {return playgroundTransport}

  const existing = transports.get(bridge)
  if (existing) {return existing}

  const transport = createAgentScreenTransport(bridge)
  transports.set(bridge, transport)
  return transport
}

/** noVNC accepts a raw channel with the WebSocket surface below. Main dials and authenticates. */
function openAgentScreenChannel(bridge: MatrixAgentScreenBridge, ticket: string): AgentScreenChannel {
  const id = crypto.randomUUID()
  const channel: AgentScreenChannel = {
    binaryType: 'arraybuffer',
    protocol: '',
    readyState: 0,
    onerror: null,
    onmessage: null,
    onopen: null,
    onclose: null,
    close(clean = false) {
      if (channel.readyState === 3) {return}
      channel.readyState = 3
      unsubscribe()
      bridge.disconnect(id, clean)
    },
    send(bytes) {
      if (channel.readyState === 1) {bridge.send(id, new Uint8Array(bytes).buffer)}
    }
  }

  const closed = (code: number, wasClean: boolean) => {
    if (channel.readyState === 3) {return}
    channel.readyState = 3
    unsubscribe()
    channel.onclose?.({ code, wasClean })
  }
  const unsubscribe = bridge.subscribe(id, event => {
    switch (event.kind) {
      case 'open':
        channel.readyState = 1
        channel.onopen?.()
        break
      case 'frame':
        try {
          channel.onmessage?.({ data: event.bytes })
        } finally {
          bridge.acknowledge(id, event.sequence)
        }
        break
      case 'close':
        closed(event.code, event.clean)
        break
    }
  })

  // Subscribe first and give noVNC time to attach its handlers before dialing.
  queueMicrotask(() => {
    if (channel.readyState === 3) {return}
    void bridge.connect(ticket, id).then(accepted => {
      if (!accepted) {closed(4401, false)}
      // Close may have raced the initial invoke. Its stream ID remains unique.
      if (accepted && channel.readyState === 3) {bridge.disconnect(id, false)}
    }, () => closed(1006, false))
  })

  return channel
}

import { z } from 'zod'

export const MATRIX_AGENT_SCREEN_IPC = {
  request: 'matrix:agent-screen:request',
  stream: 'matrix:agent-screen:stream',
  data: 'matrix:agent-screen:data'
} as const

const bindingId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const sessionId = bindingId
const controlRevision = z.number().int().nonnegative()
const eventId = z.string().regex(/^\$[^\s]{1,511}$/u)
const roomId = z.string().regex(/^![^\s]{1,511}$/u)
export const agentScreenTicket = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const selector = { agentPrincipal: bindingId }
const release = { ...selector, sessionId, expectedControlRevision: controlRevision }

// ownerPrincipal and accessToken are added only in Electron main.
export const agentScreenRequest = z.object({
  roomId,
  request: z.union([
    z.strictObject({ ...selector, op: z.literal('status'), sessionId: sessionId.optional() }),
    z.strictObject({ ...selector, op: z.literal('open'), mode: z.literal('watch'), sessionId: sessionId.optional() }),
    z.strictObject({ ...release, op: z.literal('open'), mode: z.literal('control') }),
    z.strictObject({ ...release, op: z.literal('release') }),
    z.strictObject({ ...release, op: z.literal('handback'), askEventId: eventId }),
    z.strictObject({ ...selector, op: z.literal('force_release'), expectedControlRevision: controlRevision })
  ])
})

export const agentScreenStatus = z.strictObject({
  running: z.boolean(),
  holder: z.enum(['agent', 'human']),
  controlRevision,
  viewerHasControl: z.boolean()
}).refine(status => status.holder === 'human' || !status.viewerHasControl)

export const agentScreenOpen = z.strictObject({
  viewer: z.strictObject({
    ticket: agentScreenTicket,
    sessionId,
    mode: z.enum(['watch', 'control']),
    binding: z.strictObject({ ownerUserId: z.string().min(4).max(1024).regex(/^@[!-9;-~]+:[!-~]+$/u), agentPrincipal: bindingId, computerId: bindingId }),
    viewerDeviceId: z.string().min(1).max(255),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative()
  }).refine(viewer => viewer.expiresAt > viewer.issuedAt && viewer.expiresAt - viewer.issuedAt <= 30_000),
  status: agentScreenStatus
})
export const agentScreenRelease = z.strictObject({ released: z.literal(true), status: agentScreenStatus })
export const agentScreenHandback = agentScreenRelease.extend({
  continuation: z.strictObject({ askEventId: eventId, roomId, transactionId: agentScreenTicket })
})

export const agentScreenRefusal = z.strictObject({
  error: z.enum(['forbidden', 'stale_revision', 'invalid_request', 'unavailable'])
})

export type AgentScreenRequest = z.infer<typeof agentScreenRequest>
export type AgentScreenStatus = z.infer<typeof agentScreenStatus>
export type AgentScreenOpen = z.infer<typeof agentScreenOpen>
export type AgentScreenRelease = z.infer<typeof agentScreenRelease>
export type AgentScreenHandback = z.infer<typeof agentScreenHandback>
export type AgentScreenRefusal = z.infer<typeof agentScreenRefusal>
export type AgentScreenReply = AgentScreenStatus | AgentScreenOpen | AgentScreenRelease | AgentScreenHandback | AgentScreenRefusal

export type AgentScreenStreamEvent =
  | { kind: 'open' }
  | { kind: 'frame'; bytes: ArrayBuffer; sequence: number }
  | { kind: 'close'; code: number; clean: boolean }

export interface MatrixAgentScreenBridge {
  request(input: AgentScreenRequest): Promise<AgentScreenReply>
  connect(ticket: string, id: string): Promise<boolean>
  send(id: string, bytes: ArrayBuffer): void
  acknowledge(id: string, sequence: number): void
  disconnect(id: string, clean: boolean): void
  subscribe(id: string, listener: (event: AgentScreenStreamEvent) => void): () => void
}

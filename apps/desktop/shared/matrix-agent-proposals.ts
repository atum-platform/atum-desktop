import { z } from 'zod'

/**
 * Proposals the person's main agent makes about their other agents (create, hire, retire):
 * the confirm card under the agent's message. Contract: atum.agent-profile-management/1
 * (platform `packages/protocol/src/agent-profile-management.ts`, protocol 0.10.5). The agent's
 * receipt carries only a proposal ID; the card is built from the platform's own record, fetched
 * by main with the person's session, and never from the agent's message text.
 */
export const MATRIX_AGENT_PROPOSALS_IPC = {
  read: 'matrix:agent-proposals:read',
  confirm: 'matrix:agent-proposals:confirm',
  decline: 'matrix:agent-proposals:decline',
  changed: 'matrix:agent-proposals:changed'
} as const

/** Exactly 24 hours from creation (AGENT_MANAGEMENT_TTL_MS). */
export const MATRIX_AGENT_PROPOSAL_TTL_MS = 86_400_000

const uuid = z.uuid()
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stamp = z.iso.datetime({ offset: true })
const agentName = z.string().refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 40)

const createQuote = z.strictObject({
  amountMicroProtons: revision,
  periodDays: z.literal(30),
  policyVersion: z.literal('0314/1'),
  renews: z.literal(true)
})

const storeQuote = z.strictObject({
  offerId: uuid,
  offerVersion: revision.min(1),
  amountMicroProtons: revision,
  billingInterval: z.literal('month'),
  policyVersion: z.literal('store/1'),
  renews: z.literal(true)
})

// The intent's definition stays opaque here: the card names the agent and nothing else, and the
// platform re-checks the definition digest when the person confirms.
const createIntent = z.strictObject({ displayName: agentName, definition: z.record(z.string(), z.unknown()) })

const retireIntent = z.strictObject({
  target: uuid,
  expectedDefinitionRevision: revision,
  expectedIdentityRevision: revision.min(1)
})

const hireIntent = z.strictObject({ offerId: uuid, offerVersion: revision.min(1) })

/** The platform's proposal record (AgentManagementProposalSchema), as the human-session route returns it. */
export const MatrixAgentProposalRecordSchema = z
  .strictObject({
    id: uuid,
    owner: uuid,
    ownerKind: z.enum(['person', 'company']),
    requester: uuid,
    visibility: z.enum(['requester', 'company']),
    operation: z.enum(['create', 'propose_hire', 'propose_retire']),
    intent: z.record(z.string(), z.unknown()),
    quote: z.union([createQuote, storeQuote]).nullable(),
    requestId: uuid,
    createdAt: stamp,
    expiresAt: stamp,
    state: z.enum(['pending', 'consumed', 'void', 'expired'])
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== MATRIX_AGENT_PROPOSAL_TTL_MS) {
      ctx.addIssue({ code: 'custom', message: 'Proposal lasts exactly 24 hours' })
    }

    const intent =
      value.operation === 'create' ? createIntent : value.operation === 'propose_retire' ? retireIntent : hireIntent

    if (!intent.safeParse(value.intent).success) {
      ctx.addIssue({ code: 'custom', message: 'Intent must match the operation' })
    }
  })

export type MatrixAgentProposalRecord = z.infer<typeof MatrixAgentProposalRecordSchema>

const errorCodes = [
  'conflict',
  'denied',
  'duplicate',
  'invalid',
  'locked',
  'missing',
  'offline',
  'reserved',
  'unavailable',
  'run_denied',
  'quota',
  'confirmation_required',
  'awaiting_funds',
  'terms_changed',
  'expired'
] as const

/** The human-session confirmation's answer (AgentManagementConfirmationResultSchema). */
export const MatrixAgentProposalConfirmationSchema = z.union([
  z.strictObject({ error: z.enum(errorCodes) }),
  z.strictObject({
    status: z.enum(['authorised', 'awaiting_funds', 'finished', 'terms_changed', 'expired']),
    requestId: uuid,
    creation: z.record(z.string(), z.unknown()).optional()
  }),
  z.strictObject({ status: z.literal('retired'), target: uuid })
])

export type MatrixAgentProposalConfirmation = z.infer<typeof MatrixAgentProposalConfirmationSchema>

export type MatrixAgentProposalOperation = 'create' | 'hire' | 'retire'
export type MatrixAgentProposalState = 'pending' | 'confirmed' | 'declined' | 'expired' | 'failed'

/** What the window draws. Every field is main's projection of the platform record. */
export interface MatrixAgentProposalCard {
  id: string
  roomId: string
  /** The agent's message the card sits under. */
  eventId: string
  operation: MatrixAgentProposalOperation
  /** The agent the change is about, by its display name. */
  agentName: string
  /** Protons per month, only when the change costs Protons. */
  protons?: number
  state: MatrixAgentProposalState
  /** On `failed`: `funds` when the balance was short, otherwise `unavailable`. */
  failure?: 'funds' | 'unavailable'
  /** Epoch ms. A pending card past this is expired. */
  expiresAt: number
}

export interface MatrixAgentProposalsBridge {
  /** The validated proposals placed in one room. Nothing until a valid proposal arrives. */
  read(roomId: string): Promise<MatrixAgentProposalCard[]>
  /** The person's yes. Main re-checks the card and confirms with the person's own session. */
  confirm(proposalId: string): Promise<MatrixAgentProposalCard>
  /** Not now: the card settles; the proposal lapses on its own after 24 hours. */
  decline(proposalId: string): Promise<MatrixAgentProposalCard>
  /** Called with the room whose cards changed. */
  subscribe(listener: (roomId: string) => void): () => void
}

const PROPOSAL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function matrixAgentProposalId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ID.test(value)
}

/** Matrix room and event IDs as the transcript knows them; bounded, never parsed further. */
export function matrixAgentProposalRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^![^\s:]+:\S+$/.test(value)
}

export function matrixAgentProposalEventId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^\$\S+$/.test(value)
}

/** A whole-Proton monthly price from a quote, or nothing when the change is free. */
export function matrixAgentProposalProtons(record: MatrixAgentProposalRecord): number | undefined {
  const amount = record.quote?.amountMicroProtons ?? 0

  return amount > 0 ? amount / 1_000_000 : undefined
}

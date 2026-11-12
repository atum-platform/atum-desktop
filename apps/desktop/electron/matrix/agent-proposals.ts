import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  MATRIX_AGENT_PROPOSALS_IPC,
  type MatrixAgentProposalCard,
  MatrixAgentProposalConfirmationSchema,
  matrixAgentProposalEventId,
  matrixAgentProposalId,
  matrixAgentProposalProtons,
  type MatrixAgentProposalRecord,
  MatrixAgentProposalRecordSchema,
  matrixAgentProposalRoomId
} from '../../shared/matrix-agent-proposals'

/**
 * The person's own-session routes for agent-management proposals. Both are owner-session
 * routes on the platform: no agent or controller credential reaches them, and the platform
 * derives the person from the session and re-checks everything at confirmation (owner-model
 * §3.5). Absent until those routes ship, which keeps every card off.
 */
export interface MatrixAgentProposalPlatform {
  fetch(proposalId: string, signal: AbortSignal): Promise<unknown>
  confirm(proposalId: string, signal: AbortSignal): Promise<unknown>
}

export interface MatrixAgentProposalScope {
  accountKey: string
  generation: number
}

export interface MatrixAgentProposalsDependencies {
  /** The signed-in account; a different key or generation drops every card. */
  scope(): MatrixAgentProposalScope | null
  platform?: MatrixAgentProposalPlatform
  /** The display name of one of the person's agents, from main's own roster. */
  agentName(principal: string): string | undefined
  /** The display name of a listed Store offer at that version. */
  offerName(offerId: string, offerVersion: number): string | undefined
  /** A room's cards changed. */
  changed(roomId: string): void
  /** Main-process encrypted account storage; never supplied by the window. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
  now?(): number
}

/** Where a trusted main-process source says a proposal belongs; never from the window. */
export interface MatrixAgentProposalPlacement {
  proposalId: string
  roomId: string
  eventId: string
}

interface Entry {
  card: MatrixAgentProposalCard
  record: MatrixAgentProposalRecord
  confirming?: Promise<MatrixAgentProposalCard>
}

const OPERATIONS = { create: 'create', propose_hire: 'hire', propose_retire: 'retire' } as const

function sameScope(left: MatrixAgentProposalScope | null, right: MatrixAgentProposalScope | null): boolean {
  return Boolean(left && right && left.accountKey === right.accountKey && left.generation === right.generation)
}

/**
 * Admits a proposal only from the platform's record, and confirms it only with the person's
 * own session. The window names a proposal by ID and nothing else: no price, name, owner or
 * outcome it sends is ever read.
 */
export class MatrixAgentProposals {
  private readonly entries = new Map<string, Entry>()
  private declines: Record<string, number> = {}
  private scoped: MatrixAgentProposalScope | null = null

  constructor(private readonly dependencies: MatrixAgentProposalsDependencies) {}

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  /** Drops everything when the account changed; answers whether the current one is usable. */
  private current(): MatrixAgentProposalScope | null {
    const scope = this.dependencies.scope()

    if (!sameScope(scope, this.scoped)) {
      const rooms = new Set([...this.entries.values()].map(entry => entry.card.roomId))
      if (this.scoped) {
        this.dependencies.storage?.removeItem(this.declineKey(this.scoped.accountKey))
      }
      this.declines = {}
      if (scope) {
        try {
          const saved: unknown = JSON.parse(this.dependencies.storage?.getItem(this.declineKey(scope.accountKey)) ?? '{}')
          if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            this.declines = Object.fromEntries(Object.entries(saved).filter(([id, expiry]) =>
              matrixAgentProposalId(id) && typeof expiry === 'number' && expiry > this.now()))
          }
        } catch { /* Ignore unreadable decline history; platform admission remains authoritative. */ }
      }
      this.entries.clear()
      this.scoped = scope ? { ...scope } : null
      rooms.forEach(room => this.dependencies.changed(room))
    }

    return this.scoped
  }

  private declineKey(accountKey: string): string {
    return `matrix.agent-proposal-declines.${accountKey}`
  }

  /** Called on account publication, even if no proposal room is open. */
  refreshScope(): void {
    this.current()
  }

  private view(entry: Entry): MatrixAgentProposalCard {
    if (entry.card.state === 'pending' && this.now() >= entry.card.expiresAt) {
      entry.card = { ...entry.card, state: 'expired' }
    }

    return { ...entry.card }
  }

  private project(record: MatrixAgentProposalRecord, placement: MatrixAgentProposalPlacement): MatrixAgentProposalCard | undefined {
    const operation = OPERATIONS[record.operation]
    const intent = record.intent as Record<string, unknown>

    const agentName =
      operation === 'create'
        ? String(intent.displayName)
        : operation === 'retire'
          ? this.dependencies.agentName(String(intent.target))
          : this.dependencies.offerName(String(intent.offerId), Number(intent.offerVersion))

    if (!agentName?.trim()) {
      return undefined
    }

    const protons = matrixAgentProposalProtons(record)

    return {
      id: record.id,
      roomId: placement.roomId,
      eventId: placement.eventId,
      operation,
      agentName: agentName.trim(),
      ...(protons === undefined ? {} : { protons }),
      state: 'pending',
      expiresAt: Date.parse(record.expiresAt)
    }
  }

  /**
   * A proposal arrived for a message. Fetches the platform's record with the person's session
   * and admits it only when it is this person's own, pending, unexpired and nameable. A
   * proposal already here keeps its card (a second arrival never revives a settled one).
   */
  async offer(placement: MatrixAgentProposalPlacement, signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<boolean> {
    const platform = this.dependencies.platform
    const scope = this.current()

    if (
      !platform ||
      !scope ||
      !matrixAgentProposalId(placement.proposalId) ||
      !matrixAgentProposalRoomId(placement.roomId) ||
      !matrixAgentProposalEventId(placement.eventId)
    ) {
      return false
    }

    if (this.entries.has(placement.proposalId)) {
      return true
    }

    let raw: unknown

    try {
      raw = await platform.fetch(placement.proposalId, signal)
    } catch {
      return false
    }

    const parsed = MatrixAgentProposalRecordSchema.safeParse(raw)

    if (!parsed.success || !sameScope(scope, this.current()) || this.entries.has(placement.proposalId)) {
      return false
    }

    const record = parsed.data

    // Personal proposals only (O1): the person asked and the person owns it. Company and shared
    // proposals are O4 and stay off here.
    if (
      record.id !== placement.proposalId ||
      record.ownerKind !== 'person' ||
      record.visibility !== 'requester' ||
      record.owner !== record.requester ||
      record.state !== 'pending' ||
      Date.parse(record.expiresAt) <= this.now()
    ) {
      return false
    }

    const card = this.project(record, placement)

    if (!card) {
      return false
    }

    this.entries.set(record.id, { card: this.declines[record.id] ? { ...card, state: 'declined' } : card, record })
    this.dependencies.changed(card.roomId)

    return true
  }

  read(roomId: string): MatrixAgentProposalCard[] {
    if (!this.current()) {
      return []
    }

    return [...this.entries.values()].filter(entry => entry.card.roomId === roomId).map(entry => this.view(entry))
  }

  private settle(entry: Entry, next: Partial<MatrixAgentProposalCard>): MatrixAgentProposalCard {
    const { failure: _failure, ...card } = entry.card
    entry.card = { ...card, ...next }
    this.dependencies.changed(entry.card.roomId)

    return { ...entry.card }
  }

  confirm(proposalId: string): Promise<MatrixAgentProposalCard> {
    const scope = this.current()
    const entry = this.entries.get(proposalId)
    const platform = this.dependencies.platform

    if (!scope || !entry || !platform) {
      return Promise.reject(new Error('matrix_agent_proposal_unavailable'))
    }

    if (entry.confirming) {
      return entry.confirming
    }

    const view = this.view(entry)

    if (view.state !== 'pending' && view.state !== 'failed') {
      return Promise.resolve(view)
    }

    if (this.now() >= entry.card.expiresAt) {
      return Promise.resolve(this.settle(entry, { state: 'expired' }))
    }

    entry.confirming = (async () => {
      let raw: unknown

      try {
        raw = await platform.confirm(proposalId, AbortSignal.timeout(20_000))
      } catch {
        raw = undefined
      }

      if (!sameScope(scope, this.current()) || this.entries.get(proposalId) !== entry) {
        throw new Error('matrix_agent_proposal_stale')
      }

      return this.settle(entry, this.outcome(entry.record, raw))
    })().finally(() => {
      entry.confirming = undefined
    })

    return entry.confirming
  }

  /** The platform's answer, held to this proposal's own request and target. */
  private outcome(record: MatrixAgentProposalRecord, raw: unknown): Partial<MatrixAgentProposalCard> {
    const parsed = MatrixAgentProposalConfirmationSchema.safeParse(raw)
    const failed = { state: 'failed', failure: 'unavailable' } as const

    if (!parsed.success) {
      return failed
    }

    const result = parsed.data
    const code = 'error' in result ? result.error : result.status

    if (code === 'awaiting_funds') {
      return { state: 'failed', failure: 'funds' }
    }

    if (code === 'expired' || code === 'terms_changed') {
      return { state: 'expired' }
    }

    if ('error' in result) {
      return failed
    }

    if (result.status === 'retired') {
      return record.operation === 'propose_retire' && result.target === (record.intent as { target?: unknown }).target
        ? { state: 'confirmed' }
        : failed
    }

    return record.operation !== 'propose_retire' && result.requestId === record.requestId ? { state: 'confirmed' } : failed
  }

  decline(proposalId: string): MatrixAgentProposalCard {
    const entry = this.current() ? this.entries.get(proposalId) : undefined

    if (!entry) {
      throw new Error('matrix_agent_proposal_unavailable')
    }

    const view = this.view(entry)

    if (entry.confirming || (view.state !== 'pending' && view.state !== 'failed')) {
      return view
    }

    const declines = { ...this.declines, [proposalId]: entry.card.expiresAt }
    this.dependencies.storage?.setItem(this.declineKey(this.scoped!.accountKey), JSON.stringify(declines))
    this.declines = declines
    return this.settle(entry, { state: 'declined' })
  }
}

export interface MatrixAgentProposalsIpcDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  proposals: Pick<MatrixAgentProposals, 'read' | 'confirm' | 'decline'>
}

/** Trusted UI only. A proposal ID or a room ID is all that crosses IPC. */
export function registerMatrixAgentProposalsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: MatrixAgentProposalsIpcDependencies
): void {
  ipc.handle(MATRIX_AGENT_PROPOSALS_IPC.read, (event, roomId: unknown, ...rest: unknown[]) => {
    dependencies.assertTrusted(event)

    if (rest.length !== 0 || !matrixAgentProposalRoomId(roomId)) {
      throw new Error('matrix_agent_proposal_invalid_request')
    }

    return dependencies.proposals.read(roomId)
  })

  for (const action of ['confirm', 'decline'] as const) {
    ipc.handle(MATRIX_AGENT_PROPOSALS_IPC[action], (event, proposalId: unknown, ...rest: unknown[]) => {
      dependencies.assertTrusted(event)

      if (rest.length !== 0 || !matrixAgentProposalId(proposalId)) {
        throw new Error('matrix_agent_proposal_invalid_request')
      }

      return dependencies.proposals[action](proposalId)
    })
  }
}

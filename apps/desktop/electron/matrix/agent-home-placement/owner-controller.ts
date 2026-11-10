/** Owner-facing `atum.agent-home/2.5` requests. Main keeps every key and bearer. */
import { randomUUID } from 'node:crypto'

import type { MatrixShelfModelView } from '../../../shared/matrix-shelf-models'

import { CallPacer } from './call-pacer'
import type { PlacementConnectionAuth } from './connection-auth'
import type { PlacementConnectionFailure, PlacementConnectionPlatform } from './connection-platform'
import {
  type AgentHomeOwnerModelChoiceReceiptV25,
  type AgentHomeOwnerMovePreflightV25,
  type AgentHomeOwnerMoveProgressV25,
  type AgentHomeOwnerPlacementSnapshotV25,
  ATUM_MANAGED_CONNECTION_REF,
  destinationForV25,
  type HomeLocationV25,
  type MacConnectionCatalogV25,
  type ModelApplicationProjectionV25,
  type PlacementModelChoiceV25,
  sameLocationV25
} from './contract-v25'
import { outcomeIsDefinitive, RetryLedger } from './retry-ledger'

export interface AgentHomeOwnerState {
  snapshot: AgentHomeOwnerPlacementSnapshotV25
  catalogs: Readonly<Record<string, MacConnectionCatalogV25>>
  progress?: AgentHomeOwnerMoveProgressV25
  modelApplication?: ModelApplicationProjectionV25
}

export type OwnerPreflightResult =
  | { ok: true; preflight: AgentHomeOwnerMovePreflightV25 }
  | { ok: false; reason: string }

export type OwnerMoveResult =
  | { ok: true; progress: AgentHomeOwnerMoveProgressV25 }
  /** `retry`: the answer never came, so the same request may be sent again as the same operation. */
  | { ok: false; reason: string; retry?: true }

export type OwnerModelChoiceResult =
  | { ok: true; receipt: AgentHomeOwnerModelChoiceReceiptV25 }
  | { ok: false; reason: string }

export interface AgentHomeOwnerControllerOptions {
  platform: PlacementConnectionPlatform
  auth: PlacementConnectionAuth
  now?(): number
  uuid?(): string
  changed?(): void
}

export interface OwnerRefreshOptions {
  /** Reuse a state this young instead of asking the platform again (an owner action reads, then acts on what it read). */
  maxAgeMs?: number
  /** Read the current home's model application too. Off for the background follow: the participant reads it for itself. */
  application?: boolean
}

/** One cloud offer as the platform serves it (`atum.model-choice/1.1`: alias, efforts it allows, whether it is eligible now). */
export interface CloudHomeOffer {
  alias: string
  efforts: readonly string[]
  defaultEffort?: string
  eligible: boolean
  /** An OpenRouter shelf row's name and Proton price, when the offer carries them. */
  shelf?: MatrixShelfModelView
}

export interface CloudHomeOption {
  choice: PlacementModelChoiceV25
  available: boolean
}

const MANAGED_EFFORTS = ['low', 'medium', 'high'] as const
type ManagedEffort = (typeof MANAGED_EFFORTS)[number]

const isManagedEffort = (value: unknown): value is ManagedEffort => MANAGED_EFFORTS.some(effort => effort === value)

/**
 * What the platform did not serve (no offer read yet, or the read failed): the two line-up aliases at their usual
 * effort, as before an offer existed. Nothing here is authority; the platform refuses an ineligible alias when it
 * is written.
 */
const FALLBACK_CLOUD_OFFERS: readonly CloudHomeOffer[] = [
  { alias: 'nguyet-thuc', efforts: ['medium'], defaultEffort: 'medium', eligible: true },
  { alias: 'nhat-thuc', efforts: ['medium'], defaultEffort: 'medium', eligible: true }
]

/** The cloud's managed choices, from the platform's own offer when it is known. */
export function cloudHomeOptions(offers?: readonly CloudHomeOffer[]): readonly CloudHomeOption[] {
  return (offers && offers.length > 0 ? offers : FALLBACK_CLOUD_OFFERS).flatMap(row => {
    const efforts = row.efforts.filter(isManagedEffort)
    const effort = isManagedEffort(row.defaultEffort) && efforts.includes(row.defaultEffort)
      ? row.defaultEffort
      : efforts.includes('medium')
        ? 'medium'
        : efforts[0]

    return effort
      ? [
          {
            choice: {
              destination: 'cloud',
              source: 'atum',
              connectionRef: ATUM_MANAGED_CONNECTION_REF,
              model: row.alias,
              effort
            } as PlacementModelChoiceV25,
            available: row.eligible
          }
        ]
      : []
  })
}

/** The choices an owner may pick for the cloud right now. */
export const cloudHomeChoices = (offers?: readonly CloudHomeOffer[]): readonly PlacementModelChoiceV25[] =>
  cloudHomeOptions(offers).flatMap(option => (option.available ? [option.choice] : []))

/**
 * The assistant lives on a Mac the platform cannot use right now (asleep, offline, or its models went stale), so it offers no
 * move: `platform_not_ready` for a Mac home. (`client_update_required` is another thing, and a cloud home is not a Mac.)
 */
export function waitingForHomeMac(snapshot: AgentHomeOwnerPlacementSnapshotV25): boolean {
  return (
    snapshot.placement.location.kind === 'mac' &&
    snapshot.moveCapability.state === 'unavailable' &&
    snapshot.moveCapability.reason === 'platform_not_ready'
  )
}

function reason(result: PlacementConnectionFailure): string {
  return result.reason ?? result.kind
}

const PROGRESS_MEMORY = 32
const FOLLOW_MIN_MS = 5_000
const FOLLOW_MAX_MS = 120_000

const progressOpen = (progress: AgentHomeOwnerMoveProgressV25 | undefined): boolean =>
  progress !== undefined && progress.state !== 'ready' && progress.state !== 'failed'

export class AgentHomeOwnerController {
  private readonly states = new Map<string, AgentHomeOwnerState>()
  private readonly failures = new Map<string, PlacementConnectionFailure>()
  private readonly highestProgress = new Map<string, number>()
  private readonly readAt = new Map<string, { state: number; catalogs?: number }>()
  private readonly lastChange = new Map<string, { signature: string; at: number }>()
  private readonly ledger: RetryLedger
  private readonly pacer: CallPacer

  constructor(private readonly options: AgentHomeOwnerControllerOptions) {
    this.ledger = new RetryLedger({ now: options.now, uuid: options.uuid })
    this.pacer = new CallPacer({ now: options.now })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private uuid(): string {
    return this.options.uuid?.() ?? randomUUID()
  }

  state(agent: string): AgentHomeOwnerState | undefined {
    return this.states.get(agent)
  }

  /** Why the latest authoritative snapshot read failed. Kept separately from the last good
   * state so an outage never erases a place that was already known. */
  failure(agent: string): PlacementConnectionFailure | undefined {
    return this.failures.get(agent)
  }

  private remember(agent: string, next: AgentHomeOwnerState): AgentHomeOwnerState {
    const previous = this.states.get(agent)
    this.states.set(agent, next)
    if (JSON.stringify(previous) !== JSON.stringify(next)) {this.options.changed?.()}
    return next
  }

  /**
   * Progress is monotonic: a lower sequence is an old answer arriving late and is ignored; an equal or higher one is
   * accepted (an equal sequence may carry a changed state, and the newest answer is the one to show).
   */
  private rememberProgress(agent: string, progress: AgentHomeOwnerMoveProgressV25): boolean {
    const previous = this.highestProgress.get(progress.moveId) ?? 0
    if (progress.sequence < previous) {return false}

    this.highestProgress.delete(progress.moveId)
    this.highestProgress.set(progress.moveId, progress.sequence)

    while (this.highestProgress.size > PROGRESS_MEMORY) {
      const oldest = this.highestProgress.keys().next().value

      if (oldest === undefined) {break}
      this.highestProgress.delete(oldest)
    }

    const current = this.states.get(agent)
    if (current) {this.remember(agent, { ...current, progress })}
    return true
  }

  private async read(
    agent: string,
    signal: AbortSignal,
    catalogs: boolean,
    options: OwnerRefreshOptions
  ): Promise<{ ok: true; state: AgentHomeOwnerState } | PlacementConnectionFailure> {
    const read = await this.options.platform.readOwner(agent, signal)
    if (read.ok === false) {
      this.failures.set(agent, read)
      return read
    }
    this.failures.delete(agent)

    const snapshot = read.value
    const previous = this.states.get(agent)
    let progress = previous?.progress
    let modelApplication = previous?.modelApplication
    let resolvedCatalogs: Readonly<Record<string, MacConnectionCatalogV25>> = previous?.catalogs ?? {}
    const activeMove = snapshot.placement.activeMove

    if (activeMove) {
      const result = await this.options.platform.readProgress(agent, activeMove.moveId, signal)
      if (result.ok === true && this.rememberProgress(agent, result.value)) {progress = result.value}
    } else if (progress?.state !== 'ready' && progress?.state !== 'failed') {
      progress = undefined
    }

    if (snapshot.placement.location.kind === 'mac') {
      if (options.application !== false) {
        const application = await this.options.platform.readModelApplication(agent, signal)
        if (application.ok === true) {modelApplication = application.value}
      }
    } else {
      modelApplication = undefined
    }

    if (catalogs) {
      const deviceIds = new Set(snapshot.eligibleDevices.map(device => device.deviceServiceId))
      if (snapshot.placement.location.kind === 'mac') {deviceIds.add(snapshot.placement.location.deviceServiceId)}
      const entries = await Promise.all(
        [...deviceIds].map(async deviceServiceId => {
          const catalog = await this.options.platform.readCatalog(agent, deviceServiceId, signal)
          return catalog.ok === true ? ([deviceServiceId, catalog.value] as const) : null
        })
      )
      resolvedCatalogs = Object.fromEntries(entries.filter((entry): entry is readonly [string, MacConnectionCatalogV25] => entry !== null))
    }

    const now = this.now()
    const stamp = this.readAt.get(agent)
    this.readAt.set(agent, { state: now, ...(catalogs ? { catalogs: now } : stamp?.catalogs === undefined ? {} : { catalogs: stamp.catalogs }) })

    return {
      ok: true,
      state: this.remember(agent, {
        snapshot,
        catalogs: resolvedCatalogs,
        ...(progress ? { progress } : {}),
        ...(modelApplication ? { modelApplication } : {})
      })
    }
  }

  async refresh(
    agent: string,
    signal: AbortSignal,
    catalogs = false,
    options: OwnerRefreshOptions = {}
  ): Promise<AgentHomeOwnerState | undefined> {
    const cached = this.states.get(agent)
    const stamp = this.readAt.get(agent)

    if (
      cached &&
      stamp &&
      options.maxAgeMs !== undefined &&
      this.now() - stamp.state < options.maxAgeMs &&
      (!catalogs || (stamp.catalogs !== undefined && this.now() - stamp.catalogs < options.maxAgeMs))
    ) {
      return cached
    }

    const result = await this.read(agent, signal, catalogs, options)

    return result.ok === true ? result.state : cached
  }

  /**
   * Keep the owner's view of a move current while one is under way, at a pace that slows as nothing changes (5 s
   * while it moves, up to 2 minutes while it waits for a Mac), backing off when the platform fails or limits. Idle
   * agents are not read at all: the sheet reads when the owner opens it.
   */
  async follow(agent: string, moving: boolean, signal: AbortSignal): Promise<void> {
    const key = `owner:${agent}`
    const state = this.states.get(agent)

    if (!moving && !progressOpen(state?.progress)) {
      this.pacer.forget(key)
      this.lastChange.delete(agent)
      return
    }

    if (!this.pacer.due(key)) {return}

    const result = await this.read(agent, signal, false, { application: false })

    if (result.ok === false) {
      this.pacer.failed(key, result.retryAfterMs)
      return
    }

    const signature = JSON.stringify([result.state.snapshot.placement.activeMove?.status ?? null, result.state.progress?.state ?? null, result.state.progress?.sequence ?? null])
    const now = this.now()
    const last = this.lastChange.get(agent)

    if (!last || last.signature !== signature) {this.lastChange.set(agent, { signature, at: now })}

    this.pacer.ok(key, Math.min(FOLLOW_MAX_MS, Math.max(FOLLOW_MIN_MS, (now - (this.lastChange.get(agent)?.at ?? now)) / 4)))
  }

  /** The agent is gone from this Mac. */
  forget(agent: string): void {
    this.states.delete(agent)
    this.failures.delete(agent)
    this.readAt.delete(agent)
    this.lastChange.delete(agent)
    this.pacer.forget(`owner:${agent}`)
  }

  /** Something just happened that makes the owner's view worth reading again (the owner acted, a move was seen to start). */
  wake(agent: string): void {
    this.pacer.wake(`owner:${agent}`)
  }

  async preflight(
    agent: string,
    target: HomeLocationV25,
    choice: PlacementModelChoiceV25,
    catalogRevision: number,
    signal: AbortSignal
  ): Promise<OwnerPreflightResult> {
    const state = await this.refresh(agent, signal, true, { maxAgeMs: 10_000 })
    if (!state) {return { ok: false, reason: 'unsupported' }}

    if (sameLocationV25(state.snapshot.placement.location, target)) {return { ok: false, reason: 'already_there' }}

    // A Mac home that is not answering (asleep, offline, or its catalog has gone stale) leaves exactly one way out that the
    // platform supports: the owner's disclosed move to the cloud, which they accept losing the work since the last
    // checkpoint for. Every other move waits for that Mac. (The platform decides the cloud move; it is not refused here.)
    const waiting = waitingForHomeMac(state.snapshot)

    if (state.snapshot.moveCapability.state !== 'available' && !(waiting && target.kind === 'cloud')) {
      return { ok: false, reason: waiting ? 'current_home_unreachable' : 'unsupported' }
    }

    if (choice.destination !== destinationForV25(target)) {return { ok: false, reason: 'invalid' }}

    const expectedActiveMoveId = state.snapshot.placement.activeMove?.moveId ?? null
    const expectedHomeEpoch = state.snapshot.placement.homeEpoch
    const key = RetryLedger.key('preflight', agent, { target, choice, catalogRevision, expectedHomeEpoch, expectedActiveMoveId })
    const identity = this.ledger.begin(key, 2)
    const body = await this.options.auth.signOwner(
      'owner.home.move.preflight-request',
      meta => ({
        meta,
        idempotencyKey: identity.ids[1]!,
        agentPrincipal: agent,
        target,
        chosenModel: choice,
        catalogRevision,
        expectedHomeEpoch,
        expectedActiveMoveId
      }),
      { requestId: identity.ids[0]! }
    )
    const result = await this.options.platform.preflight(agent, body as never, signal)
    if (outcomeIsDefinitive(result)) {this.ledger.settle(key)}
    if (result.ok === false) {return { ok: false, reason: reason(result) }}
    if (result.value.outcome === 'blocked') {return { ok: false, reason: result.value.reason }}
    return { ok: true, preflight: result.value }
  }

  async move(
    agent: string,
    preflight: AgentHomeOwnerMovePreflightV25,
    acceptCheckpointLoss: boolean,
    signal: AbortSignal
  ): Promise<OwnerMoveResult> {
    if (preflight.outcome !== 'ready') {return { ok: false, reason: preflight.reason ?? 'preflight_required' }}

    // Losing the work since the last checkpoint is the owner's explicit choice: never assumed, never set when nothing
    // was disclosed (the contract refuses a forced move that the accepted preflight did not disclose).
    const common = preflight.common
    const disclosed = common.checkpointLoss.state === 'disclosed'
    if (disclosed && !acceptCheckpointLoss) {return { ok: false, reason: 'checkpoint_loss_not_accepted' }}
    const accept = disclosed && acceptCheckpointLoss

    const key = RetryLedger.key('move', agent, { preflightId: common.preflightId, accept })
    const identity = this.ledger.begin(key, 3)
    const body = await this.options.auth.signOwner(
      'owner.home.move.request',
      meta => ({
        meta,
        moveId: identity.ids[2]!,
        idempotencyKey: identity.ids[1]!,
        agentPrincipal: agent,
        target: common.target,
        expectedHomeEpoch: common.expectedHomeEpoch,
        expectedActiveMoveId: common.expectedActiveMoveId,
        acceptedPreflight: {
          preflightId: common.preflightId,
          preflightRevision: common.preflightRevision,
          expiresAtPlatform: common.expiresAtPlatform,
          featureInventoryRevision: common.featureInventoryRevision,
          catalogRevision: common.catalogRevision,
          chosenModel: common.chosenModel,
          featureLosses: common.featureLosses,
          lastCheckpointAtPlatform: common.lastCheckpointAtPlatform,
          conversationOverrideCount: common.conversationOverrideCount,
          checkpointLoss: common.checkpointLoss
        },
        acceptCheckpointLoss: accept
      }),
      { requestId: identity.ids[0]! }
    )
    const result = await this.options.platform.requestMove(agent, body as never, signal)
    const definitive = outcomeIsDefinitive(result)
    if (definitive) {this.ledger.settle(key)}
    if (result.ok === false) {return { ok: false, reason: reason(result), ...(definitive ? {} : { retry: true as const }) }}
    this.rememberProgress(agent, result.value)
    this.wake(agent)
    return { ok: true, progress: result.value }
  }

  async cancel(agent: string, signal: AbortSignal): Promise<OwnerMoveResult> {
    const state = await this.refresh(agent, signal, false, { maxAgeMs: 10_000, application: false })
    const active = state?.snapshot.placement.activeMove
    if (!state || !active) {return { ok: false, reason: 'stale' }}

    const expectedHomeEpoch = state.snapshot.placement.homeEpoch
    const key = RetryLedger.key('cancel', agent, { moveId: active.moveId, expectedHomeEpoch })
    const identity = this.ledger.begin(key, 3)
    const body = await this.options.auth.signOwner(
      'owner.home.move.cancel',
      meta => ({
        meta,
        cancelId: identity.ids[2]!,
        idempotencyKey: identity.ids[1]!,
        agentPrincipal: agent,
        moveId: active.moveId,
        expectedHomeEpoch,
        expectedActiveMoveId: active.moveId
      }),
      { requestId: identity.ids[0]! }
    )
    const result = await this.options.platform.cancelMove(agent, body as never, signal)
    const definitive = outcomeIsDefinitive(result)
    if (definitive) {this.ledger.settle(key)}
    if (result.ok === false) {return { ok: false, reason: reason(result), ...(definitive ? {} : { retry: true as const }) }}
    this.rememberProgress(agent, result.value)
    this.wake(agent)
    return { ok: true, progress: result.value }
  }

  async chooseModel(
    agent: string,
    choice: PlacementModelChoiceV25,
    expectedChoiceRevision: number,
    signal: AbortSignal
  ): Promise<OwnerModelChoiceResult> {
    const state = await this.refresh(agent, signal, true, { maxAgeMs: 10_000 })
    if (!state) {return { ok: false, reason: 'unavailable' }}
    const placement = state.snapshot.placement
    if (choice.destination !== destinationForV25(placement.location)) {return { ok: false, reason: 'destination_not_current' }}

    const expectedActiveMoveId = placement.activeMove?.moveId ?? null
    const key = RetryLedger.key('model', agent, {
      currentHome: placement.location,
      expectedHomeId: placement.homeId,
      expectedHomeEpoch: placement.homeEpoch,
      expectedActiveMoveId,
      expectedChoiceRevision,
      choice
    })
    const identity = this.ledger.begin(key, 2)
    const body = await this.options.auth.signOwner(
      'owner.home.model-choice.write',
      meta => ({
        meta,
        idempotencyKey: identity.ids[1]!,
        agentPrincipal: agent,
        currentHome: placement.location,
        expectedHomeId: placement.homeId,
        expectedHomeEpoch: placement.homeEpoch,
        expectedActiveMoveId,
        expectedChoiceRevision,
        choice
      }),
      { requestId: identity.ids[0]! }
    )
    const result = await this.options.platform.writeModelChoice(agent, body as never, signal)
    if (outcomeIsDefinitive(result)) {this.ledger.settle(key)}
    if (result.ok === false) {return { ok: false, reason: reason(result) }}
    this.wake(agent)
    return { ok: true, receipt: result.value }
  }
}

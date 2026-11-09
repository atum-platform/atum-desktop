/**
 * What the agent's "Where it lives" sheet asks of main (`kind: 'agentHome'`): read the owner's view, review a move, move,
 * cancel, change the current home's default model, and set this Mac up for the agent. Main keeps the exact signed preflight it
 * reviewed; the window only ever holds its id. Nothing here is a second authority: every answer is the platform's.
 *
 * The one thing the owner must say for themselves is `acceptCheckpointLoss`: the work done since the last checkpoint is
 * lost only if they tick it for THIS review. It is read from the request and nowhere else, never assumed from the
 * disclosure, and never sent for a review that disclosed no such loss.
 */
import type { MatrixAgentHomeMoveResult, MatrixAgentHomePreflightView, MatrixAgentHomeView } from '../../../shared/matrix'

import type { PrepareResult } from './connection-participant'
import type { AgentHomeOwnerMovePreflightV25, PlacementModelChoiceV25 } from './contract-v25'
import {
  type AgentHomeOwnerController,
  type AgentHomeOwnerState,
  cloudHomeChoices,
  type CloudHomeOffer
} from './owner-controller'

export type AgentHomeOwnerRequest = Readonly<Record<string, unknown>> & { action?: unknown }

export interface RetainedPreflight {
  scope: string
  preflight: AgentHomeOwnerMovePreflightV25
}

export interface AgentHomeOwnerIpcDeps {
  owner: Pick<AgentHomeOwnerController, 'refresh' | 'preflight' | 'move' | 'cancel' | 'chooseModel'>
  /** Look at the agent at the next beat instead of when its time comes. */
  kick(agent: string): void
  /** The window's state changed. */
  publish(): void
  /** The signed-in account's scope: a retained review belongs to one account only. */
  scope(): string | null
  refreshNames(): Promise<void>
  view(agent: string): MatrixAgentHomeView | undefined
  /** The cloud models the platform serves this agent now, when an offer was read. */
  cloudOffers(agent: string): readonly CloudHomeOffer[] | undefined
  /** Read the platform's cloud offer (the sheet is open and none is known yet). */
  loadCloudOffers(agent: string): Promise<void>
  /** The cloud default's revision from the earlier model-destinations snapshot, before a 2.5 application row exists. */
  cloudChoiceRevision(agent: string): Promise<number | undefined>
  /** The owner's explicit "Set this Mac up for <agent>" (enroll for it, publish its catalog). Moves nothing. */
  prepare(agent: string, signal: AbortSignal): Promise<PrepareResult>
  retained: Map<string, RetainedPreflight>
  now?(): number
}

export type ResolvedHomeChoice = {
  target: { kind: 'cloud' } | { kind: 'mac'; deviceServiceId: string }
  choice: PlacementModelChoiceV25
  catalogRevision: number
}

/**
 * The exact target and choice a window's pick means, from what the platform last said: the cloud's served models, or a
 * fresh catalog of the Mac. Null when the pick is not on offer now (the window may have been left open).
 */
export function ownerHomeChoice(
  owner: AgentHomeOwnerState,
  target: unknown,
  selected: unknown,
  cloudOffers?: readonly CloudHomeOffer[],
  now: number = Date.now()
): ResolvedHomeChoice | null {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {return null}
  const row = selected as Record<string, unknown>
  if (
    typeof row.connectionRef !== 'string' ||
    typeof row.model !== 'string' ||
    !['low', 'medium', 'high', 'max'].includes(String(row.effort))
  ) {return null}

  if (target === 'cloud') {
    const choice = cloudHomeChoices(cloudOffers).find(
      each =>
        each.connectionRef === row.connectionRef &&
        each.model === row.model &&
        each.effort === row.effort
    )
    return choice ? { target: { kind: 'cloud' }, choice, catalogRevision: 0 } : null
  }

  if (typeof target !== 'string') {return null}
  const device = owner.snapshot.eligibleDevices.find(
    each => each.deviceServiceId === target && each.eligibility === 'ready'
  )
  const current =
    owner.snapshot.placement.location.kind === 'mac' &&
    owner.snapshot.placement.location.deviceServiceId === target
  const catalog = owner.catalogs[target]
  if ((!device && !current) || catalog?.freshness !== 'fresh' || now >= catalog.freshUntilPlatform) {return null}

  const connection = catalog.connections.find(each => each.connectionRef === row.connectionRef && each.state === 'available')
  const model = connection?.models.find(each => each.model === row.model && each.efforts.includes(row.effort as never))
  if (!connection || !model) {return null}
  if (connection.source === 'atum' && row.effort === 'max') {return null}

  return {
    target: { kind: 'mac', deviceServiceId: target },
    choice: {
      destination: `mac:${target}`,
      deviceServiceId: target,
      source: connection.source,
      connectionRef: connection.connectionRef,
      model: model.model,
      effort: row.effort as 'low' | 'medium' | 'high'
    } as PlacementModelChoiceV25,
    catalogRevision: catalog.catalogRevision
  }
}

const signal = (ms: number) => AbortSignal.timeout(ms)

export async function handleAgentHomeOwnerRequest(
  request: AgentHomeOwnerRequest,
  principal: string,
  deps: AgentHomeOwnerIpcDeps
): Promise<
  | MatrixAgentHomeView
  | undefined
  | MatrixAgentHomePreflightView
  | MatrixAgentHomeMoveResult
  | { ok: boolean; reason?: string }
  | { status: 'saved' | 'refused'; reason?: string }
> {
  const now = () => deps.now?.() ?? Date.now()

  if (request.action === 'read') {
    await Promise.all([
      deps.refreshNames(),
      deps.owner.refresh(principal, signal(20_000), true),
      deps.cloudOffers(principal) ? undefined : deps.loadCloudOffers(principal)
    ])
    deps.publish()

    return deps.view(principal)
  }

  if (request.action === 'preflight') {
    const owner = await deps.owner.refresh(principal, signal(20_000), true)
    const resolved = owner ? ownerHomeChoice(owner, request.target, request.model, deps.cloudOffers(principal), now()) : null
    if (!resolved) {return { ok: false, reason: 'connection_unavailable' }}

    const result = await deps.owner.preflight(principal, resolved.target, resolved.choice, resolved.catalogRevision, signal(20_000))

    if (result.ok === false) {
      // The platform answers `target_unavailable` for a Mac that has no active executor for the agent (it never does for the
      // cloud), and its closed reason set has no word of its own for "not set up". This client does: `target_not_prepared`.
      return resolved.target.kind === 'mac' && result.reason === 'target_unavailable'
        ? { ok: false, reason: 'target_not_prepared' }
        : result
    }

    const scope = deps.scope()
    if (!scope) {return { ok: false, reason: 'unavailable' }}
    const common = result.preflight.common
    deps.retained.set(`${principal}:${common.preflightId}`, { scope, preflight: result.preflight })

    return {
      ok: true,
      preflightId: common.preflightId,
      target: request.target as 'cloud' | string,
      featureLosses: common.featureLosses,
      lastCheckpointAtPlatform: common.lastCheckpointAtPlatform,
      // The window must show the timestamp and ask; this is only whether it has to.
      checkpointLossRequired: common.checkpointLoss.state === 'disclosed'
    }
  }

  if (request.action === 'move') {
    if (typeof request.preflightId !== 'string') {throw new Error('matrix_command_invalid')}
    const key = `${principal}:${request.preflightId}`
    const retained = deps.retained.get(key)
    const scope = deps.scope()
    if (!retained || !scope || retained.scope !== scope) {
      deps.retained.delete(key)

      return { ok: false, reason: 'preflight_required' }
    }

    // The owner's own tick for this review, or nothing: a review that disclosed a loss is not moved without it.
    const result = await deps.owner.move(principal, retained.preflight, request.acceptCheckpointLoss === true, signal(30_000))

    // A review is used up by the platform's answer. When the answer never came, the same review (and the same operation)
    // can be sent again; and one the owner has not yet accepted can still be.
    if (result.ok === true || (result.retry !== true && result.reason !== 'checkpoint_loss_not_accepted')) {
      deps.retained.delete(key)
    }

    deps.kick(principal)
    deps.publish()

    return result.ok === true ? { ok: true } : { ok: false, reason: result.reason }
  }

  if (request.action === 'cancel') {
    const result = await deps.owner.cancel(principal, signal(20_000))
    deps.kick(principal)
    deps.publish()

    return result.ok === true ? { ok: true } : { ok: false, reason: result.reason }
  }

  if (request.action === 'prepare') {
    // Enrolling and starting Hermes to read this Mac's connections take a while; the same press twice is one set-up.
    const result = await deps.prepare(principal, signal(90_000))
    deps.kick(principal)
    deps.publish()

    return result.ok === true ? { ok: true } : { ok: false, reason: result.reason }
  }

  if (request.action === 'model') {
    const owner = await deps.owner.refresh(principal, signal(20_000), true)
    if (!owner) {return { status: 'refused', reason: 'unavailable' }}
    const target = owner.snapshot.placement.location.kind === 'cloud'
      ? 'cloud'
      : owner.snapshot.placement.location.deviceServiceId
    const resolved = ownerHomeChoice(owner, target, request.model, deps.cloudOffers(principal), now())
    if (!resolved) {return { status: 'refused', reason: 'connection_unavailable' }}
    const predecessor = target === 'cloud' ? await deps.cloudChoiceRevision(principal) : undefined
    const choiceRevision = owner.modelApplication?.choiceRevision ?? predecessor ?? 0
    const result = await deps.owner.chooseModel(principal, resolved.choice, choiceRevision, signal(20_000))
    deps.kick(principal)
    deps.publish()

    return result.ok === true ? { status: 'saved' } : { status: 'refused', reason: result.reason }
  }

  throw new Error('matrix_command_invalid')
}

/**
 * Who may ask the platform for a home's archive or its key, and the signed envelope it asks with (atum-platform #664,
 * `apps/shell/src/lib/agent-home-archive.ts`, `matrix-agent-home.ts` and migration 0284).
 *
 * Every one of these calls is signed like the other `atum.agent-home/2.1` calls: a `meta` header from this Mac's device
 * key (`MacExecutorAuth`) and a `fence`. But the routes admit a DEVICE, not a lease. `agent_home_archive_device_allowed`
 * lets in the placement's Mac and the target of the placement's one active move, nobody else, and `agent_home_seal_binding`
 * checks the fence's owner, agent, home and epoch against the placement. It does not look at the fence's lease, term or
 * operation (only that they are well formed), because a move's target holds no lease until it is the home, and the target
 * is exactly the Mac that has to read the archive before it can become the home.
 *
 * So:
 *
 *   - a Mac that holds the agent's answering lease presents it, as it does on every other call;
 *   - a Mac that holds none (the target of a move, or the home that has just been made and has not yet been brought up)
 *     presents a CUSTODY lease: the placement's own facts, term 1, a lease id made up for the call, and the end of its own
 *     frame as the lease's end. It claims no authority it does not have; the platform admits it by device and does not read
 *     it. If the platform ever starts to read those fields for these routes, a made-up lease is refused (403) and the Mac
 *     fails closed without having sent a byte, which is what it should do;
 *   - the placement is read fresh for every call, the only authority on who the home is, and a Mac that is neither the home
 *     nor the move's target signs nothing.
 *
 * The signed bytes are `utf8("atum.agent-home/2.1" NUL action NUL canonicalJson(body without meta.signature))` with
 * `action` one of `HomeKeyRead`, `CheckpointArchiveBegin`, `CheckpointArchiveFinalize`, `CheckpointArchiveDownload`, so
 * none can be replayed as another, and a frame is signed fresh for every attempt (the platform refuses one it has seen).
 */
import { randomUUID } from 'node:crypto'

import type { ArchiveAction, ArchiveFailure, ArchiveSigner } from './archive-store'
import type { HomeLeaseFence, HomeOperation, HomePlacement } from './contract'
import { ExecutorAuthError, type MacExecutorAuth } from './executor-auth'
import { fenceFromLease, type LeaseFacts, withOperation } from './fence'
import type { HomePlatform } from './platform-client'

/** The moves whose target the platform lets read the archive: from the request until it commits or ends. */
const MOVING_TO = new Set(['requested', 'draining', 'ready_to_commit'])

/**
 * `agent_home_archive_device_allowed`, as the Mac reads it from the placement: this Mac is the placement's Mac, or the target of
 * the placement's active move.
 */
export function mayHoldCustody(placement: HomePlacement, me: string): boolean {
  if (placement.location.kind === 'mac' && placement.location.deviceServiceId === me) {
    return true
  }

  const move = placement.activeMove

  return Boolean(move && MOVING_TO.has(move.status) && move.target.kind === 'mac' && move.target.deviceServiceId === me)
}

/** The lease section of a fence for a Mac that holds no lease: the placement's facts and a lease that says it is none. */
export function custodyLease(placement: HomePlacement, frame: { expiresAt: number }, leaseId: string): HomeLeaseFence {
  return {
    ownerUserId: placement.ownerUserId,
    agentPrincipal: placement.agentPrincipal,
    homeId: placement.homeId,
    homeEpoch: placement.homeEpoch,
    executorTerm: 1,
    leaseId,
    leaseExpiresAtPlatform: frame.expiresAt
  }
}

export interface ArchiveCustodyDeps {
  platform: Pick<HomePlatform, 'readPlacement'>
  auth: MacExecutorAuth
  /** This Mac's `deviceServiceId`, or null when it is not enrolled. */
  me(): string | null
  /** The answering lease's facts for the agent, or null when this Mac holds none. */
  leaseFacts(agent: string): LeaseFacts | null
  uuid?(): string
}

export class ArchiveCustody implements ArchiveSigner {
  constructor(private readonly deps: ArchiveCustodyDeps) {}

  async sign(
    call: { agent: string; homeId: string; action: ArchiveAction; operation?: HomeOperation },
    fields: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ ok: true; body: Record<string, unknown> } | ArchiveFailure> {
    const me = this.deps.me()

    if (!me) {
      return { ok: false, kind: 'forbidden' }
    }

    const read = await this.deps.platform.readPlacement(call.agent, signal)

    if (read.ok === false) {
      return read.kind === 'unsupported' || read.kind === 'unauthorized' || read.kind === 'forbidden'
        ? { ok: false, kind: read.kind }
        : { ok: false, kind: 'unavailable' }
    }

    const placement = read.value

    // The caller was told another home than the platform names now (it moved, or was erased and made again): nothing is signed for it.
    if (placement.agentPrincipal !== call.agent || placement.homeId !== call.homeId) {
      return { ok: false, kind: 'conflict' }
    }

    if (!mayHoldCustody(placement, me)) {
      return { ok: false, kind: 'forbidden' }
    }

    const lease = fenceFromLease(placement, this.deps.leaseFacts(call.agent))
    const uuid = this.deps.uuid ?? randomUUID
    const operation: HomeOperation = call.operation ?? { kind: 'job', id: uuid() }

    try {
      const body = await this.deps.auth.sign(call.action, meta => ({
        ...fields,
        meta,
        fence: withOperation(lease ?? custodyLease(placement, meta, uuid()), operation)
      }))

      return { ok: true, body }
    } catch (error) {
      if (error instanceof ExecutorAuthError) {
        return { ok: false, kind: 'unavailable' }
      }

      throw error
    }
  }
}

import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'

import type { MatrixIdentity } from '../../shared/matrix'

/**
 * One agent's executor on this Mac replaced by a new one, which the platform gives a new device
 * ( WS-B):
 *
 * - automatically, when the agent's device can no longer be trusted: its keys changed under the
 *   same device ID after its local store was lost (agent-trust.ts `matrix_agent_device_replaced`;
 *   Atum Moon on the MacBook, 2026-10-04, after the disk filled up). The owner's store keeps the
 *   first keys it saw for that ID forever, so no handshake can succeed and only a new device
 *   mends it;
 * - when the person presses Reconnect: an executor the platform withdrew (a renewal refused), or
 *   a replacement that could not finish;
 * - when a saved execution policy enables this Mac for an agent whose old cloud move withdrew its
 *   local executor. Like Reconnect, this is an owner-authored transition rather than an automatic
 *   trust-repair loop, so the device-replacement daily cap does not apply.
 *
 * The agent itself is untouched: its identity comes back on the new device from the owner's
 * recovery (agent-trust.ts), its chats are the same rooms, and its Hermes home stays (a named
 * agent's home is bound to the agent, agent-home.ts; the default agent's moves to the new
 * executor, `carryMatrixHermesHome`).
 *
 * Bounded: at most `MATRIX_AUTOMATIC_REENROLLMENTS` automatic replacements per agent per day on
 * this Mac, so a fault that keeps coming back can never mint executors in a loop (Atum Main
 * minted 491 executor sessions on 10-01/02). The platform's own bounds (0150, a 429 with
 * Retry-After) still apply to every enrollment, the person's included.
 */
export const MATRIX_AUTOMATIC_REENROLLMENTS = 2
const DAY_MS = 24 * 60 * 60 * 1000

/** Which agent, for the ledger: a hash, so the file lists no principal in the clear. */
export function matrixReenrollKey(owner: string, agent: string | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(['atum-agent-reenroll/v1', owner, agent ?? '']))
    .digest('hex')
}

export interface MatrixReenrollStore {
  /** The ledger as kept, `null` when there is none yet; throws when it can't be read. */
  read(): string | null
  write(value: string): void
}

/**
 * When this Mac replaced each agent's executor by itself, for the daily bound. This run's latest
 * copy is kept in memory too, so a write that fails (a full disk: the very thing that loses an
 * agent's keys) never loosens the bound; a ledger that can't be read or makes no sense counts as
 * the bound reached for automatic replacements. Reconnect and an owner-saved policy are never
 * bound by it.
 */
export class MatrixAgentReenrollments {
  private memory: Record<string, number[]> | undefined

  constructor(
    private readonly store: MatrixReenrollStore,
    private readonly now: () => number = Date.now
  ) {}

  /** The recent replacements, or `undefined` when the ledger can't be read. */
  private load(): Record<string, number[]> | undefined {
    let value: unknown = this.memory

    if (value === undefined) {
      try {
        const raw = this.store.read()
        value = raw === null ? {} : (JSON.parse(raw) as unknown)
      } catch {
        return undefined
      }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined
    }

    const since = this.now() - DAY_MS
    const kept: Record<string, number[]> = {}

    for (const [key, times] of Object.entries(value as Record<string, unknown>)) {
      if (/^[a-f0-9]{64}$/.test(key) && Array.isArray(times)) {
        const recent = times.filter((time): time is number => typeof time === 'number' && time > since)

        if (recent.length) {
          kept[key] = recent
        }
      }
    }

    return kept
  }

  /** Whether another automatic replacement is allowed for this agent today. */
  allowed(key: string): boolean {
    const ledger = this.load()

    return ledger !== undefined && (ledger[key]?.length ?? 0) < MATRIX_AUTOMATIC_REENROLLMENTS
  }

  record(key: string): void {
    const ledger = this.load() ?? {}
    ledger[key] = [...(ledger[key] ?? []), this.now()]
    this.memory = ledger

    try {
      this.store.write(JSON.stringify(ledger))
    } catch {
      // Kept in memory for this run; the next write tries the file again.
    }
  }
}

export type MatrixReenrollReason = 'device_replaced' | 'person' | 'policy'

export interface MatrixAgentReenrollPort {
  /** For logs only: the agent's principal, shortened. */
  label: string
  /** The device this Mac's executor for the agent has now, if any. */
  device(): MatrixIdentity | undefined
  /** Stops the agent's host and its Hermes. */
  stop(): Promise<void>
  /** Revokes this Mac's executor at the platform and clears its Hermes credentials here. */
  revoke(): Promise<void>
  /** Erases a device's local store: its keys are of no use to anyone now. */
  erase(device: MatrixIdentity): Promise<void>
  /** Starts the agent's gate again: it enrolls a new executor and trusts its new device. */
  restart(): void
  log(line: string): void
}

/**
 * Replaces the agent's executor here. `capped` when the automatic bound for today is reached
 * (nothing is touched; the person's Reconnect remains). A failure to revoke propagates: the old
 * executor is half withdrawn, and the person's Reconnect finishes it.
 */
export async function reenrollMatrixAgent(
  port: MatrixAgentReenrollPort,
  ledger: MatrixAgentReenrollments,
  key: string,
  reason: MatrixReenrollReason
): Promise<'started' | 'capped'> {
  if (reason === 'device_replaced') {
    if (!ledger.allowed(key)) {
      port.log(`[Matrix] agent ${port.label} executor replacement capped reason=${reason}`)

      return 'capped'
    }

    ledger.record(key)
  }

  const device = port.device()
  await port.stop()
  await port.revoke()

  if (device) {
    try {
      await port.erase(device)
    } catch {
      port.log(`[Matrix] agent ${port.label} old device store not erased`)
    }
  }

  port.log(`[Matrix] agent ${port.label} executor replaced reason=${reason}`)
  port.restart()

  return 'started'
}

/**
 * The default agent's Hermes home is named by its executor (hermes-runtime.ts
 * `matrixHermesHome`), so a new executor would start with an empty home: its memory and tools
 * on this Mac would be gone. The old home moves to the new executor's name instead, once, only
 * inside the same profiles folder, and never over a home that already exists.
 */
export function carryMatrixHermesHome(from: string, to: string, log: (line: string) => void): boolean {
  if (from === to || path.dirname(path.resolve(from)) !== path.dirname(path.resolve(to))) {
    return false
  }

  if (!existsSync(from)) {
    return false
  }

  if (existsSync(to)) {
    log('[Matrix] assistant home not moved: the new executor already has one')

    return false
  }

  try {
    renameSync(from, to)
    log('[Matrix] assistant home moved to its new executor')

    return true
  } catch {
    log('[Matrix] assistant home not moved')

    return false
  }
}

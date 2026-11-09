/**
 * Retry identity for the placement and connection writes.
 *
 * A retry of one logical operation (the owner pressed Move again after a lost answer; a catalog publish whose reply
 * never came) must be the SAME operation to the platform: the same `meta.requestId` and the same operation idempotency
 * key, plus the operation's own ids (`moveId`, `cancelId`, `publishId`, `applicationId`). `atum.agent-home/2.5`
 * excludes authentication metadata from effect identity, so a retry may carry renewed signature bytes; a Mac-signed
 * write that the platform hashes whole instead gets the very same signed bytes again while they are still valid.
 *
 * The ledger only remembers an operation whose outcome is UNKNOWN. A definitive answer (accepted, or refused) ends it:
 * the next identical request is a new operation with new ids, so an expired review is never replayed back at the owner.
 */
import { createHash, randomUUID } from 'node:crypto'

import { canonicalJson } from '../device/canonical'

import type { PlacementConnectionResult } from './connection-platform'

export interface RetryEntry {
  /** The operation's ids, in the order the caller asked for them (the request id first). */
  readonly ids: readonly string[]
  /** The signed bytes of the attempt that went out last, with the moment their signature stops being valid. */
  signed?: { body: unknown; expiresAt: number }
  touchedAt: number
}

export interface RetryLedgerOptions {
  now?(): number
  uuid?(): string
  /** How long an unanswered operation is remembered: past a signature's life nothing replays it anyway. */
  ttlMs?: number
  limit?: number
}

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_LIMIT = 64
/** A signed attempt is re-sent as is only while it has at least this long to live. */
const REUSE_MARGIN_MS = 30_000

export class RetryLedger {
  private readonly entries = new Map<string, RetryEntry>()

  constructor(private readonly options: RetryLedgerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** One logical operation: its kind, its scope (agent) and the digest of its effect fields (never its authentication). */
  static key(kind: string, scope: string, effect: unknown): string {
    return `${kind}:${scope}:${createHash('sha256').update(canonicalJson(effect)).digest('hex').slice(0, 32)}`
  }

  /** The ids an earlier attempt of this operation used while its outcome is unknown, otherwise fresh ones. */
  begin(key: string, count: number): RetryEntry {
    const now = this.now()
    const known = this.entries.get(key)

    if (known && known.ids.length === count && now - known.touchedAt < (this.options.ttlMs ?? DEFAULT_TTL_MS)) {
      known.touchedAt = now
      return known
    }

    const entry: RetryEntry = {
      ids: Array.from({ length: count }, () => this.options.uuid?.() ?? randomUUID()),
      touchedAt: now
    }
    this.entries.delete(key)
    this.entries.set(key, entry)

    while (this.entries.size > (this.options.limit ?? DEFAULT_LIMIT)) {
      const oldest = this.entries.keys().next().value

      if (oldest === undefined) {break}
      this.entries.delete(oldest)
    }

    return entry
  }

  /** The signed bytes of the last attempt, while they are still valid long enough to be sent again. */
  reusable(entry: RetryEntry): unknown {
    return entry.signed && entry.signed.expiresAt - this.now() >= REUSE_MARGIN_MS ? entry.signed.body : undefined
  }

  /** The attempt that is going out now carries these signed bytes. */
  sent(entry: RetryEntry, body: unknown, expiresAt: number): void {
    entry.signed = { body, expiresAt }
  }

  /** The platform answered for good: the next identical request is a new operation. */
  settle(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Whether a result ends the operation. A lost answer, a timeout, a 429/5xx, a refused sign-in and a 2xx whose body
 * could not be read all leave it unknown (the effect may or may not have happened): those are retried as the same
 * operation. Everything else is the platform's answer.
 */
export function outcomeIsDefinitive(result: PlacementConnectionResult<unknown>): boolean {
  if (result.ok === true) {return true}

  switch (result.kind) {
    case 'conflict':
    case 'forbidden':
    case 'unsupported':
      return true
    case 'invalid':
      return result.status !== 200
    default:
      return false
  }
}

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { WorkScope } from './contract'

// The gate's durable store (plan §6.4, §11.3, §11.4). It lives in main's own
// account directory, outside T3's database and its snapshot, so a SQLite
// restore cannot roll a receipt, a counter or a stop owed back. Every method
// is synchronous: a call to one is a single atomic step as far as the gate's
// other code is concerned, which is what makes "admission and revocation take
// one lock" true without a lock (see gate.ts, `handoff` and `cutoff`).

export type ReceiptState = 'admitted' | 'launched' | 'rejected' | 'refused' | 'void'
export type Settlement = 'stopped' | 'never_sent' | 'nothing_started'

export interface ReceiptRow {
  principal: string
  requestId: string
  state: ReceiptState
  reason: string | null
  paramsHash: string | null
  callJson: string | null
  /** Settings fingerprint taken at admission: T3's provider and mode settings, the mode limit, project and model. */
  fingerprint: string | null
  sessionId: string | null
  threadId: string | null
  eventId: string | null
  notAfter: number | null
  epochAtAdmit: number | null
  generationAtAdmit: number | null
  /** Set durably BEFORE the first byte goes to T3 (plan §11.4). */
  forwarded: boolean
  forwardCount: number
  /** The T3 process incarnation the forward was handed to. A missing thread settles only after another one is ready. */
  incarnation: string | null
  runId: string | null
  /** The gate has seen the thread end with no run active. */
  finished: boolean
  stopScope: WorkScope | null
  stopAt: number | null
  revocationId: number | null
  settled: Settlement | null
  createdAt: number
  updatedAt: number
}

export interface AgentRow {
  principal: string
  generation: number
  entitled: boolean
}

export interface GrantRow {
  hash: string
  principal: string
  routeEpoch: number
  generation: number
  mintedAt: number
  expiresAt: number
  /** Replaced by a newer grant, or its agent or route was revoked. A dead grant answers `revoked`, not `unknown_grant`. */
  dead: boolean
  carried: boolean
}

export interface RevocationRow {
  id: number
  scope: WorkScope
  principal: string | null
  reason: string
  sourceSeq: number | null
  at: number
  ackedAt: number | null
}

export interface OutboxRow {
  id: number
  kind: string
  payload: string
  createdAt: number
  deliveredAt: number | null
  attempts: number
}

type Row = Record<string, unknown>

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 10000;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS agents (
    principal TEXT PRIMARY KEY, generation INTEGER NOT NULL, entitled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS grants (
    hash TEXT PRIMARY KEY, principal TEXT NOT NULL, route_epoch INTEGER NOT NULL, generation INTEGER NOT NULL,
    minted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dead INTEGER NOT NULL DEFAULT 0, carried INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS receipts (
    principal TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
    params_hash TEXT, call_json TEXT, fingerprint TEXT, session_id TEXT, thread_id TEXT, event_id TEXT,
    not_after INTEGER, epoch_at_admit INTEGER, generation_at_admit INTEGER,
    forwarded INTEGER NOT NULL DEFAULT 0, forward_count INTEGER NOT NULL DEFAULT 0, incarnation TEXT, run_id TEXT,
    finished INTEGER NOT NULL DEFAULT 0,
    stop_scope TEXT, stop_at INTEGER, revocation_id INTEGER, settled TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (principal, request_id));
  CREATE INDEX IF NOT EXISTS receipts_thread ON receipts (thread_id);
  CREATE TABLE IF NOT EXISTS claims (
    account TEXT NOT NULL, event_id TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY (account, event_id));
  CREATE TABLE IF NOT EXISTS revocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, principal TEXT, reason TEXT NOT NULL,
    source_seq INTEGER, at INTEGER NOT NULL, acked_at INTEGER);
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
`

function receipt(row: Row): ReceiptRow {
  return {
    principal: String(row.principal),
    requestId: String(row.request_id),
    state: row.state as ReceiptState,
    reason: (row.reason as string | null) ?? null,
    paramsHash: (row.params_hash as string | null) ?? null,
    callJson: (row.call_json as string | null) ?? null,
    fingerprint: (row.fingerprint as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    eventId: (row.event_id as string | null) ?? null,
    notAfter: (row.not_after as number | null) ?? null,
    epochAtAdmit: (row.epoch_at_admit as number | null) ?? null,
    generationAtAdmit: (row.generation_at_admit as number | null) ?? null,
    forwarded: row.forwarded === 1,
    forwardCount: Number(row.forward_count),
    incarnation: (row.incarnation as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    finished: row.finished === 1,
    stopScope: (row.stop_scope as WorkScope | null) ?? null,
    stopAt: (row.stop_at as number | null) ?? null,
    revocationId: (row.revocation_id as number | null) ?? null,
    settled: (row.settled as Settlement | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

export interface AdmitInput {
  principal: string
  requestId: string
  paramsHash: string
  callJson: string
  fingerprint: string
  sessionId: string
  threadId: string
  eventId: string
  notAfter: number
  epoch: number
  generation: number
}

export type AdmitResult = { ok: true } | { ok: false; reason: 'event_already_used' | 'request_exists' }

export interface CutoffInput {
  scope: WorkScope
  principal?: string
  reason: string
  sourceSeq?: number
}

export interface CutoffResult {
  revocationId: number
  owed: number
  routeEpoch: number
  generation?: number
}

export class GateLedger {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(
    path: string,
    private readonly account: string,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'a', 0o600))
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)

    if (this.meta('route_epoch') === undefined) {
      this.setMeta('route_epoch', 1)
    }
  }

  close(): void {
    this.db.close()
  }

  /** One durable transaction. Reentrant: an inner call joins the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++

      try {
        return fn()
      } finally {
        this.depth--
      }
    }

    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1

    try {
      const result = fn()
      this.db.exec('COMMIT')

      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back by SQLite
      }

      throw error
    } finally {
      this.depth = 0
    }
  }

  // ---- meta and counters
  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as Row | undefined)?.v as string | undefined
  }

  setMeta(key: string, value: string | number): void {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v')
      .run(key, String(value))
  }

  routeEpoch(): number {
    return Number(this.meta('route_epoch') ?? 1)
  }

  appliedSeq(): number {
    return Number(this.meta('applied_seq') ?? 0)
  }

  setAppliedSeq(seq: number): void {
    if (seq > this.appliedSeq()) {
      this.setMeta('applied_seq', seq)
    }
  }

  // ---- agents and grants
  agent(principal: string): AgentRow | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE principal = ?').get(principal) as Row | undefined

    return row ? { principal, generation: Number(row.generation), entitled: row.entitled === 1 } : undefined
  }

  agents(): AgentRow[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY principal').all() as Row[]).map(row => ({
      principal: String(row.principal),
      generation: Number(row.generation),
      entitled: row.entitled === 1
    }))
  }

  /** Create the agent at generation 1, or set its entitlement. A generation never moves here. */
  setEntitled(principal: string, entitled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO agents (principal, generation, entitled) VALUES (?, 1, ?) ON CONFLICT (principal) DO UPDATE SET entitled = excluded.entitled'
      )
      .run(principal, entitled ? 1 : 0)
  }

  grantByHash(hash: string): GrantRow | undefined {
    const row = this.db.prepare('SELECT * FROM grants WHERE hash = ?').get(hash) as Row | undefined

    return row ? this.grant(row) : undefined
  }

  liveGrant(principal: string): GrantRow | undefined {
    const row = this.db.prepare('SELECT * FROM grants WHERE principal = ? AND dead = 0').get(principal) as Row | undefined

    return row ? this.grant(row) : undefined
  }

  private grant(row: Row): GrantRow {
    return {
      hash: String(row.hash),
      principal: String(row.principal),
      routeEpoch: Number(row.route_epoch),
      generation: Number(row.generation),
      mintedAt: Number(row.minted_at),
      expiresAt: Number(row.expires_at),
      dead: row.dead === 1,
      carried: row.carried === 1
    }
  }

  /** One live grant per agent: minting replaces the old one at once. Keeps only the hash. */
  insertGrant(grant: Omit<GrantRow, 'dead' | 'carried'>): void {
    this.tx(() => {
      this.db.prepare('UPDATE grants SET dead = 1 WHERE principal = ? AND dead = 0').run(grant.principal)
      this.db
        .prepare(
          'INSERT INTO grants (hash, principal, route_epoch, generation, minted_at, expires_at, dead, carried) VALUES (?, ?, ?, ?, ?, ?, 0, 0)'
        )
        .run(grant.hash, grant.principal, grant.routeEpoch, grant.generation, grant.mintedAt, grant.expiresAt)
    })
  }

  markGrantCarried(hash: string): void {
    this.db.prepare('UPDATE grants SET carried = 1 WHERE hash = ?').run(hash)
  }

  killGrant(hash: string): void {
    this.db.prepare('UPDATE grants SET dead = 1 WHERE hash = ?').run(hash)
  }

  pruneGrants(before: number): void {
    this.db.prepare('DELETE FROM grants WHERE expires_at < ?').run(before)
  }

  // ---- receipts
  receipt(principal: string, requestId: string): ReceiptRow | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE principal = ? AND request_id = ?').get(principal, requestId) as
      | Row
      | undefined

    return row ? receipt(row) : undefined
  }

  receiptByThread(principal: string, threadId: string): ReceiptRow | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE principal = ? AND thread_id = ?').get(principal, threadId) as
      | Row
      | undefined

    return row ? receipt(row) : undefined
  }

  receipts(where = '1 = 1', ...args: (string | number)[]): ReceiptRow[] {
    return (this.db.prepare(`SELECT * FROM receipts WHERE ${where} ORDER BY created_at, request_id`).all(...args) as Row[]).map(receipt)
  }

  eventClaimed(eventId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM claims WHERE account = ? AND event_id = ?').get(this.account, eventId))
  }

  /** The claim on the owner's event and the `admitted` row, in one durable transaction (plan §11.3). */
  admit(input: AdmitInput): AdmitResult {
    try {
      return this.tx(() => {
        if (this.receipt(input.principal, input.requestId)) {
          return { ok: false, reason: 'request_exists' } as const
        }

        this.db
          .prepare('INSERT INTO claims (account, event_id, principal, request_id) VALUES (?, ?, ?, ?)')
          .run(this.account, input.eventId, input.principal, input.requestId)
        this.db
          .prepare(
            `INSERT INTO receipts (principal, request_id, state, params_hash, call_json, fingerprint, session_id, thread_id,
               event_id, not_after, epoch_at_admit, generation_at_admit, created_at, updated_at)
             VALUES (?, ?, 'admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.principal,
            input.requestId,
            input.paramsHash,
            input.callJson,
            input.fingerprint,
            input.sessionId,
            input.threadId,
            input.eventId,
            input.notAfter,
            input.epoch,
            input.generation,
            this.now(),
            this.now()
          )

        return { ok: true } as const
      })
    } catch (error) {
      if (/UNIQUE|constraint/iu.test(String((error as Error).message))) {
        return { ok: false, reason: 'event_already_used' }
      }

      throw error
    }
  }

  /** A gate check failed before T3 was called: never admitted, retired. Idempotent. */
  refuse(principal: string, requestId: string, reason: string, extra: { paramsHash?: string; eventId?: string; notAfter?: number } = {}): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO receipts (principal, request_id, state, reason, params_hash, event_id, not_after, created_at, updated_at)
         VALUES (?, ?, 'refused', ?, ?, ?, ?, ?, ?)`
      )
      .run(principal, requestId, reason, extra.paramsHash ?? null, extra.eventId ?? null, extra.notAfter ?? null, this.now(), this.now())
  }

  /** The agent voided an id that has no row, at a gate it reached under a valid grant. */
  void(principal: string, requestId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO receipts (principal, request_id, state, reason, created_at, updated_at)
         VALUES (?, ?, 'void', 'void_by_agent', ?, ?)`
      )
      .run(principal, requestId, this.now(), this.now())
  }

  update(principal: string, requestId: string, set: Partial<Record<string, string | number | null>>): void {
    const columns = Object.keys(set)

    this.db
      .prepare(`UPDATE receipts SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ? WHERE principal = ? AND request_id = ?`)
      .run(...columns.map(column => set[column] ?? null), this.now(), principal, requestId)
  }

  /** Durably, BEFORE the first byte goes to T3. */
  markForwarded(principal: string, requestId: string, incarnation: string): void {
    this.db
      // The FIRST forward's incarnation is kept: a later resend must not make an earlier uncertain send look provably absent.
      .prepare('UPDATE receipts SET forwarded = 1, forward_count = forward_count + 1, incarnation = COALESCE(incarnation, ?), updated_at = ? WHERE principal = ? AND request_id = ?')
      .run(incarnation, this.now(), principal, requestId)
  }

  releaseClaim(eventId: string | null): void {
    if (eventId) {
      this.db.prepare('DELETE FROM claims WHERE account = ? AND event_id = ?').run(this.account, eventId)
    }
  }

  // ---- revocation (plan §6.4)
  /**
   * Step 1, one durable write: move the narrowest counter, kill the grants in scope, and mark every unfinished
   * row in scope stop owed with its scope. A route-wide stop widens an agent's.
   */
  cutoff(input: CutoffInput): CutoffResult {
    return this.tx(() => {
      const at = this.now()
      let generation: number | undefined

      if (input.scope === 'route') {
        this.setMeta('route_epoch', this.routeEpoch() + 1)
        this.db.prepare('UPDATE grants SET dead = 1 WHERE dead = 0').run()
      } else {
        const principal = input.principal as string
        this.db
          .prepare('INSERT INTO agents (principal, generation, entitled) VALUES (?, 2, 0) ON CONFLICT (principal) DO UPDATE SET generation = generation + 1')
          .run(principal)
        generation = this.agent(principal)?.generation
        this.db.prepare('UPDATE grants SET dead = 1 WHERE principal = ? AND dead = 0').run(input.principal as string)
      }

      const info = this.db
        .prepare('INSERT INTO revocations (scope, principal, reason, source_seq, at) VALUES (?, ?, ?, ?, ?)')
        .run(input.scope, input.principal ?? null, input.reason, input.sourceSeq ?? null, at)

      const revocationId = Number(info.lastInsertRowid)
      const unfinished = "state IN ('admitted', 'launched') AND finished = 0 AND settled IS NULL"
      let owed: number

      if (input.scope === 'route') {
        owed = Number(
          this.db
            .prepare(`UPDATE receipts SET stop_scope = 'route', stop_at = COALESCE(stop_at, ?), revocation_id = COALESCE(revocation_id, ?), updated_at = ? WHERE ${unfinished}`)
            .run(at, revocationId, at).changes
        )
      } else {
        owed = Number(
          this.db
            .prepare(
              `UPDATE receipts SET stop_scope = COALESCE(stop_scope, 'agent'), stop_at = COALESCE(stop_at, ?), revocation_id = COALESCE(revocation_id, ?), updated_at = ? WHERE principal = ? AND ${unfinished}`
            )
            .run(at, revocationId, at, input.principal as string).changes
        )
      }

      // The report owed to the platform is part of the cutoff: a crash can never leave one without the other.
      this.enqueue('mac_event', {
        kind: input.scope === 'route' ? 'route_closed' : 'agent_closed',
        routeEpoch: this.routeEpoch(),
        at,
        ...(input.principal ? { agentPrincipal: input.principal, agentGeneration: generation } : {})
      })

      return { revocationId, owed, routeEpoch: this.routeEpoch(), generation }
    })
  }

  /** An agent has work the gate has not seen end: a new T3 session must not replace the one that owns it (plan §11.2). */
  hasUnfinished(principal: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM receipts WHERE principal = ? AND state IN ('admitted', 'launched') AND finished = 0 AND settled IS NULL LIMIT 1")
        .get(principal)
    )
  }

  /** Rows that owe a stop and have not settled. */
  owedRows(): ReceiptRow[] {
    return this.receipts('stop_scope IS NOT NULL AND settled IS NULL')
  }

  /** A route-wide stop owed blocks every agent until it settles; an agent's blocks only that agent [S0-4]. */
  scopeBlocked(principal: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM receipts WHERE stop_scope IS NOT NULL AND settled IS NULL AND (stop_scope = 'route' OR principal = ?) LIMIT 1")
        .get(principal)
    )
  }

  routeBlocked(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM receipts WHERE stop_scope = 'route' AND settled IS NULL LIMIT 1").get())
  }

  revocation(id: number): RevocationRow | undefined {
    const row = this.db.prepare('SELECT * FROM revocations WHERE id = ?').get(id) as Row | undefined

    return row ? this.revocationRow(row) : undefined
  }

  openRevocations(): RevocationRow[] {
    return (this.db.prepare('SELECT * FROM revocations WHERE acked_at IS NULL ORDER BY id').all() as Row[]).map(row => this.revocationRow(row))
  }

  private revocationRow(row: Row): RevocationRow {
    return {
      id: Number(row.id),
      scope: row.scope as WorkScope,
      principal: (row.principal as string | null) ?? null,
      reason: String(row.reason),
      sourceSeq: (row.source_seq as number | null) ?? null,
      at: Number(row.at),
      ackedAt: (row.acked_at as number | null) ?? null
    }
  }

  ackRevocation(id: number): void {
    this.db.prepare('UPDATE revocations SET acked_at = ? WHERE id = ? AND acked_at IS NULL').run(this.now(), id)
  }

  /** The highest platform sequence whose every revocation is acknowledged (never past the applied one). */
  settledSeq(): number {
    const open = this.db.prepare('SELECT MIN(source_seq) AS s FROM revocations WHERE acked_at IS NULL AND source_seq IS NOT NULL').get() as Row

    const applied = this.appliedSeq()

    return open.s === null || open.s === undefined ? applied : Math.min(applied, Number(open.s) - 1)
  }

  // ---- outbox: content-free reports owed to the platform
  enqueue(kind: string, payload: unknown): number {
    const info = this.db
      .prepare('INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)')
      .run(kind, JSON.stringify(payload), this.now())

    return Number(info.lastInsertRowid)
  }

  pending(kind?: string): OutboxRow[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM outbox WHERE delivered_at IS NULL AND kind = ? ORDER BY id').all(kind)
      : this.db.prepare('SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY id').all()) as Row[]

    return rows.map(row => ({
      id: Number(row.id),
      kind: String(row.kind),
      payload: String(row.payload),
      createdAt: Number(row.created_at),
      deliveredAt: null,
      attempts: Number(row.attempts)
    }))
  }

  delivered(id: number): void {
    this.db.prepare('UPDATE outbox SET delivered_at = ? WHERE id = ?').run(this.now(), id)
  }

  attempted(id: number): void {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?').run(id)
  }
}

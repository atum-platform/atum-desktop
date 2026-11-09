/**
 * The durable device operation ledger (S1 build plan §2.7, §3.3, WS-4 `device/ledger.ts`).
 *
 * Every command the device admits gets a record, and the record moves only along the contract's
 * ledger state machine (`atum.device-service/1` `state_machines.ledger`):
 *
 *     not_started ──admission_refused──▶ refused
 *     not_started ──admitted_before_spawn──▶ started ──exited──▶ completed
 *     not_started ──restart_before_spawn──▶ failed_no_effect      started ──failed_before_effect──▶ failed_no_effect
 *                                                                  started ──restart_or_stop_mid_effect──▶ unknown
 *
 * Nothing leaves a terminal state: a command that completed, or whose effect is unknown, is never run
 * again under its id (the `ledger-rerun-after-completion` and `ledger-unknown-retried` sequences are
 * the rejected ones). **Intent is persisted before the command is spawned and the terminal state before
 * the Receipt is sent.** If the intent cannot be persisted the write throws and the caller must not
 * spawn: a command the device cannot account for after a crash never runs.
 *
 * After a crash the next load reconciles what was in flight: a `started` record becomes `unknown` (the
 * effect may or may not have happened) and a `not_started` one becomes `failed_no_effect` (it never
 * spawned). The brain is told, and nothing is re-run.
 *
 * It is also the dedup store (admission step 6): an identical `commandId` with the same `commandHash`
 * returns the stored Receipt; a different payload under the same id is a `replayed` refusal.
 *
 * Storage is the main-process `EncryptedStore` (safeStorage-sealed, atomic file). The ledger is one
 * sealed JSON map keyed by `commandId`, so it is kept bounded: terminal records leave after the 7-day
 * dedup window, and only the most recent receipts keep their output (older ones keep state, hashes and
 * exit code, which is all dedup and a late status query need).
 */
import type { DeviceLedgerState } from './contracts'

const LEDGER_KEY = 'device-ledger'
const DEDUPE_MS = 7 * 24 * 60 * 60 * 1000
/** Receipts whose result (output/data) is kept in full; older terminal records are compacted. */
const FULL_RECEIPTS_KEPT = 32
/** Hard bound on records; the oldest terminal records go first. In-flight records are never dropped. */
const MAX_RECORDS = 4000

export interface LedgerArtifact {
  readonly name: string
  readonly size: number
  readonly sha256: string
}

export interface LedgerReceipt {
  readonly exitCode?: number
  readonly output?: string
  readonly data?: unknown
}

export interface LedgerRecord {
  readonly commandId: string
  readonly commandHash: string
  readonly grantId: string
  readonly seq: number
  readonly state: DeviceLedgerState
  readonly refusal?: string
  readonly approvalHash?: string
  readonly result?: LedgerReceipt
  readonly artifacts?: readonly LedgerArtifact[]
  readonly startedAt?: number
  readonly endedAt?: number
  readonly updatedAt: number
}

type LedgerMap = Record<string, LedgerRecord>

export interface LedgerStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The contract's ledger transitions (`from → to`). Anything else is refused. */
const TRANSITIONS: Readonly<Record<DeviceLedgerState, readonly DeviceLedgerState[]>> = {
  not_started: ['refused', 'started', 'failed_no_effect'],
  started: ['completed', 'failed_no_effect', 'unknown'],
  completed: [],
  failed_no_effect: [],
  unknown: [],
  refused: []
}

/** A terminal state cannot transition further; only `started`/`not_started` records are live. */
export function isTerminalState(state: DeviceLedgerState): boolean {
  return TRANSITIONS[state].length === 0
}

export function ledgerTransitionAllowed(from: DeviceLedgerState, to: DeviceLedgerState): boolean {
  return TRANSITIONS[from].includes(to)
}

export class LedgerError extends Error {
  constructor(readonly code: 'device_ledger_unwritable' | 'device_ledger_transition' | 'device_ledger_exists') {
    super(code)
    this.name = 'LedgerError'
  }
}

export class DeviceLedger {
  private map: LedgerMap = {}
  private loaded = false

  constructor(
    private readonly store: LedgerStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Load the ledger from the sealed store and reconcile what a previous process left in flight: a
   * `started` record becomes `unknown`, a `not_started` one `failed_no_effect`. Returns the reconciled
   * records. Idempotent; call once at startup.
   */
  load(): LedgerRecord[] {
    const raw = this.store.getItem(LEDGER_KEY)
    this.map = {}

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as LedgerMap

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.map = parsed
        }
      } catch {
        this.map = {}
      }
    }

    const reconciled: LedgerRecord[] = []
    const at = this.now()

    for (const [commandId, record] of Object.entries(this.map)) {
      if (record.state === 'started' || record.state === 'not_started') {
        const state: DeviceLedgerState = record.state === 'started' ? 'unknown' : 'failed_no_effect'
        this.map[commandId] = { ...record, state, endedAt: record.endedAt ?? at, updatedAt: at }
        reconciled.push(this.map[commandId])
      }
    }

    this.loaded = true

    if (reconciled.length) {
      // Best effort here: the in-memory reconciliation is what this process answers with either way.
      try {
        this.persist()
      } catch {
        // Reported by the next write, which must succeed before anything spawns.
      }
    }

    return reconciled
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load()
    }
  }

  get(commandId: string): LedgerRecord | undefined {
    this.ensureLoaded()

    return this.map[commandId]
  }

  /** Every record, newest first (status queries and diagnostics). */
  records(): LedgerRecord[] {
    this.ensureLoaded()

    return Object.values(this.map).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Persist a command's intent (`not_started`) at admission, before any approval prompt or spawn.
   * Throws when the id is already recorded (dedup is the caller's job, before this) or when the intent
   * cannot be made durable — the caller then refuses rather than spawning.
   */
  begin(input: { commandId: string; commandHash: string; grantId: string; seq: number }): LedgerRecord {
    this.ensureLoaded()

    if (this.map[input.commandId]) {
      throw new LedgerError('device_ledger_exists')
    }

    const record: LedgerRecord = {
      commandId: input.commandId,
      commandHash: input.commandHash,
      grantId: input.grantId,
      seq: input.seq,
      state: 'not_started',
      updatedAt: this.now()
    }

    return this.write(record)
  }

  /** `not_started → started`, persisted immediately before the spawn. */
  start(commandId: string, input: { approvalHash?: string; startedAt: number }): LedgerRecord {
    const prior = this.require(commandId, 'started')

    return this.write({
      ...prior,
      state: 'started',
      ...(input.approvalHash ? { approvalHash: input.approvalHash } : {}),
      startedAt: input.startedAt,
      updatedAt: this.now()
    })
  }

  /**
   * A terminal state, persisted before the Receipt is sent. From `not_started` only `refused` and
   * `failed_no_effect` are possible; from `started`, `completed`, `failed_no_effect` or `unknown`.
   */
  finish(
    commandId: string,
    input: {
      state: Extract<DeviceLedgerState, 'completed' | 'failed_no_effect' | 'unknown' | 'refused'>
      refusal?: string
      result?: LedgerReceipt
      artifacts?: readonly LedgerArtifact[]
      endedAt: number
    }
  ): LedgerRecord {
    const prior = this.require(commandId, input.state)

    return this.write({
      ...prior,
      state: input.state,
      ...(input.refusal ? { refusal: input.refusal } : {}),
      ...(input.result ? { result: input.result } : {}),
      ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
      endedAt: input.endedAt,
      updatedAt: this.now()
    })
  }

  /**
   * Record a command refused at admission that was never begun (`not_started → refused` in one step),
   * so an identical re-send returns the same refusal. Never overwrites an existing record: a different
   * payload under a known id is a replay and must not touch the original.
   */
  refuse(input: { commandId: string; commandHash: string; grantId: string; seq: number; refusal: string }): LedgerRecord {
    this.ensureLoaded()

    if (this.map[input.commandId]) {
      throw new LedgerError('device_ledger_exists')
    }

    const at = this.now()

    return this.write({
      commandId: input.commandId,
      commandHash: input.commandHash,
      grantId: input.grantId,
      seq: input.seq,
      state: 'refused',
      refusal: input.refusal,
      endedAt: at,
      updatedAt: at
    })
  }

  private require(commandId: string, to: DeviceLedgerState): LedgerRecord {
    this.ensureLoaded()
    const prior = this.map[commandId]

    if (!prior || !ledgerTransitionAllowed(prior.state, to)) {
      throw new LedgerError('device_ledger_transition')
    }

    return prior
  }

  private write(record: LedgerRecord): LedgerRecord {
    const previous = this.map[record.commandId]
    this.map[record.commandId] = record

    try {
      this.persist()
    } catch {
      // Not durable: undo, so this process never answers with a state it could not keep.
      if (previous) {
        this.map[record.commandId] = previous
      } else {
        delete this.map[record.commandId]
      }

      throw new LedgerError('device_ledger_unwritable')
    }

    return record
  }

  private persist(): void {
    this.prune()
    this.store.setItem(LEDGER_KEY, JSON.stringify(this.map))
  }

  private prune(): void {
    const now = this.now()
    const cutoff = now - DEDUPE_MS
    const terminal: LedgerRecord[] = []

    for (const [commandId, record] of Object.entries(this.map)) {
      if (!isTerminalState(record.state)) {
        continue
      }

      if (record.updatedAt < cutoff) {
        delete this.map[commandId]
      } else {
        terminal.push(record)
      }
    }

    terminal.sort((a, b) => b.updatedAt - a.updatedAt)

    // Keep the newest receipts whole; older ones keep what dedup and status need.
    for (const record of terminal.slice(FULL_RECEIPTS_KEPT)) {
      if (record.result && (record.result.output !== undefined || record.result.data !== undefined)) {
        this.map[record.commandId] = {
          ...record,
          result: record.result.exitCode === undefined ? {} : { exitCode: record.result.exitCode }
        }
      }
    }

    const excess = Object.keys(this.map).length - MAX_RECORDS

    if (excess > 0) {
      for (const record of terminal.slice(-excess)) {
        delete this.map[record.commandId]
      }
    }
  }
}

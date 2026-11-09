/**
 * What this Mac remembers about an agent's home between restarts, in the device's encrypted store.
 *
 * Everything the platform decides (who the home is, which generation is selected) is read from the
 * platform; this journal holds only what the platform cannot know about this Mac: which checkpoint
 * it had reserved, which move it was part of and how far it got, which epoch it last activated the
 * agent at, and whether it has ever seen the agent under the placement model (`managed`).
 * A journal that cannot be read is treated as no journal: every step it guards re-reads the platform,
 * and the platform's reservation and move are idempotent by id, so a lost journal costs a retry, never
 * a wrong effect.
 */
import path from 'node:path'

import type { CheckpointReason } from './contract'
import { isSha256, isUuid } from './contract'

export type CheckpointPhase = 'reserved' | 'captured' | 'sealed' | 'uploaded' | 'committing'

export interface JournalCheckpoint {
  checkpointId: string
  reason: CheckpointReason
  phase: CheckpointPhase
  startedAt: number
  generation?: number
  parentGeneration?: number
  homeEpoch?: number
  manifestSha256?: string
  /** The capture's content digest, kept so a commit that landed before a crash can be recognised and recorded. */
  contentSha256?: string
  /** What the home looked like to the cheap change check when it was captured (see `lastFingerprint`). */
  fingerprintSha256?: string
  /**
   * The sealed archive this checkpoint uploads, recorded the moment it is complete and before any byte of it leaves: where
   * it is staged, how long it is, and its SHA-256. A restart that finds the reservation again checks those exact bytes
   * against this record and uploads them (the platform holds one archive per reservation, and may hold this one already);
   * it never seals a second archive for the same reservation.
   */
  sealed?: { path: string; bytes: number; sha256: string }
}

/** The Mac's part in one move, from the source's drain to the target's activation. */
export type MoveRole = 'source' | 'target'

export type MovePhase =
  /** Source: the move was seen; no new work is admitted. */
  | 'draining'
  /** Source: the final checkpoint is committed and the drain acknowledged. */
  | 'drained'
  /** Target: the selected generation is being fetched and verified without writes. */
  | 'verifying'
  /** Target: the portable import was authenticated before the move commit. */
  | 'imported'
  /** Target: the move committed and its enrollment/local home is being created. */
  | 'materializing'
  /** Target: the selected generation is being fetched and restored. */
  | 'restoring'
  /** Target: restored and verified; waiting to commit the move. */
  | 'restored'
  /** Target: the commit was sent; the answer was not seen. */
  | 'committing'
  /** Target: the move is committed; this Mac is the home and is activating. */
  | 'activating'

export interface JournalMove {
  moveId: string
  idempotencyKey: string
  role: MoveRole
  phase: MovePhase
  /** The home epoch and revision the platform's move names; the commit is a CAS on them. */
  expectedHomeEpoch: number
  expectedPlacementRevision: number
  generation?: number
  /** The job id the source's drain acknowledgement and its final checkpoint are both fenced by. */
  operationId?: string
  startedAt: number
  /** Failed tries at the step this phase is waiting on, so a move that cannot finish is ended, not retried for ever. */
  attempts?: number
  /** When the move was last seen ready for its target to commit, on this Mac's clock. */
  readySince?: number
  /** Target archive restored at this epoch; startup retries must not overwrite it. */
  restoredEpoch?: number
  /** Startup was issued after the model gate passed; do not select or restart again on journal recovery. */
  activationStarted?: boolean
  /** Owner-accepted source recovery, without a source acknowledgement. */
  forced?: boolean
  /** When the source's drain was acknowledged: a checkpoint reserved before it is dead, one after it is the move's. */
  ackedAt?: number
}

export interface HomeJournal {
  v: 1
  agent: string
  /** Seen under the placement model (an epoch beyond the first, or a move): the platform is the authority. */
  managed: boolean
  /**
   * This Mac is not the home of the agent (it moved away, or was never the home of a managed agent) and must not
   * run it. Kept here so a restart, before the platform has been asked, still leaves the agent stopped.
   */
  standDown?: true
  /**
   * The saved home-default model is not (yet) this Mac's own, so the agent takes no turn: kept here so a restart, before
   * the platform has been asked, still leaves it stopped (`holds.ts`). Lifted only when the choice is applied here.
   */
  modelHold?: true
  /** The home epoch this Mac last activated the agent at. */
  activatedEpoch?: number
  homeId?: string
  checkpoint?: JournalCheckpoint
  move?: JournalMove
  /** The newest committed generation this Mac captured or restored, so an unchanged home is not captured again. */
  lastGeneration?: number
  lastContentSha256?: string
  /**
   * The cheap fingerprint (paths, sizes and modification times of what a capture carries) the home had when that
   * generation was captured or restored: the checkpoint cadence compares the home's fingerprint now with it to
   * tell whether anything changed, without capturing.
   */
  lastFingerprint?: string
  lastCommittedAt?: number
}

export interface JournalStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const JOURNAL_KEY_PREFIX = 'agent-home-journal-v1:'

const PHASES: readonly string[] = ['reserved', 'captured', 'sealed', 'uploaded', 'committing']
const MOVE_PHASES: readonly string[] = [
  'draining',
  'drained',
  'verifying',
  'imported',
  'materializing',
  'restoring',
  'restored',
  'committing',
  'activating'
]
const REASONS: readonly string[] = ['cadence_dirty', 'idle', 'manual', 'move_drain']

const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parseSealed(value: unknown): JournalCheckpoint['sealed'] {
  const row = value as Record<string, unknown> | null

  if (
    !row ||
    typeof row !== 'object' ||
    Object.keys(row).length !== 3 ||
    typeof row.path !== 'string' ||
    row.path.length === 0 ||
    row.path.length > 4096 ||
    !path.isAbsolute(row.path) ||
    !int(row.bytes) ||
    row.bytes < 1 ||
    !isSha256(row.sha256)
  ) {
    return undefined
  }

  return { path: row.path, bytes: row.bytes, sha256: row.sha256 }
}

function parseCheckpoint(value: unknown): JournalCheckpoint | undefined {
  const row = value as Record<string, unknown> | null

  if (
    !row ||
    typeof row !== 'object' ||
    !isUuid(row.checkpointId) ||
    typeof row.reason !== 'string' ||
    !REASONS.includes(row.reason) ||
    typeof row.phase !== 'string' ||
    !PHASES.includes(row.phase) ||
    !int(row.startedAt)
  ) {
    return undefined
  }

  return {
    checkpointId: row.checkpointId,
    reason: row.reason as CheckpointReason,
    phase: row.phase as CheckpointPhase,
    startedAt: row.startedAt,
    ...(int(row.generation) ? { generation: row.generation } : {}),
    ...(int(row.parentGeneration) ? { parentGeneration: row.parentGeneration } : {}),
    ...(int(row.homeEpoch) ? { homeEpoch: row.homeEpoch } : {}),
    ...(isSha256(row.manifestSha256) ? { manifestSha256: row.manifestSha256 } : {}),
    ...(isSha256(row.contentSha256) ? { contentSha256: row.contentSha256 } : {}),
    ...(isSha256(row.fingerprintSha256) ? { fingerprintSha256: row.fingerprintSha256 } : {}),
    ...(parseSealed(row.sealed) ? { sealed: parseSealed(row.sealed) } : {})
  }
}

function parseMove(value: unknown): JournalMove | undefined {
  const row = value as Record<string, unknown> | null

  if (
    !row ||
    typeof row !== 'object' ||
    !isUuid(row.moveId) ||
    !isUuid(row.idempotencyKey) ||
    (row.role !== 'source' && row.role !== 'target') ||
    typeof row.phase !== 'string' ||
    !MOVE_PHASES.includes(row.phase) ||
    !int(row.expectedHomeEpoch) ||
    !int(row.expectedPlacementRevision) ||
    !int(row.startedAt)
  ) {
    return undefined
  }

  return {
    moveId: row.moveId,
    idempotencyKey: row.idempotencyKey,
    role: row.role,
    phase: row.phase as MovePhase,
    expectedHomeEpoch: row.expectedHomeEpoch,
    expectedPlacementRevision: row.expectedPlacementRevision,
    startedAt: row.startedAt,
    ...(int(row.generation) ? { generation: row.generation } : {}),
    ...(isUuid(row.operationId) ? { operationId: row.operationId } : {}),
    ...(int(row.attempts) ? { attempts: row.attempts } : {}),
    ...(int(row.readySince) ? { readySince: row.readySince } : {}),
    ...(row.activationStarted === true ? { activationStarted: true } : {}),
    ...(row.forced === true ? { forced: true } : {}),
    ...(int(row.restoredEpoch) ? { restoredEpoch: row.restoredEpoch } : {}),
    ...(int(row.ackedAt) ? { ackedAt: row.ackedAt } : {})
  }
}

export function emptyJournal(agent: string): HomeJournal {
  return { v: 1, agent, managed: false }
}

export class AgentHomeJournal {
  constructor(private readonly store: JournalStore) {}

  read(agent: string): HomeJournal {
    let raw: string | null = null

    try {
      raw = this.store.getItem(`${JOURNAL_KEY_PREFIX}${agent}`)
    } catch {
      return emptyJournal(agent)
    }

    if (!raw) {
      return emptyJournal(agent)
    }

    try {
      const row = JSON.parse(raw) as Record<string, unknown>

      if (!row || row.v !== 1 || row.agent !== agent || typeof row.managed !== 'boolean') {
        return emptyJournal(agent)
      }

      return {
        v: 1,
        agent,
        managed: row.managed,
        ...(row.standDown === true ? { standDown: true as const } : {}),
        ...(row.modelHold === true ? { modelHold: true as const } : {}),
        ...(int(row.activatedEpoch) ? { activatedEpoch: row.activatedEpoch } : {}),
        ...(isUuid(row.homeId) ? { homeId: row.homeId } : {}),
        ...(parseCheckpoint(row.checkpoint) ? { checkpoint: parseCheckpoint(row.checkpoint) } : {}),
        ...(parseMove(row.move) ? { move: parseMove(row.move) } : {}),
        ...(int(row.lastGeneration) ? { lastGeneration: row.lastGeneration } : {}),
        ...(isSha256(row.lastContentSha256) ? { lastContentSha256: row.lastContentSha256 } : {}),
        ...(isSha256(row.lastFingerprint) ? { lastFingerprint: row.lastFingerprint } : {}),
        ...(int(row.lastCommittedAt) ? { lastCommittedAt: row.lastCommittedAt } : {})
      }
    } catch {
      return emptyJournal(agent)
    }
  }

  /** Applies a change and stores it durably before returning; the new journal is returned. */
  update(agent: string, change: (journal: HomeJournal) => HomeJournal | void): HomeJournal {
    const draft = structuredClone(this.read(agent))
    const changed = change(draft)
    const next: HomeJournal = changed ? changed : draft
    this.store.setItem(`${JOURNAL_KEY_PREFIX}${agent}`, JSON.stringify(next))

    return next
  }

  clear(agent: string): void {
    this.store.removeItem(`${JOURNAL_KEY_PREFIX}${agent}`)
  }
}

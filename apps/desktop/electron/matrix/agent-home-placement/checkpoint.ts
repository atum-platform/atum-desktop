/**
 * One portable checkpoint of an agent's home, taken by the Mac that is its home
 * (`portable_checkpoint` of atum.agent-home/2.1: dirty -> quiescing -> staging -> uploading -> verifying ->
 * committing -> committed | previous_selected).
 *
 *   1. Standing: this Mac must be the home (or the home that drains for a move), asked fresh.
 *   2. Reserve exactly `selectedGeneration + 1` with the platform, signed, fenced by the lease, the epoch and
 *      an operation (a move's drain operation, else a job id this Mac mints). The reservation is journaled
 *      BEFORE it is sent, so a crash that loses the answer still knows the id.
 *   3. Capture the portable part with the Python tool (SQLite never copied, the manifest in the 2.1 grammar, skipped
 *      paths listed by hash). There are two ways to keep the home still for it:
 *        - a move's final checkpoint and the owner's own STOP the home's writers for the capture and let them go
 *          again (`deps.quiesce`): the agent is leaving, or the owner asked. The archive says `writers: stopped`;
 *        - the cadence's (`isBackgroundCheckpoint`) stop NOTHING. A stop kills the agent's Hermes process and what lives
 *          only in it, and costs a cold start before the next reply, every quarter hour. Instead the writers are HELD for
 *          the fraction of a second a snapshot takes (`deps.holdWrites`: the agent's turn lock, so no new turn, watch or
 *          model change begins, plus the app's own facts and Hermes's word that its review of the last answer is over),
 *          the tool stages the home inside that window (an APFS clone of each file, a database through SQLite's backup
 *          API), and the writers go the moment it says it is done. The capture, the seal and the upload then read the
 *          snapshot, which nothing writes to. The archive is the home as it was while its writers were held still, not a
 *          reading of files a writer may be changing, and it says so (`writers: barrier`, `stagedBy: snapshot_*`) because
 *          that is how it was made. A fingerprint cannot prove that: a writer that has updated one file and not yet the
 *          next leaves every fingerprint equal. A write the barrier cannot see (a Hermes cron job already running, the
 *          owner's editor) that lands inside the window is caught by the tool's second look and refuses the snapshot.
 *          Writers that are busy, or a refused snapshot, throw the attempt away: nothing is uploaded, the reservation is
 *          failed, and the cadence tries again at the next quiet moment.
 *   4. Check the capture against the reservation and against the contract's parsers; seal it; upload it (the Shell
 *      mints a 90-second attempt, the bytes go straight to Storage over TUS, and a signed finalize records them:
 *      `archive-store.ts`); compare the count and digest the platform says it holds with the local ones. That
 *      comparison, not this Mac's say-so, is `uploadVerified`: Storage acknowledged every chunk up to the full length,
 *      its own metadata showed the declared size at finalize, and the digest is checked by whoever downloads.
 *   5. Commit with the platform: one CAS on the home epoch and the placement revision. The standing is read
 *      afresh for it, so a Mac that stopped being the home meanwhile does not commit.
 *
 * Any failure leaves the previous generation selected: the reservation is failed at once (an unverified
 * commit) where the platform can still be reached, and expires after 15 minutes of platform time where it
 * cannot. The plaintext archive exists only inside a private staging folder and is removed in every case.
 *
 * Every attempt is signed fresh: the platform refuses a frame it has seen, so a lost answer is answered by a
 * retry of the same logical step, which the platform keeps idempotent by checkpoint id.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

import { sealFile } from './archive-seal'
import type { HomeArchiveStore, HomeSealKeySource } from './archive-store'
import type { CheckpointCommitOutcome, CheckpointReason, CheckpointReserveOutcome, HomeOperation, HomePlacement } from './contract'
import type { MacExecutorAuth } from './executor-auth'
import type { LeaseFacts } from './fence'
import { type HomeTool, HomeToolError, type PortableCaptureSummary, type PortableSnapshotSummary, readArchiveHeader } from './home-tool'
import type { AgentHomeJournal } from './journal'
import type { CheckpointCommitBody, CheckpointReserveBody, HomePlatform, HomePlatformFailure } from './platform-client'
import { failureWord, signedCall, type SignedFailure, type SignedInput } from './signed-call'
import { removeOtherStaging } from './staging'
import { type HomeStanding, mayCheckpoint } from './standing'

export type CheckpointFailure =
  /** The platform has no such routes yet. */
  | 'unsupported'
  | 'unavailable'
  | 'unauthorized'
  /** This Mac is not the home (or a move has taken it away): nothing was reserved or committed. */
  | 'not_home'
  /** The lease, its term or this Mac's signing could not be presented. */
  | 'no_authority'
  /** The home epoch or the placement revision moved while the checkpoint was in flight. */
  | 'stale_epoch'
  /** Another reservation is live for this home. */
  | 'busy'
  | 'quiesce_failed'
  /**
   * A checkpoint taken beside the running agent could not be made one moment of the home: its writers were busy when they were
   * to be held still (`detail: writers_busy`), or something the barrier cannot see wrote a file it carries inside the window
   * (`detail: changed`). Thrown away; nothing was uploaded and the previous generation stays selected. Not a fault of the
   * platform: the cadence tries again at its next look.
   */
  | 'home_changed'
  | 'staging_failed'
  | 'key_unavailable'
  | 'upload_failed'
  | 'verification_failed'
  | 'reservation_expired'

export type CheckpointOutcome =
  | {
      state: 'committed'
      generation: number
      selectedGeneration: number
      placementRevision: number
      manifestSha256: string
      contentSha256: string
      included: number
      skipped: number
    }
  | { state: 'failed'; reason: CheckpointFailure; detail?: string; selectedGeneration: number }

export interface CheckpointRequest {
  agent: string
  reason: CheckpointReason
  /** A move's drain operation (a checkpoint during a drain is accepted from no other); else a fresh job id. */
  operation?: HomeOperation
  /**
   * For a move's final checkpoint: when its drain was acknowledged. A reservation journaled before that moment
   * was failed by the drain and is never resumed; one made after it is this checkpoint's own.
   */
  notBefore?: number
}

export type CheckpointPhase = 'reserved' | 'captured' | 'sealed' | 'uploaded' | 'committing' | 'committed'

/**
 * A checkpoint taken beside the running agent: the cadence's two reasons. The agent is alive and answering, and a
 * checkpoint every quarter hour must not stop it. A move's final checkpoint (`move_drain`) and the owner's own
 * (`manual`) are taken with the writers stopped.
 */
export const isBackgroundCheckpoint = (reason: CheckpointReason): boolean => reason === 'cadence_dirty' || reason === 'idle'

export interface CheckpointDeps {
  platform: HomePlatform
  auth: MacExecutorAuth
  tool: HomeTool
  store: HomeArchiveStore
  keys: HomeSealKeySource
  journal: AgentHomeJournal
  standing: HomeStanding
  /** The agent's Hermes home on this Mac. */
  home(agent: string): string | null
  /** The answering lease's facts for the fence (`MatrixExecutorLease.fenceFacts`). */
  leaseFacts(agent: string): LeaseFacts | null
  /** Hold the home's writers still (stopping them); the returned function lets them go. Not used for a background checkpoint. */
  quiesce(agent: string): Promise<() => Promise<void>>
  /**
   * Hold the home's writers still for the moment a snapshot takes, without stopping them (`HomeRuntimeOps.holdWrites`): null
   * when they cannot be held now. Only a background checkpoint uses it, and lets go as soon as the snapshot is staged.
   */
  holdWrites(agent: string): Promise<(() => void) | null>
  /** The private staging folder for plaintext and sealed archives. */
  workDir: string
  now?(): number
  uuid?(): string
  log?(line: string): void
  /** Test seam: called after each phase is journaled (a test throws here to model a crash). */
  phase?(phase: CheckpointPhase): void
}

class Stop extends Error {
  constructor(readonly outcome: CheckpointOutcome) {
    super(outcome.state === 'failed' ? outcome.reason : 'committed')
  }
}

/** What a failed signed call means for the checkpoint in flight. */
export function checkpointFailureOf(failure: SignedFailure): CheckpointFailure {
  switch (failure.kind) {
    case 'not_home':

    case 'forbidden':
      return 'not_home'

    case 'no_authority':
      return 'no_authority'

    case 'unsupported':
      return 'unsupported'

    case 'unauthorized':
      return 'unauthorized'

    case 'refused':
      return failure.reason === 'stale_home_epoch' || failure.reason === 'wrong_home' || failure.reason === 'wrong_signer_location'
        ? 'stale_epoch'
        : 'no_authority'

    case 'conflict':
      return 'busy'

    default:
      return 'unavailable'
  }
}

interface Reserved {
  checkpointId: string
  generation: number
  parentGeneration: number
}

/** What the capture and the seal produced (or what the journal remembers of them): all the upload and the commit need. */
interface Prepared {
  manifestSha256: string
  contentSha256: string
  fingerprintSha256?: string
  includedFiles: number
  skippedPaths: number
  /** The sealed archive's length and digest. */
  local: { bytes: number; sha256: string }
}

/** The length and SHA-256 of a file, read as a stream (an archive can be up to the tool's cap). */
async function digestOfFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }

  return { bytes, sha256: hash.digest('hex') }
}

/** Make a file's directory entry durable as well as its bytes (best effort: a platform that cannot sync a directory goes on). */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Not durable against a power cut; still whole after a killed process, which is what the journal's record relies on.
  }
}

export async function takeCheckpoint(deps: CheckpointDeps, request: CheckpointRequest, signal: AbortSignal): Promise<CheckpointOutcome> {
  const { agent } = request
  const now = () => deps.now?.() ?? Date.now()
  const uuid = () => deps.uuid?.() ?? randomUUID()
  const operation: HomeOperation = request.operation ?? { kind: 'job', id: uuid() }
  let selectedGeneration = 0
  let staging: string | undefined

  const fail = (reason: CheckpointFailure, detail?: string): never => {
    throw new Stop({ state: 'failed', reason, ...(detail ? { detail } : {}), selectedGeneration })
  }

  const call = async <T>(
    build: (input: SignedInput) => Promise<{ ok: true; value: T } | HomePlatformFailure>
  ): Promise<{ ok: true; value: T; placement: HomePlacement }> => {
    const result = await signedCall<T>(deps, agent, operation, mayCheckpoint, build, signal)

    if (result.ok === false) {
      return fail(checkpointFailureOf(result.failure), failureWord(result.failure))
    }

    selectedGeneration = result.placement.selectedGeneration

    return result
  }

  const commitCall = (reserved: Reserved, manifestSha256: string, uploadVerified: boolean) =>
    call<CheckpointCommitOutcome>(({ fence, placement }) =>
      deps.auth
        .sign('CheckpointCommit', meta => ({
          operation: 'commit' as const,
          meta,
          checkpointId: reserved.checkpointId,
          generation: reserved.generation,
          parentGeneration: reserved.parentGeneration,
          expectedHomeEpoch: placement.homeEpoch,
          expectedPlacementRevision: placement.placementRevision,
          manifestSha256,
          uploadVerified,
          fence: fence!
        }))
        .then(body => deps.platform.commitCheckpoint(agent, body as CheckpointCommitBody, signal))
    )

  /** Fail the reservation now where the platform can be reached, and report why. Never throws. */
  const abandon = async (reserved: Reserved, reason: CheckpointFailure, detail?: string): Promise<CheckpointOutcome> => {
    try {
      await commitCall(reserved, createHash('sha256').update(`abandoned|${reserved.checkpointId}`).digest('hex'), false)
    } catch {
      // The reservation then expires on its own after 15 minutes of platform time.
    }

    deps.journal.update(agent, entry => {
      entry.checkpoint = undefined
    })

    return { state: 'failed', reason, ...(detail ? { detail } : {}), selectedGeneration }
  }

  /** Commit, and if the answer is lost on the way back read the placement: the platform may have committed. */
  const commitReserved = async (reserved: Reserved, manifestSha256: string) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let answer: Awaited<ReturnType<typeof commitCall>>

      try {
        answer = await commitCall(reserved, manifestSha256, true)
      } catch (error) {
        if (!(error instanceof Stop && error.outcome.state === 'failed' && error.outcome.reason === 'unavailable')) {
          throw error
        }

        const read = await deps.platform.readPlacement(agent, signal)

        if (read.ok === true && read.value.selectedGeneration >= reserved.generation) {
          return { generation: reserved.generation, selectedGeneration: read.value.selectedGeneration, placementRevision: read.value.placementRevision }
        }

        continue
      }

      const value = answer.value

      if (value.outcome === 'committed' || value.outcome === 'already_committed') {
        return { generation: value.generation, selectedGeneration: value.selectedGeneration, placementRevision: value.placementRevision }
      }

      if (value.outcome === 'reservation_expired') {
        return fail('reservation_expired')
      }

      if (value.outcome === 'verification_failed') {
        return fail('verification_failed', 'platform_recorded_unverified')
      }

      return fail('stale_epoch', value.outcome)
    }

    return fail('unavailable', 'commit_answer_lost')
  }

  try {
    const home = deps.home(agent)

    if (!home) {
      return fail('staging_failed', 'home_missing')
    }

    // --------------------------------------------------------------------- 1-2: reserve
    const journaled = deps.journal.read(agent).checkpoint
    const resumed = journaled && (request.notBefore === undefined || journaled.startedAt >= request.notBefore) ? journaled : undefined

    // A commit that was sent before a crash may have landed. The platform's selected generation, at the same
    // home epoch, is the answer: record it and stop, instead of reserving a second generation for the same state.
    if (
      resumed &&
      resumed.generation !== undefined &&
      resumed.homeEpoch !== undefined &&
      resumed.manifestSha256 !== undefined &&
      (resumed.phase === 'uploaded' || resumed.phase === 'committing')
    ) {
      const read = await deps.platform.readPlacement(agent, signal)

      if (read.ok === true && read.value.homeEpoch === resumed.homeEpoch && read.value.selectedGeneration >= resumed.generation) {
        // The platform has that checkpoint: nothing of it is wanted any more, and the archive the dead process staged goes.
        await rm(path.join(deps.workDir, agent, resumed.checkpointId), { recursive: true, force: true })

        deps.journal.update(agent, entry => {
          entry.checkpoint = undefined
          entry.lastGeneration = resumed.generation
          entry.lastContentSha256 = resumed.contentSha256
          entry.lastFingerprint = resumed.fingerprintSha256
          entry.lastCommittedAt = now()
        })
        deps.standing.invalidate(agent)

        return {
          state: 'committed',
          generation: resumed.generation!,
          selectedGeneration: read.value.selectedGeneration,
          placementRevision: read.value.placementRevision,
          manifestSha256: resumed.manifestSha256,
          contentSha256: resumed.contentSha256 ?? '0'.repeat(64),
          included: 0,
          skipped: 0
        }
      }
    }

    let checkpointId = resumed ? resumed.checkpointId : uuid()

    const reserve = async () => {
      deps.journal.update(agent, entry => {
        entry.checkpoint = { checkpointId, reason: request.reason, phase: 'reserved', startedAt: now() }
      })

      return call<CheckpointReserveOutcome>(({ fence, placement }) =>
        deps.auth
          .sign('CheckpointReserve', meta => ({
            operation: 'reserve' as const,
            meta,
            checkpointId,
            expectedPlacementRevision: placement.placementRevision,
            fence: fence!
          }))
          .then(body => deps.platform.reserveCheckpoint(agent, body as CheckpointReserveBody, signal))
      )
    }

    let reservation = await reserve().catch(error => {
      // A resumed id the platform holds as terminal is dropped once and a new one reserved.
      if (error instanceof Stop && error.outcome.state === 'failed' && error.outcome.reason === 'busy' && resumed) {
        checkpointId = uuid()

        return reserve()
      }

      throw error
    })

    // The placement moved on between the read and the reserve: read it again and reserve against the new one, once.
    if (reservation.value.outcome === 'stale_revision') {
      reservation = await reserve()
    }

    if (reservation.value.outcome !== 'reserved') {
      return fail('stale_epoch', 'stale_revision')
    }

    const reserved = reservation.value
    const homeId = reservation.placement.homeId
    selectedGeneration = reserved.parentGeneration
    deps.phase?.('reserved')

    if (reserved.homeEpoch !== reservation.placement.homeEpoch) {
      return await abandon(reserved, 'stale_epoch')
    }

    // The reservation is held, and the platform lets one be live at a time, so staging that is not this checkpoint's belongs
    // to a run that is not coming back: whatever a killed process left, whatever an earlier checkpoint of this agent staged.
    const stagingFolder = path.join(deps.workDir, agent, checkpointId)
    staging = stagingFolder
    await removeOtherStaging(path.join(deps.workDir, agent), checkpointId)

    // The upload of this very reservation was verified before the crash (the phase is only journaled after the platform's
    // own digest matched ours): the platform holds those bytes, and sealing a new capture would be a different object
    // under the same reservation, which it refuses as a changed replay. Only the commit is left.
    if (
      resumed &&
      resumed.checkpointId === checkpointId &&
      (resumed.phase === 'uploaded' || resumed.phase === 'committing') &&
      resumed.manifestSha256 !== undefined &&
      resumed.generation === reserved.generation &&
      resumed.parentGeneration === reserved.parentGeneration &&
      resumed.homeEpoch === reserved.homeEpoch
    ) {
      const committed = await commitReserved(reserved, resumed.manifestSha256)

      deps.journal.update(agent, entry => {
        entry.checkpoint = undefined
        entry.lastGeneration = committed.generation
        entry.lastContentSha256 = resumed.contentSha256
        entry.lastFingerprint = resumed.fingerprintSha256
        entry.lastCommittedAt = now()
      })
      deps.phase?.('committed')
      deps.standing.invalidate(agent)

      return {
        state: 'committed',
        generation: committed.generation,
        selectedGeneration: committed.selectedGeneration,
        placementRevision: committed.placementRevision,
        manifestSha256: resumed.manifestSha256,
        contentSha256: resumed.contentSha256 ?? '0'.repeat(64),
        included: 0,
        skipped: 0
      }
    }

    // --------------------------------------------------------------------- 3-4: capture and seal, or the archive already staged
    const plain = path.join(stagingFolder, 'checkpoint.plain')
    const sealed = path.join(stagingFolder, 'checkpoint.sealed')

    // A process that died after it had sealed this reservation's archive left a record of it in the journal and the bytes in
    // the staging folder. The platform keeps one archive per reservation and may hold this one already, so those exact bytes,
    // and no others, are the ones that go up; sealing again would be a different object under the same reservation.
    const staged =
      resumed &&
      resumed.checkpointId === checkpointId &&
      resumed.phase === 'sealed' &&
      resumed.sealed &&
      resumed.manifestSha256 !== undefined &&
      resumed.contentSha256 !== undefined &&
      resumed.generation === reserved.generation &&
      resumed.parentGeneration === reserved.parentGeneration &&
      resumed.homeEpoch === reserved.homeEpoch
        ? { sealed: resumed.sealed, manifestSha256: resumed.manifestSha256, contentSha256: resumed.contentSha256, fingerprintSha256: resumed.fingerprintSha256 }
        : undefined

    const captureInput = { home, out: plain, homeId, generation: reserved.generation, parentGeneration: reserved.parentGeneration, homeEpoch: reserved.homeEpoch }

    /**
     * Capture the home with its writers stopped (a move's final checkpoint, the owner's own): they are let go as soon as the
     * capture has read it. Resolves with the capture's summary, or the outcome the attempt ended with.
     */
    const captureStopped = async (): Promise<PortableCaptureSummary | CheckpointOutcome> => {
      let release: () => Promise<void>

      try {
        release = await deps.quiesce(agent)
      } catch {
        return await abandon(reserved, 'quiesce_failed')
      }

      try {
        return await deps.tool.capture(captureInput, signal)
      } catch (error) {
        return await abandon(reserved, 'staging_failed', error instanceof Error ? error.message : undefined)
      } finally {
        await release().catch(() => undefined)
      }
    }

    /**
     * Capture the home beside the running agent (the cadence's): hold its writers still for the moment a snapshot takes, stage
     * the snapshot inside that window, and capture from the snapshot, which nothing writes to. The snapshot (a plaintext copy of
     * the portable part) lives only as long as the capture reads it.
     */
    const captureBeside = async (): Promise<PortableCaptureSummary | CheckpointOutcome> => {
      const snapshotFolder = path.join(stagingFolder, 'snapshot')

      try {
        let staged: PortableSnapshotSummary

        try {
          staged = await deps.tool.snapshot({ home, dest: snapshotFolder, hold: () => deps.holdWrites(agent) }, signal)
        } catch (error) {
          const code = error instanceof HomeToolError ? error.code : undefined

          // Neither is a fault of the platform or of the home: the agent was at work, or something wrote while it was held.
          if (code === 'home_writers_busy') {
            return await abandon(reserved, 'home_changed', 'writers_busy')
          }

          if (code === 'home_changed_during_snapshot') {
            return await abandon(reserved, 'home_changed', 'changed')
          }

          return await abandon(reserved, 'staging_failed', error instanceof Error ? error.message : undefined)
        }

        deps.log?.(
          `[Home] ${agent.slice(0, 8)} writers held ${staged.heldMs} ms for the snapshot (${staged.method}, ${staged.files} files${staged.attempts > 1 ? ', walked again under the hold' : ''})`
        )

        let summary: PortableCaptureSummary

        try {
          summary = await deps.tool.capture({ ...captureInput, snapshot: snapshotFolder }, signal)
        } catch (error) {
          return await abandon(reserved, 'staging_failed', error instanceof Error ? error.message : undefined)
        }

        // The capture read the snapshot that was just staged, not another one that happened to be in the folder.
        if (summary.fingerprintSha256 !== staged.fingerprintSha256) {
          return await abandon(reserved, 'staging_failed', 'capture_does_not_match_snapshot')
        }

        return summary
      } finally {
        // Whatever the outcome, the copy goes. One that will not is swept at the agent's next reservation or the next start.
        await rm(snapshotFolder, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    /** Capture the home (held still for a snapshot, or stopped, as the reason says), check the capture, seal it, and journal the sealed archive. */
    const captureAndSeal = async (): Promise<Prepared | CheckpointOutcome> => {
      const captured = isBackgroundCheckpoint(request.reason) ? await captureBeside() : await captureStopped()

      if ('state' in captured) {
        return captured
      }

      const summary = captured
      const header = await readArchiveHeader(plain).catch(() => null)

      if (
        !header ||
        header.manifest.homeId !== homeId ||
        header.manifest.generation !== reserved.generation ||
        header.manifest.parentGeneration !== reserved.parentGeneration ||
        header.manifest.producingHomeEpoch !== reserved.homeEpoch ||
        header.manifest.manifestSha256 !== summary.manifestSha256
      ) {
        return await abandon(reserved, 'staging_failed', 'capture_does_not_match_reservation')
      }

      deps.journal.update(agent, entry => {
        if (entry.checkpoint) {
          entry.checkpoint = {
            ...entry.checkpoint,
            phase: 'captured',
            generation: reserved.generation,
            parentGeneration: reserved.parentGeneration,
            homeEpoch: reserved.homeEpoch,
            manifestSha256: summary.manifestSha256,
            contentSha256: summary.contentSha256,
            ...(summary.fingerprintSha256 ? { fingerprintSha256: summary.fingerprintSha256 } : {})
          }
        }
      })
      deps.phase?.('captured')

      const key = await deps.keys.key({ agent, homeId, operation }, signal)

      if (key.ok === false) {
        return await abandon(reserved, key.kind === 'unsupported' ? 'unsupported' : 'key_unavailable')
      }

      let local: { bytes: number; sha256: string }

      try {
        local = await sealFile({ plain, sealed, key: key.value, homeId, generation: reserved.generation })
      } catch {
        return await abandon(reserved, 'staging_failed', 'seal_failed')
      } finally {
        await rm(plain, { force: true })
      }

      // From here the sealed archive is the checkpoint: its place, length and digest are journaled before any byte of it
      // can leave, so a restart after a kill can check those exact bytes and upload them.
      await syncDirectory(stagingFolder)
      deps.journal.update(agent, entry => {
        if (entry.checkpoint) {
          entry.checkpoint = { ...entry.checkpoint, phase: 'sealed', sealed: { path: sealed, bytes: local.bytes, sha256: local.sha256 } }
        }
      })
      deps.phase?.('sealed')

      return {
        manifestSha256: summary.manifestSha256,
        contentSha256: summary.contentSha256,
        fingerprintSha256: summary.fingerprintSha256,
        includedFiles: summary.includedFiles,
        skippedPaths: summary.skippedPaths,
        local
      }
    }

    let prepared: Prepared

    if (staged) {
      const found = await digestOfFile(sealed).catch(() => null)

      if (staged.sealed.path !== sealed || !found || found.bytes !== staged.sealed.bytes || found.sha256 !== staged.sealed.sha256) {
        // Not the bytes that were sealed: nothing of them can be vouched for, and the platform may hold the real ones.
        return await abandon(reserved, 'staging_failed', 'sealed_archive_unusable')
      }

      prepared = {
        manifestSha256: staged.manifestSha256,
        contentSha256: staged.contentSha256,
        fingerprintSha256: staged.fingerprintSha256,
        includedFiles: 0,
        skippedPaths: 0,
        local: found
      }
    } else {
      // Nothing sealed was recorded, so nothing of this reservation can have been uploaded: what a dead run left is of no use.
      await rm(stagingFolder, { recursive: true, force: true })
      await mkdir(stagingFolder, { recursive: true, mode: 0o700 })

      const made = await captureAndSeal()

      if ('state' in made) {
        return made
      }

      prepared = made
    }

    // --------------------------------------------------------------------- 4: upload, verify
    const stored = await deps.store.put(
      { agent, homeId, generation: reserved.generation, checkpointId: reserved.checkpointId, operation, file: sealed, manifestSha256: prepared.manifestSha256 },
      signal
    )

    if (stored.ok === false) {
      return await abandon(reserved, stored.kind === 'unsupported' ? 'unsupported' : 'upload_failed', stored.kind)
    }

    // The store's digest of the bytes it holds, against ours: that comparison is `uploadVerified`.
    if (stored.value.sha256 !== prepared.local.sha256 || stored.value.bytes !== prepared.local.bytes) {
      return await abandon(reserved, 'verification_failed', 'store_digest_differs')
    }

    deps.journal.update(agent, entry => {
      if (entry.checkpoint) {
        entry.checkpoint = { ...entry.checkpoint, phase: 'uploaded' }
      }
    })
    deps.phase?.('uploaded')

    // --------------------------------------------------------------------- 5: commit
    deps.journal.update(agent, entry => {
      if (entry.checkpoint) {
        entry.checkpoint = { ...entry.checkpoint, phase: 'committing' }
      }
    })
    deps.phase?.('committing')

    const committed = await commitReserved(reserved, prepared.manifestSha256)

    deps.journal.update(agent, entry => {
      entry.checkpoint = undefined
      entry.lastGeneration = committed.generation
      entry.lastContentSha256 = prepared.contentSha256
      entry.lastFingerprint = prepared.fingerprintSha256
      entry.lastCommittedAt = now()
    })
    deps.phase?.('committed')
    deps.standing.invalidate(agent)

    return {
      state: 'committed',
      generation: committed.generation,
      selectedGeneration: committed.selectedGeneration,
      placementRevision: committed.placementRevision,
      manifestSha256: prepared.manifestSha256,
      contentSha256: prepared.contentSha256,
      included: prepared.includedFiles,
      skipped: prepared.skippedPaths
    }
  } catch (error) {
    if (error instanceof Stop) {
      if (error.outcome.state === 'failed') {
        deps.log?.(`[Home] ${agent.slice(0, 8)} checkpoint ${request.reason} failed: ${error.outcome.reason}`)
      }

      return error.outcome
    }

    throw error
  } finally {
    if (staging) {
      // An archive the journal still vouches for stays, because the reservation is live and its bytes are the only way to
      // finish it (the platform may hold them already). Everything else staged here is of no further use.
      const live = deps.journal.read(agent).checkpoint
      const vouched = live?.phase === 'sealed' && live.sealed !== undefined && path.dirname(live.sealed.path) === staging

      if (!vouched) {
        await rm(staging, { recursive: true, force: true })
      }
    }
  }
}

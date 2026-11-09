/**
 * A move TO this Mac: the target's half.
 *
 *   waiting     The source is still draining. Nothing happens here.
 *   verifying   The move is ready (the source's final checkpoint is committed and selected). This Mac fetches that
 *               generation, opens it with the home's data key (the tag binds it to this home and generation),
 *               checks it against the manifest digest the platform committed and against the contract's own
 *               grammar, and has the Python tool read all of it WITHOUT writing a byte (`verify_only`). It
 *               commits the move only after having proved it can read what it is about to become.
 *   committing  One CAS on the home epoch and the placement revision. It is the point of no return: from the
 *               platform's answer on, this Mac is the home and the source is not.
 *   activating  Fetch and verify again (a crash can have removed the staging), restore the portable part into the
 *               local home with every replaced file backed up, rebind paths (credentials and settings are this
 *               Mac's own and are never touched), and bring the agent up with a NEW session that rebuilds its
 *               context from the Matrix room. Then report ready.
 *
 * A crash anywhere resumes from the journal and the platform's record: before the commit nothing about this
 * Mac's home has changed; after it, `recoverTarget` finds this Mac made the home at a later epoch and finishes
 * the activation, which is idempotent.
 */
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJson } from '../device/canonical'

import { openFile } from './archive-seal'
import type { HomeMove, HomePlacement } from './contract'
import { type AgentHomePortableArchiveImportV25, sameLocationV25 } from './contract-v25'
import { type ArchiveHeader, readArchiveHeader } from './home-tool'
import { outcomeIsDefinitive, RetryLedger } from './retry-ledger'
import type { HomeContext } from './runtime-ops'

export type TargetStep = 'waiting_for_source' | 'committed' | 'activated' | 'abandoned' | 'failed'

export interface TargetResult {
  step: TargetStep
  detail?: string
}

interface Fetched {
  dir: string
  plain: string
  header: ArchiveHeader
  archiveSha256: string
}

type FetchResult = ({ ok: true } & Fetched) | { ok: false; reason: string }

/** The content digest of a manifest's entries, as the Python capture computes it. */
export const contentDigestOf = (header: ArchiveHeader): string =>
  createHash('sha256').update(canonicalJson(header.manifest.entries), 'utf8').digest('hex')

/** Fetch the selected generation, open it, and check it against the placement and the platform's committed digest. */
async function fetchAndVerify(ctx: HomeContext, agent: string, placement: HomePlacement, signal: AbortSignal): Promise<FetchResult> {
  const generation = placement.selectedGeneration
  const dir = path.join(ctx.dirs.work, agent, `restore-${generation}-${ctx.uuid()}`)

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const key = await ctx.keys.key({ agent, homeId: placement.homeId }, signal)

    if (key.ok === false) {
      return await cleaned(dir, key.kind === 'unsupported' ? 'unsupported' : 'key_unavailable')
    }

    const sealed = path.join(dir, 'checkpoint.sealed')
    const got = await ctx.store.get({ agent, homeId: placement.homeId, generation, file: sealed }, signal)

    if (got.ok === false) {
      return await cleaned(
        dir,
        got.kind === 'unsupported' ? 'unsupported' : got.kind === 'not_found' ? 'archive_missing' : got.kind === 'corrupt' ? 'archive_unreadable' : 'archive_unavailable'
      )
    }

    const plain = path.join(dir, 'checkpoint.plain')

    try {
      await openFile({ sealed, plain, key: key.value, homeId: placement.homeId, generation })
    } catch {
      return await cleaned(dir, 'archive_unreadable')
    } finally {
      await rm(sealed, { force: true })
    }

    const header = await readArchiveHeader(plain).catch(() => null)

    if (
      !header ||
      header.manifest.homeId !== placement.homeId ||
      header.manifest.generation !== generation ||
      (got.value.manifestSha256 !== null && got.value.manifestSha256 !== header.manifest.manifestSha256)
    ) {
      return await cleaned(dir, 'archive_mismatch')
    }

    // Everything read and checked, nothing written: this Mac can read what it is about to become.
    await ctx.tool.restore(
      {
        home: ctx.runtime.home(agent) ?? dir,
        archive: plain,
        backups: path.join(ctx.dirs.backups, agent),
        expectManifestSha256: header.manifest.manifestSha256,
        expectHomeId: placement.homeId,
        verifyOnly: true
      },
      signal
    )

    return { ok: true, dir, plain, header, archiveSha256: got.value.sha256 }
  } catch (error) {
    return await cleaned(dir, error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : 'archive_unreadable')
  }
}

function importMatches(
  instruction: AgentHomePortableArchiveImportV25,
  placement: HomePlacement,
  move: HomeMove,
  fetched: Fetched,
  me: string
): boolean {
  return (
    instruction.moveId === move.moveId &&
    instruction.target.kind === 'mac' &&
    instruction.target.deviceServiceId === me &&
    instruction.lineage.agentPrincipal === placement.agentPrincipal &&
    instruction.lineage.homeId === placement.homeId &&
    instruction.lineage.homeEpoch === placement.homeEpoch &&
    instruction.lineage.generation === placement.selectedGeneration &&
    sameLocationV25(instruction.lineage.source, move.source) &&
    instruction.portableArchiveSha256 === fetched.archiveSha256 &&
    instruction.portableManifestSha256 === fetched.header.manifest.manifestSha256 &&
    instruction.lineage.manifestSha256 === fetched.header.manifest.manifestSha256 &&
    instruction.outputSealing === 'owner_agent_home' &&
    instruction.credentialMaterialIncluded === false
  )
}

/** Authenticate the portable import before the placement commit (2.4 ordering). */
export async function acknowledgeImport(
  ctx: HomeContext,
  agent: string,
  placement: HomePlacement,
  move: HomeMove,
  fetched: Fetched,
  signal: AbortSignal
): Promise<string | null> {
  // A 2.1 Mac-to-Mac move predates the trusted cloud conversion/import route.
  if (move.source.kind !== 'cloud') {return null}
  const connection = ctx.connection
  const me = ctx.me()
  if (!connection || !me) {return 'portable_import_unavailable'}

  const read = await connection.platform.readImport(agent, move.moveId, signal)
  if (read.ok === false) {return read.kind === 'unsupported' ? 'portable_import_unsupported' : 'portable_import_unavailable'}
  if (!importMatches(read.value, placement, move, fetched, me)) {return 'archive_mismatch'}

  // A receipt whose answer never came is sent again as the same operation (the same request id); the platform answers
  // a receipt it already holds with that receipt.
  const operation = RetryLedger.key('import-receipt', agent, {
    moveId: move.moveId,
    target: read.value.target,
    lineage: read.value.lineage,
    portableArchiveSha256: read.value.portableArchiveSha256,
    portableManifestSha256: read.value.portableManifestSha256
  })
  const identity = ctx.retry.begin(operation, 1)
  const body = await connection.auth.signMac(
    'home.archive.import-receipt',
    meta => ({
      meta,
      moveId: move.moveId,
      target: read.value.target,
      lineage: read.value.lineage,
      portableArchiveSha256: read.value.portableArchiveSha256,
      portableManifestSha256: read.value.portableManifestSha256,
      outcome: 'imported' as const,
      reason: null
    }),
    { requestId: identity.ids[0]! }
  )
  const receipt = await connection.platform.reportImport(agent, body as never, signal)
  if (outcomeIsDefinitive(receipt)) {ctx.retry.settle(operation)}

  if (receipt.ok === false) {return receipt.reason ?? 'archive_import_unavailable'}

  return ['imported', 'replay'].includes(receipt.value.outcome) ? null : (receipt.value.reason ?? 'archive_import_refused')
}

async function cleaned(dir: string, reason: string): Promise<{ ok: false; reason: string }> {
  await rm(dir, { recursive: true, force: true })

  return { ok: false, reason }
}

async function endMove(ctx: HomeContext, agent: string, move: HomeMove, signal: AbortSignal): Promise<void> {
  const read = await ctx.platform.readPlacement(agent, signal)

  if (read.ok === false) {
    return
  }

  await ctx.platform.abortMove(
    agent,
    {
      moveId: move.moveId,
      idempotencyKey: move.idempotencyKey,
      expectedHomeEpoch: read.value.homeEpoch,
      expectedPlacementRevision: read.value.placementRevision,
      reason: 'target_unavailable'
    },
    signal
  )
}

/** Between two looks at a commit that met a publication being sent: the worker's lease is about 45 s at most. */
const IN_FLIGHT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000]

/**
 * The commit, retried while the platform answers `agent_home_publication_in_flight` (exactly): the worker is sending a
 * message of the old home right now, and the move waits for that one to land rather than cut it. Bounded by
 * `budgets.publicationWaitMs`, with a backoff; the placement is read again before every retry (a move that was
 * cancelled meanwhile is not committed) and the commit is a fresh CAS on what it says. Nothing is forced, and nothing is
 * sent around the worker.
 */
async function commitWhilePublicationsLand(
  ctx: HomeContext,
  agent: string,
  move: HomeMove,
  placement: HomePlacement,
  signal: AbortSignal
) {
  let current = placement
  let waited = 0

  for (let attempt = 0; ; attempt += 1) {
    const answer = await ctx.platform.commitMove(
      agent,
      {
        moveId: move.moveId,
        idempotencyKey: move.idempotencyKey,
        expectedHomeEpoch: current.homeEpoch,
        expectedPlacementRevision: current.placementRevision
      },
      signal
    )

    if (answer.ok === true || answer.kind !== 'publication_in_flight') {
      return answer
    }

    const delay = IN_FLIGHT_BACKOFF_MS[Math.min(attempt, IN_FLIGHT_BACKOFF_MS.length - 1)]!

    if (signal.aborted || waited + delay > ctx.budgets.publicationWaitMs) {
      return answer
    }

    ctx.log(`[Home] ${agent.slice(0, 8)} move commit waits for a publication in flight (${waited + delay} ms)`)
    await ctx.sleep(delay, signal)
    waited += delay

    const read = await ctx.platform.readPlacement(agent, signal)

    // The move ended while it waited, or the platform cannot be read: the pass decides again from the placement.
    if (read.ok === false || read.value.activeMove?.moveId !== move.moveId || read.value.activeMove.status !== 'ready_to_commit') {
      return answer
    }

    current = read.value
  }
}

export async function runTarget(
  ctx: HomeContext,
  agent: string,
  placement: HomePlacement,
  move: HomeMove,
  signal: AbortSignal
): Promise<TargetResult> {
  if (move.status !== 'ready_to_commit') {
    ctx.journal.update(agent, entry => {
      entry.managed = true
      entry.homeId = placement.homeId
    })

    return { step: 'waiting_for_source', detail: move.status }
  }

  const known = ctx.journal.read(agent).move

  if (!known || known.moveId !== move.moveId || known.role !== 'target') {
    ctx.journal.update(agent, entry => {
      entry.managed = true
      entry.homeId = placement.homeId
      entry.move = {
        moveId: move.moveId,
        idempotencyKey: move.idempotencyKey,
        role: 'target',
        phase: 'verifying',
        expectedHomeEpoch: placement.homeEpoch,
        expectedPlacementRevision: placement.placementRevision,
        generation: placement.selectedGeneration,
        startedAt: ctx.now(),
        attempts: 0
      }
    })
  }

  // -------------------------------------------------------------- verify before the point of no return
  const fetched = await fetchAndVerify(ctx, agent, placement, signal)

  if (fetched.ok === false) {
    const attempts = (ctx.journal.read(agent).move?.attempts ?? 0) + 1

    ctx.journal.update(agent, entry => {
      if (entry.move) {
        entry.move = { ...entry.move, attempts }
      }
    })

    if (attempts >= ctx.budgets.attempts) {
      await endMove(ctx, agent, move, signal)
      ctx.journal.update(agent, entry => {
        entry.move = undefined
      })

      return { step: 'abandoned', detail: fetched.reason }
    }

    return { step: 'failed', detail: fetched.reason }
  }

  const importFailure = await acknowledgeImport(ctx, agent, placement, move, fetched, signal)

  if (importFailure) {
    await rm(fetched.dir, { recursive: true, force: true })
    return { step: 'failed', detail: importFailure }
  }

  await rm(fetched.dir, { recursive: true, force: true })

  ctx.journal.update(agent, entry => {
    if (entry.move) {
      entry.move = { ...entry.move, phase: move.source.kind === 'cloud' ? 'imported' : 'restored' }
    }
  })
  ctx.step?.('target:verified')

  // ---------------------------------------------------------------------------- commit: one CAS
  const fresh = await ctx.platform.readPlacement(agent, signal)

  if (fresh.ok === false) {
    return { step: 'failed', detail: 'placement_unavailable' }
  }

  if (fresh.value.activeMove?.moveId !== move.moveId || fresh.value.activeMove.status !== 'ready_to_commit') {
    // Cancelled, replaced or not ready any more: nothing was changed here.
    ctx.journal.update(agent, entry => {
      entry.move = undefined
    })

    return { step: 'abandoned', detail: 'move_changed' }
  }

  ctx.journal.update(agent, entry => {
    if (entry.move) {
      entry.move = {
        ...entry.move,
        phase: 'committing',
        expectedHomeEpoch: fresh.value.homeEpoch,
        expectedPlacementRevision: fresh.value.placementRevision
      }
    }
  })
  ctx.step?.('target:committing')

  const committed = await commitWhilePublicationsLand(ctx, agent, move, fresh.value, signal)

  if (committed.ok === false) {
    // A lost answer or a conflict: the next pass reads the placement, which is the truth either way. A publication
    // that is still being sent after the whole wait is the same: the platform will say yes once it has landed.
    return { step: 'failed', detail: committed.kind }
  }

  ctx.journal.update(agent, entry => {
    if (entry.move) {
      entry.move = { ...entry.move, phase: 'activating' }
    }
  })
  ctx.standing.invalidate(agent)
  ctx.step?.('target:committed')

  return activate(ctx, agent, signal)
}

/**
 * This Mac is the home at a later epoch than the move it journaled: restore, bring the agent up, report ready.
 * Idempotent, so a crash at any point of it is finished by the next pass.
 */
export async function activate(ctx: HomeContext, agent: string, signal: AbortSignal): Promise<TargetResult> {
  const read = await ctx.platform.readPlacement(agent, signal)

  if (read.ok === false) {
    return { step: 'failed', detail: 'placement_unavailable' }
  }

  const placement = read.value
  const me = ctx.me()

  if (placement.location.kind !== 'mac' || placement.location.deviceServiceId !== me) {
    return { step: 'abandoned', detail: 'not_the_home' }
  }

  // Startup may need another pass (for example while the old lease expires). Never restore over a home twice.
  if (ctx.journal.read(agent).move?.restoredEpoch === placement.homeEpoch) {
    return await finishActivation(ctx, agent, signal)
  }

  ctx.journal.update(agent, entry => {
    if (entry.move?.role === 'target') {entry.move = { ...entry.move, phase: 'materializing' }}
  })

  const home = await ctx.runtime.materialize(agent, signal)

  if (!home) {
    return { step: 'failed', detail: 'no_local_home' }
  }

  // Materialization can enroll and touch the network. Re-read authority before restoring a byte.
  const current = await ctx.platform.readPlacement(agent, signal)
  if (
    current.ok === false ||
    current.value.homeId !== placement.homeId ||
    current.value.homeEpoch !== placement.homeEpoch ||
    current.value.location.kind !== 'mac' ||
    current.value.location.deviceServiceId !== me
  ) {
    return { step: 'abandoned', detail: 'stale_home' }
  }

  ctx.journal.update(agent, entry => {
    if (entry.move?.role === 'target') {entry.move = { ...entry.move, phase: 'restoring' }}
  })

  const fetched = await fetchAndVerify(ctx, agent, placement, signal)

  if (fetched.ok === false) {
    return { step: 'failed', detail: fetched.reason }
  }

  try {
    // The home's writers are held still while the portable part is replaced, then let go.
    let fingerprint: string | undefined

    try {
      const release = await ctx.runtime.quiesce(agent)

      try {
        await ctx.tool.restore(
          {
            home,
            archive: fetched.plain,
            backups: path.join(ctx.dirs.backups, agent),
            expectManifestSha256: fetched.header.manifest.manifestSha256,
            expectHomeId: placement.homeId
          },
          signal
        )

        // What the home looks like now is the generation just restored: the cadence's baseline, so the first
        // look at it does not mistake the restore itself for a change.
        fingerprint = (await ctx.tool.fingerprint({ home }, signal).catch(() => undefined))?.fingerprintSha256
      } finally {
        await release().catch(() => undefined)
      }
    } catch (error) {
      return { step: 'failed', detail: closedCode(error, 'restore_failed') }
    }

    ctx.step?.('target:restored')

    ctx.journal.update(agent, entry => {
      if (entry.move) {entry.move = { ...entry.move, restoredEpoch: placement.homeEpoch }}
      entry.homeId = placement.homeId
      entry.lastGeneration = placement.selectedGeneration
      entry.lastContentSha256 = contentDigestOf(fetched.header)
      entry.lastFingerprint = fingerprint
      entry.lastCommittedAt = ctx.now()
    })
    return await finishActivation(ctx, agent, signal)
  } finally {
    await rm(fetched.dir, { recursive: true, force: true })
  }
}

async function finishActivation(ctx: HomeContext, agent: string, signal: AbortSignal): Promise<TargetResult> {
  if (!ctx.journal.read(agent).move?.activationStarted) {
    try { await ctx.runtime.activate(agent, signal) }
    catch (error) { return { step: 'failed', detail: closedCode(error, 'activation_failed') } }
    ctx.journal.update(agent, entry => {
      if (entry.move) {entry.move = { ...entry.move, activationStarted: true }}
    })
  }
  ctx.step?.('target:activated')
  ctx.journal.update(agent, entry => {
    entry.activatedEpoch = entry.move?.restoredEpoch
    entry.move = undefined
    entry.checkpoint = undefined
    entry.managed = true
  })
  ctx.standing.invalidate(agent)
  return { step: 'activated' }
}

/** A closed code from a failure: the tool's and the runtime's own when they gave one, else the fallback. */
function closedCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : fallback
}

/** A journaled target move whose platform move is gone: committed to this Mac (finish the activation) or ended (forget it). */
export async function recoverTarget(ctx: HomeContext, agent: string, placement: HomePlacement, signal: AbortSignal): Promise<TargetResult> {
  const entry = ctx.journal.read(agent).move

  if (!entry || entry.role !== 'target') {
    return { step: 'abandoned', detail: 'nothing_to_recover' }
  }

  const committedHere =
    placement.location.kind === 'mac' && placement.location.deviceServiceId === ctx.me() && placement.homeEpoch > entry.expectedHomeEpoch

  if (!committedHere) {
    ctx.journal.update(agent, e => {
      e.move = undefined
    })

    return { step: 'abandoned', detail: 'move_ended' }
  }

  ctx.journal.update(agent, e => {
    if (e.move) {
      e.move = { ...e.move, phase: 'activating' }
    }
  })

  return activate(ctx, agent, signal)
}

/**
 * A move AWAY from this Mac: the source's half (atum.agent-home/2.1 `move`: requested -> draining ->
 * ready_to_commit -> committed).
 *
 *   draining   The platform shows a move whose source is this Mac. The agent takes no new work; the turn in
 *              flight, and its publication, are allowed to finish (`runtime.drain`). If they do not finish
 *              in time the drain is acknowledged `timed_out`, which the platform answers by ending the move,
 *              and the agent goes on answering from here.
 *   drained    The drain is acknowledged `quiesced`, signed with the move's operation (a job id this Mac
 *              minted and journaled, so a retry presents the same one). Only then is the FINAL checkpoint
 *              reserved: the platform ties it to the move and accepts it only if it was reserved after the
 *              acknowledgement and from that same operation. Its commit makes the move ready for the target.
 *   waiting    Nothing more happens here until the target commits. If it never does within the bound, this
 *              Mac ends the move itself (`target_unavailable`) and answers again: an owner who asked for a move
 *              and walked away is not left with a silent agent.
 *   stood down The platform shows the home elsewhere (the move committed): the runtime and the answering
 *              lease are given up, and anything newer than the last committed generation is set aside as a
 *              quarantined copy (the whole home, `state.db` included, as one consistent export). A returning
 *              home is never promoted and never merged.
 *
 * Every step is journaled before it is taken, so a crash anywhere in this sequence resumes from the journal and
 * the platform's idempotent operations; none of it can leave two Macs answering.
 */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { type CheckpointDeps, takeCheckpoint } from './checkpoint'
import type { HomeMove, HomeOperation, HomePlacement } from './contract'
import type { HomeContext } from './runtime-ops'
import { failureWord, signedCall } from './signed-call'
import { mayCheckpoint } from './standing'

export type SourceStep =
  | 'draining'
  | 'checkpointing'
  | 'waiting_for_target'
  /** The move ended without a commit: this Mac answers again. */
  | 'resumed'
  /** The move committed elsewhere: this Mac is no longer the home. */
  | 'stood_down'
  | 'failed'

export interface SourceResult {
  step: SourceStep
  detail?: string
  /** A copy of newer state was kept (stood down only). */
  quarantined?: string
}

export const checkpointDepsOf = (ctx: HomeContext): CheckpointDeps => ({
  platform: ctx.platform,
  auth: ctx.auth,
  tool: ctx.tool,
  store: ctx.store,
  keys: ctx.keys,
  journal: ctx.journal,
  standing: ctx.standing,
  home: agent => ctx.runtime.home(agent),
  leaseFacts: agent => ctx.runtime.leaseFacts(agent),
  quiesce: agent => ctx.runtime.quiesce(agent),
  holdWrites: agent => ctx.runtime.holdWrites(agent),
  workDir: ctx.dirs.work,
  now: ctx.now,
  uuid: ctx.uuid,
  log: ctx.log,
  phase: name => ctx.step?.(`checkpoint:${name}`)
})

/** Acknowledge the drain, signed fresh, fenced by the move's operation. */
async function acknowledge(
  ctx: HomeContext,
  agent: string,
  move: HomeMove,
  operation: HomeOperation,
  result: 'quiesced' | 'timed_out',
  signal: AbortSignal
) {
  return signedCall<unknown>(
    { standing: ctx.standing, auth: ctx.auth, leaseFacts: a => ctx.runtime.leaseFacts(a) },
    agent,
    operation,
    mayCheckpoint,
    ({ fence }) =>
      ctx.auth
        .sign('DrainAck', meta => ({ meta, moveId: move.moveId, fence: fence!, result }))
        .then(body => ctx.platform.ackDrain(agent, body as never, signal)),
    signal
  )
}

/** End the move from this side (the owner's operation, fenced by the CAS on epoch and revision). */
async function endMove(
  ctx: HomeContext,
  agent: string,
  move: HomeMove,
  reason: 'drain_failed' | 'target_unavailable',
  signal: AbortSignal
): Promise<boolean> {
  const read = await ctx.platform.readPlacement(agent, signal)

  if (read.ok === false) {
    return false
  }

  const answer = await ctx.platform.abortMove(
    agent,
    {
      moveId: move.moveId,
      idempotencyKey: move.idempotencyKey,
      expectedHomeEpoch: read.value.homeEpoch,
      expectedPlacementRevision: read.value.placementRevision,
      reason
    },
    signal
  )

  // `stale_cas` means the placement moved between the read and the abort: the next pass reads it again.
  return answer.ok === true && ['aborted', 'already_aborted'].includes(answer.value)
}

async function resumeAgent(ctx: HomeContext, agent: string): Promise<void> {
  await ctx.runtime.resume(agent)
  ctx.standing.invalidate(agent)
  ctx.journal.update(agent, entry => {
    entry.move = undefined
  })
}

export async function runSource(
  ctx: HomeContext,
  agent: string,
  placement: HomePlacement,
  move: HomeMove,
  signal: AbortSignal
): Promise<SourceResult> {
  const known = ctx.journal.read(agent).move
  // Readiness can be owner-accepted without a source acknowledgement. Journal it so cancellation resumes here
  // and commitment elsewhere preserves any post-checkpoint state through finishSource.
  if (move.status === 'ready_to_commit' && !(known?.moveId === move.moveId && known.ackedAt)) {
    if (known?.moveId !== move.moveId || known.role !== 'source' || !known.forced) {
      ctx.journal.update(agent, entry => {
        entry.managed = true
        entry.homeId = placement.homeId
        entry.checkpoint = undefined
        entry.move = {
          moveId: move.moveId, idempotencyKey: move.idempotencyKey, role: 'source', phase: 'drained', forced: true,
          expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision,
          startedAt: ctx.now()
        }
      })
      await ctx.runtime.standDown(agent)
      ctx.standing.invalidate(agent)
    }
    return { step: 'waiting_for_target' }
  }

  if (!known || known.moveId !== move.moveId || known.role !== 'source') {
    ctx.journal.update(agent, entry => {
      entry.managed = true
      entry.homeId = placement.homeId
      // Whatever checkpoint was open is failed by the platform when the drain is acknowledged.
      entry.checkpoint = undefined
      entry.move = {
        moveId: move.moveId,
        idempotencyKey: move.idempotencyKey,
        role: 'source',
        phase: 'draining',
        expectedHomeEpoch: placement.homeEpoch,
        expectedPlacementRevision: placement.placementRevision,
        operationId: ctx.uuid(),
        startedAt: ctx.now(),
        attempts: 0
      }
    })
    ctx.standing.invalidate(agent)
    ctx.step?.('source:journaled')
  }

  const entry = ctx.journal.read(agent).move!
  const operation: HomeOperation = { kind: 'job', id: entry.operationId! }

  // ------------------------------------------------------------------------------ draining
  if (entry.phase === 'draining') {
    const drained = await ctx.runtime.drain(agent, ctx.budgets.drainMs, signal)
    ctx.step?.('source:drained')

    const ack = await acknowledge(ctx, agent, move, operation, drained, signal)

    if (ack.ok === false) {
      // Not acknowledged: the agent stays quiet and the next pass asks again. A platform that cannot be reached
      // is waited for; any other refusal (this Mac has no lease term to sign with, the signature is refused) will
      // not change by waiting, so after a few tries the move is ended and the agent answers again, instead of
      // sitting silent until the platform gives up on the move.
      const waits = ['unavailable', 'unsupported', 'not_home'].includes(ack.failure.kind)

      if (!waits) {
        const tries = (ctx.journal.read(agent).move?.attempts ?? 0) + 1

        ctx.journal.update(agent, e => {
          if (e.move) {
            e.move = { ...e.move, attempts: tries }
          }
        })

        if (tries >= ctx.budgets.attempts && (await endMove(ctx, agent, move, 'drain_failed', signal))) {
          await resumeAgent(ctx, agent)

          return { step: 'resumed', detail: failureWord(ack.failure) }
        }
      }

      return { step: 'failed', detail: failureWord(ack.failure) }
    }

    if (drained === 'timed_out') {
      // The platform ended the move on a drain that did not finish; the agent answers again.
      await resumeAgent(ctx, agent)

      return { step: 'resumed', detail: 'drain_timed_out' }
    }

    ctx.journal.update(agent, e => {
      if (e.move) {
        e.move = { ...e.move, phase: 'drained', attempts: 0, ackedAt: ctx.now() }
      }
    })
    ctx.step?.('source:acknowledged')
  }

  // ------------------------------------------------------------------------------ drained
  const fresh = await ctx.platform.readPlacement(agent, signal)

  if (fresh.ok === false) {
    return { step: 'waiting_for_target', detail: 'placement_unavailable' }
  }

  const current = fresh.value.activeMove

  // The move is gone or replaced: the caller's next pass classifies it again.
  if (!current || current.moveId !== move.moveId) {
    return { step: 'waiting_for_target', detail: 'move_changed' }
  }

  if (current.status === 'ready_to_commit') {
    const since = ctx.journal.read(agent).move?.readySince ?? ctx.now()

    if (ctx.journal.read(agent).move?.readySince === undefined) {
      ctx.journal.update(agent, e => {
        if (e.move) {
          e.move = { ...e.move, readySince: since }
        }
      })
    }

    if (ctx.now() - since > ctx.budgets.targetWaitMs) {
      const ended = await endMove(ctx, agent, current, 'target_unavailable', signal)

      if (ended) {
        await resumeAgent(ctx, agent)

        return { step: 'resumed', detail: 'target_unavailable' }
      }
    }

    return { step: 'waiting_for_target' }
  }

  // The final checkpoint: reserved after the acknowledgement, from the drain's own operation.
  const outcome = await takeCheckpoint(
    checkpointDepsOf(ctx),
    { agent, reason: 'move_drain', operation, notBefore: ctx.journal.read(agent).move?.ackedAt },
    signal
  )

  if (outcome.state === 'committed') {
    ctx.journal.update(agent, e => {
      if (e.move) {
        e.move = { ...e.move, readySince: ctx.now(), attempts: 0 }
      }
    })
    ctx.step?.('source:checkpointed')

    return { step: 'waiting_for_target' }
  }

  const attempts = (ctx.journal.read(agent).move?.attempts ?? 0) + 1

  ctx.journal.update(agent, e => {
    if (e.move) {
      e.move = { ...e.move, attempts }
    }
  })

  if (attempts >= ctx.budgets.attempts) {
    // The checkpoint cannot be taken: end the move so the agent is not left quiet for a move that cannot finish.
    if (await endMove(ctx, agent, current, 'drain_failed', signal)) {
      await resumeAgent(ctx, agent)

      return { step: 'resumed', detail: `checkpoint_${outcome.reason}` }
    }
  }

  return { step: 'checkpointing', detail: outcome.reason }
}

/**
 * The move that this Mac drained for is over. Committed elsewhere: stand down and keep a copy of anything
 * newer. Ended without a commit (cancelled, superseded by nothing, timed out): answer again.
 */
export async function finishSource(ctx: HomeContext, agent: string, placement: HomePlacement, signal: AbortSignal): Promise<SourceResult> {
  const me = ctx.me()

  if (placement.location.kind === 'mac' && placement.location.deviceServiceId === me) {
    await resumeAgent(ctx, agent)

    return { step: 'resumed', detail: 'move_ended' }
  }

  await ctx.runtime.standDown(agent)
  const quarantined = await keepNewerCopy(ctx, agent, placement, signal)

  ctx.journal.update(agent, entry => {
    entry.move = undefined
    entry.checkpoint = undefined
  })
  ctx.standing.invalidate(agent)

  return { step: 'stood_down', ...(quarantined ? { quarantined } : {}) }
}

/**
 * Anything the home holds that the last committed generation does not is set aside as one consistent copy of
 * the whole home (`state.db` included) in a private folder; nothing is merged or promoted. "Newer" is decided
 * on content: the portable part measured now against the digest of the generation this Mac last committed.
 */
async function keepNewerCopy(ctx: HomeContext, agent: string, placement: HomePlacement, signal: AbortSignal): Promise<string | undefined> {
  const home = ctx.runtime.home(agent)

  if (!home) {
    return undefined
  }

  const probe = path.join(ctx.dirs.work, agent, `measure-${ctx.uuid()}`)

  try {
    await mkdir(probe, { recursive: true, mode: 0o700 })

    const measured = await ctx.tool.capture(
      { home, out: path.join(probe, 'measure.plain'), homeId: placement.homeId, generation: 2, parentGeneration: 1, homeEpoch: 1 },
      signal
    )

    if (measured.contentSha256 === ctx.journal.read(agent).lastContentSha256) {
      return undefined
    }
  } catch {
    // If the home cannot even be measured, keep the copy: losing it silently is the worse mistake.
  } finally {
    await rm(probe, { recursive: true, force: true })
  }

  const dir = path.join(ctx.dirs.quarantine, agent)
  const file = path.join(dir, `${placement.homeEpoch}-${ctx.now()}.archive`)

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await ctx.tool.exportAll({ home, out: file }, signal)
    ctx.log(`[Home] ${agent.slice(0, 8)} kept a quarantined copy of newer state (epoch ${placement.homeEpoch})`)

    return file
  } catch {
    ctx.log(`[Home] ${agent.slice(0, 8)} could not keep a quarantined copy`)

    return undefined
  }
}

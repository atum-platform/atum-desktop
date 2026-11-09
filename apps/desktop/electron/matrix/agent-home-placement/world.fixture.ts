/**
 * Test support only: a platform, two Macs and one agent, on one clock.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll } from 'vitest'

import type { HomeAuthorityFence, HomeLeaseFence, HomeOperation } from './contract'
import { createTestMac, FakeClock, type TestMac } from './mac.fixture'
import { StubHomePlatform } from './stub-platform.fixture'

const scratchRoots: string[] = []

/** A private temp folder for a test, removed when the test file is done (a Mac's home, its work and backup folders). */
export function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  scratchRoots.push(directory)

  return directory
}

afterAll(() => {
  for (const directory of scratchRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

export interface World {
  clock: FakeClock
  stub: StubHomePlatform
  /** "MacBook". */
  a: TestMac
  /** "Mac mini". */
  b: TestMac
  agent: string
}

export async function createWorld(options: { lazy?: boolean; at?: 'a' | 'b' | 'cloud' } = {}): Promise<World> {
  const clock = new FakeClock()
  const stub = new StubHomePlatform({ now: clock.now })
  const a = await createTestMac(stub, clock, 'MacBook')
  const b = await createTestMac(stub, clock, 'Mac mini')
  const agent = randomUUID()
  const at = options.at ?? 'a'

  stub.addAgent(agent, {
    lazy: options.lazy,
    location: at === 'cloud' ? { kind: 'cloud' } : { kind: 'mac', deviceServiceId: (at === 'a' ? a : b).deviceServiceId }
  })

  if (at !== 'cloud') {
    stub.grantLease(agent, (at === 'a' ? a : b).deviceServiceId)
  }

  return { clock, stub, a, b, agent }
}

/**
 * A manual move of the agent from A to B, asked for as the owner would ask (nothing drains yet): B is from now on the target
 * of the placement's one active move, which is what lets it read the home's archive and key before it is the home.
 */
export async function requestMove(w: World): Promise<void> {
  const placed = w.stub.placement(w.agent)

  const answer = await w.a.platform.requestMove(
    w.agent,
    {
      moveId: randomUUID(),
      idempotencyKey: randomUUID(),
      target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
      expectedHomeEpoch: placed.homeEpoch,
      expectedPlacementRevision: placed.placementRevision
    },
    signal()
  )

  if (!answer.ok) {
    throw new Error('move_not_requested')
  }
}

/** The next generation of the agent's home, reserved as the home Mac reserves it: the only thing an archive upload can be for. */
export async function reserveGeneration(w: World): Promise<{ checkpointId: string; generation: number; homeId: string }> {
  const placed = w.stub.placement(w.agent)
  const checkpointId = randomUUID()

  const body = await w.a.auth.sign('CheckpointReserve', meta => ({
    operation: 'reserve' as const,
    meta,
    checkpointId,
    expectedPlacementRevision: placed.placementRevision,
    fence: fenceOf(w)
  }))

  const answer = await w.a.platform.reserveCheckpoint(w.agent, body as never, signal())

  if (!answer.ok || answer.value.outcome !== 'reserved') {
    throw new Error('generation_not_reserved')
  }

  return { checkpointId, generation: answer.value.generation, homeId: placed.homeId }
}

/** A reserved generation, committed: what binds a manifest to its archive and lets any Mac of the owner's read it back. */
export async function commitGeneration(w: World, reserved: { checkpointId: string; generation: number }, manifestSha256: string): Promise<void> {
  const placed = w.stub.placement(w.agent)

  const body = await w.a.auth.sign('CheckpointCommit', meta => ({
    operation: 'commit' as const,
    meta,
    checkpointId: reserved.checkpointId,
    generation: reserved.generation,
    parentGeneration: reserved.generation - 1,
    expectedHomeEpoch: placed.homeEpoch,
    expectedPlacementRevision: placed.placementRevision,
    manifestSha256,
    uploadVerified: true,
    fence: fenceOf(w)
  }))

  const answer = await w.a.platform.commitCheckpoint(w.agent, body as never, signal())

  if (!answer.ok || answer.value.outcome !== 'committed') {
    throw new Error('generation_not_committed')
  }
}

/** A job id the Mac minted: checkpoints and drains are fenced by the lease and the epoch, not a lookup of it. */
export const mintOperation = (): HomeOperation => ({ kind: 'job', id: randomUUID() })

/** The lease half of the fence as the platform trusts it right now. */
export function leaseFenceOf(w: World): HomeLeaseFence {
  const placement = w.stub.placement(w.agent)
  const lease = w.stub.lease(w.agent)

  if (!lease) {
    throw new Error('no_lease')
  }

  return {
    ownerUserId: w.stub.ownerUserId,
    agentPrincipal: w.agent,
    homeId: placement.homeId,
    homeEpoch: placement.homeEpoch,
    executorTerm: lease.term,
    leaseId: lease.leaseId,
    leaseExpiresAtPlatform: lease.expiresAt
  }
}

export const fenceOf = (w: World, operation: HomeOperation = mintOperation()): HomeAuthorityFence => ({
  ...leaseFenceOf(w),
  operation
})

export const signal = (): AbortSignal => new AbortController().signal

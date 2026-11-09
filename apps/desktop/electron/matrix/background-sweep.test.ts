import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  parseAgentSweepClaimResponseV2,
  parseAgentSweepDispatchResponseV2
} from '../../../../packages/device-protocol/agent-sweep-v2'
import { followupSweepLocalDay, type FollowupSweepSuggestionNote } from '../../../shared/src/followup-sweep'

import {
  AGENT_SWEEP_PROFILE,
  AGENT_SWEEP_PROFILE_V2,
  AGENT_SWEEP_PROFILE_V11,
  type AgentSweepActivity,
  backgroundSweepOwnerEvent,
  FOLLOWUP_SWEEP_RESULT_PROFILE,
  type MatrixBackgroundSweepDeps,
  MatrixBackgroundSweeps
} from './background-sweep'

const sweepFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(
  `../../../../packages/device-protocol/fixtures/agent-sweep-v2/fixtures/${name}`,
  import.meta.url
), 'utf8'))
const claimV2 = (() => {
  const value = parseAgentSweepClaimResponseV2(sweepFixture('claim.normal.json'))
  if (value.decision !== 'claimed') {
    throw new Error('test_fixture_invalid')
  }
  return value
})()
const dispatchV2 = (() => {
  const value = parseAgentSweepDispatchResponseV2(sweepFixture('dispatch.normal.native.json'))
  if (value.decision !== 'dispatched') {
    throw new Error('test_fixture_invalid')
  }
  return value
})()

const candidate = {
  agentPrincipal: '00000000-0000-4000-8000-dec97132ebbf',
  assistantId: '00000000-0000-4000-8000-288c0dd127cf',
  roomId: '!agent:atum.test',
  ownerPrincipal: '@owner:atum.test'
}
const leaseToken = '00000000-0000-4000-8000-1f36c4162676'
const occurrenceId = '00000000-0000-4000-8000-149a1ef8d82f'
const activity: AgentSweepActivity = {
  lastOwnerEvent: { eventId: '$owner:test', at: 1_793_010_000_000 },
  lastDialogueAt: 1_793_010_060_000,
  busy: false,
  pendingWork: false,
  pendingApproval: false,
  typing: false
}
const claimed = {
  profile: AGENT_SWEEP_PROFILE,
  decision: 'claimed' as const,
  occurrenceId,
  occurrenceAt: 1_793_017_200_000,
  expiresAt: 1_793_017_320_000,
  settingsRevision: 1,
  ownerTimeZone: 'Asia/Ho_Chi_Minh',
  policy: { sourceIntervalMs: 7_200_000 as const },
  sourceWatermarks: { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null }
}
const authorization = {
  kind: 'native' as const,
  authorizationId: '00000000-0000-4000-8000-463bfa64f08a',
  expiresAt: 1_793_017_320_000,
  destination: { destination: 'mac:raymond', source: 'atum', model: 'nguyet-thuc', effort: 'medium' as const },
  protection: { kind: 'standard' as const },
  attribution: { id: '00000000-0000-4000-8000-5bb08005840f', lane: 'atum_managed' as const },
  limits: {
    activeComputeSeconds: 120 as const,
    calls: 1 as const,
    inputTokens: 8_000 as const,
    outputTokens: 1_000 as const,
    maxModelMicroProtons: 114_210_000
  }
}
const snapshot = (fresh: boolean) => ({
  profile: 'atum.followup-sweep-evidence/1' as const,
  capturedAt: 1_793_017_200_000,
  ownerTimeZone: 'Asia/Ho_Chi_Minh',
  watermarks: { googleMail: 'mail-1', googleCalendar: null, atumChats: null, conversation: 'event-1', memory: null },
  sources: [{ source: 'google_mail' as const, status: 'ok' as const }],
  entries: [{ fresh }],
  digest: 'd'.repeat(64)
})

function suggestionNotes() {
  let note: FollowupSweepSuggestionNote | null = null

  return {
    read: (_owner: string) => note,
    write: (value: FollowupSweepSuggestionNote) => {
      note = value
    },
    admit: (owner: string, date: string) => {
      if (note && note.owner === owner && note.date === date) {
        note = { ...note, admitted: true }
      }
    },
    current: () => note
  }
}

function harness(change: Partial<MatrixBackgroundSweepDeps> = {}) {
  let held = true
  const deps: MatrixBackgroundSweepDeps = {
    candidates: () => [candidate],
    activity: vi.fn(async () => activity),
    hold: vi.fn(async () => {
      held = true
      return {
        leaseToken,
        held: () => held,
        release: () => {
          held = false
        }
      }
    }),
    acquire: vi.fn(async () => ({ release: vi.fn() })),
    claim: vi.fn(async () => claimed),
    dispatch: vi.fn(async () => ({
      profile: AGENT_SWEEP_PROFILE,
      decision: 'dispatched' as const,
      occurrenceId,
      expiresAt: claimed.expiresAt,
      settingsRevision: 1,
      authorization
    })),
    collect: vi.fn(async () => snapshot(false)),
    needsModel: value => value.entries.some(entry => entry.fresh),
    suggestion: () => false,
    prompt: () => 'bounded prompt',
    classify: vi.fn(async () => ({
      value: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' },
      usage: {
        computeSeconds: 2,
        modelAttempts: 1 as const,
        inputTokens: 300,
        outputTokens: 10,
        modelMicroProtons: 100
      }
    })),
    validate: value => ({
      result: value as never,
      findingHashes:
        value && typeof value === 'object' && (value as { decision?: string }).decision === 'offer'
          ? ['f'.repeat(64)]
          : []
    }),
    fingerprint: vi.fn(async () => 'a'.repeat(64)),
    stagePublication: vi.fn(async () => ({
      outboxId: '00000000-0000-4000-8000-fbd62e9c2632',
      bodySha256: 'b'.repeat(64)
    })),
    release: vi.fn(async () => ({
      profile: AGENT_SWEEP_PROFILE_V11,
      decision: 'released' as const,
      occurrenceId,
      occurrenceKind: 'warmup_nudge' as const,
      warmupNudgeIndex: 1 as const,
      releaseCount: 1 as const,
      retryAt: 1_793_017_320_000
    })),
    settle: vi.fn(async () => ({ publication: { state: 'none' as const } })),
    now: () => 1_793_017_200_000,
    log: vi.fn(),
    ...change
  }
  return {
    deps,
    driver: new MatrixBackgroundSweeps(deps),
    loseLease: () => {
      held = false
    }
  }
}

describe('the Mac background sweep driver', () => {
  it('keeps the latest owner event after the assistant replies', () => {
    expect(
      backgroundSweepOwnerEvent(
        [
          { eventId: '$assistant:test', role: 'assistant' },
          { eventId: '$owner:test', role: 'user' },
          { eventId: '$older-owner:test', role: 'user' }
        ],
        activity.lastDialogueAt!
      )
    ).toEqual({ eventId: '$owner:test', at: activity.lastDialogueAt })
  })

  it('claims under the answering lease and settles an unchanged source scan with zero model calls', async () => {
    const h = harness()
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.classify).not.toHaveBeenCalled()
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceId,
        outcome: 'answered',
        disposition: 'silent',
        usage: expect.objectContaining({ modelAttempts: 0, inputTokens: 0, outputTokens: 0 })
      }),
      expect.any(AbortSignal)
    )
    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(true)
  })

  it('claims /2 only after explicit negotiation and drains that recorded profile through settlement', async () => {
    const negotiate = vi.fn(async () => AGENT_SWEEP_PROFILE_V2)
    const collect = vi.fn(async () => ({ profile: 'atum.followup-sweep-evidence/2' as const,
      capturedAt: 1_793_017_200_000, ownerTimeZone: 'Asia/Ho_Chi_Minh',
      sourceSnapshotDigest: claimV2.admittedSources.snapshotDigest, cursorDeltas: {}, sources: [], entries: [],
      digest: 'd'.repeat(64) }))
    const h = harness({ negotiate,
      claim: vi.fn(async (_candidate, _lease, request) => {
        expect(request.profile).toBe(AGENT_SWEEP_PROFILE_V2)
        return claimV2
      }),
      dispatch: vi.fn(async (_candidate, _lease, request) => {
        expect(request.profile).toBe(AGENT_SWEEP_PROFILE_V2)
        return dispatchV2
      }),
      collect })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(negotiate).toHaveBeenCalledOnce()
    expect(collect).toHaveBeenCalledWith(candidate, claimV2, expect.any(AbortSignal))
    expect(h.deps.settle).toHaveBeenCalledWith(expect.objectContaining({ profile: AGENT_SWEEP_PROFILE_V2 }),
      expect.any(AbortSignal))
  })

  it('does not claim when source negotiation times out or is refused', async () => {
    const claim = vi.fn()
    const h = harness({ negotiate: vi.fn(async () => { throw new Error('matrix_background_sweep_unavailable') }), claim })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.log).toHaveBeenCalled())
    expect(claim).not.toHaveBeenCalled()
  })

  it('reports repeated failures once, reports reason changes, and re-arms after recovery', async () => {
    const negotiate = vi.fn(async () => { throw new Error('matrix_background_sweep_denied') })
    const h = harness({ negotiate })
    const beat = async () => {
      h.driver.tick()
      // Allow the full run and its cleanup to finish before the next host beat.
      await new Promise(resolve => setImmediate(resolve))
    }
    await beat()
    await beat()
    expect(negotiate).toHaveBeenCalledTimes(2)
    expect(h.deps.log).toHaveBeenCalledTimes(1)
    expect(h.deps.log).toHaveBeenLastCalledWith(expect.stringContaining('reason=matrix_background_sweep_denied'))

    negotiate.mockRejectedValueOnce(new Error('matrix_background_sweep_unsupported'))
    await beat()
    expect(h.deps.log).toHaveBeenCalledTimes(2)
    expect(h.deps.log).toHaveBeenLastCalledWith(expect.stringContaining('reason=matrix_background_sweep_unsupported'))

    // An idle/busy observation is a healthy run; a subsequent outage is a new state.
    vi.mocked(h.deps.activity).mockResolvedValueOnce(null)
    await beat()
    await beat()
    expect(h.deps.log).toHaveBeenCalledTimes(3)
  })

  it('never logs arbitrary error text or cancellation as a sweep failure', async () => {
    const h = harness({ negotiate: vi.fn(async () => { throw new Error('private payload or credential') }) })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.log).toHaveBeenCalledOnce())
    expect(h.deps.log).toHaveBeenLastCalledWith(
      `[Matrix] background sweep unavailable agent=${candidate.agentPrincipal.slice(0, 8)} reason=matrix_background_sweep_unavailable`
    )

    const cancelled = harness({ negotiate: vi.fn(async (_candidate, signal) => {
      cancelled.driver.cancel(candidate.agentPrincipal)
      signal.throwIfAborted()
      return AGENT_SWEEP_PROFILE_V2
    }) })
    cancelled.driver.tick()
    await new Promise(resolve => setImmediate(resolve))
    expect(cancelled.deps.log).not.toHaveBeenCalled()
  })

  it('refuses an implicit profile downgrade in the claim response', async () => {
    const dispatch = vi.fn()
    const h = harness({ negotiate: vi.fn(async () => AGENT_SWEEP_PROFILE_V2),
      claim: vi.fn(async () => ({ profile: AGENT_SWEEP_PROFILE_V11, decision: 'defer' as const,
        reason: 'not_due', notBefore: 1_793_017_320_000 })), dispatch })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.log).toHaveBeenCalled())
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('makes one classifier call and seals an offer for settle-gated publication', async () => {
    const offer = {
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
      decision: 'offer' as const,
      evidenceIds: ['mail:abc'],
      urgency: 'normal' as const,
      text: 'Lan needs an answer. Shall I draft a reply?'
    }
    const h = harness({
      collect: vi.fn(async () => snapshot(true)),
      classify: vi.fn(async () => ({
        value: offer,
        usage: {
          computeSeconds: 2,
          modelAttempts: 1 as const,
          inputTokens: 300,
          outputTokens: 10,
          modelMicroProtons: 100
        }
      })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.classify).toHaveBeenCalledOnce()
    expect(h.deps.stagePublication).toHaveBeenCalledBefore(vi.mocked(h.deps.settle))
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'offer',
        findingHashes: ['f'.repeat(64)],
        outbox: expect.objectContaining({ outboxId: '00000000-0000-4000-8000-fbd62e9c2632' })
      }),
      expect.any(AbortSignal)
    )
  })

  it('does not charge an attempt when the bounded prompt cannot be built', async () => {
    const h = harness({
      collect: vi.fn(async () => snapshot(true)),
      prompt: vi.fn(() => {
        throw new Error('followup_sweep_prompt_too_large')
      })
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.classify).not.toHaveBeenCalled()
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'uncertain',
        disposition: 'none',
        usage: expect.objectContaining({ modelAttempts: 0 })
      }),
      expect.any(AbortSignal)
    )
  })

  it('replays the identical admitted settlement once when inline publication transport fails', async () => {
    const offer = {
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
      decision: 'offer' as const,
      evidenceIds: ['mail:abc'],
      urgency: 'normal' as const,
      text: 'Lan needs an answer. Shall I draft a reply?'
    }
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error('inline publication unavailable'))
      .mockResolvedValueOnce({ publication: { state: 'admitted' as const } })
    const h = harness({
      collect: vi.fn(async () => snapshot(true)),
      classify: vi.fn(async () => ({
        value: offer,
        usage: { computeSeconds: 2, modelAttempts: 1 as const, inputTokens: 300, outputTokens: 10, modelMicroProtons: 0 }
      })),
      settle
    })

    h.driver.tick()
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(2))

    expect(settle.mock.calls[1]?.[0]).toBe(settle.mock.calls[0]?.[0])
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
  })

  it('settles an ambiguous publication stage as uncertain and never as silence', async () => {
    const offer = {
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
      decision: 'offer' as const,
      evidenceIds: ['mail:abc'],
      urgency: 'normal' as const,
      text: 'Lan needs an answer. Shall I draft a reply?'
    }
    const h = harness({
      collect: vi.fn(async () => snapshot(true)),
      classify: vi.fn(async () => ({
        value: offer,
        usage: { computeSeconds: 2, modelAttempts: 1 as const, inputTokens: 300, outputTokens: 10, modelMicroProtons: 100 }
      })),
      stagePublication: vi.fn(async () => Promise.reject(new Error('effect unknown')))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'uncertain', disposition: 'none', outbox: null }),
      expect.any(AbortSignal)
    )
  })

  it('does no work on a second Mac that cannot hold the answering lease', async () => {
    const h = harness({ hold: vi.fn(async () => null) })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.hold).toHaveBeenCalledOnce())
    expect(h.deps.claim).not.toHaveBeenCalled()
    expect(h.deps.collect).not.toHaveBeenCalled()
  })

  it('confirms sweep capability without fabricating activity from unreadable history', async () => {
    const probe = vi.fn(async () => ({ active: true }))
    const h = harness({ probe, activity: vi.fn(async () => null) })
    h.driver.tick()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(true)
    expect(h.deps.claim).not.toHaveBeenCalled()
  })

  it('stops before dispatch when a home transition loses the lease', async () => {
    let h: ReturnType<typeof harness>
    h = harness({
      acquire: vi.fn(async () => {
        h.loseLease()
        return { release: vi.fn() }
      })
    })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.acquire).toHaveBeenCalledOnce())
    expect(h.deps.dispatch).not.toHaveBeenCalled()
    expect(h.deps.classify).not.toHaveBeenCalled()
  })

  it('honours platform disablement for cloud and Mac through the same claim decision', async () => {
    const h = harness({
      claim: vi.fn(async () => ({
        profile: AGENT_SWEEP_PROFILE,
        decision: 'defer' as const,
        reason: 'disabled',
        notBefore: 1_793_024_400_000
      }))
    })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.claim).toHaveBeenCalledOnce())
    expect(h.deps.dispatch).not.toHaveBeenCalled()
    expect(h.deps.classify).not.toHaveBeenCalled()
    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(true)
  })

  it('restores legacy nudges when rollout is not active for this owner', async () => {
    const h = harness({
      claim: vi.fn(async () => ({
        profile: AGENT_SWEEP_PROFILE,
        decision: 'defer' as const,
        reason: 'policy_off',
        notBefore: 1_793_017_230_000
      }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.claim).toHaveBeenCalledOnce())

    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(false)
    expect(h.deps.classify).not.toHaveBeenCalled()
  })

  it('keeps legacy nudges and skips claims without an active owner placement', async () => {
    const probe = vi.fn(async () => ({ active: false }))
    const h = harness({ probe })

    h.driver.tick()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())

    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(false)
    expect(h.deps.hold).not.toHaveBeenCalled()
    expect(h.deps.claim).not.toHaveBeenCalled()
  })

  it('rechecks owner activity immediately before settlement', async () => {
    const later = { ...activity, lastOwnerEvent: { eventId: '$new-owner:test', at: activity.lastOwnerEvent!.at + 1 } }
    const activityRead = vi
      .fn()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(later)
    const h = harness({ activity: activityRead })
    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEventWatermark: later.lastOwnerEvent }),
      expect.any(AbortSignal)
    )
  })

  it('refreshes rollout eligibility independently of a deferred sweep deadline', async () => {
    let now = 1_793_017_200_000
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ active: true, revision: 1 })
      .mockResolvedValue({ active: false, revision: 1 })
    const h = harness({
      probe,
      now: () => now,
      claim: vi.fn(async () => ({
        profile: AGENT_SWEEP_PROFILE,
        decision: 'defer' as const,
        reason: 'not_due',
        notBefore: now + 2 * 60 * 60_000
      }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.claim).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(true)

    // The platform moved the next check two hours out; the rollout probe stays bounded.
    now += 9 * 60_000
    h.driver.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(probe).toHaveBeenCalledOnce()

    now += 60_000
    h.driver.tick()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect(h.driver.activeForOwner(candidate.agentPrincipal)).toBe(false)
  })

  it('rechecks a re-enable inside ten minutes instead of the old two-hour deadline', async () => {
    let now = 1_793_017_200_000
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ active: true, revision: 1 })
      .mockResolvedValue({ active: true, revision: 2 })
    const claim = vi.fn(async () => ({
      profile: AGENT_SWEEP_PROFILE,
      decision: 'defer' as const,
      reason: 'not_due',
      notBefore: now + 2 * 60 * 60_000
    }))
    const h = harness({ probe, now: () => now, claim })

    h.driver.tick()
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 20))

    h.driver.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(claim).toHaveBeenCalledTimes(1)

    // Ten minutes later the setting revision changed: the owner re-enabled the rollout.
    now += 10 * 60_000
    h.driver.tick()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2))
  })
})

const warmupClaim = (occurrenceAt = 1_793_017_200_000) => ({
  profile: AGENT_SWEEP_PROFILE_V11,
  decision: 'claimed' as const,
  occurrenceId,
  occurrenceAt,
  effectiveDueAt: occurrenceAt,
  expiresAt: occurrenceAt + 120_000,
  settingsRevision: 1,
  ownerTimeZone: 'Asia/Ho_Chi_Minh',
  policy: { sourceIntervalMs: 7_200_000 as const, effectiveSourceIntervalMs: 3_600_000 },
  sourceWatermarks: { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null },
  occurrenceKind: 'warmup_nudge' as const,
  warmupNudgeIndex: 1 as const
})

const warmupDispatch = (claim: ReturnType<typeof warmupClaim>) => ({
  profile: AGENT_SWEEP_PROFILE_V11,
  decision: 'dispatched' as const,
  occurrenceId,
  occurrenceKind: 'warmup_nudge' as const,
  warmupNudgeIndex: 1 as const,
  expiresAt: claim.expiresAt,
  settingsRevision: 1,
  authorization: {
    ...authorization,
    limits: { ...authorization.limits, activeComputeSeconds: 1_800 as const }
  }
})

describe('the Mac warm-up nudge driver', () => {
  it('takes the deeper 1,800-second turn and publishes one offer even without an owner event', async () => {
    const claim = warmupClaim()
    const offer = {
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
      decision: 'offer' as const,
      evidenceIds: [],
      urgency: 'normal' as const,
      text: 'You keep mentioning the Hai Ba Trung launch. Shall I sketch a one-week plan for it?'
    }
    const prompt = vi.fn(() => 'warm-up prompt')
    const validate = vi.fn(() => ({ result: offer, findingHashes: [] }))
    const h = harness({
      claim: vi.fn(async () => claim),
      dispatch: vi.fn(async () => warmupDispatch(claim)),
      activity: vi.fn(async () => ({ ...activity, lastOwnerEvent: null })),
      collect: vi.fn(async () => snapshot(false)),
      needsModel: vi.fn(() => false),
      prompt,
      validate,
      classify: vi.fn(async () => ({
        value: offer,
        usage: { computeSeconds: 900, modelAttempts: 1 as const, inputTokens: 3_000, outputTokens: 80, modelMicroProtons: 0 }
      })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.claim).toHaveBeenCalledWith(
      candidate,
      expect.anything(),
      expect.objectContaining({ profile: AGENT_SWEEP_PROFILE_V11 }),
      expect.any(AbortSignal)
    )
    expect(h.deps.needsModel).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith(expect.anything(), 1, 'finding')
    expect(validate).toHaveBeenCalledWith(offer, expect.anything(), 1, 'finding', candidate.ownerPrincipal)
    expect(h.deps.classify).toHaveBeenCalledOnce()
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: AGENT_SWEEP_PROFILE_V11,
        outcome: 'answered',
        disposition: 'offer',
        urgency: 'normal',
        findingHashes: [],
        outbox: expect.objectContaining({ outboxId: '00000000-0000-4000-8000-fbd62e9c2632' })
      }),
      expect.any(AbortSignal)
    )
  })

  it('does not run or publish a nudge while the platform reports the agent disabled', async () => {
    const h = harness({
      claim: vi.fn(async () => ({
        profile: AGENT_SWEEP_PROFILE_V11,
        decision: 'defer' as const,
        reason: 'disabled',
        notBefore: 1_793_024_400_000
      }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.claim).toHaveBeenCalledOnce())
    expect(h.deps.collect).not.toHaveBeenCalled()
    expect(h.deps.dispatch).not.toHaveBeenCalled()
    expect(h.deps.classify).not.toHaveBeenCalled()
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).not.toHaveBeenCalled()
  })

  it('never dispatches or publishes a nudge whose slot falls outside quiet hours', async () => {
    // 16:00 UTC is 23:00 in the owner's Asia/Ho_Chi_Minh day.
    const claim = warmupClaim(Date.parse('2026-10-26T16:00:00.000Z'))
    const h = harness({
      claim: vi.fn(async () => claim),
      dispatch: vi.fn(async () => warmupDispatch(claim))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.claim).toHaveBeenCalledOnce())
    expect(h.deps.acquire).not.toHaveBeenCalled()
    expect(h.deps.collect).not.toHaveBeenCalled()
    expect(h.deps.dispatch).not.toHaveBeenCalled()
    expect(h.deps.classify).not.toHaveBeenCalled()
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).not.toHaveBeenCalled()
    expect(h.deps.release).toHaveBeenCalledOnce()
    expect(h.deps.release).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId, reason: 'unusable_claim' }),
      expect.any(AbortSignal)
    )
    expect(vi.mocked(h.deps.release).mock.calls[0]?.[0]).not.toHaveProperty('usage')
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('quiet_hours'))
  })

  it('releases an invalid nudge result with the metered usage and never settles', async () => {
    const claim = warmupClaim()
    const h = harness({
      claim: vi.fn(async () => claim),
      dispatch: vi.fn(async () => warmupDispatch(claim)),
      collect: vi.fn(async () => snapshot(false)),
      prompt: vi.fn(() => 'warm-up prompt'),
      validate: vi.fn(() => ({ result: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' as const },
        findingHashes: [] })),
      classify: vi.fn(async () => ({
        value: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' },
        usage: { computeSeconds: 121, modelAttempts: 1 as const, inputTokens: 2_000, outputTokens: 12, modelMicroProtons: 4_000 }
      }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.release).toHaveBeenCalledOnce())

    expect(h.deps.release).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId, reason: 'invalid_result',
        usage: { computeSeconds: 121, modelAttempts: 1, inputTokens: 2_000, outputTokens: 12, modelMicroProtons: 4_000 } }),
      expect.any(AbortSignal)
    )
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).not.toHaveBeenCalled()
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('released'))
  })

  it('retires a nudge after two releases, publishes nothing and waits for nextDueAt', async () => {
    let now = 1_793_017_200_000
    const retryAt = now + 120_000
    const nextDueAt = now + 600_000
    let releases = 0
    const release = vi.fn(async () => {
      releases += 1
      return releases === 1
        ? { profile: AGENT_SWEEP_PROFILE_V11, decision: 'released' as const, occurrenceId,
            occurrenceKind: 'warmup_nudge' as const, warmupNudgeIndex: 1 as const, releaseCount: 1 as const, retryAt }
        : { profile: AGENT_SWEEP_PROFILE_V11, decision: 'retired' as const, occurrenceId,
            occurrenceKind: 'warmup_nudge' as const, warmupNudgeIndex: 1 as const, releaseCount: 2 as const,
            outcome: 'uncertain' as const, disposition: 'none' as const,
            receiptId: '00000000-0000-4000-8000-106e3b7099bf', settingsRevision: 1, nextDueAt,
            publication: { state: 'none' as const } }
    })
    const claim = vi.fn(async () => warmupClaim(now))
    const h = harness({
      now: () => now,
      claim,
      dispatch: vi.fn(async () => warmupDispatch(warmupClaim(now))),
      collect: vi.fn(async () => snapshot(false)),
      prompt: vi.fn(() => 'warm-up prompt'),
      validate: vi.fn(() => ({ result: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' as const },
        findingHashes: [] })),
      release
    })

    h.driver.tick()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    now = retryAt
    h.driver.tick()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))

    expect(claim).toHaveBeenCalledTimes(2)
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).not.toHaveBeenCalled()
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('retired'))

    now = nextDueAt - 1
    h.driver.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(claim).toHaveBeenCalledTimes(2)
  })

  it('replays a lost release response once with the identical request', async () => {
    const claim = warmupClaim()
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error('response_lost'))
      .mockResolvedValueOnce({ profile: AGENT_SWEEP_PROFILE_V11, decision: 'released' as const, occurrenceId,
        occurrenceKind: 'warmup_nudge' as const, warmupNudgeIndex: 1 as const, releaseCount: 1 as const,
        retryAt: 1_793_017_320_000 })
    const h = harness({
      claim: vi.fn(async () => claim),
      dispatch: vi.fn(async () => warmupDispatch(claim)),
      collect: vi.fn(async () => snapshot(false)),
      prompt: vi.fn(() => 'warm-up prompt'),
      validate: vi.fn(() => ({ result: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' as const },
        findingHashes: [] })),
      release
    })

    h.driver.tick()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))

    expect(release.mock.calls[1]?.[0]).toBe(release.mock.calls[0]?.[0])
    expect(h.deps.stagePublication).not.toHaveBeenCalled()
    expect(h.deps.settle).not.toHaveBeenCalled()
  })

  it('replays the identical nudge settlement after a crash and stages publication once', async () => {
    const claim = warmupClaim()
    const offer = {
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
      decision: 'offer' as const,
      evidenceIds: [],
      urgency: 'normal' as const,
      text: 'Your first-run notes mention a September deadline. Shall I turn it into a short plan?'
    }
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error('inline publication unavailable'))
      .mockResolvedValueOnce({ publication: { state: 'admitted' as const } })
    const h = harness({
      claim: vi.fn(async () => claim),
      dispatch: vi.fn(async () => warmupDispatch(claim)),
      collect: vi.fn(async () => snapshot(false)),
      prompt: vi.fn(() => 'warm-up prompt'),
      validate: vi.fn(() => ({ result: offer, findingHashes: [] })),
      classify: vi.fn(async () => ({
        value: offer,
        usage: { computeSeconds: 300, modelAttempts: 1 as const, inputTokens: 2_000, outputTokens: 50, modelMicroProtons: 0 }
      })),
      settle
    })

    h.driver.tick()
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(2))

    expect(settle.mock.calls[1]?.[0]).toBe(settle.mock.calls[0]?.[0])
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
  })
})

describe('the Mac quiet suggestion', () => {
  const midday = 1_792_989_000_000 // 11:30 Asia/Ho_Chi_Minh
  const offer = {
    profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
    decision: 'offer' as const,
    evidenceIds: [],
    urgency: 'normal' as const,
    text: 'I could turn the launch notes into a one-page plan. Want me to start it?'
  }
  const answer = {
    value: offer,
    usage: { computeSeconds: 2, modelAttempts: 1 as const, inputTokens: 300, outputTokens: 10, modelMicroProtons: 100 }
  }

  it('offers one grounded suggestion when there is no fresh finding inside the window', async () => {
    const h = harness({
      collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'suggestion prompt'),
      classify: vi.fn(async () => answer),
      validate: vi.fn((_value: unknown, _snapshot: unknown, _index: unknown, mode?: string) => ({
        result: offer,
        findingHashes: mode === 'suggestion' ? ['e'.repeat(64)] : []
      })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.classify).toHaveBeenCalledOnce()
    expect(vi.mocked(h.deps.prompt).mock.calls[0]?.[2]).toBe('suggestion')
    expect(vi.mocked(h.deps.validate).mock.calls[0]?.[3]).toBe('suggestion')
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'offer', urgency: 'normal', findingHashes: ['e'.repeat(64)] }),
      expect.any(AbortSignal)
    )
  })

  it('spends no second model call after today\'s admitted suggestion', async () => {
    const suggestions = suggestionNotes()
    const h = harness({
      suggestions,
      collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'suggestion prompt'),
      classify: vi.fn(async () => answer),
      validate: vi.fn(() => ({ result: offer, findingHashes: ['e'.repeat(64)] })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())
    expect(suggestions.current()).toMatchObject({ owner: candidate.ownerPrincipal, admitted: true })

    h.driver.tick()
    await vi.waitFor(() => expect(vi.mocked(h.deps.settle).mock.calls.length).toBe(2))

    expect(h.deps.classify).toHaveBeenCalledOnce()
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
    expect(vi.mocked(h.deps.settle).mock.calls[1]?.[0]).toMatchObject({ disposition: 'silent',
      usage: { modelAttempts: 0 } })
  })

  it('offers once across two agents of the same owner', async () => {
    const suggestions = suggestionNotes()
    const other = { ...candidate, agentPrincipal: '00000000-0000-4000-8000-d0aa05a3a29d',
      assistantId: '00000000-0000-4000-8000-93342ecaba36', roomId: '!other:atum.test' }
    let candidates = [candidate]
    const h = harness({
      suggestions,
      candidates: () => candidates,
      collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'suggestion prompt'),
      classify: vi.fn(async () => answer),
      validate: vi.fn(() => ({ result: offer, findingHashes: ['e'.repeat(64)] })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())
    candidates = [other]
    h.driver.tick()
    await vi.waitFor(() => expect(vi.mocked(h.deps.settle).mock.calls.length).toBe(2))

    expect(h.deps.classify).toHaveBeenCalledOnce()
    expect(h.deps.stagePublication).toHaveBeenCalledOnce()
    expect(vi.mocked(h.deps.settle).mock.calls[1]?.[0]).toMatchObject({ disposition: 'silent',
      usage: { modelAttempts: 0 } })
  })

  it('passes yesterday\'s admitted suggestion as a negative example', async () => {
    const suggestions = suggestionNotes()
    const yesterday = followupSweepLocalDay(midday - 86_400_000, 'Asia/Ho_Chi_Minh')!
    suggestions.write({ owner: candidate.ownerPrincipal, date: yesterday.date, at: midday - 86_400_000,
      text: 'Shall I turn the launch notes into a one-page plan?', admitted: true })
    const h = harness({
      suggestions,
      collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'suggestion prompt'),
      classify: vi.fn(async () => answer),
      validate: vi.fn(() => ({ result: offer, findingHashes: ['e'.repeat(64)] })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(vi.mocked(h.deps.prompt).mock.calls[0]?.[3]).toBe(
      'Shall I turn the launch notes into a one-page plan?')
  })

  it('lets a fresh finding win without asking the suggestion policy', async () => {
    const finding = { ...offer, evidenceIds: ['mail:abc'], text: 'Lan needs an answer. Shall I draft a reply?' }
    const h = harness({
      collect: vi.fn(async () => ({ ...snapshot(true), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'finding prompt'),
      classify: vi.fn(async () => ({ ...answer, value: finding })),
      validate: vi.fn(() => ({ result: finding, findingHashes: ['f'.repeat(64)] })),
      settle: vi.fn(async () => ({ publication: { state: 'admitted' as const } }))
    })

    h.driver.tick()
    await vi.waitFor(() => expect(h.deps.settle).toHaveBeenCalledOnce())

    expect(h.deps.suggestion).not.toHaveBeenCalled()
    expect(vi.mocked(h.deps.prompt).mock.calls[0]?.[2]).toBe('finding')
    expect(h.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'offer', findingHashes: ['f'.repeat(64)] }),
      expect.any(AbortSignal)
    )
  })

  it('stays silent without a model call when the window is closed or nothing is worthwhile', async () => {
    const closed = harness({ collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => false) })
    closed.driver.tick()
    await vi.waitFor(() => expect(closed.deps.settle).toHaveBeenCalledOnce())
    expect(closed.deps.classify).not.toHaveBeenCalled()
    expect(closed.deps.settle).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'silent',
      findingHashes: [] }), expect.any(AbortSignal))

    const declined = harness({
      collect: vi.fn(async () => ({ ...snapshot(false), capturedAt: midday })),
      suggestion: vi.fn(() => true),
      prompt: vi.fn(() => 'suggestion prompt'),
      classify: vi.fn(async () => answer),
      validate: vi.fn(() => ({ result: { profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' as const },
        findingHashes: [] }))
    })
    declined.driver.tick()
    await vi.waitFor(() => expect(declined.deps.settle).toHaveBeenCalledOnce())
    expect(declined.deps.stagePublication).not.toHaveBeenCalled()
    expect(declined.deps.settle).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'silent',
      findingHashes: [] }), expect.any(AbortSignal))
  })
})

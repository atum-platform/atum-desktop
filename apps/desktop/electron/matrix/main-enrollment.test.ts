import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment, MatrixReadiness } from '../../shared/matrix'

import { MatrixCredentialRenewal } from './credential-renewal'
import { MatrixExecutorLease } from './lease'
import {
  admitMatrixEnrollmentSetup,
  matrixEnrollmentAuthority,
  projectMatrixEnrollmentReadiness
} from './main-enrollment'
import { MatrixReadinessMonitor } from './readiness'

const identity = {
  issuer: 'https://domain.test',
  subject: 'owner',
  principal: 'owner-principal',
  userId: '@agent:test',
  deviceId: 'AGENT',
  executorId: '00000000-0000-4000-8000-75c02539218c',
  agentPrincipal: 'agent-principal',
  expiresAt: 3_600_000
}

const withdrawn: MatrixEnrollment = { state: 'withdrawn', identity: null }
const denied = { ok: false, code: 'authority_withdrawn' }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void

  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => vi.useRealTimers())

/** The callable main composition, with the real gate/watch and enrollment truth
 * overriding its last publication. Host/probe calls are observable boundaries. */
function runtime(enrollment: MatrixEnrollment, setup = vi.fn(async () => {})) {
  const custody = { enrollment }
  let published: MatrixReadiness | undefined

  const hermes = vi.fn(async () => ({ ok: true as const }))
  const ai = vi.fn(async () => ({ ok: true as const }))
  const heldLease = vi.fn(async () => ({ ok: true as const }))

  const project = () => {
    published = projectMatrixEnrollmentReadiness(custody.enrollment, readiness.current, published)

    return published
  }

  const readiness = new MatrixReadinessMonitor({
    gate: [
      { step: 'signed_in', check: async () => ({ ok: true }) },
      { step: 'assistant', check: () => admitMatrixEnrollmentSetup(() => custody.enrollment, setup) },
      { step: 'hermes', check: hermes },
      { step: 'ai', check: ai },
      { step: 'authority', check: heldLease }
    ],
    watch: [
      {
        step: 'ai',
        check: async () => {
          const authority = matrixEnrollmentAuthority(custody.enrollment)

          return authority.ok ? ai() : authority
        }
      },
      {
        step: 'authority',
        check: async () => {
          const authority = matrixEnrollmentAuthority(custody.enrollment)

          return authority.ok ? heldLease() : authority
        }
      }
    ],
    onChange: () => project(),
    random: () => 0.5
  })

  return { custody, setup, hermes, ai, heldLease, readiness, project }
}

describe('main enrollment admission', () => {
  it('never invokes setup for withdrawn custody', async () => {
    const setup = vi.fn(async () => {})

    await expect(admitMatrixEnrollmentSetup(() => withdrawn, setup)).resolves.toEqual(denied)
    expect(setup).not.toHaveBeenCalled()
    expect(withdrawn).toEqual({ state: 'withdrawn', identity: null })
  })

  it.each(['absent', 'pending', 'ready', 'expired', 'revoking'] as const)(
    'leaves ordinary %s admission to the existing setup branch',
    async state => {
      const enrollment: MatrixEnrollment = { state, identity: state === 'ready' ? identity : null }
      const setup = vi.fn(async () => {})

      await expect(admitMatrixEnrollmentSetup(() => enrollment, setup)).resolves.toEqual({ ok: true })
      expect(setup).toHaveBeenCalledTimes(1)
    }
  )

  it('checks persisted withdrawal again after asynchronous setup completes', async () => {
    let enrollment: MatrixEnrollment = { state: 'ready', identity }
    const work = deferred()
    const setup = vi.fn(() => work.promise)
    const admitted = admitMatrixEnrollmentSetup(() => enrollment, setup)

    expect(setup).toHaveBeenCalledTimes(1)
    enrollment = withdrawn
    work.resolve()
    await expect(admitted).resolves.toEqual(denied)
  })

  it('reports persisted withdrawal instead of a generic asynchronous setup failure', async () => {
    let enrollment: MatrixEnrollment = { state: 'expired', identity }
    const work = deferred()

    const admitted = admitMatrixEnrollmentSetup(
      () => enrollment,
      () => work.promise
    )

    enrollment = withdrawn
    work.reject(new Error('matrix_enrollment_denied'))
    await expect(admitted).resolves.toEqual(denied)
  })

  it('preserves an ordinary failure instead of classifying an outage as withdrawal', async () => {
    const error = new Error('matrix_enrollment_unavailable')

    await expect(
      admitMatrixEnrollmentSetup(
        () => ({ state: 'pending', identity: null }),
        async () => {
          throw error
        }
      )
    ).rejects.toBe(error)
  })
})

describe('main withdrawn readiness projection', () => {
  it.each(['pending', 'expired', 'ready'] as const)(
    'does not infer a tombstone from missing identity or lease unavailability for %s custody',
    state => {
      const current: MatrixReadiness = { phase: 'degraded', step: 'authority', code: 'platform_unavailable', since: 10 }
      const enrollment: MatrixEnrollment = { state, identity: state === 'ready' ? identity : null }

      expect(projectMatrixEnrollmentReadiness(enrollment, current, undefined, 20)).toBe(current)
    }
  )

  it('overrides an absent or stale-ready monitor without adding a retry time', () => {
    const ready: MatrixReadiness = { phase: 'ready', since: 10 }

    expect(projectMatrixEnrollmentReadiness(withdrawn, undefined, undefined, 20)).toEqual({
      phase: 'blocked',
      step: 'authority',
      code: 'authority_withdrawn',
      since: 20
    })
    expect(projectMatrixEnrollmentReadiness(withdrawn, ready, undefined, 20)).toEqual({
      phase: 'blocked',
      step: 'authority',
      code: 'authority_withdrawn',
      since: 20
    })
    expect(ready).toEqual({ phase: 'ready', since: 10 })
  })

  it('keeps its published blocked timestamp through start and recheck publications', async () => {
    const f = runtime(withdrawn)
    f.readiness.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(f.readiness.current).toMatchObject({ phase: 'blocked', code: 'authority_withdrawn' })
    expect(f.project()).toEqual({ phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: 0 })
    expect(f.setup).not.toHaveBeenCalled()
    expect(f.hermes).not.toHaveBeenCalled()
    expect(f.ai).not.toHaveBeenCalled()
    expect(f.heldLease).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    f.readiness.recheck()
    f.readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.project()).toEqual({ phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: 0 })
    expect(f.setup).not.toHaveBeenCalled()
    f.readiness.stop()
  })

  it('blocks the real gate when custody is withdrawn during setup, before later steps run', async () => {
    const work = deferred()

    const f = runtime(
      { state: 'ready', identity },
      vi.fn(() => work.promise)
    )

    f.readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.setup).toHaveBeenCalledTimes(1)
    f.custody.enrollment = withdrawn
    work.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(f.project()).toMatchObject({ phase: 'blocked', step: 'authority', code: 'authority_withdrawn' })
    expect(f.hermes).not.toHaveBeenCalled()
    expect(f.ai).not.toHaveBeenCalled()
    expect(f.heldLease).not.toHaveBeenCalled()
    f.readiness.stop()
  })

  it('publishes persisted lease refusal immediately, even while the watch still says ready', async () => {
    const f = runtime({ state: 'ready', identity })
    f.readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.project()?.phase).toBe('ready')
    f.ai.mockClear()
    f.heldLease.mockClear()
    const publications: MatrixReadiness[] = []

    const lease = new MatrixExecutorLease({
      request: async () => {
        // The account persists this state before the lease refusal reaches main.
        f.custody.enrollment = withdrawn
        throw new Error('matrix_lease_denied')
      },
      onChange: status => {
        if (status.state === 'unavailable' && status.reason === 'authority_withdrawn') {
          f.readiness.recheck()
          publications.push(f.project()!)
        }
      },
      random: () => 0.5
    })

    lease.start(identity.executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
    expect(f.readiness.current.phase).toBe('ready')
    expect(publications).toEqual([{ phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: 0 }])
    expect(f.ai).not.toHaveBeenCalled()
    expect(f.heldLease).not.toHaveBeenCalled()
    f.readiness.recheck()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.readiness.current.phase).toBe('degraded')
    expect(f.project()?.phase).toBe('blocked')
    await lease.stop()
    f.readiness.stop()
  })

  it('leaves another successfully admitted agent unchanged', async () => {
    const refused = runtime(withdrawn)
    const healthy = runtime({ state: 'ready', identity: { ...identity, agentPrincipal: 'other-agent' } })
    refused.readiness.start()
    healthy.readiness.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(refused.project()?.code).toBe('authority_withdrawn')
    expect(healthy.project()).toEqual(healthy.readiness.current)
    expect(healthy.project()?.phase).toBe('ready')
    expect(healthy.setup).toHaveBeenCalledTimes(1)
    expect(healthy.hermes).toHaveBeenCalledTimes(1)
    expect(healthy.ai).toHaveBeenCalledTimes(1)
    expect(healthy.heldLease).toHaveBeenCalledTimes(1)

    refused.readiness.stop()
    healthy.readiness.stop()
  })

  it('lets existing credential renewal stop scheduling once custody no longer supplies expiry', async () => {
    let enrollment: MatrixEnrollment = { state: 'ready', identity }

    const renew = vi.fn(async () => {
      enrollment = withdrawn
      throw new Error('matrix_enrollment_denied')
    })

    const renewal = new MatrixCredentialRenewal({
      label: 'assistant',
      expiresAt: () => (enrollment.state === 'ready' ? enrollment.identity?.expiresAt : undefined),
      renew,
      random: () => 0,
      log: () => {}
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(1_800_000)
    expect(renew).toHaveBeenCalledTimes(1)
    renewal.resume()
    expect(renewal.expedite()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(enrollment).toEqual(withdrawn)
    renewal.stop()
  })
})

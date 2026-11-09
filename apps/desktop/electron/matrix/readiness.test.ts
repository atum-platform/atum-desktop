import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixReadiness, MatrixReadinessStep } from '../../shared/matrix'

import {
  MATRIX_READINESS_TIMINGS,
  matrixCloudOnlyReadiness,
  matrixLaunchExclusionLine,
  type MatrixReadinessCheck,
  MatrixReadinessMonitor,
  restartMatrixReadinessAfterExpiry
} from './readiness'

const ok: MatrixReadinessCheck = { ok: true }
const fail = (code: string): MatrixReadinessCheck => ({ ok: false, code })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function monitor(
  gate: Partial<Record<MatrixReadinessStep, () => MatrixReadinessCheck>>,
  watch: () => MatrixReadinessCheck = () => ok
) {
  const changes: MatrixReadiness[] = []
  const calls: Record<string, number> = {}
  const steps: MatrixReadinessStep[] = ['signed_in', 'assistant', 'hermes', 'ai', 'authority']

  const readiness = new MatrixReadinessMonitor({
    gate: steps.map(step => ({
      step,
      check: async () => {
        calls[step] = (calls[step] ?? 0) + 1

        return (gate[step] ?? (() => ok))()
      }
    })),
    watch: [
      {
        step: 'ai',
        check: async () => {
          calls.watch = (calls.watch ?? 0) + 1

          return watch()
        }
      }
    ],
    onChange: value => changes.push(value),
    random: () => 0.5
  })

  return { readiness, changes, calls }
}

it('stops at the first failing step and blocks with its code', async () => {
  const { readiness, calls } = monitor({ ai: () => fail('ai_unavailable') })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)

  expect(readiness.current).toMatchObject({ phase: 'blocked', step: 'ai', code: 'ai_unavailable' })
  expect(calls.authority).toBeUndefined()
  expect(calls.hermes).toBe(1)
})

it('opens an exhausted wallet in degraded state after all remaining gates pass', async () => {
  const { readiness, calls } = monitor({ ai: () => fail('out_of_protons') })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current).toMatchObject({ phase: 'degraded', step: 'ai', code: 'out_of_protons' })
  expect(calls.authority).toBe(1)
  await vi.advanceTimersByTimeAsync(MATRIX_READINESS_TIMINGS.watchMs * 2 + 1000)
  expect(readiness.current.phase).toBe('ready')
  readiness.stop()
})

it('never lets exhausted credit bypass a failed authority gate or another failing step', async () => {
  const { readiness } = monitor({ ai: () => fail('out_of_protons'), authority: () => fail('identity_changed') })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current).toMatchObject({ phase: 'blocked', step: 'authority', code: 'identity_changed' })
  readiness.stop()
  const { readiness: other } = monitor({ hermes: () => fail('out_of_protons') })
  other.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(other.current).toMatchObject({ phase: 'blocked', step: 'hermes' })
  other.stop()
})

it.each(['signed_in', 'assistant', 'hermes', 'ai', 'authority'] as const)('blocks on %s with that step', async step => {
  const { readiness } = monitor({ [step]: () => fail(`${step}_code`) })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current).toMatchObject({ phase: 'blocked', step, code: `${step}_code` })
})

it('opens only when every step passes, naming each step while it runs', async () => {
  const { readiness, changes } = monitor({})
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)

  expect(readiness.current.phase).toBe('ready')
  expect(changes.filter(change => change.phase === 'starting').map(change => change.step)).toEqual([
    'signed_in',
    'assistant',
    'hermes',
    'ai',
    'authority'
  ])
})

it('retries a blocked gate with backoff and never faster than the schedule', async () => {
  let failing = true
  const { readiness, calls } = monitor({ ai: () => (failing ? fail('ai_unavailable') : ok) })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.ai).toBe(1)

  // 5, 10, 30, 60, 60 s: five retries in 165 s, none sooner.
  for (const [wait, expected] of [
    [4_999, 1],
    [1, 2],
    [10_000, 3],
    [30_000, 4],
    [60_000, 5],
    [60_000, 6]
  ] as const) {
    await vi.advanceTimersByTimeAsync(wait)
    expect(calls.ai).toBe(expected)
  }

  failing = false
  await vi.advanceTimersByTimeAsync(MATRIX_READINESS_TIMINGS.backoffMs.at(-1)!)
  expect(readiness.current.phase).toBe('ready')
})

// 2026-10-06 check: a retry used to show `starting` from the first step and then block again with
// a fresh `since`, so the window's grace (agent-attention.ts) restarted on every retry and a
// lasting failure never asked for the person, while an unknown one flickered.
it('keeps a retried block on screen, with its first since, until the gate gets past that step', async () => {
  let failing = true
  const { readiness, changes } = monitor({ hermes: () => (failing ? fail('hermes_unavailable') : ok) })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  const first = readiness.current
  expect(first).toMatchObject({ phase: 'blocked', step: 'hermes', code: 'hermes_unavailable' })
  const seen = changes.length

  // Three retries (5, 10, 30 s), all failing: the window sees no change at all.
  await vi.advanceTimersByTimeAsync(45_000)
  expect(changes.length).toBe(seen)
  expect(readiness.current).toEqual(first)

  // Past its step, the steps after it are named again, then it opens.
  failing = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(readiness.current.phase).toBe('ready')
  expect(changes.slice(seen).map(change => (change.phase === 'starting' ? change.step : change.phase))).toEqual([
    'ai',
    'authority',
    'ready'
  ])
})

it('shows an earlier step that fails on a retry as a new block, from then', async () => {
  let earlier = false

  const { readiness } = monitor({
    signed_in: () => (earlier ? fail('offline') : ok),
    hermes: () => fail('hermes_unavailable')
  })

  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  const first = readiness.current

  earlier = true
  await vi.advanceTimersByTimeAsync(5_000)
  expect(readiness.current).toMatchObject({ phase: 'blocked', step: 'signed_in', code: 'offline' })
  expect(readiness.current.since).toBeGreaterThan(first.since)
})

it('jitters the backoff within ±20%', async () => {
  const early = new MatrixReadinessMonitor({
    gate: [{ step: 'ai', check: async () => fail('x') }],
    watch: [],
    onChange: () => {},
    random: () => 0
  })

  const check = vi.fn(async () => fail('x'))

  const late = new MatrixReadinessMonitor({
    gate: [{ step: 'ai', check }],
    watch: [],
    onChange: () => {},
    random: () => 1
  })

  early.start()
  late.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5_999)
  expect(check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(check).toHaveBeenCalledTimes(2)
  early.stop()
  late.stop()
})

it('Try again re-runs a blocked gate at once', async () => {
  let failing = true
  const { readiness } = monitor({ hermes: () => (failing ? fail('hermes_unavailable') : ok) })
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('blocked')

  failing = false
  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('ready')
})

it('never retries on a timer a block only an event can change, and runs again on that event', async () => {
  let key = false
  const check = vi.fn(async () => (key ? ok : fail('recovery_required')))
  const lines: string[] = []

  const readiness = new MatrixReadinessMonitor({
    gate: [{ step: 'assistant', check }],
    watch: [],
    waitsForEvent: new Set(['recovery_required', 'agent_reconnect_required', 'device_replaced']),
    onChange: () => {},
    log: line => lines.push(line),
    random: () => 0.5
  })

  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current).toMatchObject({ phase: 'blocked', code: 'recovery_required' })

  // An hour with nothing changed: one check, one line (the Mac mini logged 500).
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(check).toHaveBeenCalledTimes(1)
  expect(lines.filter(line => line.includes('code=recovery_required'))).toHaveLength(1)

  // The key arrived (typed, approved, or kept and unlocked): main starts the gate again.
  key = true
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('ready')
  readiness.stop()
})

async function readyMonitor(results: MatrixReadinessCheck[]) {
  const queue = [...results]
  const m = monitor({}, () => queue.shift() ?? ok)
  m.readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(m.readiness.current.phase).toBe('ready')

  return m
}

it('never degrades on a flapping check (fail, ok, fail, ok)', async () => {
  const { readiness, changes } = await readyMonitor([fail('ai_unavailable'), ok, fail('ai_unavailable'), ok])

  for (let index = 0; index < 4; index++) {
    readiness.recheck()
    await vi.advanceTimersByTimeAsync(0)
  }

  expect(changes.some(change => change.phase === 'degraded')).toBe(false)
  expect(readiness.current.phase).toBe('ready')
})

it('degrades after two failures and recovers after two successes', async () => {
  const { readiness } = await readyMonitor([fail('offline'), fail('offline'), ok, ok])
  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('ready')
  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current).toMatchObject({ phase: 'degraded', step: 'ai', code: 'offline' })
  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('degraded')
  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('ready')
})

it('watches every 30 s ± 5 s while ready and backs off while degraded', async () => {
  let failing = false
  const { readiness, calls } = monitor({}, () => (failing ? fail('ai_unavailable') : ok))
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.watch).toBeUndefined()

  await vi.advanceTimersByTimeAsync(30_000)
  expect(calls.watch).toBe(1)

  failing = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(calls.watch).toBe(2)
  // The first failure re-checks on the backoff (5 s), and the second degrades.
  await vi.advanceTimersByTimeAsync(5_000)
  expect(calls.watch).toBe(3)
  expect(readiness.current.phase).toBe('degraded')
  // Degraded re-checks back off: 5, 10, 30 s.
  await vi.advanceTimersByTimeAsync(5_000)
  expect(calls.watch).toBe(4)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(calls.watch).toBe(5)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(calls.watch).toBe(5)
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.watch).toBe(6)
})

it('retries a non-blocking watch failure with backoff without pausing a ready chat', async () => {
  let calls = 0

  const readiness = new MatrixReadinessMonitor({
    gate: [{ step: 'signed_in', check: async () => ok }],
    watch: [
      {
        step: 'assistant',
        nonBlocking: true,
        check: async () => {
          calls += 1

          return calls === 1 ? fail('agent_roster_unavailable') : ok
        }
      }
    ],
    onChange: () => {},
    random: () => 0.5
  })

  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readiness.current.phase).toBe('ready')

  readiness.recheck()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(1)
  expect(readiness.current.phase).toBe('ready')

  await vi.advanceTimersByTimeAsync(4_999)
  expect(calls).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(calls).toBe(2)
  expect(readiness.current.phase).toBe('ready')
})

it('keeps repeated optional failures non-blocking and resets retry delay after recovery', async () => {
  let failing = true
  const check = vi.fn(async () => (failing ? fail('agent_roster_unavailable') : ok))
  const changes: MatrixReadiness[] = []

  const readiness = new MatrixReadinessMonitor({
    gate: [{ step: 'signed_in', check: async () => ok }],
    watch: [{ step: 'assistant', nonBlocking: true, check }],
    onChange: value => changes.push(value),
    random: () => 0.5
  })

  readiness.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(check).toHaveBeenCalledTimes(2)
  expect(changes.some(value => value.phase === 'degraded')).toBe(false)
  failing = false
  await vi.advanceTimersByTimeAsync(10_000)
  expect(check).toHaveBeenCalledTimes(3)
  failing = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(check).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(check).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(check).toHaveBeenCalledTimes(5)
  expect(readiness.current.phase).toBe('ready')
  readiness.stop()
})

it('stops cleanly: nothing runs after sign-out', async () => {
  const { readiness, calls } = monitor({})
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  readiness.stop()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(calls.watch).toBeUndefined()
  expect(readiness.current.phase).toBe('starting')
})

it('re-gates after short credential expiry only after the previous executor has stopped', async () => {
  const { readiness, calls } = monitor({})
  readiness.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.assistant).toBe(1)
  let release!: () => void

  const stopped = new Promise<void>(resolve => {
    release = resolve
  })

  let resumed: Promise<void> | undefined
  setTimeout(() => {
    resumed = restartMatrixReadinessAfterExpiry(
      stopped,
      () => true,
      () => readiness.start()
    )
  }, 100)
  await vi.advanceTimersByTimeAsync(100)
  expect(calls.assistant).toBe(1)
  release()
  await resumed
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.assistant).toBe(2)
  expect(readiness.current.phase).toBe('ready')
  readiness.stop()
})

it('does not revive a signed-out/retired/replaced account while executor shutdown was pending', async () => {
  let current = true
  let release!: () => void
  const restart = vi.fn()

  const pending = restartMatrixReadinessAfterExpiry(
    new Promise<void>(resolve => {
      release = resolve
    }),
    () => current,
    restart
  )

  current = false
  release()
  await pending
  expect(restart).not.toHaveBeenCalled()
})

it('cannot re-enroll if the old executor failed to stop', async () => {
  const restart = vi.fn()
  await expect(
    restartMatrixReadinessAfterExpiry(Promise.reject(new Error('stop failed')), () => true, restart)
  ).rejects.toThrow('stop failed')
  expect(restart).not.toHaveBeenCalled()
})

// A 429 from enrollment (platform 0150's per-owner bounds) waits for its Retry-After instead
// of showing a failure (launch checklist G1-13's follow-up; stream RT, slice 2).
describe('a step asked to wait', () => {
  it('publishes a moved native deadline without changing the retry authority', async () => {
    const changes: MatrixReadiness[] = []
    const check = vi.fn(async () => ({ ok: false as const, code: 'rate_limited', retryAt: Date.now() + 60_000 }))

    const readiness = new MatrixReadinessMonitor({
      gate: [{ step: 'assistant', check }],
      watch: [],
      onChange: value => changes.push(value),
      random: () => 0.5
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = readiness.current.retryAt
    await vi.advanceTimersByTimeAsync(60_000)
    const next = readiness.current.retryAt

    expect(next).toBe(Number(first) + 60_000)
    expect(changes.filter(value => value.code === 'rate_limited').map(value => value.retryAt)).toEqual([first, next])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(check).toHaveBeenCalledTimes(2)
    readiness.stop()
  })

  it('stays starting on its step, with the code, and runs again only when asked', async () => {
    let waiting = true
    const log: string[] = []
    const changes: MatrixReadiness[] = []
    const checks = { assistant: 0, hermes: 0 }

    const readiness = new MatrixReadinessMonitor({
      gate: [
        {
          step: 'assistant',
          check: async () => {
            checks.assistant += 1

            return waiting ? { ok: false, code: 'rate_limited', retryAt: Date.now() + 90_000 } : ok
          }
        },
        { step: 'hermes', check: async () => ((checks.hermes += 1), ok) }
      ],
      watch: [],
      onChange: value => changes.push(value),
      log: line => log.push(line),
      random: () => 0.5
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(readiness.current).toMatchObject({ phase: 'starting', step: 'assistant', code: 'rate_limited' })
    expect(readiness.current.retryAt).toBe(Date.now() + 90_000)
    expect(changes.some(change => change.phase === 'blocked')).toBe(false)
    expect(checks).toEqual({ assistant: 1, hermes: 0 })
    expect(log.at(-1)).toMatch(
      /^\[Matrix\] readiness gate step=assistant ok=false code=rate_limited ms=\d+ start=cold wait=90000$/
    )

    // Not at the gate's own 5 s backoff: at Retry-After.
    await vi.advanceTimersByTimeAsync(89_999)
    expect(checks.assistant).toBe(1)

    waiting = false
    await vi.advanceTimersByTimeAsync(1)
    expect(checks).toEqual({ assistant: 2, hermes: 1 })
    expect(readiness.current.phase).toBe('ready')
    expect(readiness.current.retryAt).toBeUndefined()
    readiness.stop()
  })

  it('spends no backoff step while waiting: a later failure starts at the first', async () => {
    let result: MatrixReadinessCheck = { ok: false, code: 'rate_limited', retryAt: Date.now() + 60_000 }
    const check = vi.fn(async () => result)

    const readiness = new MatrixReadinessMonitor({
      gate: [{ step: 'assistant', check }],
      watch: [],
      onChange: () => {},
      random: () => 0.5
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    result = fail('setup_failed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(readiness.current).toMatchObject({ phase: 'blocked', code: 'setup_failed' })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(check).toHaveBeenCalledTimes(3)
    readiness.stop()
  })

  it('waits at least a second, even for a time already past', async () => {
    const check = vi.fn(async (): Promise<MatrixReadinessCheck> => ({ ok: false, code: 'rate_limited', retryAt: 0 }))

    const readiness = new MatrixReadinessMonitor({
      gate: [{ step: 'assistant', check }],
      watch: [],
      onChange: () => {}
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(2)
    readiness.stop()
  })

  it('Try again checks at once, and the step decides whether the wait still holds', async () => {
    const check = vi.fn(
      async (): Promise<MatrixReadinessCheck> => ({ ok: false, code: 'rate_limited', retryAt: Date.now() + 600_000 })
    )

    const readiness = new MatrixReadinessMonitor({
      gate: [{ step: 'assistant', check }],
      watch: [],
      onChange: () => {}
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(0)
    readiness.recheck()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(2)
    expect(readiness.current).toMatchObject({ phase: 'starting', code: 'rate_limited' })
    readiness.stop()
  })
})

// Any assistant stop is excluded from launch; main says so once, by the agent's prefix and closed
// codes, not on each retry. The caller intentionally has no primary exception.
describe('an agent that stops its gate', () => {
  it('is named once by its 8-character prefix and closed codes, however often the gate retries', async () => {
    const { readiness, changes } = monitor({ assistant: () => fail('agent_initializing') })
    readiness.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    // Main writes a line when it differs from the last one it wrote (main.ts logLaunchExclusion).
    const written: string[] = []
    let last: string | undefined

    for (const change of changes) {
      const line = matrixLaunchExclusionLine('00000000-0000-4000-8000-62d962e89876', change)

      if (line && line !== last) {
        written.push(line)
      }

      last = line
    }

    expect(written).toEqual(['[Matrix] launch gate excludes agent 00000000 step=assistant code=agent_initializing'])
    readiness.stop()
  })

  it('is not named while it still holds the launch, or once it is past the gate', () => {
    const at = (value: Omit<MatrixReadiness, 'since'>) => matrixLaunchExclusionLine('moon', { ...value, since: 1 })

    expect(at({ phase: 'starting', step: 'hermes' })).toBeUndefined()
    expect(at({ phase: 'ready' })).toBeUndefined()
    expect(at({ phase: 'degraded', step: 'ai', code: 'ai_unavailable' })).toBeUndefined()
    // Waiting as the platform asked holds nothing either.
    expect(at({ phase: 'starting', step: 'assistant', code: 'rate_limited', retryAt: 60_000 })).toBe(
      '[Matrix] launch gate excludes agent moon step=assistant code=rate_limited'
    )
  })
})

// A cloud-only agent (the roster's default on a fresh account, S1) does its work in the cloud:
// its local Hermes, Atum model and answering lease are deliberately absent here. The gate used to
// run those real checks and publish blocked/hermes_unavailable while the renderer masked it.
describe('a cloud-only agent’s readiness', () => {
  const probes = (calls: string[]) => [
    {
      step: 'signed_in' as const,
      check: async () => {
        calls.push('signed_in')

        return ok
      }
    },
    {
      step: 'hermes' as const,
      check: async () => {
        calls.push('hermes')

        return fail('hermes_unavailable')
      }
    },
    {
      step: 'ai' as const,
      check: async () => {
        calls.push('ai')

        return fail('ai_unavailable')
      }
    },
    {
      step: 'authority' as const,
      check: async () => {
        calls.push('authority')

        return fail('platform_unavailable')
      }
    }
  ]

  it('passes hermes, ai and authority without running this Mac’s writers, while signed_in still runs', async () => {
    const calls: string[] = []
    const ready = matrixCloudOnlyReadiness(probes(calls), () => true)
    const signal = new AbortController().signal

    for (const probe of ready) {
      expect(await probe.check(signal)).toEqual(ok)
    }

    expect(calls).toEqual(['signed_in'])
  })

  it('keeps every real local check for a Mac-run or policy-backed standby agent', async () => {
    const calls: string[] = []
    const local = matrixCloudOnlyReadiness(probes(calls), () => false)
    const signal = new AbortController().signal

    await expect(local[1]!.check(signal)).resolves.toEqual(fail('hermes_unavailable'))
    await expect(local[2]!.check(signal)).resolves.toEqual(fail('ai_unavailable'))
    await expect(local[3]!.check(signal)).resolves.toEqual(fail('platform_unavailable'))
    await expect(local[0]!.check(signal)).resolves.toEqual(ok)
    expect(calls).toEqual(['hermes', 'ai', 'authority', 'signed_in'])
  })

  it('never holds a nonBlocking probe, even when the agent is cloud-only', async () => {
    const check = vi.fn(async (): Promise<MatrixReadinessCheck> => fail('agent_roster_unavailable'))
    const [probe] = matrixCloudOnlyReadiness([{ step: 'assistant', nonBlocking: true, check }], () => true)

    await expect(probe!.check(new AbortController().signal)).resolves.toEqual(fail('agent_roster_unavailable'))
    expect(check).toHaveBeenCalledOnce()
  })

  it('lets the whole gate read ready while every local writer fails', async () => {
    const changes: MatrixReadiness[] = []
    const calls: string[] = []

    const readiness = new MatrixReadinessMonitor({
      gate: matrixCloudOnlyReadiness(probes(calls), () => true),
      watch: matrixCloudOnlyReadiness(probes(calls), () => true),
      onChange: value => changes.push(value),
      random: () => 0.5
    })

    readiness.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(readiness.current.phase).toBe('ready')
    expect(calls).toEqual(['signed_in'])
    readiness.stop()
  })
})

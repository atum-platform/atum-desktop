/**
 * Whether an agent is at rest: the app's own facts, then Hermes's word that the review of the last answer has finished
 * (`runtime.quiesce` with no wait). Asking must disturb nothing and wait for nothing.
 */
import { describe, expect, it } from 'vitest'

import { agentAtRest, agentHoldWrites, hermesReviewFinished, type HermesRpc, REVIEW_PROBE_TIMEOUT_MS } from './at-rest'

class FakeHermes implements HermesRpc {
  readonly asked: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = []
  /** What Hermes answers; a failure is thrown instead. */
  answer: unknown = { drained: true, pending: [] }
  failure: Error | null = null
  /** Runs while Hermes is answering (a turn begins, say). */
  during?: () => void

  async request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    this.asked.push({ method, params, timeoutMs })
    this.during?.()

    if (this.failure) {
      throw this.failure
    }

    return this.answer as T
  }
}

describe("Hermes's word on its review of the last answer", () => {
  it('asks the flush hook Hermes has, without giving it any time to wait, and is told it has finished', async () => {
    const hermes = new FakeHermes()

    await expect(hermesReviewFinished(hermes)).resolves.toBe(true)

    // `timeout_ms: 0` joins nothing: it is a question, not a wait. And the answer is not waited for for ever either.
    expect(hermes.asked).toEqual([{ method: 'runtime.quiesce', params: { timeout_ms: 0 }, timeoutMs: REVIEW_PROBE_TIMEOUT_MS }])
    expect(REVIEW_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('is told it has not when the review is still writing', async () => {
    const hermes = new FakeHermes()
    hermes.answer = { drained: false, pending: ['bg-review'] }

    await expect(hermesReviewFinished(hermes)).resolves.toBe(false)
  })

  it.each([null, undefined, {}, { drained: 'yes' }, { drained: 1 }, { pending: [] }, 'drained', []])('takes nothing but an exact "drained: true" for a yes (%j)', async answer => {
    const hermes = new FakeHermes()
    hermes.answer = answer

    await expect(hermesReviewFinished(hermes)).resolves.toBe(false)
  })

  it('takes an unanswered, refused or unknown question for a no, and says so', async () => {
    const lines: string[] = []

    for (const failure of ['request timed out after 5s: runtime.quiesce', 'unknown method: runtime.quiesce', 'gateway not connected']) {
      const hermes = new FakeHermes()
      hermes.failure = new Error(failure)

      await expect(hermesReviewFinished(hermes, line => lines.push(line))).resolves.toBe(false)
    }

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('could not ask Hermes whether its review has finished')
    expect(lines.join('\n')).toContain('unknown method: runtime.quiesce')
  })
})

describe('an agent at rest', () => {
  function rig(resting: boolean | (() => boolean) = true) {
    const hermes = new FakeHermes()
    const state = { resting, up: true }
    const lines: string[] = []

    const facts = {
      resting: () => (typeof state.resting === 'function' ? state.resting() : state.resting),
      hermes: () => (state.up ? hermes : undefined),
      log: (line: string) => lines.push(line)
    }

    return { hermes, state, lines, ask: () => agentAtRest(facts) }
  }

  it('is at rest when the app sees nothing going on and Hermes has finished its review', async () => {
    const { hermes, ask } = rig()

    await expect(ask()).resolves.toBe(true)
    expect(hermes.asked).toHaveLength(1)
  })

  it('does not even ask Hermes while a turn, a task or an operation is going on', async () => {
    const { hermes, ask } = rig(false)

    await expect(ask()).resolves.toBe(false)
    expect(hermes.asked).toEqual([])
  })

  it('has nothing to ask when no Hermes is running: nothing then writes the home', async () => {
    const { hermes, state, ask } = rig()
    state.up = false

    await expect(ask()).resolves.toBe(true)
    expect(hermes.asked).toEqual([])
  })

  it('is not at rest while the review is writing', async () => {
    const { hermes, ask } = rig()
    hermes.answer = { drained: false, pending: ['bg-review'] }

    await expect(ask()).resolves.toBe(false)
  })

  it('is not at rest when Hermes cannot be asked', async () => {
    const { hermes, ask, lines } = rig()
    hermes.failure = new Error('request timed out after 5s: runtime.quiesce')

    await expect(ask()).resolves.toBe(false)
    expect(lines).toHaveLength(1)
  })

  it('is not at rest when a turn begins while Hermes is answering: the answer is old by then', async () => {
    let turn = false
    const { hermes, ask } = rig(() => !turn)

    hermes.during = () => {
      turn = true
    }

    await expect(ask()).resolves.toBe(false)
  })
})

describe('holding the writers still for a snapshot', () => {
  /** A rig with the agent's turn lock modelled as a real one: taken and let go, and counted. */
  function rig(options: { lockFree?: boolean; resting?: boolean | (() => boolean) } = {}) {
    const hermes = new FakeHermes()
    const state = { lockFree: options.lockFree ?? true, resting: options.resting ?? true, up: true, held: 0, letGo: 0 }
    const lines: string[] = []
    const asked: boolean[] = []

    const facts = {
      lock: () => {
        if (!state.lockFree) {
          return null
        }

        state.lockFree = false
        state.held += 1
        let once = false

        return () => {
          if (!once) {
            once = true
            state.letGo += 1
            state.lockFree = true
          }
        }
      },
      resting: () => {
        // What the app's facts say, asked with the lock held: it must be held by then.
        asked.push(!state.lockFree)

        return typeof state.resting === 'function' ? state.resting() : state.resting
      },
      hermes: () => (state.up ? hermes : undefined),
      log: (line: string) => lines.push(line)
    }

    return { hermes, state, lines, asked, hold: () => agentHoldWrites(facts) }
  }

  it('holds the writers: the lock is taken, the app’s facts and Hermes are asked with it held, and the release lets it go', async () => {
    const { hermes, state, asked, hold } = rig()
    const release = await hold()

    expect(release).toBeTypeOf('function')
    expect(state).toMatchObject({ lockFree: false, held: 1, letGo: 0 })
    expect(hermes.asked).toHaveLength(1)
    // Before and after Hermes answers, each time with the lock already ours: nothing could have begun in between.
    expect(asked).toEqual([true, true])
    release!()
    expect(state).toMatchObject({ lockFree: true, letGo: 1 })
    release!()
    expect(state.letGo).toBe(1)
  })

  it('is refused at once, without asking anything, while a turn holds or awaits the lock', async () => {
    const { hermes, state, asked, hold } = rig({ lockFree: false })

    await expect(hold()).resolves.toBeNull()
    expect(hermes.asked).toEqual([])
    expect(asked).toEqual([])
    // It took nothing, so it let nothing go: the turn's hold is untouched.
    expect(state).toMatchObject({ lockFree: false, held: 0, letGo: 0 })
  })

  it.each([
    ['the app sees something of the agent’s at work', { resting: false }, 0],
    ['the review of the last answer is still writing', { drained: false }, 1],
    ['Hermes cannot be asked', { failure: true }, 1]
  ])('is refused, and lets the lock go, when %s', async (_label, fault, hermesAsks) => {
    const { hermes, state, hold } = rig({ resting: !('resting' in fault) })

    if ('drained' in fault) {
      hermes.answer = { drained: false, pending: ['bg-review'] }
    }

    if ('failure' in fault) {
      hermes.failure = new Error('request timed out after 5s: runtime.quiesce')
    }

    await expect(hold()).resolves.toBeNull()
    expect(hermes.asked).toHaveLength(hermesAsks)
    expect(state).toMatchObject({ lockFree: true, held: 1, letGo: 1 })
  })

  it('is refused, and lets the lock go, when something that does not take the lock begins while Hermes answers', async () => {
    let operation = false
    const { hermes, state, hold } = rig({ resting: () => !operation })

    hermes.during = () => {
      operation = true
    }

    await expect(hold()).resolves.toBeNull()
    expect(state).toMatchObject({ lockFree: true, held: 1, letGo: 1 })
  })

  it('has nothing to ask when no Hermes is running, and still holds the lock for the snapshot', async () => {
    const { hermes, state, hold } = rig()
    state.up = false
    const release = await hold()

    expect(release).toBeTypeOf('function')
    expect(hermes.asked).toEqual([])
    expect(state).toMatchObject({ lockFree: false, held: 1 })
    release!()
  })

  it('lets the lock go and rethrows when the facts themselves fail: a held lock is never leaked', async () => {
    const { state, hold } = rig({
      resting: () => {
        throw new Error('facts_failed')
      }
    })

    await expect(hold()).rejects.toThrow('facts_failed')
    expect(state).toMatchObject({ lockFree: true, held: 1, letGo: 1 })
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { EncryptedStore } from '../encrypted-store'

import {
  matrixAgentAtRest,
  matrixAgentQuiet,
  MatrixAgentRuntime,
  matrixBackendRestartable,
  matrixMissingTickerRestartable,
  matrixTurnOwnsHeldLease,
  matrixUnheldTickerRestartable
} from './agent-runtime'
import { applyMatrixJobsHold, MatrixCronHolds, matrixJobsTickerMissing, reconcileMatrixJobsHold } from './cron-hold'
import { MatrixHermesExecutor } from './hermes-executor'

const idle = { busy: false, closing: false }

it('binds an admitted room turn to the exact held lease session', () => {
  const current = new AbortController()
  const successor = new AbortController()
  const turn = { roomId: '!room:test', leaseSignal: current.signal }
  expect(matrixTurnOwnsHeldLease(turn, { signal: current.signal })).toBe(true)
  expect(matrixTurnOwnsHeldLease(turn, { signal: successor.signal })).toBe(false)
  expect(matrixTurnOwnsHeldLease({ leaseSignal: current.signal }, { signal: current.signal })).toBe(false)
  current.abort()
  expect(matrixTurnOwnsHeldLease(turn, { signal: current.signal })).toBe(false)
})

/** An agent with a backend that is running (never actually opened here). */
function running() {
  const agent = new MatrixAgentRuntime('agent')
  agent.executor = new MatrixHermesExecutor(() => new Promise(() => {}), {} as EncryptedStore)

  return agent
}

it('holds a running backend while a plan sign-in waits, and lets the restart that waited run once it ends', () => {
  const agent = running()
  expect(agent.holdsSignIn).toBe(false)
  expect(matrixBackendRestartable(agent, idle)).toBe(true)

  // The person is approving a ChatGPT sign-in on this backend (pages-providers.ts signingIn).
  agent.signIns = 1
  expect(agent.holdsSignIn).toBe(true)
  // A new jobs room or a Google tools change waits (main's refreshHermesHomeRoom/refreshGoogleTools).
  expect(matrixBackendRestartable(agent, idle)).toBe(false)

  agent.signIns = 0
  expect(agent.holdsSignIn).toBe(false)
  expect(matrixBackendRestartable(agent, idle)).toBe(true)
})

it('holds nothing on a backend that has already exited, so replacing it is never held', async () => {
  const agent = running()
  agent.signIns = 1
  await agent.executor!.close()

  expect(agent.executor!.usable).toBe(false)
  expect(agent.holdsSignIn).toBe(false)
  // Nothing running for an optional restart to stop either.
  expect(matrixBackendRestartable(agent, idle)).toBe(false)
})

it('restarts only an idle backend', () => {
  const busy: Array<[string, (agent: MatrixAgentRuntime) => { busy: boolean; closing: boolean }]> = [
    [
      'starting',
      agent => {
        agent.starting = Promise.resolve(true)

        return idle
      }
    ],
    [
      'a turn or check',
      agent => {
        agent.invocation = { abort: new AbortController(), pending: Promise.resolve() }

        return idle
      }
    ],
    [
      "the agent's own operation",
      agent => {
        agent.operation = true

        return idle
      }
    ],
    ['an account-wide operation', () => ({ busy: true, closing: false })],
    ['quitting', () => ({ busy: false, closing: true })]
  ]

  for (const [label, make] of busy) {
    const agent = running()
    const app = make(agent)
    expect(matrixBackendRestartable(agent, app), label).toBe(false)
  }

  expect(matrixBackendRestartable(new MatrixAgentRuntime('agent'), idle)).toBe(false)
})

describe('an agent at rest, for the checkpoint cadence', () => {
  const calm = { busy: false, closing: false, conversationPending: false }

  it('is at rest when nothing of its own is going on, whether or not a backend is running', () => {
    expect(matrixAgentAtRest(new MatrixAgentRuntime('agent'), calm)).toBe(true)
    expect(matrixAgentAtRest(running(), calm)).toBe(true)
  })

  it('is at rest with a plan sign-in being approved on its backend: a capture does not touch the backend', () => {
    const agent = running()
    agent.signIns = 1

    expect(agent.holdsSignIn).toBe(true)
    // An optional restart waits for the sign-in; a capture beside the backend has nothing to wait for.
    expect(matrixBackendRestartable(agent, idle)).toBe(false)
    expect(matrixAgentAtRest(agent, calm)).toBe(true)
  })

  it('is not at rest for anything of its own that could write its home', () => {
    const blockers: Array<[string, (agent: MatrixAgentRuntime) => void]> = [
      ['a turn', agent => void (agent.invocation = { abort: new AbortController(), pending: Promise.resolve() })],
      ['a start', agent => void (agent.starting = Promise.resolve(true))],
      ["the agent's own operation", agent => void (agent.operation = true)],
      ['a task waiting for the lease', agent => void (agent.backgroundDemand = 1)],
      ['a group message waiting for the lease', agent => void (agent.groupDemand = 1)],
      ['a check-in waiting for the lease', agent => void (agent.checkInDemand = 1)],
      ['a local question running', agent => void (agent.localTurns = { executionPending: true } as never)],
      ['the turn lock held', agent => void agent.lock.acquire('!room:test', 'watch')],
      [
        'a turn waiting for the turn lock',
        agent => {
          void agent.lock.acquire('!room:test', 'watch')
          void agent.lock.acquire('!room:test', 'local')
        }
      ],
      ['an agent that is closed', agent => void (agent.closed = true)]
    ]

    for (const [label, make] of blockers) {
      const agent = running()
      expect(matrixAgentAtRest(agent, calm), `${label} (before)`).toBe(true)
      make(agent)
      expect(matrixAgentAtRest(agent, calm), label).toBe(false)
    }
  })

  it('is not at rest while the app is busy with an operation, a conversation change, or quitting', () => {
    const agent = running()

    expect(matrixAgentAtRest(agent, { ...calm, busy: true })).toBe(false)
    expect(matrixAgentAtRest(agent, { ...calm, conversationPending: true })).toBe(false)
    expect(matrixAgentAtRest(agent, { ...calm, closing: true })).toBe(false)
  })

  it('takes and holds nothing by being asked: the turn lock is as free afterwards as before', async () => {
    const agent = running()

    expect(matrixAgentAtRest(agent, calm)).toBe(true)
    expect(matrixAgentAtRest(agent, calm)).toBe(true)
    expect(agent.lock.holder).toBeUndefined()
    expect(agent.lock.waiting).toBe(0)

    // And a turn that comes in is granted at once, not queued behind a question.
    const release = await agent.lock.acquire('!room:test', 'watch')
    expect(agent.lock.holder?.label).toBe('watch')
    release()
  })
})

describe('an agent quiet enough for its writers to be held still, for the checkpoint barrier', () => {
  const calm = { busy: false, closing: false, conversationPending: false }

  it('is quiet when nothing of its own is going on, and says nothing of the turn lock: the barrier holds that itself', () => {
    const agent = running()

    expect(matrixAgentQuiet(agent, calm)).toBe(true)

    const release = agent.lock.tryAcquire('home', 'checkpoint')!

    // The barrier asks with its own hold on the lock; the cadence's question counts any holder.
    expect(matrixAgentQuiet(agent, calm)).toBe(true)
    expect(matrixAgentAtRest(agent, calm)).toBe(false)
    release()
    expect(matrixAgentAtRest(agent, calm)).toBe(true)
  })

  it('is not quiet for anything of its own that could write its home, apart from the lock', () => {
    const blockers: Array<[string, (agent: MatrixAgentRuntime) => void]> = [
      ['a turn', agent => void (agent.invocation = { abort: new AbortController(), pending: Promise.resolve() })],
      ['a start', agent => void (agent.starting = Promise.resolve(true))],
      ["the agent's own operation", agent => void (agent.operation = true)],
      ['a task waiting for the lease', agent => void (agent.backgroundDemand = 1)],
      ['a group message waiting for the lease', agent => void (agent.groupDemand = 1)],
      ['a check-in waiting for the lease', agent => void (agent.checkInDemand = 1)],
      ['a local question running', agent => void (agent.localTurns = { executionPending: true } as never)],
      ['an agent that is closed', agent => void (agent.closed = true)]
    ]

    for (const [label, make] of blockers) {
      const agent = running()
      make(agent)
      expect(matrixAgentQuiet(agent, calm), label).toBe(false)
    }

    expect(matrixAgentQuiet(running(), { ...calm, busy: true })).toBe(false)
    expect(matrixAgentQuiet(running(), { ...calm, conversationPending: true })).toBe(false)
    expect(matrixAgentQuiet(running(), { ...calm, closing: true })).toBe(false)
  })
})

describe('taking an un-held cron ticker off its backend', () => {
  const quitting = { closing: true }
  const open = { closing: false }

  /** A running backend launched with its ticker on, whose hold could not be written. */
  function unheld() {
    const agent = running()
    agent.cronTicker = new AbortController().signal
    agent.cronTickerUnheld = true

    return agent
  }

  it('restarts a backend whose ticker is un-held, at once and without waiting for the app to be idle', () => {
    const agent = unheld()

    expect(agent.cronTickerRunning).toBe(true)
    expect(matrixUnheldTickerRestartable(agent, open)).toBe(true)
    // An optional restart would wait for any account-wide operation; this one does not.
    expect(matrixBackendRestartable(agent, { busy: true, closing: false })).toBe(false)
    expect(matrixUnheldTickerRestartable(agent, open)).toBe(true)
  })

  it('waits only for what must not be cut: a reply in progress, a sign-in being approved, a start under way', () => {
    const waiting: Array<[string, (agent: MatrixAgentRuntime) => void]> = [
      ['a reply', agent => void (agent.invocation = { abort: new AbortController(), pending: Promise.resolve() })],
      ['a plan sign-in', agent => void (agent.signIns = 1)],
      ['a start', agent => void (agent.starting = Promise.resolve(true))]
    ]

    for (const [label, make] of waiting) {
      const agent = unheld()
      make(agent)
      expect(matrixUnheldTickerRestartable(agent, open), label).toBe(false)
    }

    expect(matrixUnheldTickerRestartable(unheld(), quitting)).toBe(false)
  })

  it('has nothing to restart without an un-held, running ticker', () => {
    const held = unheld()
    held.cronTickerUnheld = false
    expect(matrixUnheldTickerRestartable(held, open)).toBe(false)

    // The backend launched with its ticker off, or has already exited.
    const off = unheld()
    off.cronTicker = undefined
    expect(off.cronTickerRunning).toBe(false)
    expect(matrixUnheldTickerRestartable(off, open)).toBe(false)

    const abort = new AbortController()
    const gone = unheld()
    gone.cronTicker = abort.signal
    abort.abort()
    expect(gone.cronTickerRunning).toBe(false)
    expect(matrixUnheldTickerRestartable(gone, open)).toBe(false)

    const closed = unheld()
    closed.closed = true
    expect(matrixUnheldTickerRestartable(closed, open)).toBe(false)
  })
})

describe('a backend that launched without its cron ticker', () => {
  const idle = { busy: false, closing: false }
  const standby = { tick: true, holdUntilAnswering: true }
  const answering = { tick: true, holdUntilAnswering: false }

  /** Holds whose folder can never be made (a file sits where it should be), so a hold fails. */
  function unwritable(): { holds: MatrixCronHolds; root: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-ticker-missing-'))
    writeFileSync(path.join(root, 'not-a-folder'), '')

    return { holds: new MatrixCronHolds(path.join(root, 'not-a-folder', 'cron-holds')), root }
  }

  it('is restarted with the ticker on once its Mac takes the term (a standby launch whose hold could not be written)', () => {
    const { holds, root } = unwritable()

    try {
      // The standby launch needs the hold, cannot write it and so starts with no ticker at all.
      const mayRun = applyMatrixJobsHold(holds, 'agent', standby)
      expect(mayRun).toBe(false)
      const agent = running()
      agent.cronTicker = mayRun ? new AbortController().signal : undefined
      expect(agent.cronTickerRunning).toBe(false)

      // Still standing by: it must not fire, and it need not be restarted for that.
      expect(matrixJobsTickerMissing(standby, agent.cronTickerRunning)).toBe(false)

      // The Mac takes the term: the plan stops holding. The hold logic alone finds nothing to fix,
      // because there is no ticker to un-hold or to lift; this is the case that was dropped.
      const reconciled = reconcileMatrixJobsHold(holds, 'agent', answering, agent.cronTickerRunning)
      agent.cronTickerUnheld = reconciled.unheld
      expect(reconciled).toEqual({ unheld: false })
      expect(matrixUnheldTickerRestartable(agent, { closing: false })).toBe(false)

      agent.cronTickerMissing = matrixJobsTickerMissing(answering, agent.cronTickerRunning)
      expect(agent.cronTickerMissing).toBe(true)
      expect(matrixMissingTickerRestartable(agent, idle)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("is missing only where this Mac should be firing the agent's jobs", () => {
    expect(matrixJobsTickerMissing(answering, false)).toBe(true)
    // A ticker is running (held or not): nothing missing.
    expect(matrixJobsTickerMissing(answering, true)).toBe(false)
    // Standing by: the hold decides, and a standby Mac without a ticker fires nothing, as it must.
    expect(matrixJobsTickerMissing(standby, false)).toBe(false)
    // The person switched this Mac's jobs off (`matrix-run-jobs`): never wanted.
    expect(matrixJobsTickerMissing({ tick: false, holdUntilAnswering: false }, false)).toBe(false)
  })

  it('waits like an optional restart: an idle backend, no reply, no plan sign-in, no start, not quitting', () => {
    const missing = () => {
      const agent = running()
      agent.cronTickerMissing = true

      return agent
    }

    expect(matrixMissingTickerRestartable(missing(), idle)).toBe(true)

    const waiting: Array<[string, (agent: MatrixAgentRuntime) => { busy: boolean; closing: boolean }]> = [
      [
        'a reply',
        agent => (void (agent.invocation = { abort: new AbortController(), pending: Promise.resolve() }), idle)
      ],
      ['a plan sign-in', agent => (void (agent.signIns = 1), idle)],
      ['a start', agent => (void (agent.starting = Promise.resolve(true)), idle)],
      ["the agent's own operation", agent => (void (agent.operation = true), idle)],
      ['an account-wide operation', () => ({ busy: true, closing: false })],
      ['quitting', () => ({ busy: false, closing: true })]
    ]

    for (const [label, make] of waiting) {
      const agent = missing()
      expect(matrixMissingTickerRestartable(agent, make(agent)), label).toBe(false)
    }
  })

  it('has nothing to restart when the ticker runs, was not flagged, or there is no backend to restart', () => {
    const flagged = running()
    flagged.cronTickerMissing = true
    flagged.cronTicker = new AbortController().signal
    expect(matrixMissingTickerRestartable(flagged, idle)).toBe(false)

    expect(matrixMissingTickerRestartable(running(), idle)).toBe(false)

    // No backend yet (or it exited): its next launch decides the ticker from the plan, afresh.
    const none = new MatrixAgentRuntime('agent')
    none.cronTickerMissing = true
    expect(matrixMissingTickerRestartable(none, idle)).toBe(false)
  })
})

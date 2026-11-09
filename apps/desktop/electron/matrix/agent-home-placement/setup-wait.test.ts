import { describe, expect, it } from 'vitest'

import { waitForAgentSetup } from './setup-wait'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

describe('waiting for an agent launch set-up', () => {
  it('does nothing when no set-up runs, or when the caller already aborted', async () => {
    const aborted = new AbortController()
    aborted.abort()

    await expect(waitForAgentSetup(undefined, new AbortController().signal)).resolves.toBeUndefined()
    await expect(waitForAgentSetup(deferred().promise, aborted.signal)).resolves.toBeUndefined()
  })

  it('resolves only after the set-up does', async () => {
    const setup = deferred()
    const controller = new AbortController()
    let settled = false
    const waiting = waitForAgentSetup(setup.promise, controller.signal).then(() => (settled = true))

    await Promise.resolve()
    expect(settled).toBe(false)

    setup.resolve()
    await waiting
    expect(settled).toBe(true)
  })

  it('resolves after a failed set-up too, and leaves the read to report what exists', async () => {
    const setup = deferred()
    const waiting = waitForAgentSetup(setup.promise, new AbortController().signal)

    setup.reject(new Error('matrix_agent_unavailable'))
    await expect(waiting).resolves.toBeUndefined()
  })

  it('stops waiting when the caller aborts, without rejecting the wait itself', async () => {
    const setup = deferred()
    const controller = new AbortController()
    const waiting = waitForAgentSetup(setup.promise, controller.signal)

    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})

import { afterEach, describe, expect, it } from 'vitest'

import type { T3Reply } from './ports'
import { type Harness, makeHarness } from './test-support'

// `ownerRunsIdle` is what main asks before it restarts the session server on its own (`restartWhenIdle`): a restart
// that interrupts the person's own run cannot be undone, so every doubt answers "not idle".

let h: Harness

afterEach(async () => h?.cleanup())

function answer(reply: T3Reply): void {
  h.t3.list = async (token: string) => {
    h.t3.calls.push({ tool: 'list', token })

    return reply
  }
}

const threads = (...statuses: unknown[]): T3Reply => ({
  transport: 'ok',
  status: 200,
  isError: false,
  data: { threads: statuses.map((status, index) => ({ threadId: `t${index}`, status })) }
})

describe('ownerRunsIdle', () => {
  it('is idle when every thread of the owner is at rest, asked with the owner session only', async () => {
    h = makeHarness()
    answer(threads('idle', 'completed', 'no_run_yet', 'interrupted'))

    expect(await h.gate.ownerRunsIdle()).toBe(true)
    expect(h.t3.calls.filter(call => call.tool === 'list').map(call => call.token)).toEqual(['owner-token'])
  })

  it('is idle for a server with no thread at all', async () => {
    h = makeHarness()
    answer(threads())

    expect(await h.gate.ownerRunsIdle()).toBe(true)
  })

  it.each(['running', 'starting', 'preparing', 'waiting', 'queued'])('is not idle while a thread is %s', async status => {
    h = makeHarness()
    answer(threads('idle', status))

    expect(await h.gate.ownerRunsIdle()).toBe(false)
  })

  it('is not idle for a status it does not know, or none', async () => {
    h = makeHarness()
    answer(threads('idle', 'something_new'))
    expect(await h.gate.ownerRunsIdle()).toBe(false)

    answer(threads('idle', undefined))
    expect(await h.gate.ownerRunsIdle()).toBe(false)
  })

  it('is not idle when T3 did not answer, answered an error, has another page, or the call throws', async () => {
    h = makeHarness()
    answer({ transport: 'failed', error: 'ECONNRESET' })
    expect(await h.gate.ownerRunsIdle()).toBe(false)

    answer({ transport: 'ok', status: 200, isError: true, data: {}, code: 'boom' })
    expect(await h.gate.ownerRunsIdle()).toBe(false)

    answer({ transport: 'ok', status: 200, isError: false, data: { threads: [], nextCursor: 'more' } })
    expect(await h.gate.ownerRunsIdle()).toBe(false)

    h.t3.list = async () => {
      throw new Error('socket')
    }
    expect(await h.gate.ownerRunsIdle()).toBe(false)
  })
})

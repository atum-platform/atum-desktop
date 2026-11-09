import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { registerAtumAdvisoryIpc } from './atum-advisory-ipc'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

const ipc = {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
    handlers.set(channel, listener),
  removeHandler: (channel: string) => handlers.delete(channel)
}

test('advisory search IPC admits only opaque gateway invocation ids and fails closed malformed authority replies', async () => {
  handlers.clear()
  const trusted = vi.fn()
  const search = vi.fn(async () => ({ status: 'not-a-contract' as const, results: [] }))
  registerAtumAdvisoryIpc(ipc as never, {} as never, trusted as never, search as never)

  const handler = handlers.get('atum:advisory:search')!

  const result = await handler(
    {},
    {
      request_id: 'request-1',
      session_id: 'runtime-1',
      turn_id: 'turn-1',
      profile: 'moon'
    }
  )

  assert.deepEqual(search.mock.calls, [
    [{ request_id: 'request-1', session_id: 'runtime-1', turn_id: 'turn-1', profile: 'moon' }]
  ])
  assert.equal(trusted.mock.calls.length, 1)
  assert.deepEqual(result, { status: 'unavailable', results: [], next_reference: null, previous_reference: null })
})

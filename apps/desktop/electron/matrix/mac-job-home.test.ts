import { afterEach, expect, it, vi } from 'vitest'

import { createWorld } from './agent-home-placement/world.fixture'
import { createMacJobHome } from './mac-job-home'
import { macJobAuthority } from './mac-job-lifecycle'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('retains signed Mac-job authority without exposing relocation', async () => {
  const w = await createWorld({ at: 'a' })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(w.clock.now())
  vi.stubGlobal('fetch', w.stub.fetch)
  const home = createMacJobHome({ request: send => send(w.stub.token, 'https://shell.test/api/matrix/v1'),
    key: w.a.key, store: w.a.store, leaseFacts: () => {
      const lease = w.stub.lease(w.agent)
      return lease ? { leaseId: lease.leaseId, executorTerm: lease.term, leaseExpiresAtPlatform: lease.expiresAt } : null
    }, publicationStore: () => null, agents: () => [w.agent], ready: () => true, changed: () => {}, log: () => {} })
  const signal = new AbortController().signal
  const authority = await macJobAuthority(home.controller.ctx, w.agent, signal)
  expect(authority?.leaseId).toBe(w.stub.lease(w.agent)?.leaseId)
  expect(home).not.toHaveProperty('prepare')
  expect(home.controller).not.toHaveProperty('requestMove')
  home.controller.ctx.journal.update(w.agent, entry => { entry.managed = true; entry.standDown = true })
  expect(home.isHeld(w.agent)).toBe(true)
  home.service.stop()
})

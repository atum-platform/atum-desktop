import { describe, expect, it, vi } from 'vitest'

import type { MatrixAccount } from './account'
import { dispatchMatrixStop } from './main-host-stop'

const principal = '00000000-0000-4000-8000-159badba71cd'
const source = { roomId: '!room:test', eventId: '$source' }
function fixture(host: boolean, cloud = true, ready = true) {
  const fetcher = vi.fn()
  const hostStop = vi.fn(async () => ({ state: 'stop_requested' as const }))
  const legacyStop = vi.fn(async () => ({ state: 'stop_requested' as const }))
  const s1Request = vi.fn()
  const runS1: MatrixAccount['s1Request'] = (work, signal, options) => {
    s1Request(work, signal, options)
    return work('synthetic-grant', 'https://shell.test/api/matrix/v1', signal)
  }
  const run = (agent: string | undefined = principal) => dispatchMatrixStop({ ...source, principal: agent, host, cloud, ready }, { s1Request: runS1, s1Call: vi.fn(), fetcher, hostStop, legacyStop })
  return { run, s1Request, hostStop, legacyStop, fetcher }
}
describe('main host Stop dispatch', () => {
  it('uses the domain grant and a 40s S1 budget for Hermes', async () => {
    const f = fixture(true)
    await expect(f.run()).resolves.toEqual({ state: 'stop_requested' })
    expect(f.s1Request).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal), { timeoutMs: 40_000 })
    expect(f.hostStop).toHaveBeenCalledWith('https://shell.test/api/matrix/v1', 'synthetic-grant', principal, source.roomId, source.eventId, expect.any(AbortSignal), f.fetcher)
    expect(f.legacyStop).not.toHaveBeenCalled()
  })
  it('retains the legacy cloud Stop path and its deadline', async () => {
    const f = fixture(false)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await f.run()
      expect(f.legacyStop).toHaveBeenCalledWith(expect.any(Function), principal, source.roomId, source.eventId, expect.any(AbortSignal))
      expect(timeout).toHaveBeenCalledWith(30_000)
      expect(f.s1Request).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  })
  it('refuses local agents before any transport', () => {
    const f = fixture(false, false)
    expect(() => f.run()).toThrow('matrix_agent_unavailable')
    expect(f.s1Request).not.toHaveBeenCalled()
    expect(f.legacyStop).not.toHaveBeenCalled()
  })
  it('refuses a missing principal', () => {
    expect(() => dispatchMatrixStop({ ...source, cloud: true, host: true, ready: true }, { s1Request: vi.fn(), s1Call: vi.fn(), fetcher: vi.fn() })).toThrow('matrix_agent_unavailable')
  })
  it('requires configured domain and account scope for host Stop', () => {
    const f = fixture(true, true, false)
    expect(() => f.run()).toThrow('matrix_not_ready')
    expect(f.s1Request).not.toHaveBeenCalled()
  })
  it('never downgrades a refused host Stop to legacy', async () => {
    const f = fixture(true)
    f.hostStop.mockRejectedValueOnce(new Error('matrix_host_stop_refused'))
    await expect(f.run()).rejects.toThrow('matrix_host_stop_refused')
    expect(f.legacyStop).not.toHaveBeenCalled()
  })
})

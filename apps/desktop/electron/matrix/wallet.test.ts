import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MatrixWalletController, matrixWalletHistory, matrixWalletView, readMatrixWallet } from './wallet'

const view = {
  unit: 'micro_proton' as const,
  balances: { available: 1234567, paid: 1234567, earned: 0, promo: 0, held: 1 },
  allowance: { kind: 'founding' as const, state: 'deferred' as const, amount: 50000000000, grantedAt: null },
  checkoutOpen: false
}

const entry = { id: '00000000-0000-4000-8000-11e594f48195', at: '2026-10-01T18:00:00.123456Z',
  kind: 'usage', status: 'charged', amount: -123, reference: null, closedAt: '2026-10-01T18:00:01Z' }

const servers: Server[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

describe('Matrix wallet wire', () => {
  it('retains exact micro amounts and deferred allowance, never inventing credit', () => {
    expect(matrixWalletView(view)).toEqual(view)
    expect(matrixWalletView({ ...view, allowance: null, balances: { available: 0, paid: 0, earned: 0, promo: 0, held: 0 } }).balances.available).toBe(0)
  })
  it.each([
    { ...view, unit: 'proton' },
    { ...view, balances: { ...view.balances, available: 1234568 } },
    { ...view, balances: { ...view.balances, paid: -1 } },
    { ...view, balances: { ...view.balances, held: 0.5 } },
    { ...view, allowance: { ...view.allowance, state: 'granted', grantedAt: null } },
    { ...view, allowance: undefined },
    { ...view, checkoutOpen: 'true' }
  ])('refuses malformed balances/allowances rather than displaying zero', bad => {
    expect(() => matrixWalletView(bad)).toThrow('matrix_wallet_invalid')
  })
  it('keeps unknown provider history kinds/statuses visible and signed, preserving exact timestamps', () => {
    const future = { ...entry, kind: 'future_reward', status: 'future_settled' }
    expect(matrixWalletHistory({ entries: [future], next: 'opaque_cursor' })).toEqual({ entries: [future], next: 'opaque_cursor' })
  })
  it.each([
    { entries: [entry, entry], next: null },
    { entries: [], next: 'cursor' },
    { entries: [entry], next: 'https://example.test' },
    { entries: [{ ...entry, amount: Number.MAX_SAFE_INTEGER + 1 }], next: null },
    { entries: [{ ...entry, at: 'invalid' }], next: null }
  ])('refuses incomplete/malformed pages without returning partial success', bad => {
    expect(() => matrixWalletHistory(bad)).toThrow('matrix_wallet_invalid')
  })
  it('reads the actual fixed route with a native bearer, no principal or browser origin', async () => {
    const requests: Array<{ url?: string; auth?: string; origin?: string }> = []

    const server = createServer((request, response) => {
      requests.push({ url: request.url, auth: request.headers.authorization, origin: request.headers.origin })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.url?.includes('/history') ? { entries: [entry], next: null } : view))
    })

    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const resource = `http://127.0.0.1:${address.port}/api/matrix/v1`
    const grant = { issuer: 'https://id.test', subject: 'person', accessToken: 'synthetic-owner-bearer', refreshToken: 'synthetic-refresh' }
    expect(await readMatrixWallet(resource, grant, 'wallet', AbortSignal.timeout(5000))).toEqual(view)
    expect(await readMatrixWallet(resource, grant, 'history', AbortSignal.timeout(5000), 'opaque_cursor')).toEqual({ entries: [entry], next: null })
    expect(requests).toEqual([
      { url: '/api/matrix/v1/wallet', auth: 'Bearer synthetic-owner-bearer', origin: undefined },
      { url: '/api/matrix/v1/wallet/history?limit=50&before=opaque_cursor', auth: 'Bearer synthetic-owner-bearer', origin: undefined }
    ])
    await expect(readMatrixWallet(resource, grant, 'history', AbortSignal.timeout(5000), '../other')).rejects.toThrow('matrix_wallet_invalid')
    expect(requests).toHaveLength(2)
  })
})

describe('event-driven owner wallet', () => {
  it('reads on activation, keeps a ready balance during refresh, and removes it on failure', async () => {
    let finish!: (value: typeof view) => void
    const read = vi.fn().mockResolvedValueOnce(view).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValueOnce(new Error('outage'))
    const changed = vi.fn()
    const wallet = new MatrixWalletController({ read, changed })
    wallet.activate({ accountKey: 'owner', generation: 1 })
    await wallet.refresh('manual')
    expect(wallet.snapshot()).toEqual({ state: 'ready', wallet: view })
    const refresh = wallet.refresh('manual')
    await Promise.resolve()
    expect(wallet.snapshot()?.state).toBe('ready')
    finish(view)
    await refresh
    await wallet.refresh('manual')
    expect(wallet.snapshot()).toEqual({ state: 'unavailable', wallet: null })
    wallet.activate(null)
  })
  it('discards a delayed old account read even if that read ignores abort', async () => {
    let finish!: (value: typeof view) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ ...view, checkoutOpen: true })
    const wallet = new MatrixWalletController({ read, changed: vi.fn() })
    wallet.activate({ accountKey: 'old', generation: 1 })
    await Promise.resolve()
    wallet.activate({ accountKey: 'new', generation: 2 })
    await wallet.refresh('manual')
    finish(view)
    await Promise.resolve()
    await Promise.resolve()
    expect(wallet.snapshot()).toEqual({ state: 'ready', wallet: { ...view, checkoutOpen: true } })
    wallet.activate(null)
    expect(wallet.snapshot()).toBeUndefined()
  })
  it('coalesces turn events to 15 seconds and focus events to a minute, with no idle polling', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(view)
    const wallet = new MatrixWalletController({ read, changed: vi.fn() })
    wallet.activate({ accountKey: 'owner', generation: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await wallet.refresh('turn')
    await wallet.refresh('turn')
    await vi.advanceTimersByTimeAsync(14999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    await wallet.refresh('focus')
    await wallet.refresh('focus')
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(120000)
    expect(read).toHaveBeenCalledTimes(3)
    wallet.activate(null)
  })
})

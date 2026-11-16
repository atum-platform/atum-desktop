import { expect, it, vi } from 'vitest'

import { matrixHostRefresh } from './matrix-host-refresh'

const url = 'https://matrix.test/_matrix/client/v3/account/whoami'
const refused = () => Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 })

function fixture() {
  const refresh = vi.fn(async (_handle: string) => ({
    ok: true as const,
    accessToken: 'new',
    refreshToken: 'next-handle'
  }))

  const apply = vi.fn()
  const active = vi.fn(() => true)
  const fetcher = vi.fn<typeof fetch>(async () => refused())

  const host = matrixHostRefresh({
    baseUrl: 'https://matrix.test',
    accessToken: 'old',
    handle: 'handle',
    refresh,
    apply,
    active,
    fetcher
  })

  return { ...host, refresh, apply, active, network: fetcher }
}

it('shares concurrent refresh, rotates only the handle, and replays request bodies once', async () => {
  const f = fixture()
  const send = () => f.fetcher(url, { method: 'POST', body: '{"test":true}', headers: { authorization: 'Bearer old' } })
  await Promise.all([send(), send()])
  expect(f.refresh).toHaveBeenCalledExactlyOnceWith('handle')
  expect(f.network).toHaveBeenCalledTimes(4)
  const retry = f.network.mock.calls[2][0] as Request
  expect(retry.headers.get('authorization')).toBe('Bearer new')
  expect(await retry.text()).toBe('{"test":true}')
  await f.renew()
  expect(f.refresh).toHaveBeenLastCalledWith('next-handle')
})
it('never refreshes foreign, unauthenticated, or non-Matrix requests', async () => {
  const f = fixture()
  await f.fetcher('https://foreign.test/_matrix/client/v3/sync', { headers: { authorization: 'Bearer old' } })
  await f.fetcher(url)
  await f.fetcher('https://matrix.test/token', { headers: { authorization: 'Bearer old' } })
  expect(f.refresh).not.toHaveBeenCalled()
})
it('does not apply a late credential or retry after stopping', async () => {
  const f = fixture()
  f.refresh.mockImplementationOnce(async () => {
    f.active.mockReturnValue(false)

    return { ok: true, accessToken: 'new', refreshToken: 'next-handle' }
  })
  await expect(f.fetcher(url, { headers: { authorization: 'Bearer old' } })).rejects.toThrow('matrix_stopped')
  expect(f.apply).not.toHaveBeenCalled()
  expect(f.network).toHaveBeenCalledOnce()
})
it('leaves definitive sign-out to the SDK without a retry', async () => {
  const f = fixture()

  const host = matrixHostRefresh({
    baseUrl: 'https://matrix.test',
    accessToken: 'old',
    handle: 'handle',
    refresh: async () => ({ ok: false, reauthenticate: true }),
    apply: f.apply,
    active: f.active,
    fetcher: f.network
  })

  expect((await host.fetcher(url, { headers: { authorization: 'Bearer old' } })).status).toBe(401)
  expect(f.apply).not.toHaveBeenCalled()
  expect(f.network).toHaveBeenCalledOnce()
})

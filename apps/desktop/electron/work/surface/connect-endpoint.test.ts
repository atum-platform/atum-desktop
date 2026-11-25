import { expect, it, vi } from 'vitest'

import { ensureConnectMcpUrl } from './connect-endpoint'

const LOCAL = 'http://127.0.0.1:12345'
const RELAY = 'https://relay.atumplatform.com'

function fixture() {
  const records: { url: string; init?: RequestInit }[] = []
  const state = { linked: false, linkRevoked: false, linkableHere: true, tunnelHostname: undefined as string | undefined }
  let current = true
  const link = {
    ok: true, environmentId: 'env-1', relayIssuer: RELAY, cloudUserId: 'owner-1',
    environmentCredential: 'env-secret', cloudMintPublicKey: 'mint-public-key',
    endpoint: { providerKind: 'cloudflare_tunnel' },
    endpointRuntime: { providerKind: 'cloudflare_tunnel', connectorToken: 'connector-secret' }
  }
  const record = (input: RequestInfo | URL, init?: RequestInit) => {
    records.push({ url: String(input), init })

    return new URL(String(input)).pathname
  }
  const ownerFetch: typeof fetch = async (input, init) => {
    switch (record(input, init)) {
      case '/api/connect/link-state': return Response.json(state)
      case '/.well-known/t3/environment': return Response.json({ environmentId: 'env-1' })
      case '/api/connect/link-proof': return Response.json('native-proof')
      case '/api/connect/relay-config':
        Object.assign(state, { linked: true, tunnelHostname: 'mac.example.test' })

        return Response.json({ ok: true })
      default: throw new Error('unexpected Work request')
    }
  }
  const relayFetch: typeof fetch = async (input, init) => {
    switch (record(input, init)) {
      case '/v1/client/environment-link-challenges': return Response.json({ challenge: 'native-challenge' })
      case '/v1/client/environment-links': return Response.json(link)
      default: throw new Error('unexpected relay request')
    }
  }
  const assertion = vi.fn(async () => 'owner-assertion')
  const disconnect = vi.fn(async () => {})

  return {
    records, state, link, assertion, disconnect, retire: () => { current = false },
    options: { origin: LOCAL, ownerFetch, relayFetch, assertion, disconnect, current: () => current, signal: new AbortController().signal }
  }
}

it('links an unlinked Work instance through native T3 endpoints and then reads its assigned hostname', async () => {
  const { options, records, assertion, link } = fixture()
  expect(await ensureConnectMcpUrl(options)).toBe('https://mac.example.test/mcp')
  expect(assertion).toHaveBeenCalledTimes(2)
  expect(records.map(row => row.url)).toEqual([
    `${LOCAL}/api/connect/link-state`,
    `${LOCAL}/.well-known/t3/environment`,
    `${RELAY}/v1/client/environment-link-challenges`,
    `${LOCAL}/api/connect/link-proof`,
    `${RELAY}/v1/client/environment-links`,
    `${LOCAL}/api/connect/relay-config`,
    `${LOCAL}/api/connect/link-state`
  ])
  for (const { url, init } of records) {
    const isRelay = url.startsWith(RELAY)
    expect(init).toMatchObject({ redirect: 'error', credentials: isRelay ? 'omit' : 'include' })
    expect(new Headers(init?.headers).get('authorization')).toBe(isRelay ? 'Bearer owner-assertion' : null)
  }
  const body = (i: number) => JSON.parse(String(records[i]?.init?.body))
  expect(body(2)).toMatchObject({ managedTunnelsEnabled: true })
  expect(body(3)).toEqual({
    challenge: 'native-challenge', relayIssuer: RELAY,
    endpoint: { providerKind: 'cloudflare_tunnel', httpBaseUrl: LOCAL, wsBaseUrl: 'ws://127.0.0.1:12345' },
    origin: { localHttpHost: '127.0.0.1', localHttpPort: 12345 }
  })
  expect(body(4)).toMatchObject({ proof: 'native-proof', managedTunnelsEnabled: true })
  expect(body(5)).toEqual({
    relayUrl: RELAY, relayIssuer: RELAY, cloudUserId: link.cloudUserId,
    environmentCredential: link.environmentCredential, cloudMintPublicKey: link.cloudMintPublicKey,
    endpointRuntime: link.endpointRuntime
  })
})

it('uses a linked hostname and waits for a pending tunnel without creating another link', async () => {
  const { options, state, records, assertion, disconnect } = fixture()
  state.linked = true
  expect(await ensureConnectMcpUrl(options)).toBeUndefined()
  state.tunnelHostname = 'mac.example.test'
  expect(await ensureConnectMcpUrl(options)).toBe('https://mac.example.test/mcp')
  expect(assertion).not.toHaveBeenCalled()
  expect(disconnect).not.toHaveBeenCalled()
  expect(records).toHaveLength(2)
})

it('withdraws publication when native Connect marks the link revoked', async () => {
  const { options, state, disconnect, assertion } = fixture()
  Object.assign(state, { linked: true, linkRevoked: true, tunnelHostname: 'mac.example.test' })
  expect(await ensureConnectMcpUrl(options)).toBeUndefined()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(assertion).not.toHaveBeenCalled()
})

it('refuses non-loopback Work, an unexpected environment and a stale account', async () => {
  const { options, records, link, assertion, retire } = fixture()
  await expect(ensureConnectMcpUrl({ ...options, origin: 'https://external.example.test' })).rejects.toThrow('work_connect_unavailable')
  expect(records).toHaveLength(0)

  link.environmentId = 'different-env'
  await expect(ensureConnectMcpUrl(options)).rejects.toThrow('work_connect_invalid_link')
  expect(records.some(row => row.url.endsWith('/relay-config'))).toBe(false)

  records.splice(0)
  assertion.mockImplementationOnce(async () => { retire(); return 'stale-assertion' })
  await expect(ensureConnectMcpUrl(options)).rejects.toThrow('work_account_changed')
  expect(records.every(row => row.url.startsWith(LOCAL))).toBe(true)
})

const RELAY = 'https://relay.atumplatform.com'
const LINK_FEATURES = { managedTunnelsEnabled: true, notificationsEnabled: false, liveActivitiesEnabled: false }

interface ConnectOptions {
  origin: string
  ownerFetch: typeof fetch
  relayFetch: typeof fetch
  assertion(): Promise<string>
  current(): boolean
  signal: AbortSignal
  disconnect(): Promise<void>
  canLink(): boolean
  rememberLink(): void
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Read the native Connect state and establish a managed link if this Work home needs one. */
export async function ensureConnectMcpUrl(options: ConnectOptions): Promise<string | undefined> {
  const { origin, ownerFetch, relayFetch, signal, current } = options

  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)) {throw new Error('work_connect_unavailable')}

  const json = async (request: typeof fetch, url: string, init: RequestInit, timeout = 5_000) => {
    if (!current()) {throw new Error('work_account_changed')}

    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })

    if (!response.ok) {throw new Error('work_connect_unavailable')}

    return response.json()
  }
  const post = (payload: object) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const readState = () => json(ownerFetch, `${origin}/api/connect/link-state`, { credentials: 'include' })
  let state = await readState()

  if (state.linkRevoked === true) {
    await options.disconnect()

    return undefined
  }

  if (state.linked === false) {
    await options.disconnect()

    if (state.linkableHere === false || !options.canLink()) {return undefined}

    const relay = async (path: string, payload: object, timeout: number) => {
      if (!current()) {throw new Error('work_account_changed')}
      const assertion = await options.assertion()
      const init = post(payload)

      return json(relayFetch, `${RELAY}/v1/client/${path}`, {
        ...init, credentials: 'omit', headers: { ...init.headers, authorization: `Bearer ${assertion}` }
      }, timeout)
    }

    const { environmentId } = await json(ownerFetch, `${origin}/.well-known/t3/environment`, { credentials: 'include' })
    const { challenge } = await relay('environment-link-challenges', LINK_FEATURES, 15_000)

    if (!text(environmentId) || !text(challenge)) {throw new Error('work_connect_invalid_challenge')}

    const local = new URL(origin)
    const proof = await json(ownerFetch, `${origin}/api/connect/link-proof`, {
      ...post({
        challenge,
        relayIssuer: RELAY,
        endpoint: { providerKind: 'cloudflare_tunnel', httpBaseUrl: local.origin, wsBaseUrl: `ws://${local.host}` },
        origin: { localHttpHost: local.hostname, localHttpPort: Number(local.port) }
      }),
      credentials: 'include'
    })

    if (!text(proof)) {throw new Error('work_connect_invalid_proof')}

    const link = await relay('environment-links', { ...LINK_FEATURES, proof }, 60_000)

    if (link.ok !== true || link.environmentId !== environmentId || link.endpoint?.providerKind !== 'cloudflare_tunnel' ||
        link.endpointRuntime?.providerKind !== 'cloudflare_tunnel' || !text(link.endpointRuntime.connectorToken) ||
        link.relayIssuer !== RELAY || !text(link.cloudUserId) || !text(link.environmentCredential) || !text(link.cloudMintPublicKey)) {
      throw new Error('work_connect_invalid_link')
    }

    // Record custody before applying the config. An interrupted response may still have enabled the link.
    if (!current()) {throw new Error('work_account_changed')}
    options.rememberLink()
    await json(ownerFetch, `${origin}/api/connect/relay-config`, {
      ...post({
        relayUrl: RELAY, relayIssuer: link.relayIssuer, cloudUserId: link.cloudUserId,
        environmentCredential: link.environmentCredential, cloudMintPublicKey: link.cloudMintPublicKey, endpointRuntime: link.endpointRuntime
      }),
      credentials: 'include'
    }, 60_000)
    state = await readState()
  }

  if (state.linked === false || state.linkRevoked === true || (state.linked === true && !state.tunnelHostname)) {return undefined}

  if (state.linked !== true || typeof state.tunnelHostname !== 'string' || !/^[a-z0-9.-]+$/iu.test(state.tunnelHostname)) {
    throw new Error('work_connect_unavailable')
  }

  return new URL('/mcp', `https://${state.tunnelHostname}`).href
}

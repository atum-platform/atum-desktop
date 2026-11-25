import { createHash, randomBytes } from 'node:crypto'

import { readConnectMcpUrl } from '../surface/connect-endpoint'

const REDIRECT_URI = 'http://127.0.0.1:9/cb'
const SCOPES = 'orchestration:read orchestration:operate'
const RENEW_BEFORE_MS = 7 * 86_400_000

interface Credential {
  credential: string
  expiresAt: number
}

interface MintOptions {
  workOrigin: string
  connectUrl: string
  localBearer: string
  fetch?: typeof fetch
  now?: () => number
}

export async function mintT3McpCredential(options: MintOptions): Promise<Credential> {
  const { workOrigin, localBearer, fetch: request = fetch, now = Date.now } = options
  const connect = new URL(options.connectUrl)

  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(workOrigin) ||
      connect.href !== `${connect.origin}/mcp` || connect.protocol !== 'https:') {
    throw new Error('work_t3_mcp_invalid_endpoint')
  }

  const json = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })

    if (!response.ok) {throw new Error('work_t3_mcp_oauth_refused')}

    return response.json()
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  const metadata = await json(`${connect.origin}/.well-known/oauth-authorization-server`)

  if (typeof metadata.registration_endpoint !== 'string') {throw new Error('work_t3_mcp_invalid_metadata')}
  const registrationUrl = new URL(metadata.registration_endpoint)

  if (registrationUrl.origin !== connect.origin || registrationUrl.username || registrationUrl.password) {
    throw new Error('work_t3_mcp_invalid_registration_endpoint')
  }

  const { client_id } = await post(registrationUrl.href, {
    client_name: 'Atum Work',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPES
  })

  if (typeof client_id !== 'string' || !client_id) {throw new Error('work_t3_mcp_invalid_client')}

  const verifier = randomBytes(32).toString('base64url')

  const authorization = {
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT_URI,
    state: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: SCOPES,
    resource: `${workOrigin}/mcp`
  }

  const pairing = await post(`${workOrigin}/api/auth/pairing-token`, {}, { authorization: `Bearer ${localBearer}` })

  if (typeof pairing.credential !== 'string' || !pairing.credential) {throw new Error('work_t3_mcp_invalid_pairing')}

  const decision = await post(`${workOrigin}/oauth/mcp/decision`, {
    authorization,
    decision: { _tag: 'pairing-code', access: 'full-access', code: pairing.credential }
  })

  if (typeof decision.redirectTo !== 'string') {throw new Error('work_t3_mcp_invalid_decision')}
  const callback = new URL(decision.redirectTo)
  const code = callback.searchParams.get('code')

  if (!code || callback.searchParams.get('state') !== authorization.state ||
      `${callback.origin}${callback.pathname}` !== REDIRECT_URI || callback.username || callback.password) {
    throw new Error('work_t3_mcp_invalid_callback')
  }

  const requestedAt = now()

  const token = await json(`${workOrigin}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: authorization.resource
    })
  })

  const { access_token, expires_in } = token
  const expiresAt = typeof expires_in === 'number' ? requestedAt + expires_in * 1000 : 0

  if (typeof access_token !== 'string' || !access_token || Buffer.byteLength(access_token) > 8192 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
    throw new Error('work_t3_mcp_invalid_token')
  }

  return { credential: access_token, expiresAt }
}

type DeviceCall = (operation: string, body: Record<string, unknown>) => Promise<unknown>

interface PublicationTarget {
  deviceServiceId: string
  workOrigin: string
  localBearer(): Promise<string>
  current(): boolean
  call: DeviceCall
}

export class WorkT3McpPublication {
  private running?: { deviceServiceId: string; abort: AbortController; done: Promise<void> }
  private published?: { deviceServiceId: string; workOrigin: string; connectUrl: string; expiresAt: number }

  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  refresh(target: PublicationTarget): Promise<void> {
    if (this.running) {return this.running.done}

    const abort = new AbortController()
    const done = this.publish(target, abort.signal).finally(() => { this.running = undefined })
    this.running = { deviceServiceId: target.deviceServiceId, abort, done }

    return done
  }

  private async publish(target: PublicationTarget, signal: AbortSignal): Promise<void> {
    const live = () => !signal.aborted && target.current()

    if (!live()) {return}

    const { deviceServiceId, workOrigin } = target
    const localBearer = await target.localBearer()

    if (!live()) {return}

    const request: typeof fetch = (input, init) => this.request(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    })

    const connectUrl = await readConnectMcpUrl(workOrigin, {
      fetch: (input, init) => request(input, { ...init, headers: { authorization: `Bearer ${localBearer}` } })
    })

    if (!live()) {return}

    const published = this.published

    if (!connectUrl) {
      if (published?.deviceServiceId === deviceServiceId) {
        await target.call('work_t3_mcp_clear', { deviceServiceId })
        this.published = undefined
      }

      return
    }

    if (published?.deviceServiceId === deviceServiceId && published.workOrigin === workOrigin && published.connectUrl === connectUrl &&
        published.expiresAt - this.now() >= RENEW_BEFORE_MS) {return}

    const token = await mintT3McpCredential({ workOrigin, connectUrl, localBearer, fetch: request, now: this.now })

    if (!live()) {return}

    await target.call('work_t3_mcp_set', { deviceServiceId, connectUrl, ...token })
    this.published = { deviceServiceId, workOrigin, connectUrl, expiresAt: token.expiresAt }
  }

  stop(): void {
    this.running?.abort.abort()
  }

  async clear(deviceServiceId: string, call: DeviceCall): Promise<void> {
    const running = this.running

    if (running?.deviceServiceId === deviceServiceId) {
      // If set is already on the wire let it finish before clearing the row.
      running.abort.abort()
      await running.done.catch(() => undefined)
    }

    if (this.published?.deviceServiceId === deviceServiceId) {this.published = undefined}

    await call('work_t3_mcp_clear', { deviceServiceId })
  }
}

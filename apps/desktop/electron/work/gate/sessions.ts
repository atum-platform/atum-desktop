import { createHash, randomBytes } from 'node:crypto'

import { type CommandRunner, execCommand } from '../session/t3-auth'

import type { GateSession, GateSessions } from './ports'

// Each agent's T3 session, issued and held on the Mac, and main's own owner session (plan §11.2, S0-1, S0-4).
// Main is an ordinary MCP OAuth client of its own server on loopback: register a public client, approve the sign-in
// with a one-time pairing code, then authorization code + PKCE. No browser, no owner cookie, nothing sent to the
// cloud. An agent's client is registered with T3's peer-link marker and the agent's name, so T3 itself fences the
// thread: the session changes only threads it started. The owner session is an ordinary client (the fence does not
// apply to it) at Auto-accept edits or above, so it can stop a peer's thread; no gate call is ever forwarded with it.

export interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

export function memorySecretStore(): SecretStore {
  const map = new Map<string, string>()

  return { get: key => map.get(key), set: (key, value) => void map.set(key, value), delete: key => void map.delete(key) }
}

export interface PairingCodes {
  create(label: string): Promise<string>
}

/** `t3 auth pairing create --ttl 10m --label <label> --json`, run against the account's home. */
export function createT3PairingCodes(options: {
  executable: string
  home: string
  environment: Record<string, string>
  run?: CommandRunner
}): PairingCodes {
  const run = options.run ?? execCommand

  return {
    async create(label) {
      const result = await run(
        options.executable,
        ['auth', 'pairing', 'create', '--ttl', '10m', '--label', label, '--json'],
        { ...options.environment, T3CODE_HOME: options.home, T3CODE_TELEMETRY_ENABLED: 'false' }
      )

      const credential = result.code === 0 ? (JSON.parse(result.stdout) as { credential?: unknown }).credential : undefined

      if (typeof credential !== 'string' || !credential) {
        throw new Error('t3_pairing_code_unavailable')
      }

      return credential
    }
  }
}

export interface SessionIdSource {
  sessionIds(): Promise<string[]>
  revokeSession(id: string): Promise<void>
}

export interface T3SessionsOptions {
  /** Loopback origin of the running session server. */
  origin(): string | undefined
  pairing: PairingCodes
  auth: SessionIdSource
  store: SecretStore
  /** The name T3 shows for the agent's threads. */
  agentName(principal: string): string
  /** Every agent principal the gate knows, so a reset can forget sessions that are only in the store. */
  knownAgents(): string[]
  /** A new session is issued only when that agent has no unfinished thread (plan §11.2). */
  unfinished(principal: string): boolean
  /** At or below D8's ceiling for agents; at least Auto-accept edits for the owner session. */
  agentAccess?: string
  ownerAccess?: string
  fetch?: typeof fetch
}

const REDIRECT = 'http://127.0.0.1:9/cb'

interface Stored {
  token: string
  sessionId: string
}

export class T3Sessions implements GateSessions {
  private readonly agents = new Map<string, Stored>()
  private ownerSession: Stored | undefined
  private readonly pending = new Map<string, Promise<Stored>>()
  private readonly doFetch: typeof fetch

  constructor(private readonly options: T3SessionsOptions) {
    this.doFetch = options.fetch ?? fetch
  }

  private load(key: string): Stored | undefined {
    const raw = this.options.store.get(key)

    if (!raw) {
      return undefined
    }

    try {
      const value = JSON.parse(raw) as Stored

      return typeof value.token === 'string' && typeof value.sessionId === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }

  agentSessionId(principal: string): string | undefined {
    return (this.agents.get(principal) ?? this.load(`agent:${principal}`))?.sessionId
  }

  async agent(principal: string): Promise<GateSession> {
    const cached = this.agents.get(principal) ?? this.load(`agent:${principal}`)

    if (cached) {
      this.agents.set(principal, cached)

      return cached
    }

    if (this.options.unfinished(principal)) {
      throw new Error('session_replacement_blocked')
    }

    const key = `agent:${principal}`
    const issued = await this.once(key, () => this.issue({ peer: true, name: this.options.agentName(principal), access: this.options.agentAccess ?? 'auto-accept-edits' }))

    this.agents.set(principal, issued)
    this.options.store.set(key, JSON.stringify(issued))

    return issued
  }

  async owner(): Promise<GateSession> {
    const cached = this.ownerSession ?? this.load('owner')

    if (cached) {
      this.ownerSession = cached

      return cached
    }

    const issued = await this.once('owner', () => this.issue({ peer: false, name: 'Atum Work (owner)', access: this.options.ownerAccess ?? 'auto-accept-edits' }))

    this.ownerSession = issued
    this.options.store.set('owner', JSON.stringify(issued))

    return issued
  }

  private once(key: string, make: () => Promise<Stored>): Promise<Stored> {
    let inflight = this.pending.get(key)

    if (!inflight) {
      inflight = make().finally(() => this.pending.delete(key))
      this.pending.set(key, inflight)
    }

    return inflight
  }

  /**
   * The session id stays (in memory and in the store) until T3 confirms the session is gone, so a failed revocation
   * is found and retried by the next pass instead of being forgotten. A session T3 no longer lists counts as revoked.
   */
  async revokeAgent(principal: string): Promise<void> {
    const current = this.agents.get(principal) ?? this.load(`agent:${principal}`)

    if (current) {
      try {
        await this.options.auth.revokeSession(current.sessionId)
      } catch (error) {
        const listed = await this.options.auth.sessionIds().then(ids => ids.includes(current.sessionId), () => true)

        if (listed) {
          throw error
        }
      }
    }

    this.agents.delete(principal)
    this.options.store.delete(`agent:${principal}`)
  }

  async revokeAll(principals: string[]): Promise<void> {
    for (const principal of principals) {
      await this.revokeAgent(principal)
    }
  }

  forgetAll(): void {
    for (const principal of [...this.agents.keys(), ...this.options.knownAgents()]) {
      this.options.store.delete(`agent:${principal}`)
    }

    this.agents.clear()
    this.ownerSession = undefined
    this.options.store.delete('owner')
  }

  private async issue(input: { peer: boolean; name: string; access: string }): Promise<Stored> {
    const origin = this.options.origin()

    if (!origin) {
      throw new Error('t3_not_serving')
    }

    const { token, sessionId } = await issueT3McpSession({ ...input, origin, pairing: this.options.pairing, fetch: this.doFetch })

    return { token, sessionId }
  }
}

interface IssueOptions {
  origin: string
  registrationEndpoint?: string
  pairing: PairingCodes
  peer: boolean
  name: string
  access: string
  fetch?: typeof fetch
  now?: () => number
}

/** The native DCR, pairing approval and PKCE exchange shared by the gate and Connect publication. */
export async function issueT3McpSession(input: IssueOptions): Promise<Stored & { expiresAt: number }> {
  const { origin, fetch: request = fetch, now = Date.now } = input
  const post = async (url: string, body: object | URLSearchParams, failure: string) => {
    const form = body instanceof URLSearchParams
    const response = await request(url, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {throw new Error(failure)}

    return response.json().catch(() => {throw new Error(failure)})
  }
  const { client_id } = await post(input.registrationEndpoint ?? `${origin}/oauth/mcp/register`, {
    client_name: input.name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    ...(input.peer ? { software_id: 't3code-peer-link' } : {})
  }, 't3_oauth_register_failed')

  if (typeof client_id !== 'string' || !client_id) {throw new Error('t3_oauth_register_failed')}

  const code = await input.pairing.create(`oauth-${input.peer ? 'peer' : 'owner'}`)
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const resource = `${origin}/mcp`
  const { redirectTo } = await post(`${origin}/oauth/mcp/decision`, {
    authorization: {
      response_type: 'code', client_id, redirect_uri: REDIRECT, state, resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
    },
    decision: { _tag: 'pairing-code', access: input.access, code }
  }, 't3_oauth_decision_failed')

  const callback = typeof redirectTo === 'string' ? new URL(redirectTo) : undefined
  const authCode = callback?.searchParams.get('code')

  if (!callback || !authCode || callback.searchParams.get('state') !== state ||
      `${callback.origin}${callback.pathname}` !== REDIRECT || callback.username || callback.password) {
    throw new Error('t3_oauth_decision_failed')
  }

  const requestedAt = now()
  const { access_token, expires_in } = await post(`${origin}/oauth/mcp/token`, new URLSearchParams({
    grant_type: 'authorization_code', code: authCode, redirect_uri: REDIRECT, client_id, code_verifier: verifier, resource
  }), 't3_oauth_token_failed')

  // T3 SessionStore signs base64url session claims containing sid. Read it only from the token exchanged
  // directly with loopback Work. A global list diff races concurrent sign-ins.
  if (typeof access_token !== 'string' || !/^[\w-]+\.[\w-]+$/u.test(access_token)) {
    throw new Error('t3_oauth_token_failed')
  }

  let claims: { kind?: unknown; sid?: unknown } | null

  try {
    claims = JSON.parse(Buffer.from(access_token.split('.')[0], 'base64url').toString('utf8'))
  } catch {
    throw new Error('t3_session_unidentified')
  }

  if (claims?.kind !== 'session' || typeof claims.sid !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(claims.sid)) {
    throw new Error('t3_session_unidentified')
  }

  return { token: access_token, sessionId: claims.sid, expiresAt: typeof expires_in === 'number' ? requestedAt + expires_in * 1000 : 0 }
}

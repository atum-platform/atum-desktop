import { createHash, randomBytes } from 'node:crypto'

import { type CommandRunner, execCommand } from '../session/t3-auth'

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

const REDIRECT = 'http://127.0.0.1:9/cb'

interface IssueOptions {
  origin: string
  registrationEndpoint?: string
  pairing: PairingCodes
  name: string
  access: string
  fetch?: typeof fetch
  now?: () => number
}

/** The native DCR, pairing approval and PKCE exchange for Connect publication. */
export async function issueT3McpSession(input: IssueOptions): Promise<{ token: string; sessionId: string; expiresAt: number }> {
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
    token_endpoint_auth_method: 'none'
  }, 't3_oauth_register_failed')

  if (typeof client_id !== 'string' || !client_id) {throw new Error('t3_oauth_register_failed')}

  const code = await input.pairing.create('oauth-owner')
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

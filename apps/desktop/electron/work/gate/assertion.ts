import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from 'jose'

// Cloudflare Access's signed assertion (plan §11.2 "Who is calling", K34; S0-3). The gate validates it itself,
// with a standard JWT library, whether or not the connector checked it first:
//   RS256 only; the signature by the key whose `kid` matches, from the team's certs (cached, fetched again on an
//   unknown `kid`; with none cached and none fetchable the answer is refuse); `iss` exactly the team's issuer;
//   `aud`, a string or an array, holds THIS Mac's Work application tag; `exp` ahead; `nbf`, when present, not
//   ahead; a service token (`common_name` present, `sub` empty); and, under D20, `common_name` is one of the
//   enrollment's Access Client IDs (one, or two during a rotation). The typed detail is for the gate's log and
//   never goes on the wire.

export type AssertionResult = { ok: true; commonName: string } | { ok: false; detail: string }

export interface AccessVerifierOptions {
  /** `<team>.cloudflareaccess.com` */
  teamDomain: string
  /** This Mac's Work application's audience tag. */
  audience: string
  /** The enrollment's Access Client IDs, read on every call so a rotation needs no restart. */
  clientIds(): readonly string[]
  fetchJwks?(url: string): Promise<unknown>
  now?(): number
  /** The least time between two certs fetches caused by unknown `kid`s. */
  refetchFloorMs?: number
}

const MAX_TOKEN_BYTES = 8192

async function defaultFetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' })

  if (!response.ok) {
    throw new Error(`certs_http_${response.status}`)
  }

  return response.json()
}

function keysOf(value: unknown): JSONWebKeySet | undefined {
  const keys = (value as { keys?: unknown } | undefined)?.keys

  if (!Array.isArray(keys)) {
    return undefined
  }

  return { keys: keys.filter(key => key && typeof key === 'object' && (key as { kty?: string }).kty === 'RSA') } as JSONWebKeySet
}

export class AccessVerifier {
  private jwks: JSONWebKeySet = { keys: [] }
  private fetchedAt = 0
  private inflight?: Promise<void>
  private readonly issuer: string

  constructor(private readonly options: AccessVerifierOptions) {
    this.issuer = `https://${options.teamDomain}`
  }

  private async refetch(): Promise<void> {
    const now = (this.options.now ?? Date.now)()

    if (this.inflight) {
      return this.inflight
    }

    if (now - this.fetchedAt < (this.options.refetchFloorMs ?? 10_000) && this.jwks.keys.length > 0) {
      return
    }

    this.inflight = (async () => {
      try {
        const fresh = keysOf(await (this.options.fetchJwks ?? defaultFetchJwks)(`${this.issuer}/cdn-cgi/access/certs`))

        if (fresh && fresh.keys.length > 0) {
          this.jwks = fresh
        }
      } catch {
        // keep what is cached; an unknown kid with nothing fetchable is refused below
      } finally {
        this.fetchedAt = (this.options.now ?? Date.now)()
        this.inflight = undefined
      }
    })()

    return this.inflight
  }

  async verify(token: string): Promise<AssertionResult> {
    if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
      return { ok: false, detail: 'malformed' }
    }

    if (this.jwks.keys.length === 0) {
      await this.refetch()
    }

    const attempt = async () =>
      jwtVerify(token, createLocalJWKSet(this.jwks), {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.options.audience,
        currentDate: new Date((this.options.now ?? Date.now)()),
        requiredClaims: ['exp']
      })

    let verified: Awaited<ReturnType<typeof attempt>>

    try {
      try {
        verified = await attempt()
      } catch (error) {
        if (!(error instanceof errors.JWKSNoMatchingKey)) {
          throw error
        }

        await this.refetch()
        verified = await attempt()
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.constructor.name : 'invalid' }
    }

    const claims = verified.payload as { common_name?: unknown; sub?: unknown }

    if (typeof claims.common_name !== 'string' || !claims.common_name) {
      return { ok: false, detail: 'not_a_service_token' }
    }

    if (claims.sub !== undefined && claims.sub !== '') {
      return { ok: false, detail: 'user_identity' }
    }

    if (!this.options.clientIds().includes(claims.common_name)) {
      return { ok: false, detail: 'client_id_not_enrolled' }
    }

    return { ok: true, commonName: claims.common_name }
  }
}

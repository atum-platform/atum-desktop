import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import * as oidc from 'openid-client'

import { MATRIX_CALLBACK_PAGE_HEADERS, type MatrixCallbackPage, matrixCallbackPage } from './callback-page'

/** Ends a callback request on one of Atum's own pages (callback-page.ts), in the browser's language
 * where Atum speaks it. */
function page(req: IncomingMessage, res: ServerResponse, status: number, kind: MatrixCallbackPage) {
  res.writeHead(status, MATRIX_CALLBACK_PAGE_HEADERS).end(matrixCallbackPage(kind, req.headers['accept-language']))
}

export interface NativeGrant {
  accessToken: string
  refreshToken: string
  issuer: string
  subject: string
  expiresAt?: number
}

/** Library-owned OAuth; this adapter owns only the callback and commit lifetime. */
export async function authorizeNative<T>({
  config,
  issuer,
  scope,
  port,
  prepare,
  commit,
  discard,
  continueTo,
  onCallback,
  prompt,
  // Browser registration, email verification and upstream MFA need more time
  // than an already-registered password login. Expiry is not user cancellation.
  timeoutMs = 15 * 60_000
}: {
  config: oidc.Configuration
  issuer: string
  scope: string
  port: number
  prepare: (grant: NativeGrant) => Promise<T>
  commit: (value: T) => void
  discard: (grant: NativeGrant) => Promise<void>
  /** Next authorization in the same browser tab (one trip for both grants), if any. It may
   * take a moment to be ready (the caller bounds it); nothing it does fails the sign-in. */
  continueTo?: () => string | undefined | Promise<string | undefined>
  /** The browser is back with this authorization's answer: called once, after the state check
   * and before the code is redeemed, so the app can come to the front while the rest plays. */
  onCallback?: () => void
  /** `create` asks the server for its registration page (OpenID "prompt=create"). */
  prompt?: 'create'
  timeoutMs?: number
}) {
  const verifier = oidc.randomPKCECodeVerifier()
  const challenge = await oidc.calculatePKCECodeChallenge(verifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  let live = true
  let consumed = false
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  let timer: ReturnType<typeof setTimeout>
  let redirectUri: string

  const completed = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  void completed.catch(() => {})

  const finish = () => {
    live = false
    clearTimeout(timer)
    listener.close()
    listener.closeIdleConnections()
  }

  const cancel = () => {
    finish()
    reject(new Error('matrix_login_cancelled'))
  }

  const listener = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let url: URL

    try {
      url = new URL(req.url ?? '/', redirectUri)
    } catch {
      page(req, res, 400, 'failed')

      return
    }

    if (
      req.method !== 'GET' ||
      req.headers.host !== new URL(redirectUri).host ||
      url.origin !== new URL(redirectUri).origin ||
      url.pathname !== '/callback'
    ) {
      page(req, res, 404, 'missing')

      return
    }

    if (!live || consumed || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
      page(req, res, 400, 'failed')

      return
    }

    consumed = true
    let grant: NativeGrant | undefined
    let committed = false

    // The person is back from the browser: the app comes to the front now, while the code is
    // redeemed and any next step plays in the tab behind it. Never fails the callback.
    try {
      onCallback?.()
    } catch {
      // Bringing a window forward is a courtesy.
    }

    try {
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce
      })

      const claims = tokens.claims()
      // Preserve issued credentials for cleanup even if identity validation fails.
      grant = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? '',
        issuer: claims?.iss ?? '',
        subject: claims?.sub ?? '',
        ...(typeof tokens.expires_in === 'number' ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {})
      }

      if (!grant.refreshToken || !grant.subject || grant.issuer !== issuer) {
        throw new Error('invalid_identity')
      }

      const value = await prepare(grant)

      if (!live) {
        throw new Error('expired_callback')
      }

      // This synchronous guarded commit is the ONLY persistence point. Async
      // prepare cannot save late credentials after cancellation or logout.
      commit(value)
      committed = true

      // Committed: nothing after this line may fail the sign-in. The caller learns the next
      // step's outcome from that step itself, so it is decided before the sign-in resolves.
      try {
        const next = await continueTo?.()

        if (next && httpsUrl(next)) {
          res.writeHead(302, { Location: next }).end()
        } else {
          page(req, res, 200, 'signed_in')
        }
      } catch {
        if (!res.headersSent) {
          page(req, res, 200, 'signed_in')
        }
      }

      resolve(value)
    } catch (error) {
      if (grant && !committed) {
        await discard(grant).catch(() => {})
      }

      page(req, res, 400, 'failed')
      const cancelled = error instanceof oidc.AuthorizationResponseError && error.error === 'access_denied'
      reject(new Error(cancelled ? 'matrix_login_cancelled' : 'matrix_login_failed'))
    } finally {
      finish()
    }
  })

  await new Promise<void>((yes, no) => {
    listener.once('error', no)
    listener.listen(port, '127.0.0.1', yes)
  })
  const address = listener.address()

  if (!address || typeof address === 'string') {
    throw new Error('matrix_callback_unavailable')
  }

  redirectUri = `http://127.0.0.1:${address.port}/callback`
  timer = setTimeout(() => {
    finish()
    reject(new Error('matrix_login_timed_out'))
  }, timeoutMs)

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(prompt ? { prompt } : {})
  }).href

  return { authorizationUrl, completed, cancel }
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

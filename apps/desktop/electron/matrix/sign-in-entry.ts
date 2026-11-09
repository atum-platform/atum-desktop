import type { MatrixEmailSignIn, MatrixSignInMethod } from '../../shared/matrix'

/**
 * Google's upstream provider in MAS (atum-platform `deploy/chat/signup.py` and
 * `google-config.py` pin this ID).
 */
export const MATRIX_GOOGLE_PROVIDER = '01J00000000000000000000005'

/** MAS's IDs are ULIDs (Crockford base 32). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const PROBE_MS = 8_000

/** `issuer provider` pairs this run saw MAS offer (its own redirect to the provider, or its
 * page naming it): Google's hop is built blind only for a provider confirmed this way. */
const confirmedProviders = new Set<string>()

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** A redirect to the issuer itself; anything else is not MAS's own next step. */
function redirectTo(response: Response, from: string, issuer: string): URL | undefined {
  const location = response.headers.get('location')

  if (response.status < 300 || response.status >= 400 || !location) {
    return undefined
  }

  try {
    const url = new URL(location, from)

    return url.origin === issuer && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

/** A grant's step at MAS, continuing the authorization `grant` (MAS's own `kind`/`id` query). */
function grantStep(issuer: string, path: string, grant: string): string {
  const url = new URL(path, issuer)
  url.search = new URLSearchParams({ kind: 'continue_authorization_grant', id: grant }).toString()

  return url.href
}

/**
 * Where the browser opens for a way in, so nobody sees a page they did not ask for
 * (atum-platform  A2; proven on MAS
 * 1.24 by the signup proof's case 11):
 *
 * - MAS's `/authorize` creates the grant and redirects to its sign-in page (or, with
 *   `prompt=create`, its registration page) carrying the grant's ID. The grant is not tied
 *   to a browser, so asking from here is safe, and PKCE, state and the loopback callback
 *   still guard the result.
 * - **Google** continues that grant at MAS's Google hop, built from the grant's ID, so Google's
 *   account picker is the first page whether MAS's sign-in page would redirect there (passwords
 *   off: then MAS's own redirect is followed) or show itself (passwords on). MAS's page escapes
 *   its links (`&#x2f;`), so the hop is never read from its HTML; the page only has to name the
 *   provider at all, else (a server without Google) MAS's own page opens.
 * - **Email** opens MAS's own sign-in page for the grant. When MAS has no passwords it goes
 *   straight on to its only provider; then this refuses with `matrix_password_unavailable`
 *   rather than send someone who chose email to Google.
 * - **Create** opens MAS's password registration form for the grant when the server takes new
 *   accounts by email (`registration`: discovery lists `prompt=create`, MAS discovery.rs:142-148),
 *   not its chooser of ways (Google is its own button here); otherwise its registration page,
 *   refused like email when it goes straight on to a provider.
 *
 * Anything unexpected (offline, another MAS version) opens the plain authorization URL: MAS's
 * own page, never a broken link. So does Google when MAS's page can't be checked, unless this
 * run already saw this server offer that provider (`confirmed`): the pinned ID is production's,
 * and a hop to a provider the server lacks is a broken page.
 */
export async function matrixSignInEntry({
  authorizationUrl,
  method,
  registration = false,
  provider = MATRIX_GOOGLE_PROVIDER,
  fetch: request = (input, init) => fetch(input, init),
  timeoutMs = PROBE_MS,
  confirmed = confirmedProviders
}: {
  authorizationUrl: string
  method: MatrixSignInMethod
  /** The server takes new accounts by email (discovery's `prompt_values_supported` has `create`). */
  registration?: boolean
  provider?: string
  fetch?: Fetch
  timeoutMs?: number
  /** The providers seen offered by each server (`issuer provider`); this run's by default. */
  confirmed?: Set<string>
}): Promise<string> {
  const issuer = new URL(authorizationUrl).origin
  const known = `${issuer} ${provider}`

  const probe = (url: string) =>
    request(url, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    })

  let page: URL | undefined

  try {
    page = redirectTo(await probe(authorizationUrl), authorizationUrl, issuer)
  } catch {
    return authorizationUrl
  }

  const grant = page?.searchParams.get('id') ?? ''

  if (!page || page.searchParams.get('kind') !== 'continue_authorization_grant' || !ULID.test(grant)) {
    return authorizationUrl
  }

  if (method === 'create' && registration) {
    return grantStep(issuer, '/register/password', grant)
  }

  const google = ULID.test(provider) ? grantStep(issuer, `/upstream/authorize/${provider}`, grant) : undefined
  let shown: Response

  try {
    shown = await probe(page.href)
  } catch {
    if (method !== 'google') {
      return page.href
    }

    return google && confirmed.has(known) ? google : authorizationUrl
  }

  const onward = redirectTo(shown, page.href, issuer)
  const straightToProvider = onward?.pathname.startsWith('/upstream/authorize/') ?? false

  if (onward?.pathname === `/upstream/authorize/${provider}`) {
    confirmed.add(known)
  }

  if (method !== 'google') {
    if (straightToProvider) {
      throw new Error('matrix_password_unavailable')
    }

    return page.href
  }

  // MAS's own choice of where this grant goes next.
  if (straightToProvider) {
    return onward!.href
  }

  if (!google) {
    return page.href
  }

  // MAS shows its own page: Google's hop, unless the page plainly has no Google at all.
  const html = shown.ok ? await shown.text().catch(() => undefined) : undefined

  if (html?.includes(provider)) {
    confirmed.add(known)
  }

  return html !== undefined && !html.includes(provider) ? page.href : google
}

/**
 * Whether the sign-in server takes email sign-in at all, asked once in the background when
 * the sign-in window opens so the window offers only ways in that work. It is the same two
 * steps as an email sign-in above, on a throwaway authorization of the app's own (MAS keeps
 * an unused grant only until it expires; nothing signs in): MAS's own page for the grant
 * either shows (`available`) or goes straight on to its only provider because passwords are
 * off (`unavailable`). Anything else, offline included, is `unknown`, and the window keeps
 * both ways (the sign-in itself still refuses an email sign-in the server can't take).
 */
export async function matrixEmailSignIn({
  authorizationUrl,
  fetch: request = (input, init) => fetch(input, init),
  timeoutMs = PROBE_MS
}: {
  authorizationUrl: string
  fetch?: Fetch
  timeoutMs?: number
}): Promise<MatrixEmailSignIn> {
  const issuer = new URL(authorizationUrl).origin

  const probe = (url: string) =>
    request(url, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    })

  try {
    const page = redirectTo(await probe(authorizationUrl), authorizationUrl, issuer)

    if (
      !page ||
      page.searchParams.get('kind') !== 'continue_authorization_grant' ||
      !ULID.test(page.searchParams.get('id') ?? '')
    ) {
      return 'unknown'
    }

    const shown = await probe(page.href)

    if (redirectTo(shown, page.href, issuer)?.pathname.startsWith('/upstream/authorize/')) {
      return 'unavailable'
    }

    return shown.ok ? 'available' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Main's answer to "does the server take email sign-in", for every snapshot while nobody is
 * signed in. `want` starts the background probe when the answer is still unknown (at most
 * once per `retryMs`, so an offline Mac doesn't keep asking); `learn` records an answer a
 * sign-in found out by itself. `onChange` republishes the snapshot.
 */
export function matrixEmailSignInState({
  probe,
  onChange,
  now = Date.now,
  retryMs = 60_000
}: {
  probe(): Promise<MatrixEmailSignIn>
  onChange(): void
  now?: () => number
  retryMs?: number
}) {
  let value: MatrixEmailSignIn = 'unknown'
  let running = false
  let tried = Number.NEGATIVE_INFINITY

  const learn = (next: MatrixEmailSignIn) => {
    if (next !== 'unknown' && next !== value) {
      value = next
      onChange()
    }
  }

  return {
    value: () => value,
    learn,
    want() {
      if (value !== 'unknown' || running || now() - tried < retryMs) {
        return
      }

      running = true
      tried = now()
      void probe()
        .catch((): MatrixEmailSignIn => 'unknown')
        .then(answer => {
          running = false

          if (value === 'unknown') {
            learn(answer)
          }
        })
    }
  }
}

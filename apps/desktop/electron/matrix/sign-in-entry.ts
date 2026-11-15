import type { MatrixEmailSignIn, MatrixSignInMethod } from '../../shared/matrix'

/** MAS's IDs are ULIDs (Crockford base 32). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const PROBE_MS = 8_000

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

/** Provider IDs from MAS's own links, including Minijinja's escaped slashes. */
function offeredProviders(html: string, page: URL): string[] {
  const providers = new Set<string>()

  for (const link of html.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])(.*?)\1/gi)) {
    const href = link[2].replace(/&#(?:x2f|47);/gi, '/').replace(/&amp;/g, '&')

    try {
      const url = new URL(href, page)
      const provider = url.pathname.match(/^\/upstream\/authorize\/([^/]+)$/)?.[1]

      if (url.origin === page.origin && !url.username && !url.password && provider && ULID.test(provider)) {
        providers.add(provider)
      }
    } catch {
      // An unfamiliar link leaves selection to MAS.
    }
  }

  return [...providers]
}

/**
 * Continue MAS's own grant without pinning a deployment's upstream provider ID.
 * A sole offered provider can be opened directly; multiple providers always open MAS's
 * chooser. An optional hint is used only if it matches that sole provider.
 * Email/create keep MAS's page, refusing only its automatic hop to a sole provider when
 * passwords are off. A provider-only chooser remains usable for an in-flight email attempt.
 * Password registration still uses discovery's explicit registration capability.
 * An unreadable or unexpected page leaves provider selection to MAS;
 * no previous provider offer is cached, since MAS's provider list can change between attempts.
 */
export async function matrixSignInEntry({
  authorizationUrl,
  method,
  registration = false,
  provider,
  fetch: request = (input, init) => fetch(input, init),
  timeoutMs = PROBE_MS
}: {
  authorizationUrl: string
  method: MatrixSignInMethod
  /** The server takes new accounts by email (discovery's `prompt_values_supported` has `create`). */
  registration?: boolean
  /** Optional upstream hint; it never overrides MAS's multi-provider chooser. */
  provider?: string
  fetch?: Fetch
  timeoutMs?: number
}): Promise<string> {
  const issuer = new URL(authorizationUrl).origin

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

  let shown: Response

  try {
    shown = await probe(page.href)
  } catch {
    return method === 'google' ? authorizationUrl : page.href
  }

  const onward = redirectTo(shown, page.href, issuer)
  const straightToProvider = onward?.pathname.startsWith('/upstream/authorize/') ?? false

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

  const html = shown.ok ? await shown.text().catch(() => undefined) : undefined
  const providers = html === undefined ? [] : offeredProviders(html, page)
  const sole = providers.length === 1 ? providers[0] : undefined

  return sole && (provider === undefined || provider === sole)
    ? grantStep(issuer, `/upstream/authorize/${sole}`, grant)
    : page.href
}

/**
 * Whether the sign-in server takes email sign-in at all, asked once in the background when
 * the sign-in window opens so the window offers only ways in that work. It is the same two
 * steps as an email sign-in above, on a throwaway authorization of the app's own (MAS keeps
 * an unused grant only until it expires; nothing signs in): MAS's own page for the grant
 * either has a password input (`available`), goes straight on to its only provider, or shows
 * a provider-only chooser (`unavailable`). Anything else, offline included, is `unknown`,
 * and the window keeps both ways. In-flight email attempts can still open MAS's chooser.
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

    const html = shown.ok ? await shown.text() : undefined

    if (html === undefined) {
      return 'unknown'
    }

    if (/<input\b[^>]*\stype\s*=\s*(?:"password"|'password'|password(?=[\s>]))/i.test(html)) {
      return 'available'
    }

    return offeredProviders(html, page).length ? 'unavailable' : 'unknown'
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

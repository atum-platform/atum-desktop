import path from 'node:path'

interface Request {
  path: string
  method: string
  body?: unknown
}

/** Closed HTTP metadata for native diagnostics; response bodies remain discarded. */
export class MatrixHermesPagesHttpError extends Error {
  constructor(
    message: 'pages_invalid_request' | 'pages_request_failed',
    readonly httpStatus: number
  ) {
    super(message)
    this.name = 'MatrixHermesPagesHttpError'
  }
}

/** Native-only REST over the existing owned Hermes backend. Hermes resolves its
 * profiles; Atum selects the one whose home it actually launched. A directory
 * named `profiles` has special meaning upstream, so `default` is not always
 * the current process's home. Neither the catalog nor bearer reaches a page. */
export function createHermesPagesTransport(port: number, token: string, home: string, lifetime: AbortSignal) {
  const json = async (request: Request) => {
    const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: 'error',
      signal: AbortSignal.any([lifetime, AbortSignal.timeout(60_000)])
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new MatrixHermesPagesHttpError(
        response.status === 400 ? 'pages_invalid_request' : 'pages_request_failed',
        response.status
      )
    }

    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0

    if (!reader) {
      throw new Error('pages_request_failed')
    }

    try {
      while (true) {
        const next = await reader.read()

        if (next.done) {
          break
        }

        bytes += next.value.byteLength

        if (bytes > 8 * 1024 * 1024) {
          throw new Error('pages_response_too_large')
        }

        chunks.push(next.value)
      }

      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  let resolved: Promise<string> | undefined

  const profile = () =>
    (resolved ??= json({ path: '/api/profiles', method: 'GET' })
      .then(value => {
        const profiles = (value as { profiles?: Array<{ name?: unknown; path?: unknown }> })?.profiles

        const matches = Array.isArray(profiles)
          ? profiles.filter(
              each =>
                typeof each?.path === 'string' &&
                path.isAbsolute(each.path) &&
                path.resolve(each.path) === path.resolve(home)
            )
          : []

        const name = matches.length === 1 ? matches[0].name : undefined

        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,199}$/.test(name) || name === 'all') {
          throw new Error('pages_profile_unavailable')
        }

        return name
      })
      .catch(error => {
        resolved = undefined
        throw error
      }))

  return async (request: Request) => {
    // Requests already passed the separate exact route/body allowlist. Only
    // native code can substitute this reserved profile placeholder.
    const url = new URL(request.path, 'http://pages.invalid')

    if (url.origin !== 'http://pages.invalid' || url.searchParams.get('profile') !== 'default') {
      throw new Error('pages_request_forbidden')
    }

    url.searchParams.set('profile', await profile())
    lifetime.throwIfAborted()

    return json({ ...request, path: `${url.pathname}?${url.searchParams}` })
  }
}

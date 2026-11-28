import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { atumOAuthCompletionHtml } from '../atum-oauth-completion-page'

/** As with Google, native main owns the loopback listener, verifier, and code exchange. */
export async function authorizeOpenRouterFree({
  openExternal,
  signal,
  fetchImpl = fetch
}: {
  openExternal(url: string): Promise<void>
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  lifetime.throwIfAborted()
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  // A denied OpenRouter callback omits state. Its private path still identifies this attempt.
  const path = '/callback/' + state
  let finish!: (code: string) => void
  let fail!: (error: Error) => void
  const callback = new Promise<string>((resolve, reject) => {
    finish = resolve
    fail = reject
  })

  void callback.catch(() => undefined)

  const abort = () => fail(new Error('openrouter_authorization_cancelled'))
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    const url = new URL('http://localhost' + (request.url ?? '/'))

    if (request.method !== 'GET' || url.pathname !== path) {
      response.writeHead(400).end(atumOAuthCompletionHtml('invalid-response'))

      return
    }

    const code = url.searchParams.get('code')

    if (!code || url.searchParams.has('error')) {
      response.end(atumOAuthCompletionHtml('connection-denied'))
      fail(new Error('openrouter_authorization_denied'))

      return
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end(atumOAuthCompletionHtml('invalid-response'))

      return
    }

    response.end(atumOAuthCompletionHtml('connection-approved'))
    finish(code)
  })
  lifetime.addEventListener('abort', abort, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    lifetime.throwIfAborted()
    const address = server.address()

    if (!address || typeof address === 'string') {
      throw new Error('openrouter_callback_unavailable')
    }

    const url = new URL('https://openrouter.ai/auth')
    url.search = new URLSearchParams({
      callback_url: `http://localhost:${address.port}${path}`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      key_label: 'Atum Free',
      state,
      limit: '0.01'
    }).toString()
    await openExternal(url.toString())
    const code = await callback
    const response = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      redirect: 'error',
      signal: lifetime
    })

    if (!response.ok) {
      throw new Error('openrouter_exchange_failed')
    }

    const { key } = await response.json()

    if (typeof key !== 'string' || !/^sk-or-v1-[A-Za-z0-9_-]{32,128}$/u.test(key)) {
      throw new Error('openrouter_exchange_failed')
    }

    return key
  } finally {
    lifetime.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections()
  }
}

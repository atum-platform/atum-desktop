import { describe, expect, it, vi } from 'vitest'

import { matrixEmailSignIn, matrixEmailSignInState, matrixSignInEntry } from './sign-in-entry'

const googleProvider = '01J00000000000000000000005'
const appleProvider = '01J0000000000000000000000A'

const issuer = 'https://auth.example'
const grant = '01K6ZQ3W4X5Y6Z7A8B9C0D1E2F'
const authorize = `${issuer}/authorize?client_id=matrix&state=s&code_challenge=c`
const chooser = `${issuer}/login?kind=continue_authorization_grant&id=${grant}`

function providerHop(provider: string) {
  return `${issuer}/upstream/authorize/${provider}?kind=continue_authorization_grant&id=${grant}`
}

/** A stand-in for MAS 1.24: `/authorize` → its page with the grant, then the page itself. */
function mas({
  page = '/login',
  passwords = true,
  providers = [googleProvider]
}: { page?: string; passwords?: boolean; providers?: string[] } = {}) {
  const pageUrl = `${page}?kind=continue_authorization_grant&id=${grant}`

  return vi.fn(async (input: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual')
    const url = new URL(input)

    if (url.pathname === '/authorize') {
      return new Response(null, { status: 303, headers: { location: pageUrl } })
    }

    if (!passwords && providers.length === 1) {
      // Passwords off and one provider: MAS goes straight on to it.
      return new Response(null, {
        status: 303,
        headers: { location: `/upstream/authorize/${providers[0]}?kind=continue_authorization_grant&id=${grant}` }
      })
    }

    // As MAS 1.24 renders it: its template engine escapes `/` in attributes as `&#x2f;`.
    const links = providers
      .map(
        id =>
          `<a href="&#x2f;upstream&#x2f;authorize&#x2f;${id}?kind=continue_authorization_grant&amp;id=${grant}">Provider</a>`
      )
      .join('')

    return new Response(`${passwords ? '<form><input name="password" type="password"></form>' : ''}${links}`, {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  })
}

describe('where the browser opens for each way in', () => {
  it("sends Google straight to Google's account picker by continuing MAS's own grant", async () => {
    const fetch = mas()
    const url = new URL(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch }))
    expect(url.origin + url.pathname).toBe(`${issuer}/upstream/authorize/${googleProvider}`)
    expect(url.searchParams.get('kind')).toBe('continue_authorization_grant')
    expect(url.searchParams.get('id')).toBe(grant)
    // The authorization MAS checks is the app's own: PKCE and state are unchanged.
    expect(fetch.mock.calls[0]![0]).toBe(authorize)
  })

  it("builds Google's hop from the grant even though MAS's page escapes its links (passwords on)", async () => {
    const fetch = mas({ passwords: true })
    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch })).toBe(
      `${issuer}/upstream/authorize/${googleProvider}?kind=continue_authorization_grant&id=${grant}`
    )
  })

  it('does not reuse a previous provider offer when the page check fails', async () => {
    await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: mas() })

    const flaky = vi.fn(async (input: string) =>
      new URL(input).pathname === '/authorize'
        ? new Response(null, { status: 303, headers: { location: chooser } })
        : Promise.reject(new TypeError('fetch failed'))
    )

    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: flaky })).toBe(authorize)
  })

  it('uses the sole provider MAS offers, without a pinned deployment ID', async () => {
    const provider = '01J00000000000000000000009'

    for (const passwords of [true, false]) {
      expect(
        await matrixSignInEntry({
          authorizationUrl: authorize,
          method: 'google',
          fetch: mas({ providers: [provider], passwords })
        })
      ).toBe(providerHop(provider))
    }
  })

  it.each([true, false])('opens MAS’s two-provider chooser (passwords: %s)', async passwords => {
    for (const providers of [
      [appleProvider, googleProvider],
      [googleProvider, appleProvider]
    ]) {
      expect(
        await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: mas({ providers, passwords }) })
      ).toBe(chooser)
    }
  })

  it('uses a hint only for the sole provider currently offered', async () => {
    for (const provider of [undefined, googleProvider]) {
      expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', provider, fetch: mas() })).toBe(
        providerHop(googleProvider)
      )
    }

    for (const provider of [appleProvider, 'not-a-provider']) {
      expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', provider, fetch: mas() })).toBe(
        chooser
      )
    }

    expect(
      await matrixSignInEntry({
        authorizationUrl: authorize,
        method: 'google',
        provider: googleProvider,
        fetch: mas({ passwords: false, providers: [appleProvider, googleProvider] })
      })
    ).toBe(chooser)
  })

  it('reads plain and escaped links, ignores foreign/invalid links, and deduplicates provider IDs', async () => {
    const href = `/upstream/authorize/${googleProvider}`

    const fetch = vi.fn(async (input: string) =>
      input === authorize
        ? new Response(null, { status: 303, headers: { location: chooser } })
        : new Response(
            [
              `<a href="${href}">Google</a>`,
              `<a href='${href.replaceAll('/', '&#47;')}'>Google again</a>`,
              `<a href="https://other.example/upstream/authorize/${appleProvider}">Foreign</a>`,
              `<a href="https://user:noreply@auth.example/upstream/authorize/${appleProvider}">Credentials</a>`,
              '<a href="/upstream/authorize/not-a-provider">Invalid</a>'
            ].join('')
          )
    )

    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch })).toBe(
      providerHop(googleProvider)
    )
  })

  it.each([200, 500])('leaves an unrecognised page to MAS (HTTP %s)', async status => {
    const fetch = vi.fn(async (input: string) =>
      input === authorize
        ? new Response(null, { status: 303, headers: { location: chooser } })
        : new Response(`Unrecognised page mentioning ${googleProvider}`, { status })
    )

    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch })).toBe(chooser)
  })

  it('opens the password registration form for a new account when the server takes them', async () => {
    const fetch = mas({ page: '/register' })
    expect(
      await matrixSignInEntry({
        authorizationUrl: `${authorize}&prompt=create`,
        method: 'create',
        registration: true,
        fetch
      })
    ).toBe(`${issuer}/register/password?kind=continue_authorization_grant&id=${grant}`)
    // One question to MAS: the grant; its chooser of ways is never opened or asked.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('follows MAS when it would go to Google by itself (passwords off)', async () => {
    const url = await matrixSignInEntry({
      authorizationUrl: authorize,
      method: 'google',
      fetch: mas({ passwords: false })
    })

    expect(url).toBe(`${issuer}/upstream/authorize/${googleProvider}?kind=continue_authorization_grant&id=${grant}`)
  })

  it("opens MAS's sign-in page for email, and its registration page for a new account", async () => {
    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'email', fetch: mas() })).toBe(
      `${issuer}/login?kind=continue_authorization_grant&id=${grant}`
    )
    expect(
      await matrixSignInEntry({
        authorizationUrl: `${authorize}&prompt=create`,
        method: 'create',
        fetch: mas({ page: '/register' })
      })
    ).toBe(`${issuer}/register?kind=continue_authorization_grant&id=${grant}`)
  })

  it('refuses email and a new account when the server has no passwords, instead of opening Google', async () => {
    for (const method of ['email', 'create'] as const) {
      await expect(
        matrixSignInEntry({ authorizationUrl: authorize, method, fetch: mas({ passwords: false }) })
      ).rejects.toThrow('matrix_password_unavailable')
    }
  })

  it.each(['email', 'create'] as const)('keeps %s usable on a provider-only chooser', async method => {
    expect(
      await matrixSignInEntry({
        authorizationUrl: authorize,
        method,
        fetch: mas({ passwords: false, providers: [appleProvider, googleProvider] })
      })
    ).toBe(chooser)
  })

  it("never opens a broken link: anything unexpected opens MAS's own page", async () => {
    // No provider links: the server's page is the authority.
    expect(
      await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: mas({ providers: [] }) })
    ).toBe(chooser)

    // Offline, or a redirect that is not MAS's grant page: the plain authorization URL.
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: offline })).toBe(authorize)
    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'email', fetch: offline })).toBe(authorize)

    for (const location of [
      'https://elsewhere.example/login?kind=continue_authorization_grant&id=' + grant,
      `/login?kind=continue_authorization_grant&id=not-a-grant`,
      `/login`
    ]) {
      const odd = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
      expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'google', fetch: odd })).toBe(authorize)
      expect(odd).toHaveBeenCalledOnce()
    }
  })

  it('still opens the email page when only the page check fails', async () => {
    const fetch = vi.fn(async (input: string) =>
      new URL(input).pathname === '/authorize'
        ? new Response(null, {
            status: 303,
            headers: { location: `/login?kind=continue_authorization_grant&id=${grant}` }
          })
        : Promise.reject(new TypeError('fetch failed'))
    )

    expect(await matrixSignInEntry({ authorizationUrl: authorize, method: 'email', fetch })).toBe(
      `${issuer}/login?kind=continue_authorization_grant&id=${grant}`
    )
  })
})

describe('whether the server takes email sign-in, for the sign-in window', () => {
  it('is available when MAS shows its own page, and unavailable when it goes straight to its provider', async () => {
    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch: mas() })).toBe('available')
    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch: mas({ passwords: false }) })).toBe(
      'unavailable'
    )
  })

  it.each([true, false])('detects password availability on the two-provider chooser (%s)', async passwords => {
    expect(
      await matrixEmailSignIn({
        authorizationUrl: authorize,
        fetch: mas({ passwords, providers: [appleProvider, googleProvider] })
      })
    ).toBe(passwords ? 'available' : 'unavailable')
  })

  it('keeps an unrecognised successful page unknown', async () => {
    const fetch = vi.fn(async (input: string) =>
      input === authorize
        ? new Response(null, { status: 303, headers: { location: chooser } })
        : new Response('<p>Unexpected page</p>')
    )

    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch })).toBe('unknown')
  })

  it('is unknown offline or for anything it does not recognise, so the window keeps both ways', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch: offline })).toBe('unknown')

    const elsewhere = vi.fn(
      async () => new Response(null, { status: 303, headers: { location: 'https://evil.example/' } })
    )

    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch: elsewhere })).toBe('unknown')

    const broken = vi.fn(async (input: string) =>
      new URL(input).pathname === '/authorize'
        ? new Response(null, {
            status: 303,
            headers: { location: `/login?kind=continue_authorization_grant&id=${grant}` }
          })
        : new Response('oops', { status: 500 })
    )

    expect(await matrixEmailSignIn({ authorizationUrl: authorize, fetch: broken })).toBe('unknown')
  })
})

describe("main's answer about email sign-in", () => {
  it('asks once in the background, republishes the answer, and never asks again once known', async () => {
    const probe = vi.fn(async () => 'unavailable' as const)
    const onChange = vi.fn()
    const email = matrixEmailSignInState({ probe, onChange })

    expect(email.value()).toBe('unknown')
    email.want()
    email.want()
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(email.value()).toBe('unavailable')
    email.want()
    expect(probe).toHaveBeenCalledOnce()
  })

  it('asks again only after its retry interval when the answer stayed unknown', async () => {
    let clock = 0
    const probe = vi.fn(async () => 'unknown' as const)
    const onChange = vi.fn()
    const email = matrixEmailSignInState({ probe, onChange, now: () => clock, retryMs: 1000 })

    email.want()
    expect(probe).toHaveBeenCalledOnce()
    // Let the unknown answer settle.
    await new Promise(resolve => setTimeout(resolve, 0))
    email.want()
    expect(probe).toHaveBeenCalledOnce()
    clock = 1000
    email.want()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes what a sign-in found out by itself', () => {
    const onChange = vi.fn()
    const email = matrixEmailSignInState({ probe: vi.fn(), onChange })

    email.learn('unavailable')
    email.learn('unavailable')
    expect(email.value()).toBe('unavailable')
    expect(onChange).toHaveBeenCalledOnce()
  })
})

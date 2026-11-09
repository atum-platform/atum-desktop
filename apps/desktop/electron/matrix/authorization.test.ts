import { request } from 'node:http'

import * as oidc from 'openid-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { authorizeNative } from './authorization'

vi.mock('openid-client', async importOriginal => ({
  AuthorizationResponseError: (await importOriginal<typeof oidc>()).AuthorizationResponseError,
  randomPKCECodeVerifier: () => 'verifier',
  calculatePKCECodeChallenge: async () => 'challenge',
  randomState: () => 'state',
  randomNonce: () => 'nonce',
  buildAuthorizationUrl: (_config: unknown, parameters: Record<string, string>) =>
    new URL(`https://id.example/authorize?${new URLSearchParams(parameters)}`),
  authorizationCodeGrant: vi.fn()
}))

const flows: Array<{ cancel(): void }> = []
afterEach(() => {
  flows.splice(0).forEach(flow => flow.cancel())
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('native callback lifetime', () => {
  const options = () => ({
    config: {} as oidc.Configuration,
    issuer: 'https://id.example',
    scope: 'openid',
    port: 0,
    prepare: vi.fn(async () => 'prepared'),
    commit: vi.fn(),
    discard: vi.fn(async () => {})
  })

  const token = () => ({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    claims: () => ({ iss: 'https://id.example', sub: 'subject' })
  })

  it('continues the same browser tab into the next authorization after committing', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    const input = { ...options(), continueTo: () => 'https://id.example/authorize?client_id=domain' }
    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    const response = await fetch(`${redirect}?state=state&code=code`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://id.example/authorize?client_id=domain')
    expect(await flow.completed).toBe('prepared')
    expect(input.commit).toHaveBeenCalledTimes(1)
  })
  it('ends on the Atum page, and an unusable next step never fails a committed sign-in', async () => {
    for (const continueTo of [
      undefined,
      () => undefined,
      () => 'not a url',
      () => 'http://id.example/plain',
      async () => {
        throw new Error('not ready')
      }
    ]) {
      vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
      const flow = await authorizeNative({ ...options(), ...(continueTo ? { continueTo } : {}) })
      flows.push(flow)
      const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
      const response = await fetch(`${redirect}?state=state&code=code`, { redirect: 'manual' })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const html = await response.text()
      expect(html).toContain('Đã đăng nhập Atum')
      expect(html).toContain('Signed in to Atum')
      expect(await flow.completed).toBe('prepared')
    }
  })
  it("Atum's pages load and run nothing, and name no token, state or server", async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    const flow = await authorizeNative(options())
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!

    for (const [path, status, title] of [
      ['/elsewhere', 404, 'Atum'],
      ['/callback?state=wrong&code=code', 400, 'Chưa đăng nhập được'],
      ['/callback?state=state&code=code', 200, 'Đã đăng nhập Atum']
    ] as const) {
      const response = await fetch(new URL(path, redirect))
      expect(response.status).toBe(status)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
      const html = await response.text()
      expect(html).toContain(`<h1>${title}</h1>`)
      expect(html).not.toMatch(/<script|src=|href=|synthetic-|state=|id\.example/)
    }
  })
  it('announces the callback once, after the state check and before the code is redeemed', async () => {
    const order: string[] = []
    vi.mocked(oidc.authorizationCodeGrant).mockImplementation(async () => {
      order.push('redeem')

      return token() as never
    })
    const onCallback = vi.fn(() => order.push('returned'))
    const flow = await authorizeNative({ ...options(), onCallback })
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!

    // A stray or forged request is not the person coming back.
    expect((await fetch(`${redirect}?state=wrong&code=code`)).status).toBe(400)
    expect(onCallback).not.toHaveBeenCalled()

    expect((await fetch(`${redirect}?state=state&code=code`)).status).toBe(200)
    expect(order).toEqual(['returned', 'redeem'])
    expect(await flow.completed).toBe('prepared')
  })
  it('never fails a sign-in because bringing the window forward threw', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)

    const flow = await authorizeNative({
      ...options(),
      onCallback: () => {
        throw new Error('window gone')
      }
    })

    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    expect((await fetch(`${redirect}?state=state&code=code`)).status).toBe(200)
    expect(await flow.completed).toBe('prepared')
  })
  it('waits for a next step that takes a moment, then sends the same tab on', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    let ready!: (url: string) => void
    const next = new Promise<string>(resolve => (ready = resolve))
    const flow = await authorizeNative({ ...options(), continueTo: () => next })
    flows.push(flow)
    const settled = vi.fn()
    void flow.completed.then(settled)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    const response = fetch(`${redirect}?state=state&code=code`, { redirect: 'manual' })
    await vi.waitFor(() => expect(oidc.authorizationCodeGrant).toHaveBeenCalled())
    // The sign-in resolves only once the next step is decided (the caller learns it from there).
    expect(settled).not.toHaveBeenCalled()
    ready('https://id.example/authorize?client_id=domain')
    expect((await response).headers.get('location')).toBe('https://id.example/authorize?client_id=domain')
    expect(await flow.completed).toBe('prepared')
  })
  it('asks for the registration page only when a new account was chosen', async () => {
    const plain = await authorizeNative(options())
    flows.push(plain)
    expect(new URL(plain.authorizationUrl).searchParams.has('prompt')).toBe(false)
    plain.cancel()
    const create = await authorizeNative({ ...options(), prompt: 'create' })
    flows.push(create)
    const url = new URL(create.authorizationUrl)
    expect(url.searchParams.get('prompt')).toBe('create')
    // Everything that guards the result is unchanged.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state')
  })
  it('checks state before library redemption and consumes the callback once', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    const input = options()
    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    expect((await fetch(`${redirect}?state=wrong&code=code`)).status).toBe(400)
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled()
    expect((await fetch(`${redirect}?state=state&code=code`)).status).toBe(200)
    expect(await flow.completed).toBe('prepared')
    expect(input.commit).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed callback URLs without exiting the process or consuming the valid callback', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    const input = options()
    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!)

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: redirect.hostname, port: redirect.port, path: '//[' }, response => {
        response.resume()
        resolve(response.statusCode)
      })

      req.on('error', reject)
      req.end()
    })

    expect(status).toBe(400)
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled()
    expect((await fetch(`${redirect}?state=state&code=code`)).status).toBe(200)
    await expect(flow.completed).resolves.toBe('prepared')
  })
  it('owns the commit guard even when async preparation finishes after cancellation', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    let finish!: (value: string) => void
    let entered!: () => void

    const started = new Promise<void>(resolve => {
      entered = resolve
    })

    const input = {
      ...options(),
      prepare: async () => {
        entered()

        return new Promise<string>(resolve => {
          finish = resolve
        })
      }
    }

    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    const response = fetch(`${redirect}?state=state&code=code`)
    await started
    flow.cancel()
    finish('late')
    expect((await response).status).toBe(400)
    await expect(flow.completed).rejects.toThrow('cancelled')
    expect(input.commit).not.toHaveBeenCalled()
    expect(input.discard).toHaveBeenCalledTimes(1)
  })
  it('reclaims an issued grant after identity preparation fails, without leaking provider errors', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)

    const input = {
      ...options(),
      prepare: async () => {
        throw new Error('private provider payload')
      }
    }

    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    const response = await fetch(`${redirect}?state=state&code=code`)
    const html = await response.text()
    expect(html).not.toContain('private provider')
    expect(html).toContain('<h1>Chưa đăng nhập được</h1>')
    await expect(flow.completed).rejects.toThrow('matrix_login_failed')
    expect(input.discard).toHaveBeenCalledTimes(1)
  })
  it('keeps onboarding alive past three minutes and reports the fifteen-minute deadline distinctly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const input = options()
    const flow = await authorizeNative(input)
    flows.push(flow)
    const settled = vi.fn()
    void flow.completed.then(settled, settled)
    await vi.advanceTimersByTimeAsync(180_001)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(720_000)
    await expect(flow.completed).rejects.toThrow('matrix_login_timed_out')
    expect(input.commit).not.toHaveBeenCalled()
  })
  it('discards a prepared grant arriving after timeout instead of committing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(oidc.authorizationCodeGrant).mockResolvedValue(token() as never)
    let finish!: (value: string) => void
    let entered!: () => void

    const started = new Promise<void>(resolve => {
      entered = resolve
    })

    const input = {
      ...options(),
      timeoutMs: 1000,
      prepare: async () => {
        entered()

        return new Promise<string>(resolve => {
          finish = resolve
        })
      }
    }

    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    const response = fetch(`${redirect}?state=state&code=code`)
    await started
    await vi.advanceTimersByTimeAsync(1000)
    await expect(flow.completed).rejects.toThrow('matrix_login_timed_out')
    finish('late')
    expect((await response).status).toBe(400)
    expect(input.commit).not.toHaveBeenCalled()
    expect(input.discard).toHaveBeenCalledTimes(1)
  })
  it('treats an authenticated-state provider denial as cancellation, without exposing provider text', async () => {
    vi.mocked(oidc.authorizationCodeGrant).mockRejectedValue(
      new oidc.AuthorizationResponseError('denied', { cause: new URLSearchParams('error=access_denied') })
    )
    const input = options()
    const flow = await authorizeNative(input)
    flows.push(flow)
    const redirect = new URL(flow.authorizationUrl).searchParams.get('redirect_uri')!
    expect((await fetch(`${redirect}?state=wrong&error=access_denied`)).status).toBe(400)
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled()
    await fetch(`${redirect}?state=state&error=access_denied`)
    await expect(flow.completed).rejects.toThrow('matrix_login_cancelled')
    expect(input.commit).not.toHaveBeenCalled()
  })
})

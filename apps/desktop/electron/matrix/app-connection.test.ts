import http from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type AppConnectionDependencies, createAppConnection, isLinkReturnUrl } from './app-connection'

const initiationId = '00000000-0000-4000-8000-232a373eb43a'
const returnCode = 'c'.repeat(43)
const ticket = 't'.repeat(43)
const attempt = 'a'.repeat(43)

const connection = {
  state: 'never_linked' as const,
  connectionRequired: true,
  available: true,
  readiness: 'not_linked' as const
}

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

async function callback(url: string, headers?: http.OutgoingHttpHeaders): Promise<number | 'error'> {
  return await new Promise(resolve => {
    const request = http.get(url, { headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })

    request.once('error', () => resolve('error'))
  })
}

async function returnPage(url: string): Promise<{ status: number; type: string; body: string }> {
  return await new Promise((resolve, reject) => {
    http
      .get(url, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.once('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8')
        })
      )
      })
      .once('error', reject)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

describe('Matrix app connection lifetime', () => {
  it('accepts only the exact loopback return and sends credentials only after an explicit confirmation', async () => {
    let redirectUri = ''
    const opened: string[] = []
    const requests: Array<{ slug: string; action: string; body?: unknown }> = []

    const app = createAppConnection({
      resource: 'https://matrix.test/api/matrix/v1',
      active: () => true,
      changed: vi.fn(),
      openExternal: async url => {
        opened.push(url)
      },
      request: async (slug, action, body) => {
        requests.push({ slug, action, body })

        if (action === 'connection') {
          return { connection }
        }

        if (action === 'connect') {
          redirectUri = (body as { redirect_uri: string }).redirect_uri

          return {
            authorize_url: `https://matrix.test/link/start?t=${ticket}&a=${attempt}`,
            initiation_id: initiationId
          }
        }

        if (action === 'confirm') {
          return { status: 'confirmed' }
        }

        throw new Error(`unexpected ${action}`)
      }
    })

    await app.begin('river')
    expect(app.snapshot().river).toEqual({ phase: 'waiting', connection })
    expect(opened).toEqual([`https://matrix.test/link/start?t=${ticket}&a=${attempt}`])
    expect(JSON.stringify(app.snapshot())).not.toContain(redirectUri)
    expect(JSON.stringify(app.snapshot())).not.toContain(ticket)
    expect(JSON.stringify(app.snapshot())).not.toContain(initiationId)

    const returnUrl = new URL(redirectUri)
    expect(
      await callback(`http://127.0.0.1:${returnUrl.port}/wrong?code=${returnCode}&initiation_id=${initiationId}`)
    ).toBe(404)
    expect(
      await callback(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`, {
        host: `localhost:${returnUrl.port}`
      })
    ).toBe(404)
    expect(await callback(`${redirectUri}?code=${returnCode}&initiation_id=00000000-0000-4000-8000-db8055e0e030`)).toBe(
      400
    )
    expect(await callback(`${redirectUri}?code=${returnCode}&code=${returnCode}&initiation_id=${initiationId}`)).toBe(
      400
    )
    expect(requests.filter(request => request.action === 'confirm')).toHaveLength(0)

    expect(await callback(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`)).toBe(200)
    expect(app.snapshot().river.phase).toBe('confirm')
    expect(await callback(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`)).toBe(400)
    expect(requests.filter(request => request.action === 'confirm')).toHaveLength(0)

    await app.confirm('river')
    expect(requests.filter(request => request.action === 'confirm')).toEqual([
      {
        slug: 'river',
        action: 'confirm',
        body: { initiation_id: initiationId, return_code: returnCode, confirmation: true }
      }
    ])
    expect(app.snapshot().river).toEqual({ phase: 'idle', connection })
    expect(JSON.stringify(app.snapshot())).not.toContain(returnCode)
    app.dispose()
  })

  it('fails closed rather than opening a non-canonical authority URL', async () => {
    const opened = vi.fn()

    const app = createAppConnection({
      resource: 'https://matrix.test',
      active: () => true,
      changed: vi.fn(),
      openExternal: opened,
      request: async (_slug, action) =>
        action === 'connection'
          ? { connection }
          : { authorize_url: `https://provider.test/anything?code=${returnCode}`, initiation_id: initiationId }
    })

    await app.begin('river')
    expect(app.snapshot().river).toEqual({ phase: 'failed', connection, error: 'unavailable' })
    expect(opened).not.toHaveBeenCalled()
    app.dispose()
  })

  // 0.19.4: the platform mints the sign-in start page on its people-facing host
  // (account.…), not the API host the Desktop calls (api.…). Requiring the API origin
  // refused every real start, so Connect did nothing and said nothing.
  it('opens the sign-in start page on the platform people-facing host and logs each step', async () => {
    const opened: string[] = []
    const lines: string[] = []
    const returned = vi.fn()
    let redirectUri = ''

    const app = createAppConnection({
      resource: 'https://api.matrix.test/api/matrix/v1',
      active: () => true,
      changed: vi.fn(),
      log: line => lines.push(line),
      returned,
      openExternal: async url => {
        opened.push(url)
      },
      request: async (_slug, action, body) => {
        if (action === 'connection') {
          return { connection }
        }

        if (action === 'connect') {
          redirectUri = (body as { redirect_uri: string }).redirect_uri

          return {
            authorize_url: `https://account.matrix.test/link/start?t=${ticket}&a=${attempt}`,
            initiation_id: initiationId
          }
        }

        return { status: 'confirmed' }
      }
    })

    await app.begin('moon')
    expect(opened).toEqual([`https://account.matrix.test/link/start?t=${ticket}&a=${attempt}`])
    expect(app.snapshot().moon.phase).toBe('waiting')
    // The page the person lands on after signing in is labelled UTF-8 (set for every response
    // up front), so the Vietnamese line reads right in Safari too.
    const page = await returnPage(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`)
    expect(page.status).toBe(200)
    expect(page.type).toMatch(/charset=utf-8/i)
    expect(page.body).toContain('đã nhận')
    expect(app.snapshot().moon.phase).toBe('confirm')
    expect(returned).toHaveBeenCalledOnce()
    await app.confirm('moon')
    expect(app.snapshot().moon.phase).toBe('idle')
    expect(lines).toEqual([
      '[Matrix] app link app=moon step=begin outcome=opened authorize=other_origin',
      '[Matrix] app link app=moon step=return outcome=received',
      '[Matrix] app link app=moon step=confirm outcome=confirmed'
    ])
    // Nothing secret in the log: no ticket, code, initiation or host.
    expect(lines.join('\n')).not.toMatch(new RegExp(`${ticket}|${returnCode}|${initiationId}|matrix\\.test`))
    app.dispose()
  })

  it.each([
    ['connection_failed', 'connection', () => Promise.reject(new Error('503'))],
    ['connect_failed', 'connect', () => Promise.reject(new Error('403'))],
    [
      'authorize_invalid',
      'connect',
      async () => ({
        authorize_url: `http://account.matrix.test/link/start?t=${ticket}&a=${attempt}`,
        initiation_id: initiationId
      })
    ]
  ] as const)('says which step failed (%s) and shows the failure instead of nothing', async (code, failing, answer) => {
    const lines: string[] = []
    const openExternal = vi.fn()

    const app = createAppConnection({
      resource: 'https://api.matrix.test',
      active: () => true,
      changed: vi.fn(),
      log: line => lines.push(line),
      openExternal,
      request: async (_slug, action) => (action === failing ? answer() : { connection })
    })

    await app.begin('andy')
    expect(app.snapshot().andy.phase).toBe('failed')
    expect(openExternal).not.toHaveBeenCalled()
    expect(lines).toEqual([`[Matrix] app link app=andy step=begin outcome=${code}`])
    app.dispose()
  })

  // Relaxing the start host to any https origin must not drop what 0.19.4 accepted: a start
  // page on the API's own origin, which is plain http for a loopback authority in local runs.
  it('still opens a start page on the API origin itself, even over loopback http', async () => {
    const opened: string[] = []
    const lines: string[] = []

    const app = createAppConnection({
      resource: 'http://127.0.0.1:4100/api/matrix/v1',
      active: () => true,
      changed: vi.fn(),
      log: line => lines.push(line),
      openExternal: async url => {
        opened.push(url)
      },
      request: async (_slug, action) =>
        action === 'connect'
          ? { authorize_url: `http://127.0.0.1:4100/link/start?t=${ticket}&a=${attempt}`, initiation_id: initiationId }
          : { connection }
    })

    await app.begin('moon')
    expect(opened).toEqual([`http://127.0.0.1:4100/link/start?t=${ticket}&a=${attempt}`])
    expect(app.snapshot().moon.phase).toBe('waiting')
    expect(lines).toEqual(['[Matrix] app link app=moon step=begin outcome=opened authorize=same_origin'])
    app.dispose()
  })

  it('reports a browser that would not open', async () => {
    const lines: string[] = []

    const app = createAppConnection({
      resource: 'https://api.matrix.test',
      active: () => true,
      changed: vi.fn(),
      log: line => lines.push(line),
      openExternal: async () => {
        throw new Error('no browser')
      },
      request: async (_slug, action) =>
        action === 'connection'
          ? { connection }
          : {
              authorize_url: `https://api.matrix.test/link/start?t=${ticket}&a=${attempt}`,
              initiation_id: initiationId
            }
    })

    await app.begin('moon')
    expect(app.snapshot().moon).toEqual({ phase: 'failed', connection, error: 'unavailable' })
    expect(lines).toEqual(['[Matrix] app link app=moon step=begin outcome=browser_failed authorize=same_origin'])
    app.dispose()
  })

  it('times out and drops a late connect response without opening a browser', async () => {
    const connect = deferred<unknown>()
    let redirectUri = ''
    const openExternal = vi.fn()

    const app = createAppConnection({
      resource: 'https://matrix.test',
      active: () => true,
      changed: vi.fn(),
      timeoutMs: 20,
      openExternal,
      request: async (_slug, action, body) => {
        if (action === 'connection') {
          return { connection }
        }

        redirectUri = (body as { redirect_uri: string }).redirect_uri

        return connect.promise
      }
    })

    const begun = app.begin('river')
    await wait(45)
    expect(app.snapshot().river).toEqual({ phase: 'failed', connection, error: 'timed_out' })
    connect.resolve({
      authorize_url: `https://matrix.test/link/start?t=${ticket}&a=${attempt}`,
      initiation_id: initiationId
    })
    await begun
    expect(openExternal).not.toHaveBeenCalled()
    expect(await callback(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`)).toBe('error')
    app.dispose()
  })

  it('drains a listener when the account owner becomes inactive during begin', async () => {
    let active = true
    const connect = deferred<unknown>()
    let redirectUri = ''

    const app = createAppConnection({
      resource: 'https://matrix.test',
      active: () => active,
      changed: vi.fn(),
      openExternal: vi.fn(),
      request: async (_slug, action, body) => {
        if (action === 'connection') {
          return { connection }
        }

        redirectUri = (body as { redirect_uri: string }).redirect_uri

        return connect.promise
      }
    })

    const begun = app.begin('river')
    await vi.waitFor(() => expect(redirectUri).not.toBe(''))
    active = false
    connect.resolve({
      authorize_url: `https://matrix.test/link/start?t=${ticket}&a=${attempt}`,
      initiation_id: initiationId
    })
    await begun
    expect(await callback(`${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`)).toBe('error')
    app.dispose()
  })

  it('projects cleanup only from GET connection after a disconnect', async () => {
    const requests: string[] = []

    const afterDisconnect = {
      state: 'unlinked' as const,
      connectionRequired: true,
      available: false,
      readiness: 'not_linked' as const,
      cleanup: 'pending' as const
    }

    const app = createAppConnection({
      resource: 'https://matrix.test',
      active: () => true,
      changed: vi.fn(),
      openExternal: vi.fn(),
      request: async (_slug, action) => {
        requests.push(action)

        if (action === 'disconnect') {
          return { state: 'unlinked' }
        }

        return { connection: afterDisconnect }
      }
    })

    await app.read('river')
    expect(app.snapshot().river).toEqual({ phase: 'idle', connection: afterDisconnect })

    await app.disconnect('river')
    expect(requests).toEqual(['connection', 'disconnect', 'connection'])
    expect(app.snapshot().river).toEqual({ phase: 'idle', connection: afterDisconnect })
    app.dispose()
  })
})

/**
 * Auto-confirm (2026-10-10): a flow the setup card started confirms on the browser return with
 * no tap, but only through the one gate in app-connection.ts (security consult §10).
 */
describe('auto-confirm gate', () => {
  const linkedConnection = { ...connection, state: 'linked' as const, readiness: 'pending' as const }

  async function autoFixture(
    overrides: Partial<AppConnectionDependencies> = {},
    options: { linkOnConfirm?: boolean } = {}
  ) {
    let active = true
    let redirectUri = ''
    let platform: typeof connection | typeof linkedConnection = connection
    const requests: Array<{ slug: string; action: string; body?: unknown }> = []
    const lines: string[] = []
    const phases: string[] = []
    const confirmed = vi.fn()
    const returned = vi.fn()
    const consented = vi.fn(async () => ({ disclosureVersion: 3 }))
    let confirmAnswer: () => Promise<unknown> = async () => ({ status: 'confirmed' })

    const app: ReturnType<typeof createAppConnection> = createAppConnection({
      resource: 'https://api.matrix.test/api/matrix/v1',
      active: () => active,
      changed: () => {
        const phase = app.snapshot().moon?.phase

        if (phase && phases.at(-1) !== phase) {
          phases.push(phase)
        }
      },
      openExternal: vi.fn(),
      log: line => lines.push(line),
      returned,
      confirmed,
      consented,
      request: async (slug, action, body) => {
        requests.push({ slug, action, body })

        if (action === 'connection') {
          return { connection: platform }
        }

        if (action === 'connect') {
          redirectUri = (body as { redirect_uri: string }).redirect_uri

          return {
            authorize_url: `https://account.matrix.test/link/start?t=${ticket}&a=${attempt}`,
            initiation_id: initiationId
          }
        }

        if (action === 'confirm') {
          const answer = await confirmAnswer()

          // The platform links once the confirm lands, whatever the Mac did meanwhile.
          if (options.linkOnConfirm) {
            platform = linkedConnection
          }

          return answer
        }

        throw new Error(`unexpected ${action}`)
      },
      ...overrides
    })

    return {
      app,
      requests,
      lines,
      phases,
      confirmed,
      returned,
      consented,
      redirect: () => redirectUri,
      valid: () => `${redirectUri}?code=${returnCode}&initiation_id=${initiationId}`,
      confirms: () => requests.filter(request => request.action === 'confirm'),
      setActive: (value: boolean) => {
        active = value
      },
      answerConfirm: (answer: () => Promise<unknown>) => {
        confirmAnswer = answer
      }
    }
  }

  it('confirms a valid return exactly once with guarded chat and provider-page provenance', async () => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    expect(f.app.snapshot().moon.phase).toBe('waiting')

    const page = await returnPage(f.valid())
    expect(page.status).toBe(200)
    // The browser tab no longer asks for a last step in Atum.
    expect(page.body).toContain('Atum đang hoàn tất kết nối')
    expect(page.body).not.toContain(returnCode)
    expect(f.returned).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(f.app.snapshot().moon).toEqual({ phase: 'idle', connection }))
    expect(f.confirms()).toEqual([
      {
        slug: 'moon',
        action: 'confirm',
        body: {
          initiation_id: initiationId,
          return_code: returnCode,
          confirmation: true,
          consent_provenance: {
            chat: { state: 'accepted', disclosure_version: 3 },
            exact_pair: { state: 'accepted', source: 'provider_page' }
          }
        }
      }
    ])
    expect(f.confirmed).toHaveBeenCalledExactlyOnceWith('moon')

    // Replay, and a late tap, send nothing more.
    expect(await callback(f.valid())).toBe('error')
    await f.app.confirm('moon')
    expect(f.confirms()).toHaveLength(1)

    expect(f.lines).toEqual([
      '[Matrix] app link app=moon step=begin outcome=opened authorize=other_origin',
      '[Matrix] app link app=moon step=return outcome=received',
      '[Matrix] app link app=moon step=confirm outcome=confirmed mode=auto',
      '[Matrix] app link app=moon step=confirm outcome=not_ready'
    ])
    expect(f.lines.join('\n')).not.toMatch(
      new RegExp(`${ticket}|${attempt}|${returnCode}|${initiationId}|matrix\\.test`)
    )
    expect(JSON.stringify(f.app.snapshot())).not.toMatch(new RegExp(`${returnCode}|${initiationId}`))
    f.app.dispose()
  })

  it('refuses every return that is not exactly this attempt’s, and sends nothing for it', async () => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    const url = new URL(f.redirect())
    const other = '00000000-0000-4000-8000-db8055e0e030'

    expect(await callback(`${f.redirect()}?code=${returnCode}&code=${returnCode}&initiation_id=${initiationId}`)).toBe(
      400
    )
    expect(
      await callback(`${f.redirect()}?code=${returnCode}&initiation_id=${initiationId}&initiation_id=${initiationId}`)
    ).toBe(400)
    expect(await callback(`${f.redirect()}?code=${returnCode}&initiation_id=${initiationId}&extra=1`)).toBe(400)
    expect(await callback(`${f.redirect()}?code=${returnCode}&initiation_id=${other}`)).toBe(400)
    expect(await callback(`${f.redirect()}?code=${'c'.repeat(42)}&initiation_id=${initiationId}`)).toBe(400)
    expect(await callback(`${f.redirect()}?code=${returnCode}`)).toBe(400)
    expect(
      await callback(
        `http://127.0.0.1:${url.port}/atum/app-link/${'x'.repeat(43)}?code=${returnCode}&initiation_id=${initiationId}`
      )
    ).toBe(404)
    expect(await callback(f.valid(), { host: `localhost:${url.port}` })).toBe(404)
    expect(
      await callback(f.valid(), { host: `127.0.0.1:${Number(url.port) === 65535 ? 1024 : Number(url.port) + 1}` })
    ).toBe(404)
    expect(f.confirms()).toHaveLength(0)
    expect(f.app.snapshot().moon.phase).toBe('waiting')

    // None of those burned the attempt: the real return still completes it, once.
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    f.app.dispose()
  })

  it('closes the contained sheet only for its validated return', async () => {
    const close = vi.fn()
    let sheetClosed: ((reason: 'closed' | 'failed') => void) | undefined
    const openAuthorize = vi.fn(
      async (request: Parameters<NonNullable<AppConnectionDependencies['openAuthorize']>>[0]) => {
        sheetClosed = request.onClosed

        return { close }
      }
    )
    const f = await autoFixture({ openAuthorize })

    await f.app.begin('moon', { autoConfirm: true })
    expect(openAuthorize).toHaveBeenCalledOnce()
    expect(openAuthorize.mock.calls[0]?.[0]).toMatchObject({
      slug: 'moon',
      url: `https://account.matrix.test/link/start?t=${ticket}&a=${attempt}`
    })
    expect(close).not.toHaveBeenCalled()

    expect(await callback(f.valid())).toBe(200)
    expect(close).toHaveBeenCalledOnce()
    sheetClosed?.('closed')
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    f.app.dispose()
  })

  it('treats a person closing the contained sheet as cancellation, with no confirm', async () => {
    const close = vi.fn()
    let sheetClosed: ((reason: 'closed' | 'failed') => void) | undefined
    const f = await autoFixture({
      openAuthorize: async request => {
        sheetClosed = request.onClosed

        return { close }
      }
    })

    await f.app.begin('moon', { autoConfirm: true })
    const first = f.valid()
    sheetClosed?.('closed')
    expect(f.app.snapshot().moon).toEqual({ phase: 'idle', connection })
    expect(close).toHaveBeenCalledOnce()
    expect(await callback(first)).toBe('error')
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  it.each([
    ['cancel', (f: Awaited<ReturnType<typeof autoFixture>>) => f.app.cancel('moon')],
    ['dispose', (f: Awaited<ReturnType<typeof autoFixture>>) => f.app.dispose()]
  ] as const)('sends nothing for a return that arrives after %s', async (_label, end) => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    end(f)
    expect(await callback(f.valid())).toBe('error')
    expect(f.confirms()).toHaveLength(0)
    expect(f.confirmed).not.toHaveBeenCalled()
    f.app.dispose()
  })

  it('sends nothing for a return after the bounded wait timed out', async () => {
    const f = await autoFixture({ timeoutMs: 20 })
    await f.app.begin('moon', { autoConfirm: true })
    await wait(45)
    expect(f.app.snapshot().moon).toEqual({ phase: 'failed', connection, error: 'timed_out' })
    expect(await callback(f.valid())).toBe('error')
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  it('checks the arrival window itself, not only the timer', async () => {
    let clock = 1_000
    const f = await autoFixture({ now: () => clock })
    await f.app.begin('moon', { autoConfirm: true })
    clock += 180_001
    expect(await callback(f.valid())).toBe(400)
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  it('sends nothing for the return of a superseded attempt', async () => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    const first = f.valid()
    await f.app.begin('moon', { autoConfirm: true })
    expect(f.valid()).not.toBe(first)
    expect(await callback(first)).toBe('error')
    expect(f.confirms()).toHaveLength(0)

    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    f.app.dispose()
  })

  it('sends nothing once the account that began the flow no longer owns it', async () => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    f.setActive(false)
    expect(await callback(f.valid())).toBe(400)
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  it('publishes nothing for a confirm that lands after the account changed', async () => {
    const held = deferred<unknown>()
    const f = await autoFixture()
    f.answerConfirm(() => held.promise)
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    expect(f.app.snapshot().moon.phase).toBe('confirming')
    f.setActive(false)
    held.resolve({ status: 'confirmed' })
    await wait(10)
    expect(f.requests.filter(request => request.action === 'connection')).toHaveLength(1)
    expect(f.app.snapshot().moon.phase).toBe('confirming')
    expect(f.confirmed).not.toHaveBeenCalled()
    f.app.dispose()
  })

  it('sends nothing when the app is no longer one this account may connect', async () => {
    const f = await autoFixture({ confirmable: () => false })
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(400)
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  it('never retries a failed confirm with the same code', async () => {
    const f = await autoFixture()
    f.answerConfirm(() => Promise.reject(new Error('503')))
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.app.snapshot().moon).toEqual({ phase: 'failed', connection, error: 'unavailable' }))
    await f.app.confirm('moon')
    expect(f.confirms()).toHaveLength(1)
    expect(f.confirmed).not.toHaveBeenCalled()
    expect(f.lines).toContain('[Matrix] app link app=moon step=confirm outcome=confirm_failed mode=auto')
    f.app.dispose()
  })

  it('keeps the explicit confirm step for a flow begun without auto-confirm', async () => {
    const f = await autoFixture()
    await f.app.begin('moon')
    const page = await returnPage(f.valid())
    expect(page.body).toContain('Quay lại Atum để hoàn tất kết nối')
    expect(f.app.snapshot().moon.phase).toBe('confirm')
    await wait(10)
    expect(f.confirms()).toHaveLength(0)
    await f.app.confirm('moon')
    expect(f.confirms()).toHaveLength(1)
    expect(f.confirmed).not.toHaveBeenCalled()
    f.app.dispose()
  })

  // Consult §10(g): consent to the disclosure this Atum shows is read fresh at the return, not
  // trusted from the renderer's begin. A revoke on another device, or a newer disclosure,
  // during the wait means nothing is sent.
  it.each([
    ['consent no longer stands', async () => null],
    ['the consent read failed', async () => Promise.reject(new Error('503'))]
  ] as const)('sends nothing when %s at the return', async (_label, consented) => {
    const f = await autoFixture({ consented: vi.fn(consented) })
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.app.snapshot().moon).toEqual({ phase: 'failed', connection, error: 'unavailable' }))
    expect(f.confirms()).toHaveLength(0)
    expect(f.confirmed).not.toHaveBeenCalled()
    // The return was burned before the read: neither a replay nor a tap sends it later.
    expect(await callback(f.valid())).toBe('error')
    await f.app.confirm('moon')
    expect(f.confirms()).toHaveLength(0)
    expect(f.lines).toContain('[Matrix] app link app=moon step=confirm outcome=consent_required mode=auto')
    f.app.dispose()
  })

  it('reads consent only after the return passed the gate, once', async () => {
    const f = await autoFixture()
    await f.app.begin('moon', { autoConfirm: true })
    expect(
      await callback(`${f.redirect()}?code=${returnCode}&initiation_id=00000000-0000-4000-8000-db8055e0e030`)
    ).toBe(400)
    expect(f.consented).not.toHaveBeenCalled()
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    expect(f.consented).toHaveBeenCalledExactlyOnceWith('moon')
    f.app.dispose()
  })

  it('never confirms by itself without a consent read to rely on', async () => {
    const f = await autoFixture({ consented: undefined })
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(400)
    await wait(10)
    expect(f.confirms()).toHaveLength(0)
    f.app.dispose()
  })

  // The browser can come back, and the confirm go out, before opening the browser resolves.
  it('does not fall back to waiting when the return lands before the browser call resolves', async () => {
    const held = deferred<unknown>()
    let f: Awaited<ReturnType<typeof autoFixture>>

    f = await autoFixture({
      // The browser comes straight back and the confirm is on the wire before this resolves.
      openExternal: async () => {
        expect(await callback(f.valid())).toBe(200)
        await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
      }
    })

    f.answerConfirm(() => held.promise)
    await f.app.begin('moon', { autoConfirm: true })
    expect(f.app.snapshot().moon.phase).toBe('confirming')

    held.resolve({ status: 'confirmed' })
    await vi.waitFor(() => expect(f.app.snapshot().moon.phase).toBe('idle'))
    expect(f.phases.slice(f.phases.indexOf('confirming'))).not.toContain('waiting')
    expect(f.confirms()).toHaveLength(1)
    expect(f.confirmed).toHaveBeenCalledOnce()
    f.app.dispose()
  })

  // A confirm on the wire cannot be called back. Stopping its attempt meanwhile (a cancel on
  // the Apps page, the app changing, consent withdrawn in Settings) must not leave the old
  // never-linked state on screen while the platform links.
  it('shows the link the platform made when the attempt was cancelled with the confirm in flight', async () => {
    const held = deferred<unknown>()
    const f = await autoFixture({}, { linkOnConfirm: true })
    f.answerConfirm(() => held.promise)
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    expect(f.app.snapshot().moon.phase).toBe('confirming')

    f.app.cancel('moon')
    held.resolve({ status: 'confirmed' })
    await vi.waitFor(() => expect(f.app.snapshot().moon).toEqual({ phase: 'idle', connection: linkedConnection }))
    expect(f.confirmed).toHaveBeenCalledExactlyOnceWith('moon')
    expect(f.confirms()).toHaveLength(1)
    f.app.dispose()
  })

  it('lets the confirm decide, not the timer, once the confirm is on the wire', async () => {
    const held = deferred<unknown>()
    const f = await autoFixture({ timeoutMs: 60 }, { linkOnConfirm: true })
    f.answerConfirm(() => held.promise)
    await f.app.begin('moon', { autoConfirm: true })
    expect(await callback(f.valid())).toBe(200)
    await vi.waitFor(() => expect(f.confirms()).toHaveLength(1))
    await wait(120)
    expect(f.app.snapshot().moon.phase).toBe('confirming')

    held.resolve({ status: 'confirmed' })
    await vi.waitFor(() => expect(f.app.snapshot().moon).toEqual({ phase: 'idle', connection: linkedConnection }))
    expect(f.lines).not.toContain('[Matrix] app link app=moon step=begin outcome=timed_out')
    f.app.dispose()
  })
})

describe('loopback return grammar', () => {
  const base = `http://127.0.0.1:51234/atum/app-link/${'p'.repeat(43)}`

  it('accepts only the platform-bound shape', () => {
    expect(isLinkReturnUrl(`${base}?code=${returnCode}&initiation_id=${initiationId}`)).toBe(true)
    expect(isLinkReturnUrl(`${base}?initiation_id=${initiationId}&code=${returnCode}`)).toBe(true)

    for (const refused of [
      `${base}?code=${returnCode}`,
      `${base}?code=${returnCode}&initiation_id=${initiationId}&x=1`,
      `${base}?code=${returnCode}&code=${returnCode}&initiation_id=${initiationId}`,
      `${base}?code=${'c'.repeat(42)}&initiation_id=${initiationId}`,
      `${base}?code=${returnCode}&initiation_id=not-a-uuid`,
      `${base}?code=${returnCode}&initiation_id=${initiationId}#x`,
      `http://localhost:51234/atum/app-link/${'p'.repeat(43)}?code=${returnCode}&initiation_id=${initiationId}`,
      `http://127.0.0.1:80/atum/app-link/${'p'.repeat(43)}?code=${returnCode}&initiation_id=${initiationId}`,
      `https://127.0.0.1:51234/atum/app-link/${'p'.repeat(43)}?code=${returnCode}&initiation_id=${initiationId}`,
      `http://127.0.0.1:51234/atum/app-link/${'p'.repeat(42)}?code=${returnCode}&initiation_id=${initiationId}`,
      `http://u@127.0.0.1:51234/atum/app-link/${'p'.repeat(43)}?code=${returnCode}&initiation_id=${initiationId}`
    ]) {
      expect(isLinkReturnUrl(refused), refused).toBe(false)
    }
  })
})

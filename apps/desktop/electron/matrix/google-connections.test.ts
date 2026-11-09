import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as GoogleModule from '../atum-utilities/google'

import type { MatrixGoogleConnectionOwner } from './google-connections'
import { MatrixGoogleConnections } from './google-connections'

const { authorizeGoogle } = vi.hoisted(() => ({ authorizeGoogle: vi.fn() }))

vi.mock('../atum-utilities/google', async importOriginal => {
  const actual = await importOriginal<typeof GoogleModule>()

  return { ...actual, authorizeGoogle }
})

const cleanups: Array<() => void> = []
const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)

afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) { cleanup() } })

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })

  return { promise, resolve }
}

function owner(accountKey = ACCOUNT_A): MatrixGoogleConnectionOwner {
  return { accountKey, generation: 1, userId: '@person:matrix.test', deviceId: 'DEVICE', host: {} }
}

function partition(accountKey: string): string {
  return createHash('sha256')
    .update('matrix-google-connection-v1\0', 'utf8')
    .update(accountKey.toLowerCase(), 'utf8')
    .digest('hex')
}

function harness() {
  const temp = mkdtempSync(join(tmpdir(), 'matrix-google-connections-'))
  const root = join(temp, 'matrix-private')
  cleanups.push(() => rmSync(temp, { recursive: true, force: true }))
  let current: MatrixGoogleConnectionOwner | null = owner()
  let serial = 0
  const publishFence = vi.fn(async () => ({ v: 1 as const, since: 1 }))
  authorizeGoogle.mockImplementation(async (_client, _openExternal, _fetchImpl, _signal, _timeout, _labels, service: 'email-calendar' | 'drive') => {
    const drive = service === 'drive'

    return {
      accessToken: drive ? 'drive-access-token' : 'mail-access-token',
      credential: {
        clientId: 'matrix-test.apps.googleusercontent.com',
        refreshToken: `refresh-secret-${++serial}|${drive ? 'drive' : 'mail'}`,
        label: 'person@example.test',
        scopes: drive
          ? ['https://www.googleapis.com/auth/drive.readonly']
          : ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events']
      }
    }
  })

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = new URL(String(url))

    if (request.pathname === '/token') {
      const form = new URLSearchParams(String(init?.body))
      const isDrive = form.get('refresh_token')?.endsWith('|drive') ?? false
      const tokenGrant = isDrive ? 'drive' : 'mail'

      return Response.json({
        access_token: `${tokenGrant}-access-token`,
        refresh_token: `refresh-secret-${++serial}|${isDrive ? 'drive' : 'mail'}`,
        scope: isDrive
          ? 'https://www.googleapis.com/auth/drive.readonly'
          : 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events'
      })
    }

    if (request.pathname.includes('/calendarList')) {
      return Response.json({ items: [{ id: 'private-calendar-id', summary: 'Primary calendar', primary: true, accessRole: 'owner' }] })
    }

    if (request.pathname.endsWith('/profile')) {
      return Response.json({ emailAddress: 'person@example.test' })
    }

    if (request.pathname.endsWith('/about')) {
      return Response.json({ user: { emailAddress: 'person@example.test' } })
    }

    return Response.json({ files: [] })
  }) as unknown as typeof fetch

  const openExternal = vi.fn(async (_url: string) => {})

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8')
  }

  const confirmWrite = vi.fn(async () => true)

  const createConnections = (extra: Partial<ConstructorParameters<typeof MatrixGoogleConnections>[0]> = {}) => new MatrixGoogleConnections({
    root, owner: () => current, safeStorage, google: { clientId: 'matrix-test.apps.googleusercontent.com' },
    fetchImpl, openExternal, publishFence, ...extra
  })

  const connections = createConnections()

  return {
    connections, createConnections, fetchImpl, publishFence, root, openExternal, confirmWrite,
    setOwner(value: MatrixGoogleConnectionOwner | null) { current = value },
    owner: () => current
  }
}

describe('MatrixGoogleConnections', () => {
  it('revokes a received token after handoff through the real PKCE loopback authorization path', async () => {
    const h = harness()
    const actual = await vi.importActual<typeof GoogleModule>('../atum-utilities/google')
    authorizeGoogle.mockImplementation(actual.authorizeGoogle)
    h.openExternal.mockImplementation(async url => {
      const consent = new URL(url)
      const callback = new URL(consent.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', consent.searchParams.get('state')!)
      callback.searchParams.set('code', 'loopback-test-code')
      const response = await fetch(callback)
      expect(response.status).toBe(200)
    })
    vi.mocked(h.fetchImpl).mockImplementation(async (url, init) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('authorization_code')
        h.setOwner(owner(ACCOUNT_B))
        return Response.json({ access_token: 'received-access', refresh_token: 'received-refresh',
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events' })
      }
      expect(String(url)).toBe('https://oauth2.googleapis.com/revoke')
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe('received-refresh')
      return Response.json({})
    })
    await expect(h.connections.connect('email-calendar')).resolves.toEqual({ status: null, error: 'cancelled' })
    expect(vi.mocked(h.fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke'
    ])
    expect(() => lstatSync(join(h.root, 'google-connections', partition(ACCOUNT_B)))).toThrow()
  })
  it('does not publish a permanent fence for empty status or unavailable consent', async () => {
    const h = harness()
    await expect(h.connections.status()).resolves.toEqual({ status: { sources: [], available: true } })
    expect(h.publishFence).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    await expect(h.connections.connect('invalid' as never)).resolves.toEqual({ status: null, error: 'invalid_input' })
    expect(h.publishFence).not.toHaveBeenCalled()
  })

  it('never overwrites an in-flight authority and refuses a new account until cancellation settles', async () => {
    const h = harness()
    const pending = deferred<{ v: 1; since: number }>()
    h.publishFence.mockImplementationOnce(() => pending.promise)
    const operation = h.connections.connect('email-calendar')
    await vi.waitFor(() => expect(h.publishFence).toHaveBeenCalledOnce())
    await expect(h.connections.status()).resolves.toEqual({ status: null, error: 'busy' })
    h.setOwner(owner(ACCOUNT_B))
    await expect(h.connections.status()).resolves.toEqual({ status: null, error: 'busy' })
    pending.resolve({ v: 1, since: 1 })
    await expect(operation).resolves.toEqual({ status: null, error: 'cancelled' })
    expect(h.fetchImpl).not.toHaveBeenCalled()
    await expect(h.connections.status()).resolves.toEqual({ status: { sources: [], available: true } })
  })

  it('rejects a cross-partition vault symlink without loading or returning its grant', async () => {
    const h = harness()
    await h.connections.connect('email-calendar')
    const vaultA = join(h.root, 'google-connections', partition(ACCOUNT_A), 'utilities.credentials.json')
    h.setOwner(owner(ACCOUNT_B))
    await h.connections.status()
    const vaultB = join(h.root, 'google-connections', partition(ACCOUNT_B), 'utilities.credentials.json')
    symlinkSync(vaultA, vaultB)
    await expect(h.connections.status()).resolves.toEqual({ status: null, error: 'storage' })
  })
  it('stores independent email-calendar and Drive grants in encrypted account partitions, exposing metadata only', async () => {
    const h = harness()
    const emailCalendar = await h.connections.connect('email-calendar')
    const drive = await h.connections.connect('drive')

    expect(emailCalendar).toMatchObject({ status: { sources: expect.arrayContaining([expect.objectContaining({ provider: 'google', kind: 'email' })]) } })
    expect(drive).toMatchObject({ status: { sources: expect.arrayContaining([expect.objectContaining({ kind: 'drive' })]) } })
    expect(h.publishFence).toHaveBeenCalledTimes(2)
    expect(h.publishFence).toHaveBeenCalledWith(h.owner())

    const serialized = JSON.stringify(drive)
    expect(serialized).not.toContain('refresh-secret')
    expect(serialized).not.toContain('private-calendar-id')
    expect(serialized).not.toContain(h.root)
    expect(serialized).not.toContain(ACCOUNT_A)

    const vault = join(h.root, 'google-connections', partition(ACCOUNT_A), 'utilities.credentials.json')
    expect(statSync(join(h.root, 'google-connections')).mode & 0o077).toBe(0)
    expect(statSync(dirname(vault)).mode & 0o077).toBe(0)
    expect(readFileSync(vault, 'utf8')).not.toContain('refresh-secret')

    h.setOwner(owner(ACCOUNT_B))
    await expect(h.connections.status()).resolves.toEqual({ status: { sources: [], available: true } })
    expect(lstatSync(join(h.root, 'google-connections', partition(ACCOUNT_B))).isDirectory()).toBe(true)
  })

  it.each(['accountKey', 'generation', 'userId', 'deviceId', 'host'] as const)(
    'cancels a %s handoff while publication is pending and never returns stale metadata',
    async field => {
      const h = harness()
      const pending = deferred<{ v: 1; since: number }>()
      h.publishFence.mockImplementationOnce(() => pending.promise)
      const operation = h.connections.connect('email-calendar')
      await vi.waitFor(() => expect(h.publishFence).toHaveBeenCalledOnce())
      const next = owner(field === 'accountKey' ? ACCOUNT_B : ACCOUNT_A)

      if (field === 'generation') { next.generation = 2 }

      if (field === 'userId') { next.userId = '@other:matrix.test' }

      if (field === 'deviceId') { next.deviceId = 'OTHER' }

      if (field === 'host') { next.host = {} }
      h.setOwner(next)
      pending.resolve({ v: 1, since: 1 })

      await expect(operation).resolves.toEqual({ status: null, error: 'cancelled' })
    }
  )

  it('cancels after a provider response when the owner changes and does not use the new owner partition', async () => {
    const h = harness()
    const reply = deferred<Response>()
    let first = true
    vi.mocked(h.fetchImpl).mockImplementation(async () => {
      if (first) {
        first = false

        return reply.promise
      }

      return Response.json({})
    })

    const operation = h.connections.connect('email-calendar')
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledOnce())
    h.setOwner(owner(ACCOUNT_B))
    reply.resolve(Response.json({ access_token: 'secret', refresh_token: 'refresh-secret|mail', scope: 'https://www.googleapis.com/auth/gmail.readonly' }))

    await expect(operation).resolves.toEqual({ status: null, error: 'cancelled' })
    expect(h.publishFence).toHaveBeenCalledOnce()
    expect(vi.mocked(h.fetchImpl).mock.calls.some(([url, init]) =>
      String(url) === 'https://oauth2.googleapis.com/revoke' && init?.method === 'POST' &&
      new URLSearchParams(String(init.body)).get('token')?.startsWith('refresh-secret-'))).toBe(true)
    expect(() => lstatSync(join(h.root, 'google-connections', partition(ACCOUNT_B)))).toThrow()
  })

  it('fails closed when the private provider path is a symlink', async () => {
    const h = harness()
    const outside = mkdtempSync(join(tmpdir(), 'matrix-google-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    mkdirSync(h.root, { recursive: true, mode: 0o700 })
    symlinkSync(outside, join(h.root, 'google-connections'))

    await expect(h.connections.status()).resolves.toEqual({ status: null, error: 'storage' })
    expect(h.publishFence).not.toHaveBeenCalled()
  })

  it('returns a degraded, local-only saved projection after a status fence failure so a fresh settings mount can recover', async () => {
    const h = harness()
    const connected = await h.connections.connect('email-calendar')
    const source = connected.status!.sources[0]!
    h.publishFence.mockResolvedValue({ v: 1, since: -1 })
    vi.mocked(h.fetchImpl).mockClear()

    const fresh = h.createConnections()
    const recovered = await fresh.status()

    expect(recovered).toMatchObject({
      status: {
        available: true,
        degraded: true,
        sources: expect.arrayContaining([expect.objectContaining({ id: source.id, groupId: source.groupId, enabled: true })])
      }
    })
    expect(JSON.stringify(recovered)).not.toContain('refresh-secret')
    expect(JSON.stringify(recovered)).not.toContain('private-calendar-id')
    expect(vi.mocked(h.fetchImpl)).not.toHaveBeenCalled()

    const fenceCalls = h.publishFence.mock.calls.length
    const disabled = await fresh.setSourcePreferences([{ id: source.id, enabled: false }])
    expect(disabled.status?.sources.find(item => item.id === source.id)?.enabled).toBe(false)
    expect(h.publishFence).toHaveBeenCalledTimes(fenceCalls)
    expect(vi.mocked(h.fetchImpl)).not.toHaveBeenCalled()
    await expect(fresh.setSourcePreferences([{ id: source.id, enabled: true }])).resolves.toEqual({ status: null, error: 'fence' })

    h.setOwner(owner(ACCOUNT_B))
    await expect(h.createConnections().status()).resolves.toEqual({ status: { sources: [], available: true } })
    h.setOwner(owner(ACCOUNT_A))
    await expect(fresh.disconnect(source.groupId)).resolves.toEqual({ status: { sources: [], available: true } })
    expect(vi.mocked(h.fetchImpl).mock.calls.some(([url]) => String(url) === 'https://oauth2.googleapis.com/revoke')).toBe(true)
  })

  it('cancels status recovery if the publisher hands the account to another owner', async () => {
    const h = harness()
    await h.connections.connect('email-calendar')
    h.publishFence.mockImplementationOnce(async () => {
      h.setOwner(owner(ACCOUNT_B))
      throw new Error('publisher changed owner')
    })
    vi.mocked(h.fetchImpl).mockClear()

    await expect(h.createConnections().status()).resolves.toEqual({ status: null, error: 'cancelled' })
    expect(vi.mocked(h.fetchImpl)).not.toHaveBeenCalled()
  })

  it('runs an assistant read under the owner fence: the fence first, then the saved grant, never a token', async () => {
    const h = harness()
    await h.connections.connect('drive')
    const fenced = h.publishFence.mock.calls.length
    vi.mocked(h.fetchImpl).mockClear()

    const read = await h.connections.toolRead({ kind: 'drive', action: 'files', query: 'budget' })

    expect(read).toMatchObject({ ok: true, value: { kind: 'drive', results: [expect.objectContaining({ data: { files: [], more: false } })] } })
    expect(h.publishFence.mock.calls.length).toBe(fenced + 1)
    expect(JSON.stringify(read)).not.toMatch(/refresh-secret|access-token/)
  })

  it('refuses an assistant read when the fence cannot be published, before any provider call', async () => {
    const h = harness()
    await h.connections.connect('drive')
    h.publishFence.mockRejectedValueOnce(new Error('sdk offline'))
    vi.mocked(h.fetchImpl).mockClear()

    await expect(h.connections.toolRead({ kind: 'drive', action: 'files' })).resolves.toEqual({ ok: false, error: 'fence' })
    expect(vi.mocked(h.fetchImpl)).not.toHaveBeenCalled()
  })

  it('says the account changed when signed out, and busy while Settings holds the connection', async () => {
    const h = harness()
    await h.connections.connect('drive')

    const pending = deferred<{ v: 1; since: number }>()
    h.publishFence.mockImplementationOnce(() => pending.promise)
    const settings = h.connections.status()
    await expect(h.connections.toolRead({ kind: 'drive', action: 'files' })).resolves.toEqual({ ok: false, error: 'busy' })
    pending.resolve({ v: 1, since: 1 })
    await settings

    h.setOwner(null)
    await expect(h.connections.toolRead({ kind: 'drive', action: 'files' })).resolves.toEqual({ ok: false, error: 'account_changed' })
  })

  it('sends only after the owner confirms, and never without a confirmation hook', async () => {
    const h = harness()
    const connected = await h.connections.connect('email-calendar')
    const mail = connected.status!.sources.find(source => source.kind === 'email')!
    const send = { action: 'send-email', operationId: '00000000-0000-1000-8000-986c0dc956dc', sourceId: mail.id, to: ['lan@example.com'], subject: 'Hi', body: 'Hello' }

    // This adapter was built without a confirmation: no write can happen.
    await expect(h.connections.toolWrite(send)).resolves.toEqual({ ok: false, error: 'unavailable' })

    const confirming = h.createConnections({ confirmWrite: h.confirmWrite })
    h.confirmWrite.mockResolvedValueOnce(false)
    await expect(confirming.toolWrite(send)).resolves.toEqual({ ok: false, error: 'cancelled' })
    expect(vi.mocked(h.fetchImpl).mock.calls.some(([url]) => String(url).includes('/messages/send'))).toBe(false)

    vi.mocked(h.fetchImpl).mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/messages/send') ? Response.json({ id: 'sent-1' }) : Response.json({ access_token: 'mail-access-token', scope: String(init?.body ?? '') })
    )
    await expect(confirming.toolWrite({ ...send, operationId: '00000000-0000-1000-8000-d48df04d882b' })).resolves.toMatchObject({ ok: true, value: { id: 'sent-1' } })
    expect(h.confirmWrite).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'send-email', detail: expect.stringContaining('To: lan@example.com') }))
  })

  it('summarizes what the saved grants allow from the local vault, without asking Google', async () => {
    const h = harness()
    expect(h.connections.services()).toEqual({ gmail: false, send: false, calendar: false, drive: false })

    await h.connections.connect('email-calendar')
    vi.mocked(h.fetchImpl).mockClear()
    const fenced = h.publishFence.mock.calls.length

    expect(h.connections.services()).toEqual({ gmail: true, send: true, calendar: true, drive: false })
    expect(h.createConnections().services()).toEqual({ gmail: true, send: true, calendar: true, drive: false })
    expect(vi.mocked(h.fetchImpl)).not.toHaveBeenCalled()
    expect(h.publishFence.mock.calls.length).toBe(fenced)

    h.setOwner(owner(ACCOUNT_B))
    expect(h.connections.services()).toEqual({ gmail: false, send: false, calendar: false, drive: false })
  })
})

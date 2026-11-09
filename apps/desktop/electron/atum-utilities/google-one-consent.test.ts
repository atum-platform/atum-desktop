import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GOOGLE_SCOPES, ONE_CONSENT_SCOPES, parseMailbox } from './google'

import { AtumUtilities, type UtilityAccount } from './index'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) { cleanup() } })

const S = GOOGLE_SCOPES
const ALL = [...ONE_CONSENT_SCOPES]

function idToken(email: string | undefined) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'RS256' })}.${part(email ? { email, email_verified: true } : { sub: '1' })}.signature`
}

/** A fake Google: one consent screen where the person may untick permissions, and APIs
 * that answer only what was granted, as Google's do. */
function fakeGoogle() {
  const root = mkdtempSync(join(tmpdir(), 'atum-one-consent-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const account: UtilityAccount = { accountId: 'account-a', generation: 1, root }

  const state = {
    label: 'minh@example.com',
    grant: ALL as string[],
    withIdToken: true,
    serial: 0,
    authorizations: [] as URL[],
    refreshes: 0,
    calls: [] as string[],
    revoked: [] as string[],
    threads: {} as Record<string, any>
  }

  const grants = new Map<string, string[]>()

  const openExternal = vi.fn(async (value: string) => {
    const url = new URL(value)
    state.authorizations.push(url)
    await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=code`)
  })

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const params = new URLSearchParams(String(init?.body ?? ''))

    if (url.pathname === '/revoke') {
      state.revoked.push(params.get('token')!)

      return new Response(null, { status: 200 })
    }

    if (url.pathname === '/token') {
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshes++
        const token = params.get('refresh_token')!

        return Response.json({ access_token: `access:${token}` })
      }

      const refresh = `${state.label}|${++state.serial}`
      grants.set(`access:${refresh}`, [...state.grant])
      grants.set(`first:${refresh}`, [...state.grant])

      return Response.json({
        access_token: `first:${refresh}`,
        refresh_token: refresh,
        scope: state.grant.join(' '),
        ...(state.withIdToken ? { id_token: idToken(state.label) } : {})
      })
    }

    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
    const granted = grants.get(token) ?? []
    const allowed = (scope: string) => (granted.includes(scope) ? null : Response.json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 }))
    state.calls.push(url.pathname)

    if (url.hostname === 'openidconnect.googleapis.com') { return Response.json({ email: state.label, email_verified: true }) }

    if (url.pathname.endsWith('/profile')) { return allowed(S.gmailRead) ?? Response.json({ emailAddress: state.label }) }

    if (url.pathname.includes('calendarList')) {
      return allowed(S.calendarList) ?? Response.json({ items: [{ id: 'primary-id', summary: state.label, primary: true, accessRole: 'owner' }, { id: 'team', summary: 'Team', accessRole: 'reader' }] })
    }

    if (url.pathname.endsWith('/events')) { return allowed(S.calendarEvents) ?? Response.json({ items: [] }) }

    if (url.pathname.startsWith('/drive/')) { return allowed(S.drive) ?? Response.json({ user: { emailAddress: state.label }, files: [] }) }

    if (url.pathname.endsWith('/threads')) { return allowed(S.gmailRead) ?? Response.json({ threads: Object.keys(state.threads).map(id => ({ id })) }) }

    if (url.pathname.includes('/threads/')) { return allowed(S.gmailRead) ?? Response.json(state.threads[url.pathname.split('/').at(-1)!]) }

    return Response.json({}, { status: 404 })
  }) as unknown as typeof fetch

  const manager = new AtumUtilities({
    account: () => account,
    apple: { available: { calendar: false }, calendar: vi.fn(async () => ({ calendars: [] })) },
    google: { clientId: 'example.apps.googleusercontent.com' },
    fetchImpl,
    openExternal,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() }
  })

  return { manager, state, account, fetchImpl }
}

const kinds = (status: any) => status.sources.map((source: any) => `${source.kind}:${source.label}${source.writable ? ':writable' : ''}`).sort()

describe('one Google consent for Gmail, Calendar and Drive (G2-08)', () => {
  it('asks once for exactly the saved scopes and connects every service the person allowed', async () => {
    const { manager, state } = fakeGoogle()
    const result = await manager.connect({ provider: 'google', service: 'google' })

    expect(result.error).toBeUndefined()
    const asked = state.authorizations[0]
    expect(asked.searchParams.get('scope')!.split(' ').sort()).toEqual([...ALL].sort())
    expect(asked.searchParams.get('include_granted_scopes')).toBe('true')
    expect(kinds(result.status)).toEqual([
      'calendar:Team',
      'calendar:minh@example.com:writable',
      'drive:minh@example.com',
      'email:minh@example.com:writable'
    ])
  })

  it('uses what was granted when the person unticks permissions, and asks nothing else', async () => {
    const { manager, state } = fakeGoogle()
    state.grant = [S.openid, S.email, S.calendarEvents]
    const result = await manager.connect({ provider: 'google', service: 'google' })

    // Only the primary calendar is reachable without the calendar-list permission.
    expect(kinds(result.status)).toEqual(['calendar:minh@example.com:writable'])
    expect(state.authorizations).toHaveLength(1)

    // Checking the connection never touches a service that wasn't granted.
    state.calls.length = 0
    const checked = await manager.status()
    expect(checked.status!.sources.every(source => source.state === 'connected')).toBe(true)
    expect(state.calls.some(path => path.endsWith('/profile') || path.startsWith('/drive/') || path.includes('calendarList'))).toBe(false)
  })

  it('refreshes one token once per check, though both service slots hold it', async () => {
    const { manager, state } = fakeGoogle()
    await manager.connect({ provider: 'google', service: 'google' })
    state.refreshes = 0

    await manager.status()

    expect(state.refreshes).toBe(1)
  })

  it('connects nothing and revokes the grant when the person unticks every service', async () => {
    const { manager, state } = fakeGoogle()
    state.grant = [S.openid, S.email]
    const result = await manager.connect({ provider: 'google', service: 'google' })

    expect(result.error).toBe('denied')
    expect(result.status?.sources ?? []).toEqual([])
    expect(state.revoked).toEqual(['minh@example.com|1'])
  })

  it('adds a service to the same account later, and drops one the person no longer allows', async () => {
    const { manager, state } = fakeGoogle()
    state.grant = [S.openid, S.email, S.gmailRead]
    await manager.connect({ provider: 'google', service: 'google' })

    state.grant = [S.openid, S.email, S.gmailRead, S.gmailSend, S.drive]
    const more = await manager.connect({ provider: 'google', service: 'google' })
    expect(kinds(more.status)).toEqual(['drive:minh@example.com', 'email:minh@example.com:writable'])
    expect(new Set(more.status!.sources.map(source => source.accountKey)).size).toBe(1)

    state.grant = [S.openid, S.email, S.drive]
    const less = await manager.connect({ provider: 'google', service: 'google' })
    expect(kinds(less.status)).toEqual(['drive:minh@example.com'])
  })

  it('names the account from the ID token, else from Google’s userinfo, even with Gmail unticked', async () => {
    const { manager, state } = fakeGoogle()
    state.grant = [S.openid, S.email, S.drive]
    state.withIdToken = false
    state.label = 'Other@Example.com'
    const result = await manager.connect({ provider: 'google', service: 'google' })

    expect(kinds(result.status)).toEqual(['drive:Other@Example.com'])
    expect(state.calls).toContain('/v1/userinfo')
  })

  it('keeps two accounts apart, each with its own sources', async () => {
    const { manager, state } = fakeGoogle()
    await manager.connect({ provider: 'google', service: 'google' })
    state.label = 'work@example.com'
    state.grant = [S.openid, S.email, S.gmailRead]
    const result = await manager.connect({ provider: 'google', service: 'google' })

    expect(new Set(result.status!.sources.map(source => source.accountKey)).size).toBe(2)
    expect(result.status!.sources.filter(source => source.label === 'work@example.com').map(source => source.kind)).toEqual(['email'])
  })
})

describe('Gmail reads for the assistant', () => {
  const message = (from: string, to: string, extra: Record<string, string> = {}, at = 1_759_500_000_000) => ({
    internalDate: String(at),
    snippet: `from ${from}`,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Quote' },
        { name: 'Message-ID', value: `<${at}@mail.test>` },
        ...Object.entries(extra).map(([name, value]) => ({ name, value }))
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(`Body from ${from}`).toString('base64url') }
    }
  })

  it('lists only people waiting on the owner, oldest first', async () => {
    const { manager, state, account } = fakeGoogle()
    await manager.connect({ provider: 'google', service: 'google' })
    const owner = 'minh@example.com'
    state.threads = {
      waiting: { id: 'waiting', messages: [message('"Lan" <lan@example.com>', owner, {}, 1_759_400_000_000)] },
      answered: { id: 'answered', messages: [message('lan@example.com', owner), message(owner, 'lan@example.com')] },
      robot: { id: 'robot', messages: [message('no-reply@shop.test', owner)] },
      newsletter: { id: 'newsletter', messages: [message('news@paper.test', owner, { 'List-Unsubscribe': '<mailto:x>' })] },
      cc: { id: 'cc', messages: [message('boss@example.com', 'team@example.com', { Cc: owner }, 1_759_450_000_000)] },
      notForOwner: { id: 'notForOwner', messages: [message('someone@example.com', 'group@example.com')] }
    }

    const read = await manager.read(account.accountId, account.generation, { kind: 'email', action: 'waiting' }) as any
    const threads = read.results[0].data.threads

    expect(threads.map((thread: any) => thread.id)).toEqual(['waiting', 'cc'])
    expect(threads[0]).toMatchObject({ subject: 'Quote', from: { name: 'Lan', address: 'lan@example.com' }, messageCount: 1 })
    expect(threads[0].sourceId).toBe(read.results[0].sourceId)
  })

  it('reads one thread with what a reply needs to stay in it', async () => {
    const { manager, state, account } = fakeGoogle()
    const connected = await manager.connect({ provider: 'google', service: 'google' })
    const mail = connected.status!.sources.find(source => source.kind === 'email')!
    state.threads = { t1: { id: 't1', messages: [message('Lan <lan@example.com>', 'minh@example.com')] } }

    const read = await manager.read(account.accountId, account.generation, { kind: 'email', action: 'thread', sources: [mail.id], id: 't1' }) as any
    const thread = read.results[0].data

    expect(thread.messages[0].text).toBe('Body from Lan <lan@example.com>')
    expect(thread.reply).toEqual({ threadId: 't1', to: ['lan@example.com'], subject: 'Re: Quote', inReplyTo: '<1759500000000@mail.test>' })
    expect(thread.sourceId).toBe(mail.id)

    // A thread lives in one mailbox: reading one names exactly one source.
    await expect(manager.read(account.accountId, account.generation, { kind: 'email', action: 'thread', id: 't1' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('parses mailboxes the way people write them', () => {
    expect(parseMailbox('"Nguyễn Lan" <Lan@Example.com>')).toEqual({ name: 'Nguyễn Lan', address: 'lan@example.com' })
    expect(parseMailbox('lan@example.com')).toEqual({ name: '', address: 'lan@example.com' })
    expect(parseMailbox('undisclosed-recipients:;')).toEqual({ name: '', address: '' })
  })
})

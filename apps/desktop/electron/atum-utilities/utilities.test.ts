import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_ID } from '../../shared/atum-interaction-capability'
import { decodeMime, decodeWords, parseUpload } from '../../shared/gmail-mime-test-utils'
import { AtumFilesystemActionBroker, AtumFilesystemCapabilityAuthority } from '../atum-filesystem-capability'
import { accountKeyFor, AccountRootAuthority } from '../atum-messaging/account-roots'
import { SafeStorageAuthStorage } from '../atum-messaging/credential-vault'
import { matrixGoogleUtilityInput } from '../matrix/google-tools'

import { authorizeGoogle, type GoogleClient, googleRead, UtilityFailure } from './google'

import { AtumUtilities, type UtilityAccount } from './index'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup() } })

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'atum-utilities-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let account: UtilityAccount = { accountId: 'account-a', generation: 1, root }

  const apple = {
    available: { calendar: true },
    calendar: vi.fn(async (_input: Record<string, unknown>) => ({ calendars: [{ id: 'native-private-id', label: 'Personal', primary: true }] }) as any)
  }

  const encryptString = vi.fn((value: string) => Buffer.from(value).reverse())
  const confirmWrite = vi.fn(async () => true)

  const deps = {
    account: () => account, apple, google: null as GoogleClient | null,
    fetchImpl: vi.fn() as unknown as typeof fetch, openExternal: vi.fn(),
    confirmWrite,
    safeStorage: { isEncryptionAvailable: () => true, encryptString, decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() }
  }

  const manager = new AtumUtilities(deps)

  return { manager, deps, root, setAccount: (value: UtilityAccount) => { account = value } }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()

  if (!address || typeof address === 'string') { throw new Error('address') }

  return `http://127.0.0.1:${address.port}`
}

function googleHarness() {
  const h = harness()
  h.deps.google = { clientId: 'example.apps.googleusercontent.com' }
  let label = 'first@example.com'
  let serial = 0
  let partial = false
  let revokeFails = false
  let existingNotes = 'Current notes'
  let service = 'email-calendar'
  const scopes: string[] = []
  const driveDeniedAccounts = new Set<string>()
  const invalidTokens = new Set<string>()
  const revoked: string[] = []
  const revokedAccounts = new Set<string>()
  const offlineAccounts = new Set<string>()
  h.deps.openExternal = vi.fn(async (value: string) => {
    const url = new URL(value)
    scopes.push(url.searchParams.get('scope')!)
    service = url.searchParams.get('scope')!.includes('drive.readonly') ? 'drive' : 'email-calendar'
    await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=test-code`)
  })
  h.deps.fetchImpl = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname
    const params = new URLSearchParams(String(init?.body))

    if (path === '/revoke') {
      revoked.push(params.get('token')!)

      if (invalidTokens.has(params.get('token')!)) { return Response.json({ error: 'invalid_token' }, { status: 400 }) }

      return new Response(revokeFails ? '{}' : null, { status: revokeFails ? 503 : 200 })
    }

    if (path === '/token') {
      const owner = params.get('grant_type') === 'refresh_token' ? params.get('refresh_token')!.split('|')[0] : label

      if (offlineAccounts.has(owner)) { throw new Error('offline') }

      if (revokedAccounts.has(owner)) { return Response.json({ error: 'invalid_grant' }, { status: 400 }) }

      const drive = params.get('grant_type') === 'refresh_token' ? params.get('refresh_token')!.endsWith('|drive') : service === 'drive'

      return Response.json({ access_token: `${drive ? 'drive-' : ''}access-token:${owner}`, refresh_token: `${owner}|${++serial}${drive ? '|drive' : ''}`, scope: partial ? 'https://www.googleapis.com/auth/gmail.readonly' : drive ? 'https://www.googleapis.com/auth/drive.readonly' : 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events' })
    }

    const auth = new Headers(init?.headers).get('authorization')!
    const owner = auth.replace('Bearer ', '').replace(/^(drive-)?access-token:/, '')

    if (path.startsWith('/drive/')) {
      if (!auth.includes('drive-access-token:') || driveDeniedAccounts.has(owner)) { return Response.json({}, { status: 403 }) }

      if (path.endsWith('/about')) { return Response.json({ user: { emailAddress: owner } }) }

      if (path.endsWith('/export')) { return new Response(`Drive document for ${owner}`) }

      if (path.endsWith('/files')) { return Response.json({ files: [{ id: 'doc', name: `Document for ${owner}`, mimeType: 'application/vnd.google-apps.document' }] }) }

      return Response.json({ id: 'doc', name: `Document for ${owner}`, mimeType: 'application/vnd.google-apps.document' })
    }

    if (auth.includes('drive-access-token:')) { return Response.json({}, { status: 403 }) }

    if (path.endsWith('/profile')) { return Response.json({ emailAddress: owner }) }

    if (path.includes('calendarList')) { return Response.json({ items: [{ id: `${owner}/primary`, summary: 'Primary calendar', primary: true, accessRole: 'owner' }, { id: `${owner}/team`, summary: 'Team calendar', accessRole: 'reader' }] }) }

    if (path.endsWith('/events') && init?.method === 'POST') { return Response.json({ id: 'created-event', etag: '"created"' }) }

    if (path.includes('/events/')) {
      if (init?.method === 'PATCH') { return Response.json({ id: path.split('/').at(-1), etag: '"updated"' }) }

      return Response.json({ id: path.split('/').at(-1), etag: '"before"', summary: 'Current title', start: { dateTime: '2026-09-10T09:00:00+07:00' }, end: { dateTime: '2026-09-10T10:00:00+07:00' }, description: existingNotes })
    }

    if (path.endsWith('/events')) { return Response.json({ items: [{ id: 'event', summary: 'Shared meeting' }] }) }

    if (path.endsWith('/messages/send')) { return Response.json({ id: 'sent-message' }) }

    if (path.endsWith('/messages')) { return Response.json({ messages: [{ id: 'same-id' }] }) }

    return Response.json({ id: 'same-id', snippet: `Mail for ${owner}` })
  }) as typeof fetch

  return { ...h, scopes, driveDeniedAccounts, invalidTokens, revoked, revokedAccounts, offlineAccounts, setLabel: (value: string) => { label = value }, partial: () => { partial = true }, failRevoke: (value: boolean) => { revokeFails = value }, setExistingNotes: (value: string) => { existingNotes = value } }
}

const writeOperation = (suffix: string) => `123e4567-e89b-12d3-a456-426614174${suffix}`

function sendEmail(sourceId: string, operationId = writeOperation('000')) {
  return { action: 'send-email' as const, operationId, sourceId, to: ['recipient@example.com'], subject: 'Bản cập nhật 👋', body: 'Nội dung riêng tư' }
}

function updateEvent(sourceId: string, operationId = writeOperation('001')) {
  return {
    action: 'update-event' as const, operationId, sourceId, id: 'event-safe', title: 'Updated title',
    start: '2026-09-11T09:00:00+07:00', end: '2026-09-11T10:00:00+07:00', description: 'After notes'
  }
}

function mutationCalls(fetchImpl: typeof fetch): unknown[][] {
  return vi.mocked(fetchImpl).mock.calls.filter(([url, init]) =>
    String(url).includes('/messages/send') || (String(url).includes('/events') && ['POST', 'PATCH'].includes(String(init?.method))))
}

describe('approved Google utility writes', () => {
  it('requires the explicitly enabled source and previews the real mailbox and calendar before dispatch', async () => {
    const h = googleHarness()
    const status = (await h.manager.connect({ provider: 'google' })).status!
    const email = status.sources.find(source => source.kind === 'email')!
    const calendar = status.sources.find(source => source.kind === 'calendar' && source.primary)!

    await h.manager.setEnabled([{ id: email.id, enabled: false }])
    vi.mocked(h.deps.fetchImpl).mockClear()
    await expect(h.manager.write('account-a', 1, sendEmail(email.id))).rejects.toMatchObject({ code: 'unavailable' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])

    await h.manager.setEnabled([{ id: email.id, enabled: true }])
    await h.manager.write('account-a', 1, sendEmail(email.id))
    expect(h.deps.confirmWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'send-email', detail: expect.stringContaining('From: first@example.com\nTo: recipient@example.com\nSubject: Bản cập nhật 👋\n\nNội dung riêng tư')
    }))

    await h.manager.write('account-a', 1, updateEvent(calendar.id))
    expect(h.deps.confirmWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'update-event', detail: expect.stringContaining('Calendar: Primary calendar (first@example.com)\n\nCurrent event:\nTitle: Current title')
    }))
    expect(h.deps.confirmWrite).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringContaining('After changes:\nTitle: Updated title') }))
  })

  it('never asks the owner to approve a body they cannot read in full, and shows a padded one collapsed', async () => {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    vi.mocked(h.deps.fetchImpl).mockClear()
    h.deps.confirmWrite.mockClear()

    // 20,000 characters: refused before any dialog and before any mutation.
    await expect(h.manager.write('account-a', 1, { ...sendEmail(email.id), body: 'a'.repeat(20_000) })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(h.deps.confirmWrite).not.toHaveBeenCalled()
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])

    // Blank-line padding: the dialog gets the collapsed text, tail included, in a handful of lines.
    await h.manager.write('account-a', 1, { ...sendEmail(email.id, writeOperation('002')), body: `Thanks!${'\n'.repeat(400)}MARKER-TAIL` })
    const detail = (h.deps.confirmWrite.mock.calls.at(-1) as unknown as [{ detail: string }])[0].detail
    expect(detail).toContain('MARKER-TAIL')
    expect(detail.split('\n').length).toBeLessThan(15)
  })

  // Review r1 of the 2026-11-06 audit lead: only some fields were bounded, and the assembled text not at all.
  it('refuses a calendar write whose location or whole dialog cannot be read at once, before any dialog or mutation', async () => {
    const h = googleHarness()
    const calendar = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'calendar' && source.primary)!
    const start = { start: '2026-09-11T09:00:00+07:00', end: '2026-09-11T10:00:00+07:00' }
    const create = (suffix: string, fields: Record<string, string>) => ({ action: 'create-event' as const, operationId: writeOperation(suffix), sourceId: calendar.id, title: 'Plan', ...start, ...fields })
    vi.mocked(h.deps.fetchImpl).mockClear()
    h.deps.confirmWrite.mockClear()

    // 490 short lines in the location would push the notes below the visible area.
    await expect(h.manager.write('account-a', 1, create('010', { location: 'x\n'.repeat(490), description: 'REAL-NOTES' }))).rejects.toMatchObject({ code: 'invalid_input' })
    // Hidden padding in a location is shown collapsed, and a location that is short enough still works.
    await h.manager.write('account-a', 1, create('011', { location: `Room 1${'\n'.repeat(300)}Floor 2`, description: 'REAL-NOTES' }))
    expect((h.deps.confirmWrite.mock.calls.at(-1) as unknown as [{ detail: string }])[0].detail).toContain('Floor 2')

    // Each field fits on its own; together they exceed what one dialog can show.
    h.deps.confirmWrite.mockClear()
    const calls = mutationCalls(h.deps.fetchImpl).length
    await expect(h.manager.write('account-a', 1, create('012', { location: 'b\n'.repeat(45), description: 'a\n'.repeat(55) }))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(h.deps.confirmWrite).not.toHaveBeenCalled()
    expect(mutationCalls(h.deps.fetchImpl)).toHaveLength(calls)
  })

  it('bounds existing event text by lines too, so the comparison cannot hide the change', async () => {
    const h = googleHarness()
    const calendar = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'calendar' && source.primary)!
    h.setExistingNotes('q\n'.repeat(700))
    h.deps.confirmWrite.mockClear()

    await h.manager.write('account-a', 1, updateEvent(calendar.id))
    const detail = (h.deps.confirmWrite.mock.calls.at(-1) as unknown as [{ detail: string }])[0].detail
    expect(detail.split('\n').length).toBeLessThan(40)
    expect(detail).toContain('more characters not shown')
    expect(detail).toContain('After changes:\nTitle: Updated title')
    expect(detail).toContain('After notes')
  })

  it('does not mutate when confirmation is denied or when account/source fences change while approval is open', async () => {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    h.deps.confirmWrite.mockResolvedValueOnce(false)
    vi.mocked(h.deps.fetchImpl).mockClear()
    await expect(h.manager.write('account-a', 1, sendEmail(email.id))).rejects.toMatchObject({ code: 'cancelled' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])

    let approve!: (value: boolean) => void
    h.deps.confirmWrite.mockImplementationOnce(() => new Promise<boolean>(resolve => { approve = resolve }))
    const pending = h.manager.write('account-a', 1, sendEmail(email.id, writeOperation('002')))
    await vi.waitFor(() => expect(h.deps.confirmWrite).toHaveBeenCalledTimes(2))
    await h.manager.setEnabled([{ id: email.id, enabled: false }])
    approve(true)
    await expect(pending).rejects.toMatchObject({ code: 'account_changed' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])

    await h.manager.setEnabled([{ id: email.id, enabled: true }])
    h.deps.confirmWrite.mockImplementationOnce(() => new Promise<boolean>(resolve => { approve = resolve }))
    const accountChanged = h.manager.write('account-a', 1, sendEmail(email.id, writeOperation('003')))
    await vi.waitFor(() => expect(h.deps.confirmWrite).toHaveBeenCalledTimes(3))
    h.setAccount({ accountId: 'account-b', generation: 2, root: h.root })
    approve(true)
    await expect(accountChanged).rejects.toMatchObject({ code: 'account_changed' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])
  })

  it('cancels an abandoned write before dispatch even if its old approval resolves true', async () => {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    let approve!: (value: boolean) => void
    h.deps.confirmWrite.mockImplementationOnce(() => new Promise<boolean>(resolve => { approve = resolve }))
    const controller = new AbortController()
    vi.mocked(h.deps.fetchImpl).mockClear()
    const pending = h.manager.write('account-a', 1, sendEmail(email.id), controller.signal)
    await vi.waitFor(() => expect(h.deps.confirmWrite).toHaveBeenCalledOnce())
    controller.abort()
    approve(true)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])
  })

  it('retains account protection after restart and Google disconnection', async () => {
    const h = googleHarness()
    expect(h.manager.workspaceProtected()).toBe(false)
    const status = (await h.manager.connect({ provider: 'google' })).status!
    expect(status.workspaceProtected).toBe(true)
    await h.manager.disconnect({ provider: 'google', accountKey: status.sources[0].accountKey! })
    const restarted = new AtumUtilities(h.deps)
    expect(restarted.workspaceProtected()).toBe(true)
    expect((await restarted.status()).status?.sources).toEqual([])
  })

  it('persists the Google latch before calendar inventory observes the encrypted store', async () => {
    const h = googleHarness()
    const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
    const fetchImpl = h.deps.fetchImpl
    let inventoryState: unknown

    h.deps.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(String(url)).pathname.includes('calendarList')) {
        inventoryState = JSON.parse(vault.getItem('connections')!)
      }

      return fetchImpl(url, init)
    }) as typeof fetch

    await expect(h.manager.connect({ provider: 'google' })).resolves.toMatchObject({
      status: { workspaceProtected: true }
    })
    expect(inventoryState).toMatchObject({ workspaceProtected: true, accounts: [], sources: [] })
  })

  it('does not expose calendar inventory or leave an empty group when a new grant cannot latch', async () => {
    const h = googleHarness()
    const fetchImpl = h.deps.fetchImpl
    const calendarInventory = vi.fn()
    h.deps.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(String(url)).pathname.includes('calendarList')) { calendarInventory() }

      return fetchImpl(url, init)
    }) as typeof fetch
    vi.mocked(h.deps.safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('keychain unavailable') })

    await expect(h.manager.connect({ provider: 'google' })).resolves.toMatchObject({ error: 'storage' })
    expect(calendarInventory).not.toHaveBeenCalled()
    expect(h.revoked).toEqual(['first@example.com|1'])
    expect(new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage).getItem('connections')).toBeNull()
  })

  it('rechecks the account after latching before it can request calendar inventory', async () => {
    const h = googleHarness()
    const fetchImpl = h.deps.fetchImpl
    const calendarInventory = vi.fn()
    h.deps.fetchImpl = vi.fn(async (url, init) => {
      if (new URL(String(url)).pathname.includes('calendarList')) { calendarInventory() }

      return fetchImpl(url, init)
    }) as typeof fetch
    const encrypt = h.deps.safeStorage.encryptString
    vi.mocked(h.deps.safeStorage.encryptString).mockImplementationOnce(value => {
      h.setAccount({ accountId: 'account-b', generation: 2, root: join(h.root, 'account-b') })

      return encrypt(value)
    })

    await expect(h.manager.connect({ provider: 'google' })).resolves.toMatchObject({ error: 'account_changed' })
    expect(calendarInventory).not.toHaveBeenCalled()
    expect(h.revoked).toEqual(['first@example.com|1'])
    expect(JSON.parse(new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage).getItem('connections')!)).toMatchObject({
      workspaceProtected: true, accounts: [], sources: []
    })
  })

  it('requires the retained write grants before provider dispatch and fails closed when ledger encryption fails', async () => {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
    const saved = JSON.parse(vault.getItem('connections')!)
    delete saved.accounts[0].credentials['email-calendar'].scopes
    vault.setItem('connections', JSON.stringify(saved))
    vi.mocked(h.deps.fetchImpl).mockClear()
    await expect(h.manager.write('account-a', 1, sendEmail(email.id))).rejects.toMatchObject({ code: 'reconnect' })
    expect(h.deps.fetchImpl).not.toHaveBeenCalled()

    saved.accounts[0].credentials['email-calendar'].scopes = [
      'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'
    ]
    vault.setItem('connections', JSON.stringify(saved))
    h.deps.safeStorage.encryptString.mockImplementationOnce(() => { throw new Error('keychain unavailable') })
    await expect(h.manager.write('account-a', 1, sendEmail(email.id, writeOperation('004')))).rejects.toMatchObject({ code: 'storage' })
    expect(mutationCalls(h.deps.fetchImpl)).toEqual([])
  })

  it('persists uncertain sends, returns completed replays, and rejects changed payloads without another send', async () => {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    const action = sendEmail(email.id, writeOperation('005'))
    const provider = h.deps.fetchImpl
    h.deps.fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes('/messages/send')) { throw new Error('connection reset after dispatch') }

      return provider(url, init)
    }) as typeof fetch
    await expect(h.manager.write('account-a', 1, action)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(mutationCalls(h.deps.fetchImpl)).toHaveLength(1)
    const restarted = new AtumUtilities(h.deps)
    await expect(restarted.write('account-a', 1, action)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(mutationCalls(h.deps.fetchImpl)).toHaveLength(1)

    h.deps.fetchImpl = provider
    const completeAction = sendEmail(email.id, writeOperation('006'))
    await expect(restarted.write('account-a', 1, completeAction)).resolves.toMatchObject({ id: 'sent-message', operationId: completeAction.operationId, sourceId: email.id })
    vi.mocked(h.deps.fetchImpl).mockClear()
    await expect(new AtumUtilities(h.deps).write('account-a', 1, completeAction)).resolves.toEqual({ action: 'send-email', id: 'sent-message', operationId: completeAction.operationId, replay: true })
    expect(h.deps.fetchImpl).not.toHaveBeenCalled()
    await expect(new AtumUtilities(h.deps).write('account-a', 1, { ...completeAction, body: 'changed' })).rejects.toMatchObject({ code: 'conflict' })
    expect(h.deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('sends Calendar updates with the inspected etag and reports a stale provider response as conflict', async () => {
    const h = googleHarness()
    const calendar = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'calendar' && source.primary)!
    await expect(h.manager.write('account-a', 1, updateEvent(calendar.id))).resolves.toMatchObject({ id: 'event-safe' })
    const patch = mutationCalls(h.deps.fetchImpl).find(([, init]) => (init as RequestInit).method === 'PATCH')!
    expect((patch[1] as RequestInit).headers).toMatchObject({ 'if-match': '"before"' })

    const provider = h.deps.fetchImpl
    h.deps.fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes('/events/event-safe') && init?.method === 'PATCH') { return new Response(null, { status: 412 }) }

      return provider(url, init)
    }) as typeof fetch
    await expect(h.manager.write('account-a', 1, updateEvent(calendar.id, writeOperation('007')))).rejects.toMatchObject({ code: 'conflict' })
    expect(mutationCalls(h.deps.fetchImpl)).toHaveLength(1)
  })
})

it('requests only mail, event and calendar-list access and accepts legacy retained grants', async () => {
  const h = googleHarness()
  const status = (await h.manager.connect({ provider: 'google' })).status!
  expect(h.scopes[0].split(' ').sort()).toEqual([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events'
  ].sort())
  const calendar = status.sources.find(source => source.kind === 'calendar' && source.writable)!
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  const saved = JSON.parse(vault.getItem('connections')!)
  saved.accounts[0].credentials['email-calendar'].scopes = saved.accounts[0].credentials['email-calendar'].scopes.map(
    (scope: string) => scope.replace('calendar.calendarlist.readonly', 'calendar.readonly'))
  vault.setItem('connections', JSON.stringify(saved))
  const restarted = new AtumUtilities(h.deps)
  await expect(restarted.write('account-a', 1, updateEvent(calendar.id))).resolves.toMatchObject({ action: 'update-event', id: 'event-safe' })
  expect(h.scopes).toHaveLength(1)
})

it('connects Drive alone without mail scopes and preserves both credentials when mail is added', async () => {
  const h = googleHarness()
  const drive = await h.manager.connect({ provider: 'google', service: 'drive' })
  expect(drive.error).toBeUndefined()
  expect(h.scopes).toEqual(['https://www.googleapis.com/auth/drive.readonly'])
  expect(drive.status!.sources.map(source => source.kind)).toEqual(['drive'])
  const driveSource = drive.status!.sources[0]
  const both = await h.manager.connect({ provider: 'google' })
  expect(both.error).toBeUndefined()
  expect(new Set(both.status!.sources.map(source => source.accountKey))).toEqual(new Set([driveSource.accountKey]))
  expect(both.status!.sources.find(source => source.kind === 'drive')?.id).toBe(driveSource.id)
  const restarted = new AtumUtilities(h.deps)
  expect((await restarted.status()).status!.sources.every(source => source.state === 'connected')).toBe(true)
  const doc = await restarted.read('account-a', 1, { kind: 'drive', action: 'file', id: 'doc', sources: [driveSource.id] }) as any
  expect(doc.results[0].data.text).toBe('Drive document for first@example.com')
  expect(doc.results[0].sourceId).toBe(driveSource.id)
  expect((await restarted.read('account-a', 1, { kind: 'email', action: 'inbox' }) as any).results[0].data.messages).toHaveLength(1)
  expect(h.revoked).toEqual([])
})

it('adds Drive to an existing mail account without changing calendar choices, and scopes status failures', async () => {
  const h = googleHarness()
  const mail = await h.manager.connect({ provider: 'google' })
  const team = mail.status!.sources.find(source => source.label === 'Team calendar')!
  await h.manager.setEnabled([{ id: team.id, enabled: true }])
  const drive = await h.manager.connect({ provider: 'google', service: 'drive' })
  expect(drive.error).toBeUndefined()
  expect(drive.status!.sources.find(source => source.id === team.id)?.enabled).toBe(true)
  expect(new Set(drive.status!.sources.map(source => source.accountKey)).size).toBe(1)
  h.driveDeniedAccounts.add('first@example.com')
  const status = (await h.manager.status()).status!
  expect(status.sources.find(source => source.kind === 'drive')?.state).toBe('reconnect')
  expect(status.sources.filter(source => source.kind !== 'drive').every(source => source.state === 'connected')).toBe(true)
  expect((await h.manager.read('account-a', 1, { kind: 'email', action: 'inbox' }) as any).results).toHaveLength(1)
  expect(h.revoked).toEqual([])
})

it('preserves working mail and its credentials when Drive consent is denied', async () => {
  const h = googleHarness()
  const before = await h.manager.connect({ provider: 'google' })
  h.partial()
  const denied = await h.manager.connect({ provider: 'google', service: 'drive' })
  expect(denied.error).toBe('denied')
  expect(denied.status!.sources).toEqual(before.status!.sources)
  expect(h.revoked).toEqual([])
  expect((await h.manager.read('account-a', 1, { kind: 'email', action: 'inbox' }) as any).results).toHaveLength(1)
})

it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'])('keeps Drive connected after a %s response', async reason => {
  const h = googleHarness()
  const source = (await h.manager.connect({ provider: 'google', service: 'drive' })).status!.sources[0]
  const provider = h.deps.fetchImpl
  h.deps.fetchImpl = vi.fn(async (url, init) => new URL(String(url)).pathname === '/drive/v3/files'
    ? Response.json({ error: { message: 'private provider detail', errors: [{ reason }] } }, { status: 403 })
    : provider(url, init)) as typeof fetch
  const result = await h.manager.read('account-a', 1, { kind: 'drive', action: 'files' }) as any
  expect(result.failures).toMatchObject([{ sourceId: source.id, error: 'network' }])
  expect(JSON.stringify(result)).not.toContain('private provider detail')
  // Inspect persisted state before status() could repair a spurious reconnect.
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  expect(JSON.parse(vault.getItem('connections')!).sources.find((item: any) => item.id === source.id).state).toBe('connected')
  h.deps.fetchImpl = provider
  expect((await h.manager.read('account-a', 1, { kind: 'drive', action: 'files' }) as any).results).toHaveLength(1)
})

it('keeps Drive working when adding mail consent fails', async () => {
  const h = googleHarness()
  const before = await h.manager.connect({ provider: 'google', service: 'drive' })
  h.partial()
  const denied = await h.manager.connect({ provider: 'google' })
  expect(denied.error).toBe('denied')
  expect(denied.status!.sources).toEqual(before.status!.sources)
  expect(h.revoked).toEqual([])
  expect((await h.manager.read('account-a', 1, { kind: 'drive', action: 'files' }) as any).results).toHaveLength(1)
})

it('revokes the surviving Drive token when the mail token is already invalid', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  const both = await h.manager.connect({ provider: 'google', service: 'drive' })
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  const credentials = JSON.parse(vault.getItem('connections')!).accounts[0].credentials
  h.invalidTokens.add(credentials['email-calendar'].refreshToken)
  const disconnected = await h.manager.disconnect({ provider: 'google', accountKey: both.status!.sources[0].accountKey! })
  expect(disconnected.error).toBeUndefined()
  expect(disconnected.status!.sources).toEqual([])
  expect(h.revoked).toEqual([credentials['email-calendar'].refreshToken, credentials.drive.refreshToken])
})

it('rejects a malformed stored Drive credential without overwriting the store', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google', service: 'drive' })
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  const saved = JSON.parse(vault.getItem('connections')!)
  saved.accounts[0].credentials.drive.refreshToken = { invalid: true }
  const raw = JSON.stringify(saved)
  vault.setItem('connections', raw)
  expect((await new AtumUtilities(h.deps).status()).error).toBe('storage')
  expect(vault.getItem('connections')).toBe(raw)
})

it('binds Drive file reads to one account and searches only selected accounts', async () => {
  const h = googleHarness()
  const first = (await h.manager.connect({ provider: 'google', service: 'drive' })).status!.sources[0]
  h.setLabel('second@example.com')
  const second = (await h.manager.connect({ provider: 'google', service: 'drive' })).status!.sources.find(source => source.id !== first.id)!
  const all = await h.manager.read('account-a', 1, { kind: 'drive', action: 'files' }) as any
  expect(all.results.map((item: any) => item.data.files[0].sourceId)).toEqual([first.id, second.id])
  await expect(h.manager.read('account-a', 1, { kind: 'drive', action: 'file', id: 'doc' })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(h.manager.read('account-a', 1, { kind: 'drive', action: 'file', id: 'doc', sources: [first.id, second.id] })).rejects.toMatchObject({ code: 'invalid_input' })
  await h.manager.setEnabled([{ id: first.id, enabled: false }])
  const selected = await h.manager.read('account-a', 1, { kind: 'drive', action: 'files' }) as any
  expect(selected.results.map((item: any) => item.sourceId)).toEqual([second.id])
  expect(selected.skipped).toContainEqual({ sourceId: first.id, reason: 'disabled' })
  const explicit = await h.manager.read('account-a', 1, { kind: 'drive', action: 'file', id: 'doc', sources: [first.id] }) as any
  expect(explicit.results[0].data.text).toContain('first@example.com')
  const removed = await h.manager.disconnect({ provider: 'google', accountKey: first.accountKey! })
  expect(removed.status!.sources.map(source => source.id)).toEqual([second.id])
  expect(h.revoked).toHaveLength(1)
})

it('migrates the existing multi-account store without losing source identities or preferences', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  const saved = JSON.parse(vault.getItem('connections')!)
  const legacy = { ...saved, version: 2, accounts: saved.accounts.map((account: any) => ({ accountKey: account.accountKey, credential: account.credentials['email-calendar'] })) }
  vault.setItem('connections', JSON.stringify(legacy))
  const status = await new AtumUtilities(h.deps).status()
  expect(status.error).toBeUndefined()
  expect(status.status!.sources.map(({ id, enabled }) => ({ id, enabled }))).toEqual(saved.sources.map(({ id, enabled }: any) => ({ id, enabled })))
  expect(JSON.parse(vault.getItem('connections')!).accounts[0].credentials['email-calendar']).toEqual(legacy.accounts[0].credential)
})

it('adds accounts, preserves calendar choices on reconnect, and only revokes the selected account', async () => {
  const h = googleHarness()
  const first = await h.manager.connect({ provider: 'google' })
  expect(first.error).toBeUndefined()
  const firstEmail = first.status!.sources.find(source => source.kind === 'email')!
  const firstTeam = first.status!.sources.find(source => source.label === 'Team calendar')!
  expect(firstTeam.enabled).toBe(false)
  await h.manager.setEnabled([{ id: firstTeam.id, enabled: true }])
  h.setLabel('second@example.com')
  const second = await h.manager.connect({ provider: 'google' })
  expect(second.status!.sources.filter(source => source.kind === 'email')).toHaveLength(2)
  h.setLabel('first@example.com')
  const reconnect = await h.manager.connect({ provider: 'google' })
  expect(reconnect.status!.sources.filter(source => source.kind === 'email')).toHaveLength(2)
  expect(reconnect.status!.sources.find(source => source.id === firstTeam.id)?.enabled).toBe(true)
  expect(h.revoked).toEqual([])
  await h.manager.connect({ provider: 'apple-calendar' })
  h.failRevoke(true)
  expect((await h.manager.disconnect({ provider: 'google', accountKey: firstEmail.accountKey! })).error).toBe('network')
  h.failRevoke(false)
  const disconnected = await h.manager.disconnect({ provider: 'google', accountKey: firstEmail.accountKey! })
  expect(disconnected.status!.sources.some(source => source.accountKey === firstEmail.accountKey)).toBe(false)
  expect(disconnected.status!.sources.filter(source => source.kind === 'email').map(source => source.label)).toEqual(['second@example.com'])
  expect(disconnected.status!.sources.some(source => source.provider === 'apple-calendar')).toBe(true)
  expect(h.revoked.every(token => token.startsWith('first@example.com|'))).toBe(true)
  expect(JSON.stringify(disconnected)).not.toContain('native-private-id')
  expect(JSON.stringify(disconnected)).not.toContain('refreshToken')
  expect(readFileSync(join(h.root, 'utilities.credentials.json'), 'utf8')).not.toContain('second@example.com')
  expect((await new AtumUtilities(h.deps).status()).status!.sources.some(source => source.label === 'second@example.com')).toBe(true)
})

it('passes a freshly refreshed token only to a main-process Google proof callback', async () => {
  const h = googleHarness()
  const first = await h.manager.connect({ provider: 'google' })
  const firstEmail = first.status!.sources.find(source => source.kind === 'email')!
  h.setLabel('second@example.com')
  const second = await h.manager.connect({ provider: 'google' })
  const secondEmail = second.status!.sources.find(source => source.kind === 'email' && source.accountKey !== firstEmail.accountKey)!
  let suppliedToken: string | undefined

  const proof = await h.manager.withGoogleConnectionProof('email', (accessToken, connection) => {
    suppliedToken = accessToken

    return connection
  })

  expect(suppliedToken).toBe('access-token:first@example.com')
  expect(proof).toEqual({ sourceId: firstEmail.id, accountKey: firstEmail.accountKey, label: 'first@example.com', service: 'email' })
  expect(JSON.stringify(proof)).not.toContain(suppliedToken!)
  await h.manager.setEnabled([{ id: firstEmail.id, enabled: false }])
  await expect(h.manager.withGoogleConnectionProof('email', (_token, connection) => connection)).resolves.toMatchObject({ sourceId: secondEmail.id, accountKey: secondEmail.accountKey })
  await h.manager.setEnabled([{ id: secondEmail.id, enabled: false }])
  await expect(h.manager.withGoogleConnectionProof('email', () => undefined)).rejects.toThrow('unavailable')
})

it('does not run a Google proof callback after its account/revision fence changes', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  let release!: (response: Response) => void
  const tokenRefresh = new Promise<Response>(resolve => { release = resolve })
  vi.mocked(h.deps.fetchImpl).mockImplementationOnce(async url => {
    if (new URL(String(url)).pathname === '/token') { return tokenRefresh }

    throw new Error('unexpected provider request')
  })
  const callback = vi.fn()
  const proof = h.manager.withGoogleConnectionProof('email', callback)
  h.setAccount({ accountId: 'account-b', generation: 2, root: h.root })
  release(Response.json({ access_token: 'fresh-access-token' }))

  await expect(proof).rejects.toThrow('account_changed')
  expect(callback).not.toHaveBeenCalled()
})

it('migrates old Google and Apple connections and overwrites discontinued iCloud passwords', async () => {
  const h = googleHarness()
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  const google = { clientId: 'example.apps.googleusercontent.com', label: 'first@example.com', refreshToken: 'first@example.com|old' }
  const connection = { provider: 'google', label: google.label, state: 'connected', google }
  vault.setItem('connections', JSON.stringify({ email: connection, calendar: connection }))
  const status = await h.manager.status()
  expect(status.error).toBeUndefined()
  expect(new Set(status.status!.sources.map(source => source.accountKey)).size).toBe(1)
  expect(status.status!.sources.find(source => source.primary)?.enabled).toBe(true)
  vault.setItem('connections', JSON.stringify({ email: { provider: 'icloud', password: 'discard-this-secret' }, calendar: { provider: 'apple-calendar', label: 'Mac', state: 'connected' } }))
  expect((await new AtumUtilities(h.deps).status()).status!.sources.map(source => source.provider)).toEqual(['apple-calendar'])
  const migrated = vault.getItem('connections')!
  expect(migrated).not.toContain('discard-this-secret')
  expect((await new AtumUtilities(h.deps).status()).error).toBeUndefined()
  vault.setItem('connections', JSON.stringify({ version: 99 }))
  expect((await new AtumUtilities(h.deps).status()).error).toBe('storage')
  expect(JSON.parse(vault.getItem('connections')!).version).toBe(99)
})

it('keeps each source and its provenance, and reports partial outages instead of empty results', async () => {
  const h = googleHarness()
  const first = await h.manager.connect({ provider: 'google' })
  const firstEmail = first.status!.sources.find(source => source.kind === 'email')!
  h.setLabel('second@example.com')
  await h.manager.connect({ provider: 'google' })
  h.revokedAccounts.add('second@example.com')
  const result: any = await h.manager.read('account-a', 1, { kind: 'email', action: 'inbox' })
  expect(result.partial).toBe(true)
  expect(result.results).toHaveLength(1)
  expect(result.results[0].data.messages[0].sourceId).toBe(firstEmail.id)
  expect(result.failures[0]).toMatchObject({ label: 'second@example.com', error: 'reconnect' })
  await h.manager.setEnabled([{ id: firstEmail.id, enabled: false }])
  const disabled: any = await h.manager.read('account-a', 1, { kind: 'email', action: 'inbox' })
  expect(disabled.skipped).toContainEqual({ sourceId: firstEmail.id, reason: 'disabled' })
  expect(disabled.results).toHaveLength(0)
  const explicit: any = await h.manager.read('account-a', 1, { kind: 'email', action: 'message', sources: [firstEmail.id], id: 'same-id' })
  expect(explicit.results[0].data.sourceId).toBe(firstEmail.id)
  await expect(h.manager.read('account-a', 1, { kind: 'email', action: 'message', id: 'same-id' })).rejects.toThrow('invalid_input')
  vi.mocked(h.deps.fetchImpl).mockClear()
  await expect(h.manager.read('account-a', 1, { kind: 'email', action: 'inbox', sources: ['unknown'] })).rejects.toThrow('invalid_input')
  expect(h.deps.fetchImpl).not.toHaveBeenCalled()
  await expect(h.manager.read('account-a', 1, { kind: 'email', action: 'send' })).rejects.toThrow('invalid_input')
})

it('selects individual Google and Mac calendars and keeps overlapping events visible', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  const connected = await h.manager.connect({ provider: 'apple-calendar' })
  h.deps.apple.calendar.mockResolvedValue({ events: [{ id: 'native-event', title: 'Shared meeting' }] })
  const result: any = await h.manager.read('account-a', 1, { kind: 'calendar', action: 'events' })
  expect(result.results).toHaveLength(2)
  expect(result.overlap).toBe(true)
  expect(result.results.flatMap((item: any) => item.data.events).map((item: any) => item.title)).toEqual(['Shared meeting', 'Shared meeting'])
  expect(h.deps.apple.calendar).toHaveBeenLastCalledWith(expect.objectContaining({ calendarIds: ['native-private-id'] }), expect.any(AbortSignal))
  expect(result.skipped).toHaveLength(1)
  const apple = connected.status!.sources.find(source => source.provider === 'apple-calendar')!
  await h.manager.setEnabled([{ id: apple.id, enabled: false }])
  h.deps.apple.calendar.mockClear()
  await h.manager.read('account-a', 1, { kind: 'calendar', action: 'events' })
  expect(h.deps.apple.calendar).not.toHaveBeenCalled()
})

it('reads a year of calendar history through provider-sized windows', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  vi.mocked(h.deps.fetchImpl).mockClear()
  const { read } = matrixGoogleUtilityInput(
    { action: 'agenda', when: 'past_365d' },
    new Date(2026, 9, 4, 12)
  ) as { read: Record<string, unknown> }
  const result: any = await h.manager.read('account-a', 1, read)

  expect(result.partial).toBe(false)
  expect(result.truncated).toBe(false)
  expect(result.results).toHaveLength(1)
  const events = vi.mocked(h.deps.fetchImpl).mock.calls
    .map(([url]) => new URL(String(url)))
    .filter(url => url.pathname.endsWith('/events'))
  expect(events.length).toBeGreaterThan(12)
  for (const call of events) {
    const span = Date.parse(call.searchParams.get('timeMax')!) - Date.parse(call.searchParams.get('timeMin')!)
    expect(span).toBeGreaterThan(0)
    expect(span).toBeLessThanOrEqual(31 * 86_400_000)
  }
  expect(Math.min(...events.map(call => Date.parse(call.searchParams.get('timeMin')!))))
    .toBe(Date.parse(String(read.start)))
  expect(Math.max(...events.map(call => Date.parse(call.searchParams.get('timeMax')!))))
    .toBe(Date.parse(String(read.end)))
})

it('keeps a past_30d calendar read working across a DST shift', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  vi.mocked(h.deps.fetchImpl).mockClear()
  // 30 local days around the 2026 fall-back: 31 days and one hour in absolute time.
  const read = {
    kind: 'calendar', action: 'events', limit: 250,
    start: '2026-10-04T00:00:00-04:00', end: '2026-11-04T00:00:00-05:00'
  }
  expect(Date.parse(read.end) - Date.parse(read.start)).toBe(31 * 86_400_000 + 3_600_000)

  const result: any = await h.manager.read('account-a', 1, read)

  expect(result.partial).toBe(false)
  expect(result.results).toHaveLength(1)
  const events = vi.mocked(h.deps.fetchImpl).mock.calls
    .map(([url]) => new URL(String(url)))
    .filter(url => url.pathname.endsWith('/events'))
  expect(events.length).toBeGreaterThan(1)
  for (const call of events) {
    expect(Date.parse(call.searchParams.get('timeMax')!) - Date.parse(call.searchParams.get('timeMin')!))
      .toBeLessThanOrEqual(31 * 86_400_000)
  }
})

it('signals truncation when a calendar page is cut', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  const base = vi.mocked(h.deps.fetchImpl).getMockImplementation()!
  vi.mocked(h.deps.fetchImpl).mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/events')) {
      return Response.json({ items: [{ id: 'event', summary: 'One' }], nextPageToken: 'next' })
    }
    return base(url, init)
  })

  const result: any = await h.manager.read('account-a', 1, { kind: 'calendar', action: 'events' })

  expect(result.truncated).toBe(true)
})

it('passes a year-long native calendar range through the same bounds', async () => {
  const h = harness()
  await h.manager.connect({ provider: 'apple-calendar' })
  h.deps.apple.calendar.mockResolvedValue({ events: [] })

  const result: any = await h.manager.read('account-a', 1, {
    kind: 'calendar', action: 'events', limit: 250,
    start: '2025-10-04T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z'
  })

  expect(result.results).toHaveLength(1)
  expect(h.deps.apple.calendar).toHaveBeenLastCalledWith(
    expect.objectContaining({ start: '2025-10-04T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' }),
    expect.any(AbortSignal)
  )
})

it('retains connection facts during network failures, but marks revoked grants for reconnect', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  h.setLabel('second@example.com')
  await h.manager.connect({ provider: 'google' })
  h.offlineAccounts.add('first@example.com')
  const offline = await new AtumUtilities(h.deps).status()
  expect(offline.status!.degraded).toBe(true)
  expect(offline.status!.sources.every(source => source.state === 'connected')).toBe(true)
  h.revokedAccounts.add('second@example.com')
  const revoked = await new AtumUtilities(h.deps).status()
  expect(revoked.status!.sources.filter(source => source.detail === 'second@example.com' || source.label === 'second@example.com').every(source => source.state === 'reconnect')).toBe(true)
})

it('does not revoke an existing grant after failed re-consent, but cleans up new partial grants', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  h.partial()
  expect((await h.manager.connect({ provider: 'google' })).error).toBe('denied')
  expect(h.revoked).toEqual([])
  expect((await h.manager.status()).status!.sources.some(source => source.kind === 'email')).toBe(true)
  const fresh = googleHarness()
  fresh.partial()
  expect((await fresh.manager.connect({ provider: 'google' })).error).toBe('denied')
  expect(fresh.revoked).toHaveLength(1)
  expect((await fresh.manager.status()).status!.sources).toHaveLength(0)
})

it('fences cancellation, account switches, and data returned after disconnect', async () => {
  const h = harness()
  h.deps.safeStorage.isEncryptionAvailable = () => false
  expect((await h.manager.connect({ provider: 'apple-calendar' })).error).toBe('storage')
  expect(h.deps.apple.calendar).not.toHaveBeenCalled()
  h.deps.safeStorage.isEncryptionAvailable = () => true
  h.deps.apple.calendar.mockRejectedValueOnce(new UtilityFailure('denied'))
  expect((await h.manager.connect({ provider: 'apple-calendar' })).error).toBe('denied')
  let finish!: (value: any) => void
  h.deps.apple.calendar.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const cancelled = h.manager.connect({ provider: 'apple-calendar' })
  h.manager.cancel()
  finish({ calendars: [] })
  expect((await cancelled).error).toBe('account_changed')
  await h.manager.connect({ provider: 'apple-calendar' })
  h.deps.apple.calendar.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const read = h.manager.read('account-a', 1, { kind: 'calendar', action: 'events' })
  await h.manager.disconnect({ provider: 'apple-calendar' })
  finish({ events: [{ title: 'private' }] })
  await expect(read).rejects.toThrow('account_changed')
  h.deps.apple.calendar.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const switched = h.manager.connect({ provider: 'apple-calendar' })
  h.setAccount({ accountId: 'account-b', generation: 2, root: join(h.root, 'b') })
  finish({ calendars: [] })
  expect((await switched).error).toBe('account_changed')
})

it('lets only the primary broker credential invoke an approved utility write', async () => {
  const h = googleHarness()
  const roots = new AccountRootAuthority(join(h.root, 'roots'))
  const authority = new AtumFilesystemCapabilityAuthority()
  const paths = roots.prepare('account-a')
  authority.activateAccount({ accountId: 'account-a', generation: 1, paths })
  h.setAccount({ accountId: 'account-a', generation: 1, root: paths.root })
  const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
  const broker = new AtumFilesystemActionBroker(authority, undefined, undefined, h.manager)
  await broker.start()
  cleanups.push(() => broker.stop())
  const sessionId = 'utility-write-session'
  const primary = broker.backendEnvironment(undefined, true)

  const request = (environment: Record<string, string>) => fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/utilities/write`, {
    method: 'POST', headers: { authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...sendEmail(email.id, writeOperation('008')), sessionId })
  })

  const group = broker.backendEnvironment('group-agent')
  broker.authorizeWorkspaceSourceRead(sessionId, 1, group.ATUM_FILESYSTEM_BROKER_TOKEN)
  expect((await request(primary)).status).toBe(403)
  broker.authorizeWorkspaceSourceRead(sessionId, 1, primary.ATUM_FILESYSTEM_BROKER_TOKEN)
  await expect(request(primary)).resolves.toMatchObject({ status: 200 })
  expect(await (await request(broker.backendEnvironment('group-agent'))).json()).toEqual({ error: 'account_changed' })
})

it('spends one Workspace permit per session read, honours revocation, reports partial results and fences the account', async () => {
  const h = googleHarness()
  const roots = new AccountRootAuthority(join(h.root, 'roots'))
  const authority = new AtumFilesystemCapabilityAuthority()
  const paths = roots.prepare('account-a')
  authority.activateAccount({ accountId: 'account-a', generation: 1, paths })
  h.setAccount({ accountId: 'account-a', generation: 1, root: paths.root })
  await h.manager.connect({ provider: 'google' })
  h.setLabel('second@example.com')
  await h.manager.connect({ provider: 'google' })
  const broker = new AtumFilesystemActionBroker(authority, undefined, undefined, h.manager)
  await broker.start()
  cleanups.push(() => broker.stop())
  const sessionId = 'utility-session-a'
  const env = broker.backendEnvironment(undefined, true)
  const inbox = { kind: 'email', action: 'inbox' }

  const read = async (environment: Record<string, string>, input: Record<string, unknown> = inbox, session = sessionId) => {
    const response = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/utilities/read`, {
      method: 'POST', headers: { authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, sessionId: session })
    })

    return { status: response.status, result: await response.json() as any }
  }

  const permit = () => broker.authorizeWorkspaceSourceRead(sessionId, 1, env.ATUM_FILESYSTEM_BROKER_TOKEN)

  expect(await read(env)).toEqual({ status: 403, result: { error: 'workspace_model_required' } })
  permit()
  expect((await read(env)).result.results).toHaveLength(2)
  const drive = (await h.manager.connect({ provider: 'google', service: 'drive' })).status!.sources.find(source => source.kind === 'drive')!
  expect((await read(env, { kind: 'drive', action: 'files' })).result).toEqual({ error: 'workspace_model_required' })
  permit()
  expect((await read(env, { kind: 'drive', action: 'files', query: 'a document' })).result.results[0].sourceId).toBe(drive.id)
  permit()
  const file = await read(env, { kind: 'drive', action: 'file', sources: [drive.id], id: 'doc' })
  expect(file.status).toBe(200)
  expect(file.result).not.toHaveProperty('error')
  expect(file.result.partial).toBeFalsy()
  expect(file.result.results[0].data.text).toBe('Drive document for second@example.com')
  // A permit belongs to the session it was granted for.
  permit()
  expect((await read(env, inbox, 'utility-session-b')).result).toEqual({ error: 'workspace_model_required' })

  const revocation = await fetch(`${env.ATUM_FILESYSTEM_BROKER_URL}/v1/utilities/revoke-workspace-source-reads`, {
    method: 'POST', headers: { authorization: `Bearer ${env.ATUM_FILESYSTEM_BROKER_TOKEN}` }
  })

  expect(revocation.status).toBe(200)
  expect((await read(env)).result).toEqual({ error: 'workspace_model_required' })
  h.revokedAccounts.add('second@example.com')
  permit()
  const partial = await read(env)
  expect(partial.status).toBe(200)
  expect(partial.result.partial).toBe(true)
  expect(partial.result.results).toHaveLength(1)
  expect(await read(broker.backendEnvironment('group-agent'))).toEqual({ status: 403, result: { error: 'account_changed' } })
  authority.activateAccount({ accountId: 'account-b', generation: 2, paths: roots.prepare('account-b') })
  expect((await read(env)).result.error).toBe('account_changed')
  expect((await read({ ...env, ATUM_FILESYSTEM_BROKER_TOKEN: 'wrong' })).status).toBe(401)
  expect((await read(broker.backendEnvironment('default'))).result).toEqual({ error: 'account_changed' })
})

describe('Google loopback OAuth', () => {
  it('checks state and PKCE, then verifies both APIs through real HTTP before connecting', async () => {
    let challenge = ''
    const paths: string[] = []

    const provider = createServer(async (request, response) => {
      paths.push(request.url!)
      response.setHeader('content-type', 'application/json')

      if (request.url === '/token') {
        let body = ''

        for await (const chunk of request) { body += chunk }
        const params = new URLSearchParams(body)
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge)
        response.end(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events' }))
      } else if (request.url!.includes('/profile')) {
        expect(request.headers.authorization).toBe('Bearer test-access')
        response.end(JSON.stringify({ emailAddress: 'test@example.com' }))
      } else { response.end(JSON.stringify({ items: [] })) }
    })

    const base = await listen(provider)
    let callbackUrl = ''

    const open = async (value: string) => {
      const url = new URL(value)
      challenge = url.searchParams.get('code_challenge')!
      callbackUrl = url.searchParams.get('redirect_uri')!
      expect(url.hostname).toBe('accounts.google.com')
      expect((await fetch(`${callbackUrl}?state=wrong&code=untrusted`)).status).toBe(400)
      await fetch(`${callbackUrl}?state=${url.searchParams.get('state')}&code=example-code`)
    }

    const result = await authorizeGoogle({ clientId: 'example.apps.googleusercontent.com' }, open,
      (url, init) => fetch(base + new URL(String(url)).pathname + new URL(String(url)).search, init), new AbortController().signal)

    expect(result.credential.label).toBe('test@example.com')
    expect(paths.some(path => path.includes('/calendar/'))).toBe(true)
    await expect(fetch(callbackUrl)).rejects.toThrow()
  })

  it('closes its callback on cancel, denial, and timeout without exposing callback secrets', async () => {
    const controller = new AbortController()
    const open = vi.fn(async () => { controller.abort() })
    await expect(authorizeGoogle({ clientId: 'example' }, open, fetch, controller.signal)).rejects.toThrow('cancelled')
    await expect(authorizeGoogle({ clientId: 'example' }, async value => {
      const url = new URL(value)
      await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&error=access_denied`)
    }, fetch, new AbortController().signal)).rejects.toThrow('denied')
    await expect(authorizeGoogle({ clientId: 'example' }, async () => {}, fetch, new AbortController().signal, 10)).rejects.toThrow('timeout')
  })
})


it('re-homes only a running primary backend with a missing or changed account binding', async () => {
  const { manager, root } = harness()
  const authority = new AtumFilesystemCapabilityAuthority()
  const broker = new AtumFilesystemActionBroker(authority, undefined, undefined, manager)
  await broker.start()
  cleanups.push(() => broker.stop())
  const account = { accountId: 'account-a', accountGeneration: 1 }
  const prelogin = broker.backendEnvironment(undefined, true)

  const response = await fetch(`${prelogin.ATUM_FILESYSTEM_BROKER_URL}/v1/utilities/read`, {
    method: 'POST', headers: { authorization: `Bearer ${prelogin.ATUM_FILESYSTEM_BROKER_TOKEN}` }, body: JSON.stringify({ action: 'status' })
  })

  expect(response.status).toBe(403)

  const route = (environment: Record<string, string>) => fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/utilities/route-authority`, {
    headers: { authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}` }
  })

  expect((await route(prelogin)).status).toBe(403)
  expect(broker.needsUtilityRehome(account, false)).toBe(false)
  expect(broker.needsUtilityRehome(account, true)).toBe(true)
  authority.activateAccount({ accountId: account.accountId, generation: account.accountGeneration, paths: new AccountRootAuthority(join(root, 'roots')).prepare(account.accountId) })
  const signedIn = broker.backendEnvironment(undefined, true)
  expect((await route(prelogin)).status).toBe(401)
  expect(await (await route(signedIn)).json()).toEqual({
    protected: false, workspaceAlias: 'binh-minh', accountKey: accountKeyFor(account.accountId), agentId: DEFAULT_AGENT_ID
  })
  expect(broker.needsUtilityRehome(account, true)).toBe(false)
  expect(broker.needsUtilityRehome({ ...account, accountGeneration: 2 }, true)).toBe(true)
  expect(broker.needsUtilityRehome({ ...account, accountId: 'account-b' }, true)).toBe(true)
  broker.revokeBackendCredential()
  expect(broker.needsUtilityRehome(account, true)).toBe(true)
})

it('keeps Mac preferences through empty inventory and asks for selection after identifiers change', async () => {
  const h = harness()
  const original = (await h.manager.connect({ provider: 'apple-calendar' })).status!.sources[0]
  h.deps.apple.calendar.mockResolvedValue({ calendars: [] })
  const empty = await new AtumUtilities(h.deps).status()
  expect(empty.status!.degraded).toBe(true)
  expect(empty.status!.sources[0]).toEqual(original)
  h.deps.apple.calendar.mockResolvedValue({ calendars: [{ id: 'new-native-id', label: 'Personal' }] })
  const manager = new AtumUtilities(h.deps)
  const changed = await manager.status()
  expect(changed.status!.calendarSelectionRequired).toBe(true)
  expect(changed.status!.sources[0].enabled).toBe(false)
  expect(await manager.read('account-a', 1, { kind: 'calendar', action: 'events' })).toMatchObject({ error: 'calendar_selection_required' })
  expect((await manager.setEnabled([{ id: changed.status!.sources[0].id, enabled: true }])).status!.calendarSelectionRequired).toBe(false)
  const fresh = harness()
  fresh.deps.apple.calendar.mockResolvedValue({ calendars: [] })
  expect((await fresh.manager.connect({ provider: 'apple-calendar' })).status!.appleConnected).toBe(true)
  expect((await fresh.manager.disconnect({ provider: 'apple-calendar' })).status!.appleConnected).toBe(false)
})

it('expands a migrated Mac connection on its first read without requiring re-consent', async () => {
  const h = harness()
  const vault = new SafeStorageAuthStorage(join(h.root, 'utilities.credentials.json'), h.deps.safeStorage)
  vault.setItem('connections', JSON.stringify({ email: null, calendar: { provider: 'apple-calendar', label: 'Mac', state: 'connected' } }))
  h.deps.apple.calendar.mockImplementation(async input => input.action === 'events' ? { events: [] } : { calendars: [{ id: 'native-id', label: 'Personal' }] })
  const result: any = await h.manager.read('account-a', 1, { kind: 'calendar', action: 'events' })
  expect(result.failures).toEqual([])
  expect(result.results).toHaveLength(1)
  expect(h.deps.apple.calendar).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'connect' }), expect.anything())
})

it('does not revoke the existing Google grant when a re-consent profile lookup fails', async () => {
  const h = googleHarness()
  await h.manager.connect({ provider: 'google' })
  const fetchImpl = h.deps.fetchImpl
  h.deps.fetchImpl = vi.fn(async (url, init) => {
    if (String(url).includes('/profile')) { throw new Error('network') }

    return fetchImpl(url, init)
  }) as typeof fetch
  expect((await h.manager.connect({ provider: 'google' })).error).toBe('network')
  expect(h.revoked).toEqual([])
  expect((await h.manager.setEnabled([{ id: 'foreign', enabled: true }])).error).toBe('invalid_input')
})

it('does not create a credential store during status for an unconnected user', async () => {
  const h = harness()
  h.deps.safeStorage.isEncryptionAvailable = () => false
  expect((await h.manager.status()).error).toBeUndefined()
  expect(h.deps.safeStorage.encryptString).not.toHaveBeenCalled()
})


it('caches protected state per account generation and updates it on consent', async () => {
  const h = googleHarness()
  const decrypt = vi.spyOn(h.deps.safeStorage, 'decryptString')
  expect(h.manager.workspaceProtected()).toBe(false)
  await h.manager.connect({ provider: 'google' })
  decrypt.mockClear()
  expect(h.manager.workspaceProtected()).toBe(true)
  expect(h.manager.workspaceProtected()).toBe(true)
  expect(decrypt).not.toHaveBeenCalled()
  h.setAccount({ accountId: 'account-a', generation: 2, root: h.root })
  expect(h.manager.workspaceProtected()).toBe(true)
  expect(decrypt).toHaveBeenCalledOnce()
  h.setAccount({ accountId: 'new-account', generation: 1, root: join(h.root, 'new-account') })
  expect(h.manager.workspaceProtected()).toBe(false)
  vi.spyOn(h.deps, 'account').mockReturnValue(null as any)
  expect(h.manager.workspaceProtected()).toBe(false)
})

it('recovers a failed broker listen and shares concurrent startup', async () => {
  const { manager } = harness()
  const broker = new AtumFilesystemActionBroker(new AtumFilesystemCapabilityAuthority(), undefined, undefined, manager)
  cleanups.push(() => broker.stop())
  const server = (broker as unknown as { server: Server }).server
  const listen = vi.spyOn(server, 'listen')
  listen.mockImplementationOnce(function (this: Server) { this.emit('error', new Error('temporary listen failure'));

 return this })
  await expect(broker.start()).rejects.toThrow('temporary listen failure')
  await Promise.all([broker.start(), broker.start()])
  expect(listen).toHaveBeenCalledTimes(2)
  expect(broker.backendEnvironment().ATUM_FILESYSTEM_BROKER_URL).toMatch(/^http:\/\/127\.0\.0\.1:/)
})

it('follows one bounded Gmail page cursor and hands the next one back', async () => {
  const urls: string[] = []

  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url))

    if (String(url).includes('/messages?')) { return Response.json({ messages: [{ id: 'm2' }], nextPageToken: '2222' }) }

    return Response.json({ id: 'm2', threadId: 't2', snippet: 'Older', payload: { headers: [] } })
  }) as unknown as typeof fetch

  const page = await googleRead(fetchImpl, 'token', 'email', { action: 'inbox', query: 'after:2020/01/01', pageToken: '1111' })

  expect(new URL(urls[0]!).searchParams.get('pageToken')).toBe('1111')
  expect(page).toMatchObject({ messages: [{ id: 'm2' }], more: true, nextPageToken: '2222' })
  await expect(googleRead(fetchImpl, 'token', 'email', { action: 'inbox', query: 'x', pageToken: 'a\nb' }))
    .rejects.toThrow(UtilityFailure)
})


describe('approved sends with cc, bcc, reply, forward and attachments', () => {
  const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d])
  const b64u = (value: Buffer | string) => Buffer.from(value).toString('base64url')

  /** The mailbox fake plus an original message with a PDF; records the order of attachment downloads and sends. */
  async function mailHarness(options: { headers?: Array<{ name: string; value: string }>; sendAs?: Array<Record<string, unknown>> } = {}) {
    const h = googleHarness()
    const email = (await h.manager.connect({ provider: 'google' })).status!.sources.find(source => source.kind === 'email')!
    const events: string[] = []
    const base = h.deps.fetchImpl

    const original = {
      id: 'm1', threadId: 't1', payload: {
        mimeType: 'multipart/mixed',
        headers: options.headers ?? [
          { name: 'From', value: 'Lan <lan@example.com>' }, { name: 'Reply-To', value: 'desk@example.com' },
          { name: 'To', value: 'first@example.com, Binh <binh@example.com>' }, { name: 'Cc', value: 'Boss@example.com, binh@example.com' },
          { name: 'Subject', value: 'Báo giá' }, { name: 'Message-ID', value: '<a@m.test>' }, { name: 'Date', value: 'Fri, 07 Nov 2026' }
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64u('Nội dung báo giá') } },
          { mimeType: 'application/pdf', filename: 'báo giá.pdf', body: { attachmentId: 'ATT-1', size: PDF.length } }
        ]
      }
    }

    h.deps.fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname

      if (path.endsWith('/settings/sendAs')) { events.push('sendAs'); return Response.json({ sendAs: options.sendAs ?? [{ sendAsEmail: 'first@example.com', isPrimary: true }] }) }

      if (path.endsWith('/messages/m1/attachments/ATT-1')) { events.push('download'); return Response.json({ data: b64u(PDF) }) }

      if (path.endsWith('/messages/m1')) { return Response.json(original) }

      if (path.endsWith('/messages/send')) { events.push('send') }

      return base(url, init)
    }) as typeof fetch

    const sent = () => vi.mocked(h.deps.fetchImpl).mock.calls
      .filter(([url]) => String(url).includes('/upload/gmail/v1/users/me/messages/send'))
      .map(([, init]) => {
        const upload = parseUpload(new Headers(init!.headers).get('content-type')!, init!.body as Uint8Array)

        return { mime: upload.mime, threadId: (upload.metadata as { threadId?: string } | undefined)?.threadId, uploadType: upload.uploadType }
      })

    const detail = () => (h.deps.confirmWrite.mock.calls.at(-1) as unknown as [{ detail: string }])[0].detail
    const send = (fields: Record<string, unknown>, suffix = '010') =>
      h.manager.write('account-a', 1, { action: 'send-email', operationId: writeOperation(suffix), sourceId: email.id, to: [], subject: '', body: 'Hello', ...fields })

    return { ...h, email, events, sent, detail, send }
  }

  it('shows the owner Cc, Bcc and the file names and sizes, then sends exactly that', async () => {
    const h = await mailHarness()
    const bytes = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251))

    await h.send({ to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'], subject: 'Files', attachments: [{ filename: 'số liệu.bin', data: bytes.toString('base64') }] })

    expect(h.detail()).toContain('From: first@example.com\nTo: a@example.com\nCc: b@example.com\nBcc: c@example.com\nSubject: Files\nAttachments: số liệu.bin (2.0 KB)\n\nHello')
    const mail = decodeMime(h.sent()[0].mime)
    expect([mail.headers.to, mail.headers.cc, mail.headers.bcc]).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(mail.files[0]!.params.filename).toBe('số liệu.bin')
    expect(mail.files[0]!.bytes!.equals(bytes)).toBe(true)
  })

  it('confirms the worked-out reply-all recipients, never the owner, and keeps the thread', async () => {
    const h = await mailHarness()

    await h.send({ reply: { messageId: 'm1', all: true }, cc: ['extra@example.com'], body: 'Cảm ơn' })

    expect(h.detail()).toContain('To: desk@example.com\nCc: binh@example.com, Boss@example.com, extra@example.com\nSubject: Re: Báo giá\nReplies in the same conversation.')
    const sent = h.sent()[0]
    const mail = decodeMime(sent.mime)
    expect(sent.threadId).toBe('t1')
    expect(mail.headers['in-reply-to']).toBe('<a@m.test>')
    expect(decodeWords(mail.headers.subject!)).toBe('Re: Báo giá')
    expect(`${mail.headers.to} ${mail.headers.cc}`).not.toContain('first@example.com')
  })

  it('confirms a forward with the original file’s name and downloads it only after the owner approves', async () => {
    const h = await mailHarness()

    await h.send({ to: ['new@example.com'], body: 'FYI', forward: { messageId: 'm1' } })

    expect(h.detail()).toContain('Attachments: báo giá.pdf (')
    expect(h.detail()).toContain('Forwarded message:\n---------- Forwarded message ---------')
    expect(h.detail()).toContain('Nội dung báo giá')
    // Downloaded after the dialog, before the send; the dialog saw names and sizes only.
    expect(h.events).toEqual(['download', 'send'])
    const mail = decodeMime(h.sent()[0].mime)
    expect(mail.files[0]!.bytes!.equals(PDF)).toBe(true)
    expect(h.sent()[0].threadId).toBeUndefined()
  })

  it('downloads nothing and sends nothing when the owner says no', async () => {
    const h = await mailHarness()
    h.deps.confirmWrite.mockResolvedValueOnce(false)

    await expect(h.send({ to: ['new@example.com'], body: 'FYI', forward: { messageId: 'm1' } }, '011')).rejects.toMatchObject({ code: 'cancelled' })
    expect(h.events).toEqual([])
  })

  it('refuses an over-limit message as a plain failure, before any marker, so a smaller retry with the same operation works', async () => {
    const h = await mailHarness()
    const big = { filename: 'big.bin', data: Buffer.alloc(20 * 1024 * 1024, 3).toString('base64') }

    await expect(h.send({ to: ['a@example.com'], subject: 'Big', attachments: [big] }, '012')).rejects.toMatchObject({ code: 'message_too_large' })
    expect(h.events).toEqual([])
    expect(h.deps.confirmWrite).not.toHaveBeenCalled()
    await h.send({ to: ['a@example.com'], subject: 'Big', attachments: [{ ...big, data: Buffer.from('ok').toString('base64') }] }, '012')
    expect(h.sent()).toHaveLength(1)
  })

  it('sends a 16 MB attachment through Gmail’s media-upload endpoint, whole, and a threaded reply as a multipart upload', async () => {
    const h = await mailHarness()
    const big = Buffer.from(Array.from({ length: 16 * 1024 * 1024 }, (_unused, index) => (index * 11) % 249))

    await h.send({ to: ['a@example.com'], subject: 'Big', attachments: [{ filename: 'big.bin', data: big.toString('base64') }] }, '013')
    await h.send({ reply: { messageId: 'm1' }, body: 'ok' }, '014')

    expect(h.sent().map(sent => sent.uploadType)).toEqual(['media', 'multipart'])
    expect(decodeMime(h.sent()[0].mime).files[0]!.bytes!.equals(big)).toBe(true)
    expect(h.sent()[1].threadId).toBe('t1')
    // Nothing went to the ordinary JSON send endpoint.
    expect(vi.mocked(h.deps.fetchImpl).mock.calls.some(([url]) => new URL(String(url)).pathname === '/gmail/v1/users/me/messages/send')).toBe(false)
  })

  it('knows the owner’s send-as aliases: a message the owner wrote from an alias is answered to its recipients, once-asked and remembered', async () => {
    const h = await mailHarness({
      sendAs: [{ sendAsEmail: 'first@example.com', isPrimary: true }, { sendAsEmail: 'first.work@example.com', verificationStatus: 'accepted' }],
      headers: [
        { name: 'From', value: 'First <first.work@example.com>' }, { name: 'To', value: 'lan@example.com, binh@example.com' },
        { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<a@m.test>' }
      ]
    })

    await h.send({ reply: { messageId: 'm1', all: true }, body: 'ok' }, '015')
    await h.send({ reply: { messageId: 'm1', all: true }, body: 'ok again' }, '016')

    expect(h.detail()).toContain('To: lan@example.com, binh@example.com\n')
    expect(decodeMime(h.sent()[0].mime).headers.to).toBe('lan@example.com, binh@example.com')
    // The alias list was asked for once for both sends (the confirmation and the build share it).
    expect(h.events.filter(event => event === 'sendAs')).toHaveLength(1)
  })

  it('leaves another owner alias out of a reply-all', async () => {
    const h = await mailHarness({
      sendAs: [{ sendAsEmail: 'first@example.com', isPrimary: true }, { sendAsEmail: 'first.work@example.com', verificationStatus: 'accepted' }],
      headers: [
        { name: 'From', value: 'Lan <lan@example.com>' }, { name: 'To', value: 'first.work@example.com, binh@example.com' },
        { name: 'Cc', value: 'first@example.com, boss@example.com' }, { name: 'Subject', value: 'Plan' }, { name: 'Message-ID', value: '<a@m.test>' }
      ]
    })

    await h.send({ reply: { messageId: 'm1', all: true }, body: 'ok' }, '017')

    const mail = decodeMime(h.sent()[0].mime)
    expect([mail.headers.to, mail.headers.cc]).toEqual(['lan@example.com', 'binh@example.com, boss@example.com'])
  })
})

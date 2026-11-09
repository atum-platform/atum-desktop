import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../../../electron/encrypted-store'
import { MatrixAccount } from '../../../electron/matrix/account'
import { matrixConfigurationKey } from '../../../electron/matrix/config'
import { handleMatrixCompanyCommand } from '../../../electron/matrix/main-company'
import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { isDefinitiveCompanyRefusal } from '../../../shared/matrix-company-team-space'

import { requestTeamSpace } from './request'

/*
 * PR #864 review F1, end to end: the renderer's request seam over main's real Company IPC handler over the real
 * account-owned durable journal (`MatrixAccount.company()`), with only `fetch` scripted. A typed add / email-invite 429
 * (the platform records nothing) must release main's journal at the same moment the renderer drops its Retry, so the next
 * press, with a new request ID, reaches the platform. Anything uncertain keeps the journal for an exact replay.
 */
vi.mock('openid-client', () => ({
  discovery: vi.fn(async (_url: string, clientId: string) => ({ clientId })),
  None: () => ({}),
  allowInsecureRequests: () => {},
  refreshTokenGrant: vi.fn(),
  tokenRevocation: vi.fn(async () => {}),
  ResponseBodyError: class extends Error {}
}))

const config = {
  issuer: 'https://id.test/',
  server: 'https://matrix.test',
  nativeClientId: 'matrix',
  callbackPort: 21881,
  domain: { nativeClientId: 'domain', resource: 'https://api.test' }
}

const directories: string[] = []

afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.unstubAllGlobals()
})

/** A signed-in account with a domain grant, on a throwaway encrypted store. */
function signedIn(): MatrixAccount {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-invite-journal-'))
  directories.push(directory)

  const store = new EncryptedStore(path.join(directory, 'vault.json'), {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })

  store.setItem('matrix-account', JSON.stringify({
    version: 1,
    configurationKey: matrixConfigurationKey(config),
    issuer: config.issuer,
    subject: 'alice',
    userId: '@alice:test',
    deviceId: 'A',
    storageKey: Buffer.alloc(32, 1).toString('base64'),
    accessToken: 'matrix-access',
    refreshToken: 'matrix-refresh',
    domain: { issuer: config.issuer, subject: 'alice', accessToken: 'domain-access', refreshToken: 'domain-refresh', sessionId: 'domain-session' }
  }))

  return new MatrixAccount(config, store, async () => {})
}

/** The renderer's bridge: main's real Company IPC handler over this account's journalled request. */
function bridgeOver(account: MatrixAccount): MatrixCompanyBridge {
  const frame = { url: 'atum://matrix' }
  const ui = { mainFrame: frame }

  return {
    pending: async () => ({ ok: true, request: account.companyPending() }),
    request: (input: unknown) => handleMatrixCompanyCommand(input, {
      event: { sender: ui, senderFrame: frame } as never,
      ui: ui as never,
      uiUrl: frame.url,
      enabled: true,
      closing: false,
      available: () => true,
      request: value => account.company(value, AbortSignal.timeout(2000))
    })
  } as unknown as MatrixCompanyBridge
}

const team = '00000000-0000-4000-8000-3570bef6c8ca'

const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json', ...headers } })

const add = (requestId: string) => ({ action: 'member-add' as const, companyId: team, requestId,
  target: { kind: 'matrixUser' as const, memberMatrixUser: '@lan:atum.example' }, role: 'member' as const })

const emailInvite = (requestId: string) => ({ action: 'email-invitation-create' as const, companyId: team, requestId,
  email: 'lan@example.com', locale: 'vi' as const })

const added = { schemaVersion: 12, outcome: 'added', companyId: team, memberRef: 'A'.repeat(43), role: 'member',
  invitationId: '00000000-0000-4000-8000-933779c60f5b', authorityGeneration: 10, replayed: false }

const accepted = { schemaVersion: 10, invitationId: '00000000-0000-4000-8000-71544ed54ec4', state: 'accepted',
  mailStatus: 'accepted', expiresAt: 1793000000, replayed: false }

describe('a typed add or email-invite 429, renderer to journal', () => {
  it.each([
    ['a direct add', add, { error: 'matrix_429', details: { reason: 'member_add_limited' } }, 'member_add_limited', added],
    ['an email invitation', emailInvite, { error: 'matrix_429', details: { reason: 'email_invite_limited', retryable: true } },
      'email_invite_limited', accepted]
  ] as const)('%s: both sides release it, and the next press is a fresh request that reaches the platform', async (
    _name, build, refusal, reason, success
  ) => {
    const account = signedIn()
    const bridge = bridgeOver(account)

    const request = vi.fn()
      .mockResolvedValueOnce(status(429, refusal, { 'Retry-After': '1200' }))
      .mockResolvedValueOnce(status(200, success))

    vi.stubGlobal('fetch', request)

    const first = build('00000000-0000-4000-8000-eb8abd3c16e2')
    const refused = await requestTeamSpace(bridge, first as never)

    expect(refused).toMatchObject({ ok: false, error: 'limit', reason })
    // The renderer's rule (company-workspace drops its Retry) and main's journal agree.
    expect(isDefinitiveCompanyRefusal(first.action, 'limit', reason)).toBe(true)
    await expect(bridge.pending()).resolves.toEqual({ ok: true, request: null })

    const second = build('00000000-0000-4000-8000-c43aa9490abe')
    await expect(requestTeamSpace(bridge, second as never)).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenCalledTimes(2)
    expect(JSON.parse(request.mock.calls[1]![1].body as string).requestId).toBe(second.requestId)
    expect(account.companyPending()).toBeNull()
  })

  it.each([
    ['a 503', () => Promise.resolve(status(503, { error: 'matrix_503' }))],
    ['an untyped 429', () => Promise.resolve(status(429, { error: 'matrix_429' }, { 'Retry-After': '60' }))],
    ['a lost answer', () => Promise.reject(new Error('lost response'))]
  ] as const)('%s keeps the add journalled on both sides: only the exact request replays', async (_name, failure) => {
    const account = signedIn()
    const bridge = bridgeOver(account)
    const request = vi.fn().mockImplementationOnce(failure).mockResolvedValueOnce(status(200, added))

    vi.stubGlobal('fetch', request)

    const first = add('00000000-0000-4000-8000-88dee10a5070')
    const lost = await requestTeamSpace(bridge, first)

    expect(lost.ok).toBe(false)
    expect(isDefinitiveCompanyRefusal(first.action, lost.ok ? '' : lost.error, lost.ok ? undefined : lost.reason)).toBe(false)
    expect(account.companyPending()).toEqual(first)

    await expect(requestTeamSpace(bridge, add('00000000-0000-4000-8000-827bf44f87d4'))).resolves.toMatchObject({ ok: false, error: 'conflict' })
    expect(request).toHaveBeenCalledTimes(1)

    await expect(requestTeamSpace(bridge, first)).resolves.toMatchObject({ ok: true, value: { outcome: 'added' } })
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body)
    expect(account.companyPending()).toBeNull()
  })
})

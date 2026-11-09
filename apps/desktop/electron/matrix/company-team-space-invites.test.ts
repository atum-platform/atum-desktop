import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as wire from '../../shared/matrix-company-team-space'

import { matrixCompanyRoute, parseMatrixCompanyRequest, parseMatrixCompanyResponse, requestMatrixCompany } from './company'

/*
 * The frozen packs platform #794 shipped for Add people: company-workspace 1.9 (email invitations),
 * company-invites 1 (invite readiness) and company-policy 1.2 (who may invite). Copied verbatim from
 * atum-platform and pinned by the same framed digest as the other vendored packs.
 */
const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/team-space')

interface Pack {
  name: string
  contract: { pack_files: string[]; fixtures: Array<{ file: string; message?: string; expect?: 'accept' | 'reject' }> }
  vendored: { sha256: string }
  read(file: string): Buffer
  json(file: string): unknown
}

function pack(name: string): Pack {
  const root = resolve(packRoot, name)
  const read = (file: string) => readFileSync(resolve(root, file))
  const json = (file: string): unknown => JSON.parse(read(file).toString('utf8'))

  return { name, contract: json('contract.json') as Pack['contract'], vendored: json('VENDORED.json') as Pack['vendored'], read, json }
}

function digest(source: Pack): string {
  const hash = createHash('sha256')

  for (const file of source.contract.pack_files) {
    const name = Buffer.from(file, 'utf8')
    const body = source.read(file)
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

const email = pack('atum-company-workspace-v1.9')
const invites = pack('atum-company-invites-v1')
const policy = pack('atum-company-policy-v1.2')

type Check = (value: unknown) => boolean
const schema = (candidate: { safeParse(value: unknown): { success: boolean } }): Check => value => candidate.safeParse(value).success

/** The messages this client sends or reads. Server-to-server MAS facts and the claim (not built here) are not consumed. */
const MESSAGES: Record<string, Record<string, Check>> = {
  [email.name]: {
    'email-invitation.create.request': schema(wire.CompanyEmailInvitationCreate19RequestSchema),
    'email-invitation.create.response': schema(wire.CompanyEmailInvitationCreate19ResponseSchema),
    'invite-link.email-bound-refusal': value => wire.parseMatrixCompanyRefusal(value, 'link')?.reason === 'email_invite_claim_required'
  },
  [invites.name]: { response: schema(wire.CompanyInviteCapabilitiesSchema) },
  [policy.name]: {
    request: schema(wire.CompanyPolicyUpdate12RequestSchema),
    response: schema(wire.CompanyPolicyUpdate12ResponseSchema),
    snapshot: schema(wire.CompanyAdminSnapshotPolicy12ResponseSchema)
  }
}

const NOT_CONSUMED = new Set(['email-invitation.claim.request', 'mas-email-resolution.absent', 'mas-email-resolution.match', 'mas-verified-email.fact'])

describe('vendored invite packs', () => {
  it.each([email, invites, policy])('$name is the exact frozen pack', source => {
    expect(source.read('PINNED-SHA256').toString('utf8').trim()).toBe(source.vendored.sha256)
    expect(digest(source)).toBe(source.vendored.sha256)
  })

  for (const source of [email, invites, policy]) {
    const fixtures = source.contract.fixtures.filter(fixture => fixture.message && !NOT_CONSUMED.has(fixture.message))

    it(`${source.name}: every consumed message has a parser`, () => {
      expect(fixtures.filter(fixture => !MESSAGES[source.name]![fixture.message!]).map(fixture => fixture.message)).toEqual([])
    })

    it.each(fixtures.map(fixture => [fixture.file, fixture] as const))(`${source.name}: %s`, (_file, fixture) => {
      expect(MESSAGES[source.name]![fixture.message!]!(source.json(fixture.file))).toBe(fixture.expect !== 'reject')
    })
  }
})

const companyId = '00000000-0000-4000-8000-72805976e3a7'
const requestId = '00000000-0000-4000-8000-30e86fb27729'

describe('invite routes', () => {
  it('asks invite readiness on the capabilities read with its own profile header', () => {
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'invite-readiness' }))).toEqual({
      method: 'GET', path: '/company-capabilities', wire: '1.3', profile: { header: 'Atum-Company-Invites', value: '1' }
    })
  })

  it('asks who may invite on the administration read with company policy 1.2', () => {
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'administration-policy', companyId }))).toEqual({
      method: 'GET', path: `/companies/${companyId}/administration`, wire: '1.3', profile: { header: 'Atum-Company-Policy', value: '1.2' }
    })
  })

  it('sends an email invitation on wire 1.9 with exactly the frozen body', () => {
    const route = matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'email-invitation-create', companyId, requestId,
      email: 'person@example.com', locale: 'vi' }))

    expect(route).toEqual({ method: 'POST', path: `/companies/${companyId}/email-invitations`, wire: '1.9',
      body: email.json('fixtures/email-invitation.create.request.json') })
  })

  it('refuses an address that is not one complete trimmed email before anything is sent', () => {
    for (const bad of ['person', ' person@example.com', 'person@example', 'a b@example.com']) {
      expect(() => parseMatrixCompanyRequest({ action: 'email-invitation-create', companyId, requestId, email: bad, locale: 'en' })).toThrow()
    }

    expect(() => parseMatrixCompanyRequest({ action: 'email-invitation-create', companyId, requestId, email: 'person@example.com',
      locale: 'ja' })).toThrow()
  })
})

describe('invite answers', () => {
  it('reads the email acknowledgement and refuses one that leaks the address or a token', () => {
    const ask = parseMatrixCompanyRequest({ action: 'email-invitation-create', companyId, requestId, email: 'person@example.com', locale: 'en' })

    expect(parseMatrixCompanyResponse(email.json('fixtures/email-invitation.create.response.json'), ask))
      .toMatchObject({ state: 'accepted', mailStatus: 'accepted' })
    expect(() => parseMatrixCompanyResponse(email.json('fixtures/email-invitation.create-email-leak.response.json'), ask)).toThrow()
    expect(() => parseMatrixCompanyResponse(email.json('fixtures/email-invitation.create-token-leak.response.json'), ask)).toThrow()
  })

  it('reads the policy 1.2 snapshot only for the company asked about, and an older server’s plain 1.3 one as is', () => {
    const ask = parseMatrixCompanyRequest({ action: 'administration-policy', companyId })
    const snapshot = policy.json('fixtures/read.response.json') as { company: { policy: Record<string, string> } }

    expect(wire.companyInvitationPolicy(parseMatrixCompanyResponse(snapshot, ask) as wire.CompanyAdminSnapshot13Response)).toBe('members')
    expect(() => parseMatrixCompanyResponse(snapshot, parseMatrixCompanyRequest({ action: 'administration-policy',
      companyId: '00000000-0000-4000-8000-8f71c3161f99' }))).toThrow()

    // A server that ignores the header answers the 1.3 snapshot: still the authority, silent on who may invite.
    const older = { ...snapshot, company: { ...snapshot.company, policy: { channelCreation: 'members' } } }
    expect(wire.companyInvitationPolicy(parseMatrixCompanyResponse(older, ask) as wire.CompanyAdminSnapshot13Response)).toBeUndefined()
    // A broken 1.2 policy is not mistaken for a 1.3 one: the strict 1.3 policy refuses the 1.2 keys.
    const broken = { ...snapshot, company: { ...snapshot.company, policy: { ...snapshot.company.policy, companyInvitations: 'everyone' } } }
    expect(() => parseMatrixCompanyResponse(broken, ask)).toThrow()
  })

  it('names who may invite only from a policy 1.2 read', () => {
    expect(wire.companyInvitationPolicy(undefined)).toBeUndefined()
    const snapshot = policy.json('fixtures/read.response.json') as wire.CompanyAdminSnapshot13Response
    expect(wire.companyInvitationPolicy({ ...snapshot, company: { ...snapshot.company, policy: { channelCreation: 'members' } } }))
      .toBeUndefined()
  })
})

describe('email invitation refusals', () => {
  it('understands each 1.9 reason at its own status, with its retryable flag', () => {
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_429', details: { reason: 'email_invite_limited', retryable: true } }, 'email'))
      .toEqual({ error: 'matrix_429', reason: 'email_invite_limited' })
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_503', details: { reason: 'email_invite_identity_unavailable', retryable: true } },
      'email')).toEqual({ error: 'matrix_503', reason: 'email_invite_identity_unavailable' })
    // A reason at another status, or another family's reason, is not understood.
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_409', details: { reason: 'email_invite_limited' } }, 'email')).toBeNull()
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_404', details: { reason: 'invitation_unavailable' } }, 'email')).toBeNull()
  })

  it('never widens an older family: `retryable` on an administration refusal is an unknown key', () => {
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_404', details: { reason: 'invitation_unavailable', retryable: false } }, 'admin'))
      .toBeNull()
    expect(wire.matrixCompanyRefusalFamily('email-invitation-create')).toBe('email')
  })
})

describe('the email invitation request on the wire', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends wire 1.9 and reads the typed refusal, never repeating the request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'matrix_403',
      details: { reason: 'email_invite_denied', retryable: false } }), { status: 403, headers: { 'content-type': 'application/json' } }))

    vi.stubGlobal('fetch', fetchMock)

    const sent = requestMatrixCompany('https://shell.example/api/matrix/v1', { accessToken: 'token' } as never,
      { action: 'email-invitation-create', companyId, requestId, email: 'person@example.com', locale: 'en' }, new AbortController().signal)

    await expect(sent).rejects.toMatchObject({ code: 'denied', reason: 'email_invite_denied' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://shell.example/api/matrix/v1/companies/${companyId}/email-invitations`)
    expect((init.headers as Record<string, string>)['Atum-Company-Wire']).toBe('1.9')
    expect(JSON.parse(init.body as string)).toEqual({ requestId, email: 'person@example.com', locale: 'en' })
  })

  it('sends the invites profile header on the readiness read', async () => {
    const fetchMock = vi.fn(async () => new Response(invites.read('fixtures/capabilities.response.json').toString('utf8'),
      { status: 200, headers: { 'content-type': 'application/json' } }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(requestMatrixCompany('https://shell.example/api/matrix/v1', { accessToken: 'token' } as never,
      { action: 'invite-readiness' }, new AbortController().signal)).resolves.toMatchObject({ emailCreation: 'ready' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'Atum-Company-Wire': '1.3', 'Atum-Company-Invites': '1' })
  })
})

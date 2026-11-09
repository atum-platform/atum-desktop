import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as wire from '../../shared/matrix-company-team-space'

import { matrixCompanyRoute, parseMatrixCompanyRequest, parseMatrixCompanyResponse, requestMatrixCompany } from './company'

/*
 * The frozen packs platform #799 and #801 shipped: company-direct-add 1 (wire 1.12), company-invites 2 (mail state) and
 * 3 (install-level direct add), and company-policy 1.3 (who may add directly). Copied verbatim from atum-platform at
 * 8c18ad4293 and pinned by the same framed digest as the other vendored packs.
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

const directAdd = pack('atum-company-direct-add-v1')
const invites2 = pack('atum-company-invites-v2')
const invites3 = pack('atum-company-invites-v3')
const policy13 = pack('atum-company-policy-v1.3')

type Check = (value: unknown) => boolean
const schema = (candidate: { safeParse(value: unknown): { success: boolean } }): Check => value => candidate.safeParse(value).success

/** Every message these packs define is one this client sends or reads. */
const MESSAGES: Record<string, Record<string, Check>> = {
  [directAdd.name]: {
    request: schema(wire.CompanyMemberAdd112RequestSchema),
    response: schema(wire.CompanyMemberAdd112ResponseSchema),
    readiness: schema(wire.CompanyMemberAddReadiness112ResponseSchema)
  },
  [invites2.name]: {
    capabilities: schema(wire.CompanyInviteCapabilities2Schema),
    'mail-status': schema(wire.CompanyEmailInvitationStatus19ResponseSchema)
  },
  [invites3.name]: { capabilities: schema(wire.CompanyInviteCapabilities3Schema) },
  [policy13.name]: {
    request: schema(wire.CompanyPolicyUpdate3RequestSchema),
    response: schema(wire.CompanyPolicyUpdate3ResponseSchema),
    snapshot: schema(wire.CompanyAdminSnapshotPolicy3ResponseSchema)
  }
}

const PACKS = [directAdd, invites2, invites3, policy13]

describe('vendored direct-add packs', () => {
  it.each(PACKS)('$name is the exact frozen pack', source => {
    expect(source.read('PINNED-SHA256').toString('utf8').trim()).toBe(source.vendored.sha256)
    expect(digest(source)).toBe(source.vendored.sha256)
  })

  for (const source of PACKS) {
    const fixtures = source.contract.fixtures.filter(fixture => fixture.message)

    it(`${source.name}: every message has a parser`, () => {
      expect(fixtures.filter(fixture => !MESSAGES[source.name]![fixture.message!]).map(fixture => fixture.message)).toEqual([])
    })

    it.each(fixtures.map(fixture => [fixture.file, fixture] as const))(`${source.name}: %s`, (_file, fixture) => {
      expect(MESSAGES[source.name]![fixture.message!]!(source.json(fixture.file))).toBe(fixture.expect !== 'reject')
    })
  }
})

const companyId = '00000000-0000-4000-8000-3570bef6c8ca'
const otherCompany = '00000000-0000-4000-8000-8f71c3161f99'
const fixture = (file: string) => directAdd.json(`fixtures/${file}.json`) as Record<string, unknown>

const addPerson = (role: 'admin' | 'member' = 'member') => parseMatrixCompanyRequest({ action: 'member-add', companyId,
  requestId: '00000000-0000-4000-8000-72805976e3a7', target: { kind: 'matrixUser', memberMatrixUser: '@lan:atum.example' }, role })

const addAddress = () => parseMatrixCompanyRequest({ action: 'member-add', companyId, requestId: '00000000-0000-4000-8000-4ddf7748f9cd',
  target: { kind: 'email', email: 'lan@example.com', locale: 'vi' }, role: 'member' })

describe('direct add routes', () => {
  it('reads the per-company readiness on wire 1.12', () => {
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'member-add-readiness', companyId }))).toEqual({
      method: 'GET', path: `/companies/${companyId}/member-add`, wire: '1.12'
    })
  })

  it('adds a person and an address with exactly the frozen bodies, naming no principal', () => {
    expect(matrixCompanyRoute(addPerson())).toEqual({ method: 'POST', path: `/companies/${companyId}/member-add`, wire: '1.12',
      body: fixture('request.matrix-user') })
    expect(matrixCompanyRoute(addAddress())).toEqual({ method: 'POST', path: `/companies/${companyId}/member-add`, wire: '1.12',
      body: fixture('request.email') })
  })

  it('never builds an add that grants an address the admin role', () => {
    expect(() => parseMatrixCompanyRequest({ action: 'member-add', companyId, requestId: '00000000-0000-4000-8000-4ddf7748f9cd',
      target: { kind: 'email', email: 'lan@example.com', locale: 'vi' }, role: 'admin' })).toThrow()
  })

  it('asks invite readiness profile 3 or 2 by its own header, and profile 1 without one', () => {
    for (const profile of ['3', '2'] as const) {
      expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'invite-readiness', profile }))).toEqual({
        method: 'GET', path: '/company-capabilities', wire: '1.3', profile: { header: 'Atum-Company-Invites', value: profile }
      })
    }

    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'invite-readiness' })).profile).toEqual({ header: 'Atum-Company-Invites', value: '1' })
  })

  it('reads one email invitation’s mail state on wire 1.9 with invites profile 2', () => {
    const invitationId = '00000000-0000-4000-8000-7b86e579389b'

    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'email-invitation-status', companyId, invitationId }))).toEqual({
      method: 'GET', path: `/companies/${companyId}/email-invitations/${invitationId}`, wire: '1.9',
      profile: { header: 'Atum-Company-Invites', value: '2' }
    })
  })

  it('reads policy 1.3 on the administration read, and updates all five fields under its header', () => {
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'administration-policy', companyId, profile: '1.3' })).profile)
      .toEqual({ header: 'Atum-Company-Policy', value: '1.3' })

    const update = policy13.json('fixtures/update.request.json') as Record<string, unknown>
    const route = matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'policy-update', companyId, ...update }))

    expect(route).toEqual({ method: 'POST', path: `/companies/${companyId}/policy`, wire: '1.3',
      profile: { header: 'Atum-Company-Policy', value: '1.3' }, body: update })
    // Channel creation alone stays the plain 1.3 update, with no profile.
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'policy-update', companyId, requestId: update.requestId,
      policy: { channelCreation: 'members' }, expectedAuthorityGeneration: 9 })).profile).toBeUndefined()
    // A partial 1.3 policy is neither.
    expect(() => parseMatrixCompanyRequest({ action: 'policy-update', companyId, requestId: update.requestId,
      policy: { channelCreation: 'members', directMemberAdd: 'admins' }, expectedAuthorityGeneration: 9 })).toThrow()
  })
})

describe('direct add answers', () => {
  it('reads every outcome for the company and target asked about', () => {
    for (const outcome of ['added', 'already-member', 'not-allowed', 'roster-full', 'unknown-user']) {
      expect(parseMatrixCompanyResponse(fixture(`response.${outcome}`), addPerson())).toMatchObject({ schemaVersion: 12 })
    }

    expect(parseMatrixCompanyResponse(fixture('response.invited'), addAddress())).toMatchObject({ outcome: 'invited' })
  })

  it('refuses an answer for another company, a role other than the one asked, or `invited` for a person', () => {
    expect(() => parseMatrixCompanyResponse({ ...fixture('response.added'), companyId: otherCompany }, addPerson())).toThrow()
    expect(() => parseMatrixCompanyResponse(fixture('response.added'), addPerson('admin'))).toThrow()
    expect(() => parseMatrixCompanyResponse({ ...fixture('response.already-member'), companyId: otherCompany }, addPerson())).toThrow()
    expect(() => parseMatrixCompanyResponse(fixture('response.invited'), addPerson())).toThrow()
    // An address is never added, nor named as a member.
    expect(() => parseMatrixCompanyResponse(fixture('response.added'), addAddress())).toThrow()
    expect(() => parseMatrixCompanyResponse(fixture('response.already-member'), addAddress())).toThrow()
  })

  it('reads the readiness only for the company asked about', () => {
    const ask = parseMatrixCompanyRequest({ action: 'member-add-readiness', companyId })

    expect(parseMatrixCompanyResponse(fixture('readiness.allowed'), ask)).toMatchObject({ directAdd: 'allowed' })
    expect(() => parseMatrixCompanyResponse({ ...fixture('readiness.allowed'), companyId: otherCompany }, ask)).toThrow()
  })

  it('reads the mail state only for the invitation asked about', () => {
    const sent = invites2.json('fixtures/mail-status.sent.response.json') as { invitationId: string }
    const ask = (invitationId: string) => parseMatrixCompanyRequest({ action: 'email-invitation-status', companyId, invitationId })

    expect(parseMatrixCompanyResponse(sent, ask(sent.invitationId))).toMatchObject({ mailStatus: 'sent' })
    expect(() => parseMatrixCompanyResponse(sent, ask('00000000-0000-4000-8000-1a51ce5b3973'))).toThrow()
  })

  it('takes each readiness profile only as itself: a profile 2 body is not a profile 3 answer', () => {
    const three = invites3.json('fixtures/capabilities.response.json')
    const two = invites2.json('fixtures/capabilities.response.json')

    expect(parseMatrixCompanyResponse(three, parseMatrixCompanyRequest({ action: 'invite-readiness', profile: '3' })))
      .toMatchObject({ directAdd: 'ready' })
    expect(() => parseMatrixCompanyResponse(two, parseMatrixCompanyRequest({ action: 'invite-readiness', profile: '3' }))).toThrow()
    expect(parseMatrixCompanyResponse(two, parseMatrixCompanyRequest({ action: 'invite-readiness', profile: '2' })))
      .toMatchObject({ schemaVersion: 2 })
  })

  it('reads the policy 1.3 snapshot and update answer, and refuses an update answer that is not what was sent', () => {
    const snapshot = policy13.json('fixtures/read.response.json') as wire.CompanyAdminSnapshot13Response
    const read = parseMatrixCompanyRequest({ action: 'administration-policy', companyId: snapshot.company.id, profile: '1.3' })

    expect(wire.companyPolicy3(parseMatrixCompanyResponse(snapshot, read) as wire.CompanyAdminSnapshot13Response)?.directMemberAdd).toBe('members')

    const update = policy13.json('fixtures/update.request.json') as Record<string, unknown>
    const answer = policy13.json('fixtures/update.response.json') as Record<string, unknown>
    const sent = parseMatrixCompanyRequest({ action: 'policy-update', companyId: answer.companyId, ...update })

    expect(parseMatrixCompanyResponse(answer, sent)).toMatchObject({ policy: { directMemberAdd: 'members' } })
    const admins = policy13.json('fixtures/admins.request.json') as Record<string, unknown>
    expect(() => parseMatrixCompanyResponse(answer, parseMatrixCompanyRequest({ action: 'policy-update', companyId: answer.companyId, ...admins })))
      .toThrow()
  })
})

describe('direct add refusals', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('understands the add budget (429) and a request ID reused with other input (409), and no other family’s reason', () => {
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_429', details: { reason: 'member_add_limited' } }, 'member-add'))
      .toEqual({ error: 'matrix_429', reason: 'member_add_limited' })
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_409', details: { reason: 'invitation_changed_input' } }, 'member-add'))
      .toEqual({ error: 'matrix_409', reason: 'invitation_changed_input' })
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_429', details: { reason: 'email_invite_limited', retryable: true } }, 'member-add'))
      .toEqual({ error: 'matrix_429', reason: 'email_invite_limited' })
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_409', details: { reason: 'member_add_limited' } }, 'member-add')).toBeNull()
    expect(wire.parseMatrixCompanyRefusal({ error: 'matrix_429', details: { reason: 'member_add_limited' } }, 'admin')).toBeNull()
    expect(wire.matrixCompanyRefusalFamily('member-add')).toBe('member-add')
  })

  it('sends wire 1.12 once and reads the budget refusal with its Retry-After', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'matrix_429', details: { reason: 'member_add_limited' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '1200' } }))

    vi.stubGlobal('fetch', fetchMock)

    const sent = requestMatrixCompany('https://shell.example/api/matrix/v1', { accessToken: 'token' } as never, {
      action: 'member-add', companyId, requestId: '00000000-0000-4000-8000-72805976e3a7',
      target: { kind: 'matrixUser', memberMatrixUser: '@lan:atum.example' }, role: 'member'
    }, new AbortController().signal)

    await expect(sent).rejects.toMatchObject({ reason: 'member_add_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://shell.example/api/matrix/v1/companies/${companyId}/member-add`)
    expect((init.headers as Record<string, string>)['Atum-Company-Wire']).toBe('1.12')
    expect(JSON.parse(init.body as string)).toEqual(fixture('request.matrix-user'))
  })
})

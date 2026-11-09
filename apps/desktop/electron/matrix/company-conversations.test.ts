import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import type { MatrixCommand, MatrixRoom } from '../../shared/matrix'
import type { MatrixCompanyRequest } from '../../shared/matrix-company'
import {
  companyConversationRoomBinding,
  isCompanyConversationRoom,
  isTeamSpaceRoom,
  MATRIX_COMPANY_CONVERSATION_BINDING,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'
import * as wire from '../../shared/matrix-company-team-space'

import {
  isMatrixCompanyRead,
  matrixCompanyRoute,
  parseMatrixCompanyRequest,
  parseMatrixCompanyResponse,
  requestMatrixCompany
} from './company'
import { companyConversationDigest } from './company-conversation-digest'
import { assertCompanyConversationCommandAllowed } from './company-room-guard'

/*
 * Company DMs and group DMs (company-workspace/1.5), against the frozen pack copied verbatim from
 * atum-platform@bee273b7422bdb1ee3ecb1b6f075f8a7af0f7052:spec/company-workspace/v1.5.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/team-space/atum-company-workspace-v1.5')
const read = (file: string) => readFileSync(resolve(root, file))
const json = (file: string): unknown => JSON.parse(read(file).toString('utf8'))

interface Contract {
  version: string
  pack_files: string[]
  fixtures: Array<{ file: string; message?: string; expect?: 'accept' | 'reject' }>
}

const contract = json('contract.json') as Contract
const vendored = json('VENDORED.json') as { sha256: string; path: string }

function packDigest(): string {
  const hash = createHash('sha256')

  for (const file of contract.pack_files) {
    const name = Buffer.from(file, 'utf8')
    const body = read(file)
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

describe('the vendored company-workspace 1.5 pack', () => {
  it('is the exact frozen pack', () => {
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(packDigest()).toBe(vendored.sha256)
    expect(vendored.path).toBe('spec/company-workspace/v1.5')
    expect(contract.version).toBe('1.5')
  })
})

type Check = (value: unknown) => boolean
const schema = (candidate: z.ZodType): Check => value => candidate.safeParse(value).success
const refusal = (family: wire.MatrixCompanyRefusalFamily): Check => value => wire.parseMatrixCompanyRefusal(value, family) !== null

const MESSAGES: Record<string, Check> = {
  'conversation-directory.response': schema(wire.CompanyConversationDirectory15ResponseSchema),
  'conversation-open.request': schema(wire.CompanyConversationOpen15RequestSchema),
  'conversation-expand.request': schema(wire.CompanyConversationExpand15RequestSchema),
  'conversation-open.response': schema(wire.CompanyConversationOpen15ResponseSchema),
  'conversation-hidden.request': schema(wire.CompanyConversationHidden15RequestSchema),
  'conversation-hidden.response': schema(wire.CompanyConversationHidden15ResponseSchema),
  'conversation.error.response': refusal('conversation'),
  'legacy-conversation.error.response': refusal('legacy')
}

// A server trace and the digest vectors are producer-side relation fixtures; the vectors are run below.
const NOT_CONSUMED = new Set(['conversation-open.trace', 'participant-digest.vector'])

describe('frozen 1.5 fixtures through the strict parsers', () => {
  const fixtures = contract.fixtures.filter(fixture => fixture.message !== undefined && !NOT_CONSUMED.has(fixture.message))

  it('every consumed message has a parser, so no fixture family is silently skipped', () => {
    expect(fixtures.filter(fixture => !MESSAGES[fixture.message!]).map(fixture => fixture.message)).toEqual([])
  })

  it.each(fixtures.map(fixture => [fixture.file, fixture] as const))('%s', (_file, fixture) => {
    expect(MESSAGES[fixture.message!]!(json(fixture.file)), `${fixture.file} must be ${fixture.expect}ed`).toBe(fixture.expect === 'accept')
  })
})

describe('the participant-set digest', () => {
  it.each(['participant-digest-dm', 'participant-digest-group'])('%s matches the normative vector', name => {
    const vector = json(`fixtures/${name}.vector.json`) as {
      companyId: string
      kind: 'dm' | 'group_dm'
      participants: Array<{ memberRef: string; admissionEpoch: number }>
      participantSetDigest: string
    }

    expect(companyConversationDigest(vector.companyId, vector.kind, vector.participants)).toBe(vector.participantSetDigest)
    // Request order is irrelevant: the preimage sorts by the bytes of the member ref.
    expect(companyConversationDigest(vector.companyId, vector.kind, [...vector.participants].reverse())).toBe(vector.participantSetDigest)
  })

  it('changes with the company, the kind and every admission epoch (a readmission is another conversation)', () => {
    const vector = json('fixtures/participant-digest-dm.vector.json') as {
      companyId: string
      participants: Array<{ memberRef: string; admissionEpoch: number }>
      participantSetDigest: string
    }

    const [first, second] = vector.participants as [{ memberRef: string; admissionEpoch: number }, { memberRef: string; admissionEpoch: number }]

    expect(companyConversationDigest('00000000-0000-4000-8000-c70f27930704', 'dm', vector.participants)).not.toBe(vector.participantSetDigest)
    expect(companyConversationDigest(vector.companyId, 'group_dm', vector.participants)).not.toBe(vector.participantSetDigest)
    expect(
      companyConversationDigest(vector.companyId, 'dm', [{ ...first, admissionEpoch: first.admissionEpoch + 1 }, second])
    ).not.toBe(vector.participantSetDigest)
  })
})

const companyId = '00000000-0000-4000-8000-87c6455cae48'
const conversationId = '00000000-0000-4000-8000-f6c6b8bb709f'
const requestId = '00000000-0000-4000-8000-f9ae298d66d3'
const anh = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const bao = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
const cuong = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM'
const resource = 'https://api.test/api/matrix/v1'
const grant = { issuer: 'https://id.test/', subject: 'alice', accessToken: 'native-only', refreshToken: 'native-refresh' }

describe('company conversation requests', () => {
  const REQUESTS = [
    { request: { action: 'conversations', companyId }, method: 'GET', path: `/companies/${companyId}/conversations` },
    { request: { action: 'read-conversation', companyId, conversationId }, method: 'GET', path: `/companies/${companyId}/conversations/${conversationId}` },
    {
      request: { action: 'conversation-open', companyId, requestId, participantMemberRefs: [anh, bao] },
      method: 'POST',
      path: `/companies/${companyId}/conversations`,
      body: { requestId, participantMemberRefs: [anh, bao] }
    },
    {
      request: { action: 'conversation-expand', companyId, requestId, sourceConversationId: conversationId, participantMemberRefs: [anh, bao, cuong] },
      method: 'POST',
      path: `/companies/${companyId}/conversations/${conversationId}/expand`,
      body: { requestId, sourceConversationId: conversationId, participantMemberRefs: [anh, bao, cuong] }
    },
    {
      request: { action: 'conversation-hidden', companyId, conversationId, requestId, hidden: true },
      method: 'POST',
      path: `/companies/${companyId}/conversations/${conversationId}/hidden`,
      body: { requestId, hidden: true }
    }
  ] as const

  it.each(REQUESTS)('$request.action selects wire 1.5 with its own path and closed body', ({ request, method, path, ...rest }) => {
    const parsed = parseMatrixCompanyRequest(request)
    const route = matrixCompanyRoute(parsed)

    expect(route).toMatchObject({ method, path, wire: '1.5' })
    expect(route.body).toEqual('body' in rest ? rest.body : undefined)
    expect(isMatrixCompanyRead(parsed.action)).toBe(method === 'GET')
  })

  it('refuses authority and shapes the contract closes', () => {
    const open = { action: 'conversation-open', companyId, requestId, participantMemberRefs: [anh, bao] }

    const rejected: unknown[] = [
      { ...open, principal: anh },
      { ...open, roomId: '!x:y' },
      { ...open, wire: '1.5' },
      // Two to nine people, none twice, an opaque member ref and never a handle or an address.
      { ...open, participantMemberRefs: [anh] },
      { ...open, participantMemberRefs: [anh, anh] },
      { ...open, participantMemberRefs: [anh, '@bao:atum.example'] },
      { ...open, participantMemberRefs: Array.from({ length: 10 }, (_, index) => String.fromCharCode(65 + index).repeat(43)) },
      // An expansion has at least three people and names its source.
      { action: 'conversation-expand', companyId, requestId, sourceConversationId: conversationId, participantMemberRefs: [anh, bao] },
      { action: 'conversation-expand', companyId, requestId, participantMemberRefs: [anh, bao, cuong] },
      { action: 'conversation-hidden', companyId, conversationId, requestId },
      { action: 'conversation-hidden', companyId, conversationId, requestId, hidden: 'yes' },
      // There is no leave, delete or restore of a conversation.
      { action: 'conversation-delete', companyId, conversationId, requestId }
    ]

    for (const value of rejected) {
      expect(() => parseMatrixCompanyRequest(value), JSON.stringify(value)).toThrow('invalid')
    }
  })
})

describe('company conversation answers are bound to the request that asked', () => {
  const open = json('fixtures/conversation-open.response.json') as wire.CompanyConversationOpen15Response
  const directory = json('fixtures/conversation-directory.response.json')
  const hidden = json('fixtures/conversation-hidden.response.json')
  const otherCompany = '00000000-0000-4000-8000-0535bd89d837'

  const openAsked: Extract<MatrixCompanyRequest, { action: 'conversation-open' }> = {
    action: 'conversation-open',
    companyId,
    requestId,
    participantMemberRefs: [bao, anh]
  }

  it('accepts the directory for the company asked about and refuses another company', () => {
    expect(parseMatrixCompanyResponse(directory, { action: 'conversations', companyId })).toEqual(directory)
    expect(() => parseMatrixCompanyResponse(directory, { action: 'conversations', companyId: otherCompany })).toThrow('invalid')
  })

  it('accepts an open for exactly the set asked for, in any order, and refuses any other', () => {
    expect(parseMatrixCompanyResponse(open, openAsked)).toEqual(open)
    expect(() => parseMatrixCompanyResponse(open, { ...openAsked, participantMemberRefs: [anh, cuong] })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(open, { ...openAsked, participantMemberRefs: [anh, bao, cuong] })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(open, { ...openAsked, companyId: otherCompany })).toThrow('invalid')
  })

  it('refuses an answer whose participant-set digest is not the digest of its participants', () => {
    const forged = { ...open, conversation: { ...open.conversation, participantSetDigest: 'f'.repeat(64) } }

    expect(() => parseMatrixCompanyResponse(forged, openAsked)).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse({ ...(directory as object), conversations: [forged.conversation] }, { action: 'conversations', companyId })).toThrow('invalid')
  })

  it('reads one conversation by the id asked for, and an expansion as a different conversation than its source', () => {
    expect(parseMatrixCompanyResponse(open, { action: 'read-conversation', companyId, conversationId })).toEqual(open)
    expect(() =>
      parseMatrixCompanyResponse(open, { action: 'read-conversation', companyId, conversationId: '00000000-0000-4000-8000-c70f27930704' })
    ).toThrow('invalid')

    const group = json('fixtures/conversation-group.response.json') as wire.CompanyConversationOpen15Response
    const refs = group.conversation.participants.map(participant => participant.memberRef)

    expect(
      parseMatrixCompanyResponse(group, {
        action: 'conversation-expand',
        companyId,
        requestId,
        sourceConversationId: conversationId,
        participantMemberRefs: refs
      })
    ).toEqual(group)
    // An answer that is the source itself is not an expansion.
    expect(() =>
      parseMatrixCompanyResponse(group, {
        action: 'conversation-expand',
        companyId,
        requestId,
        sourceConversationId: group.conversation.id,
        participantMemberRefs: refs
      })
    ).toThrow('invalid')
  })

  it('binds a hide to the conversation and the state asked for', () => {
    const ask = (hide: boolean) => ({ action: 'conversation-hidden', companyId, conversationId, requestId, hidden: hide }) as const

    expect(parseMatrixCompanyResponse(hidden, ask(true))).toEqual(hidden)
    expect(() => parseMatrixCompanyResponse(hidden, ask(false))).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyResponse(hidden, { ...ask(true), conversationId: '00000000-0000-4000-8000-c70f27930704' })
    ).toThrow('invalid')
  })

  it('refuses a body from another wire family (a 1.4 directory is not a conversation list)', () => {
    expect(() => parseMatrixCompanyResponse({ schemaVersion: 5, channels: [] }, { action: 'conversations', companyId })).toThrow('invalid')
  })
})

describe('company conversation transport', () => {
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('sends wire 1.5 with a closed body and the native bearer only', async () => {
    const answer = json('fixtures/conversation-open.response.json')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(answer))
    vi.stubGlobal('fetch', fetch)

    await expect(
      requestMatrixCompany(resource, grant, { action: 'conversation-open', companyId, requestId, participantMemberRefs: [anh, bao] }, AbortSignal.timeout(1000))
    ).resolves.toEqual(answer)

    const [url, init] = fetch.mock.calls[0]!

    expect(url).toBe(`${resource}/companies/${companyId}/conversations`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(init!.headers).toMatchObject({ 'Atum-Company-Wire': '1.5', Authorization: 'Bearer native-only' })
    expect(JSON.parse(init!.body as string)).toEqual({ requestId, participantMemberRefs: [anh, bao] })
    vi.unstubAllGlobals()
  })

  it('carries a conversation refusal reason, and ignores any other family’s', async () => {
    const ask = () =>
      requestMatrixCompany(resource, grant, { action: 'conversation-open', companyId, requestId, participantMemberRefs: [anh, bao] }, AbortSignal.timeout(1000))

    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => response({ error: 'matrix_409', details: { reason: 'participant_set_conflict' } }, 409)))
    await expect(ask()).rejects.toMatchObject({ code: 'conflict', reason: 'participant_set_conflict' })

    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => response({ error: 'matrix_404', details: { reason: 'participant_unavailable' } }, 404)))
    await expect(ask()).rejects.toMatchObject({ code: 'missing', reason: 'participant_unavailable' })

    // A channel's reason, a reason at the wrong status, or a private name in the details is not a refusal this client understands.
    for (const [status, body] of [
      [409, { error: 'matrix_409', details: { reason: 'channel_archived' } }],
      [404, { error: 'matrix_404', details: { reason: 'participant_limit' } }],
      [404, { error: 'matrix_404', details: { reason: 'conversation_unavailable', displayName: 'Bảo' } }]
    ] as const) {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => response(body, status)))
      await expect(ask()).rejects.toMatchObject({ reason: undefined })
    }

    vi.unstubAllGlobals()
  })

  it('an older server answers a plain status: no conversations, never data', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => response({ error: 'matrix_404' }, 404)))
    await expect(
      requestMatrixCompany(resource, grant, { action: 'conversations', companyId }, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'missing', reason: undefined })
    vi.unstubAllGlobals()
  })
})

describe('classifying a company conversation room', () => {
  const sender = '@manager:atum.example'
  const digest = 'a'.repeat(64)

  const content = (over: Record<string, unknown> = {}, binding: Record<string, unknown> = {}) => ({
    type: MATRIX_COMPANY_CONVERSATION_TYPE,
    room_version: '11',
    [MATRIX_COMPANY_CONVERSATION_BINDING]: { companyId, conversationId, conversationKind: 'dm', participantSetDigest: digest, ...binding },
    ...over
  })

  it('reads the binding the manager wrote, and nothing looser', () => {
    expect(companyConversationRoomBinding(content(), sender)).toEqual({
      companyId,
      conversationId,
      conversationKind: 'dm',
      participantSetDigest: digest,
      managerUserId: sender
    })

    const refused = [
      companyConversationRoomBinding(content(), undefined),
      companyConversationRoomBinding(content({ type: 'io.atum.company_channel.v1' }), sender),
      companyConversationRoomBinding(content({ room_version: '10' }), sender),
      companyConversationRoomBinding(content({}, { conversationKind: 'channel' }), sender),
      companyConversationRoomBinding(content({}, { participantSetDigest: 'short' }), sender),
      companyConversationRoomBinding(content({}, { conversationId: 'not-a-uuid' }), sender),
      companyConversationRoomBinding(content({}, { extra: true }), sender),
      companyConversationRoomBinding(content({ [MATRIX_COMPANY_CONVERSATION_BINDING]: undefined }), sender)
    ]

    expect(refused.every(value => value === undefined)).toBe(true)
  })

  it('keeps a room that claims the type out of every Personal list, with or without a readable binding', () => {
    const claimed = { roomType: MATRIX_COMPANY_CONVERSATION_TYPE }
    const bound = { roomType: MATRIX_COMPANY_CONVERSATION_TYPE, companyConversation: { companyId, conversationId } }

    expect(isCompanyConversationRoom(claimed)).toBe(true)
    expect(isCompanyConversationRoom(bound)).toBe(true)
    expect(isTeamSpaceRoom(claimed)).toBe(true)
    expect(isTeamSpaceRoom({ companyChannel: { companyId, channelId: conversationId } })).toBe(true)
    expect(isTeamSpaceRoom({})).toBe(false)
    expect(isTeamSpaceRoom({ roomType: 'm.space' })).toBe(false)
  })
})

describe('Matrix commands on a joined company conversation', () => {
  const room = (over: Partial<MatrixRoom> = {}): Pick<MatrixRoom, 'roomType' | 'membership'> => ({
    roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    membership: 'join',
    ...over
  })

  const refused: MatrixCommand['kind'][] = ['leave', 'forget', 'invite', 'removeMember', 'ban', 'unban']

  it.each(refused)('refuses %s: who is in a conversation is the platform’s, and hiding is only the person’s own view', kind => {
    expect(() => assertCompanyConversationCommandAllowed(kind, room())).toThrow('matrix_company_room_managed')
  })

  it('leaves everything else alone: other commands, an invitation to decline, other rooms', () => {
    expect(() => assertCompanyConversationCommandAllowed('send', room())).not.toThrow()
    expect(() => assertCompanyConversationCommandAllowed('leave', room({ membership: 'invite' }))).not.toThrow()
    expect(() => assertCompanyConversationCommandAllowed('leave', room({ roomType: undefined }))).not.toThrow()
    expect(() => assertCompanyConversationCommandAllowed('leave', undefined)).not.toThrow()
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import * as wire from '../../shared/matrix-company-team-space'

import {
  isMatrixCompanyMutation,
  isMatrixCompanyRead,
  MatrixCompanyError,
  matrixCompanyRoute,
  parseMatrixCompanyRequest,
  parseMatrixCompanyResponse,
  requestMatrixCompany
} from './company'

/*
 * Frozen company-workspace packs copied verbatim from atum-platform.
 * (Vendored beside this test rather than under contracts/, which another change owns; move them
 * there with the rest of the vendored packs and change `packRoot` when that lands.)
 */
const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/team-space')

interface Pack {
  version: string
  contract: { version: string; pack_files: string[]; fixtures: Array<{ file: string; message?: string; expect?: 'accept' | 'reject'; machine?: string }> }
  vendored: { sha256: string; commit: string; path: string }
  read: (file: string) => Buffer
  json: (file: string) => unknown
}

function pack(version: string): Pack {
  const root = resolve(packRoot, `atum-company-workspace-${version}`)
  const read = (file: string) => readFileSync(resolve(root, file))
  const json = (file: string): unknown => JSON.parse(read(file).toString('utf8'))

  return {
    version,
    contract: json('contract.json') as Pack['contract'],
    vendored: json('VENDORED.json') as Pack['vendored'],
    read,
    json
  }
}

/** The framed manifest digest every vendored pack is pinned by. */
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

const packs = {
  'v1.2': pack('v1.2'),
  'v1.3': pack('v1.3'),
  'v1.4': pack('v1.4'),
  'v1.6': pack('v1.6'),
  'v1.7': pack('v1.7'),
  'v1.10': pack('v1.10'),
  'v1.11': pack('v1.11')
}

describe('vendored company-workspace packs', () => {
  it.each(Object.values(packs))('$version is the exact frozen pack', source => {
    expect(source.read('PINNED-SHA256').toString('utf8').trim()).toBe(source.vendored.sha256)
    expect(digest(source)).toBe(source.vendored.sha256)
    expect(source.vendored.path).toBe(`spec/company-workspace/${source.version}`)
    expect(source.contract.version).toBe(source.version.slice(1))
  })
})

type Check = (value: unknown) => boolean
const schema = (candidate: z.ZodType): Check => value => candidate.safeParse(value).success
const refusal = (family: wire.MatrixCompanyRefusalFamily): Check => value => wire.parseMatrixCompanyRefusal(value, family) !== null

/** Which strict parser each frozen message goes through. */
const MESSAGES: Record<string, Record<string, Check>> = {
  'v1.2': {
    'invite-link.create.request': schema(wire.CompanyInviteLinkCreateRequestSchema),
    'invite-link.create.response': schema(wire.CompanyInviteLinkCreateResponseSchema),
    'invite-link.list.response': schema(wire.CompanyInviteLinkListResponseSchema),
    'invite-link.revoke.request': schema(wire.CompanyInviteLinkRevokeRequestSchema),
    'invite-link.revoke.response': schema(wire.CompanyInviteLinkRevokeResponseSchema),
    'invite-link.preview.request': schema(wire.CompanyInviteLinkPreviewRequestSchema),
    'invite-link.preview.response': schema(wire.CompanyInviteLinkPreviewResponseSchema),
    'invite-link.redeem.request': schema(wire.CompanyInviteLinkRedeemRequestSchema),
    'invite-link.redeem.response': schema(wire.CompanyInviteLinkRedeemResponseSchema),
    'invite-link.error.response': refusal('link')
  },
  'v1.3': {
    'capabilities.response': schema(wire.CompanyCapabilities13ResponseSchema),
    'admin.snapshot.response': schema(wire.CompanyAdminSnapshot13ResponseSchema),
    'role-change.request': schema(wire.CompanyRoleChange13RequestSchema),
    'role-change.response': schema(wire.CompanyRoleChange13ResponseSchema),
    'ownership-transfer.request': schema(wire.CompanyOwnershipTransfer13RequestSchema),
    'ownership-transfer.response': schema(wire.CompanyOwnershipTransfer13ResponseSchema),
    'policy-update.request': schema(wire.CompanyPolicyUpdate13RequestSchema),
    'policy-update.response': schema(wire.CompanyPolicyUpdate13ResponseSchema),
    'invitation-create.request': schema(wire.CompanyInvitationCreate13RequestSchema),
    'invitation-create.response': schema(wire.CompanyInvitationCreate13ResponseSchema),
    'invitation-self.request': schema(wire.CompanyInvitationSelfAction13RequestSchema),
    'invitation-admin.request': schema(wire.CompanyInvitationAdminAction13RequestSchema),
    'invitation-mutation.response': schema(wire.CompanyInvitationMutation13ResponseSchema),
    'invitation-resend.request': schema(wire.CompanyInvitationResend13RequestSchema),
    'invitation-resend.response': schema(wire.CompanyInvitationResend13ResponseSchema),
    'admin.error.response': refusal('admin'),
    'legacy-admin.error.response': refusal('legacy')
  },
  'v1.4': {
    'channel-browse.response': schema(wire.CompanyChannelBrowse14ResponseSchema),
    'channel-admitted.snapshot': schema(wire.CompanyChannelAdmittedSnapshot14Schema),
    'channel-admitted-directory.response': schema(wire.CompanyChannelAdmittedDirectory14ResponseSchema),
    'channel-members.response': schema(wire.CompanyChannelMembers14ResponseSchema),
    'channel-command.request': schema(wire.CompanyChannelCommand14RequestSchema),
    'channel-command.response': schema(wire.CompanyChannelCommand14ResponseSchema),
    'channel-invitation.response': schema(wire.CompanyChannelInvitation14ResponseSchema),
    'channel.error.response': refusal('channel'),
    'legacy-channel.error.response': refusal('legacy')
  },
  'v1.6': {
    'channel-browse.response': schema(wire.CompanyChannelBrowse16ResponseSchema)
  },
  'v1.7': {
    'set-avatar.request': schema(wire.CompanyAvatarSet17RequestSchema),
    'set-avatar.response': schema(wire.CompanyAvatarSet17ResponseSchema)
  },
  'v1.10': {
    'invitation-create.request': schema(wire.CompanyInvitationCreate110RequestSchema),
    'invitation-create.response': schema(wire.CompanyInvitationCreate110ResponseSchema),
    'invitation-mutation.response': schema(wire.CompanyInvitationMutation110ResponseSchema),
    'invitation-resend.response': schema(wire.CompanyInvitationResend110ResponseSchema),
    'admin.snapshot.response': schema(wire.CompanyAdminSnapshot110ResponseSchema),
    'capabilities.response': schema(wire.CompanyCapabilities110ResponseSchema)
  },
  'v1.11': {
    'leave.error.response': refusal('leave')
  }
}

/**
 * Messages this client never sends or receives: server traces and producer-side relation fixtures.
 */
const NOT_CONSUMED = new Set([
  'invite-link.trace',
  'invitation-self-directory.response'
])

describe('frozen fixtures through the strict parsers', () => {
  for (const [name, source] of Object.entries(packs)) {
    const fixtures = source.contract.fixtures.filter(
      fixture => fixture.message !== undefined && !NOT_CONSUMED.has(fixture.message)
    )

    it(`${name}: every consumed message has a parser, so no fixture family is silently skipped`, () => {
      const unmapped = fixtures.filter(fixture => !MESSAGES[name]![fixture.message!])

      expect(unmapped.map(fixture => fixture.message)).toEqual([])
    })

    it.each(fixtures.map(fixture => [fixture.file, fixture] as const))(`${name}: %s`, (_file, fixture) => {
      const accepted = MESSAGES[name]![fixture.message!]!(source.json(fixture.file))

      expect(accepted, `${fixture.file} must be ${fixture.expect}ed`).toBe(fixture.expect === 'accept')
    })
  }
})

const companyId = '00000000-0000-4000-8000-72805976e3a7'
const channelId = '00000000-0000-4000-8000-f19cafd05964'
const requestId = '00000000-0000-4000-8000-564e93c689af'
const invitationId = '00000000-0000-4000-8000-3e6e169a72d6'
const linkId = '00000000-0000-4000-8000-05d9ec66b6d2'
const ownerRef = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const memberRef = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM'
const resource = 'https://api.test/api/matrix/v1'
const grant = { issuer: 'https://id.test/', subject: 'alice', accessToken: 'native-only', refreshToken: 'native-refresh' }

const REQUESTS: Array<{ request: Record<string, unknown>; method: 'GET' | 'POST'; path: string; wire: string; body?: unknown }> = [
  { request: { action: 'capabilities' }, method: 'GET', path: '/company-capabilities', wire: '1.3' },
  { request: { action: 'administration', companyId }, method: 'GET', path: `/companies/${companyId}/administration`, wire: '1.3' },
  {
    request: { action: 'role-change', companyId, requestId, memberRef, role: 'admin', expectedAuthorityGeneration: 7 },
    method: 'POST',
    path: `/companies/${companyId}/role-change`,
    wire: '1.3',
    body: { requestId, memberRef, role: 'admin', expectedAuthorityGeneration: 7 }
  },
  {
    request: { action: 'ownership-transfer', companyId, requestId, targetMemberRef: memberRef, expectedAuthorityGeneration: 8 },
    method: 'POST',
    path: `/companies/${companyId}/ownership/transfer`,
    wire: '1.3',
    body: { requestId, targetMemberRef: memberRef, expectedAuthorityGeneration: 8 }
  },
  {
    request: { action: 'policy-update', companyId, requestId, policy: { channelCreation: 'admins_only' }, expectedAuthorityGeneration: 9 },
    method: 'POST',
    path: `/companies/${companyId}/policy`,
    wire: '1.3',
    body: { requestId, policy: { channelCreation: 'admins_only' }, expectedAuthorityGeneration: 9 }
  },
  {
    request: { action: 'invitation-create', companyId, requestId, memberHandle: '@Lan_Nguyen', role: 'member' },
    method: 'POST',
    path: `/companies/${companyId}/invitations`,
    wire: '1.3',
    body: { requestId, memberHandle: '@Lan_Nguyen', role: 'member' }
  },
  {
    request: { action: 'invitation-create-directory', companyId, requestId, memberMatrixUser: '@user-0123:atum.test', role: 'member' },
    method: 'POST',
    path: `/companies/${companyId}/invitations`,
    wire: '1.10',
    body: { requestId, memberMatrixUser: '@user-0123:atum.test', role: 'member' }
  },
  {
    request: { action: 'invitation-accept', companyId, invitationId, requestId },
    method: 'POST',
    path: `/companies/${companyId}/invitations/${invitationId}/accept`,
    wire: '1.3',
    body: { requestId, action: 'accept' }
  },
  {
    request: { action: 'invitation-decline', companyId, invitationId, requestId },
    method: 'POST',
    path: `/companies/${companyId}/invitations/${invitationId}/decline`,
    wire: '1.3',
    body: { requestId, action: 'decline' }
  },
  {
    request: { action: 'invitation-cancel', companyId, invitationId, requestId },
    method: 'POST',
    path: `/companies/${companyId}/invitations/${invitationId}/cancel`,
    wire: '1.3',
    body: { requestId, action: 'cancel' }
  },
  {
    request: { action: 'invitation-resend', companyId, invitationId, requestId },
    method: 'POST',
    path: `/companies/${companyId}/invitations/${invitationId}/resend`,
    wire: '1.3',
    body: { requestId }
  },
  { request: { action: 'invite-links', companyId }, method: 'GET', path: `/companies/${companyId}/invite-links`, wire: '1.2' },
  {
    request: { action: 'invite-link-create', companyId, requestId, role: 'member', maxUses: 10 },
    method: 'POST',
    path: `/companies/${companyId}/invite-links`,
    wire: '1.2',
    body: { requestId, role: 'member', maxUses: 10 }
  },
  {
    request: { action: 'invite-link-revoke', companyId, linkId, requestId },
    method: 'POST',
    path: `/companies/${companyId}/invite-links/${linkId}/revoke`,
    wire: '1.2',
    body: { requestId }
  },
  {
    request: { action: 'invite-link-preview', token: 'A'.repeat(43) },
    method: 'POST',
    path: '/invite-links/preview',
    wire: '1.2',
    body: { token: 'A'.repeat(43) }
  },
  {
    request: { action: 'invite-link-redeem', requestId, token: 'A'.repeat(43) },
    method: 'POST',
    path: '/invite-links/redeem',
    wire: '1.2',
    body: { requestId, token: 'A'.repeat(43) }
  },
  { request: { action: 'browse-channels', companyId }, method: 'GET', path: `/companies/${companyId}/channels/browse`, wire: '1.4' },
  {
    request: { action: 'browse-joinable-channels', companyId },
    method: 'GET',
    path: `/companies/${companyId}/channels/browse`,
    wire: '1.6'
  },
  { request: { action: 'admitted-channels', companyId }, method: 'GET', path: `/companies/${companyId}/channels`, wire: '1.4' },
  {
    request: { action: 'read-admitted-channel', companyId, channelId },
    method: 'GET',
    path: `/companies/${companyId}/channels/${channelId}`,
    wire: '1.4'
  },
  {
    request: { action: 'channel-members', companyId, channelId },
    method: 'GET',
    path: `/companies/${companyId}/channels/${channelId}/members`,
    wire: '1.4'
  },
  {
    request: { action: 'channel-command', companyId, command: { requestId, operation: 'create', displayName: 'leadership', visibility: 'private' } },
    method: 'POST',
    path: `/companies/${companyId}/channels`,
    wire: '1.4',
    body: { requestId, operation: 'create', displayName: 'leadership', visibility: 'private' }
  },
  {
    request: { action: 'channel-command', companyId, channelId, command: { requestId, operation: 'join', expectedChannelGeneration: 7 } },
    method: 'POST',
    path: `/companies/${companyId}/channels/${channelId}/join`,
    wire: '1.4',
    body: { requestId, operation: 'join', expectedChannelGeneration: 7 }
  },
  {
    request: {
      action: 'channel-command',
      companyId,
      channelId,
      command: { requestId, operation: 'update_metadata', expectedChannelGeneration: 7, topic: 'New topic' }
    },
    method: 'POST',
    path: `/companies/${companyId}/channels/${channelId}/update-metadata`,
    wire: '1.4',
    body: { requestId, operation: 'update_metadata', expectedChannelGeneration: 7, topic: 'New topic' }
  },
  {
    request: { action: 'channel-command', companyId, channelId, command: { requestId, operation: 'archive', expectedChannelGeneration: 7 } },
    method: 'POST',
    path: `/companies/${companyId}/channels/${channelId}/archive`,
    wire: '1.4',
    body: { requestId, operation: 'archive', expectedChannelGeneration: 7 }
  },
  {
    request: {
      action: 'channel-command',
      companyId,
      channelId,
      command: { requestId, operation: 'remove', memberRef, expectedChannelGeneration: 7, expectedAdmissionGeneration: 3 }
    },
    method: 'POST',
    path: `/companies/${companyId}/channels/${channelId}/remove`,
    wire: '1.4',
    body: { requestId, operation: 'remove', memberRef, expectedChannelGeneration: 7, expectedAdmissionGeneration: 3 }
  },
  {
    request: { action: 'set-avatar', companyId, requestId, avatarUri: 'mxc://matrix.atum.app/company-logo' },
    method: 'POST',
    path: `/companies/${companyId}/set-avatar`,
    wire: '1.7',
    body: { requestId, operation: 'set_avatar', avatarUri: 'mxc://matrix.atum.app/company-logo' }
  }
]

describe('Team Space native requests', () => {
  it.each(REQUESTS)('$request.action selects its own family wire, path and closed body', ({ body, method, path, request, wire: value }) => {
    const parsed = parseMatrixCompanyRequest(request)
    const route = matrixCompanyRoute(parsed)

    expect(route).toMatchObject({ method, path, wire: value })
    expect(route.body).toEqual(body)
    expect(isMatrixCompanyRead(parsed.action)).toBe(method === 'GET')
  })

  it('keeps the earlier 1.1 actions on the 1.1 selection', () => {
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'list' }))).toMatchObject({ method: 'GET', wire: '1.1' })
    expect(
      matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'invite', companyId, requestId, memberHandle: 'lan_nguyen', role: 'member' }))
    ).toMatchObject({ method: 'POST', path: `/companies/${companyId}/invite`, wire: '1.1' })
    expect(matrixCompanyRoute(parseMatrixCompanyRequest({ action: 'list-channels', companyId }))).toMatchObject({
      path: `/companies/${companyId}/channels`,
      wire: '1.1'
    })
  })

  it('refuses authority the renderer must never name, and shapes the contract closes', () => {
    const create = { action: 'channel-command', companyId, command: { requestId, operation: 'create', displayName: 'ops', visibility: 'public' } }
    const join = { action: 'channel-command', companyId, channelId, command: { requestId, operation: 'join', expectedChannelGeneration: 1 } }
    const role = { action: 'role-change', companyId, requestId, memberRef, role: 'member', expectedAuthorityGeneration: 1 }

    const rejected: unknown[] = [
      // Forbidden fields on the wire: principals, owners, actors, emails, room ids, wire selection.
      { ...role, principal: ownerRef },
      { ...role, actor: ownerRef },
      { ...role, ownerMemberRef: ownerRef },
      { ...role, email: 'a@b.example' },
      { ...role, wire: '1.4' },
      { ...role, url: 'https://evil.example' },
      { ...create, command: { ...create.command, roomId: '!x:y' } },
      // The owner is never assigned as a role; a generation is never optional or zero.
      { ...role, role: 'owner' },
      { ...role, expectedAuthorityGeneration: 0 },
      { ...role, expectedAuthorityGeneration: undefined },
      { ...role, memberRef: 'short' },
      { action: 'ownership-transfer', companyId, requestId, targetMemberRef: memberRef },
      // Guests are deferred.
      { action: 'invitation-create', companyId, requestId, memberHandle: 'lan_nguyen', role: 'guest' },
      // A link grants member only, and a client never mints the secret.
      { action: 'invite-link-create', companyId, requestId, role: 'admin' },
      { action: 'invite-link-create', companyId, requestId, role: 'member', token: 'x'.repeat(43) },
      { action: 'invite-link-preview', token: 'short' },
      { action: 'invite-link-preview', token: 'A'.repeat(43), companyId },
      { action: 'invite-link-redeem', requestId, token: 'A'.repeat(43), companyId },
      // Create names no channel yet; every other operation names exactly one.
      { ...create, channelId },
      { ...join, channelId: undefined },
      { ...join, channelId: 'not-a-uuid' },
      // Only `private` and `public` exist; there is no third visibility and it cannot be changed after creation.
      { ...create, command: { ...create.command, visibility: 'company' } },
      {
        action: 'channel-command',
        companyId,
        channelId,
        command: { requestId, operation: 'update_metadata', expectedChannelGeneration: 1, visibility: 'public' }
      },
      {
        action: 'channel-command',
        companyId,
        channelId,
        command: { requestId, operation: 'update_metadata', expectedChannelGeneration: 1 }
      },
      { ...join, command: { requestId, operation: 'join' } },
      { action: 'channel-command', companyId, channelId, command: { requestId, operation: 'delete', expectedChannelGeneration: 1 } },
      { action: 'channel-command', companyId, channelId, command: { requestId, operation: 'accept', expectedChannelGeneration: 1 } },
      { action: 'set-avatar', companyId, requestId, avatarUri: 'https://cdn.atum.app/logo.png' },
      { action: 'set-avatar', companyId, requestId, avatarUri: 'mxc://matrix.atum.app/logo', bytes: 'forged' },
      { action: 'unknown-team-space-action', companyId }
    ]

    for (const value of rejected) {
      expect(() => parseMatrixCompanyRequest(value), JSON.stringify(value)).toThrow('invalid')
    }
  })

  it('a replayed request normalises to the same journal text', () => {
    const request = REQUESTS.find(entry => entry.request.action === 'role-change')!.request
    const shuffled = Object.fromEntries(Object.entries(request).reverse())

    expect(JSON.stringify(parseMatrixCompanyRequest(shuffled))).toBe(JSON.stringify(parseMatrixCompanyRequest(request)))
  })

  it('keeps bearer preview and redeem out of the persistent company journal', () => {
    const preview = parseMatrixCompanyRequest({ action: 'invite-link-preview', token: 'A'.repeat(43) })
    const redeem = parseMatrixCompanyRequest({ action: 'invite-link-redeem', requestId, token: 'A'.repeat(43) })

    expect(isMatrixCompanyRead(preview.action)).toBe(false)
    expect(isMatrixCompanyMutation(preview)).toBe(false)
    expect(isMatrixCompanyMutation(redeem)).toBe(false)
  })
})

describe('Team Space answers are bound to the request that asked', () => {
  const admin = packs['v1.3'].json('fixtures/admin-snapshot.response.json')
  const directory = packs['v1.4'].json('fixtures/channel-admitted-directory.response.json') as { channels: Array<{ channel: { companyId: string } }> }
  const browse = packs['v1.4'].json('fixtures/channel-browse.response.json')
  const joinableBrowse = packs['v1.6'].json('fixtures/channel-browse.response.json')
  const receipt = packs['v1.4'].json('fixtures/channel-command.response.json')
  const invitation = packs['v1.4'].json('fixtures/channel-invitation.response.json')
  const otherCompany = '00000000-0000-4000-8000-0535bd89d837'
  const adminCompany = '00000000-0000-4000-8000-72805976e3a7'
  const channelCompany = '00000000-0000-4000-8000-3f27f2fc4915'
  const joinableCompany = '00000000-0000-4000-8000-3ea3a757cb19'
  const channel = '00000000-0000-4000-8000-f19cafd05964'
  // What the frozen channel-invitation answer names: the person invited and its own id.
  const invitedRef = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  const invitationAnswered = '00000000-0000-4000-8000-38fdf4747966'

  it('accepts an answer for the company asked about and refuses another company', () => {
    expect(parseMatrixCompanyResponse(admin, { action: 'administration', companyId: adminCompany })).toEqual(admin)
    expect(() => parseMatrixCompanyResponse(admin, { action: 'administration', companyId: otherCompany })).toThrow('invalid')
    expect(parseMatrixCompanyResponse(directory, { action: 'admitted-channels', companyId: channelCompany })).toEqual(directory)
    expect(() => parseMatrixCompanyResponse(directory, { action: 'admitted-channels', companyId: otherCompany })).toThrow('invalid')
    expect(parseMatrixCompanyResponse(browse, { action: 'browse-channels', companyId: channelCompany })).toEqual(browse)
    expect(() => parseMatrixCompanyResponse(browse, { action: 'browse-channels', companyId: otherCompany })).toThrow('invalid')
    expect(parseMatrixCompanyResponse(joinableBrowse, { action: 'browse-joinable-channels', companyId: joinableCompany })).toEqual(joinableBrowse)
    expect(() => parseMatrixCompanyResponse(joinableBrowse, { action: 'browse-joinable-channels', companyId: otherCompany })).toThrow('invalid')
  })

  it('accepts a 1.10 directory invitation, handle or not, only for the company and role asked', () => {
    const created = packs['v1.10'].json('fixtures/invitation-create.response.json') as { invitation: { companyId: string } }
    const company = created.invitation.companyId

    const ask = { action: 'invitation-create-directory' as const, companyId: company, requestId,
      memberMatrixUser: '@user-0123:atum.test', role: 'member' as const }

    expect(parseMatrixCompanyResponse(created, ask)).toEqual(created)
    expect(parseMatrixCompanyResponse(packs['v1.10'].json('fixtures/invitation-create-handled.response.json'), ask))
      .toMatchObject({ invitation: { targetHandle: 'lan_nguyen' } })
    expect(() => parseMatrixCompanyResponse(created, { ...ask, companyId: otherCompany })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(created, { ...ask, role: 'admin' })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(packs['v1.3'].json('fixtures/invitation-create.response.json'), ask)).toThrow('invalid')
  })

  it('reads a channel command receipt by its operation, and an invitation by the channel it names', () => {
    const join = { requestId, operation: 'join' as const, expectedChannelGeneration: 7 }

    expect(
      parseMatrixCompanyResponse(receipt, { action: 'channel-command', companyId: channelCompany, channelId: channel, command: join })
    ).toEqual(receipt)
    expect(() =>
      parseMatrixCompanyResponse(receipt, {
        action: 'channel-command',
        companyId: channelCompany,
        channelId: channel,
        command: { requestId, operation: 'leave', expectedChannelGeneration: 7, expectedAdmissionGeneration: 4 }
      })
    ).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyResponse(receipt, {
        action: 'channel-command',
        companyId: channelCompany,
        channelId: '00000000-0000-4000-8000-4b37da97c68d',
        command: join
      })
    ).toThrow('invalid')

    const invite = { requestId, operation: 'invite' as const, memberRef: invitedRef, expectedChannelGeneration: 7 }

    expect(
      parseMatrixCompanyResponse(invitation, { action: 'channel-command', companyId: channelCompany, channelId: channel, command: invite })
    ).toEqual(invitation)
    // The receipt shape is not an invitation answer.
    expect(() =>
      parseMatrixCompanyResponse(receipt, { action: 'channel-command', companyId: channelCompany, channelId: channel, command: invite })
    ).toThrow('invalid')
    // An invitation for another channel is not this request's answer either.
    expect(() =>
      parseMatrixCompanyResponse(invitation, {
        action: 'channel-command',
        companyId: channelCompany,
        channelId: '00000000-0000-4000-8000-4b37da97c68d',
        command: invite
      })
    ).toThrow('invalid')
  })

  it('binds an invitation answer to the person invited and to the invitation acted on', () => {
    const ask = (command: wire.CompanyChannelCommand14Request) => ({
      action: 'channel-command' as const,
      companyId: channelCompany,
      channelId: channel,
      command
    })

    // An invite names the person it asked for: an answer about someone else is refused.
    expect(parseMatrixCompanyResponse(invitation, ask({ requestId, operation: 'invite', memberRef: invitedRef, expectedChannelGeneration: 7 }))).toEqual(
      invitation
    )
    expect(() =>
      parseMatrixCompanyResponse(invitation, ask({ requestId, operation: 'invite', memberRef, expectedChannelGeneration: 7 }))
    ).toThrow('invalid')

    // A decline and a cancel name the invitation they act on: another invitation's answer is refused.
    for (const operation of ['decline', 'cancel'] as const) {
      expect(
        parseMatrixCompanyResponse(invitation, ask({ requestId, operation, invitationId: invitationAnswered, expectedChannelGeneration: 7 }))
      ).toEqual(invitation)
      expect(() =>
        parseMatrixCompanyResponse(invitation, ask({ requestId, operation, invitationId, expectedChannelGeneration: 7 }))
      ).toThrow('invalid')
    }
  })

  it('refuses an old-wire body for a new-wire request (a later selection never widens an earlier shape)', () => {
    const older = { schemaVersion: 2, channels: [] }

    expect(() => parseMatrixCompanyResponse(older, { action: 'admitted-channels', companyId: channelCompany })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(older, { action: 'administration', companyId: adminCompany })).toThrow('invalid')
  })

  it('does not let the 1.4 directory be parsed as the 1.1 company-wide one', () => {
    expect(() => parseMatrixCompanyResponse(directory, { action: 'list-channels', companyId: channelCompany })).toThrow('invalid')
  })

  it('binds a company-avatar answer to the company and MXC URI asked for', () => {
    const answer = packs['v1.7'].json('fixtures/set-avatar.response.json')
    const request = {
      action: 'set-avatar' as const,
      companyId: '00000000-0000-4000-8000-877abe50a90f',
      requestId: '00000000-0000-4000-8000-ba58ff7e081b',
      avatarUri: 'mxc://matrix.atum.app/company-logo'
    }

    expect(parseMatrixCompanyResponse(answer, request)).toEqual(answer)
    expect(() => parseMatrixCompanyResponse(answer, { ...request, companyId: otherCompany })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(answer, { ...request, avatarUri: 'mxc://matrix.atum.app/other' })).toThrow('invalid')
  })
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Team Space transport', () => {
  it('sends the family wire, a closed body and no credentials beyond the native bearer', async () => {
    const answer = packs['v1.3'].json('fixtures/role-change.response.json')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(answer))
    vi.stubGlobal('fetch', fetch)

    const request = REQUESTS.find(entry => entry.request.action === 'role-change')!

    await expect(
      requestMatrixCompany(resource, grant, request.request as never, AbortSignal.timeout(1000))
    ).resolves.toEqual(answer)

    const [url, init] = fetch.mock.calls[0]!

    expect(url).toBe(`${resource}${request.path}`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(init!.headers).toMatchObject({ 'Atum-Company-Wire': '1.3', Authorization: 'Bearer native-only' })
    expect(JSON.parse(init!.body as string)).toEqual(request.body)
  })

  it('reads carry no body and the family wire', async () => {
    const answer = packs['v1.4'].json('fixtures/channel-browse.response.json')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(answer))
    vi.stubGlobal('fetch', fetch)

    await requestMatrixCompany(resource, grant, { action: 'browse-channels', companyId: channelCompanyId }, AbortSignal.timeout(1000))

    const [, init] = fetch.mock.calls[0]!

    expect(init).toMatchObject({ method: 'GET' })
    expect(init).not.toHaveProperty('body')
    expect(init!.headers).toMatchObject({ 'Atum-Company-Wire': '1.4' })
  })

  it('direct-probes the joinable browse with wire 1.6', async () => {
    const answer = packs['v1.6'].json('fixtures/channel-browse.response.json')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(answer))
    vi.stubGlobal('fetch', fetch)

    await requestMatrixCompany(
      resource,
      grant,
      { action: 'browse-joinable-channels', companyId: '00000000-0000-4000-8000-3ea3a757cb19' },
      AbortSignal.timeout(1000)
    )

    const [, init] = fetch.mock.calls[0]!

    expect(init).toMatchObject({ method: 'GET' })
    expect(init).not.toHaveProperty('body')
    expect(init!.headers).toMatchObject({ 'Atum-Company-Wire': '1.6' })
  })

  it('maps an older server to a plain status, never to data (old servers mean no Team Space)', async () => {
    for (const [status, code] of [[404, 'missing'], [400, 'invalid']] as const) {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => json({ error: `matrix_${status}` }, status)))

      await expect(
        requestMatrixCompany(resource, grant, { action: 'capabilities' }, AbortSignal.timeout(1000))
      ).rejects.toMatchObject({ code, reason: undefined })
    }

    // A v1 server ignores the header and answers a v1 body: a closed parser refuses it.
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => json({ schemaVersion: 1, channels: [] })))
    await expect(
      requestMatrixCompany(resource, grant, { action: 'admitted-channels', companyId: channelCompanyId }, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('carries the typed refusal reason of the request family and ignores every other', async () => {
    const refuse = (status: number, body: unknown) => {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => json(body, status)))
    }

    const transfer = { action: 'ownership-transfer', companyId, requestId, targetMemberRef: memberRef, expectedAuthorityGeneration: 8 } as const

    refuse(409, { error: 'matrix_409', details: { reason: 'owner_generation_conflict' } })
    await expect(requestMatrixCompany(resource, grant, transfer, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'conflict',
      reason: 'owner_generation_conflict'
    })

    // A reason that belongs to another family, another status, or carries more keys is not understood.
    for (const [status, body] of [
      [409, { error: 'matrix_409', details: { reason: 'channel_archived' } }],
      [404, { error: 'matrix_404', details: { reason: 'owner_generation_conflict' } }],
      [409, { error: 'matrix_409', details: { reason: 'owner_generation_conflict', displayName: 'secret' } }],
      [409, { error: 'matrix_404', details: { reason: 'owner_target_unavailable' } }],
      [409, 'not an object']
    ] as const) {
      refuse(status, body)
      await expect(requestMatrixCompany(resource, grant, transfer, AbortSignal.timeout(1000))).rejects.toSatisfy(
        (error: unknown) => error instanceof MatrixCompanyError && error.reason === undefined
      )
    }

    refuse(409, { error: 'matrix_409', details: { reason: 'channel_name_conflict' } })
    await expect(
      requestMatrixCompany(
        resource,
        grant,
        { action: 'channel-command', companyId, command: { requestId, operation: 'create', displayName: 'ops', visibility: 'public' } },
        AbortSignal.timeout(1000)
      )
    ).rejects.toMatchObject({ code: 'conflict', reason: 'channel_name_conflict' })
  })

  it('a private channel that the platform does not name is not named by an error either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () =>
        json({ error: 'matrix_404', details: { reason: 'channel_unavailable', displayName: 'secret' } }, 404)
      )
    )

    await expect(
      requestMatrixCompany(resource, grant, { action: 'read-admitted-channel', companyId, channelId }, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'missing', reason: undefined })
  })
})

const channelCompanyId = '00000000-0000-4000-8000-3f27f2fc4915'

/*
 * Company channel command 1.1 (atum-platform spec/company-channel-command/v1.1), vendored verbatim beside the
 * workspace packs: create carries the people who start in the channel, and add admits one person directly.
 */
describe('company channel command 1.1', () => {
  const root = resolve(packRoot, 'atum-company-channel-command-v1.1')
  const read = (file: string) => readFileSync(resolve(root, file))
  const load = (file: string): unknown => JSON.parse(read(file).toString('utf8'))

  const command11: Pack = {
    version: 'v1.1',
    contract: load('contract.json') as Pack['contract'],
    vendored: load('VENDORED.json') as Pack['vendored'],
    read,
    json: load
  }

  const parsers: Record<string, Check> = {
    request: schema(wire.CompanyChannelCommand15RequestSchema),
    response: schema(wire.CompanyChannelCommand15ResponseSchema)
  }

  const ref = (letter: string) => letter.repeat(43)
  const created = command11.json('fixtures/create.response.json')
  const added = command11.json('fixtures/add.response.json')
  const newChannel = '00000000-0000-4000-8000-f19cafd05964'

  const create = (initialMemberRefs: string[]) => ({
    action: 'channel-command' as const,
    companyId: channelCompanyId,
    command: { requestId, operation: 'create' as const, displayName: 'Launch', visibility: 'public' as const, initialMemberRefs }
  })

  const add = (target: string, onChannel = newChannel) => ({
    action: 'channel-command' as const,
    companyId: channelCompanyId,
    channelId: onChannel,
    command: { requestId, operation: 'add' as const, memberRef: target, expectedChannelGeneration: 1 }
  })

  it('is the exact frozen pack', () => {
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(command11.vendored.sha256)
    expect(digest(command11)).toBe(command11.vendored.sha256)
    expect(command11.vendored.path).toBe('spec/company-channel-command/v1.1')
    expect(command11.contract.version).toBe('1.1')
  })

  it.each(command11.contract.fixtures.map(fixture => [fixture.file, fixture] as const))('%s', (_file, fixture) => {
    expect(parsers[fixture.message!]!(command11.json(fixture.file)), `${fixture.file} must be ${fixture.expect}ed`)
      .toBe(fixture.expect === 'accept')
  })

  it('sends a create with its people and a direct add on the channel wire plus the profile header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(created))
    vi.stubGlobal('fetch', fetch)

    await expect(requestMatrixCompany(resource, grant, create([ref('B')]), AbortSignal.timeout(1000))).resolves.toEqual(created)

    const [url, init] = fetch.mock.calls[0]!

    expect(url).toBe(`${resource}/companies/${channelCompanyId}/channels`)
    expect(init!.headers).toMatchObject({ 'Atum-Company-Wire': '1.4', 'Atum-Company-Channel-Command': '1.1' })
    expect(JSON.parse(init!.body as string)).toEqual(create([ref('B')]).command)

    fetch.mockImplementation(async () => json(added))
    await expect(requestMatrixCompany(resource, grant, add(ref('A')), AbortSignal.timeout(1000))).resolves.toEqual(added)

    const [addUrl, addInit] = fetch.mock.calls[1]!

    expect(addUrl).toBe(`${resource}/companies/${channelCompanyId}/channels/${newChannel}/members`)
    expect(addInit!.headers).toMatchObject({ 'Atum-Company-Wire': '1.4', 'Atum-Company-Channel-Command': '1.1' })
  })

  it('keeps a create journaled without people on the frozen 1.4 command, with no profile', () => {
    const legacy = { action: 'channel-command' as const, companyId: channelCompanyId,
      command: { requestId, operation: 'create' as const, displayName: 'Launch', visibility: 'private' as const } }

    expect(matrixCompanyRoute(parseMatrixCompanyRequest(legacy))).not.toHaveProperty('profile')
    expect(matrixCompanyRoute(parseMatrixCompanyRequest(create([])))).toMatchObject({ profile: { value: '1.1' } })
    // The same person twice is not a command the contract allows.
    expect(() => parseMatrixCompanyRequest(create([ref('B'), ref('B')]))).toThrow()
  })

  it('binds the admissions to the people the command named', () => {
    // The creator (A) is admitted with the one pick (B).
    expect(parseMatrixCompanyResponse(created, create([ref('B')]))).toEqual(created)
    // Two people nobody picked is not this create's answer.
    expect(() => parseMatrixCompanyResponse(created, create([]))).toThrow('invalid')

    expect(parseMatrixCompanyResponse(added, add(ref('A')))).toEqual(added)
    expect(() => parseMatrixCompanyResponse(added, add(ref('C')))).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(added, add(ref('A'), '00000000-0000-4000-8000-4b37da97c68d'))).toThrow('invalid')
    // A 1.4 receipt is never read as a 1.1 answer.
    expect(() => parseMatrixCompanyResponse(packs['v1.4'].json('fixtures/channel-command.response.json'), create([ref('B')])))
      .toThrow('invalid')
  })
})

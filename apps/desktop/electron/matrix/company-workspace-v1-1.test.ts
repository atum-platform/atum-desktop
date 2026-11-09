import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { MatrixCompanyRequest } from '../../shared/matrix-company'

import { parseMatrixCompanyRequest, parseMatrixCompanyResponse } from './company'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-workspace-v1.1/fixtures')

const fixture = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, file), 'utf8')) as Record<string, unknown>

const companyId = '00000000-0000-4000-8000-2a39c7cf131c'
const channelId = '00000000-0000-4000-8000-c52538d87a60'
const memberRef = 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew'
const requestId = '00000000-0000-4000-8000-175097128f22'

describe('company-workspace v1 stays byte-compatible', () => {
  it('parses every accepted v1 fixture with the shipped v1 parser', () => {
    expect(parseMatrixCompanyResponse(fixture('v1.list.response.json'), { action: 'list' }))
      .toEqual(fixture('v1.list.response.json'))
    expect(parseMatrixCompanyResponse(fixture('v1.snapshot.response.json'), { action: 'read', companyId }))
      .toEqual(fixture('v1.snapshot.response.json'))

    // The desktop shipped create/accept on v1; invite/remove-member were never
    // part of its v1 path (the plan's G2), so only these are its old wire.
    for (const file of ['v1.create.request.json', 'v1.accept.request.json']) {
      const action = file.includes('create') ? 'create' : 'accept'

      expect(parseMatrixCompanyRequest({ action, ...(action === 'create' ? {} : { companyId }), ...fixture(file) } as unknown))
        .toBeTruthy()
    }
  })

  it('refuses v1 answers that carry a 1.1 addition', () => {
    expect(() => parseMatrixCompanyResponse(fixture('v1.list-extra-can-create.response.json'), { action: 'list' }))
      .toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('v1.list-inviter.response.json'), { action: 'list' }))
      .toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('v1.snapshot-member-handle.response.json'),
      { action: 'read', companyId })).toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('v1.snapshot-default-channel.response.json'),
      { action: 'read', companyId })).toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('v1.snapshot-schema-2.response.json'),
      { action: 'read', companyId })).toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('v1.removal-removed.response.json'),
      { action: 'remove-member', companyId, requestId, memberRef })).toThrow('matrix_company_invalid')
    // The desktop's own remove path is 1.1-only; it never consumes the v1 response.
    expect(() => parseMatrixCompanyResponse(fixture('v1.removal.response.json'),
      { action: 'remove-member', companyId, requestId, memberRef } as MatrixCompanyRequest))
      .toThrow('matrix_company_invalid')
  })
})

describe('company-workspace 1.1 parser', () => {
  it('accepts the directory, snapshot and channel projections', () => {
    expect(parseMatrixCompanyResponse(fixture('list.response.json'), { action: 'list' }))
      .toEqual(fixture('list.response.json'))

    for (const file of ['snapshot-create.response.json', 'snapshot-member.response.json',
      'snapshot-admin.response.json', 'snapshot-legacy.response.json']) {
      expect(parseMatrixCompanyResponse(fixture(file), { action: 'read', companyId }))
        .toEqual(fixture(file))
    }

    expect(parseMatrixCompanyResponse(fixture('channel-directory.response.json'),
      { action: 'list-channels', companyId })).toEqual(fixture('channel-directory.response.json'))
    expect(parseMatrixCompanyResponse(fixture('channel-directory-empty.response.json'),
      { action: 'list-channels', companyId })).toEqual(fixture('channel-directory-empty.response.json'))
    expect(parseMatrixCompanyResponse(fixture('channel-default.snapshot.json'),
      { action: 'read-channel', companyId, channelId })).toEqual(fixture('channel-default.snapshot.json'))
    expect(parseMatrixCompanyResponse(fixture('channel-ready.snapshot.json'),
      { action: 'read-channel', companyId, channelId: (fixture('channel-ready.snapshot.json').channel as { id: string }).id }))
      .toEqual(fixture('channel-ready.snapshot.json'))
  })

  it('accepts the revocation acknowledgements and the selector header fixture', () => {
    expect(parseMatrixCompanyResponse(fixture('removal.response.json'),
      { action: 'remove-member', companyId, requestId, memberRef })).toEqual(fixture('removal.response.json'))
    expect(parseMatrixCompanyResponse(fixture('removal-replayed.response.json'),
      { action: 'remove-member', companyId, requestId, memberRef })).toEqual(fixture('removal-replayed.response.json'))
    expect(parseMatrixCompanyResponse(fixture('leave.response.json'), { action: 'leave', companyId, requestId }))
      .toEqual(fixture('leave.response.json'))
    expect(parseMatrixCompanyResponse(fixture('leave-removed.response.json'), { action: 'leave', companyId, requestId }))
      .toEqual(fixture('leave-removed.response.json'))
    expect(parseMatrixCompanyResponse(fixture('leave-retired.response.json'), { action: 'leave', companyId, requestId }))
      .toEqual(fixture('leave-retired.response.json'))
    expect(fixture('selector.headers.json')).toEqual({ 'Atum-Company-Wire': '1.1', Accept: 'application/json' })
  })

  it('parses 1.1-only requests exactly and keeps the handle as typed', () => {
    expect(parseMatrixCompanyRequest({ action: 'invite', companyId, ...fixture('invite.request.json') })).toEqual({
      action: 'invite', companyId, requestId, memberHandle: '@Lan_Nguyen', role: 'member'
    })
    expect(parseMatrixCompanyRequest({ action: 'remove-member', companyId, ...fixture('remove-member.request.json') }))
      .toEqual({ action: 'remove-member', companyId, requestId, memberRef })
    expect(parseMatrixCompanyRequest({ action: 'leave', companyId, ...fixture('leave.request.json') }))
      .toEqual({ action: 'leave', companyId, requestId })
  })

  it('refuses a principal, profile leak, bad ref, or malformed member projection', () => {
    const rejects = [
      ['snapshot-principal.response.json', 'read'],
      ['snapshot-email.response.json', 'read'],
      ['snapshot-matrix-id.response.json', 'read'],
      ['snapshot-project-principals.response.json', 'read'],
      ['snapshot-avatar-url.response.json', 'read'],
      ['snapshot-bad-ref.response.json', 'read'],
      ['snapshot-removed-identity.response.json', 'read'],
      ['list-inviter-principal.response.json', 'list'],
      ['list-inviter-ref.response.json', 'list'],
      ['removal-principal.response.json', 'remove-member'],
      ['leave-active.response.json', 'leave'],
      ['leave-no-retired.response.json', 'leave']
    ] as const

    for (const [file, action] of rejects) {
      expect(() => parseMatrixCompanyResponse(fixture(file), action === 'list'
        ? { action: 'list' }
        : action === 'remove-member'
          ? { action: 'remove-member', companyId, requestId, memberRef }
          : action === 'leave'
            ? { action: 'leave', companyId, requestId }
            : { action: 'read', companyId })).toThrow('matrix_company_invalid')
    }
  })

  it('refuses 1.1 requests that smuggle authority or misstate the handle', () => {
    for (const [file, action] of [
      ['invite-both.request.json', 'invite'], ['invite-principal.request.json', 'invite'],
      ['invite-hyphen.request.json', 'invite'], ['invite-short.request.json', 'invite'],
      ['invite-role.request.json', 'invite'], ['remove-member-principal.request.json', 'remove-member'],
      ['remove-member-short-ref.request.json', 'remove-member'], ['leave-actor.request.json', 'leave'],
      ['leave-target.request.json', 'leave']
    ]) {
      expect(() => parseMatrixCompanyRequest({ action, companyId, requestId,
        memberHandle: '@lan_nguyen', memberRef, ...fixture(file) })).toThrow('matrix_company_invalid')
    }
  })

  it('refuses channel projections that leak principals or invent a system key', () => {
    expect(() => parseMatrixCompanyResponse(fixture('channel-principals.snapshot.json'),
      { action: 'read-channel', companyId, channelId })).toThrow('matrix_company_invalid')
    expect(() => parseMatrixCompanyResponse(fixture('channel-system-key.snapshot.json'),
      { action: 'read-channel', companyId, channelId })).toThrow('matrix_company_invalid')
  })
})

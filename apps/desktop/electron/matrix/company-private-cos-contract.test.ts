import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyAIEmptyJournal, matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE,
  MatrixCompanyPrivateCosCapabilitySchema,
  MatrixCompanyPrivateCosCapabilityV1Schema,
  MatrixCompanyPrivateCosCapabilityV12Schema,
  MatrixCompanyPrivateCosCapabilityV13Schema,
  MatrixCompanyPrivateCosEnsureRequestSchema,
  MatrixCompanyPrivateCosGreetingClaimSchema,
  MatrixCompanyPrivateCosGreetingContentSchema,
  MatrixCompanyPrivateCosGreetingSchema,
  MatrixCompanyPrivateCosOwnerReceiptSchema,
  MatrixCompanyPrivateCosPreparingV11Schema,
  MatrixCompanyPrivateCosRoomAttemptSchema,
  matrixCompanyPrivateCosRoute,
  matrixCompanyPrivateCosSupportsV11,
  matrixCompanyPrivateCosSupportsV12,
  matrixCompanyPrivateCosSupportsV13,
  MatrixCompanyPrivateCosUnfundedStopReceiptSchema,
  MatrixCompanyPrivateCosViewSchema,
  parseMatrixCompanyPrivateCosRequest
} from '../../shared/matrix-company-private-cos'

import { requestMatrixCompanyPrivateCos } from './company-private-cos'

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts')
const root = resolve(contracts, 'atum-company-private-cos-v1.3')
const v12 = resolve(contracts, 'atum-company-private-cos-v1.2')
const v11 = resolve(contracts, 'atum-company-private-cos-v1.1')
const base = resolve(contracts, 'atum-company-private-cos-v1')
const read = (directory: string, file: string) => readFileSync(resolve(directory, file))

const json = <T = unknown>(directory: string, file: string): T =>
  JSON.parse(read(directory, file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-540eb3b6436f'
const runId = '00000000-0000-4000-8000-e5d1aab98d21'
const requestId = '00000000-0000-4000-8000-ea3f14245121'
const wireHeaders = { 'Atum-Company-Wire': '1.3' }

function digest(directory: string, files: string[]): string {
  const hash = createHash('sha256')

  for (const file of files) {
    const name = Buffer.from(file, 'utf8')
    const body = read(directory, file)
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

function context() {
  return {
    resource: 'https://api.test/api/matrix/v1',
    accessToken: 'native-only',
    signal: AbortSignal.timeout(2_000),
    scope: matrixCompanyScope('account', companyId),
    assertCurrent: vi.fn(),
    journal: matrixCompanyAIEmptyJournal()
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('vendored company-private-cos/1.3 pack', () => {
  const contract = json<{ pack_files: string[] }>(root, 'contract.json')

  const vendored = json<{ contract: string; sha256: string; commit: string; path: string; protocolPackage: string }>(
    root,
    'VENDORED.json'
  )

  it('pins the frozen 1.3 bytes (0395 reference) at protocol 0.7.78', () => {
    expect(vendored).toMatchObject({
      contract: 'atum.company-private-cos/1.3',
      commit: '2517a89593cf26854342479bb1b6aeb7bb214152',
      path: 'spec/company-private-cos/v1.3',
      protocolPackage: '@atum/protocol@0.7.78'
    })
    expect(read(root, 'PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(root, contract.pack_files)).toBe(vendored.sha256)
  })

  it('pins the exact private assistant room marker and policy', () => {
    const bootstrap = json<{
      private_room_bootstrap: {
        room_type: string
        classification: string
        marker: { type: string; state_key: string; content: string[] }
        policy: {
          room_version: string
          encrypted: boolean
          history_visibility: string
          join_rule: string
          power_levels: {
            users: Record<string, number>
            users_default: number
            events_default: number
            state_default: number
            invite: number
            kick: number
            ban: number
            redact: number
            events: Record<string, number>
          }
        }
      }
    }>(v11, 'contract.json').private_room_bootstrap

    expect(bootstrap).toMatchObject({
      room_type: 'io.atum.assistant',
      classification: 'company_private_cos',
      marker: {
        type: 'io.atum.company_private_cos',
        state_key: '',
        content: ['v:1', 'classification:company_private_cos', 'companyId', 'membershipIncarnation', 'executorId']
      },
      policy: {
        room_version: '11',
        encrypted: true,
        history_visibility: 'joined',
        join_rule: 'invite',
        power_levels: {
          users: { manager: 100, member: 0, agent: 0 },
          users_default: 0,
          events_default: 0,
          state_default: 100,
          invite: 100,
          kick: 100,
          ban: 100,
          redact: 100
        }
      }
    })
    expect(bootstrap.policy.power_levels.events).toEqual(
      Object.fromEntries(MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE.map(type => [type, 100]))
    )
  })

  it('parses the explicit 1.3 capability, locale ensure and room-attempt fixtures', () => {
    const capability = json(root, 'fixtures/capability.response.json')
    const ensure = json(root, 'fixtures/ensure-locale.request.json')
    const attempt = json(root, 'fixtures/room-attempt.json')

    expect(MatrixCompanyPrivateCosCapabilityV13Schema.parse(capability)).toEqual(capability)
    expect(MatrixCompanyPrivateCosCapabilitySchema.parse(capability)).toEqual(capability)
    expect(matrixCompanyPrivateCosSupportsV13(capability)).toBe(true)
    expect(MatrixCompanyPrivateCosEnsureRequestSchema.parse(ensure)).toEqual(ensure)
    expect(MatrixCompanyPrivateCosRoomAttemptSchema.parse(attempt)).toEqual(attempt)
  })

  it('retains the frozen 1.2 capability and greeting fixtures', () => {
    const capability = json(v12, 'fixtures/capability.response.json')
    const claim = json(v12, 'fixtures/greeting.claim.json')
    const cardClaim = json(v12, 'fixtures/greeting.claim.card.json')
    const content = json(v12, 'fixtures/greeting.matrix-content.json')
    const cardContent = json(v12, 'fixtures/greeting.matrix-content.card.json')

    expect(MatrixCompanyPrivateCosCapabilityV12Schema.parse(capability)).toEqual(capability)
    expect(MatrixCompanyPrivateCosCapabilitySchema.parse(capability)).toEqual(capability)
    expect(matrixCompanyPrivateCosSupportsV12(capability)).toBe(true)
    expect(MatrixCompanyPrivateCosGreetingClaimSchema.parse(claim)).toEqual(claim)
    expect(MatrixCompanyPrivateCosGreetingClaimSchema.parse(cardClaim)).toEqual(cardClaim)
    expect(MatrixCompanyPrivateCosGreetingContentSchema.parse(content)).toEqual(content)
    expect(MatrixCompanyPrivateCosGreetingContentSchema.parse(cardContent)).toEqual(cardContent)
  })

  it('parses the 1.1 capability and binding-free preparing fixtures and rejects unversioned bytes', () => {
    const capability = json(v11, 'fixtures/capability.response.json')
    const accepted = json(v11, 'fixtures/ensure-accepted.response.json')

    expect(MatrixCompanyPrivateCosCapabilitySchema.parse(capability)).toEqual(capability)
    expect(matrixCompanyPrivateCosSupportsV11(capability)).toBe(true)
    expect(MatrixCompanyPrivateCosPreparingV11Schema.parse(accepted)).toEqual(accepted)
    expect(MatrixCompanyPrivateCosViewSchema.parse(accepted)).toEqual(accepted)
    expect(() => MatrixCompanyPrivateCosPreparingV11Schema.parse(
      json(v11, 'fixtures/ensure-unversioned.response.json')
    )).toThrow()
  })

  it('retains the frozen v1 fixtures as the exact bound base without advertising 1.1', () => {
    const capability = json(base, 'fixtures/capability.response.json')

    expect(MatrixCompanyPrivateCosCapabilityV1Schema.parse(capability)).toEqual(capability)
    expect(matrixCompanyPrivateCosSupportsV11(capability)).toBe(false)
    expect(MatrixCompanyPrivateCosViewSchema.parse(json(base, 'fixtures/lazy-first-open.uncreated.response.json')))
      .toEqual(json(base, 'fixtures/lazy-first-open.uncreated.response.json'))
    expect(MatrixCompanyPrivateCosViewSchema.parse(json(base, 'fixtures/lazy-first-open.preparing.response.json')))
      .toEqual(json(base, 'fixtures/lazy-first-open.preparing.response.json'))
    expect(MatrixCompanyPrivateCosEnsureRequestSchema.parse(json(base, 'fixtures/lazy-first-open.ensure.request.json')))
      .toEqual(json(base, 'fixtures/lazy-first-open.ensure.request.json'))
    expect(MatrixCompanyPrivateCosGreetingSchema.parse(json(base, 'fixtures/greeting-once.record.json')))
      .toEqual(json(base, 'fixtures/greeting-once.record.json'))
    expect(MatrixCompanyPrivateCosOwnerReceiptSchema.parse(json(base, 'fixtures/owner-run.receipt.json')))
      .toEqual(json(base, 'fixtures/owner-run.receipt.json'))
    expect(() => MatrixCompanyPrivateCosEnsureRequestSchema.parse(
      json(base, 'fixtures/lazy-sidebar-render.ensure.request.json')
    )).toThrow()
  })

  it('parses the round-4 queued unfunded owner Stop receipt without fabricating funding', () => {
    const receipt = {
      schemaVersion: 2,
      profile: 'atum.company-private-cos/1.1',
      runId,
      taskId: runId,
      pair: {
        companyPrincipal: companyId,
        memberPrincipal: '00000000-0000-4000-8000-7b0cac15d6b0',
        membershipIncarnation: '00000000-0000-4000-8000-ed2914fe0e5a'
      },
      executorId: '00000000-0000-4000-8000-3f48695086a0',
      contextEpoch: 1,
      homeGeneration: 1,
      authorityEpoch: 1,
      state: 'stopped',
      verifiedEventId: '$queued-unfunded',
      funding: {
        state: 'not_reserved',
        reservationId: null,
        reservedMicroProtons: 0,
        settledMicroProtons: 0
      },
      homeCommitId: null,
      outboxTransactionId: null,
      publishedEventId: null,
      sourceLinks: []
    }

    expect(MatrixCompanyPrivateCosUnfundedStopReceiptSchema.parse(receipt)).toEqual(receipt)
  })

  it('uses only owner-derived native routes and carries no member selector', () => {
    expect(matrixCompanyPrivateCosRoute({ action: 'private-cos-capability', companyId }))
      .toEqual({ method: 'GET', path: '/cloud/controller/company-private-cos' })
    expect(matrixCompanyPrivateCosRoute({ action: 'private-cos-view', companyId }))
      .toEqual({ method: 'GET', path: `/companies/${companyId}/private-cos`, headers: wireHeaders })
    expect(matrixCompanyPrivateCosRoute({
      action: 'private-cos-ensure', companyId, schemaVersion: 1, requestId, trigger: 'dm_open'
    })).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/private-cos`,
      body: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'dm_open' },
      headers: wireHeaders
    })
    expect(matrixCompanyPrivateCosRoute({
      action: 'private-cos-ensure',
      companyId,
      schemaVersion: 1,
      requestId,
      trigger: 'first_company_visit',
      locale: 'vi'
    })).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/private-cos`,
      body: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'first_company_visit', locale: 'vi' },
      headers: wireHeaders
    })
    expect(matrixCompanyPrivateCosRoute({ action: 'private-cos-receipt', companyId, runId }))
      .toEqual({ method: 'GET', path: `/companies/${companyId}/private-cos/runs/${runId}/receipt` })
    expect(matrixCompanyPrivateCosRoute({
      action: 'private-cos-stop', companyId, runId, schemaVersion: 1, requestId
    })).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/private-cos/runs/${runId}/stop`,
      body: { schemaVersion: 1, requestId }
    })
    expect(() => parseMatrixCompanyPrivateCosRequest({
      action: 'private-cos-view', companyId, memberPrincipal: requestId
    })).toThrow()
  })

  it('requires the exact frozen 1.3 advertisement before sending locale', () => {
    const advertisement = MatrixCompanyPrivateCosCapabilityV13Schema.parse(
      json(root, 'fixtures/capability.response.json')
    )
    const incomplete = {
      profile: MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE,
      supportedProfiles: advertisement.supportedProfiles
    }

    expect(matrixCompanyPrivateCosSupportsV13(advertisement)).toBe(true)
    expect(matrixCompanyPrivateCosSupportsV13(incomplete)).toBe(false)
  })
})

describe('native company-private-cos client', () => {
  it('reads the explicit platform capability from its frozen endpoint', async () => {
    const capability = json<Record<string, unknown>>(root, 'fixtures/capability.response.json')
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(capability))
    vi.stubGlobal('fetch', fetcher)

    await expect(requestMatrixCompanyPrivateCos(context(), {
      action: 'private-cos-capability',
      companyId
    })).resolves.toEqual(capability)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.test/api/matrix/v1/cloud/controller/company-private-cos')
  })

  it('adopts one exact owner view and replays the same uncertain ensure intent', async () => {
    const view = json<Record<string, unknown>>(v11, 'fixtures/ensure-accepted.response.json')
    const preparing = json<Record<string, unknown>>(v11, 'fixtures/ensure-accepted.response.json')

    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(view))
      .mockRejectedValueOnce(new Error('socket lost'))
      .mockResolvedValueOnce(Response.json(preparing, { status: 202 }))

    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    await expect(requestMatrixCompanyPrivateCos(ctx, { action: 'private-cos-view', companyId })).resolves.toEqual(view)
    const ensure = { action: 'private-cos-ensure' as const, companyId, schemaVersion: 1 as const, requestId, trigger: 'dm_open' as const }
    await expect(requestMatrixCompanyPrivateCos(ctx, ensure)).rejects.toThrow('socket lost')
    await expect(requestMatrixCompanyPrivateCos(ctx, { ...ensure, trigger: 'first_company_visit' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(requestMatrixCompanyPrivateCos(ctx, ensure)).resolves.toEqual(preparing)
    expect(fetcher).toHaveBeenCalledTimes(3)

    for (const call of fetcher.mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject(wireHeaders)
    }
  })

  it('accepts and exactly replays the versioned unfunded owner Stop response', async () => {
    const receipt = {
      schemaVersion: 2,
      profile: 'atum.company-private-cos/1.1',
      runId,
      taskId: runId,
      pair: {
        companyPrincipal: companyId,
        memberPrincipal: '00000000-0000-4000-8000-7b0cac15d6b0',
        membershipIncarnation: '00000000-0000-4000-8000-ed2914fe0e5a'
      },
      executorId: '00000000-0000-4000-8000-3f48695086a0',
      contextEpoch: 1,
      homeGeneration: 1,
      authorityEpoch: 1,
      state: 'stopped',
      verifiedEventId: '$queued-unfunded',
      funding: {
        state: 'not_reserved',
        reservationId: null,
        reservedMicroProtons: 0,
        settledMicroProtons: 0
      },
      homeCommitId: null,
      outboxTransactionId: null,
      publishedEventId: null,
      sourceLinks: []
    }

    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json(receipt))

    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    const stop = {
      action: 'private-cos-stop' as const,
      companyId,
      runId,
      schemaVersion: 1 as const,
      requestId
    }

    await expect(requestMatrixCompanyPrivateCos(ctx, stop)).resolves.toEqual(receipt)
    await expect(requestMatrixCompanyPrivateCos(ctx, stop)).resolves.toEqual(receipt)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

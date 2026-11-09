import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  MATRIX_COMPANY_MEMBER_FUND_MAX_PROTONS,
  MatrixCompanyFundingErrorSchema,
  matrixCompanyFundingRoute,
  MatrixCompanyMemberFundSchema,
  parseMatrixCompanyFundingRequest
} from '../../shared/matrix-company-funding'

import { requestMatrixCompanyFunding } from './company-funding'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-funding-v2.1')
const v2Root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-funding-v2')
const read = (file: string, at = root) => readFileSync(resolve(at, file))
const json = <T = unknown>(file: string, at = root): T => JSON.parse(read(file, at).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-61b0206ddea9'
const requestId = '00000000-0000-4000-8000-6ea014a92b8f'
const intent = { action: 'funding-member-fund' as const, companyId, requestId, protons: 40 }

function digest(files: string[]): string {
  const hash = createHash('sha256')

  for (const file of files) {
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

function context() {
  const entries = new Map<string, string>()

  return {
    resource: 'https://api.test/api/matrix/v1',
    accessToken: 'native-only',
    signal: AbortSignal.timeout(2000),
    scope: matrixCompanyScope('account', companyId),
    assertCurrent: () => {},
    journal: {
      read: (scope: string) => entries.get(scope) ?? null,
      write: (scope: string, value: string) => {
        entries.set(scope, value)
      },
      clear: (scope: string, value: string) => {
        if (entries.get(scope) === value) {
          entries.delete(scope)
        }
      }
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('vendored company-funding/2.1 pack', () => {
  const contract = json<{
    base: { sha256: string }
    pack_files: string[]
    fixtures: Array<{ file: string; message: string; expect: 'accept' | 'reject' }>
  }>('contract.json')

  const vendored = json<{ contract: string; sha256: string; path: string }>('VENDORED.json')

  it('pins the exact pack bytes over the vendored /2 base', () => {
    expect(vendored.contract).toBe('atum.company-funding/2.1')
    expect(vendored.path).toBe('spec/company-funding/v2.1')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
    expect(contract.base.sha256).toBe(read('PINNED-SHA256', v2Root).toString('utf8').trim())
  })

  it('matches every accepted and rejected fixture with the desktop parsers', () => {
    const parse: Record<string, (value: unknown) => boolean> = {
      'fund.response': value => MatrixCompanyMemberFundSchema.safeParse(value).success,
      'funding-error.response': value => MatrixCompanyFundingErrorSchema.safeParse(value).success,
      'fund.request': value => {
        try {
          parseMatrixCompanyFundingRequest({ action: 'funding-member-fund', companyId, ...(value as object) })

          return true
        } catch {
          return false
        }
      }
    }

    for (const entry of contract.fixtures) {
      const body = json<Record<string, unknown>>(entry.file)
      // The IPC request carries no schemaVersion; the route adds it.
      const value = entry.message === 'fund.request' ? (({ schemaVersion: _, ...rest }) => rest)(body) : body
      expect(parse[entry.message]!(value), entry.file).toBe(entry.expect === 'accept')
    }
  })

  it('posts only requestId and whole Protons to /wallet/fund', () => {
    expect(matrixCompanyFundingRoute(intent)).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/wallet/fund`,
      body: json('fixtures/fund.request.json')
    })

    for (const protons of [0, 1.5, MATRIX_COMPANY_MEMBER_FUND_MAX_PROTONS + 1]) {
      expect(() => parseMatrixCompanyFundingRequest({ ...intent, protons })).toThrow('invalid')
    }
  })
})

describe('native member-fund client', () => {
  it('sends wire 2 and returns the parsed transfer, closing its intent', async () => {
    const fund = json<Record<string, unknown>>('fixtures/fund.response.json')
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(fund))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    await expect(requestMatrixCompanyFunding(ctx, intent)).resolves.toEqual(fund)
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.test/api/matrix/v1/companies/${companyId}/wallet/fund`)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Atum-Company-Funding': '2' }),
      body: JSON.stringify({ schemaVersion: 2, requestId, protons: 40 })
    })
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('a short wallet is a definite refusal: insufficient_protons, intent closed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(Response.json(json('fixtures/fund-insufficient.response.json'), { status: 409 }))
    )
    const ctx = context()

    await expect(requestMatrixCompanyFunding(ctx, intent)).rejects.toMatchObject({ code: 'insufficient_protons' })
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('an unconfirmed transfer replays with the same request and refuses a different one before I/O', async () => {
    const fund = json<Record<string, unknown>>('fixtures/fund.response.json')
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    await expect(requestMatrixCompanyFunding(ctx, intent)).rejects.toThrow('socket lost')
    await expect(requestMatrixCompanyFunding(ctx, { ...intent, protons: 41 })).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json(fund))
    await expect(requestMatrixCompanyFunding(ctx, intent)).resolves.toEqual(fund)
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('a 200 it cannot validate is an unknown outcome: the intent stays and only the same request retries', async () => {
    const fund = json<Record<string, unknown>>('fixtures/fund.response.json')

    for (const wrong of [
      { ...fund, requestId: companyId },
      { ...fund, protons: 41, amountMicroProtons: 41_000_000, fromPaidMicroProtons: 11_000_000 },
      { ...fund, fromPaidMicroProtons: 11_000_000 },
      'not json at all'
    ]) {
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(wrong))
      vi.stubGlobal('fetch', fetcher)
      const ctx = context()

      await expect(requestMatrixCompanyFunding(ctx, intent)).rejects.toMatchObject({
        code: 'unavailable',
        errorCode: 'unconfirmed'
      })
      expect(ctx.journal.read(ctx.scope), JSON.stringify(wrong)).not.toBeNull()
      await expect(requestMatrixCompanyFunding(ctx, { ...intent, requestId: companyId })).rejects.toMatchObject({
        code: 'conflict'
      })
      expect(fetcher).toHaveBeenCalledTimes(1)

      fetcher.mockResolvedValueOnce(Response.json(fund))
      await expect(requestMatrixCompanyFunding(ctx, intent)).resolves.toEqual(fund)
      expect(ctx.journal.read(ctx.scope)).toBeNull()
    }
  })

  it('reads the unresolved transfer back from the journal without any network call', async () => {
    const fund = json<Record<string, unknown>>('fixtures/fund.response.json')
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()
    const pending = { action: 'funding-member-fund-pending' as const, companyId }

    await expect(requestMatrixCompanyFunding(ctx, pending)).resolves.toEqual({ pending: null })
    await expect(requestMatrixCompanyFunding(ctx, intent)).rejects.toThrow('socket lost')
    await expect(requestMatrixCompanyFunding(ctx, pending)).resolves.toEqual({
      pending: { requestId, protons: 40 }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json(fund))
    await requestMatrixCompanyFunding(ctx, intent)
    await expect(requestMatrixCompanyFunding(ctx, pending)).resolves.toEqual({ pending: null })
  })

  it('an unresolved order is not offered as a transfer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('socket lost')))
    const ctx = context()

    await expect(
      requestMatrixCompanyFunding(ctx, {
        action: 'funding-order-create',
        companyId,
        requestId,
        packId: 'protons-100k'
      })
    ).rejects.toThrow('socket lost')
    await expect(
      requestMatrixCompanyFunding(ctx, { action: 'funding-member-fund-pending', companyId })
    ).resolves.toEqual({ pending: null })
  })

  it('a member 403 is the typed member refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(Response.json(json('fixtures/fund-member-denied.response.json'), { status: 403 }))
    )

    await expect(requestMatrixCompanyFunding(context(), intent)).rejects.toMatchObject({ code: 'denied', member: true })
  })
})

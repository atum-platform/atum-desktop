import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  MATRIX_COMPANY_FUNDING_WIRE_HEADER,
  MATRIX_COMPANY_FUNDING_WIRE_VALUE,
  matrixCompanyFundingRoute,
  MatrixCompanyProtonOrderSchema,
  MatrixCompanyProtonPackCatalogSchema,
  MatrixCompanyWalletSchema,
  parseMatrixCompanyFundingRequest
} from '../../shared/matrix-company-funding'

import { requestMatrixCompanyFunding } from './company-funding'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-funding-v2')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-61b0206ddea9'
const requestId = '00000000-0000-4000-8000-0e9205f48dc5'
const orderId = '00000000-0000-4000-8000-2f5656bb7927'
const packId = 'protons-100k'

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

function context(overrides: Partial<Parameters<typeof requestMatrixCompanyFunding>[0]> = {}) {
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
    },
    ...overrides
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('vendored company funding native contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; sha256: string; commit: string; path: string }>('VENDORED.json')

  it('pins the exact frozen pack bytes and platform commit', () => {
    expect(vendored.contract).toBe('atum.company-funding/2')
    expect(vendored.path).toBe('spec/company-funding/v2')
    expect(vendored.commit).toBe('6adad50a4c72f0686d8fa3522d75256734084cce')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts wallet, packs and order fixtures with their equations', () => {
    expect(MatrixCompanyWalletSchema.parse(json('fixtures/wallet.response.json'))).toEqual(
      json('fixtures/wallet.response.json')
    )
    expect(MatrixCompanyProtonPackCatalogSchema.parse(json('fixtures/packs.response.json'))).toEqual(
      json('fixtures/packs.response.json')
    )
    expect(MatrixCompanyProtonOrderSchema.parse(json('fixtures/order.response.json'))).toEqual(
      json('fixtures/order.response.json')
    )
  })

  it('rejects a wallet that does not satisfy available = funded - held', () => {
    expect(() => MatrixCompanyWalletSchema.parse(json('fixtures/wallet-bad-available.response.json'))).toThrow()
  })

  it('refuses client authority, payer and money fields', () => {
    expect(() =>
      parseMatrixCompanyFundingRequest({
        action: 'funding-order-create',
        companyId,
        requestId,
        packId,
        purchasedBy: companyId,
        amountVnd: 1
      })
    ).toThrow('invalid')
  })

  it('names only the four owner/admin routes and selects wire 2', () => {
    expect(matrixCompanyFundingRoute({ action: 'funding-wallet', companyId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/wallet`
    })
    expect(matrixCompanyFundingRoute({ action: 'funding-packs', companyId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/wallet/packs`
    })
    expect(matrixCompanyFundingRoute({ action: 'funding-order-create', companyId, requestId, packId })).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/wallet/orders`,
      body: { schemaVersion: 2, requestId, packId }
    })
    expect(matrixCompanyFundingRoute({ action: 'funding-order', companyId, orderId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/wallet/orders/${orderId}`
    })
    expect(MATRIX_COMPANY_FUNDING_WIRE_HEADER).toBe('X-Atum-Company-Funding')
    expect(MATRIX_COMPANY_FUNDING_WIRE_VALUE).toBe('2')
  })
})

describe('native company funding client', () => {
  it('sends wire 2 and the exact order body, then echoes the created order', async () => {
    const order = json<Record<string, unknown>>('fixtures/order.response.json')
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(order))
    vi.stubGlobal('fetch', fetcher)

    await expect(
      requestMatrixCompanyFunding(context(), {
        action: 'funding-order-create',
        companyId,
        requestId,
        packId
      })
    ).resolves.toEqual(order)
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.test/api/matrix/v1/companies/${companyId}/wallet/orders`)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Atum-Company-Funding': '2' }),
      body: JSON.stringify({ schemaVersion: 2, requestId, packId })
    })
  })

  it('turns a member 403 into a typed refusal and never returns balances', async () => {
    const wallet = json<Record<string, unknown>>('fixtures/wallet.response.json')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(wallet, { status: 403 })))

    const result = requestMatrixCompanyFunding(context(), { action: 'funding-wallet', companyId })

    await expect(result).rejects.toMatchObject({
      code: 'denied',
      name: 'MatrixCompanyFundingMemberError',
      member: true
    })
    await expect(result).rejects.not.toHaveProperty('balances')
  })

  it('replays one uncertain order intent and conflicts a changed pack before I/O', async () => {
    const order = json<Record<string, unknown>>('fixtures/order.response.json')
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()
    const intent = { action: 'funding-order-create' as const, companyId, requestId, packId }

    await expect(requestMatrixCompanyFunding(ctx, intent)).rejects.toThrow('socket lost')
    await expect(
      requestMatrixCompanyFunding(ctx, {
        ...intent,
        packId: 'protons-500k'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json(order))
    await expect(requestMatrixCompanyFunding(ctx, intent)).resolves.toEqual(order)
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('drops a member-safe answer whose account fence moved during I/O', async () => {
    let current = true
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        current = false

        return Response.json(json('fixtures/wallet.response.json'))
      })
    )

    await expect(
      requestMatrixCompanyFunding(
        context({
          assertCurrent: () => {
            if (!current) {
              throw new Error('matrix_domain_cancelled')
            }
          }
        }),
        { action: 'funding-wallet', companyId }
      )
    ).rejects.toThrow('matrix_domain_cancelled')
  })

  it('rejects an order that echoes another company or another order id', async () => {
    const order = json<Record<string, unknown>>('fixtures/order.response.json')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ...order, companyId: 'x' })))
    await expect(
      requestMatrixCompanyFunding(context(), { action: 'funding-order', companyId, orderId })
    ).rejects.toMatchObject({ code: 'invalid' })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ...order,
          orderId: '00000000-0000-4000-8000-76b3bacc1035'
        })
      )
    )
    await expect(
      requestMatrixCompanyFunding(context(), { action: 'funding-order', companyId, orderId })
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MatrixCompanyAIConfigureSchema,
  matrixCompanyAIRoute,
  MatrixCompanyAITaskStopResponseSchema,
  MatrixCompanyAIViewSchema,
  matrixCompanyScope,
  parseMatrixCompanyAIRequest,
  parseMatrixCompanyAIResponse
} from '../../shared/matrix-company-ai'

import { requestMatrixCompanyAI } from './company-ai'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-ai-v1')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-887900f65a05'
const requestId = '00000000-0000-4000-8000-f3cb80828804'
const taskId = '00000000-0000-4000-8000-eb4362c069a7'
const foreignCompany = '00000000-0000-4000-8000-9d6eb487c79e'

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

function context(overrides: Partial<Parameters<typeof requestMatrixCompanyAI>[0]> = {}) {
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

describe('vendored company AI native contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; sha256: string; commit: string; path: string }>('VENDORED.json')

  it('pins the exact frozen pack bytes and platform commit', () => {
    expect(vendored.contract).toBe('atum.company-ai/1')
    expect(vendored.path).toBe('spec/company-ai/v1')
    expect(vendored.commit).toBe('6adad50a4c72f0686d8fa3522d75256734084cce')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts the frozen view, configuration and Stop fixtures', () => {
    const view = json('fixtures/ai-view.response.json')

    expect(MatrixCompanyAIViewSchema.parse(view)).toEqual(view)
    expect(MatrixCompanyAIConfigureSchema.parse(json('fixtures/configure.request.json'))).toEqual(
      json('fixtures/configure.request.json')
    )
    expect(MatrixCompanyAITaskStopResponseSchema.parse(json('fixtures/stop.response.json'))).toEqual(
      json('fixtures/stop.response.json')
    )
    expect(parseMatrixCompanyAIResponse(view, { action: 'company-ai-view', companyId })).toEqual(view)
  })

  it('refuses client authority and a company echo that is not the request', () => {
    expect(() =>
      parseMatrixCompanyAIRequest({
        action: 'company-ai-configure',
        companyId,
        requestId,
        expectedRevision: 1,
        enabled: false,
        actorId: foreignCompany
      })
    ).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyAIRequest({
        action: 'company-ai-stop',
        companyId,
        taskId,
        requestId,
        roomId: '!nope:atum.example'
      })
    ).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyAIResponse(
        { ...json<Record<string, unknown>>('fixtures/ai-view.response.json'), companyId: foreignCompany },
        { action: 'company-ai-view', companyId }
      )
    ).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyAIResponse(
        { ...json<Record<string, unknown>>('fixtures/stop.response.json'), taskId: foreignCompany },
        { action: 'company-ai-stop', companyId, taskId, requestId }
      )
    ).toThrow('invalid')
  })

  it('uses only the three frozen native routes and exact bodies', () => {
    expect(matrixCompanyAIRoute({ action: 'company-ai-view', companyId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/ai`
    })
    expect(
      matrixCompanyAIRoute({
        action: 'company-ai-configure',
        companyId,
        requestId,
        expectedRevision: 1,
        enabled: false
      })
    ).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/ai`,
      body: { schemaVersion: 1, requestId, expectedRevision: 1, enabled: false }
    })
    expect(matrixCompanyAIRoute({ action: 'company-ai-stop', companyId, taskId, requestId })).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/ai/tasks/${taskId}/stop`,
      body: { schemaVersion: 1, requestId }
    })
  })
})

describe('native company AI client', () => {
  const view = json<Record<string, unknown>>('fixtures/ai-view.response.json')

  it('replays one uncertain configure intent and conflicts a changed one before I/O', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    const intent = {
      action: 'company-ai-configure' as const,
      companyId,
      requestId,
      expectedRevision: 1,
      enabled: false
    }

    await expect(requestMatrixCompanyAI(ctx, intent)).rejects.toThrow('socket lost')
    await expect(requestMatrixCompanyAI(ctx, { ...intent, enabled: true })).rejects.toMatchObject({ code: 'conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json(view))
    await expect(requestMatrixCompanyAI(ctx, intent)).resolves.toEqual(view)
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('drops a stale answer when the account/company generation moved during I/O', async () => {
    let current = true

    const fetcher = vi.fn().mockImplementation(async () => {
      current = false

      return Response.json(view)
    })

    vi.stubGlobal('fetch', fetcher)

    await expect(
      requestMatrixCompanyAI(
        context({
          assertCurrent: () => {
            if (!current) {
              throw new Error('matrix_domain_cancelled')
            }
          }
        }),
        { action: 'company-ai-view', companyId }
      )
    ).rejects.toThrow('matrix_domain_cancelled')
  })

  it('keeps the mutation journal open across a lost response and closes it on a definitive refusal', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket lost'))
      .mockResolvedValueOnce(
        Response.json(
          {
            schemaVersion: 1,
            error: { code: 'denied' }
          },
          { status: 403 }
        )
      )

    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    await expect(
      requestMatrixCompanyAI(ctx, {
        action: 'company-ai-stop',
        companyId,
        taskId,
        requestId
      })
    ).rejects.toThrow('socket lost')
    expect(ctx.journal.read(ctx.scope)).not.toBeNull()
    await expect(
      requestMatrixCompanyAI(ctx, {
        action: 'company-ai-stop',
        companyId,
        taskId,
        requestId
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('never adopts another company error body or a non-JSON success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('nope', { status: 200 })))
    await expect(requestMatrixCompanyAI(context(), { action: 'company-ai-view', companyId })).rejects.toMatchObject({
      code: 'unavailable'
    })
  })
})

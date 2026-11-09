import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  MATRIX_COMPANY_PROJECT_BRAIN_BOARD_PIN,
  matrixCompanyBrainCitationAllowed,
  matrixCompanyBrainCitationAuthority,
  matrixCompanyBrainCorrectionAuthority,
  MatrixCompanyBrainCorrectionSchemaV4,
  MatrixCompanyBrainDocumentSchema,
  matrixCompanyBrainFileCitations,
  matrixCompanyBrainRoute,
  matrixCompanyBrainTaskAuthority,
  MatrixCompanyBrainTaskRefSchema,
  parseMatrixCompanyBrainRequest,
  parseMatrixCompanyBrainResponse
} from '../../shared/matrix-company-project-brain'

import { requestMatrixCompanyBrain } from './company-project-brain'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-project-brain-v4')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-42eb2dd5dae7'
const projectId = '00000000-0000-4000-8000-bd674f59504c'
const decisionItemId = 'c'.repeat(64)
const requestId = '00000000-0000-4000-8000-6e19e97fb048'
const foreignCompany = '00000000-0000-4000-8000-0f21890fb04b'

const live = () => json<Record<string, unknown>>('fixtures/brain-live.response.json')

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

function context(overrides: Partial<Parameters<typeof requestMatrixCompanyBrain>[0]> = {}) {
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

describe('vendored company project brain v4 native contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; sha256: string; commit: string; path: string }>('VENDORED.json')

  it('pins the exact frozen pack bytes, platform commit and board dependency', () => {
    expect(vendored.contract).toBe('atum.company-project-brain/4')
    expect(vendored.path).toBe('spec/company-project-brain/v4')
    expect(vendored.commit).toBe('6adad50a4c72f0686d8fa3522d75256734084cce')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
    expect(MATRIX_COMPANY_PROJECT_BRAIN_BOARD_PIN).toBe(
      'c25d852fe2e591442265c6866edf0ef3fed2d3047fd9db096011f3ec328af689'
    )
  })

  it('accepts current content and pending markers with no prose', () => {
    const current = MatrixCompanyBrainDocumentSchema.parse(live())
    expect('brief' in current).toBe(true)
    expect(MatrixCompanyBrainDocumentSchema.parse(json('fixtures/brain-pending.response.json'))).not.toHaveProperty(
      'brief'
    )
  })

  it('withholds stale prose and hidden task counts', () => {
    expect(() => MatrixCompanyBrainDocumentSchema.parse(json('fixtures/brain-stale-leak.response.json'))).toThrow()
    expect(() => MatrixCompanyBrainDocumentSchema.parse(json('fixtures/brain-hidden-count.response.json'))).toThrow()
  })

  it('accepts only decision/open-question corrections, never a task correction', () => {
    expect(MatrixCompanyBrainCorrectionSchemaV4.parse(json('fixtures/correction.request.json'))).toEqual(
      json('fixtures/correction.request.json')
    )
    expect(() => MatrixCompanyBrainCorrectionSchemaV4.parse(json('fixtures/correction-task.request.json'))).toThrow()
  })

  it('uses the three frozen native routes and exact correction body', () => {
    const base = MatrixCompanyBrainDocumentSchema.parse(live())

    expect(matrixCompanyBrainRoute({ action: 'brain-read', companyId, projectId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/projects/${projectId}/brain`
    })
    expect(
      matrixCompanyBrainRoute({
        action: 'brain-open-task',
        companyId,
        projectId,
        base,
        cardId: '00000000-0000-4000-8000-1794b62d2fb7'
      })
    ).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/projects/${projectId}/brain/tasks/00000000-0000-4000-8000-1794b62d2fb7`
    })
    expect(
      matrixCompanyBrainRoute({
        action: 'brain-correct',
        companyId,
        projectId,
        base,
        requestId,
        expectedBriefVersion: 1,
        expectedBoardRevision: 4,
        expectedSourceGeneration: 3,
        targetKind: 'decision',
        targetItemId: decisionItemId,
        text: 'Corrected.'
      })
    ).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/projects/${projectId}/brain/corrections`,
      body: {
        schemaVersion: 4,
        requestId,
        expectedBriefVersion: 1,
        expectedBoardRevision: 4,
        expectedSourceGeneration: 3,
        targetKind: 'decision',
        targetItemId: decisionItemId,
        text: 'Corrected.'
      }
    })
  })
})

describe('brain citation and correction authority', () => {
  it('exposes only the sources the authorized document actually cites', () => {
    const authority = matrixCompanyBrainCitationAuthority(MatrixCompanyBrainDocumentSchema.parse(live()))
    expect([...authority.sourceIds]).toEqual(['00000000-0000-4000-8000-7c028b2713e7'])
    expect([...authority.channelIds]).toEqual(['00000000-0000-4000-8000-4cfbbb6ffbd2'])
    expect(authority.companyId).toBe(companyId)
  })

  it('rejects a file citation from another company after I/O', () => {
    const document = live()
    const decision = (document.brief as Record<string, unknown>).decisions as Array<Record<string, unknown>>
    decision[0] = {
      ...decision[0],
      citation: {
        kind: 'company_file',
        sourceId: '00000000-0000-4000-8000-7c028b2713e7',
        channelId: '00000000-0000-4000-8000-4cfbbb6ffbd2',
        file: {
          v: 1,
          company_id: foreignCompany,
          channel_id: '00000000-0000-4000-8000-4cfbbb6ffbd2',
          file_id: '00000000-0000-4000-8000-23ba7c7aa2b2',
          revision: 1,
          name: 'plan.md',
          content_type: 'text/markdown',
          size: 12,
          sha256: 'a'.repeat(64)
        }
      }
    }

    expect(() => parseMatrixCompanyBrainResponse(document, { action: 'brain-read', companyId, projectId })).toThrow(
      'invalid'
    )
  })

  it('carries a v2 protected file ref and exposes it only inside its channel audience', () => {
    const document = live()

    const fileCitation = {
      kind: 'company_file' as const,
      sourceId: '00000000-0000-4000-8000-55fd29d9f718',
      channelId: '00000000-0000-4000-8000-4cfbbb6ffbd2',
      file: {
        v: 2 as const,
        company_id: companyId,
        audience: {
          kind: 'channel' as const,
          channel_id: '00000000-0000-4000-8000-4cfbbb6ffbd2',
          visibility: 'public' as const
        },
        file_id: '00000000-0000-4000-8000-5fe2a95d2dfe',
        revision: 1 as const,
        name: 'plan.md',
        content_type: 'text/markdown',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    }

    ;(document.brief as Record<string, unknown>).fileNotes = [
      {
        itemId: 'e'.repeat(64),
        excerpt: 'The plan is in the file.',
        citation: fileCitation,
        assertion: 'source'
      }
    ]

    const parsed = MatrixCompanyBrainDocumentSchema.parse(document)
    const authority = matrixCompanyBrainCitationAuthority(parsed)

    expect(matrixCompanyBrainFileCitations(parsed)).toEqual([fileCitation])
    expect(matrixCompanyBrainCitationAllowed(authority, fileCitation)).toBe(true)
    expect(
      matrixCompanyBrainCitationAllowed(authority, {
        ...fileCitation,
        channelId: '00000000-0000-4000-8000-0f21890fb04b'
      })
    ).toBe(false)
  })

  it('checks the correction target and generations against the displayed document before I/O', () => {
    const base = MatrixCompanyBrainDocumentSchema.parse(live())

    const input = {
      action: 'brain-correct' as const,
      companyId,
      projectId,
      base,
      requestId,
      expectedBriefVersion: 1,
      expectedBoardRevision: 4,
      expectedSourceGeneration: 3,
      targetKind: 'decision' as const,
      targetItemId: decisionItemId,
      text: 'Corrected.'
    }

    expect(() => matrixCompanyBrainCorrectionAuthority(base, input)).not.toThrow()
    expect(() =>
      matrixCompanyBrainCorrectionAuthority(base, {
        ...input,
        targetItemId: 'd'.repeat(64)
      })
    ).toThrow('invalid')
    expect(() =>
      matrixCompanyBrainCorrectionAuthority(base, {
        ...input,
        expectedSourceGeneration: 4
      })
    ).toThrow('invalid')
    expect(() =>
      parseMatrixCompanyBrainRequest({
        ...input,
        actor: 'forbidden'
      })
    ).toThrow('invalid')
  })

  it('opens only a card the displayed document cited', () => {
    const base = MatrixCompanyBrainDocumentSchema.parse(live())
    const cardId = '00000000-0000-4000-8000-1794b62d2fb7'

    expect(matrixCompanyBrainTaskAuthority(base, { companyId, projectId, cardId })).toMatchObject({
      cardId,
      accepted: true
    })
    expect(() =>
      matrixCompanyBrainTaskAuthority(base, {
        companyId,
        projectId,
        cardId: '00000000-0000-4000-8000-0b74b34affab'
      })
    ).toThrow('invalid')
  })
})

describe('native project brain client', () => {
  it('replays one uncertain correction and conflicts changed text before I/O', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    const input = {
      action: 'brain-correct' as const,
      companyId,
      projectId,
      base: MatrixCompanyBrainDocumentSchema.parse(live()),
      requestId,
      expectedBriefVersion: 1,
      expectedBoardRevision: 4,
      expectedSourceGeneration: 3,
      targetKind: 'decision' as const,
      targetItemId: decisionItemId,
      text: 'Corrected.'
    }

    await expect(requestMatrixCompanyBrain(ctx, input)).rejects.toThrow('socket lost')
    await expect(requestMatrixCompanyBrain(ctx, { ...input, text: 'Different.' })).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json(live()))
    await expect(requestMatrixCompanyBrain(ctx, input)).resolves.toMatchObject({ schemaVersion: 4 })
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('rejects a correction whose target is not in the displayed document without a network call', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    await expect(
      requestMatrixCompanyBrain(context(), {
        action: 'brain-correct',
        companyId,
        projectId,
        base: MatrixCompanyBrainDocumentSchema.parse(live()),
        requestId,
        expectedBriefVersion: 1,
        expectedBoardRevision: 4,
        expectedSourceGeneration: 3,
        targetKind: 'decision',
        targetItemId: 'd'.repeat(64),
        text: 'Corrected.'
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps an uncertain correction open when the account fence moves during I/O', async () => {
    let current = true
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        current = false

        return Response.json(live())
      })
    )

    const ctx = context({
      assertCurrent: () => {
        if (!current) {
          throw new Error('matrix_domain_cancelled')
        }
      }
    })

    await expect(
      requestMatrixCompanyBrain(ctx, {
        action: 'brain-correct',
        companyId,
        projectId,
        base: MatrixCompanyBrainDocumentSchema.parse(live()),
        requestId,
        expectedBriefVersion: 1,
        expectedBoardRevision: 4,
        expectedSourceGeneration: 3,
        targetKind: 'decision',
        targetItemId: decisionItemId,
        text: 'Corrected.'
      })
    ).rejects.toThrow('matrix_domain_cancelled')
    expect(ctx.journal.read(ctx.scope)).not.toBeNull()
  })

  it('returns only a cited task and rejects a preview that names another card', async () => {
    const base = MatrixCompanyBrainDocumentSchema.parse(live())
    const cardId = '00000000-0000-4000-8000-1794b62d2fb7'
    const task = json('fixtures/brain-live.response.json') as Record<string, unknown>

    const accepted = ((task.brief as Record<string, unknown>).tasks as Record<string, unknown>).accepted as Array<
      Record<string, unknown>
    >

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(Response.json(MatrixCompanyBrainTaskRefSchema.parse(accepted[0])))
    )
    await expect(
      requestMatrixCompanyBrain(context(), {
        action: 'brain-open-task',
        companyId,
        projectId,
        base,
        cardId
      })
    ).resolves.toMatchObject({ cardId })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ...MatrixCompanyBrainTaskRefSchema.parse(accepted[0]),
          cardId: '00000000-0000-4000-8000-0b74b34affab'
        })
      )
    )
    await expect(
      requestMatrixCompanyBrain(context(), {
        action: 'brain-open-task',
        companyId,
        projectId,
        base,
        cardId
      })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects a brain document echoed for another company or project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ...live(), companyId: foreignCompany })))
    await expect(
      requestMatrixCompanyBrain(context(), { action: 'brain-read', companyId, projectId })
    ).rejects.toMatchObject({ code: 'invalid' })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ...live(),
          projectId: '00000000-0000-4000-8000-0f21890fb04b'
        })
      )
    )
    await expect(
      requestMatrixCompanyBrain(context(), { action: 'brain-read', companyId, projectId })
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

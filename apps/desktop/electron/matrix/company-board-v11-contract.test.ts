import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  matrixCompanyBoardNegotiatedRoute,
  parseMatrixCompanyBoardV11Response
} from '../../shared/matrix-company-board-negotiated'
import {
  MatrixCompanyBoardActivityPageV11Schema,
  MatrixCompanyBoardCardV11Schema,
  MatrixCompanyBoardCommandResultV11Schema,
  MatrixCompanyBoardCommandV11Schema,
  MatrixCompanyBoardPageV11Schema,
  MatrixCompanyBoardSearchPageV11Schema
} from '../../shared/matrix-company-board-v11'

import { requestMatrixCompanyBoard } from './company-board'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-board-v1.1')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-3fff02fcbe73'
const cardId = '00000000-0000-4000-8000-1794b62d2fb7'

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

describe('vendored company board 1.1 contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; sha256: string; commit: string; path: string }>('VENDORED.json')

  it('pins the exact additive pack bytes and platform commit', () => {
    expect(vendored).toEqual({
      publicationStatus: 'sanitised public pack; historical acceptance not applicable',
      contract: 'atum.company-board/1.1',
      repository: 'https://github.com/atum-platform/atum-platform.git',
      commit: '297eb1585cf4c99dccf872c11b3c4675102bddad',
      path: 'spec/company-board/v1.1',
      sha256: '25afcf932966ca78fbe43ef4699691749b888fac7aff5ced3f68871142bab767'
    })
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts the native card, page, search, activity and command fixtures', () => {
    expect(MatrixCompanyBoardCardV11Schema.parse(json('fixtures/card.response.json')).priority).toBe('high')
    expect(MatrixCompanyBoardPageV11Schema.parse(json('fixtures/page.response.json')).cards).toHaveLength(0)
    expect(MatrixCompanyBoardSearchPageV11Schema.parse(json('fixtures/search.response.json')).results).toHaveLength(1)
    expect(MatrixCompanyBoardActivityPageV11Schema.parse(json('fixtures/activity.response.json')).events).toHaveLength(1)

    for (const fixture of ['checklist.request.json', 'attachment.request.json', 'patch-priority.request.json', 'undo.request.json']) {
      expect(MatrixCompanyBoardCommandV11Schema.parse(json(`fixtures/${fixture}`)), fixture).toEqual(
        json(`fixtures/${fixture}`)
      )
    }
  })

  it('rejects drifted priority, checklist order, unknown command authority and an incoherent conflict', () => {
    expect(() => MatrixCompanyBoardCommandV11Schema.parse(json('fixtures/priority-enum.request.json'))).toThrow()
    expect(() => MatrixCompanyBoardCommandV11Schema.parse(json('fixtures/checklist-order-bound.request.json'))).toThrow()
    expect(() => MatrixCompanyBoardCommandV11Schema.parse(json('fixtures/unknown-field.request.json'))).toThrow()
    expect(() => MatrixCompanyBoardCommandResultV11Schema.parse(json('fixtures/stale-conflict-invalid.response.json'))).toThrow()
  })

  it('maps the negotiated search and activity routes without placing the profile in the body', () => {
    expect(matrixCompanyBoardNegotiatedRoute({
      action: 'board-search-v11',
      companyId,
      query: 'launch',
      cursor: null,
      projectId: null,
      ownerMemberRef: null,
      due: 'all',
      includeArchived: false
    })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/board/search?due=all&includeArchived=false&query=launch&limit=50&fields=title%2Cdescription%2Cchecklist_text`,
      headers: { 'X-Atum-Company-Board': '1.1' }
    })
    expect(matrixCompanyBoardNegotiatedRoute({
      action: 'board-activity-v11',
      companyId,
      cardId,
      cursor: 'YWN0aXZpdHk6Mg'
    })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/board/cards/${cardId}/activity?limit=100&cursor=YWN0aXZpdHk6Mg`,
      headers: { 'X-Atum-Company-Board': '1.1' }
    })
  })

  it('recovers a stale command from the authorized current card projection', () => {
    const conflict = parseMatrixCompanyBoardV11Response(json('fixtures/stale-conflict.response.json'), {
      action: 'board-command-v11',
      companyId,
      command: json('fixtures/patch-priority.request.json')
    })

    expect(conflict).toMatchObject({
      state: 'conflict',
      cardId,
      currentCardRevision: 6,
      currentCard: { cardId, revision: 6 }
    })
  })
})

describe('company board 1.1 negotiation', () => {
  it('sends the 1.1 profile and adopts a valid extended card', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(json('fixtures/card.response.json')))
    vi.stubGlobal('fetch', fetcher)

    await expect(requestMatrixCompanyBoard(context(), {
      action: 'board-card-v11',
      companyId,
      cardId
    })).resolves.toMatchObject({ negotiatedProfile: '1.1', value: { cardId, priority: 'high' } })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'X-Atum-Company-Board': '1.1' })
    })
  })

  it('retries a compatible list without the header when the platform refuses 1.1', async () => {
    const legacy = json('../atum-company-board-v1/fixtures/page-empty.response.json')
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 426 }))
      .mockResolvedValueOnce(Response.json(legacy))
    vi.stubGlobal('fetch', fetcher)

    await expect(requestMatrixCompanyBoard(context(), {
      action: 'board-list-v11',
      companyId,
      cursor: null,
      projectId: null,
      ownerMemberRef: null,
      due: 'all',
      includeArchived: false
    })).resolves.toMatchObject({ negotiatedProfile: '1', value: { cards: [] } })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'X-Atum-Company-Board': '1.1' })
    })
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.not.objectContaining({
      'X-Atum-Company-Board': expect.anything()
    }) })
  })
})

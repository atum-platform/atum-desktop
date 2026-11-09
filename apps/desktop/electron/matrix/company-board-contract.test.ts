import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import {
  MATRIX_COMPANY_BOARD_COLUMNS,
  MatrixCompanyBoardCardSchema,
  MatrixCompanyBoardCommandSchema,
  MatrixCompanyBoardPageSchema,
  matrixCompanyBoardRoute,
  MatrixCompanyBoardViewSchema,
  parseMatrixCompanyBoardRequest,
  parseMatrixCompanyBoardResponse
} from '../../shared/matrix-company-board'

import { requestMatrixCompanyBoard } from './company-board'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-board-v1')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

const companyId = '00000000-0000-4000-8000-3fff02fcbe73'
const boardId = '00000000-0000-4000-8000-320ce5ad961c'
const cardId = '00000000-0000-4000-8000-1794b62d2fb7'
const requestId = '00000000-0000-4000-8000-7487b628e7ea'
const foreignCompany = '00000000-0000-4000-8000-0b74b34affab'

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

function context(overrides: Partial<Parameters<typeof requestMatrixCompanyBoard>[0]> = {}) {
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

describe('vendored company board native contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; sha256: string; commit: string; path: string }>('VENDORED.json')

  it('pins the exact frozen pack bytes and platform commit', () => {
    expect(vendored.contract).toBe('atum.company-board/1')
    expect(vendored.path).toBe('spec/company-board/v1')
    expect(vendored.commit).toBe('6adad50a4c72f0686d8fa3522d75256734084cce')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts the five fixed columns, the page and both human/CoS cards', () => {
    expect(MATRIX_COMPANY_BOARD_COLUMNS).toEqual(['suggested', 'to_do', 'in_progress', 'blocked', 'done'])
    expect(MatrixCompanyBoardViewSchema.parse(json('fixtures/board.response.json')).columns).toEqual(
      MATRIX_COMPANY_BOARD_COLUMNS
    )
    expect(MatrixCompanyBoardPageSchema.parse(json('fixtures/page-empty.response.json')).cards).toEqual([])
    expect(MatrixCompanyBoardCardSchema.parse(json('fixtures/card-human.response.json')).status).toBe('to_do')
    expect(MatrixCompanyBoardCardSchema.parse(json('fixtures/card-cos-suggested.response.json'))).toMatchObject({
      status: 'suggested',
      accepted: false,
      canAccept: true
    })
  })

  it('accepts all five commands and rejects client authority', () => {
    for (const fixture of [
      'create.request.json',
      'patch.request.json',
      'accept.request.json',
      'archive.request.json',
      'undo.request.json'
    ]) {
      expect(MatrixCompanyBoardCommandSchema.parse(json(`fixtures/${fixture}`)), fixture).toEqual(
        json(`fixtures/${fixture}`)
      )
    }

    expect(() => MatrixCompanyBoardCommandSchema.parse(json('fixtures/command-authority.request.json'))).toThrow()
  })

  it('rejects a sibling-channel citation and a wrong-company card echo', () => {
    expect(() => MatrixCompanyBoardCardSchema.parse(json('fixtures/card-sibling-leak.response.json'))).toThrow()

    const card = json<Record<string, unknown>>('fixtures/card-human.response.json')
    expect(() =>
      parseMatrixCompanyBoardResponse(
        { ...card, companyId: foreignCompany },
        {
          action: 'board-card',
          companyId,
          cardId
        }
      )
    ).toThrow('invalid')
  })

  it('rejects a file citation that belongs to another company', () => {
    const cardWithFile = {
      ...json<Record<string, unknown>>('fixtures/card-human.response.json'),
      citations: [
        {
          kind: 'company_file',
          sourceId: '00000000-0000-4000-8000-c7ab25c39832',
          channelId: '00000000-0000-4000-8000-3c569570ff7d',
          file: {
            v: 1,
            company_id: foreignCompany,
            channel_id: '00000000-0000-4000-8000-3c569570ff7d',
            file_id: '00000000-0000-4000-8000-c67bdba39cea',
            revision: 1,
            name: 'brief.md',
            content_type: 'text/markdown',
            size: 10,
            sha256: 'a'.repeat(64)
          }
        }
      ]
    }

    expect(() => MatrixCompanyBoardCardSchema.parse(cardWithFile)).toThrow()
  })

  it('uses the frozen list/card/command routes and exact command body', () => {
    expect(
      matrixCompanyBoardRoute({
        action: 'board-view',
        companyId
      })
    ).toEqual({ method: 'GET', path: `/companies/${companyId}/board/revision` })
    expect(
      matrixCompanyBoardRoute({
        action: 'board-list',
        companyId,
        cursor: null,
        projectId: null,
        ownerMemberRef: null,
        due: 'all',
        includeArchived: false
      })
    ).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/board?due=all&includeArchived=false`
    })
    expect(matrixCompanyBoardRoute({ action: 'board-card', companyId, cardId })).toEqual({
      method: 'GET',
      path: `/companies/${companyId}/board/cards/${cardId}`
    })
    expect(
      matrixCompanyBoardRoute({
        action: 'board-command',
        companyId,
        command: {
          schemaVersion: 1,
          requestId,
          operation: 'patch',
          cardId,
          expectedCardRevision: 3,
          patch: { status: 'in_progress' }
        }
      })
    ).toEqual({
      method: 'POST',
      path: `/companies/${companyId}/board/commands`,
      body: {
        schemaVersion: 1,
        requestId,
        operation: 'patch',
        cardId,
        expectedCardRevision: 3,
        patch: { status: 'in_progress' }
      }
    })
  })
})

describe('native company board client', () => {
  const card = json<Record<string, unknown>>('fixtures/card-human.response.json')

  const command = {
    schemaVersion: 1 as const,
    requestId,
    operation: 'patch' as const,
    cardId,
    expectedCardRevision: 3,
    patch: { status: 'in_progress' as const }
  }

  it('replays one uncertain command and conflicts a changed command under the same request id', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('socket lost'))
    vi.stubGlobal('fetch', fetcher)
    const ctx = context()

    await expect(requestMatrixCompanyBoard(ctx, { action: 'board-command', companyId, command })).rejects.toThrow(
      'socket lost'
    )
    await expect(
      requestMatrixCompanyBoard(ctx, {
        action: 'board-command',
        companyId,
        command: { ...command, patch: { status: 'blocked' } }
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockResolvedValueOnce(Response.json({ schemaVersion: 1, duplicate: false, card }))
    await expect(
      requestMatrixCompanyBoard(ctx, { action: 'board-command', companyId, command })
    ).resolves.toMatchObject({ duplicate: false })
    expect(ctx.journal.read(ctx.scope)).toBeNull()
  })

  it('never adopts a stale page after the account fence moved', async () => {
    let current = true
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        current = false

        return Response.json(json('fixtures/page-empty.response.json'))
      })
    )

    await expect(
      requestMatrixCompanyBoard(
        context({
          assertCurrent: () => {
            if (!current) {
              throw new Error('matrix_domain_cancelled')
            }
          }
        }),
        {
          action: 'board-list',
          companyId,
          cursor: null,
          projectId: null,
          ownerMemberRef: null,
          due: 'all',
          includeArchived: false
        }
      )
    ).rejects.toThrow('matrix_domain_cancelled')
  })

  it('rejects a card from another board in a filtered page', async () => {
    const page = json<Record<string, unknown>>('fixtures/page-empty.response.json')
    const foreign = { ...card, companyId: foreignCompany }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ...page,
          cards: [foreign]
        })
      )
    )

    await expect(
      requestMatrixCompanyBoard(context(), {
        action: 'board-list',
        companyId,
        cursor: null,
        projectId: null,
        ownerMemberRef: null,
        due: 'all',
        includeArchived: false
      })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects a command response whose card is not the commanded card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          schemaVersion: 1,
          duplicate: false,
          card: { ...card, cardId: '00000000-0000-4000-8000-0b74b34affab' }
        })
      )
    )

    await expect(
      requestMatrixCompanyBoard(context(), { action: 'board-command', companyId, command })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('accepts the frozen command response fixture', () => {
    expect(
      parseMatrixCompanyBoardResponse(json('fixtures/command.response.json'), {
        action: 'board-command',
        companyId,
        command: {
          schemaVersion: 1,
          requestId,
          operation: 'accept',
          cardId: '00000000-0000-4000-8000-d5f592efccbc',
          expectedCardRevision: 1,
          status: 'to_do'
        }
      })
    ).toEqual(json('fixtures/command.response.json'))
  })

  it('keeps board id authority with the page board', () => {
    const page = json<Record<string, unknown>>('fixtures/page-empty.response.json')
    expect(boardId).toBe((page.board as Record<string, unknown>).boardId)
    expect(
      parseMatrixCompanyBoardRequest({
        action: 'board-card',
        companyId,
        cardId
      })
    ).toEqual({ action: 'board-card', companyId, cardId })
  })
})

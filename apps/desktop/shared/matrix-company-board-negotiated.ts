import { z } from 'zod'

import { MatrixCompanyNativeError } from './matrix-company-ai'
import {
  isMatrixCompanyBoardMutation,
  matrixCompanyBoardCardAuthority,
  type MatrixCompanyBoardCommand,
  MatrixCompanyBoardCommandSchema,
  type MatrixCompanyBoardRequest,
  MatrixCompanyBoardRequestSchema,
  type MatrixCompanyBoardRoute,
  matrixCompanyBoardRoute,
  type MatrixCompanyBoardValue,
  parseMatrixCompanyBoardResponse
} from './matrix-company-board'
import {
  MATRIX_COMPANY_BOARD_LIMITS_V11,
  MATRIX_COMPANY_BOARD_SEARCH_FIELDS_V11,
  MATRIX_COMPANY_BOARD_WIRE_VALUE_V11,
  MatrixCompanyBoardActivityPageV11Schema,
  MatrixCompanyBoardCardV11Schema,
  MatrixCompanyBoardCommandResultV11Schema,
  MatrixCompanyBoardCommandV11Schema,
  MatrixCompanyBoardPageV11Schema,
  MatrixCompanyBoardSearchPageV11Schema
} from './matrix-company-board-v11'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u)
const memberRef = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u)

export const MatrixCompanyBoardRequestV11Schema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('board-list-v11'),
      companyId: uuid,
      cursor: cursor.nullable(),
      projectId: uuid.nullable(),
      ownerMemberRef: memberRef.nullable(),
      due: z.enum(['all', 'due_soon', 'overdue', 'no_due']),
      includeArchived: z.boolean()
    })
    .strict(),
  z.object({ action: z.literal('board-card-v11'), companyId: uuid, cardId: uuid }).strict(),
  z
    .object({
      action: z.literal('board-search-v11'),
      companyId: uuid,
      query: z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS_V11.searchQueryCharacters),
      cursor: cursor.nullable(),
      projectId: uuid.nullable(),
      ownerMemberRef: memberRef.nullable(),
      due: z.enum(['all', 'due_soon', 'overdue', 'no_due']),
      includeArchived: z.boolean()
    })
    .strict(),
  z
    .object({
      action: z.literal('board-activity-v11'),
      companyId: uuid,
      cardId: uuid,
      cursor: cursor.nullable()
    })
    .strict(),
  z
    .object({
      action: z.literal('board-command-v11'),
      companyId: uuid,
      command: MatrixCompanyBoardCommandV11Schema
    })
    .strict()
])

export type MatrixCompanyBoardRequestV11 = z.infer<typeof MatrixCompanyBoardRequestV11Schema>
export type MatrixCompanyBoardNegotiatedRequest = MatrixCompanyBoardRequest | MatrixCompanyBoardRequestV11
export type MatrixCompanyBoardMutationV11 = Extract<MatrixCompanyBoardRequestV11, { action: 'board-command-v11' }>

export type MatrixCompanyBoardValueV11 =
  | z.infer<typeof MatrixCompanyBoardPageV11Schema>
  | z.infer<typeof MatrixCompanyBoardCardV11Schema>
  | z.infer<typeof MatrixCompanyBoardSearchPageV11Schema>
  | z.infer<typeof MatrixCompanyBoardActivityPageV11Schema>
  | z.infer<typeof MatrixCompanyBoardCommandResultV11Schema>

export type MatrixCompanyBoardNegotiatedValue =
  | MatrixCompanyBoardValue
  | { negotiatedProfile: '1' | '1.1'; value: MatrixCompanyBoardValue | MatrixCompanyBoardValueV11 }

export function parseMatrixCompanyBoardNegotiatedRequest(value: unknown): MatrixCompanyBoardNegotiatedRequest {
  const base = MatrixCompanyBoardRequestSchema.safeParse(value)

  if (base.success) {
    return base.data
  }

  const extension = MatrixCompanyBoardRequestV11Schema.safeParse(value)

  if (!extension.success) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return extension.data
}

export function isMatrixCompanyBoardNegotiatedMutation(
  input: MatrixCompanyBoardNegotiatedRequest
): input is Extract<MatrixCompanyBoardNegotiatedRequest, { action: 'board-command' | 'board-command-v11' }> {
  return isMatrixCompanyBoardMutation(input as MatrixCompanyBoardRequest) || input.action === 'board-command-v11'
}

function queryBase(input: Extract<MatrixCompanyBoardRequestV11, { action: 'board-list-v11' | 'board-search-v11' }>) {
  const query = new URLSearchParams()
  query.set('due', input.due)
  query.set('includeArchived', String(input.includeArchived))

  if (input.cursor !== null) {
    query.set('cursor', input.cursor)
  }

  if (input.projectId !== null) {
    query.set('projectId', input.projectId)
  }

  if (input.ownerMemberRef !== null) {
    query.set('ownerMemberRef', input.ownerMemberRef)
  }

  return query
}

export function matrixCompanyBoardNegotiatedRoute(
  input: MatrixCompanyBoardNegotiatedRequest
): MatrixCompanyBoardRoute & { headers?: Readonly<Record<string, string>> } {
  if (!input.action.endsWith('-v11')) {
    return matrixCompanyBoardRoute(input as MatrixCompanyBoardRequest)
  }

  const base = `/companies/${input.companyId}/board`
  const headers = { 'X-Atum-Company-Board': MATRIX_COMPANY_BOARD_WIRE_VALUE_V11 }

  if (input.action === 'board-list-v11') {
    const query = queryBase(input)
    query.set('limit', '100')

    return { method: 'GET', path: `${base}?${query.toString()}`, headers }
  }

  if (input.action === 'board-card-v11') {
    return { method: 'GET', path: `${base}/cards/${input.cardId}`, headers }
  }

  if (input.action === 'board-search-v11') {
    const query = queryBase(input)
    query.set('query', input.query)
    query.set('limit', String(MATRIX_COMPANY_BOARD_LIMITS_V11.searchPageCards))
    query.set('fields', MATRIX_COMPANY_BOARD_SEARCH_FIELDS_V11.join(','))

    return { method: 'GET', path: `${base}/search?${query.toString()}`, headers }
  }

  if (input.action === 'board-activity-v11') {
    const query = new URLSearchParams({ limit: String(MATRIX_COMPANY_BOARD_LIMITS_V11.activityPageEvents) })

    if (input.cursor !== null) {
      query.set('cursor', input.cursor)
    }

    return { method: 'GET', path: `${base}/cards/${input.cardId}/activity?${query.toString()}`, headers }
  }

  const command = input as MatrixCompanyBoardMutationV11

  return { method: 'POST', path: `${base}/commands`, body: command.command, headers }
}

export function parseMatrixCompanyBoardV11Response(
  value: unknown,
  input: MatrixCompanyBoardRequestV11
): MatrixCompanyBoardValueV11 {
  if (input.action === 'board-list-v11') {
    const parsed = MatrixCompanyBoardPageV11Schema.safeParse(value)

    if (
      !parsed.success ||
      parsed.data.board.companyId !== input.companyId ||
      parsed.data.cards.some(card =>
        !matrixCompanyBoardCardAuthority(card, {
          companyId: input.companyId,
          boardId: parsed.data.board.boardId
        }))
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'board-card-v11') {
    const parsed = MatrixCompanyBoardCardV11Schema.safeParse(value)

    if (
      !parsed.success ||
      !matrixCompanyBoardCardAuthority(parsed.data, { companyId: input.companyId, cardId: input.cardId })
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'board-search-v11') {
    const parsed = MatrixCompanyBoardSearchPageV11Schema.safeParse(value)

    if (!parsed.success || parsed.data.board.companyId !== input.companyId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'board-activity-v11') {
    const parsed = MatrixCompanyBoardActivityPageV11Schema.safeParse(value)

    if (
      !parsed.success ||
      parsed.data.cardId !== input.cardId ||
      parsed.data.events.some(event => event.companyId !== input.companyId)
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  const parsed = MatrixCompanyBoardCommandResultV11Schema.safeParse(value)

  const card = parsed.success
    ? parsed.data.state === 'applied'
      ? parsed.data.card
      : parsed.data.currentCard
    : undefined

  if (!parsed.success || !card || !matrixCompanyBoardCardAuthority(card, {
    companyId: input.companyId,
    cardId: input.command.cardId
  })) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

/** Only reads and commands that are already valid `/1` operations may retry without 1.1. */
export function matrixCompanyBoardV1Fallback(
  input: MatrixCompanyBoardRequestV11
): MatrixCompanyBoardRequest | undefined {
  if (input.action === 'board-list-v11') {
    return { ...input, action: 'board-list' }
  }

  if (input.action === 'board-card-v11') {
    return { ...input, action: 'board-card' }
  }

  if (input.action === 'board-command-v11') {
    const command = MatrixCompanyBoardCommandSchema.safeParse(input.command)

    if (command.success) {
      return { action: 'board-command', companyId: input.companyId, command: command.data }
    }
  }

  return undefined
}

export function parseMatrixCompanyBoardFallbackResponse(
  value: unknown,
  input: MatrixCompanyBoardRequestV11
): MatrixCompanyBoardValue | undefined {
  const fallback = matrixCompanyBoardV1Fallback(input)

  if (!fallback) {
    return undefined
  }

  try {
    return parseMatrixCompanyBoardResponse(value, fallback)
  } catch {
    return undefined
  }
}

export function isMatrixCompanyBoardV1Command(command: unknown): command is MatrixCompanyBoardCommand {
  return MatrixCompanyBoardCommandSchema.safeParse(command).success
}

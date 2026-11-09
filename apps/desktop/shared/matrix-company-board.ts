import { z } from 'zod'

import {
  MatrixCompanyAICitationSchema,
  matrixCompanyAIFileCitationAuthority,
  MatrixCompanyNativeError
} from './matrix-company-ai'
import { companyBoardOwnershipIssue } from './matrix-company-board-ownership'

/**
 * D1 native consumer for `atum.company-board/1`.
 *
 * One master board per company with five fixed columns. Native commands are
 * closed to `create|patch|accept|archive|undo`; actor, origin, publication
 * scope, provenance, completion authority and board revisions are always
 * server-derived. Suggested cards are nonbinding and only an authorized human
 * can make a card Done.
 *
 * The desktop parser additionally enforces what the frozen pack leaves to the
 * server: every card belongs to the requested company and board, a file
 * citation stays inside its own company/channel audience, and a channel card
 * never carries a sibling-channel citation.
 */

export const MATRIX_COMPANY_BOARD_PROFILE = 'atum.company-board/1' as const
export const MATRIX_COMPANY_BOARD_SCHEMA_VERSION = 1 as const
export const MATRIX_COMPANY_BOARD_COLUMNS = ['suggested', 'to_do', 'in_progress', 'blocked', 'done'] as const

export const MATRIX_COMPANY_BOARD_LIMITS = Object.freeze({
  pageCards: 100,
  owners: 20,
  participants: 100,
  citations: 20,
  mutationChanges: 8,
  activity: 100,
  titleCharacters: 160,
  descriptionCharacters: 2_000
} as const)

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const eventId = z
  .string()
  .min(2)
  .max(512)
  .regex(/^\$[!-~]+$/u)
const memberRef = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)
const cursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u)
const displayKey = z.string().regex(/^tsk_[A-Za-z0-9_-]{8,32}$/u)
const title = z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS.titleCharacters)
const description = z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS.descriptionCharacters)
const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)), 'timestamp must be valid UTC RFC3339')
const ianaTimeZone = z
  .string()
  .min(3)
  .max(64)
  .refine(value => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })

      return true
    } catch {
      return false
    }
  }, 'timeZone must be an IANA zone')

export const MatrixCompanyBoardColumnSchema = z.enum(MATRIX_COMPANY_BOARD_COLUMNS)
export type MatrixCompanyBoardColumn = z.infer<typeof MatrixCompanyBoardColumnSchema>
export const MatrixCompanyBoardOriginSchema = z.enum(['human', 'cos'])

export const MatrixCompanyBoardDueSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('date'),
      date: z.iso.date(),
      timeZone: ianaTimeZone,
      originalText: z.string().min(1).max(160)
    })
    .strict(),
  z
    .object({
      kind: z.literal('instant'),
      at: utcTimestamp,
      timeZone: ianaTimeZone,
      originalText: z.string().min(1).max(160)
    })
    .strict()
])
export type MatrixCompanyBoardDue = z.infer<typeof MatrixCompanyBoardDueSchema>

export const MatrixCompanyBoardActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), memberRef }).strict(),
  z.object({ kind: z.literal('cos'), agentPrincipal: uuid }).strict()
])
export type MatrixCompanyBoardActor = z.infer<typeof MatrixCompanyBoardActorSchema>

export const MatrixCompanyBoardPublicationScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company') }).strict(),
  z
    .object({
      kind: z.literal('channel'),
      channelId: uuid,
      historyScope: z.literal('shared'),
      admissionGeneration: generation,
      scopeDigest: sha256
    })
    .strict()
])
export type MatrixCompanyBoardPublicationScope = z.infer<typeof MatrixCompanyBoardPublicationScopeSchema>

export const MatrixCompanyBoardProvenanceRefSchema = z.union([
  MatrixCompanyAICitationSchema,
  z.object({ kind: z.literal('board_event'), eventId: uuid, at: utcTimestamp }).strict()
])

export const MatrixCompanyBoardFieldProvenanceSchema = z
  .object({
    origin: MatrixCompanyBoardOriginSchema,
    actor: MatrixCompanyBoardActorSchema,
    at: utcTimestamp,
    references: z.array(MatrixCompanyBoardProvenanceRefSchema).min(1).max(MATRIX_COMPANY_BOARD_LIMITS.citations)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin !== value.actor.kind) {
      context.addIssue({ code: 'custom', path: ['origin'], message: 'field origin must match the recorded actor' })
    }
  })
export type MatrixCompanyBoardFieldProvenance = z.infer<typeof MatrixCompanyBoardFieldProvenanceSchema>

export const MatrixCompanyBoardConversationSchema = z
  .object({
    channelId: uuid,
    threadRootEventId: eventId
  })
  .strict()

export const MatrixCompanyBoardCardSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    companyId: uuid,
    boardId: uuid,
    cardId: uuid,
    displayKey,
    revision: generation,
    title,
    description: description.nullable(),
    status: MatrixCompanyBoardColumnSchema,
    accepted: z.boolean(),
    owners: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.owners),
    primaryOwner: memberRef.nullable(),
    participants: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.participants),
    due: MatrixCompanyBoardDueSchema.nullable(),
    projectId: uuid.nullable(),
    citations: z.array(MatrixCompanyAICitationSchema).max(MATRIX_COMPANY_BOARD_LIMITS.citations),
    conversation: MatrixCompanyBoardConversationSchema.nullable(),
    publicationScope: MatrixCompanyBoardPublicationScopeSchema,
    fieldProvenance: z
      .object({
        title: MatrixCompanyBoardFieldProvenanceSchema,
        description: MatrixCompanyBoardFieldProvenanceSchema.nullable(),
        owners: MatrixCompanyBoardFieldProvenanceSchema,
        due: MatrixCompanyBoardFieldProvenanceSchema,
        status: MatrixCompanyBoardFieldProvenanceSchema,
        projectTag: MatrixCompanyBoardFieldProvenanceSchema.nullable()
      })
      .strict(),
    origin: MatrixCompanyBoardOriginSchema,
    createdBy: MatrixCompanyBoardActorSchema,
    createdAt: utcTimestamp,
    updatedBy: MatrixCompanyBoardActorSchema,
    updatedAt: utcTimestamp,
    archived: z.boolean(),
    canEdit: z.boolean(),
    canPropose: z.boolean(),
    canAccept: z.boolean(),
    canArchive: z.boolean(),
    canUndo: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.owners).size !== value.owners.length ||
      new Set(value.participants).size !== value.participants.length
    ) {
      context.addIssue({ code: 'custom', path: ['owners'], message: 'member references must be unique' })
    }

    if (value.primaryOwner !== null && !value.owners.includes(value.primaryOwner)) {
      context.addIssue({ code: 'custom', path: ['primaryOwner'], message: 'primary owner must be an owner' })
    }

    if (value.accepted !== (value.status !== 'suggested')) {
      context.addIssue({ code: 'custom', path: ['accepted'], message: 'Suggested is the only nonbinding status' })
    }

    if (value.origin !== value.createdBy.kind) {
      context.addIssue({ code: 'custom', path: ['origin'], message: 'card origin must match its creator' })
    }

    if (value.publicationScope.kind === 'channel') {
      const scopeChannelId = value.publicationScope.channelId

      if (
        value.conversation === null ||
        value.conversation.channelId !== scopeChannelId ||
        value.citations.some(citation => citation.channelId !== scopeChannelId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['publicationScope'],
          message: 'channel cards stay inside one source publication audience'
        })
      }
    } else if (value.conversation !== null) {
      context.addIssue({
        code: 'custom',
        path: ['conversation'],
        message: 'source-less company cards have no channel discussion target'
      })
    }

    if (value.citations.some(citation => !matrixCompanyAIFileCitationAuthority(citation, value.companyId))) {
      context.addIssue({
        code: 'custom',
        path: ['citations'],
        message: 'file citations stay inside their own company and channel audience'
      })
    }
  })
export type MatrixCompanyBoardCard = z.infer<typeof MatrixCompanyBoardCardSchema>

export const MatrixCompanyBoardViewSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    companyId: uuid,
    boardId: uuid,
    revision: generation,
    columns: z.tuple(
      MATRIX_COMPANY_BOARD_COLUMNS.map(column => z.literal(column)) as [
        z.ZodLiteral<'suggested'>,
        z.ZodLiteral<'to_do'>,
        z.ZodLiteral<'in_progress'>,
        z.ZodLiteral<'blocked'>,
        z.ZodLiteral<'done'>
      ]
    )
  })
  .strict()
export type MatrixCompanyBoardView = z.infer<typeof MatrixCompanyBoardViewSchema>

export const MatrixCompanyBoardListSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    cursor: cursor.nullable(),
    projectId: uuid.nullable(),
    ownerMemberRef: memberRef.nullable(),
    due: z.enum(['all', 'due_soon', 'overdue', 'no_due']),
    includeArchived: z.boolean()
  })
  .strict()

export const MatrixCompanyBoardPageSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    board: MatrixCompanyBoardViewSchema,
    cards: z.array(MatrixCompanyBoardCardSchema).max(MATRIX_COMPANY_BOARD_LIMITS.pageCards),
    nextCursor: cursor.nullable()
  })
  .strict()
  .refine(
    value => new Set(value.cards.map(card => card.cardId)).size === value.cards.length,
    'card ids must be unique after permission filtering'
  )
export type MatrixCompanyBoardPage = z.infer<typeof MatrixCompanyBoardPageSchema>

export const MatrixCompanyBoardPatchSchema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    owners: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.owners).optional(),
    primaryOwner: memberRef.nullable().optional(),
    participants: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.participants).optional(),
    due: MatrixCompanyBoardDueSchema.nullable().optional(),
    status: MatrixCompanyBoardColumnSchema.optional(),
    projectId: uuid.nullable().optional()
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'patch must change at least one field')
  .superRefine((value, context) => {
    const issue = companyBoardOwnershipIssue(value)

    if (issue) {
      context.addIssue({ code: 'custom', path: ['owners'], message: issue })
    }
  })

const commandBase = { schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION), requestId: uuid }

export const MatrixCompanyBoardCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...commandBase,
      operation: z.literal('create'),
      cardId: uuid,
      title,
      projectId: uuid.nullable().optional()
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('patch'),
      cardId: uuid,
      expectedCardRevision: generation,
      patch: MatrixCompanyBoardPatchSchema
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('accept'),
      cardId: uuid,
      expectedCardRevision: generation,
      status: z.enum(['to_do', 'in_progress', 'blocked'])
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('archive'),
      cardId: uuid,
      expectedCardRevision: generation,
      archived: z.boolean()
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('undo'),
      cardId: uuid,
      expectedCardRevision: generation,
      targetEventId: uuid
    })
    .strict()
])
export type MatrixCompanyBoardCommand = z.infer<typeof MatrixCompanyBoardCommandSchema>

export const MatrixCompanyBoardCommandResponseSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    duplicate: z.boolean(),
    card: MatrixCompanyBoardCardSchema
  })
  .strict()
export type MatrixCompanyBoardCommandResponse = z.infer<typeof MatrixCompanyBoardCommandResponseSchema>

/* ------------------------------------------------------------------ IPC vocabulary */

export const MatrixCompanyBoardRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('board-view'), companyId: uuid }).strict(),
  z
    .object({
      action: z.literal('board-list'),
      companyId: uuid,
      cursor: cursor.nullable(),
      projectId: uuid.nullable(),
      ownerMemberRef: memberRef.nullable(),
      due: z.enum(['all', 'due_soon', 'overdue', 'no_due']),
      includeArchived: z.boolean()
    })
    .strict(),
  z.object({ action: z.literal('board-card'), companyId: uuid, cardId: uuid }).strict(),
  z
    .object({
      action: z.literal('board-command'),
      companyId: uuid,
      command: MatrixCompanyBoardCommandSchema
    })
    .strict()
])

export type MatrixCompanyBoardRequest = z.infer<typeof MatrixCompanyBoardRequestSchema>
export type MatrixCompanyBoardMutation = Extract<MatrixCompanyBoardRequest, { action: 'board-command' }>
export type MatrixCompanyBoardValue =
  | MatrixCompanyBoardView
  | MatrixCompanyBoardPage
  | MatrixCompanyBoardCard
  | MatrixCompanyBoardCommandResponse

export function parseMatrixCompanyBoardRequest(value: unknown): MatrixCompanyBoardRequest {
  const parsed = MatrixCompanyBoardRequestSchema.safeParse(value)

  if (!parsed.success) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

export function isMatrixCompanyBoardMutation(input: MatrixCompanyBoardRequest): input is MatrixCompanyBoardMutation {
  return input.action === 'board-command'
}

/** Every card the desktop is allowed to adopt names the requested company and board. */
export function matrixCompanyBoardCardAuthority(
  card: MatrixCompanyBoardCard,
  expected: { companyId: string; boardId?: string; cardId?: string }
): boolean {
  return (
    card.companyId === expected.companyId &&
    (expected.boardId === undefined || card.boardId === expected.boardId) &&
    (expected.cardId === undefined || card.cardId === expected.cardId)
  )
}

export function parseMatrixCompanyBoardResponse(
  value: unknown,
  input: MatrixCompanyBoardRequest
): MatrixCompanyBoardValue {
  if (input.action === 'board-view') {
    const parsed = MatrixCompanyBoardViewSchema.safeParse(value)

    if (!parsed.success || parsed.data.companyId !== input.companyId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'board-list') {
    const parsed = MatrixCompanyBoardPageSchema.safeParse(value)

    if (
      !parsed.success ||
      parsed.data.board.companyId !== input.companyId ||
      parsed.data.cards.some(
        card =>
          !matrixCompanyBoardCardAuthority(card, {
            companyId: input.companyId,
            boardId: parsed.data.board.boardId
          })
      )
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'board-card') {
    const parsed = MatrixCompanyBoardCardSchema.safeParse(value)

    if (
      !parsed.success ||
      !matrixCompanyBoardCardAuthority(parsed.data, {
        companyId: input.companyId,
        cardId: input.cardId
      })
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  const parsed = MatrixCompanyBoardCommandResponseSchema.safeParse(value)

  if (
    !parsed.success ||
    !matrixCompanyBoardCardAuthority(parsed.data.card, {
      companyId: input.companyId,
      cardId: input.command.cardId
    })
  ) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

/* ------------------------------------------------------------------ native routes */

export interface MatrixCompanyBoardRoute {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export function matrixCompanyBoardRoute(input: MatrixCompanyBoardRequest): MatrixCompanyBoardRoute {
  const base = `/companies/${input.companyId}/board`

  if (input.action === 'board-view') {
    return { method: 'GET', path: `${base}/revision` }
  }

  if (input.action === 'board-list') {
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

    return { method: 'GET', path: `${base}?${query.toString()}` }
  }

  if (input.action === 'board-card') {
    return { method: 'GET', path: `${base}/cards/${input.cardId}` }
  }

  return { method: 'POST', path: `${base}/commands`, body: input.command }
}

import { z } from 'zod'

import {
  type MatrixCompanyAICitation,
  MatrixCompanyAICitationSchema,
  MatrixCompanyAIFileCitation,
  MatrixCompanyNativeError,
  matrixCompanyAIFileCitationAuthority
} from './matrix-company-ai'
import { MatrixCompanyBoardColumnSchema, MatrixCompanyBoardDueSchema } from './matrix-company-board'

/**
 * D1 native consumer for `atum.company-project-brain/4`.
 *
 * The board is the only task authority. A v4 document is a rebuildable summary
 * over exact card revisions plus cited decisions/open questions/file notes.
 * `live|partial` is the only coverage that may carry prose; every marker state
 * serializes no brief, task names, citations or hidden counts.
 *
 * Citation authority is checked on both sides of the wire:
 * - before I/O, `correct` must target a decision/open-question item in the
 *   authorized document its caller displayed, at the exact generations it read;
 * - before I/O, `openTask` may name only a card that document cited;
 * - after I/O, the returned document is re-parsed, every file citation must
 *   belong to its own company and channel audience, and the task preview must
 *   name the same card.
 */

export const MATRIX_COMPANY_PROJECT_BRAIN_PROFILE = 'atum.company-project-brain/4' as const
export const MATRIX_COMPANY_PROJECT_BRAIN_SCHEMA_VERSION = 4 as const
export const MATRIX_COMPANY_PROJECT_BRAIN_BOARD_PIN =
  'c25d852fe2e591442265c6866edf0ef3fed2d3047fd9db096011f3ec328af689' as const

export const MATRIX_COMPANY_PROJECT_BRAIN_LIMITS = Object.freeze({
  tasks: 100,
  suggestedTasks: 40,
  decisions: 20,
  openQuestions: 20,
  fileNotes: 10,
  corrections: 100,
  excerptCharacters: 500,
  sources: 100
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
const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)), 'timestamp must be valid UTC RFC3339')

export const MatrixCompanyBrainTaskRefSchema = z
  .object({
    cardId: uuid,
    cardRevision: generation,
    title: z.string().min(1).max(160),
    status: MatrixCompanyBoardColumnSchema,
    accepted: z.boolean(),
    primaryOwner: memberRef.nullable(),
    due: MatrixCompanyBoardDueSchema.nullable(),
    sourceThreadEventId: eventId.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.accepted !== (value.status !== 'suggested')) {
      context.addIssue({
        code: 'custom',
        path: ['accepted'],
        message: 'Suggested task references remain proposals'
      })
    }
  })
export type MatrixCompanyBrainTaskRef = z.infer<typeof MatrixCompanyBrainTaskRefSchema>

export const MatrixCompanyBrainEvidenceItemSchema = z
  .object({
    itemId: sha256,
    excerpt: z.string().min(1).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.excerptCharacters),
    citation: MatrixCompanyAICitationSchema,
    assertion: z.enum(['source', 'correction'])
  })
  .strict()
export type MatrixCompanyBrainEvidenceItem = z.infer<typeof MatrixCompanyBrainEvidenceItemSchema>

export const MatrixCompanyBrainGoalSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    text: z.string().min(1).max(500).nullable(),
    citation: MatrixCompanyAICitationSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.text !== null) !== (value.citation !== null)) {
      context.addIssue({ code: 'custom', path: ['citation'], message: 'goal text requires exact evidence' })
    }
  })
export type MatrixCompanyBrainGoal = z.infer<typeof MatrixCompanyBrainGoalSchema>

export const MatrixCompanyBrainCorrectionSchema = z
  .object({
    correctionId: uuid,
    createdVersion: generation,
    targetKind: z.enum(['decision', 'open_question']),
    targetItemId: sha256,
    text: z.string().min(1).max(500),
    authorMemberRef: memberRef,
    createdAt: utcTimestamp,
    carried: z.boolean()
  })
  .strict()

export const MatrixCompanyBrainFreshnessSchema = z
  .object({
    sourceAsOf: utcTimestamp,
    boardAsOf: utcTimestamp,
    boardRevision: generation,
    cardRevisionDigest: sha256,
    evidenceDigest: sha256
  })
  .strict()

const gapSchema = z.enum([
  'history_gap',
  'source_stale',
  'publication_revoked',
  'unsupported_format',
  'board_stale',
  'hidden_task',
  'reader_unavailable'
])

export const MatrixCompanyBrainCoverageSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.enum(['live', 'partial']),
      sourceAsOf: utcTimestamp,
      boardAsOf: utcTimestamp,
      lastCheckedAt: utcTimestamp,
      gaps: z.array(gapSchema).max(10)
    })
    .strict(),
  z
    .object({
      state: z.enum(['empty', 'pending', 'stale', 'paused', 'attention']),
      sourceAsOf: utcTimestamp.nullable(),
      boardAsOf: utcTimestamp.nullable(),
      lastCheckedAt: utcTimestamp.nullable(),
      gaps: z.array(gapSchema).max(10)
    })
    .strict()
])
export type MatrixCompanyBrainCoverage = z.infer<typeof MatrixCompanyBrainCoverageSchema>

export const MatrixCompanyBrainBriefSchema = z
  .object({
    version: generation,
    asOf: utcTimestamp,
    freshness: MatrixCompanyBrainFreshnessSchema,
    goal: MatrixCompanyBrainGoalSchema,
    tasks: z
      .object({
        accepted: z.array(MatrixCompanyBrainTaskRefSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.tasks),
        suggested: z.array(MatrixCompanyBrainTaskRefSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.suggestedTasks),
        overdueAcceptedCount: counter
      })
      .strict(),
    decisions: z.array(MatrixCompanyBrainEvidenceItemSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.decisions),
    openQuestions: z.array(MatrixCompanyBrainEvidenceItemSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.openQuestions),
    fileNotes: z.array(MatrixCompanyBrainEvidenceItemSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.fileNotes),
    corrections: z.array(MatrixCompanyBrainCorrectionSchema).max(MATRIX_COMPANY_PROJECT_BRAIN_LIMITS.corrections)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.tasks.accepted.some(task => !task.accepted || task.status === 'suggested') ||
      value.tasks.suggested.some(task => task.accepted || task.status !== 'suggested')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'accepted and Suggested task projections are disjoint'
      })
    }

    if (value.tasks.overdueAcceptedCount > value.tasks.accepted.length) {
      context.addIssue({
        code: 'custom',
        path: ['tasks', 'overdueAcceptedCount'],
        message: 'Suggested tasks never enter overdue totals'
      })
    }

    const ids = [...value.tasks.accepted, ...value.tasks.suggested].map(task => task.cardId)

    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['tasks'], message: 'a card appears once in a brief' })
    }
  })
export type MatrixCompanyBrainBrief = z.infer<typeof MatrixCompanyBrainBriefSchema>

const documentBase = {
  schemaVersion: z.literal(MATRIX_COMPANY_PROJECT_BRAIN_SCHEMA_VERSION),
  companyId: uuid,
  projectId: uuid,
  authorityGeneration: generation,
  sourceGeneration: counter,
  publicationGeneration: counter,
  boardRevision: generation,
  projectionRevision: generation
}

/** Every citation a brief can expose is checked against its own company/audience. */
function citationAuthority(
  document: { companyId: string },
  items: ReadonlyArray<{ citation: MatrixCompanyAICitation }>
): boolean {
  return items.every(item => matrixCompanyAIFileCitationAuthority(item.citation, document.companyId))
}

export const MatrixCompanyBrainDocumentSchema = z.union([
  z
    .object({
      ...documentBase,
      coverage: MatrixCompanyBrainCoverageSchema,
      brief: MatrixCompanyBrainBriefSchema
    })
    .strict()
    .superRefine((value, context) => {
      if (value.coverage.state !== 'live' && value.coverage.state !== 'partial') {
        context.addIssue({ code: 'custom', path: ['brief'], message: 'only current coverage carries summary content' })
      }

      if (value.brief.freshness.boardRevision !== value.boardRevision) {
        context.addIssue({
          code: 'custom',
          path: ['brief', 'freshness', 'boardRevision'],
          message: 'brief must name its board revision'
        })
      }

      const cited: Array<{ citation: MatrixCompanyAICitation }> = [
        ...value.brief.decisions.map(item => ({ citation: item.citation })),
        ...value.brief.openQuestions.map(item => ({ citation: item.citation })),
        ...value.brief.fileNotes.map(item => ({ citation: item.citation })),
        ...(value.brief.goal.citation === null ? [] : [{ citation: value.brief.goal.citation }])
      ]

      if (!citationAuthority(value, cited)) {
        context.addIssue({
          code: 'custom',
          path: ['brief'],
          message: 'brief citations stay inside their own company and channel audience'
        })
      }
    }),
  z
    .object({ ...documentBase, coverage: MatrixCompanyBrainCoverageSchema })
    .strict()
    .superRefine((value, context) => {
      if (value.coverage.state === 'live' || value.coverage.state === 'partial') {
        context.addIssue({ code: 'custom', path: ['coverage'], message: 'current coverage requires a brief' })
      }
    })
])
export type MatrixCompanyBrain = z.infer<typeof MatrixCompanyBrainDocumentSchema>

export const MatrixCompanyBrainCorrectionSchemaV4 = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_PROJECT_BRAIN_SCHEMA_VERSION),
    requestId: uuid,
    expectedBriefVersion: generation,
    expectedBoardRevision: generation,
    expectedSourceGeneration: generation,
    targetKind: z.enum(['decision', 'open_question']),
    targetItemId: sha256,
    text: z.string().min(1).max(500)
  })
  .strict()
export type MatrixCompanyBrainCorrectionRequest = z.infer<typeof MatrixCompanyBrainCorrectionSchemaV4>

/* ------------------------------------------------------------------ authority */

export interface MatrixCompanyBrainCitationAuthority {
  companyId: string
  projectId: string
  sourceIds: ReadonlySet<string>
  channelIds: ReadonlySet<string>
}

/** The sources a current document actually cites; the renderer may open only these. */
export function matrixCompanyBrainCitationAuthority(document: MatrixCompanyBrain): MatrixCompanyBrainCitationAuthority {
  if (!('brief' in document)) {
    return {
      companyId: document.companyId,
      projectId: document.projectId,
      sourceIds: new Set(),
      channelIds: new Set()
    }
  }

  const citations = [
    ...document.brief.decisions.map(item => item.citation),
    ...document.brief.openQuestions.map(item => item.citation),
    ...document.brief.fileNotes.map(item => item.citation),
    ...(document.brief.goal.citation === null ? [] : [document.brief.goal.citation])
  ]

  return {
    companyId: document.companyId,
    projectId: document.projectId,
    sourceIds: new Set(citations.map(citation => citation.sourceId)),
    channelIds: new Set(citations.map(citation => citation.channelId))
  }
}

/** A citation may be opened only when this exact authorized document carries it. */
export function matrixCompanyBrainCitationAllowed(
  authority: MatrixCompanyBrainCitationAuthority,
  citation: MatrixCompanyAICitation
): boolean {
  if (citation.kind === 'company_file') {
    return (
      authority.sourceIds.has(citation.sourceId) &&
      authority.channelIds.has(citation.channelId) &&
      citation.file.company_id === authority.companyId
    )
  }

  return authority.sourceIds.has(citation.sourceId) && authority.channelIds.has(citation.channelId)
}

/**
 * Before I/O: a correction may only target a cited decision/open question at
 * the exact brief, board and source generations the caller displayed.
 */
export function matrixCompanyBrainCorrectionAuthority(
  base: MatrixCompanyBrain,
  input: {
    companyId: string
    projectId: string
    expectedBriefVersion: number
    expectedBoardRevision: number
    expectedSourceGeneration: number
    targetKind: 'decision' | 'open_question'
    targetItemId: string
  }
): void {
  if (
    base.companyId !== input.companyId ||
    base.projectId !== input.projectId ||
    !('brief' in base) ||
    base.brief.version !== input.expectedBriefVersion ||
    base.boardRevision !== input.expectedBoardRevision ||
    base.sourceGeneration !== input.expectedSourceGeneration
  ) {
    throw new MatrixCompanyNativeError('invalid')
  }

  const items = input.targetKind === 'decision' ? base.brief.decisions : base.brief.openQuestions

  if (!items.some(item => item.itemId === input.targetItemId)) {
    throw new MatrixCompanyNativeError('invalid')
  }
}

/** Before I/O: openTask may name only a card the authorized summary cited. */
export function matrixCompanyBrainTaskAuthority(
  base: MatrixCompanyBrain,
  input: { companyId: string; projectId: string; cardId: string }
): MatrixCompanyBrainTaskRef {
  if (base.companyId !== input.companyId || base.projectId !== input.projectId || !('brief' in base)) {
    throw new MatrixCompanyNativeError('invalid')
  }

  const task = [...base.brief.tasks.accepted, ...base.brief.tasks.suggested].find(
    candidate => candidate.cardId === input.cardId
  )

  if (task === undefined) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return task
}

/* ------------------------------------------------------------------ IPC vocabulary */

const correctionBase = z
  .object({
    action: z.literal('brain-correct'),
    companyId: uuid,
    projectId: uuid,
    base: MatrixCompanyBrainDocumentSchema,
    requestId: uuid,
    expectedBriefVersion: generation,
    expectedBoardRevision: generation,
    expectedSourceGeneration: generation,
    targetKind: z.enum(['decision', 'open_question']),
    targetItemId: sha256,
    text: z.string().min(1).max(500)
  })
  .strict()

export const MatrixCompanyBrainRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('brain-read'),
      companyId: uuid,
      projectId: uuid
    })
    .strict(),
  correctionBase,
  z
    .object({
      action: z.literal('brain-open-task'),
      companyId: uuid,
      projectId: uuid,
      base: MatrixCompanyBrainDocumentSchema,
      cardId: uuid
    })
    .strict()
])

export type MatrixCompanyBrainRequest = z.infer<typeof MatrixCompanyBrainRequestSchema>
export type MatrixCompanyBrainMutation = Extract<MatrixCompanyBrainRequest, { action: 'brain-correct' }>
export type MatrixCompanyBrainValue = MatrixCompanyBrain | MatrixCompanyBrainTaskRef

export function parseMatrixCompanyBrainRequest(value: unknown): MatrixCompanyBrainRequest {
  const parsed = MatrixCompanyBrainRequestSchema.safeParse(value)

  if (!parsed.success) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

export function isMatrixCompanyBrainMutation(input: MatrixCompanyBrainRequest): input is MatrixCompanyBrainMutation {
  return input.action === 'brain-correct'
}

export function parseMatrixCompanyBrainResponse(
  value: unknown,
  input: MatrixCompanyBrainRequest
): MatrixCompanyBrainValue {
  if (input.action === 'brain-open-task') {
    const parsed = MatrixCompanyBrainTaskRefSchema.safeParse(value)

    if (!parsed.success || parsed.data.cardId !== input.cardId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  const parsed = MatrixCompanyBrainDocumentSchema.safeParse(value)

  if (!parsed.success || parsed.data.companyId !== input.companyId || parsed.data.projectId !== input.projectId) {
    throw new MatrixCompanyNativeError('invalid')
  }

  // Re-check the returned document's citations; a corrective response may add
  // items and a stale response may not cross into a sibling channel.
  matrixCompanyBrainCitationAuthority(parsed.data)

  return parsed.data
}

/* ------------------------------------------------------------------ native routes */

export interface MatrixCompanyBrainRoute {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export function matrixCompanyBrainRoute(input: MatrixCompanyBrainRequest): MatrixCompanyBrainRoute {
  const base = `/companies/${input.companyId}/projects/${input.projectId}/brain`

  if (input.action === 'brain-read') {
    return { method: 'GET', path: base }
  }

  if (input.action === 'brain-open-task') {
    return { method: 'GET', path: `${base}/tasks/${input.cardId}` }
  }

  return {
    method: 'POST',
    path: `${base}/corrections`,
    body: {
      schemaVersion: MATRIX_COMPANY_PROJECT_BRAIN_SCHEMA_VERSION,
      requestId: input.requestId,
      expectedBriefVersion: input.expectedBriefVersion,
      expectedBoardRevision: input.expectedBoardRevision,
      expectedSourceGeneration: input.expectedSourceGeneration,
      targetKind: input.targetKind,
      targetItemId: input.targetItemId,
      text: input.text
    }
  }
}

/** The exact files a document cites, for source-open routing without room authority. */
export function matrixCompanyBrainFileCitations(document: MatrixCompanyBrain): MatrixCompanyAIFileCitation[] {
  if (!('brief' in document)) {
    return []
  }

  const citations = [
    ...document.brief.decisions.map(item => item.citation),
    ...document.brief.openQuestions.map(item => item.citation),
    ...document.brief.fileNotes.map(item => item.citation),
    ...(document.brief.goal.citation === null ? [] : [document.brief.goal.citation])
  ]

  return citations.filter((citation): citation is MatrixCompanyAIFileCitation => citation.kind === 'company_file')
}

import { z } from 'zod'

import {
  MatrixCompanyAIChannelCitationSchema,
  matrixCompanyAIFileRefAuthority,
  MatrixCompanyAIFileRefSchema
} from './matrix-company-ai'
import {
  MATRIX_COMPANY_BOARD_LIMITS,
  MATRIX_COMPANY_BOARD_SCHEMA_VERSION,
  MatrixCompanyBoardActorSchema,
  MatrixCompanyBoardCardSchema,
  MatrixCompanyBoardColumnSchema,
  MatrixCompanyBoardDueSchema,
  MatrixCompanyBoardFieldProvenanceSchema,
  MatrixCompanyBoardProvenanceRefSchema,
  MatrixCompanyBoardViewSchema
} from './matrix-company-board'
import { companyBoardOwnershipIssue } from './matrix-company-board-ownership'

export const MATRIX_COMPANY_BOARD_PROFILE_V11 = 'atum.company-board/1.1' as const
export const MATRIX_COMPANY_BOARD_WIRE_VALUE_V11 = '1.1' as const
export const MATRIX_COMPANY_BOARD_PRIORITIES_V11 = ['low', 'normal', 'high', 'urgent'] as const
export const MATRIX_COMPANY_BOARD_SEARCH_FIELDS_V11 = ['title', 'description', 'checklist_text'] as const

export const MATRIX_COMPANY_BOARD_LIMITS_V11 = Object.freeze({
  checklistItems: 50,
  checklistTextCharacters: 240,
  attachments: 20,
  searchQueryCharacters: 160,
  searchPageCards: 50,
  activityPageEvents: 100
} as const)

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u)
const memberRef = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u)
const eventId = z.string().min(2).max(512).regex(/^\$[!-~]+$/u)
const displayKey = z.string().regex(/^tsk_[A-Za-z0-9_-]{8,32}$/u)
const title = z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS.titleCharacters)
const description = z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS.descriptionCharacters)
const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)), 'timestamp must be valid UTC RFC3339')
const checklistText = z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistTextCharacters)
const checklistOrder = z.number().int().min(0).max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistItems - 1)

export const MatrixCompanyBoardPriorityV11Schema = z.enum(MATRIX_COMPANY_BOARD_PRIORITIES_V11)
export type MatrixCompanyBoardPriorityV11 = z.infer<typeof MatrixCompanyBoardPriorityV11Schema>

export const MatrixCompanyBoardChecklistItemV11Schema = z
  .object({
    itemId: uuid,
    text: checklistText,
    done: z.boolean(),
    order: checklistOrder,
    completedBy: MatrixCompanyBoardActorSchema.nullable(),
    completedAt: utcTimestamp.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.done !== (value.completedBy !== null && value.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['done'],
        message: 'a completed checklist item records both completion actor and time'
      })
    }
  })

export const MatrixCompanyBoardChecklistV11Schema = z
  .array(MatrixCompanyBoardChecklistItemV11Schema)
  .max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistItems)
  .superRefine((items, context) => {
    if (new Set(items.map(item => item.itemId)).size !== items.length) {
      context.addIssue({ code: 'custom', message: 'checklist item ids must be unique' })
    }

    items.forEach((item, index) => {
      if (item.order !== index) {
        context.addIssue({
          code: 'custom',
          path: [index, 'order'],
          message: 'checklist order must be zero-based and contiguous'
        })
      }
    })
  })

export const MatrixCompanyBoardChecklistDraftItemV11Schema = z
  .object({ itemId: uuid, text: checklistText, order: checklistOrder })
  .strict()

const checklistDraft = z
  .array(MatrixCompanyBoardChecklistDraftItemV11Schema)
  .max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistItems)
  .superRefine((items, context) => {
    if (new Set(items.map(item => item.itemId)).size !== items.length) {
      context.addIssue({ code: 'custom', message: 'checklist item ids must be unique' })
    }

    items.forEach((item, index) => {
      if (item.order !== index) {
        context.addIssue({ code: 'custom', path: [index, 'order'], message: 'draft order must be contiguous' })
      }
    })
  })

export const MatrixCompanyBoardAttachmentV11Schema = z
  .object({
    attachmentId: uuid,
    file: MatrixCompanyAIFileRefSchema,
    addedBy: MatrixCompanyBoardActorSchema,
    addedAt: utcTimestamp
  })
  .strict()

export const MatrixCompanyBoardCardV11Schema = MatrixCompanyBoardCardSchema.safeExtend({
  priority: MatrixCompanyBoardPriorityV11Schema,
  checklist: MatrixCompanyBoardChecklistV11Schema,
  attachments: z.array(MatrixCompanyBoardAttachmentV11Schema).max(MATRIX_COMPANY_BOARD_LIMITS_V11.attachments),
  extensionProvenance: z
    .object({
      priority: MatrixCompanyBoardFieldProvenanceSchema,
      checklist: MatrixCompanyBoardFieldProvenanceSchema,
      attachments: MatrixCompanyBoardFieldProvenanceSchema
    })
    .strict()
}).superRefine((value, context) => {
  if (new Set(value.attachments.map(attachment => attachment.attachmentId)).size !== value.attachments.length) {
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'attachment ids must be unique' })
  }

  const files = value.attachments.map(attachment =>
    `${attachment.file.v}:${attachment.file.file_id}:${attachment.file.revision}`)

  if (new Set(files).size !== files.length) {
    context.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: 'a protected file revision is attached once'
    })
  }

  if (value.attachments.some(attachment =>
    !matrixCompanyAIFileRefAuthority(attachment.file, { companyId: value.companyId }))) {
    context.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: 'attachments stay inside their company audience'
    })
  }
})
export type MatrixCompanyBoardCardV11 = z.infer<typeof MatrixCompanyBoardCardV11Schema>

export const MatrixCompanyBoardPageV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    board: MatrixCompanyBoardViewSchema,
    cards: z.array(MatrixCompanyBoardCardV11Schema).max(MATRIX_COMPANY_BOARD_LIMITS.pageCards),
    nextCursor: cursor.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.cards.map(card => card.cardId)).size !== value.cards.length) {
      context.addIssue({ code: 'custom', path: ['cards'], message: 'card ids must be unique after permission filtering' })
    }
  })
export type MatrixCompanyBoardPageV11 = z.infer<typeof MatrixCompanyBoardPageV11Schema>

export const MatrixCompanyBoardSearchResultV11Schema = z
  .object({
    cardId: uuid,
    displayKey,
    revision: generation,
    title,
    description: description.nullable(),
    status: MatrixCompanyBoardColumnSchema,
    priority: MatrixCompanyBoardPriorityV11Schema,
    checklistProgress: z
      .object({
        done: z.number().int().min(0).max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistItems),
        total: z.number().int().min(0).max(MATRIX_COMPANY_BOARD_LIMITS_V11.checklistItems)
      })
      .strict()
      .refine(value => value.done <= value.total, 'completed checklist count cannot exceed total'),
    owners: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.owners),
    primaryOwner: memberRef.nullable(),
    due: MatrixCompanyBoardDueSchema.nullable(),
    archived: z.boolean(),
    matchedFields: z
      .array(z.enum(MATRIX_COMPANY_BOARD_SEARCH_FIELDS_V11))
      .min(1)
      .max(MATRIX_COMPANY_BOARD_SEARCH_FIELDS_V11.length)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.matchedFields).size !== value.matchedFields.length) {
      context.addIssue({ code: 'custom', path: ['matchedFields'], message: 'matched fields must be unique' })
    }
  })
export type MatrixCompanyBoardSearchResultV11 = z.infer<typeof MatrixCompanyBoardSearchResultV11Schema>

export const MatrixCompanyBoardSearchPageV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    board: MatrixCompanyBoardViewSchema,
    results: z.array(MatrixCompanyBoardSearchResultV11Schema).max(MATRIX_COMPANY_BOARD_LIMITS_V11.searchPageCards),
    nextCursor: cursor.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.results.map(result => result.cardId)).size !== value.results.length) {
      context.addIssue({ code: 'custom', path: ['results'], message: 'search result card ids must be unique' })
    }
  })
export type MatrixCompanyBoardSearchPageV11 = z.infer<typeof MatrixCompanyBoardSearchPageV11Schema>

export const MatrixCompanyBoardPatchV11Schema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    owners: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.owners).optional(),
    primaryOwner: memberRef.nullable().optional(),
    participants: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.participants).optional(),
    due: MatrixCompanyBoardDueSchema.nullable().optional(),
    status: MatrixCompanyBoardColumnSchema.optional(),
    projectId: uuid.nullable().optional(),
    priority: MatrixCompanyBoardPriorityV11Schema.optional()
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'patch must change at least one field')
  .superRefine((value, context) => {
    const issue = companyBoardOwnershipIssue(value)

    if (issue) {
      context.addIssue({ code: 'custom', path: ['owners'], message: issue })
    }
  })

export const MatrixCompanyBoardChecklistMutationV11Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), item: MatrixCompanyBoardChecklistDraftItemV11Schema }).strict(),
  z
    .object({
      action: z.literal('update'),
      itemId: uuid,
      patch: z
        .object({ text: checklistText.optional(), done: z.boolean().optional(), order: checklistOrder.optional() })
        .strict()
        .refine(value => Object.keys(value).length > 0, 'checklist patch must change a field')
    })
    .strict(),
  z.object({ action: z.literal('remove'), itemId: uuid }).strict()
])

export const MatrixCompanyBoardAttachmentMutationV11Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), file: MatrixCompanyAIFileRefSchema }).strict(),
  z.object({ action: z.literal('remove'), attachmentId: uuid }).strict()
])

const commandBase = { schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION), requestId: uuid }

export const MatrixCompanyBoardCommandV11Schema = z.discriminatedUnion('operation', [
  z
    .object({
      ...commandBase,
      operation: z.literal('create'),
      cardId: uuid,
      title,
      description: description.nullable().optional(),
      projectId: uuid.nullable().optional(),
      priority: MatrixCompanyBoardPriorityV11Schema.optional(),
      checklist: checklistDraft.optional()
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('patch'),
      cardId: uuid,
      expectedCardRevision: generation,
      patch: MatrixCompanyBoardPatchV11Schema
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('checklist'),
      cardId: uuid,
      expectedCardRevision: generation,
      mutation: MatrixCompanyBoardChecklistMutationV11Schema
    })
    .strict(),
  z
    .object({
      ...commandBase,
      operation: z.literal('attachment'),
      cardId: uuid,
      expectedCardRevision: generation,
      mutation: MatrixCompanyBoardAttachmentMutationV11Schema
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
export type MatrixCompanyBoardCommandV11 = z.infer<typeof MatrixCompanyBoardCommandV11Schema>

export const MatrixCompanyBoardCommandResultV11Schema = z.discriminatedUnion('state', [
  z
    .object({
      schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
      state: z.literal('applied'),
      duplicate: z.boolean(),
      eventId: uuid,
      card: MatrixCompanyBoardCardV11Schema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
      state: z.literal('conflict'),
      reason: z.literal('stale_card_revision'),
      cardId: uuid,
      expectedCardRevision: generation,
      currentCardRevision: generation,
      currentCard: MatrixCompanyBoardCardV11Schema
    })
    .strict()
]).superRefine((value, context) => {
  if (
    value.state === 'conflict' &&
    (value.expectedCardRevision === value.currentCardRevision ||
      value.currentCard.revision !== value.currentCardRevision ||
      value.currentCard.cardId !== value.cardId)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['currentCardRevision'],
      message: 'a stale conflict carries the distinct current card revision and projection'
    })
  }
})
export type MatrixCompanyBoardCommandResultV11 = z.infer<typeof MatrixCompanyBoardCommandResultV11Schema>

const fieldValue = z.discriminatedUnion('field', [
  z.object({ field: z.literal('title'), value: title }).strict(),
  z.object({ field: z.literal('description'), value: description.nullable() }).strict(),
  z
    .object({
      field: z.literal('owners'),
      owners: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.owners),
      primaryOwner: memberRef.nullable(),
      participants: z.array(memberRef).max(MATRIX_COMPANY_BOARD_LIMITS.participants)
    })
    .strict(),
  z.object({ field: z.literal('due'), value: MatrixCompanyBoardDueSchema.nullable() }).strict(),
  z.object({ field: z.literal('status'), value: MatrixCompanyBoardColumnSchema }).strict(),
  z.object({ field: z.literal('project_tag'), value: uuid.nullable() }).strict(),
  z.object({ field: z.literal('archived'), value: z.boolean() }).strict(),
  z.object({ field: z.literal('priority'), value: MatrixCompanyBoardPriorityV11Schema }).strict(),
  z.object({ field: z.literal('checklist'), value: MatrixCompanyBoardChecklistV11Schema }).strict(),
  z
    .object({
      field: z.literal('attachments'),
      value: z.array(MatrixCompanyBoardAttachmentV11Schema).max(MATRIX_COMPANY_BOARD_LIMITS_V11.attachments)
    })
    .strict()
])

const fieldChange = z
  .object({
    field: z.enum([
      'title',
      'description',
      'owners',
      'due',
      'status',
      'project_tag',
      'archived',
      'priority',
      'checklist',
      'attachments'
    ]),
    before: fieldValue.nullable(),
    after: fieldValue.nullable(),
    provenance: MatrixCompanyBoardFieldProvenanceSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.before !== null && value.before.field !== value.field) ||
      (value.after !== null && value.after.field !== value.field)
    ) {
      context.addIssue({ code: 'custom', path: ['field'], message: 'change values must match their field' })
    }
  })

const humanSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native_command'), memberRef, requestId: uuid }).strict(),
  z
    .object({
      kind: z.literal('matrix_event'),
      memberRef,
      citation: MatrixCompanyAIChannelCitationSchema
    })
    .strict()
])

const completionAuthority = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assignee'), memberRef, signal: humanSignal }).strict(),
  z.object({ kind: z.literal('owner_admin'), memberRef, signal: humanSignal }).strict()
])

export const MatrixCompanyBoardUndoAvailabilityV11Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), targetEventId: uuid, expectedCardRevision: generation }).strict(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: z.enum(['already_compensated', 'superseded', 'not_reversible', 'not_authorized', 'card_archived'])
    })
    .strict()
])

export const MatrixCompanyBoardActivityEventV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    eventId: uuid,
    companyId: uuid,
    boardId: uuid,
    cardId: uuid,
    cardRevision: generation,
    requestId: uuid,
    operation: z.enum(['create', 'patch', 'checklist', 'attachment', 'accept', 'archive', 'undo', 'derive', 'remind']),
    origin: z.enum(['human', 'cos']),
    actor: MatrixCompanyBoardActorSchema,
    sourceCitations: z.array(MatrixCompanyBoardProvenanceRefSchema).min(1).max(MATRIX_COMPANY_BOARD_LIMITS.citations),
    changes: z.array(fieldChange).min(1).max(12),
    compensatesEventId: uuid.nullable(),
    completionAuthority: completionAuthority.nullable(),
    undo: MatrixCompanyBoardUndoAvailabilityV11Schema,
    at: utcTimestamp
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin !== value.actor.kind) {
      context.addIssue({ code: 'custom', path: ['origin'], message: 'activity origin must match its actor' })
    }

    if ((value.operation === 'undo') !== (value.compensatesEventId !== null)) {
      context.addIssue({ code: 'custom', path: ['compensatesEventId'], message: 'undo compensates one exact event' })
    }

    if (value.undo.state === 'available' && value.undo.targetEventId !== value.eventId) {
      context.addIssue({ code: 'custom', path: ['undo', 'targetEventId'], message: 'undo targets this event' })
    }
  })
export type MatrixCompanyBoardActivityEventV11 = z.infer<typeof MatrixCompanyBoardActivityEventV11Schema>

export const MatrixCompanyBoardActivityPageV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    cardId: uuid,
    events: z.array(MatrixCompanyBoardActivityEventV11Schema).max(MATRIX_COMPANY_BOARD_LIMITS_V11.activityPageEvents),
    nextCursor: cursor.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.events.map(event => event.eventId)).size !== value.events.length) {
      context.addIssue({ code: 'custom', path: ['events'], message: 'activity event ids must be unique' })
    }

    if (value.events.some(event => event.cardId !== value.cardId)) {
      context.addIssue({ code: 'custom', path: ['events'], message: 'activity page contains one card only' })
    }
  })
export type MatrixCompanyBoardActivityPageV11 = z.infer<typeof MatrixCompanyBoardActivityPageV11Schema>

export const MatrixCompanyBoardSearchRequestV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    query: z.string().min(1).max(MATRIX_COMPANY_BOARD_LIMITS_V11.searchQueryCharacters),
    cursor: cursor.nullable(),
    limit: z.number().int().min(1).max(MATRIX_COMPANY_BOARD_LIMITS_V11.searchPageCards),
    fields: z.tuple([z.literal('title'), z.literal('description'), z.literal('checklist_text')]),
    projectId: uuid.nullable(),
    ownerMemberRef: memberRef.nullable(),
    due: z.enum(['all', 'due_soon', 'overdue', 'no_due']),
    priority: MatrixCompanyBoardPriorityV11Schema.nullable(),
    includeArchived: z.boolean()
  })
  .strict()

export const MatrixCompanyBoardActivityRequestV11Schema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_BOARD_SCHEMA_VERSION),
    cardId: uuid,
    cursor: cursor.nullable(),
    limit: z.number().int().min(1).max(MATRIX_COMPANY_BOARD_LIMITS_V11.activityPageEvents)
  })
  .strict()

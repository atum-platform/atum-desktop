import type { MatrixSdkCommand } from '../../shared/matrix'
import {
  MatrixCompanyAICitationSchema,
  matrixCompanyAIFileCitationAuthority,
  type MatrixCompanyAIFileRef,
  matrixCompanyAIFileRefAuthority,
  MatrixCompanyAIFileRefSchema,
  MatrixCompanyNativeError
} from '../../shared/matrix-company-ai'
import {
  MatrixCompanyBoardCardSchema,
  MatrixCompanyBoardCommandResponseSchema,
  MatrixCompanyBoardPageSchema,
  MatrixCompanyBoardRequestSchema,
  MatrixCompanyBoardViewSchema
} from '../../shared/matrix-company-board'
import { MatrixCompanyBoardRequestV11Schema } from '../../shared/matrix-company-board-negotiated'
import {
  MatrixCompanyBoardActivityPageV11Schema,
  MatrixCompanyBoardCardV11Schema,
  MatrixCompanyBoardCommandResultV11Schema,
  MatrixCompanyBoardPageV11Schema,
  MatrixCompanyBoardSearchPageV11Schema
} from '../../shared/matrix-company-board-v11'
import type { MatrixCompanyDesktopRequest, MatrixCompanyDesktopResult } from '../../shared/matrix-company-desktop'
import { isTrustedPayOSUrl } from '../../shared/matrix-company-funding'
import {
  MatrixCompanyBrainDocumentSchema,
  MatrixCompanyBrainRequestSchema
} from '../../shared/matrix-company-project-brain'

import type { CompanyChannelDirectoryValue } from './company-directory'
import { requireMatrixCaller } from './ipc-policy'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function invalid(): never {
  throw new MatrixCompanyNativeError('invalid')
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    return invalid()
  }

  return value
}

export interface MatrixCompanyDesktopContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  enabled: boolean
  closing: boolean
  available: () => boolean
  board(request: unknown): Promise<unknown>
  ai(request: unknown): Promise<unknown>
  privateCos(request: unknown): Promise<unknown>
  funding(request: unknown): Promise<unknown>
  projectBrain(request: unknown): Promise<unknown>
  channels(companyId: string): Promise<CompanyChannelDirectoryValue>
  sdk(command: MatrixSdkCommand): Promise<unknown>
  openBoardAttachment(companyId: string, file: MatrixCompanyAIFileRef): Promise<void>
  openExternal(url: string): Promise<void>
}

function gate(context: MatrixCompanyDesktopContext): MatrixCompanyDesktopResult | null {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (!context.enabled || context.closing) {
    return { ok: false, error: 'unavailable' }
  }

  if (!context.available()) {
    return { ok: false, error: 'authentication' }
  }

  return null
}

function refusal(error: unknown): MatrixCompanyDesktopResult {
  if (error instanceof Error && error.message === 'matrix_domain_signed_out') {
    return { ok: false, error: 'authentication' }
  }

  if (error instanceof MatrixCompanyNativeError) {
    return { ok: false, error: error.code }
  }

  return { ok: false, error: 'unavailable' }
}

function channelTarget(directory: CompanyChannelDirectoryValue, channelId: string) {
  return directory.channels.find(
    item =>
      item.channel.id === channelId &&
      item.room.state === 'ready' &&
      ['active', 'archived'].includes(item.channel.state)
  )
}

function channelFingerprint(directory: CompanyChannelDirectoryValue): string {
  return JSON.stringify(
    directory.channels.map(item => [item.channel.id, item.channel.state, item.room.state,
      item.room.state === 'ready' ? item.room.roomId : null])
  )
}

function rendererSafeOrder(value: unknown): unknown {
  if (!object(value)) {
    return invalid()
  }

  const { checkoutUrl: _checkoutUrl, ...order } = value

  return order
}

function negotiatedBoard(value: unknown): { negotiatedProfile: '1' | '1.1'; value: unknown } {
  if (
    !object(value) ||
    !exact(value, ['negotiatedProfile', 'value']) ||
    !['1', '1.1'].includes(String(value.negotiatedProfile))
  ) {
    return invalid()
  }

  return value as { negotiatedProfile: '1' | '1.1'; value: unknown }
}

async function openCitation(
  context: MatrixCompanyDesktopContext,
  companyId: string,
  citationValue: unknown
): Promise<unknown> {
  const citation = MatrixCompanyAICitationSchema.safeParse(citationValue)

  if (!citation.success || !matrixCompanyAIFileCitationAuthority(citation.data, companyId)) {
    return invalid()
  }

  const before = await context.channels(companyId)
  const beforeTarget = channelTarget(before, citation.data.channelId)

  if (!beforeTarget || beforeTarget.room.state !== 'ready') {
    throw new MatrixCompanyNativeError('denied')
  }

  const roomId = beforeTarget.room.roomId

  if (citation.data.kind === 'channel') {
    await context.sdk({
      kind: 'companyCitationOpen',
      companyId,
      channelId: citation.data.channelId,
      roomId,
      eventId: citation.data.eventId
    })
  }

  const after = await context.channels(companyId)
  const afterTarget = channelTarget(after, citation.data.channelId)

  if (!afterTarget || channelFingerprint(before) !== channelFingerprint(after)) {
    throw new MatrixCompanyNativeError('cancelled')
  }

  await context.sdk({
    kind: 'companyMessageSelect',
    companyId,
    channelId: citation.data.channelId,
    roomId: afterTarget.room.roomId
  })

  return null
}

async function correctBrain(
  context: MatrixCompanyDesktopContext,
  companyId: string,
  projectId: string,
  value: unknown
): Promise<unknown> {
  if (!object(value) ||
      !exact(value, ['schemaVersion', 'requestId', 'expectedBriefVersion', 'expectedBoardRevision',
        'expectedSourceGeneration', 'targetKind', 'targetItemId', 'text']) ||
      value.schemaVersion !== 4) {
    return invalid()
  }

  const document = MatrixCompanyBrainDocumentSchema.safeParse(
    await context.projectBrain({ action: 'brain-read', companyId, projectId })
  )

  if (!document.success || document.data.companyId !== companyId || document.data.projectId !== projectId) {
    return invalid()
  }

  if (!('brief' in document.data) ||
      document.data.brief.version !== value.expectedBriefVersion ||
      document.data.boardRevision !== value.expectedBoardRevision ||
      document.data.sourceGeneration !== value.expectedSourceGeneration) {
    throw new MatrixCompanyNativeError('conflict')
  }

  const request = {
    action: 'brain-correct',
    companyId,
    projectId,
    base: document.data,
    requestId: value.requestId,
    expectedBriefVersion: value.expectedBriefVersion,
    expectedBoardRevision: value.expectedBoardRevision,
    expectedSourceGeneration: value.expectedSourceGeneration,
    targetKind: value.targetKind,
    targetItemId: value.targetItemId,
    text: value.text
  }

  const parsed = MatrixCompanyBrainRequestSchema.safeParse(request)

  if (!parsed.success) {
    return invalid()
  }

  return context.projectBrain(parsed.data)
}

async function dispatch(
  context: MatrixCompanyDesktopContext,
  request: MatrixCompanyDesktopRequest
): Promise<unknown> {
  switch (request.action) {
    case 'read-board-view': {
      const parsed = MatrixCompanyBoardRequestSchema.safeParse({
        action: 'board-view',
        companyId: request.companyId
      })

      if (!parsed.success) {
        return invalid()
      }

      const view = MatrixCompanyBoardViewSchema.safeParse(await context.board(parsed.data))

      return view.success ? view.data : invalid()
    }

    case 'list-board': {
      const parsed = MatrixCompanyBoardRequestV11Schema.safeParse({
        action: 'board-list-v11',
        companyId: request.companyId,
        ...request.filters
      })

      if (!parsed.success) {
        return invalid()
      }

      const result = negotiatedBoard(await context.board(parsed.data))

      const page = result.negotiatedProfile === '1.1'
        ? MatrixCompanyBoardPageV11Schema.safeParse(result.value)
        : MatrixCompanyBoardPageSchema.safeParse(result.value)

      return page.success ? { ...page.data, contractVersion: result.negotiatedProfile } : invalid()
    }

    case 'read-board-card': {
      const parsed = MatrixCompanyBoardRequestV11Schema.safeParse({
        action: 'board-card-v11',
        companyId: request.companyId,
        cardId: request.cardId
      })

      if (!parsed.success) {
        return invalid()
      }

      const result = negotiatedBoard(await context.board(parsed.data))

      const card = result.negotiatedProfile === '1.1'
        ? MatrixCompanyBoardCardV11Schema.safeParse(result.value)
        : MatrixCompanyBoardCardSchema.safeParse(result.value)

      return card.success ? card.data : invalid()
    }

    case 'search-board': {
      const parsed = MatrixCompanyBoardRequestV11Schema.safeParse({
        action: 'board-search-v11',
        companyId: request.companyId,
        ...request.filters
      })

      if (!parsed.success) {
        return invalid()
      }

      const result = negotiatedBoard(await context.board(parsed.data))

      const page = result.negotiatedProfile === '1.1'
        ? MatrixCompanyBoardSearchPageV11Schema.safeParse(result.value)
        : null

      return page?.success ? page.data : invalid()
    }

    case 'read-board-activity': {
      const parsed = MatrixCompanyBoardRequestV11Schema.safeParse({
        action: 'board-activity-v11',
        companyId: request.companyId,
        cardId: request.cardId,
        cursor: request.cursor
      })

      if (!parsed.success) {
        return invalid()
      }

      const result = negotiatedBoard(await context.board(parsed.data))

      const page = result.negotiatedProfile === '1.1'
        ? MatrixCompanyBoardActivityPageV11Schema.safeParse(result.value)
        : null

      return page?.success ? page.data : invalid()
    }

    case 'command-board': {
      if (request.contractVersion === '1.1') {
        const parsed = MatrixCompanyBoardRequestV11Schema.safeParse({
          action: 'board-command-v11',
          companyId: request.companyId,
          command: request.command
        })

        if (!parsed.success) {
          return invalid()
        }

        const result = negotiatedBoard(await context.board(parsed.data))

        const response = result.negotiatedProfile === '1.1'
          ? MatrixCompanyBoardCommandResultV11Schema.safeParse(result.value)
          : MatrixCompanyBoardCommandResponseSchema.safeParse(result.value)

        return response.success ? response.data : invalid()
      }

      const parsed = MatrixCompanyBoardRequestSchema.safeParse({
        action: 'board-command',
        companyId: request.companyId,
        command: request.command
      })

      if (!parsed.success) {
        return invalid()
      }

      const response = MatrixCompanyBoardCommandResponseSchema.safeParse(await context.board(parsed.data))

      return response.success ? response.data : invalid()
    }

    case 'open-board-attachment': {
      const file = MatrixCompanyAIFileRefSchema.safeParse(request.file)

      if (!file.success || !matrixCompanyAIFileRefAuthority(file.data, { companyId: request.companyId })) {
        return invalid()
      }

      await context.openBoardAttachment(request.companyId, file.data)

      return null
    }

    case 'read-project-brain': {
      const parsed = MatrixCompanyBrainRequestSchema.safeParse({
        action: 'brain-read',
        companyId: request.companyId,
        projectId: request.projectId
      })

      return parsed.success ? context.projectBrain(parsed.data) : invalid()
    }

    case 'correct-project-brain':
      return correctBrain(context, request.companyId, request.projectId, request.request)

    case 'open-citation':
      return openCitation(context, request.companyId, request.citation)

    case 'read-ai':
      return context.ai({ action: 'company-ai-view', companyId: request.companyId })
    case 'configure-ai': {
      const value = request.request

      if (!object(value) || !exact(value, ['schemaVersion', 'requestId', 'expectedRevision', 'enabled']) ||
          value.schemaVersion !== 1) {
        return invalid()
      }

      return context.ai({
        action: 'company-ai-configure',
        companyId: request.companyId,
        requestId: value.requestId,
        expectedRevision: value.expectedRevision,
        enabled: value.enabled
      })
    }

    case 'read-private-cos':
      return context.privateCos({ action: 'private-cos-view', companyId: request.companyId })
    case 'read-private-cos-capability':
      return context.privateCos({ action: 'private-cos-capability', companyId: request.companyId })
    case 'ensure-private-cos': {
      const value = request.request
      const keys = value && typeof value === 'object' && 'locale' in value
        ? ['schemaVersion', 'requestId', 'action', 'trigger', 'locale']
        : ['schemaVersion', 'requestId', 'action', 'trigger']

      if (!object(value) || !exact(value, keys) ||
        value.schemaVersion !== 1 || value.action !== 'ensure' ||
        !['dm_open', 'first_company_visit'].includes(String(value.trigger)) ||
        (value.locale !== undefined && !['en', 'vi', 'ja', 'zh', 'zh-hant'].includes(String(value.locale)))) {
        return invalid()
      }

      return context.privateCos({
        action: 'private-cos-ensure',
        companyId: request.companyId,
        schemaVersion: 1,
        requestId: value.requestId,
        trigger: value.trigger,
        ...(value.locale === undefined ? {} : { locale: value.locale })
      })
    }
    case 'read-private-cos-receipt':
      return context.privateCos({
        action: 'private-cos-receipt',
        companyId: request.companyId,
        runId: request.runId
      })
    case 'stop-private-cos': {
      const value = request.request

      if (!object(value) || !exact(value, ['schemaVersion', 'requestId']) || value.schemaVersion !== 1) {
        return invalid()
      }

      return context.privateCos({
        action: 'private-cos-stop',
        companyId: request.companyId,
        runId: request.runId,
        schemaVersion: 1,
        requestId: value.requestId
      })
    }

    case 'read-wallet':
      return context.funding({ action: 'funding-wallet', companyId: request.companyId })

    case 'read-packs':
      return context.funding({ action: 'funding-packs', companyId: request.companyId })
    case 'create-order': {
      const value = request.request

      if (!object(value) || !exact(value, ['schemaVersion', 'requestId', 'packId']) || value.schemaVersion !== 2) {
        return invalid()
      }

      return rendererSafeOrder(
        await context.funding({
          action: 'funding-order-create',
          companyId: request.companyId,
          requestId: value.requestId,
          packId: value.packId
        })
      )
    }

    case 'fund-from-member': {
      const value = request.request

      if (!object(value) || !exact(value, ['schemaVersion', 'requestId', 'protons']) || value.schemaVersion !== 2) {
        return invalid()
      }

      // The answer is the transfer and the company wallet; it carries no provider URL.
      return context.funding({
        action: 'funding-member-fund',
        companyId: request.companyId,
        requestId: value.requestId,
        protons: value.protons
      })
    }

    case 'read-pending-fund':
      return context.funding({ action: 'funding-member-fund-pending', companyId: request.companyId })

    case 'read-order':
      return rendererSafeOrder(
        await context.funding({ action: 'funding-order', companyId: request.companyId, orderId: request.orderId })
      )
    case 'open-order': {
      const order = await context.funding({
        action: 'funding-order',
        companyId: request.companyId,
        orderId: request.orderId
      })

      if (!object(order) || order.orderId !== request.orderId || order.state !== 'pending'
        || !isTrustedPayOSUrl(order.checkoutUrl)) {
        throw new MatrixCompanyNativeError('invalid')
      }

      await context.openExternal(order.checkoutUrl)

      return null
    }
  }
}

function parseRequest(value: unknown): MatrixCompanyDesktopRequest {
  if (!object(value) || typeof value.action !== 'string') {
    return invalid()
  }

  const companyId = uuid(value.companyId)

  switch (value.action) {
    case 'read-board-view':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-board-view', companyId }

    case 'list-board':
      if (!exact(value, ['action', 'companyId', 'filters']) || !object(value.filters)) {
        return invalid()
      }

      return {
        action: 'list-board',
        companyId,
        filters: value.filters as Extract<MatrixCompanyDesktopRequest, { action: 'list-board' }>['filters']
      }

    case 'read-board-card':
      if (!exact(value, ['action', 'companyId', 'cardId'])) {
        return invalid()
      }

      return { action: 'read-board-card', companyId, cardId: uuid(value.cardId) }

    case 'search-board':
      if (!exact(value, ['action', 'companyId', 'filters']) || !object(value.filters)) {
        return invalid()
      }

      return {
        action: 'search-board',
        companyId,
        filters: value.filters as Extract<MatrixCompanyDesktopRequest, { action: 'search-board' }>['filters']
      }

    case 'read-board-activity':
      if (!exact(value, ['action', 'companyId', 'cardId', 'cursor'])) {
        return invalid()
      }

      return {
        action: 'read-board-activity',
        companyId,
        cardId: uuid(value.cardId),
        cursor: value.cursor as string | null
      }

    case 'command-board':
      if (
        !exact(value, ['action', 'companyId', 'contractVersion', 'command']) ||
        !['1', '1.1'].includes(String(value.contractVersion))
      ) {
        return invalid()
      }

      return {
        action: 'command-board',
        companyId,
        contractVersion: value.contractVersion as '1' | '1.1',
        command: value.command
      }

    case 'open-board-attachment':
      if (!exact(value, ['action', 'companyId', 'file'])) {
        return invalid()
      }

      return { action: 'open-board-attachment', companyId, file: value.file }

    case 'read-project-brain':
      if (!exact(value, ['action', 'companyId', 'projectId'])) {
        return invalid()
      }

      return { action: 'read-project-brain', companyId, projectId: uuid(value.projectId) }

    case 'correct-project-brain':
      if (!exact(value, ['action', 'companyId', 'projectId', 'request'])) {
        return invalid()
      }

      return { action: 'correct-project-brain', companyId, projectId: uuid(value.projectId), request: value.request }

    case 'open-citation':
      if (!exact(value, ['action', 'companyId', 'citation'])) {
        return invalid()
      }

      return { action: 'open-citation', companyId, citation: value.citation }

    case 'read-ai':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-ai', companyId }

    case 'configure-ai':
      if (!exact(value, ['action', 'companyId', 'request'])) {
        return invalid()
      }

      return { action: 'configure-ai', companyId, request: value.request }

    case 'read-private-cos':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-private-cos', companyId }

    case 'read-private-cos-capability':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-private-cos-capability', companyId }

    case 'ensure-private-cos':
      if (!exact(value, ['action', 'companyId', 'request'])) {
        return invalid()
      }

      return { action: 'ensure-private-cos', companyId, request: value.request }

    case 'read-private-cos-receipt':
      if (!exact(value, ['action', 'companyId', 'runId'])) {
        return invalid()
      }

      return { action: 'read-private-cos-receipt', companyId, runId: uuid(value.runId) }

    case 'stop-private-cos':
      if (!exact(value, ['action', 'companyId', 'runId', 'request'])) {
        return invalid()
      }

      return { action: 'stop-private-cos', companyId, runId: uuid(value.runId), request: value.request }

    case 'read-wallet':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-wallet', companyId }

    case 'read-packs':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-packs', companyId }

    case 'create-order':
      if (!exact(value, ['action', 'companyId', 'request'])) {
        return invalid()
      }

      return { action: 'create-order', companyId, request: value.request }

    case 'fund-from-member':
      if (!exact(value, ['action', 'companyId', 'request'])) {
        return invalid()
      }

      return { action: 'fund-from-member', companyId, request: value.request }

    case 'read-pending-fund':
      if (!exact(value, ['action', 'companyId'])) {
        return invalid()
      }

      return { action: 'read-pending-fund', companyId }

    case 'read-order':
      if (!exact(value, ['action', 'companyId', 'orderId'])) {
        return invalid()
      }

      return { action: 'read-order', companyId, orderId: uuid(value.orderId) }

    case 'open-order':
      if (!exact(value, ['action', 'companyId', 'orderId'])) {
        return invalid()
      }

      return { action: 'open-order', companyId, orderId: uuid(value.orderId) }

    default:
      return invalid()
  }
}

export async function handleMatrixCompanyDesktop(
  input: unknown,
  context: MatrixCompanyDesktopContext
): Promise<MatrixCompanyDesktopResult> {
  const refused = gate(context)

  if (refused) {
    return refused
  }

  try {
    const value = await dispatch(context, parseRequest(input))

    return { ok: true, value: value ?? null }
  } catch (error) {
    return refusal(error)
  }
}

import type {
  MatrixCompanyMutation,
  MatrixCompanyNativeFamily,
  MatrixCompanyNativeResult,
  MatrixCompanyPendingResult,
  MatrixCompanyRequest,
  MatrixCompanyResult
} from '../../shared/matrix-company'
import { MatrixCompanyNativeError } from '../../shared/matrix-company-ai'
import { MatrixCompanyFundingMemberError } from '../../shared/matrix-company-funding'

import { MatrixCompanyError, parseMatrixCompanyRequest } from './company'
import { requireMatrixCaller } from './ipc-policy'

export interface MatrixCompanyCommandContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  enabled: boolean
  fundingEnabled?: boolean
  projectSourcesEnabled?: boolean
  projectReaderEnabled?: boolean
  closing: boolean
  available: () => boolean
  request: (input: MatrixCompanyRequest) => Promise<Extract<MatrixCompanyResult, { ok: true }>['value']>
}

/** The actual Company IPC branch, separated so caller and intent fences can be exercised. */
export async function handleMatrixCompanyCommand(input: unknown, context: MatrixCompanyCommandContext): Promise<MatrixCompanyResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (!context.enabled || context.closing) {
    return { ok: false, error: 'unavailable' }
  }

  if (!context.available()) {
    return { ok: false, error: 'authentication' }
  }

  try {
    const request = parseMatrixCompanyRequest(input)

    if ((request.action === 'wallet' || request.action === 'funding') && !context.fundingEnabled) {
      return { ok: false, error: 'unavailable' }
    }
    if (['project-sources', 'include-project-channel-source', 'include-project-file-source',
      'withdraw-project-source'].includes(request.action) && !context.projectSourcesEnabled) {
      return { ok: false, error: 'unavailable' }
    }
    if (request.action === 'project-reader' && !context.projectReaderEnabled) {
      return { ok: false, error: 'unavailable' }
    }

    return { ok: true, value: await context.request(request) }
  } catch (error) {
    if (error instanceof Error && error.message === 'matrix_domain_signed_out') {
      return { ok: false, error: 'authentication' }
    }

    return error instanceof MatrixCompanyError
      ? { ok: false, error: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
          ...(error.reason ? { reason: error.reason } : {}) }
      : { ok: false, error: 'unavailable' }
  }
}


export async function handleMatrixCompanyPending(context: Omit<MatrixCompanyCommandContext, 'request'> & {
  pending: () => MatrixCompanyMutation | null
}): Promise<MatrixCompanyPendingResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (!context.enabled || context.closing) { return { ok: false, error: 'unavailable' } }

  if (!context.available()) { return { ok: false, error: 'authentication' } }

  try {
    return { ok: true, request: context.pending() }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === 'matrix_domain_signed_out' ? 'authentication' : 'unavailable' }
  }
}

export interface MatrixCompanyNativeCommandContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  enabled: boolean
  closing: boolean
  available: () => boolean
  request: (family: MatrixCompanyNativeFamily, value: unknown) => Promise<unknown>
}

/**
 * The Release B native branch (`company-native`). Families are closed here; the
 * account client parses each request again before any I/O, so a renderer cannot
 * widen a family or smuggle an actor/payer/room field through this seam.
 */
export async function handleMatrixCompanyNativeCommand(
  input: { family?: unknown; request?: unknown },
  context: MatrixCompanyNativeCommandContext
): Promise<MatrixCompanyNativeResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (!context.enabled || context.closing) {
    return { ok: false, error: 'unavailable' }
  }

  if (!context.available()) {
    return { ok: false, error: 'authentication' }
  }

  const family = input.family

  if (family !== 'ai' && family !== 'funding' && family !== 'board' && family !== 'project-brain') {
    return { ok: false, error: 'invalid' }
  }

  try {
    return { ok: true, value: (await context.request(family, input.request)) as Extract<MatrixCompanyNativeResult, { ok: true }>['value'] }
  } catch (error) {
    if (error instanceof Error && error.message === 'matrix_domain_signed_out') {
      return { ok: false, error: 'authentication' }
    }

    if (error instanceof MatrixCompanyNativeError) {
      return {
        ok: false,
        error: error.code,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        ...(error instanceof MatrixCompanyFundingMemberError ? { member: true as const } : {})
      }
    }

    return { ok: false, error: 'unavailable' }
  }
}

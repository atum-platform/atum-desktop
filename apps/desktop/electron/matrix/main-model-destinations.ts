import { MATRIX_MODELS, type MatrixModelDestinationsView, type MatrixModelId } from '../../shared/matrix-models'

import {
  type MatrixManagedEffort,
  type MatrixModelDestinations,
  parseMatrixDailyProtons
} from './model-destinations'
import { MATRIX_PROVIDER_MODEL_ID_PATTERN } from './provider-connections'

/** The `matrix:ui` `modelDestinations` request, narrowed to the fields its handler reads. */
export interface MatrixModelDestinationsIpcRequest {
  action?: unknown
  agentPrincipal?: unknown
  destination?: unknown
  model?: unknown
  effort?: unknown
  source?: unknown
  dailyProtons?: unknown
}

export interface MatrixModelDestinationsIpcContext {
  destinations: MatrixModelDestinations | undefined
  closing: boolean
  signedIn: boolean
  /** Whether this account has an open agent whose cloud principal is exactly `principal`. */
  open(principal: string): boolean
  /** A saved cloud row is the composer's own choice: refresh its offer, if one is live. */
  cloudChoiceSaved?(principal: string): void
}

/**
 * The one authority gate `modelDestinations` read, write and `cap` share: a live destinations
 * service, a signed-in account, and a string principal naming one of this account's open agents.
 * Every action is refused the same way (`matrix_model_destinations_unavailable`), so adding or
 * splitting an action can never leave one less fenced than the others.
 */
export function requireMatrixModelDestinations<T>(input: {
  destinations: T | undefined
  closing: boolean
  signedIn: boolean
  principal: unknown
  open(principal: string): boolean
}): { destinations: T; principal: string } {
  if (
    !input.destinations ||
    input.closing ||
    !input.signedIn ||
    typeof input.principal !== 'string' ||
    !input.open(input.principal)
  ) {
    throw new Error('matrix_model_destinations_unavailable')
  }

  return { destinations: input.destinations, principal: input.principal }
}

/** `matrix:ui` `modelDestinations`: read, write or cap one of this account's open agents. */
export async function handleMatrixModelDestinationsRequest(
  request: MatrixModelDestinationsIpcRequest,
  context: MatrixModelDestinationsIpcContext
): Promise<MatrixModelDestinationsView | undefined | { status: 'saved' | 'refused' }> {
  const { destinations, principal } = requireMatrixModelDestinations({
    destinations: context.destinations,
    closing: context.closing,
    signedIn: context.signedIn,
    principal: request.agentPrincipal,
    open: context.open
  })

  if (request.action === 'read') {
    return destinations.read(principal)
  }

  if (
    request.action === 'write' &&
    typeof request.destination === 'string' &&
    typeof request.model === 'string' &&
    (MATRIX_MODELS as readonly string[]).includes(request.model)
  ) {
    const saved = await destinations.write(principal, request.destination, request.model as MatrixModelId)

    // A cloud row is the same 0226 choice the composer writes; re-read its offer so the chip
    // and this row can never show different models.
    if (saved && request.destination === 'cloud') {
      context.cloudChoiceSaved?.(principal)
    }

    return { status: saved ? 'saved' : 'refused' }
  }

  if (
    request.action === 'writeSubscription' &&
    (request.source === 'opencode_go' || request.source === 'chatgpt_plan') &&
    typeof request.model === 'string' &&
    MATRIX_PROVIDER_MODEL_ID_PATTERN.test(request.model) &&
    (request.effort === 'low' || request.effort === 'medium' || request.effort === 'high')
  ) {
    const saved = await destinations.writeSubscription(principal, request.source, request.model,
      request.effort as MatrixManagedEffort)

    if (saved) {
      context.cloudChoiceSaved?.(principal)
    }

    return { status: saved ? 'saved' : 'refused' }
  }

  if (request.action === 'cap') {
    const dailyProtons = parseMatrixDailyProtons(request.dailyProtons)

    if (dailyProtons === undefined) {
      throw new Error('matrix_command_invalid')
    }

    const saved = await destinations.cap(principal, dailyProtons)

    return { status: saved ? 'saved' : 'refused' }
  }

  throw new Error('matrix_command_invalid')
}

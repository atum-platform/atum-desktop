import { type ManagedModelAccessAlias, parseManagedModelAccessAlias } from '@/lib/atum-managed-model-access'

export const MANAGED_FAILURE_CODES = [
  'authentication_expired',
  'rate_limited',
  'provider_rate_limited',
  'provider_call_limit_exceeded',
  'insufficient_protons',
  'funding_required',
  'managed_capacity_wait',
  'managed_request_in_progress',
  'managed_request_outcome_unknown',
  'managed_request_cancelled',
  'invalid_managed_request_id',
  'training_managed_route_required',
  'execution_route_changed',
  'model_requirements_conflict',
  'model_spending_confirmation_required',
  'hire_paused',
  'hire_task_required',
  'training_required',
  'training_unavailable',
  'training_task_invalid',
  'training_context_unavailable',
  'managed_request_conflict',
  'managed_retry_exhausted',
  'managed_dispatch_rejected',
  'managed_response_expired',
  'managed_request_recovery_corrupt',
  'managed_request_recovery_unavailable',
  'denied',
  'model_reserved',
  'managed_model_disabled',
  'reconciliation_pending',
  'reservation_active',
  'managed_turn_in_progress',
  'managed_request_too_large',
  'invalid_managed_request',
  'unsupported_managed_parameter',
  'managed_model_transport_failed',
  'managed_model_invalid_response',
  'managed_model_unavailable',
  'managed_proxy_authentication_required',
  'managed_proxy_unavailable'
] as const

export type ManagedFailureCode = (typeof MANAGED_FAILURE_CODES)[number]
export type ManagedFailureRecovery =
  | 'reauthenticate'
  | 'retry'
  | 'review_access'
  | 'review_training'
  | 'review_hiring'
  | 'review_account'
  | 'edit_request'
  | 'wait_for_turn'
  | 'repair'
  | 'pause'

export interface ManagedModelFailure {
  version: 1
  code: ManagedFailureCode
  access_alias: ManagedModelAccessAlias
  phase: 'pre_dispatch' | 'post_dispatch' | 'unknown'
  recovery: ManagedFailureRecovery
  transient: boolean
  preserve_draft: boolean
}

const FAILURE_COPY: Record<ManagedFailureCode, { message: string; action: string }> = {
  authentication_expired: {
    message: 'Your Atum sign-in expired before this question was sent.',
    action: 'Sign in and retry'
  },
  rate_limited: {
    message: 'This question was not sent because managed access is temporarily rate limited.',
    action: 'Retry'
  },
  provider_rate_limited: { message: 'The model was busy after the question was sent.', action: 'Retry' },
  provider_call_limit_exceeded: {
    message: 'This turn grew too large for a single model request.',
    action: 'Start a new chat'
  },
  insufficient_protons: {
    message: 'Add Protons to continue. The work done so far is saved.',
    action: 'Add Protons'
  },
  funding_required: { message: 'Add Protons to use this model.', action: 'Add Protons' },
  managed_capacity_wait: {
    message: 'This task is waiting for Atum to become available. Your work is saved.',
    action: 'Check task'
  },
  managed_request_in_progress: {
    message: 'Atum is still working on this request. Your progress is saved.',
    action: 'View task'
  },
  managed_request_outcome_unknown: {
    message: 'Atum lost the response and paused this task to avoid repeating work. Your progress is saved.',
    action: 'View task'
  },
  managed_request_cancelled: { message: 'This request was stopped. Your progress is saved.', action: 'View task' },
  training_managed_route_required: { message: 'This training runs with an Atum model. Choose an Atum model to continue this task.', action: 'Choose model' },
  execution_route_changed: { message: 'The AI model for this conversation has changed. Start a new task to continue; your history is saved.', action: 'Review employee' },
  model_requirements_conflict: { message: 'The AI model this employee needs is currently unavailable. Your question was not sent.', action: 'Review employee' },
  model_spending_confirmation_required: { message: 'This work needs a higher AI tier. Start a new task and choose a higher tier to continue.', action: 'Choose an AI tier' },
  hire_task_required: { message: 'Start a new task from this employee in Discover to use their training.', action: 'Review employee' },
  hire_paused: { message: 'This employee is paused. Review their monthly hiring to continue. Their work and training are saved.', action: 'Review hiring' },
  training_required: { message: 'This employee needs this training before continuing. Check their training in Discover.', action: 'Review training' },
  training_unavailable: { message: 'Atum could not load this training. Your question was not sent. Try again shortly.', action: 'Retry' },
  training_task_invalid: { message: 'This task could not be connected to its training. Start it again from the skill in Discover.', action: 'Review training' },
  training_context_unavailable: { message: 'This task needs more room for its training. Start a shorter task with an Atum model.', action: 'Review question' },
  managed_request_conflict: { message: 'Atum paused this task because its saved request no longer matches. Your progress is saved.', action: 'View task' },
  managed_retry_exhausted: { message: 'The model is still busy after several attempts. Your question was not sent.', action: 'Retry' },
  managed_dispatch_rejected: { message: 'Atum could not start this request. Your question was not sent.', action: 'Retry' },
  managed_response_expired: { message: 'This task’s recovery response has expired. Atum paused it to avoid repeating work.', action: 'View task' },
  managed_request_recovery_corrupt: { message: 'Atum could not read this task’s saved recovery state. The task is paused to avoid repeating work.', action: 'View task' },
  managed_request_recovery_unavailable: { message: 'Atum’s saved recovery data needs repair. Your work has been preserved. Contact support before retrying.', action: 'Review account' },
  denied: { message: 'This account does not have access to the requested work.', action: 'Review access' },
  model_reserved: { message: 'This model is not available for this task. Choose another Atum model.', action: 'Choose model' },
  invalid_managed_request_id: { message: 'Atum could not identify this request. Your question was not sent.', action: 'Review question' },
  managed_model_disabled: {
    message: 'The model is temporarily paused. Your question was not sent.',
    action: 'Retry'
  },
  reconciliation_pending: {
    message: 'Atum is reconciling earlier usage. Your question was not sent.',
    action: 'Retry'
  },
  reservation_active: {
    message: 'Another model turn is still settling. This question was not sent.',
    action: 'Retry when ready'
  },
  managed_turn_in_progress: {
    message: 'Another model turn is already running. This question was not sent.',
    action: 'Retry when ready'
  },
  managed_request_too_large: {
    message: 'This question is too large for the model and was not sent.',
    action: 'Edit question'
  },
  invalid_managed_request: {
    message: 'This question contains an invalid model request and was not sent.',
    action: 'Edit question'
  },
  unsupported_managed_parameter: {
    message: 'This question requested an option the model does not support.',
    action: 'Edit question'
  },
  managed_model_transport_failed: {
    message: 'The connection to the model failed. It is safe to retry.',
    action: 'Retry'
  },
  managed_model_invalid_response: {
    message: 'The model returned an unreadable response. It is safe to retry.',
    action: 'Retry'
  },
  managed_model_unavailable: { message: 'The model is temporarily unavailable.', action: 'Retry' },
  managed_proxy_authentication_required: {
    message: 'The local model connection needs repair before this question can be sent.',
    action: 'Repair'
  },
  managed_proxy_unavailable: {
    message: 'The local model service could not start. Your question was not sent.',
    action: 'Repair'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function parseManagedModelFailure(value: unknown): ManagedModelFailure | null {
  const input = record(value)

  if (
    !input ||
    Object.keys(input).some(
      key => !['version', 'code', 'access_alias', 'phase', 'recovery', 'transient', 'preserve_draft'].includes(key)
    )
  ) {
    return null
  }

  const alias = parseManagedModelAccessAlias(input.access_alias)

  if (
    input.version !== 1 ||
    !MANAGED_FAILURE_CODES.includes(input.code as ManagedFailureCode) ||
    !alias ||
    !['pre_dispatch', 'post_dispatch', 'unknown'].includes(String(input.phase)) ||
    !['reauthenticate', 'retry', 'review_access', 'review_training', 'review_hiring', 'review_account', 'edit_request', 'wait_for_turn', 'repair', 'pause'].includes(
      String(input.recovery)
    ) ||
    typeof input.transient !== 'boolean' ||
    typeof input.preserve_draft !== 'boolean'
  ) {
    return null
  }

  // Unknown or active outcomes cannot be turned into a replay button by a
  // malformed/upstream recovery hint. The dispatch layer owns reconciliation.
  const pause = ['managed_request_outcome_unknown', 'managed_request_in_progress', 'managed_request_cancelled', 'managed_request_conflict', 'managed_response_expired', 'managed_request_recovery_corrupt'].includes(String(input.code))

  return { ...input, access_alias: alias, ...(pause ? { recovery: 'pause', transient: false } : {}) } as ManagedModelFailure
}

export function managedModelFailureCopy(failure: ManagedModelFailure) {
  return FAILURE_COPY[failure.code]
}

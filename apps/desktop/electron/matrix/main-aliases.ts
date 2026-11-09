import type { MatrixAliasChange, MatrixAliasPendingResult, MatrixAliasRequest, MatrixAliasResult, MatrixAliasView } from '../../shared/matrix-aliases'

import { MatrixAliasError, parseMatrixAliasRequest } from './aliases'
import { requireMatrixCaller } from './ipc-policy'

interface AliasContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  closing: boolean
  available(): boolean
  /** One tagged line per answered request, for main.log. */
  log?(line: string): void
}

const CHECK_CODES = new Set(['alias_invalid', 'alias_bot_suffix_required', 'alias_bot_suffix_reserved', 'alias_reserved', 'alias_unavailable'])
const ACTIONS = new Set(['current', 'check', 'lookup', 'search', 'contacts', 'claim', 'rename'])

/**
 * `[Matrix] handle action=claim target=agent outcome=error code=conflict`: closed values only.
 * Never the handle, the assistant ID or the request ID: a new assistant's automatic handle shows
 * here as its current → check… → claim sequence.
 */
export function matrixAliasLogLine(input: unknown, result: MatrixAliasResult): string {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const action = typeof fields.action === 'string' && ACTIONS.has(fields.action) ? fields.action : 'other'
  const target = typeof fields.assistantId === 'string' ? 'agent' : 'person'

  if (result.ok === false) {
    // A failed contacts read says how many IDs it carried (never which), so a run of 400s shows.
    const asked = action === 'contacts' && Array.isArray(fields.matrixUsers) ? ` asked=${fields.matrixUsers.length}` : ''

    return `[Matrix] handle action=${action} target=${target} outcome=error code=${result.error}${asked}`
  }

  const value = result.value

  if (value.kind === 'check') {
    const code = value.code === null ? 'none' : CHECK_CODES.has(value.code) ? value.code : 'other'

    return `[Matrix] handle action=check target=${target} outcome=ok available=${value.available} code=${code}`
  }

  if (value.kind === 'current') {
    return `[Matrix] handle action=current target=${target} outcome=ok assigned=${value.alias !== null}`
  }

  if (value.kind === 'contacts') {
    // How many were asked and how many had a handle: never who.
    return `[Matrix] handle action=contacts target=${target} outcome=ok asked=${value.contacts.length} found=${value.contacts.filter(contact => contact.handle !== null).length}`
  }

  if (value.kind === 'claim' || value.kind === 'rename') {
    return `[Matrix] handle action=${value.kind} target=${target} outcome=ok replayed=${value.replayed === true}`
  }

  return `[Matrix] handle action=${action} target=${target} outcome=ok`
}

export async function handleMatrixAliasRequest(input: unknown, context: AliasContext & { request(input: MatrixAliasRequest): Promise<MatrixAliasView> }): Promise<MatrixAliasResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)
  const result = await answerMatrixAliasRequest(input, context)

  try { context.log?.(matrixAliasLogLine(input, result)) } catch { /* Diagnostics only. */ }

  return result
}

async function answerMatrixAliasRequest(input: unknown, context: AliasContext & { request(input: MatrixAliasRequest): Promise<MatrixAliasView> }): Promise<MatrixAliasResult> {
  if (context.closing) { return { ok: false, error: 'unavailable' } }

  if (!context.available()) { return { ok: false, error: 'authentication' } }

  try { return { ok: true, value: await context.request(parseMatrixAliasRequest(input)) } }
  catch (error) {
    if (error instanceof MatrixAliasError) { return { ok: false, error: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } }

    return { ok: false, error: error instanceof Error && error.message === 'matrix_domain_signed_out' ? 'authentication' : 'unavailable' }
  }
}

/**
 * `[Matrix] handle action=pending outcome=ok held=claim target=agent`: whether a change whose
 * answer was lost is still kept (and so blocks every different one). Closed values only.
 */
export function matrixAliasPendingLogLine(result: MatrixAliasPendingResult): string {
  if (result.ok === false) {
    return `[Matrix] handle action=pending outcome=error code=${result.error}`
  }

  const held = result.request
  const target = !held ? 'none' : held.assistantId ? 'agent' : 'person'

  return `[Matrix] handle action=pending outcome=ok held=${held?.action ?? 'none'} target=${target}`
}

export async function handleMatrixAliasPending(context: AliasContext & { pending(): MatrixAliasChange | null }): Promise<MatrixAliasPendingResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)
  const result = answerMatrixAliasPending(context)

  try { context.log?.(matrixAliasPendingLogLine(result)) } catch { /* Diagnostics only. */ }

  return result
}

function answerMatrixAliasPending(context: AliasContext & { pending(): MatrixAliasChange | null }): MatrixAliasPendingResult {
  if (context.closing) { return { ok: false, error: 'unavailable' } }

  if (!context.available()) { return { ok: false, error: 'authentication' } }

  try { return { ok: true, request: context.pending() } }
  catch { return { ok: false, error: 'unavailable' } }
}

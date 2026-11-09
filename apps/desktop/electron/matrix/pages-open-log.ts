/**
 * One closed-code main.log line per management-page open (Connections, Skills, …):
 * `[Matrix] pages open page=<id> agent=<id8> outcome=<code> ms=<n>`. Before 0.19.4b an open
 * that failed left nothing in main.log; the person saw only "Chưa mở được trang này.".
 */

export type MatrixPagesOpenOutcome =
  | 'opened'
  | 'invalid'
  | 'cloud_agent'
  | 'agent_not_running'
  | 'agent_unavailable'
  | 'load_failed'
  | 'superseded'
  | 'refused'
  | 'failed'

const CODES: Record<string, MatrixPagesOpenOutcome> = {
  pages_invalid_request: 'invalid',
  pages_agent_cloud: 'cloud_agent',
  pages_agent_not_running: 'agent_not_running',
  pages_agent_unavailable: 'agent_unavailable',
  matrix_pages_load_failed: 'load_failed',
  matrix_pages_unavailable: 'superseded',
  matrix_pages_request_forbidden: 'refused'
}

/** The closed outcome for an open's result: its view, or the error code main returned. */
export function matrixPagesOpenOutcome(result: unknown): MatrixPagesOpenOutcome {
  if (result !== null && typeof result === 'object' && 'error' in result) {
    const code = (result as { error: unknown }).error

    return typeof code === 'string' ? (CODES[code] ?? 'failed') : 'failed'
  }

  return result !== null && typeof result === 'object' && 'viewId' in result ? 'opened' : 'failed'
}

export function matrixPagesOpenLogLine(input: { page: unknown; agentPrincipal: unknown; result: unknown; ms: number }): string {
  const page = typeof input.page === 'string' && /^[a-z][a-z-]{0,31}$/u.test(input.page) ? input.page : 'unknown'

  const agent =
    typeof input.agentPrincipal !== 'string'
      ? 'default'
      : /^[A-Za-z0-9]{8}/u.test(input.agentPrincipal)
        ? input.agentPrincipal.slice(0, 8)
        : 'other'

  return `[Matrix] pages open page=${page} agent=${agent} outcome=${matrixPagesOpenOutcome(input.result)} ms=${Math.max(0, Math.round(input.ms))}`
}

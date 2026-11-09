import { randomBytes } from 'node:crypto'

export type MatrixSubscriptionCatalogPhase =
  | 'custom_endpoints'
  | 'environment'
  | 'model_info'
  | 'model_options'
  | 'oauth_catalog'

export type MatrixSubscriptionStatusClass =
  | 'cancelled'
  | 'http_4xx'
  | 'http_5xx'
  | 'invalid_response'
  | 'ok'
  | 'pending'
  | 'timeout'
  | 'transport_error'
  | 'unknown'

export type MatrixSubscriptionProviderStartOutcome = 'code_ready' | 'http_error' | 'timeout' | 'transport_error'
export type MatrixSubscriptionFollowUpMarker = 'agent_refresh' | 'relay_publication'

interface HttpErrorShape {
  httpStatus?: unknown
}

function elapsed(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function httpStatus(value: unknown): number | undefined {
  const status = (value as HttpErrorShape | null)?.httpStatus

  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

export function matrixSubscriptionRequestStatus(error: unknown): MatrixSubscriptionStatusClass {
  const status = httpStatus(error)

  if (status !== undefined) {
    return status < 500 ? 'http_4xx' : 'http_5xx'
  }

  const name = error instanceof Error ? error.name : ''
  const code = error instanceof Error ? error.message : ''

  if (name === 'TimeoutError' || code === 'pages_request_timeout') {
    return 'timeout'
  }

  if (name === 'AbortError' || code === 'matrix_pages_agent_unavailable') {
    return 'cancelled'
  }

  if (['matrix_provider_response_invalid', 'pages_invalid_request', 'pages_response_too_large'].includes(code)) {
    return 'invalid_response'
  }

  if (error instanceof Error) {
    return 'transport_error'
  }

  return 'unknown'
}

export function matrixSubscriptionProviderStartOutcome(
  error: unknown
): Exclude<MatrixSubscriptionProviderStartOutcome, 'code_ready'> {
  const status = matrixSubscriptionRequestStatus(error)

  if (status === 'http_4xx' || status === 'http_5xx') {
    return 'http_error'
  }

  return status === 'timeout' ? 'timeout' : 'transport_error'
}

export function matrixSubscriptionHttpStatus(error: unknown): number | undefined {
  return httpStatus(error)
}

/**
 * One closed-class diagnostic stream for a single native ChatGPT sign-in start.
 * No method accepts provider/account identifiers, URLs, response data or error text.
 */
export class MatrixSubscriptionAuthLifecycle {
  readonly attempt = randomBytes(8).toString('hex')
  private readonly startedAt: number
  private settled = false

  constructor(
    private readonly log: (line: string) => void = line => console.warn(line),
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = now()
  }

  private emit(marker: string, fields: readonly string[] = []): void {
    try {
      this.log(`[Matrix] chatgpt_auth attempt=${this.attempt} ${marker}${fields.length ? ` ${fields.join(' ')}` : ''}`)
    } catch {
      /* Diagnostics never own execution. */
    }
  }

  subscriptionStartReceived(): void {
    this.emit('subscription_start_received')
  }

  nativeConsentResult(result: 'accepted' | 'cancelled'): void {
    this.emit(`native_consent_result=${result}`)
  }

  acknowledgmentPersisted(): void {
    this.emit('ack_persisted')
  }

  hermesSpawned(): void {
    this.emit('hermes_spawned')
  }

  hermesPortReady(elapsedMs: number): void {
    this.emit('hermes_port_ready', [`elapsed_ms=${elapsed(elapsedMs)}`])
  }

  catalogPhase(
    phase: MatrixSubscriptionCatalogPhase,
    outcome: 'begin' | 'failed' | 'ok',
    elapsedMs: number,
    statusClass: MatrixSubscriptionStatusClass
  ): void {
    this.emit(`catalog_phase=${phase}`, [
      `outcome=${outcome}`,
      `elapsed_ms=${elapsed(elapsedMs)}`,
      `status_class=${statusClass}`
    ])
  }

  providerStartDispatchBegin(): void {
    this.emit('provider_start_dispatch_begin')
  }

  providerStartDispatchEnd(outcome: MatrixSubscriptionProviderStartOutcome, elapsedMs: number, status?: number): void {
    this.emit('provider_start_dispatch_end', [
      `outcome=${outcome}`,
      `elapsed_ms=${elapsed(elapsedMs)}`,
      `http_status=${status ?? 'none'}`
    ])
  }

  openExternalEnd(outcome: 'failed' | 'ok', elapsedMs: number): void {
    this.emit('open_external_end', [`outcome=${outcome}`, `elapsed_ms=${elapsed(elapsedMs)}`])
  }

  startIpcSettled(outcome: 'cancelled' | 'failed' | 'pending'): void {
    if (this.settled) {
      return
    }

    this.settled = true
    this.emit('start_ipc_settled', [`outcome=${outcome}`, `elapsed_ms=${elapsed(this.now() - this.startedAt)}`])
  }

  followUp(marker: MatrixSubscriptionFollowUpMarker, statusClass: MatrixSubscriptionStatusClass | 'unavailable'): void {
    this.emit(marker, [`status_class=${statusClass}`])
  }

  hermesExit(exit: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }): void {
    const codeClass = exit.signal
      ? 'signal'
      : exit.code === 0
        ? 'zero'
        : typeof exit.code === 'number'
          ? 'nonzero'
          : 'unknown'
    this.emit('hermes_exit', [`intentional=${exit.intentional}`, `code_class=${codeClass}`])
  }
}

/** Only product facts cross this bridge. IDs used for dedupe stay in main. */
export const OBSERVABILITY_IPC = {
  status: 'atum:reporting:status', enabled: 'atum:reporting:enabled',
  event: 'atum:reporting:event', error: 'atum:reporting:error', feedback: 'atum:reporting:feedback',
  changed: 'atum:reporting:changed', turn: 'atum:reporting:turn'
} as const

export const PRODUCT_EVENTS = {
  app_opened: {}, app_active: {},
  app_ready: { mode: ['local', 'remote'], duration_ms: 'number' },
  matrix_shell_ready: { duration_ms: 'number' },
  matrix_sync_ready: { duration_ms: 'number' },
  matrix_signin_finished: { outcome: ['completed', 'failed', 'cancelled'] },
  matrix_message_sent: { outcome: ['completed', 'failed'] },
  onboarding_step_completed: { step: ['signin', 'setup', 'first_turn'] },
  feature_used: { feature: ['chat', 'files', 'browser', 'messaging', 'settings', 'apps', 'skills', 'voice'] },
  turn_finished: { outcome: ['completed', 'failed', 'cancelled'], duration_ms: 'number', first_token_ms: 'latency', tool_count: 'number' },
  turn_observation_lost: { reason: ['window_closed', 'connection_lost'] },
  operation_failed: { operation: ['auth', 'backend', 'connection', 'app_launch', 'tool', 'renderer', 'main'], code: ['failed', 'process_gone', 'invalid_configuration'] },
  update_available: { from_version: 'version', to_version: 'version' },
  update_downloaded: { from_version: 'version', to_version: 'version' },
  update_failed: {
    stage: ['check', 'download', 'install'],
    code: ['failed', 'disk_space', 'transport', 'hash_mismatch']
  },
  update_applied: { from_version: 'version', to_version: 'version' },
  feedback_submitted: { kind: ['report', 'helpful', 'not_helpful'] }
} as const

export type ProductEventName = keyof typeof PRODUCT_EVENTS
export interface ProductEvent {
  name: ProductEventName
  properties: Record<string, string | number>
}
export interface ReportingStatus { enabled: boolean; configured: boolean; diagnosticId: string }
export interface DiagnosticError {
  operation: 'renderer' | 'main' | 'backend'
  kind: string
  stack?: string
  /** Numeric process status only; classified reports never carry paths or content. */
  exitCode?: number
  /** Electron child-process class; only GPU and Utility are product surfaces. */
  childType?: 'GPU' | 'Utility'
}
export interface TurnObservation {
  key: string
  phase: 'start' | 'first_token' | 'tool' | 'finish' | 'lost'
  toolKey?: string
  outcome?: 'completed' | 'failed' | 'cancelled'
}
export interface ObservabilityBridge {
  status(): Promise<ReportingStatus>
  setEnabled(enabled: boolean): Promise<ReportingStatus>
  capture(event: ProductEvent): void
  error(error: DiagnosticError): void
  turn(observation: TurnObservation): void
  feedback(message: string): Promise<{ sent: boolean }>
  onChanged(callback: (status: ReportingStatus) => void): () => void
}

/** Construct a fresh allowlisted object; never forward extra renderer fields. */
export function parseProductEvent(input: unknown): ProductEvent | null {
  if (!input || typeof input !== 'object') {return null}
  const { name, properties } = input as ProductEvent

  if (typeof name !== 'string' || !Object.hasOwn(PRODUCT_EVENTS, name) || !properties || typeof properties !== 'object') {return null}
  const schema = PRODUCT_EVENTS[name] as Record<string, readonly string[] | string>

  if (Object.keys(properties).some(key => !Object.hasOwn(schema, key))) {return null}
  const clean: ProductEvent['properties'] = {}

  for (const [key, rule] of Object.entries(schema)) {
    const value = properties[key]

    if (rule === 'number' || rule === 'latency') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (rule === 'latency' ? -1 : 0) || value > 86_400_000) {return null}
    } else if (rule === 'version') {
      if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value) || value.length > 64) {return null}
    } else if (!Array.isArray(rule) || !rule.includes(value as string)) {return null}

    clean[key] = value
  }

  return { name, properties: clean }
}

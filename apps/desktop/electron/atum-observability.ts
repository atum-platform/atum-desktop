import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { type DiagnosticError, parseProductEvent, type ReportingStatus, type TurnObservation } from '../shared/atum-observability'

import { analyticsInstallationId } from './desktop-installation'
import type { AtumObservabilityConfig } from './desktop-services-config'
import { diagnosticFrames, diagnosticKind, redactSecrets } from './diagnostic-redaction'
import { processExitCode } from './process-exit'

export interface ReportingSink {
  event(name: string, properties: Record<string, unknown>): void
  error(error: {
    operation: string
    kind: string
    frames: ReturnType<typeof diagnosticFrames>
    exitCode?: number
    childType?: string
  }): void
  feedback(message: string): Promise<boolean>
  discard(): void
  endSession?(crashed: boolean, delivery?: { delivered?: boolean }): void
}

export class AtumObservability {
  private enabled = true
  private sink: ReportingSink | null = null
  private readonly id: string
  private readonly once = new Set<string>()
  private readonly turns = new Map<string, { started: number; first: number; tools: Set<string>; owners: Set<number>; lost: boolean }>()
  private readonly finished = new Set<string>()
  private activeDay = ''
  private readonly started = Date.now()

  constructor(private readonly options: {
    installationId: string; settingsPath: string; version: string; revision: string
    config: AtumObservabilityConfig | null; packaged: boolean
    composition?: 'legacy' | 'matrix'
    createSink: (enabled: () => boolean, id: string) => ReportingSink
  }) {
    this.id = analyticsInstallationId(options.installationId)

    try { this.enabled = JSON.parse(fs.readFileSync(options.settingsPath, 'utf8')).enabled === true } catch (error) {
      // Missing file means the distributed default. A damaged preference must
      // not accidentally turn a previous opt-out back on.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {this.enabled = false}
    }

    if (this.configured()) {
      try {this.sink = options.createSink(() => this.enabled, this.id)} catch { /* Reporting must not block startup. */ }
    }

    this.capture({ name: 'app_opened', properties: {} })
  }

  private configured(): boolean {
    return Boolean(this.options.config && (this.options.packaged || this.options.config.environment === 'test'))
  }

  status(): ReportingStatus { return { enabled: this.enabled, configured: Boolean(this.sink), diagnosticId: this.id } }

  setEnabled(enabled: boolean): ReportingStatus {
    if (typeof enabled !== 'boolean') {throw new Error('atum_reporting_preference_invalid')}
    // Persist before publishing success; atomic rename avoids a half-written opt-out.
    fs.mkdirSync(path.dirname(this.options.settingsPath), { recursive: true })
    const temp = `${this.options.settingsPath}.${crypto.randomUUID()}.tmp`

    try {
      fs.writeFileSync(temp, JSON.stringify({ enabled }), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, this.options.settingsPath)
    } finally {fs.rmSync(temp, { force: true })}

    this.enabled = enabled
    this.turns.clear()

    if (!enabled) {this.sink?.discard()}

    return this.status()
  }

  capture(input: unknown): void {
    if (!this.enabled || !this.sink) {return}
    const event = parseProductEvent(input)

    if (!event) {return}

    if (event.name === 'app_active') {
      const day = new Date().toISOString().slice(0, 10)

      if (day === this.activeDay) {return}
      this.activeDay = day
    }

    if (['app_opened', 'app_ready', 'feature_used', 'onboarding_step_completed'].includes(event.name)) {
      const key = `${event.name}:${JSON.stringify(event.properties)}`

      if (this.once.has(key) || (event.name === 'app_ready' && this.once.has('ready'))) {return}
      this.once.add(key)

      if (event.name === 'app_ready') {this.once.add('ready')}
    }

    this.sink.event(event.name, {
      ...event.properties, schema_version: this.options.composition === 'matrix' ? 2 : 1, event_id: crypto.randomUUID(),
      ...(this.options.composition ? { composition: this.options.composition } : {}),
      app_version: this.options.version, build_revision: this.options.revision,
      os: process.platform, arch: process.arch, environment: this.options.config?.environment,
      ...(event.name === 'app_ready' ? { duration_ms: Date.now() - this.started } : {})
    })
  }

  error(input: DiagnosticError): void {
    if (!this.enabled || !this.sink || !input || !['renderer', 'main', 'backend'].includes(input.operation)) {return}
    const exitCode = processExitCode(input.exitCode)

    this.sink.error({
      operation: input.operation, kind: diagnosticKind(input.kind), frames: diagnosticFrames(input.stack),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(input.childType === 'GPU' || input.childType === 'Utility' ? { childType: input.childType } : {})
    })
  }

  async feedback(message: unknown): Promise<{ sent: boolean }> {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 || !this.sink) {return { sent: false }}
    // Explicit submission is independent of the automatic reporting preference.
    const sent = await this.sink.feedback(redactSecrets(message.trim())).catch(() => false)

    if (sent) {this.capture({ name: 'feedback_submitted', properties: { kind: 'report' } })}

    return { sent }
  }

  turn(owner: number, input: TurnObservation): void {
    if (!this.enabled || !this.sink || !input || typeof input.key !== 'string' || input.key.length > 512 || !input.key) {return}
    const key = input.key

    if (this.finished.has(key)) {return}
    let turn = this.turns.get(key)

    if (input.phase === 'start') {
      if (!turn) {
        if (this.turns.size >= 256) {
          const oldest = this.turns.entries().next().value!

          if (!oldest[1].lost) {this.capture({ name: 'turn_observation_lost', properties: { reason: 'connection_lost' } })}
          this.turns.delete(oldest[0])
        }

        turn = { started: Date.now(), first: -1, tools: new Set(), owners: new Set(), lost: false }
        this.turns.set(key, turn)
      }

      turn?.owners.add(owner)

      return
    }

    if (!turn || !turn.owners.has(owner)) {return}

    if (input.phase === 'first_token' && turn.first < 0) {turn.first = Date.now() - turn.started}

    if (input.phase === 'tool' && typeof input.toolKey === 'string' && input.toolKey.length <= 512 && turn.tools.size < 4096) {turn.tools.add(input.toolKey)}

    if (input.phase === 'lost' && !turn.lost) {
      turn.lost = true
      this.capture({ name: 'turn_observation_lost', properties: { reason: 'connection_lost' } })

      // Unknown observation is separate from final outcome. A later terminal
      // can still settle this turn without being counted twice.
      return
    }

    if (input.phase === 'finish' && ['completed', 'failed', 'cancelled'].includes(input.outcome ?? '')) {
      this.capture({ name: 'turn_finished', properties: {
        outcome: input.outcome, duration_ms: Math.min(86_400_000, Date.now() - turn.started),
        first_token_ms: turn.first, tool_count: turn.tools.size
      } })

      if (input.outcome === 'completed') {this.capture({ name: 'onboarding_step_completed', properties: { step: 'first_turn' } })}
      this.turns.delete(key)
      this.finished.add(key)

      if (this.finished.size > 4096) {this.finished.delete(this.finished.values().next().value!)}
    }
  }

  endSession(crashed = false, delivery?: { delivered?: boolean }): void {this.sink?.endSession?.(crashed, delivery)}

  windowClosed(owner: number): void {
    for (const [key, turn] of this.turns) {
      turn.owners.delete(owner)

      if (!turn.owners.size) {
        if (!turn.lost) {this.capture({ name: 'turn_observation_lost', properties: { reason: 'window_closed' } })}
        this.turns.delete(key)
      }
    }
  }
}

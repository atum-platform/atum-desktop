import { randomUUID } from 'node:crypto'

import { AGENT_SOURCE_GATE_KEYS, type AgentSourceGate, type AgentSourceGates, type AgentSourceGateSnapshot } from '../../../../packages/device-protocol/agent-source-gates'
import { MATRIX_SOURCE_SERVICE_UPDATE_REQUIRED } from '../../shared/matrix-agent-sources'

import { MatrixSourceGateError, type MatrixSourceGateScope, RETRY_MS } from './source-gates'

export interface SourceGateWriteV2 {
  profile: 'atum.agent-source-gates/2'
  requestId: string
  expectedRevision: number
  mode: 'narrow' | 'set'
  mergeId?: string
  gates: AgentSourceGates
}

export interface SourceGateNarrowingDevice {
  deviceId: string | null
  deviceServiceId: string | null
  deviceName: string | null
  narrowedAt: number
}
export interface SourceGateSnapshotV2 extends AgentSourceGateSnapshot {
  authority?: 'legacy' | 'account'
  narrowingDevices?: Record<AgentSourceGate, SourceGateNarrowingDevice[]>
}

export function parseSourceGateSnapshotV2(value: unknown): SourceGateSnapshotV2 {
  const fail = (): never => { throw new Error('source_gates_invalid') }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {return fail()}
  const row = value as Record<string, unknown>
  const gates = row.gates as Record<string, unknown> | undefined
  const keys = Object.keys(row).sort().join(',')
  const metadata = keys === 'authority,gates,narrowingDevices,profile,revision'

  if ((!metadata && keys !== 'gates,profile,revision') ||
      !['atum.agent-source-gates/1', 'atum.agent-source-gates/2'].includes(String(row.profile)) ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !gates ||
      Object.keys(gates).sort().join(',') !== [...AGENT_SOURCE_GATE_KEYS].sort().join(',') ||
      !AGENT_SOURCE_GATE_KEYS.every(key => typeof gates[key] === 'boolean')) {return fail()}

  const snapshot: SourceGateSnapshotV2 = { profile: 'atum.agent-source-gates/1', revision: Number(row.revision), gates: { ...gates } as AgentSourceGates }

  if (!metadata) {return snapshot}
  const records = row.narrowingDevices as Record<string, unknown> | undefined

  if (row.profile !== 'atum.agent-source-gates/2' || !['legacy', 'account'].includes(String(row.authority)) ||
      !records || typeof records !== 'object' || Array.isArray(records) ||
      Object.keys(records).sort().join(',') !== [...AGENT_SOURCE_GATE_KEYS].sort().join(',')) {return fail()}

  const narrowing = {} as Record<AgentSourceGate, SourceGateNarrowingDevice[]>

  for (const gate of AGENT_SOURCE_GATE_KEYS) {
    const entries = records[gate]

    if (!Array.isArray(entries) || entries.length > 64) {return fail()}
    narrowing[gate] = entries.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {return fail()}
      const e = value as Record<string, unknown>

      if (Object.keys(e).sort().join(',') !== 'deviceId,deviceName,deviceServiceId,narrowedAt' ||
          !(e.deviceId === null || typeof e.deviceId === 'string' && /^[!-~]{1,255}$/u.test(e.deviceId)) ||
          !(e.deviceServiceId === null || typeof e.deviceServiceId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(e.deviceServiceId)) ||
          !(e.deviceName === null || typeof e.deviceName === 'string' && e.deviceName.length > 0 && e.deviceName.length <= 64 && !Array.from(e.deviceName).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) ||
          !Number.isSafeInteger(e.narrowedAt) || Number(e.narrowedAt) < 0) {return fail()}

      return { deviceId: e.deviceId, deviceServiceId: e.deviceServiceId, deviceName: e.deviceName, narrowedAt: e.narrowedAt } as SourceGateNarrowingDevice
    })
  }

  return { ...snapshot, authority: row.authority as 'legacy' | 'account', narrowingDevices: narrowing }
}

interface Dependencies {
  scope(): MatrixSourceGateScope | null
  gates(): AgentSourceGates
  assistants(signal: AbortSignal): Promise<string[]>
  read(id: string, signal: AbortSignal): Promise<SourceGateSnapshotV2>
  write(id: string, input: SourceGateWriteV2, signal: AbortSignal): Promise<AgentSourceGateSnapshot>
  seed?(): { mergeId: string; gates: AgentSourceGates }
  merged(): boolean
  markMerged(): void
  recordOverridden?(gates: AgentSourceGate[]): void
  /** Closes native policy and durably queues the new OFF before returning. */
  off(gate: AgentSourceGate): void
  pending(): AgentSourceGate[]
  clearPending(gates: AgentSourceGate[]): void
  apply(gates: AgentSourceGates): void
  changed?(): void
}
/** Reads platform authority, with durable new OFF choices taking precedence until synced. */
export class MatrixAccountSourceGates {
  private generation = 0
  private mutations = 0
  private retry?: ReturnType<typeof setTimeout>
  private retryAttempt = 0
  private active?: AbortController
  private work?: Promise<void>
  private provenance?: { scope: MatrixSourceGateScope; snapshot: SourceGateSnapshotV2 }
  heldOff(gate: AgentSourceGate): string[] {
    const held = this.provenance, scope = this.deps.scope()

    if (!held || !scope || held.scope.accountKey !== scope.accountKey || held.scope.generation !== scope.generation ||
      this.deps.gates()[gate] || held.snapshot.authority !== 'account') {return []}

    // Empty name represents a confirmed anonymous legacy writer; never expose raw IDs or invent a name.
    return [...new Set((held.snapshot.narrowingDevices?.[gate] ?? []).map(device => device.deviceName ?? ''))]
  }
  private remember(snapshot: SourceGateSnapshotV2, scope: MatrixSourceGateScope): boolean {
    const old = this.provenance

    const changed = !old || old.scope.accountKey !== scope.accountKey || old.scope.generation !== scope.generation ||
      JSON.stringify(old.snapshot) !== JSON.stringify(snapshot)

    this.provenance = { scope: { ...scope }, snapshot }

    return changed
  }
  constructor(private readonly deps: Dependencies) {}
  stop(): void {
    this.provenance = undefined
    clearTimeout(this.retry)
    this.retry = undefined
    this.retryAttempt = 0
    this.generation++
    this.active?.abort()
    this.work = undefined
  }
  async refreshRead(): Promise<void> {
    if (this.mutations) {return}
    this.reconcile()
    await this.work
  }
  reconcile(): void {
    if (this.work || this.mutations || this.retry) {return}
    const abort = new AbortController()
    this.active = abort

    const work = this.refresh(abort.signal, ++this.generation).then(() => {}).catch(() => {}).finally(() => {
      if (this.work === work) {this.work = undefined; this.retryPending()}
    })

    this.work = work
  }
  private retryPending(): void {
    if (!this.deps.pending().length) {this.retryAttempt = 0;

 return}

    const scope = this.deps.scope()

    if (!scope) {return}
    this.retry = setTimeout(() => {
      this.retry = undefined
      const current = this.deps.scope()

      if (current?.accountKey === scope.accountKey && current.generation === scope.generation) {this.reconcile()}
    }, RETRY_MS[Math.min(this.retryAttempt++, RETRY_MS.length - 1)])
    this.retry.unref?.()
  }

  private async refresh(signal: AbortSignal, generation: number) {
    const scope = this.deps.scope()

    if (!scope) {throw new Error('source_gates_unavailable')}

    const current = () => {
      signal.throwIfAborted()

      if (generation !== this.generation) {throw new Error('source_gates_superseded')}
      const next = this.deps.scope()

      if (!next || next.accountKey !== scope.accountKey || next.generation !== scope.generation) {throw new Error('source_gates_stale')}
    }

    const local = this.deps.gates()
    const id = (await this.deps.assistants(signal))[0]
    current()

    if (!id) {return undefined}
    let snapshot = await this.deps.read(id, signal)
    let wrote = false
    current()

    // Pre-0427 Shell may ignore the profile header. Never spin v2 merge writes at it.
    if (!snapshot.authority) {
      throw new Error(`${MATRIX_SOURCE_SERVICE_UPDATE_REQUIRED}: Atum needs a service update before these settings can sync. Your off choices stay private.`)
    }

    if (!this.deps.merged()) {
      const seed = this.deps.seed?.() ?? { mergeId: randomUUID(), gates: local }

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          snapshot = await this.deps.write(id, { profile: 'atum.agent-source-gates/2', requestId: randomUUID(),
            expectedRevision: snapshot.revision, mode: 'narrow', mergeId: seed.mergeId, gates: seed.gates }, signal)
          current()
          wrote = true
          // A 200 is a final receipt, including Settings-wins takeover and replay.
          // Persist notice evidence before marking done or applying any widened gate.
          this.deps.recordOverridden?.(AGENT_SOURCE_GATE_KEYS.filter(key => !seed.gates[key] && snapshot.gates[key] && !this.deps.pending().includes(key)))
          this.deps.markMerged()

          break
        } catch (error) {
          current()

          if (!(error instanceof MatrixSourceGateError) || error.code !== 'conflict' || attempt === 1) {throw error}
          snapshot = await this.deps.read(id, signal)
        }
      }
    }

    // New explicit OFF choices are not upgrade imports. Flush them without mergeId
    // BEFORE applying a server map, even when the import's 200 retained account ON.
    const pending = this.deps.pending()

    if (pending.length) {
      const gates = { ...snapshot.gates }

      for (const gate of pending) {gates[gate] = false}
      snapshot = await this.deps.write(id, { profile: 'atum.agent-source-gates/2', requestId: randomUUID(),
        expectedRevision: snapshot.revision, mode: 'narrow', gates }, signal)
      current()
      wrote = true

      if (pending.some(gate => snapshot.gates[gate])) {throw new Error('source_gates_pending_narrow')}
      this.deps.clearPending(pending)
    }

    if (wrote) {
      snapshot = await this.deps.read(id, signal)
      current()

      if (pending.some(gate => snapshot.gates[gate])) {throw new Error('source_gates_pending_narrow')}
    }

    current()
    const changed = this.remember(snapshot, scope)
    this.deps.apply(snapshot.gates)

    if (changed) {this.deps.changed?.()}

    return { id, snapshot, current }
  }
  async set(gate: AgentSourceGate, enabled: boolean): Promise<void> {
    this.mutations++

    try {
      await this.setChoice(gate, enabled)
    } finally {
      this.mutations--

      if (!this.mutations && this.deps.pending().length) {this.reconcile()}
    }
  }
  private async setChoice(gate: AgentSourceGate, enabled: boolean): Promise<void> {
    this.stop()

    if (!enabled) {
      this.deps.off(gate)
      this.deps.changed?.()
      this.reconcile()

      return
    }

    const abort = new AbortController()
    this.active = abort
    const state = await this.refresh(abort.signal, ++this.generation)

    if (!state) {
      // First run without an assistant: retain the local choice for later import.
      this.deps.clearPending([gate])
      this.deps.apply({ ...this.deps.gates(), [gate]: true })
      this.deps.changed?.()

      return
    }

    await this.deps.write(state.id, { profile: 'atum.agent-source-gates/2', requestId: randomUUID(),
      expectedRevision: state.snapshot.revision, mode: 'set', gates: { ...state.snapshot.gates, [gate]: true } }, abort.signal)

    state.current()
    const result = await this.deps.read(state.id, abort.signal)
    state.current()
    const scope = this.deps.scope()

    if (!scope) {throw new Error('source_gates_stale')}
    this.remember(result, scope)
    this.deps.apply(result.gates)
    this.deps.changed?.()

    if (!result.gates[gate]) {throw new Error('source_gates_set_refused')}
  }
}

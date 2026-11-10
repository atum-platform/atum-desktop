import { randomUUID } from 'node:crypto'

import {
  AGENT_SOURCE_GATES_PROFILE,
  type AgentSourceGates,
  type AgentSourceGateSnapshot,
  type AgentSourceGateWrite,
  parseAgentSourceGateWrite,
  parseAgentSourceGateWriteConflict,
  sameAgentSourceGates
} from '../../../../packages/device-protocol/agent-source-gates'

import { readDomainJson } from './domain'
import { parseSourceGateSnapshotV2, type SourceGateSnapshotV2, type SourceGateWriteV2 } from './source-gates-v2'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const RESPONSE_BYTES = 96 * 1_024
// Source gates are an eventually consistent privacy projection, never launch/readiness state.
// A person's explicit switch preempts this timer; an unavailable platform otherwise stays quiet.
export const RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const

export class MatrixSourceGateError extends Error {
  constructor(
    readonly code: 'conflict' | 'unavailable',
    readonly current?: AgentSourceGateSnapshot,
    readonly reason?: string
  ) {
    super(`matrix_source_gates_${code}`)
    this.name = 'MatrixSourceGateError'
  }
}

async function sourceGateRequest(
  resource: string,
  accessToken: string,
  assistantId: string,
  signal: AbortSignal,
  write?: AgentSourceGateWrite | SourceGateWriteV2,
  fetchImpl: typeof fetch = fetch,
  readV2 = false
): Promise<SourceGateSnapshotV2> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  if (!UUID.test(assistantId)) {
    throw new MatrixSourceGateError('unavailable', undefined, 'invalid_assistant')
  }

  const response = await fetchImpl(`${resource}/agents/${encodeURIComponent(assistantId)}/source-gates`, {
    method: write ? 'PUT' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(write ? { 'Content-Type': 'application/json' } : {}),
      'Atum-Agent-Home-Wire': '2.1',
      ...(readV2 && !write ? { 'Atum-Source-Gates-Profile': '2' } : {})
    },
    ...(write ? { body: JSON.stringify(write.profile === 'atum.agent-source-gates/2' ? write : parseAgentSourceGateWrite(write)) } : {}),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal
  }).catch(() => {
    signal.throwIfAborted()
    throw new MatrixSourceGateError('unavailable', undefined, 'network')
  })

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_s1_authentication')
  }

  if (response.status === 409) {
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw new MatrixSourceGateError('unavailable', undefined, 'invalid_response')
    }

    try {
      const body = await readDomainJson(response, RESPONSE_BYTES) as Record<string, unknown>

      const conflict = body.profile === 'atum.agent-source-gates/2'
        ? { current: parseSourceGateSnapshotV2(body.current) }
        : parseAgentSourceGateWriteConflict(body)

      throw new MatrixSourceGateError('conflict', conflict.current)
    } catch (error) {
      if (error instanceof MatrixSourceGateError) {
        throw error
      }

      throw new MatrixSourceGateError('unavailable', undefined, 'invalid_response')
    }
  }

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new MatrixSourceGateError(
      'unavailable',
      undefined,
      response.ok ? 'invalid_response' : `http_${response.status}`
    )
  }

  try {
    return parseSourceGateSnapshotV2(await readDomainJson(response, RESPONSE_BYTES))
  } catch {
    throw new MatrixSourceGateError('unavailable', undefined, 'invalid_response')
  }
}

export function readMatrixSourceGates(
  resource: string,
  accessToken: string,
  assistantId: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch
): Promise<AgentSourceGateSnapshot> {
  return sourceGateRequest(resource, accessToken, assistantId, signal, undefined, fetchImpl)
}

export function readMatrixSourceGatesV2(
  resource: string, accessToken: string, assistantId: string, signal: AbortSignal, fetchImpl?: typeof fetch
): Promise<SourceGateSnapshotV2> {
  return sourceGateRequest(resource, accessToken, assistantId, signal, undefined, fetchImpl, true)
}

export function writeMatrixSourceGates(
  resource: string,
  accessToken: string,
  assistantId: string,
  write: AgentSourceGateWrite | SourceGateWriteV2,
  signal: AbortSignal,
  fetchImpl?: typeof fetch
): Promise<AgentSourceGateSnapshot> {
  return sourceGateRequest(resource, accessToken, assistantId, signal, write, fetchImpl)
}

export interface MatrixSourceGateScope {
  accountKey: string
  generation: number
}

export interface MatrixSourceGateSyncDependencies {
  scope(): MatrixSourceGateScope | null
  gates(): AgentSourceGates
  assistants(signal: AbortSignal): Promise<string[]>
  read(assistantId: string, signal: AbortSignal): Promise<AgentSourceGateSnapshot>
  write(assistantId: string, input: AgentSourceGateWrite, signal: AbortSignal): Promise<AgentSourceGateSnapshot>
  uuid?(): string
  retryMs?: readonly number[]
  log?(line: string): void
}

function sameScope(left: MatrixSourceGateScope, right: MatrixSourceGateScope | null): boolean {
  return right !== null && left.accountKey === right.accountKey && left.generation === right.generation
}

/**
 * TEST-ONLY legacy compatibility fixture. Production uses MatrixAccountSourceGates.
 * One account-scoped, non-blocking reconciler. Explicit changes preempt older intent; offline work
 * retries with bounded backoff, and every CAS conflict is re-read before local intent is re-applied.
 */
export class MatrixSourceGateSync {
  private generation = 0
  private active?: AbortController
  private running?: Promise<void>
  private roster?: string[]
  private retry?: ReturnType<typeof setTimeout>
  private retryIndex = 0
  private unavailableLogged = false
  private stopped = false
  private readonly pendingWrites = new Map<string, {
    scope: MatrixSourceGateScope
    gates: AgentSourceGates
    input: AgentSourceGateWrite
  }>()

  constructor(private readonly dependencies: MatrixSourceGateSyncDependencies) {}

  reconcile(assistants?: readonly string[]): void {
    const roster = assistants ? [...new Set(assistants)].sort() : undefined

    // Roster refreshes carry the same authoritative list every few minutes. Do not let an
    // unrelated refresh abort a request or reset an unavailable route to the shortest retry.
    if (
      roster &&
      this.roster &&
      roster.length === this.roster.length &&
      roster.every((assistant, index) => assistant === this.roster![index]) &&
      (this.running || this.retry)
    ) {
      return
    }

    this.stopped = false
    this.generation += 1
    this.roster = roster
    this.retryIndex = 0

    if (this.retry) {
      clearTimeout(this.retry)
    }

    this.retry = undefined
    this.active?.abort({ reason: 'superseded' })
    this.kick()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.roster = undefined
    this.pendingWrites.clear()
    this.unavailableLogged = false

    if (this.retry) {
      clearTimeout(this.retry)
    }

    this.retry = undefined
    this.active?.abort({ reason: 'stopped' })
  }

  private kick(): void {
    if (this.stopped || this.running) {
      return
    }

    const generation = this.generation
    const roster = this.roster
    const abort = new AbortController()
    this.active = abort
    this.running = this.run(generation, roster, abort.signal)
      .then(() => {
        if (generation === this.generation) {
          this.retryIndex = 0
          this.unavailableLogged = false
        }
      })
      .catch(error => {
        if (generation === this.generation && this.dependencies.scope()) {
          this.scheduleRetry(error)
        }
      })
      .finally(() => {
        if (this.active === abort) {
          this.active = undefined
        }

        this.running = undefined

        if (!this.stopped && generation !== this.generation && !this.retry) {
          this.kick()
        }
      })
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped || this.retry) {
      return
    }

    const delays = this.dependencies.retryMs?.length ? this.dependencies.retryMs : RETRY_MS
    const delay = delays[Math.min(this.retryIndex, delays.length - 1)]!
    this.retryIndex += 1

    if (!this.unavailableLogged) {
      const reason = error instanceof MatrixSourceGateError && error.reason ? ` reason=${error.reason}` : ''
      this.dependencies.log?.(`[Matrix] source gates unavailable${reason}; retrying quietly`)
      this.unavailableLogged = true
    }

    this.retry = setTimeout(() => {
      this.retry = undefined
      this.generation += 1
      this.kick()
    }, delay)
    this.retry.unref?.()
  }

  private current(generation: number, scope: MatrixSourceGateScope, gates: AgentSourceGates): boolean {
    return generation === this.generation && sameScope(scope, this.dependencies.scope()) &&
      sameAgentSourceGates(gates, this.dependencies.gates())
  }

  private async run(generation: number, roster: string[] | undefined, signal: AbortSignal): Promise<void> {
    const scope = this.dependencies.scope()

    if (!scope) {
      return
    }

    const gates = this.dependencies.gates()
    const assistants = roster ?? await this.dependencies.assistants(signal)
    signal.throwIfAborted()

    if (!this.current(generation, scope, gates)) {
      return
    }

    for (const assistantId of [...new Set(assistants)].sort()) {
      await this.apply(assistantId, generation, scope, gates, signal)
    }
  }

  private async apply(
    assistantId: string,
    generation: number,
    scope: MatrixSourceGateScope,
    gates: AgentSourceGates,
    signal: AbortSignal
  ): Promise<void> {
    let snapshot = await this.dependencies.read(assistantId, signal)

    for (let conflict = 0; conflict < 2; conflict += 1) {
      signal.throwIfAborted()

      if (!this.current(generation, scope, gates)) {
        return
      }

      if (sameAgentSourceGates(snapshot.gates, gates)) {
        this.pendingWrites.delete(assistantId)

        return
      }

      const pending = this.pendingWrites.get(assistantId)

      const input = pending && sameScope(scope, pending.scope) && sameAgentSourceGates(gates, pending.gates) &&
        pending.input.expectedRevision === snapshot.revision
        ? pending.input
        : parseAgentSourceGateWrite({ profile: AGENT_SOURCE_GATES_PROFILE,
            requestId: (this.dependencies.uuid ?? randomUUID)(), expectedRevision: snapshot.revision, gates })

      this.pendingWrites.set(assistantId, { scope: { ...scope }, gates: { ...gates }, input })

      try {
        snapshot = await this.dependencies.write(assistantId, input, signal)

        if (!sameAgentSourceGates(snapshot.gates, gates)) {
          throw new MatrixSourceGateError('unavailable')
        }

        this.pendingWrites.delete(assistantId)

        return
      } catch (error) {
        if (!(error instanceof MatrixSourceGateError) || error.code !== 'conflict') {
          throw error
        }

        this.pendingWrites.delete(assistantId)
        snapshot = error.current ?? await this.dependencies.read(assistantId, signal)
      }
    }

    throw new MatrixSourceGateError('unavailable')
  }
}

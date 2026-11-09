import { createHash, randomUUID } from 'node:crypto'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  type MatrixAgentRoutine,
  type MatrixAgentRoutineMutation,
  type MatrixAgentRoutineMutationDraft,
  type MatrixAgentRoutineRunsSnapshot,
  type MatrixAgentRoutinesSnapshot,
  matrixRoutineActionInput,
  matrixRoutineCreateInput,
  type MatrixRoutineError,
  type MatrixRoutineMutationResult,
  type MatrixRoutineReadResult,
  type MatrixRoutineRunsResult,
  matrixRoutineUpdateInput,
  parseMatrixAgentRoutineMutation,
  parseMatrixAgentRoutineRunsSnapshot,
  parseMatrixAgentRoutinesSnapshot
} from '../../shared/agent-routines'

import { readDomainJson } from './domain'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const REQUEST_TIMEOUT_MS = 20_000
const SNAPSHOT_BYTES = 4_500_000
const MUTATION_BYTES = 256 * 1024
const RUNS_BYTES = 512 * 1024

type MatrixRoutineOperation = 'read' | 'create' | 'update' | 'run' | 'delete' | 'runs'

function routineFailureCode(operation: MatrixRoutineOperation, error: MatrixRoutineError): string {
  return `matrix_routine_${operation}_${error}`
}

/** One owner route answer, or a closed failure. `error` is `matrix_409`/`matrix_403`/… from
 * the Shell when it refuses: a 403 means a legacy schedule fence or a replayed request id,
 * a 409 means a stale revision (or the 64-routine quota on create). */
export class MatrixAgentRoutineRequestError extends Error {
  constructor(readonly code: MatrixRoutineError) {
    super(`matrix_agent_routine_${code}`)
    this.name = 'MatrixAgentRoutineRequestError'
  }
}

/** A stable id per mutation draft, so a retry after a dropped answer is the same mutation.
 * The Key is a hash of the assistant and the exact body; no title or instruction is kept. */
export class MatrixRoutineRequestLedger {
  private readonly entries = new Map<string, string>()

  key(assistantId: string, input: MatrixAgentRoutineMutationDraft): string {
    return createHash('sha256')
      .update(`atum.routine-request.v1\u0000${assistantId}\u0000${canonical(input)}`)
      .digest('hex')
  }

  requestId(key: string): string {
    const existing = this.entries.get(key)

    if (existing) {
      return existing
    }

    const id = randomUUID()
    this.entries.set(key, id)

    return id
  }

  clear(key: string | undefined): void {
    if (key) {
      this.entries.delete(key)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

function failure(error: unknown): MatrixRoutineError {
  return error instanceof MatrixAgentRoutineRequestError ? error.code : 'unavailable'
}

/** Whether a retry may reuse the request id: only a transport/temporary failure. Any answer
 * from the server is definitive, so the draft's id is retired. */
function definitive(error: MatrixRoutineError): boolean {
  return error !== 'offline' && error !== 'unavailable'
}

async function request(
  resource: string,
  accessToken: string,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal: AbortSignal,
  maximumBytes: number
): Promise<unknown> {
  signal.throwIfAborted()
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = AbortSignal.any([signal, deadline])
  let response: Response

  try {
    response = await fetch(`${resource}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: requestSignal
    })
  } catch {
    signal.throwIfAborted()
    throw new MatrixAgentRoutineRequestError('offline')
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    signal.throwIfAborted()

    if (response.status === 401) {
      throw new MatrixAgentRoutineRequestError('denied')
    }

    if (response.status === 404) {
      throw new MatrixAgentRoutineRequestError('missing')
    }

    if (response.status === 400 || response.status === 422) {
      throw new MatrixAgentRoutineRequestError('invalid')
    }

    if (response.status === 403) {
      // Answered per operation by the caller: a legacy fence for writes that would run, a
      // replayed request id otherwise.
      throw new MatrixAgentRoutineRequestError('denied')
    }

    if (response.status === 409) {
      throw new MatrixAgentRoutineRequestError('conflict')
    }

    throw new MatrixAgentRoutineRequestError(response.status === 503 ? 'offline' : 'unavailable')
  }

  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new MatrixAgentRoutineRequestError('unavailable')
  }

  try {
    const value = await readDomainJson(response, maximumBytes)
    signal.throwIfAborted()

    return value
  } catch {
    signal.throwIfAborted()
    throw new MatrixAgentRoutineRequestError(deadline.aborted ? 'offline' : 'invalid')
  }
}

/** Reads one agent's routines from the live owner route. Native checks the envelope names
 * this agent, so a substituted snapshot never appears under another card. */
export async function readMatrixAgentRoutines(
  resource: string,
  accessToken: string,
  assistantId: string,
  signal: AbortSignal
): Promise<MatrixAgentRoutinesSnapshot> {
  if (!UUID.test(assistantId)) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  const snapshot = parseMatrixAgentRoutinesSnapshot(
    await request(
      resource,
      accessToken,
      `/agents/${encodeURIComponent(assistantId)}/routines`,
      'GET',
      undefined,
      signal,
      SNAPSHOT_BYTES
    )
  )

  if (!snapshot || snapshot.assistantId !== assistantId) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  return snapshot
}

export async function mutateMatrixAgentRoutine(
  resource: string,
  accessToken: string,
  assistantId: string,
  input: MatrixAgentRoutineMutation,
  signal: AbortSignal
): Promise<MatrixAgentRoutine | { id: string; revision: number }> {
  if (!UUID.test(assistantId)) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  let value: unknown

  try {
    value = await request(
      resource,
      accessToken,
      `/agents/${encodeURIComponent(assistantId)}/routines`,
      'POST',
      input,
      signal,
      MUTATION_BYTES
    )
  } catch (error) {
    if (!(error instanceof MatrixAgentRoutineRequestError)) {
      throw error
    }

    // The owner route does not name why a 403 happened. For the operations the legacy fence
    // refuses (create, an enabled update, run) that is the honest answer; the others can only
    // be a replayed request id, which the card shows as a conflict.
    if (error.code === 'denied') {
      const fenced = input.operation === 'create' || input.operation === 'run' ||
        (input.operation === 'update' && input.enabled)

      throw new MatrixAgentRoutineRequestError(fenced ? 'legacy' : 'conflict')
    }

    if (error.code === 'conflict' && input.operation === 'create') {
      throw new MatrixAgentRoutineRequestError('quota')
    }

    throw error
  }

  const result = parseMatrixAgentRoutineMutation(value)

  if (!result) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  if (input.operation === 'delete') {
    if (!('revision' in result) || result.id !== input.routineId) {
      throw new MatrixAgentRoutineRequestError('invalid')
    }

    return result
  }

  if (!('title' in result) || (input.operation !== 'create' && result.id !== input.routineId)) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  return result
}

export async function readMatrixAgentRoutineRuns(
  resource: string,
  accessToken: string,
  assistantId: string,
  routineId: string,
  signal: AbortSignal
): Promise<MatrixAgentRoutineRunsSnapshot> {
  if (!UUID.test(assistantId) || !UUID.test(routineId)) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  const snapshot = parseMatrixAgentRoutineRunsSnapshot(
    await request(
      resource,
      accessToken,
      `/agents/${encodeURIComponent(assistantId)}/routines/${encodeURIComponent(routineId)}/runs`,
      'GET',
      undefined,
      signal,
      RUNS_BYTES
    ),
    routineId
  )

  if (!snapshot) {
    throw new MatrixAgentRoutineRequestError('invalid')
  }

  return snapshot
}

/** The card's native side: a principal in, one owner-scoped answer out. Main holds the
 * bearer and the routine ledger; the window only ever sees the platform's closed rows. */
export class MatrixAgentRoutines {
  constructor(
    private readonly options: {
      agents(): readonly { principal: string; assistantId: string }[]
      read(assistantId: string, signal: AbortSignal): Promise<MatrixAgentRoutinesSnapshot>
      mutate(
        assistantId: string,
        input: MatrixAgentRoutineMutation,
        signal: AbortSignal
      ): Promise<MatrixAgentRoutine | { id: string; revision: number }>
      runs(assistantId: string, routineId: string, signal: AbortSignal): Promise<MatrixAgentRoutineRunsSnapshot>
      /** A38: the owner zone the platform last acknowledged on this Mac (undefined when never). */
      ownerZone?(): string | undefined
      /** Closed operational diagnostics only: no principal, routine id, prompt or response. */
      failureLog?(message: string): void
      timeoutMs?: number
    },
    private readonly ledger = new MatrixRoutineRequestLedger()
  ) {}

  private agent(principal: unknown): { principal: string; assistantId: string } | undefined {
    if (typeof principal !== 'string' || !UUID.test(principal)) {
      return undefined
    }

    const matches = this.options.agents().filter(agent => agent.principal === principal)

    return matches.length === 1 ? matches[0] : undefined
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  }

  private failed(operation: MatrixRoutineOperation, error: MatrixRoutineError): { ok: false; error: MatrixRoutineError } {
    const message = `[Matrix] routine operation=${operation} outcome=failed code=${routineFailureCode(operation, error)}`

    if (this.options.failureLog) {
      this.options.failureLog(message)
    } else {
      console.warn(message)
    }

    return { ok: false, error }
  }

  async read(value: unknown): Promise<MatrixRoutineReadResult> {
    const agent = this.agent(value)

    if (!agent) {
      return this.failed('read', 'missing')
    }

    try {
      const snapshot = await this.options.read(agent.assistantId, this.signal())

      return { ok: true, snapshot }
    } catch (error) {
      return this.failed('read', failure(error))
    }
  }

  async create(value: unknown): Promise<MatrixRoutineMutationResult> {
    const input = matrixRoutineCreateInput(value)

    if (!input) {
      return this.failed('create', 'invalid')
    }

    const agent = this.agent(input.principal)

    if (!agent) {
      return this.failed('create', 'missing')
    }

    return this.mutate(agent, {
      operation: 'create',
      title: input.title,
      instruction: input.instruction,
      schedule: input.schedule,
      timezone: input.timezone,
      enabled: input.enabled,
      notifications: input.notifications
    })
  }

  async update(value: unknown): Promise<MatrixRoutineMutationResult> {
    const input = matrixRoutineUpdateInput(value)

    if (!input) {
      return this.failed('update', 'invalid')
    }

    const agent = this.agent(input.principal)

    if (!agent) {
      return this.failed('update', 'missing')
    }

    return this.mutate(agent, {
      operation: 'update',
      routineId: input.routineId,
      expectedRevision: input.expectedRevision,
      title: input.title,
      instruction: input.instruction,
      schedule: input.schedule,
      timezone: input.timezone,
      enabled: input.enabled,
      notifications: input.notifications
    })
  }

  async run(value: unknown): Promise<MatrixRoutineMutationResult> {
    const input = matrixRoutineActionInput(value)

    if (!input) {
      return this.failed('run', 'invalid')
    }

    const agent = this.agent(input.principal)

    if (!agent) {
      return this.failed('run', 'missing')
    }

    return this.mutate(agent, {
      operation: 'run',
      routineId: input.routineId,
      expectedRevision: input.expectedRevision
    })
  }

  async delete(value: unknown): Promise<MatrixRoutineMutationResult> {
    const input = matrixRoutineActionInput(value)

    if (!input) {
      return this.failed('delete', 'invalid')
    }

    const agent = this.agent(input.principal)

    if (!agent) {
      return this.failed('delete', 'missing')
    }

    return this.mutate(agent, {
      operation: 'delete',
      routineId: input.routineId,
      expectedRevision: input.expectedRevision
    })
  }

  async runs(value: unknown, routineId: unknown): Promise<MatrixRoutineRunsResult> {
    const agent = this.agent(value)

    if (!agent || typeof routineId !== 'string' || !UUID.test(routineId)) {
      return this.failed('runs', 'missing')
    }

    try {
      const snapshot = await this.options.runs(agent.assistantId, routineId, this.signal())

      return { ok: true, snapshot }
    } catch (error) {
      return this.failed('runs', failure(error))
    }
  }

  /** The platform-acknowledged owner zone, for a new routine's default time zone. */
  ownerZone(): string | undefined {
    return this.options.ownerZone?.()
  }

  private async mutate(
    agent: { principal: string; assistantId: string },
    draft: MatrixAgentRoutineMutationDraft
  ): Promise<MatrixRoutineMutationResult> {
    const key = this.ledger.key(agent.assistantId, draft)
    const requestId = this.ledger.requestId(key)
    const input = { ...draft, requestId } as MatrixAgentRoutineMutation

    try {
      const result = await this.options.mutate(agent.assistantId, input, this.signal())
      this.ledger.clear(key)

      return 'title' in result
        ? { ok: true, routine: result }
        : { ok: true, deleted: result }
    } catch (error) {
      const code = failure(error)

      if (definitive(code)) {
        this.ledger.clear(key)
      }

      return this.failed(draft.operation, code)
    }
  }
}

/** Fixed trusted UI operations: a principal in, one owner-scoped answer out. */
export function registerMatrixAgentRoutinesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  routines: MatrixAgentRoutines,
  requireCaller: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle('matrix:routines:read', (event, principal: unknown) => {
    requireCaller(event)

    return routines.read(principal)
  })
  ipc.handle('matrix:routines:create', (event, input: unknown) => {
    requireCaller(event)

    return routines.create(input)
  })
  ipc.handle('matrix:routines:update', (event, input: unknown) => {
    requireCaller(event)

    return routines.update(input)
  })
  ipc.handle('matrix:routines:run', (event, input: unknown) => {
    requireCaller(event)

    return routines.run(input)
  })
  ipc.handle('matrix:routines:delete', (event, input: unknown) => {
    requireCaller(event)

    return routines.delete(input)
  })
  ipc.handle('matrix:routines:runs', (event, principal: unknown, routineId: unknown) => {
    requireCaller(event)

    return routines.runs(principal, routineId)
  })
  ipc.handle('matrix:routines:owner-zone', event => {
    requireCaller(event)

    return routines.ownerZone()
  })
}

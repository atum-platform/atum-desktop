import { randomUUID } from 'node:crypto'

import type { MatrixComputerUseSnapshot } from '../../shared/matrix-computer-use'
import type {
  MatrixComputerUseGrantOperation,
  MatrixComputerUseGrantStart
} from '../../shared/matrix-computer-use-grant'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const START = '/api/tools/computer-use/permissions/grant'
const OPERATIONS = '/api/tools/computer-use/permissions/grants/'
const ACTION = 'computer-use-grant'
const STATUS = '/api/actions/computer-use-grant/status?profile=default&lines=1'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

interface ActionStatus {
  name: string
  running: boolean
  pid: number | null
  exit_code: number | null
}

function actionStatus(value: unknown): ActionStatus | undefined {
  if (
    !record(value) ||
    value.name !== ACTION ||
    typeof value.running !== 'boolean' ||
    !(value.pid === null || positivePid(value.pid)) ||
    !(value.exit_code === null || Number.isSafeInteger(value.exit_code))
  ) {
    return undefined
  }

  if (
    value.running
      ? !positivePid(value.pid) || value.exit_code !== null
      : value.pid === null
        ? value.exit_code !== null
        : value.exit_code === null
  ) {
    return undefined
  }

  return {
    name: ACTION,
    running: value.running,
    pid: value.pid as number | null,
    exit_code: value.exit_code as number | null
  }
}

/** IPC operation IDs are never upstream action names or backend routes. */
export function isMatrixComputerUseGrantRequest(path: unknown): boolean {
  return typeof path === 'string' && (path === START || path.startsWith(OPERATIONS))
}

export interface MatrixPagesComputerUseGrantScopeDeps {
  platform: string
  isCurrent(): boolean
  status(): Promise<MatrixComputerUseSnapshot>
  confirm(): Promise<boolean>
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

interface OwnedGrant {
  pid: number
  terminal?: MatrixComputerUseGrantOperation
  pending?: Promise<MatrixComputerUseGrantOperation>
}

class MatrixPagesComputerUseGrantScope {
  private starting = false
  private readonly operations = new Map<string, OwnedGrant>()

  constructor(private readonly deps: MatrixPagesComputerUseGrantScopeDeps) {}

  private async eligibility(): Promise<MatrixComputerUseGrantStart | undefined> {
    if (!this.deps.isCurrent()) {return { status: 'unknown' }}

    if (this.deps.platform !== 'darwin') {return { status: 'blocked', reason: 'unsupported' }}

    const snapshot = await this.deps.status()

    if (!this.deps.isCurrent()) {return { status: 'unknown' }}

    if (snapshot.platform !== 'darwin') {return { status: 'blocked', reason: 'unsupported' }}

    if (!snapshot.installed) {return { status: 'blocked', reason: 'not-installed' }}

    const action = actionStatus(await this.deps.forward({ path: STATUS, method: 'GET' }))

    if (!this.deps.isCurrent() || !action) {return { status: 'unknown' }}

    if (action.running) {return { status: 'blocked', reason: 'busy' }}
  }

  private async start(): Promise<MatrixComputerUseGrantStart> {
    if (this.starting) {return { status: 'blocked', reason: 'busy' }}
    this.starting = true

    try {
      const before = await this.eligibility()

      if (before) {return before}

      if (!this.deps.isCurrent()) {return { status: 'unknown' }}
      const confirmed = await this.deps.confirm()

      if (!confirmed || !this.deps.isCurrent()) {return { status: 'cancelled' }}
      const after = await this.eligibility()

      if (after) {return after}

      if (!this.deps.isCurrent()) {return { status: 'cancelled' }}

      // Exactly one POST. A lost reply can mean the detached action started;
      // never retry it or guess its PID from a later status read.
      const reply = await this.deps.forward({ path: `${START}?profile=default`, method: 'POST' })

      if (
        !this.deps.isCurrent() ||
        !record(reply) ||
        reply.ok !== true ||
        reply.name !== ACTION ||
        !positivePid(reply.pid)
      ) {
        return { status: 'unknown' }
      }

      const operationId = randomUUID()
      this.operations.set(operationId, { pid: reply.pid })

      return { status: 'started', operationId }
    } catch (error) {
      return error instanceof Error && error.message === 'pages_agent_busy'
        ? { status: 'blocked', reason: 'busy' }
        : { status: 'unknown' }
    } finally {
      this.starting = false
    }
  }

  private async operationStatus(id: string): Promise<MatrixComputerUseGrantOperation> {
    const operation = UUID.test(id) ? this.operations.get(id) : undefined

    if (!operation || !this.deps.isCurrent()) {return { status: 'unknown' }}

    if (operation.terminal) {return operation.terminal}

    // IPC calls can overlap even if the ordinary page coalesces them. Sharing
    // one read prevents a late running reply from reversing a terminal result.
    operation.pending ??= this.readOperation(operation)
    const pending = operation.pending

    try {
      return await pending
    } finally {
      if (operation.pending === pending) {operation.pending = undefined}
    }
  }

  private async readOperation(operation: OwnedGrant): Promise<MatrixComputerUseGrantOperation> {
    let result: MatrixComputerUseGrantOperation = { status: 'unknown' }

    try {
      const action = actionStatus(await this.deps.forward({ path: STATUS, method: 'GET' }))

      if (this.deps.isCurrent() && action?.pid === operation.pid) {
        result = { status: action.running ? 'running' : action.exit_code === 0 ? 'completed' : 'failed' }
      }
    } catch {
      // Unknown is terminal for this ID. It cannot adopt a foreign action on
      // a later read, including after a lost/changed original process.
    }

    if (result.status !== 'running') {operation.terminal = result}

    return result
  }

  async request(value: MatrixPagesRequest): Promise<MatrixComputerUseGrantStart | MatrixComputerUseGrantOperation> {
    if (
      !record(value) ||
      Object.keys(value).some(key => key !== 'path' && key !== 'method') ||
      Object.hasOwn(value, 'body') ||
      typeof value.path !== 'string' ||
      value.path.includes('?')
    ) {
      throw new Error('matrix_pages_request_forbidden')
    }

    if (value.path === START && value.method === 'POST') {return this.start()}

    if (
      value.path.startsWith(OPERATIONS) &&
      (value.method === undefined || value.method === 'GET') &&
      !value.path.slice(OPERATIONS.length).includes('/')
    ) {
      return this.operationStatus(value.path.slice(OPERATIONS.length))
    }

    throw new Error('matrix_pages_request_forbidden')
  }
}

export function createMatrixPagesComputerUseGrantScope(deps: MatrixPagesComputerUseGrantScopeDeps) {
  return new MatrixPagesComputerUseGrantScope(deps)
}

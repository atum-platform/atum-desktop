import { MATRIX_AUXILIARY_TASKS } from '../../shared/matrix-auxiliary-settings'
import type {
  MatrixAuxiliaryAssignment,
  MatrixAuxiliaryConfirmation,
  MatrixAuxiliarySnapshot,
  MatrixAuxiliaryWriteResult
} from '../../shared/matrix-auxiliary-settings'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/auxiliary-settings/'
const AUXILIARY = '/api/model/auxiliary?profile=default'
const OPTIONS = '/api/model/options?explicit_only=1&read_only=1&profile=default'
const SET = '/api/model/set?profile=default'
const FORBIDDEN = 'matrix_pages_request_forbidden'
const UNAVAILABLE = 'matrix_pages_agent_unavailable'
const INVALID = 'matrix_auxiliary_response_invalid'
const FAILED = 'matrix_auxiliary_request_failed'

function fail(code: string): never {
  throw new Error(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, empty = false, max = 1024): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    (empty || value.length > 0) &&
    value.length <= max &&
    !/[\p{Cc}]/u.test(value)
  )
}

function task(value: unknown): value is MatrixAuxiliaryAssignment['task'] {
  return MATRIX_AUXILIARY_TASKS.some(slot => slot === value)
}

function compatible(provider: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,199}$/.test(provider) && !['auto', 'nous', 'custom', 'local'].includes(provider)
}

function exact(value: unknown, path: string, method: string, fields?: string[]): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some(key => !['path', 'method', 'body'].includes(key)) ||
    value.path !== path ||
    (value.method ?? 'GET') !== method
  ) {
    fail(FORBIDDEN)
  }

  if (!fields) {
    if (value.body !== undefined) {
      fail(FORBIDDEN)
    }

    return {}
  }

  if (
    !record(value.body) ||
    Object.keys(value.body).length !== fields.length ||
    Object.keys(value.body).some(key => !fields.includes(key))
  ) {
    fail(FORBIDDEN)
  }

  return value.body
}

function assignments(value: unknown): MatrixAuxiliaryAssignment[] {
  if (!record(value) || !Array.isArray(value.tasks)) {
    fail(INVALID)
  }

  const rows = new Map<MatrixAuxiliaryAssignment['task'], MatrixAuxiliaryAssignment>()

  for (const row of value.tasks) {
    if (
      !record(row) ||
      !task(row.task) ||
      rows.has(row.task) ||
      !text(row.provider, false, 512) ||
      !text(row.model, true)
    ) {
      fail(INVALID)
    }

    rows.set(row.task, { task: row.task, provider: row.provider, model: row.model })
  }

  return MATRIX_AUXILIARY_TASKS.map(slot => rows.get(slot) ?? fail(INVALID))
}

function providers(value: unknown): MatrixAuxiliarySnapshot['providers'] {
  if (!record(value) || !Array.isArray(value.providers)) {
    fail(INVALID)
  }

  const rows = new Map<string, MatrixAuxiliarySnapshot['providers'][number]>()

  for (const row of value.providers) {
    if (
      !record(row) ||
      !text(row.slug) ||
      !compatible(row.slug) ||
      row.authenticated !== true ||
      !Array.isArray(row.models)
    ) {
      continue
    }

    // An ambiguous duplicate cannot grant catalog authority.
    if (rows.has(row.slug)) {
      fail(INVALID)
    }

    const unavailable = new Set(Array.isArray(row.unavailable_models) ? row.unavailable_models : [])
    const models = [...new Set(row.models.filter((model): model is string => text(model) && !unavailable.has(model)))]
    rows.set(row.slug, { id: row.slug, models })
  }

  return [...rows.values()]
}

/** Reserve malformed near-matches too; the generic pages bridge cannot bypass this adapter. */
export function isMatrixAuxiliaryRequest(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(PREFIX)
}

export interface MatrixPagesAuxiliaryDeps {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(request: MatrixAuxiliaryConfirmation): boolean | Promise<boolean>
}

export class MatrixPagesAuxiliaryScope {
  private writing = false
  constructor(private readonly deps: MatrixPagesAuxiliaryDeps) {}
  private current(): void {
    if (!this.deps.isCurrent()) {
      fail(UNAVAILABLE)
    }
  }
  private async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    this.current()
    const response = await this.deps.forward(request)
    this.current()

    return response
  }
  private async eligible(provider: string, model: string): Promise<void> {
    this.current()

    if (provider === 'auto' && model === '') {
      return
    }

    const catalog = providers(await this.forward({ path: OPTIONS, method: 'GET' }))

    if (!catalog.some(row => row.id === provider && row.models.includes(model))) {
      fail(INVALID)
    }
  }
  private async confirmed(assignment: MatrixAuxiliaryAssignment, kind: MatrixAuxiliaryConfirmation['kind']) {
    this.current()
    const accepted = await this.deps.confirm({ ...assignment, kind })
    this.current()

    return accepted
  }
  private async snapshot(): Promise<MatrixAuxiliarySnapshot> {
    const tasks = assignments(await this.forward({ path: AUXILIARY, method: 'GET' }))
    const catalog = providers(await this.forward({ path: OPTIONS, method: 'GET' }))

    return { tasks, providers: catalog }
  }
  private async set(body: Record<string, unknown>): Promise<MatrixAuxiliaryWriteResult> {
    if (
      !task(body.task) ||
      !text(body.provider, false, 512) ||
      !text(body.model, true) ||
      (body.provider === 'auto' ? body.model !== '' : !compatible(body.provider) || body.model === '')
    ) {
      fail(FORBIDDEN)
    }

    const assignment = { task: body.task, provider: body.provider, model: body.model }
    await this.eligible(assignment.provider, assignment.model)

    if (!(await this.confirmed(assignment, 'pin'))) {
      return { status: 'cancelled' }
    }

    await this.eligible(assignment.provider, assignment.model)
    const payload = { scope: 'auxiliary', ...assignment }
    let response = await this.forward({ path: SET, method: 'POST', body: payload })

    if (
      record(response) &&
      response.ok === false &&
      response.scope === 'auxiliary' &&
      response.provider === assignment.provider &&
      response.model === assignment.model &&
      response.confirm_required === true
    ) {
      if (!(await this.confirmed(assignment, 'expensive-model'))) {
        return { status: 'cancelled' }
      }

      await this.eligible(assignment.provider, assignment.model)
      response = await this.forward({ path: SET, method: 'POST', body: { ...payload, confirm_expensive_model: true } })
    }

    if (
      !record(response) ||
      response.ok !== true ||
      response.scope !== 'auxiliary' ||
      response.provider !== assignment.provider ||
      response.model !== assignment.model ||
      !Array.isArray(response.tasks) ||
      response.tasks.length !== 1 ||
      response.tasks[0] !== assignment.task
    ) {
      fail(INVALID)
    }

    const normalized = assignments(await this.forward({ path: AUXILIARY, method: 'GET' })).find(
      row => row.task === assignment.task
    )

    if (!normalized || normalized.provider !== assignment.provider || normalized.model !== assignment.model) {
      fail(INVALID)
    }

    return { status: 'applied', ...normalized }
  }
  async request(value: MatrixPagesRequest): Promise<MatrixAuxiliarySnapshot | MatrixAuxiliaryWriteResult> {
    try {
      this.current()

      if (value?.path === `${PREFIX}snapshot`) {
        exact(value, `${PREFIX}snapshot`, 'GET')

        return await this.snapshot()
      }

      const body = exact(value, `${PREFIX}set`, 'POST', ['task', 'provider', 'model'])

      if (this.writing) {
        fail(FAILED)
      }

      this.writing = true

      try {
        return await this.set(body)
      } finally {
        this.writing = false
      }
    } catch (error) {
      // Upstream exceptions can contain credentials/endpoints; export only fixed codes.
      fail(
        error instanceof Error && [FORBIDDEN, UNAVAILABLE, INVALID, FAILED].includes(error.message)
          ? error.message
          : FAILED
      )
    }
  }
}

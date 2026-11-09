import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type {
  MatrixRuntimeConfirmation,
  MatrixRuntimeSnapshot,
  MatrixRuntimeWriteResult
} from '../../shared/matrix-runtime-settings'

import { MATRIX_MANAGED_ENDPOINT } from './hermes-setup'
import type { MatrixPagesForwardRequest } from './pages-bridge'

const PROFILE = 'profile=default'
const MODEL_INFO = `/api/model/info?${PROFILE}`
const MODEL_OPTIONS = `/api/model/options?explicit_only=1&read_only=1&${PROFILE}`
const MEMORY = `/api/memory?${PROFILE}`
const MODEL_SET = `/api/model/set?${PROFILE}`
const MEMORY_PROVIDER = `/api/memory/provider?${PROFILE}`

function denied(): never {
  throw new Error('matrix_pages_request_forbidden')
}

function unavailable(): never {
  throw new Error('matrix_pages_agent_unavailable')
}

function invalidResponse(): never {
  throw new Error('matrix_runtime_response_invalid')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasControl(value: string): boolean {
  return /[\p{Cc}]/u.test(value)
}

function boundedText(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControl(value)
  )
}

function boundedDescription(value: unknown): string {
  return typeof value === 'string' && value.length <= 1024 && !hasControl(value) ? value : ''
}

function exactRequest(value: unknown, path: string, method: 'GET' | 'POST' | 'PUT', fields?: readonly string[]) {
  if (!record(value) || Object.keys(value).some(key => !['path', 'method', 'body'].includes(key))) {
    return denied()
  }

  if (value.path !== path || (value.method ?? 'GET') !== method) {
    return denied()
  }

  if (!fields) {
    if (value.body !== undefined) {
      return denied()
    }

    return undefined
  }

  if (
    !record(value.body) ||
    Object.keys(value.body).length !== fields.length ||
    Object.keys(value.body).some(key => !fields.includes(key))
  ) {
    return denied()
  }

  return value.body
}

/** True only for the routes owned by the Runtime adapter. The main process
 * uses this before its generic pages allowlist so a renderer cannot route an
 * almost-runtime request into a broader capability. */
export function isMatrixRuntimeRequest(
  path: unknown
): path is '/api/runtime/snapshot' | '/api/model/set' | '/api/memory/provider' {
  return path === '/api/runtime/snapshot' || path === '/api/model/set' || path === '/api/memory/provider'
}

interface NormalizedModelInfo {
  provider: string
  model: string
  contextLength?: number
}

function modelInfo(value: unknown): NormalizedModelInfo | null {
  if (!record(value) || !boundedText(value.provider) || !boundedText(value.model, 1024)) {
    return null
  }

  const context = value.effective_context_length ?? value.config_context_length ?? value.auto_context_length

  const contextLength =
    typeof context === 'number' && Number.isSafeInteger(context) && context > 0 && context <= 10_000_000
      ? context
      : undefined

  return { provider: value.provider, model: value.model, ...(contextLength === undefined ? {} : { contextLength }) }
}

interface ModelCatalog {
  provider: string
  models: string[]
}

function writesBlockedForProvider(provider: string): boolean {
  const normalized = provider.toLowerCase()

  return (
    normalized !== MATRIX_MANAGED_ENDPOINT.id &&
    (normalized === 'nous' || normalized === 'custom' || normalized === 'local' || normalized.startsWith('custom:'))
  )
}

function currentCatalog(value: unknown, provider: string): ModelCatalog | null {
  if (!record(value) || !Array.isArray(value.providers)) {
    return null
  }

  const row = value.providers.find(
    candidate =>
      record(candidate) &&
      candidate.is_current === true &&
      candidate.authenticated === true &&
      candidate.slug === provider
  )

  if (!record(row) || !Array.isArray(row.models)) {
    return null
  }

  const unavailable = new Set(
    Array.isArray(row.unavailable_models) ? row.unavailable_models.filter(model => boundedText(model, 1024)) : []
  )

  const models: string[] = []
  const seen = new Set<string>()

  for (const model of row.models) {
    if (boundedText(model, 1024) && !unavailable.has(model) && !seen.has(model)) {
      seen.add(model)
      models.push(model)
    }
  }

  return { provider, models }
}

function memorySnapshot(value: unknown): MatrixRuntimeSnapshot['memory'] {
  if (!record(value) || typeof value.active !== 'string' || value.active.length > 512 ||
    hasControl(value.active) || !Array.isArray(value.providers)) {
    return invalidResponse()
  }

  const active = value.active
  const providers: MatrixRuntimeSnapshot['memory']['providers'] = []

  if (Array.isArray(value.providers)) {
    for (const entry of value.providers) {
      if (!record(entry) || !boundedText(entry.name)) {
        continue
      }

      const status =
        entry.status === 'ready' ? 'ready' : entry.status === 'needs_config' ? 'needs_config' : 'unavailable'

      providers.push({ name: entry.name, description: boundedDescription(entry.description), status })
    }
  }

  return { active, providers }
}

function appliedModel(value: unknown, provider: string): value is Record<string, unknown> {
  return (
    record(value) && value.ok === true && value.scope === 'main' && value.provider === provider && boundedText(value.model, 1024)
  )
}

function requiresExpensiveConfirmation(
  value: unknown,
  provider: string,
  model: string
): value is Record<string, unknown> {
  return (
    record(value) &&
    value.ok === false &&
    value.scope === 'main' &&
    value.provider === provider &&
    value.model === model &&
    value.confirm_required === true
  )
}

function boundedConfirmationMessage(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !hasControl(value)
    ? value
    : 'This model may have additional cost.'
}

function memoryProviderReady(value: unknown, provider: string): boolean {
  if (provider === '') {
    return true
  }

  return (
    record(value) &&
    Array.isArray(value.providers) &&
    value.providers.some(
      entry =>
        record(entry) &&
        entry.name === provider &&
        entry.configured === true &&
        entry.available === true &&
        entry.status === 'ready'
    )
  )
}

export interface MatrixPagesRuntimeScopeDeps {
  /** Native confirmation only; the renderer never controls confirmation flags. */
  confirm(confirmation: MatrixRuntimeConfirmation): boolean | Promise<boolean>
  /** Account/executor/scope generation guard supplied by the composition root. */
  isCurrent(): boolean
  /** The selected agent's already-scoped pages transport. */
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

/** Native Runtime settings authority. It exposes one synthetic read and
 * protects the two existing Hermes writes with current-home catalog/status
 * checks and native confirmation. */
export class MatrixPagesRuntimeScope {
  constructor(private readonly deps: MatrixPagesRuntimeScopeDeps) {}

  private assertCurrent(): void {
    if (!this.deps.isCurrent()) {
      unavailable()
    }
  }

  private async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    this.assertCurrent()
    const response = await this.deps.forward(request)
    this.assertCurrent()

    return response
  }

  private async readModelInfo(): Promise<NormalizedModelInfo | null> {
    return modelInfo(await this.forward({ path: MODEL_INFO, method: 'GET' }))
  }

  private async readEligibleModel(provider: string, model: string): Promise<void> {
    const info = await this.readModelInfo()

    if (!info || info.provider !== provider || writesBlockedForProvider(provider)) {
      return invalidResponse()
    }

    const catalog = currentCatalog(await this.forward({ path: MODEL_OPTIONS, method: 'GET' }), provider)

    if (!catalog || !catalog.models.includes(model)) {
      return invalidResponse()
    }
  }

  private async snapshot(): Promise<MatrixRuntimeSnapshot> {
    const main = await this.readModelInfo()
    // Keep the synthetic response's fixed read sequence even when a malformed
    // model-info payload makes model selection read-only. This avoids making
    // the shape or upstream traffic depend on a partially trusted response.
    const options = await this.forward({ path: MODEL_OPTIONS, method: 'GET' })
    const catalog = main ? currentCatalog(options, main.provider) : null
    const memory = memorySnapshot(await this.forward({ path: MEMORY, method: 'GET' }))
    const editable = Boolean(main && catalog && !writesBlockedForProvider(main.provider))

    return {
      main,
      modelEditable: editable,
      models: editable && catalog ? catalog.models : [],
      memory
    }
  }

  private async setModel(body: Record<string, unknown>): Promise<MatrixRuntimeWriteResult> {
    if (body.scope !== 'main' || !boundedText(body.provider) || !boundedText(body.model, 1024)) {
      return denied()
    }

    const provider = body.provider
    const model = body.model
    await this.readEligibleModel(provider, model)

    let response = await this.forward({
      path: MODEL_SET,
      method: 'POST',
      body: { scope: 'main', provider, model }
    })

    if (requiresExpensiveConfirmation(response, provider, model)) {
      const confirmed = await this.deps.confirm({
        kind: 'expensive-model',
        provider,
        model,
        message: boundedConfirmationMessage(response.confirm_message)
      })

      this.assertCurrent()

      if (!confirmed) {
        return { status: 'cancelled' }
      }

      // The dialog may have outlived a selection, account, or catalog change.
      await this.readEligibleModel(provider, model)
      response = await this.forward({
        path: MODEL_SET,
        method: 'POST',
        body: { scope: 'main', provider, model, confirm_expensive_model: true }
      })
    }

    if (!appliedModel(response, provider)) {
      return invalidResponse()
    }

    const normalized = await this.readModelInfo()

    if (!normalized || normalized.provider !== response.provider || normalized.model !== response.model) {
      return invalidResponse()
    }

    const applied = response as Record<string, unknown>

    return {
      status: 'applied',
      kind: 'model',
      provider: normalized.provider,
      model: normalized.model,
      staleAux: Array.isArray(applied.stale_aux) && applied.stale_aux.length > 0
    }
  }

  private async setMemory(body: Record<string, unknown>): Promise<MatrixRuntimeWriteResult> {
    if (
      typeof body.provider !== 'string' ||
      body.provider !== body.provider.trim() ||
      body.provider.length > 512 ||
      hasControl(body.provider)
    ) {
      return denied()
    }

    const provider = body.provider

    if (!(await this.readMemoryReady(provider))) {
      return invalidResponse()
    }

    const confirmed = await this.deps.confirm({ kind: 'memory', provider })
    this.assertCurrent()

    if (!confirmed) {
      return { status: 'cancelled' }
    }

    if (!(await this.readMemoryReady(provider))) {
      return invalidResponse()
    }

    const response = await this.forward({ path: MEMORY_PROVIDER, method: 'PUT', body: { provider } })

    if (!record(response) || response.ok !== true || response.active !== provider) {
      return invalidResponse()
    }

    return { status: 'applied', kind: 'memory', active: provider }
  }

  private async readMemoryReady(provider: string): Promise<boolean> {
    return memoryProviderReady(await this.forward({ path: MEMORY, method: 'GET' }), provider)
  }

  async request(value: MatrixPagesRequest): Promise<MatrixRuntimeSnapshot | MatrixRuntimeWriteResult> {
    if (!isMatrixRuntimeRequest(value?.path)) {
      return denied()
    }

    if (value.path === '/api/runtime/snapshot') {
      exactRequest(value, '/api/runtime/snapshot', 'GET')

      return this.snapshot()
    }

    if (value.path === '/api/model/set') {
      const body = exactRequest(value, '/api/model/set', 'POST', ['scope', 'provider', 'model'])

      return this.setModel(body!)
    }

    const body = exactRequest(value, '/api/memory/provider', 'PUT', ['provider'])

    return this.setMemory(body!)
  }
}

/** Convenience factory for composition roots that prefer functions over `new`. */
export function createMatrixPagesRuntimeScope(deps: MatrixPagesRuntimeScopeDeps): MatrixPagesRuntimeScope {
  return new MatrixPagesRuntimeScope(deps)
}

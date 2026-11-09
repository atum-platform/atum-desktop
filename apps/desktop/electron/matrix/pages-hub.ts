import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import type { MatrixPagesForwardRequest } from './pages-bridge'

function denied(): never {
  throw new Error('matrix_pages_request_forbidden')
}

function unavailable(): never {
  throw new Error('matrix_pages_agent_unavailable')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasControl(value: string): boolean {
  return /[\p{Cc}]/u.test(value)
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 && !hasControl(value)
  )
}

function decodeQueryComponent(value: string): string {
  if (/%(?![0-9a-f]{2})/i.test(value)) {
    return denied()
  }

  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '))

    if (hasControl(decoded)) {
      return denied()
    }

    return decoded
  } catch {
    return denied()
  }
}

function queryEntries(raw: string): Map<string, string> {
  if (!raw) {
    return denied()
  }

  // URLSearchParams supplies the same form-query parsing used by the outgoing
  // canonical request. Validate each raw component first because it otherwise
  // tolerates malformed percent escapes and replacement-character UTF-8.
  for (const entry of raw.split('&')) {
    if (!entry) {
      return denied()
    }

    const index = entry.indexOf('=')
    decodeQueryComponent(index === -1 ? entry : entry.slice(0, index))
    decodeQueryComponent(index === -1 ? '' : entry.slice(index + 1))
  }

  const entries = new Map<string, string>()

  for (const [key, value] of new URLSearchParams(raw)) {
    if (hasControl(key) || hasControl(value)) {
      return denied()
    }

    if (entries.has(key)) {
      return denied()
    }

    entries.set(key, value)
  }

  return entries
}

function allowedQuery(entries: Map<string, string>, names: readonly string[]): void {
  for (const name of entries.keys()) {
    if (!names.includes(name)) {
      return denied()
    }
  }
}

function boundedInteger(value: string, fallback: number, maximum: number): string {
  const raw = value || String(fallback)

  if (!/^\d+$/.test(raw)) {
    return denied()
  }

  return String(Math.max(1, Math.min(maximum, Number(raw))))
}

function sourceName(value: string): string {
  if (value === 'all' || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    return value
  }

  return denied()
}

/** The backend names a hub action from a sanitized slug plus the first eight
 * SHA-1 characters of the exact install identifier. This is syntax validation
 * only; a scope must still prove that this exact name was issued upstream. */
function hubActionName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 72 &&
    /^skills-(?:install|archive|update)-[a-z0-9]+(?:-[a-z0-9]+)*-?-[a-f0-9]{8}$/.test(value)
  )
}

function issuedHubAction(value: unknown, operation: 'install' | 'archive' | 'update'): string | undefined {
  if (
    !record(value) ||
    value.ok !== true ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !hubActionName(value.name) ||
    !value.name.startsWith(`skills-${operation}-`)
  ) {
    return undefined
  }

  return value.name
}

interface NormalizedHubRequest {
  forward: MatrixPagesForwardRequest
  identifier?: string
  actionName?: string
  operation?: 'install' | 'scan' | 'archive' | 'update' | 'update-all'
}

function normalizeHubRequest(value: unknown): NormalizedHubRequest {
  if (!record(value) || Object.keys(value).some(key => !['path', 'method', 'body'].includes(key))) {
    return denied()
  }

  if (
    typeof value.path !== 'string' ||
    value.path.length > 2048 ||
    hasControl(value.path) ||
    /[\\#]/.test(value.path)
  ) {
    return denied()
  }

  const question = value.path.indexOf('?')
  const route = question === -1 ? value.path : value.path.slice(0, question)
  const rawQuery = question === -1 ? undefined : value.path.slice(question + 1)

  // Percent escapes are meaningful only in an allowlisted query. A pathname
  // never needs them, so rejecting them also closes encoded slash/traversal.
  if (!route.startsWith('/api/') || route.includes('%') || route.includes('..')) {
    return denied()
  }

  const method = value.method ?? 'GET'

  if (method !== 'GET' && method !== 'POST') {
    return denied()
  }

  const query = rawQuery === undefined ? new Map<string, string>() : queryEntries(rawQuery)
  const output = new URLSearchParams()
  let body: unknown
  let identifier: string | undefined
  let actionName: string | undefined
  let operation: NormalizedHubRequest['operation']

  if (route === '/api/skills/hub/sources' && method === 'GET') {
    allowedQuery(query, [])
  } else if (route === '/api/skills/hub/search' && method === 'GET') {
    allowedQuery(query, ['q', 'source', 'limit'])
    const q = query.get('q') ?? ''

    if (q.length > 512 || hasControl(q)) {
      return denied()
    }

    output.set('q', q)
    output.set('source', sourceName(query.get('source') ?? 'all'))
    output.set('limit', boundedInteger(query.get('limit') ?? '', 20, 50))
  } else if (['/api/skills/hub/preview', '/api/skills/hub/scan'].includes(route) && method === 'GET') {
    allowedQuery(query, ['identifier'])
    identifier = query.get('identifier') ?? ''

    if (!validIdentifier(identifier)) {
      return denied()
    }

    output.set('identifier', identifier)

    if (route === '/api/skills/hub/scan') {
      operation = 'scan'
    }
  } else if (route === '/api/skills/hub/install' && method === 'POST') {
    allowedQuery(query, [])

    if (!record(value.body) || Object.keys(value.body).length !== 1 || !validIdentifier(value.body.identifier)) {
      return denied()
    }

    identifier = value.body.identifier
    body = { identifier }
    operation = 'install'
  } else if (route === '/api/skills/hub/uninstall' && method === 'POST') {
    allowedQuery(query, [])

    if (
      !record(value.body) ||
      Object.keys(value.body).length !== 2 ||
      value.body.archive !== true ||
      !validIdentifier(value.body.name) ||
      value.body.name.length > 128 ||
      value.body.name.startsWith('.') ||
      /[\\/]/.test(value.body.name)
    ) {
      return denied()
    }

    identifier = value.body.name
    body = { name: identifier, archive: true }
    operation = 'archive'
  } else if (route === '/api/skills/hub/update-safe' && method === 'POST') {
    allowedQuery(query, [])

    if (!record(value.body) || Object.keys(value.body).length !== 1) {
      return denied()
    }

    if (value.body.all === true) {
      body = { all: true }
      identifier = 'all'
      operation = 'update-all'
    } else if (
      validIdentifier(value.body.name) &&
      value.body.name.length <= 128 &&
      !value.body.name.startsWith('.') &&
      !value.body.name.startsWith('-') &&
      !/[\\/]/.test(value.body.name)
    ) {
      identifier = value.body.name
      body = { name: identifier }
      operation = 'update'
    } else {
      return denied()
    }
  } else {
    const prefix = '/api/actions/'
    const suffix = '/status'

    const candidate =
      route.startsWith(prefix) && route.endsWith(suffix) ? route.slice(prefix.length, -suffix.length) : ''

    if (method !== 'GET' || !hubActionName(candidate)) {
      return denied()
    }

    allowedQuery(query, ['lines'])
    actionName = candidate
    output.set('lines', boundedInteger(query.get('lines') ?? '', 200, 2000))
  }

  if (body === undefined && value.body !== undefined) {
    return denied()
  }

  output.set('profile', 'default')

  return {
    forward: {
      path: `${route}?${output}`,
      method,
      ...(body === undefined ? {} : { body })
    },
    ...(identifier === undefined ? {} : { identifier }),
    ...(actionName === undefined ? {} : { actionName }),
    ...(operation === undefined ? {} : { operation })
  }
}

/** Pure hub-route allowlist. It deliberately does not call
 * `forwardMatrixPagesRequest`: that helper protects the existing installed
 * Skills/Cron surface and cannot grant this new capability. */
export function matrixPagesHubRequest(value: unknown): MatrixPagesForwardRequest {
  return normalizeHubRequest(value).forward
}

export interface MatrixPagesHubScopeDeps {
  /** Native confirmation, phrased with the selected agent and identifier. */
  confirm(
    identifier: string,
    operation: 'install' | 'scan' | 'archive' | 'update' | 'update-all'
  ): boolean | Promise<boolean>
  /** Account/executor/scope generation guard supplied by the composition root. */
  isCurrent(): boolean
  /** The selected agent's already-scoped pages transport. */
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

/**
 * Per-native-scope authority for the skills hub. Retain one instance for as
 * long as its native account/executor scope is valid (it may outlive a view),
 * then discard it on scope teardown. This lets an in-flight install keep its
 * action-status authority across a view close without granting it to another
 * selected agent or later account generation.
 */
export class MatrixPagesHubScope {
  private readonly issuedActions = new Set<string>()

  constructor(private readonly deps: MatrixPagesHubScopeDeps) {}

  async request(value: MatrixPagesRequest): Promise<unknown> {
    const normalized = normalizeHubRequest(value)

    if (!this.deps.isCurrent()) {
      return unavailable()
    }

    if (normalized.actionName && !this.issuedActions.has(normalized.actionName)) {
      return denied()
    }

    if (normalized.operation) {
      const operation = normalized.operation
      const confirmed = await this.deps.confirm(normalized.identifier!, operation)

      if (!this.deps.isCurrent()) {
        return unavailable()
      }

      if (!confirmed) {
        throw new Error(`matrix_pages_hub_${operation}_cancelled`)
      }
    }

    const response = await this.deps.forward(normalized.forward)

    if (!this.deps.isCurrent()) {
      return unavailable()
    }

    if (normalized.operation && normalized.operation !== 'scan') {
      const operation = normalized.operation === 'update-all' ? 'update' : normalized.operation
      const actionName = issuedHubAction(response, operation)

      if (!actionName) {
        throw new Error('matrix_pages_hub_invalid_action')
      }

      this.issuedActions.add(actionName)
    }

    return response
  }
}

/** Convenience factory for composition roots that prefer functions over `new`. */
export function createMatrixPagesHubScope(deps: MatrixPagesHubScopeDeps): MatrixPagesHubScope {
  return new MatrixPagesHubScope(deps)
}

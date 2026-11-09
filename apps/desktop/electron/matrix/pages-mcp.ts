import { randomUUID } from 'node:crypto'

import type {
  MatrixMcpAddInput,
  MatrixMcpCatalogEntry,
  MatrixMcpConfirmation,
  MatrixMcpOperationStatus,
  MatrixMcpResult,
  MatrixMcpServer,
  MatrixMcpSnapshot
} from '../../shared/matrix-mcp-settings'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PROFILE = 'profile=default'

const ROUTES = new Set([
  '/api/mcp/snapshot',
  '/api/mcp/add',
  '/api/mcp/remove',
  '/api/mcp/test',
  '/api/mcp/auth',
  '/api/mcp/auth/status',
  '/api/mcp/auth/cancel',
  '/api/mcp/enabled',
  '/api/mcp/install',
  '/api/mcp/install/status',
  '/api/mcp/reload'
])

const MAX_OPERATIONS = 8
const OPERATION_TTL = 15 * 60_000

function denied(): never {
  throw new Error('matrix_pages_request_forbidden')
}

function invalid(): never {
  throw new Error('matrix_mcp_response_invalid')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 1024, empty = false): value is string {
  return (
    typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\p{Cc}]/u.test(value)
  )
}

function name(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value)
}

function exact(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (
    !record(value) ||
    fields.some(key => !(key in value)) ||
    Object.keys(value).some(key => !fields.includes(key) && !optional.includes(key))
  ) {
    denied()
  }

  return value
}

function environment(value: unknown): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 32) {
    denied()
  }

  const result: Record<string, string> = {}

  for (const [key, secret] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || !text(secret, 8192, true)) {
      denied()
    }

    result[key] = secret
  }

  return result
}

function connectionUrl(value: unknown): string {
  if (!text(value, 4096)) {
    denied()
  }

  try {
    const url = new URL(value)

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      denied()
    }

    return value
  } catch {
    return denied()
  }
}

function addInput(value: unknown): MatrixMcpAddInput {
  if (!record(value) || !name(value.name)) {
    denied()
  }

  if (value.transport === 'stdio') {
    exact(value, ['name', 'transport', 'command', 'args', 'env'])

    if (
      !text(value.command, 2048) ||
      !Array.isArray(value.args) ||
      value.args.length > 64 ||
      value.args.some(arg => !text(arg, 2048, true))
    ) {
      denied()
    }

    return {
      name: value.name,
      transport: 'stdio',
      command: value.command,
      args: value.args as string[],
      env: environment(value.env)
    }
  }

  exact(value, ['name', 'transport', 'url', 'auth'], ['bearerToken'])

  if (value.transport !== 'http' || !['none', 'oauth', 'header'].includes(String(value.auth))) {
    denied()
  }

  const url = connectionUrl(value.url)

  if (value.auth === 'header' ? !text(value.bearerToken, 8192) : value.bearerToken !== undefined) {
    denied()
  }

  return {
    name: value.name,
    transport: 'http',
    url,
    auth: value.auth as 'none' | 'oauth' | 'header',
    ...(value.auth === 'header' ? { bearerToken: value.bearerToken as string } : {})
  }
}

function serverRows(value: unknown): MatrixMcpServer[] {
  if (!record(value) || !Array.isArray(value.servers) || value.servers.length > 512) {
    invalid()
  }

  return value.servers.flatMap(each => {
    if (!record(each) || !name(each.name)) {
      return []
    }

    const transport = each.transport === 'http' || each.transport === 'stdio' ? each.transport : 'unknown'

    const auth =
      each.auth === 'oauth' || each.auth === 'header'
        ? each.auth
        : each.auth == null || each.auth === 'none'
          ? 'none'
          : 'unknown'

    return [{ name: each.name, transport, auth, enabled: each.enabled !== false } as MatrixMcpServer]
  })
}

function catalogRows(value: unknown): MatrixMcpCatalogEntry[] {
  if (!record(value) || !Array.isArray(value.entries) || value.entries.length > 1024) {
    invalid()
  }

  return value.entries.flatMap(each => {
    if (!record(each) || !name(each.name)) {
      return []
    }

    const requiredEnv: MatrixMcpCatalogEntry['requiredEnv'] = []

    if (Array.isArray(each.required_env) && each.required_env.length <= 32) {
      for (const variable of each.required_env) {
        if (record(variable) && typeof variable.name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(variable.name)) {
          requiredEnv.push({
            name: variable.name,
            prompt: text(variable.prompt, 256) ? variable.prompt : variable.name,
            required: variable.required === true
          })
        }
      }
    }

    return [
      {
        name: each.name,
        description: text(each.description, 1024, true) ? each.description : '',
        transport: each.transport === 'stdio' || each.transport === 'http' ? each.transport : 'unknown',
        auth: ['none', 'oauth', 'api_key'].includes(String(each.auth_type))
          ? (each.auth_type as 'none' | 'oauth' | 'api_key')
          : 'unknown',
        installed: each.installed === true,
        enabled: each.enabled === true,
        needsInstall: each.needs_install === true,
        requiredEnv
      } as MatrixMcpCatalogEntry
    ]
  })
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0
}

export function isMatrixMcpRequest(path: unknown): boolean {
  // Own the entire prefix: near-miss paths must not fall through to a generic
  // transport or the secret-bearing upstream server/config endpoints.
  return typeof path === 'string' && path.startsWith('/api/mcp')
}

export interface MatrixPagesMcpScopeDeps {
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  isCurrent(): boolean
  confirm(confirmation: MatrixMcpConfirmation): boolean | Promise<boolean>
  /** The composition root pins the selected connection, rejects active work,
   * and invokes only reload.mcp with native confirm:true and no session_id. */
  reload(): Promise<unknown>
  /** Only a validated upstream OAuth URL reaches this native callback. */
  openExternal(url: string): void | Promise<void>
}

interface Operation {
  kind: 'auth' | 'install'
  name: string
  upstreamId: string
  created: number
  state: MatrixMcpOperationStatus
  opened: boolean
}

/** Native authority for one selected owned home and one page lifetime. No
 * automatic probes/reloads and no retries of uncertain configuration writes. */
export class MatrixPagesMcpScope {
  private stopped = false
  private pending = false
  private operations = new Map<string, Operation>()

  constructor(private readonly deps: MatrixPagesMcpScopeDeps) {}

  stop(): void {
    this.stopped = true
    this.operations.clear()
  }
  private current(): void {
    if (this.stopped || !this.deps.isCurrent()) {
      throw new Error('matrix_pages_agent_unavailable')
    }
  }
  private async forward(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<unknown> {
    this.current()

    const value = await this.deps.forward({
      path: `${path}${path.includes('?') ? '&' : '?'}${PROFILE}`,
      method,
      ...(body === undefined ? {} : { body })
    })

    this.current()

    return value
  }
  private async approved(value: MatrixMcpConfirmation): Promise<boolean> {
    this.current()
    const approved = await this.deps.confirm(value)
    this.current()

    return approved
  }
  private gc(): void {
    for (const [id, operation] of this.operations) {
      if (Date.now() - operation.created > OPERATION_TTL) {
        this.operations.delete(id)
      }
    }
  }
  private async servers(): Promise<MatrixMcpServer[]> {
    return serverRows(await this.forward('/api/mcp/servers', 'GET'))
  }
  private async knownServer(serverName: string): Promise<MatrixMcpServer> {
    const row = (await this.servers()).find(each => each.name === serverName)

    if (!row) {
      denied()
    }

    return row
  }
  private activeFor(serverName: string): boolean {
    this.gc()

    return [...this.operations.values()].some(
      each => each.name === serverName && ['starting', 'authorization_required', 'pending'].includes(each.state)
    )
  }
  private hasCapacity(): boolean {
    this.gc()

    // Terminal operations are only display acknowledgements. Bound the
    // retained map as well as the number of concurrently pending workers.
    for (const [id, operation] of this.operations) {
      if (this.operations.size < MAX_OPERATIONS) {
        break
      }

      if (['applied', 'failed', 'cancelled'].includes(operation.state)) {
        this.operations.delete(id)
      }
    }

    return (
      [...this.operations.values()].filter(each =>
        ['starting', 'authorization_required', 'pending'].includes(each.state)
      ).length < MAX_OPERATIONS
    )
  }
  private operation(id: unknown, kind: Operation['kind']): Operation {
    this.gc()

    if (typeof id !== 'string' || id.length > 100) {
      denied()
    }

    const operation = this.operations.get(id)

    if (!operation || operation.kind !== kind) {
      denied()
    }

    return operation
  }
  private async authState(id: string, operation: Operation, value: unknown): Promise<MatrixMcpResult> {
    // A synchronous local cancel may overtake a status read. Never revive that
    // continuation or open its browser after the person stopped watching it.
    if (operation.state === 'cancelled') {
      return { status: 'operation', operationId: id, state: 'cancelled' }
    }

    if (!record(value) || value.server_name !== operation.name || value.flow_id !== operation.upstreamId) {
      invalid()
    }

    let state: MatrixMcpOperationStatus

    switch (value.status) {
      case 'starting':
        state = 'starting'

        break

      case 'authorization_required':
        state = 'authorization_required'

        break

      case 'approved':
        state = 'applied'

        break

      case 'error':
        state = 'failed'

        break

      default:
        return invalid()
    }

    operation.state = state

    if (state === 'authorization_required' && !operation.opened) {
      if (!text(value.authorization_url, 8192)) {
        invalid()
      }

      const url = new URL(value.authorization_url)

      if (url.protocol !== 'https:' || url.username || url.password) {
        invalid()
      }

      this.current()
      // Spend the handoff before awaiting it. Failed/uncertain opens are not
      // automatically repeated with a one-time OAuth authorization URL.
      operation.opened = true
      await this.deps.openExternal(url.toString())
      this.current()
    }

    return { status: 'operation', operationId: id, state }
  }
  private async handle(path: string, body: unknown): Promise<MatrixMcpResult | MatrixMcpSnapshot> {
    if (path === '/api/mcp/snapshot') {
      const [servers, catalog] = await Promise.all([
        this.servers(),
        this.forward('/api/mcp/catalog', 'GET').then(catalogRows)
      ])

      return { servers, catalog }
    }

    if (path === '/api/mcp/reload') {
      if (!(await this.approved({ kind: 'mcp-reload' }))) {
        return { status: 'cancelled' }
      }

      this.current()
      const response = await this.deps.reload()
      this.current()

      if (!record(response) || response.status !== 'reloaded') {
        invalid()
      }

      return { status: 'applied' }
    }

    if (path === '/api/mcp/add') {
      const input = addInput(body)

      if ((await this.servers()).some(each => each.name === input.name)) {
        denied()
      }

      const target =
        input.transport === 'stdio'
          ? input.command
          : (() => {
              const url = new URL(input.url)

              return `${url.origin}${url.pathname}`
            })()

      if (!(await this.approved({ kind: 'mcp-add', name: input.name, transport: input.transport, target }))) {
        return { status: 'cancelled' }
      }

      const upstream =
        input.transport === 'stdio'
          ? { name: input.name, command: input.command, args: input.args, env: input.env }
          : {
              name: input.name,
              url: input.url,
              auth: input.auth,
              ...(input.bearerToken === undefined ? {} : { bearer_token: input.bearerToken })
            }

      const result = await this.forward('/api/mcp/servers', 'POST', upstream)

      if (!record(result) || result.name !== input.name) {
        invalid()
      }

      return { status: 'applied' }
    }

    if (path === '/api/mcp/auth/status' || path === '/api/mcp/auth/cancel' || path === '/api/mcp/install/status') {
      const request = exact(body, ['operationId'])
      const kind = path === '/api/mcp/install/status' ? 'install' : 'auth'
      const operation = this.operation(request.operationId, kind)
      const id = request.operationId as string

      if (path === '/api/mcp/auth/cancel') {
        operation.state = 'cancelled'

        // Hermes owns the already-authorized worker in its original home.
        // Retire continuation locally, without claiming remote rollback.
        return { status: 'operation', operationId: id, state: 'cancelled' }
      }

      if (['applied', 'failed', 'cancelled'].includes(operation.state)) {
        return { status: 'operation', operationId: id, state: operation.state }
      }

      if (kind === 'auth') {
        return this.authState(
          id,
          operation,
          await this.forward(`/api/mcp/oauth/flows/${encodeURIComponent(operation.upstreamId)}`, 'GET')
        )
      }

      const value = await this.forward(`/api/actions/${encodeURIComponent(operation.upstreamId)}/status?lines=0`, 'GET')

      if (!record(value) || value.name !== operation.upstreamId || typeof value.running !== 'boolean') {
        invalid()
      }

      operation.state = value.running ? 'pending' : value.exit_code === 0 ? 'applied' : 'failed'

      return { status: 'operation', operationId: id, state: operation.state }
    }

    if (path === '/api/mcp/install') {
      const input = exact(body, ['name', 'env'])

      if (!name(input.name)) {
        denied()
      }

      const env = environment(input.env)
      const entry = catalogRows(await this.forward('/api/mcp/catalog', 'GET')).find(each => each.name === input.name)

      if (!entry || entry.installed || this.activeFor(entry.name) || !this.hasCapacity()) {
        denied()
      }

      if (
        Object.keys(env).some(key => !entry.requiredEnv.some(each => each.name === key)) ||
        entry.requiredEnv.some(each => each.required && !env[each.name]?.trim())
      ) {
        denied()
      }

      if (!(await this.approved({ kind: 'mcp-install', name: entry.name, needsInstall: entry.needsInstall }))) {
        return { status: 'cancelled' }
      }

      const value = await this.forward('/api/mcp/catalog/install', 'POST', { name: entry.name, env, enable: true })

      if (!record(value) || value.ok !== true || value.name !== entry.name || typeof value.background !== 'boolean') {
        invalid()
      }

      if (!value.background) {
        return { status: 'applied' }
      }

      if (typeof value.action !== 'string' || !/^mcp-install-[a-z0-9-]{1,60}-[a-f0-9]{8}$/.test(value.action)) {
        invalid()
      }

      const operationId = randomUUID()
      this.operations.set(operationId, {
        kind: 'install',
        name: entry.name,
        upstreamId: value.action,
        created: Date.now(),
        state: 'pending',
        opened: false
      })

      return { status: 'operation', operationId, state: 'pending' }
    }

    const input = exact(body, path === '/api/mcp/enabled' ? ['name', 'enabled'] : ['name'])

    if (!name(input.name) || this.activeFor(input.name)) {
      denied()
    }

    const server = await this.knownServer(input.name)
    const route = `/api/mcp/servers/${encodeURIComponent(server.name)}`

    if (path === '/api/mcp/auth') {
      if (server.transport !== 'http' || !['oauth', 'none'].includes(server.auth) || !this.hasCapacity()) {
        denied()
      }

      if (!(await this.approved({ kind: 'mcp-auth', name: server.name }))) {
        return { status: 'cancelled' }
      }

      const value = await this.forward(`${route}/auth`, 'POST')

      if (!record(value) || typeof value.flow_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.flow_id)) {
        invalid()
      }

      const operationId = randomUUID()

      const operation: Operation = {
        kind: 'auth',
        name: server.name,
        upstreamId: value.flow_id,
        created: Date.now(),
        state: 'starting',
        opened: false
      }

      this.operations.set(operationId, operation)

      return this.authState(operationId, operation, value)
    }

    if (path === '/api/mcp/test') {
      if (!(await this.approved({ kind: 'mcp-test', name: server.name }))) {
        return { status: 'cancelled' }
      }

      const value = await this.forward(`${route}/test`, 'POST')

      if (!record(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.tools)) {
        invalid()
      }

      return {
        status: 'tested',
        ok: value.ok,
        toolCount: value.ok ? Math.min(value.tools.length, 1_000_000) : 0,
        prompts: value.ok ? count(value.prompts) : 0,
        resources: value.ok ? count(value.resources) : 0
      }
    }

    if (path === '/api/mcp/remove') {
      if (!(await this.approved({ kind: 'mcp-remove', name: server.name }))) {
        return { status: 'cancelled' }
      }

      const value = await this.forward(route, 'DELETE')

      if (!record(value) || value.ok !== true) {
        invalid()
      }

      return { status: 'applied' }
    }

    if (path === '/api/mcp/enabled') {
      if (typeof input.enabled !== 'boolean') {
        denied()
      }

      if (!(await this.approved({ kind: 'mcp-enabled', name: server.name, enabled: input.enabled }))) {
        return { status: 'cancelled' }
      }

      const value = await this.forward(`${route}/enabled`, 'PUT', { enabled: input.enabled })

      if (!record(value) || value.ok !== true || value.name !== server.name || value.enabled !== input.enabled) {
        invalid()
      }

      return { status: 'applied' }
    }

    return denied()
  }

  async request(request: MatrixPagesRequest): Promise<unknown> {
    this.current()
    exact(request, ['path'], ['method', 'body'])

    if (
      !ROUTES.has(request.path) ||
      (request.method ?? 'GET') !== (request.path === '/api/mcp/snapshot' ? 'GET' : 'POST')
    ) {
      denied()
    }

    if (['/api/mcp/snapshot', '/api/mcp/reload'].includes(request.path) && request.body !== undefined) {
      denied()
    }

    const mutation = ![
      '/api/mcp/snapshot',
      '/api/mcp/auth/status',
      '/api/mcp/auth/cancel',
      '/api/mcp/install/status'
    ].includes(request.path)

    if (mutation && this.pending) {
      throw new Error('pages_agent_busy')
    }

    if (mutation) {
      this.pending = true
    }

    try {
      return await this.handle(request.path, request.body)
    } catch (error) {
      if (error instanceof Error && error.message === 'pages_agent_busy') {
        throw error
      }

      throw new Error('matrix_mcp_request_failed')
    } finally {
      if (mutation) {
        this.pending = false
      }
    }
  }
}

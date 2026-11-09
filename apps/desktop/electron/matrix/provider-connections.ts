import { randomUUID } from 'node:crypto'

import type { MatrixSubscriptionsStatus } from '../../shared/matrix-subscriptions'

import { readDomainJson } from './domain'

/**
 * The account-wide OpenCode Go connection (`atum.provider-connections/1`, migration 0335).
 *
 * The owner connects once; the platform seals the key in the Shell and serves every assistant
 * from that one row. This client reads only the closed status shape (state, revision and safe
 * model descriptors), sends the key once on connect, and never receives it back. The key is
 * write-only here: it is not logged, not kept in a cache, and not returned to the window.
 */

export const MATRIX_PROVIDER_CONNECTIONS_PROFILE = 'atum.provider-connections/1' as const
export const MATRIX_PROVIDER_CONNECTIONS_PROVIDER = 'opencode_go' as const
export const MATRIX_PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u
export const MATRIX_OPENCODE_GO_KEY_MIN_BYTES = 8
export const MATRIX_OPENCODE_GO_KEY_MAX_BYTES = 512

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_SAFE = Number.MAX_SAFE_INTEGER

export type MatrixProviderConnectionsAction = 'status' | 'connect' | 'disconnect'

export interface MatrixProviderConnectionsResponse {
  status: number
  value: unknown
}

export interface MatrixProviderConnectionModel {
  id: string
  displayName: string
  efforts: readonly ('low' | 'medium' | 'high')[]
  defaultEffort: 'low' | 'medium' | 'high'
  contextBudget: number
  outputBudget: number
}

export interface MatrixProviderConnectionSnapshot {
  revision: number
  connection: {
    state: 'connected' | 'disconnected'
    revision: number
    models: readonly MatrixProviderConnectionModel[]
    connectedAt?: number
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

const EFFORTS = ['low', 'medium', 'high'] as const

export type MatrixProviderEffort = (typeof EFFORTS)[number]

function parseModel(value: unknown): MatrixProviderConnectionModel | undefined {
  if (
    !record(value) ||
    !exact(value, ['id', 'displayName', 'efforts', 'defaultEffort', 'contextBudget', 'outputBudget']) ||
    typeof value.id !== 'string' ||
    !MATRIX_PROVIDER_MODEL_ID_PATTERN.test(value.id) ||
    typeof value.displayName !== 'string' ||
    [...value.displayName].length < 1 ||
    [...value.displayName].length > 120 ||
    !Array.isArray(value.efforts) ||
    value.efforts.length > 3 ||
    new Set(value.efforts).size !== value.efforts.length ||
    !value.efforts.every(effort => EFFORTS.some(known => known === effort)) ||
    !EFFORTS.some(effort => effort === value.defaultEffort) ||
    !integer(value.contextBudget, 1, 2_000_000) ||
    !integer(value.outputBudget, 1, 2_000_000)
  ) {
    return undefined
  }

  return {
    id: value.id,
    displayName: value.displayName,
    efforts: value.efforts as MatrixProviderEffort[],
    defaultEffort: value.defaultEffort as MatrixProviderEffort,
    contextBudget: value.contextBudget,
    outputBudget: value.outputBudget
  }
}

/**
 * The one account status Settings and the picker share. The platform connection is authoritative
 * for OpenCode Go when its read succeeded; the pre-R1 local key remains the fallback only when
 * the route could not be read at all. ChatGPT keeps its existing account-store status.
 */
export function matrixSubscriptionsWithProviderConnections(
  local: MatrixSubscriptionsStatus,
  platform: MatrixProviderConnectionSnapshot | undefined
): MatrixSubscriptionsStatus {
  return {
    ...local,
    providers: local.providers.map(provider => {
      if (provider.id !== 'opencode-go') {
        return provider
      }

      if (!platform) {
        return { ...provider, source: 'local' as const }
      }

      const connected = platform.connection.state === 'connected'

      return {
        id: 'opencode-go' as const,
        connected,
        source: 'platform' as const,
        revision: platform.connection.revision,
        ...(connected
          ? {
              models: platform.connection.models.map(model => model.id),
              modelDetails: platform.connection.models
            }
          : {})
      }
    })
  }
}

/**
 * The status exactly as the closed contract states it: one opencode_go row, no credential field,
 * and no unknown key. Anything else is unavailable; a malformed answer never becomes a weak
 * "disconnected" that lets a picker offer an unusable model.
 */
export function parseMatrixProviderConnectionsStatus(value: unknown): MatrixProviderConnectionSnapshot | undefined {
  if (
    !record(value) ||
    !exact(value, ['profile', 'revision', 'connections']) ||
    value.profile !== MATRIX_PROVIDER_CONNECTIONS_PROFILE ||
    !integer(value.revision, 0, MAX_SAFE) ||
    !Array.isArray(value.connections) ||
    value.connections.length !== 1
  ) {
    return undefined
  }

  const row = value.connections[0]

  if (!record(row) || row.provider !== MATRIX_PROVIDER_CONNECTIONS_PROVIDER || !integer(row.revision, 0, MAX_SAFE)) {
    return undefined
  }

  if (!Array.isArray(row.models) || row.models.length > 64) {
    return undefined
  }

  const models = row.models.map(parseModel)

  if (models.some(model => !model)) {
    return undefined
  }

  if (row.state === 'connected') {
    if (
      !exact(row, ['provider', 'state', 'revision', 'models', 'modelPolicy', 'connectedAt', 'keyVersion']) ||
      row.modelPolicy !== 'subscription' ||
      !integer(row.connectedAt, 0, MAX_SAFE) ||
      !integer(row.keyVersion, 1, 2_147_483_647) ||
      row.revision > value.revision
    ) {
      return undefined
    }

    return {
      revision: value.revision,
      connection: {
        state: 'connected',
        revision: row.revision,
        models: models as MatrixProviderConnectionModel[],
        connectedAt: row.connectedAt
      }
    }
  }

  if (
    row.state !== 'disconnected' ||
    !exact(row, ['provider', 'state', 'revision', 'models', 'modelPolicy']) ||
    row.modelPolicy !== 'none' ||
    row.revision > value.revision
  ) {
    return undefined
  }

  return {
    revision: value.revision,
    connection: {
      state: 'disconnected',
      revision: row.revision,
      models: models as MatrixProviderConnectionModel[]
    }
  }
}

/** The key rules the platform enforces; checked before the key leaves main. */
function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)

    return code <= 0x1f || code === 0x7f
  })
}

export function parseMatrixOpenCodeGoKey(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < MATRIX_OPENCODE_GO_KEY_MIN_BYTES ||
    Buffer.byteLength(value, 'utf8') > MATRIX_OPENCODE_GO_KEY_MAX_BYTES ||
    [...value].length > MATRIX_OPENCODE_GO_KEY_MAX_BYTES ||
    hasControlCharacter(value)
  ) {
    return undefined
  }

  return value
}

/** One fixed owner route; the bearer and base stay in native main. */
export async function requestMatrixProviderConnections(
  resource: string,
  accessToken: string,
  action: MatrixProviderConnectionsAction,
  signal: AbortSignal,
  body?: unknown
): Promise<MatrixProviderConnectionsResponse> {
  signal.throwIfAborted()

  const routes = {
    status: 'provider-connections',
    connect: 'provider-connections/connect',
    disconnect: 'provider-connections/disconnect'
  } as const

  const response = await fetch(`${resource}/${routes[action]}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(action === 'status' ? {} : { 'Content-Type': 'application/json; charset=utf-8' })
    },
    ...(action === 'status' ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    return { status: response.status, value: null }
  }

  try {
    return { status: response.status, value: await readDomainJson(response, MAX_RESPONSE_BYTES) }
  } catch {
    return { status: response.status, value: null }
  }
}

export interface MatrixProviderConnectionsScope {
  accountKey: string
  generation: number
}

interface MatrixProviderConnectionsOptions {
  scope(): MatrixProviderConnectionsScope | null
  call(
    action: MatrixProviderConnectionsAction,
    signal: AbortSignal,
    body?: unknown
  ): Promise<MatrixProviderConnectionsResponse>
  changed(): void
  now?(): number
}

const TIMEOUT_MS = 20_000

function sameScope(left: MatrixProviderConnectionsScope | null, right: MatrixProviderConnectionsScope | null): boolean {
  return left?.accountKey === right?.accountKey && left?.generation === right?.generation
}

/**
 * Account-generation-fenced cache of the one OpenCode Go connection. A failed read leaves the
 * last good status in place (the row says it could not refresh); a connect/disconnect adopts the
 * platform's own answer. The key never enters this object.
 */
export class MatrixProviderConnections {
  private owner: MatrixProviderConnectionsScope | null = null
  private snapshot: MatrixProviderConnectionSnapshot | undefined
  private lastReadAt = 0

  constructor(private readonly options: MatrixProviderConnectionsOptions) {}

  activate(owner: MatrixProviderConnectionsScope | null): void {
    if (sameScope(owner, this.owner)) {
      return
    }

    this.owner = owner
    this.snapshot = undefined
    this.lastReadAt = 0
  }

  view(): MatrixProviderConnectionSnapshot | undefined {
    return this.snapshot
  }

  /** Read now unless the last success is fresh; a stale or failed read never throws. */
  async refresh(force = false): Promise<MatrixProviderConnectionSnapshot | undefined> {
    if (!this.options.scope()) {
      return undefined
    }

    const now = this.options.now?.() ?? Date.now()

    if (!force && this.snapshot && now - this.lastReadAt < 15_000) {
      return this.snapshot
    }

    let response: MatrixProviderConnectionsResponse

    try {
      response = await this.options.call('status', AbortSignal.timeout(TIMEOUT_MS))
    } catch {
      return undefined
    }

    if (!sameScope(this.owner, this.options.scope())) {
      return undefined
    }

    const next = response.status === 200 ? parseMatrixProviderConnectionsStatus(response.value) : undefined

    if (!next) {
      return undefined
    }

    this.snapshot = next
    this.lastReadAt = Date.now()
    this.options.changed()

    return next
  }

  /**
   * Connect the account's OpenCode Go key. The value is sent once and never stored here; the
   * platform's answer is the only thing kept.
   */
  async connect(value: string): Promise<boolean> {
    const key = parseMatrixOpenCodeGoKey(value)

    if (!key || !this.options.scope()) {
      return false
    }

    const body = {
      profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
      requestId: randomUUID(),
      provider: MATRIX_PROVIDER_CONNECTIONS_PROVIDER,
      credential: { kind: 'api_key', value: key }
    }

    let response: MatrixProviderConnectionsResponse

    try {
      response = await this.options.call('connect', AbortSignal.timeout(TIMEOUT_MS), body)
    } catch {
      return false
    }

    if (!sameScope(this.owner, this.options.scope())) {
      return false
    }

    const next = response.status === 200 ? parseMatrixProviderConnectionsStatus(response.value) : undefined

    if (!next || next.connection.state !== 'connected') {
      return false
    }

    this.snapshot = next
    this.lastReadAt = Date.now()
    this.options.changed()

    return true
  }

  /** Revoke the account's connection, fenced by its live revision; one conflict is re-read. */
  async disconnect(): Promise<boolean> {
    if (!this.options.scope()) {
      return false
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.refresh(true)

      if (!current) {
        return false
      }

      let response: MatrixProviderConnectionsResponse

      try {
        response = await this.options.call('disconnect', AbortSignal.timeout(TIMEOUT_MS), {
          profile: MATRIX_PROVIDER_CONNECTIONS_PROFILE,
          requestId: randomUUID(),
          provider: MATRIX_PROVIDER_CONNECTIONS_PROVIDER,
          expectedRevision: current.connection.revision
        })
      } catch {
        return false
      }

      if (!sameScope(this.owner, this.options.scope())) {
        return false
      }

      const next = response.status === 200 ? parseMatrixProviderConnectionsStatus(response.value) : undefined

      if (next) {
        this.snapshot = next
        this.lastReadAt = Date.now()
        this.options.changed()

        return next.connection.state === 'disconnected'
      }

      // 409 revision_conflict: another device connected first. Re-read once and fence again.
      if (response.status !== 409) {
        return false
      }
    }

    return false
  }
}

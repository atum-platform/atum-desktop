import { randomUUID } from 'node:crypto'

import { type SafeStorageAuthStorage } from './credential-vault'
import { type MessagingFetch, type MessagingTokenSource } from './http-client'
import type { MessagingAccountSession } from './types'

const STORAGE_KEY = 'atum-shared-group-device-v1'
const DEVICE_PREFIX = '/api/desktop/v1/group-conversations/device'
const GROUP_CONVERSATIONS_HEADER = 'x-atum-group-conversations'
const GROUP_SHARED_AGENTS_HEADER = 'x-atum-group-shared-agents'
const GROUP_CONVERSATIONS_VERSION = '1'
const GROUP_SHARED_AGENTS_VERSION = '1'
const MAX_RESPONSE_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/iu
const DEVICE_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u
const MODEL_ALIASES = new Set(['binh-minh', 'nguyet-thuc', 'nhat-thuc'])

export interface SharedGroupDeviceOptions {
  tokens: MessagingTokenSource
  storageForAccount: (accountId: string) => SafeStorageAuthStorage | null | undefined
  installationNonce: string
  clientVersion: string
  fetchImpl?: MessagingFetch
  randomUUID?: () => string
  now?: () => Date
}

export interface SharedGroupDeviceState {
  enabled: boolean
  installationId: string
  credentialExpiresAt: string
  heartbeatIntervalSeconds: number
}

export interface SharedGroupDeviceHeartbeat {
  acceptedAt: string
  nextHeartbeatSeconds: number
  credentialState: 'active' | 'rotate'
}

export interface BindSharedGroupAgentInput {
  assistantId: string
  profileIdentity: string
  modelAlias: string
  personaDigest: string
  personaRevision: number
}

interface DeviceGrant {
  installation_id: string
  device_credential: string
  credential_expires_at: string
  heartbeat_interval_seconds: number
}

interface StoredDeviceRecord {
  version: 1
  account_id: string
  base_url: string
  grant: DeviceGrant | null
  pending_rotation_id: string | null
}

interface AccountScope {
  accountId: string
  baseUrl: string
  session: MessagingAccountSession
}

function fail(code: string): never {
  throw new Error(`shared_group_device_${code}`)
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function string(value: unknown, maximum = 4096): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function normalizeBaseUrl(value: string): string {
  try {
    const parsed = new URL(value)

    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'

    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      fail('invalid_base_url')
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail('invalid_base_url')
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/u, '')

    return parsed.toString().replace(/\/$/u, '')
  } catch {
    fail('invalid_base_url')
  }
}

function parseGrant(value: unknown): DeviceGrant | null {
  const grant = object(value)

  if (!grant || !validUuid(grant.installation_id) || !validIso(grant.credential_expires_at)) {
    return null
  }

  const credential = grant.device_credential

  if (typeof credential !== 'string' || !DEVICE_CREDENTIAL.test(credential) || grant.heartbeat_interval_seconds !== 30) {
    return null
  }

  return {
    installation_id: grant.installation_id,
    device_credential: credential,
    credential_expires_at: grant.credential_expires_at,
    heartbeat_interval_seconds: 30
  }
}

function parseRecord(value: string, scope: AccountScope): StoredDeviceRecord | null {
  try {
    const record = object(JSON.parse(value))

    if (!record || record.version !== 1 || record.account_id !== scope.accountId || record.base_url !== scope.baseUrl) {
      return null
    }

    const pending = record.pending_rotation_id

    if (pending !== null && !validUuid(pending)) {
      return null
    }

    const grant = record.grant === null ? null : parseGrant(record.grant)

    if (record.grant !== null && !grant) {
      return null
    }

    return {
      version: 1,
      account_id: scope.accountId,
      base_url: scope.baseUrl,
      grant,
      pending_rotation_id: pending as string | null
    }
  } catch {
    return null
  }
}

function publicState(grant: DeviceGrant): SharedGroupDeviceState {
  return {
    enabled: true,
    installationId: grant.installation_id,
    credentialExpiresAt: grant.credential_expires_at,
    heartbeatIntervalSeconds: grant.heartbeat_interval_seconds
  }
}

function isUsable(grant: DeviceGrant, now: Date): boolean {
  return Date.parse(grant.credential_expires_at) > now.getTime()
}

/**
 * Electron-main-only account-scoped client for a device credential. The
 * credential remains in SafeStorageAuthStorage and is never an IPC value.
 */
export class SharedGroupDevice {
  private readonly fetchImpl: MessagingFetch
  private readonly newUuid: () => string
  private readonly now: () => Date
  private readonly installationNonce: string
  private readonly clientVersion: string
  private readonly bootIdentifier: string

  constructor(private readonly options: SharedGroupDeviceOptions) {
    if (!validUuid(options.installationNonce)) {
      fail('invalid_installation_nonce')
    }

    if (!string(options.clientVersion, 256)) {
      fail('invalid_client_version')
    }

    this.installationNonce = options.installationNonce
    this.clientVersion = options.clientVersion
    this.fetchImpl = options.fetchImpl ?? fetch
    this.newUuid = options.randomUUID ?? randomUUID
    this.bootIdentifier = this.uuid()
    this.now = options.now ?? (() => new Date())
  }

  /** Called only after the owner has explicitly consented to enabling sharing. */
  async enable(): Promise<SharedGroupDeviceState> {
    const scope = this.currentScope()
    const storage = this.storage(scope)
    const existing = this.record(storage, scope).grant

    if (existing && isUsable(existing, this.now())) {
      return publicState(existing)
    }

    const response = await this.request(scope, DEVICE_PREFIX, {
      method: 'POST',
      headers: this.jsonHeaders(scope),
      body: JSON.stringify({
        installation_nonce: this.installationNonce,
        device_name: 'Atum desktop',
        client_version: this.clientVersion
      })
    })

    if (!response.ok) {
      fail('request_rejected')
    }

    const grant = parseGrant(await this.json(scope, response))
    this.assertScope(scope)

    if (!grant) {
      fail('invalid_response')
    }

    this.write(storage, { ...this.blankRecord(scope), grant })

    return publicState(grant)
  }

  async heartbeat(): Promise<SharedGroupDeviceHeartbeat> {
    const scope = this.currentScope()
    const storage = this.storage(scope)
    const record = this.record(storage, scope)
    const grant = this.usableGrant(record)

    const response = await this.request(scope, `${DEVICE_PREFIX}/heartbeat`, {
      method: 'POST',
      headers: this.jsonHeaders(scope, grant.device_credential),
      body: JSON.stringify({
        boot_id: this.bootIdentifier,
        client_version: this.clientVersion,
        sent_at: this.now().toISOString()
      })
    })

    if (!response.ok) {
      fail('request_rejected')
    }

    const body = object(await this.json(scope, response))
    this.assertScope(scope)
    const nextHeartbeatSeconds = body?.next_heartbeat_seconds
    const credentialState = body?.credential_state

    if (
      !body ||
      !validIso(body.accepted_at) ||
      !boundedInteger(nextHeartbeatSeconds, 1, 3600) ||
      (credentialState !== 'active' && credentialState !== 'rotate')
    ) {
      fail('invalid_response')
    }

    if (credentialState === 'rotate') {
      await this.rotate(scope, storage, record, grant)
      this.assertScope(scope)
    }

    return {
      acceptedAt: body.accepted_at,
      nextHeartbeatSeconds,
      credentialState
    }
  }

  async bindAgent(input: BindSharedGroupAgentInput): Promise<void> {
    if (
      !validUuid(input.assistantId) ||
      !validUuid(input.profileIdentity) ||
      !MODEL_ALIASES.has(input.modelAlias) ||
      !SHA256.test(input.personaDigest) ||
      !Number.isSafeInteger(input.personaRevision) ||
      input.personaRevision < 1
    ) {
      fail('invalid_agent_binding')
    }

    const scope = this.currentScope()
    const grant = this.usableGrant(this.record(this.storage(scope), scope))

    const response = await this.request(scope, `${DEVICE_PREFIX}/agents/${input.assistantId}`, {
      method: 'POST',
      headers: this.jsonHeaders(scope, grant.device_credential),
      body: JSON.stringify({
        profile_identity: input.profileIdentity,
        model_alias: input.modelAlias,
        persona_digest: input.personaDigest,
        persona_revision: input.personaRevision
      })
    })

    if (!response.ok) {
      fail('request_rejected')
    }
  }

  async unbindAgent(assistantId: string): Promise<void> {
    if (!validUuid(assistantId)) {
      fail('invalid_agent_binding')
    }

    const scope = this.currentScope()
    const record = this.record(this.storage(scope), scope)

    // Missing or expired credentials cannot run shared jobs. Allow local
    // withdrawal without minting a new credential solely to disconnect.
    if (!record.grant || !isUsable(record.grant, this.now())) {
      return
    }

    const grant = this.usableGrant(record)

    const response = await this.request(scope, `${DEVICE_PREFIX}/agents/${assistantId}`, {
      method: 'DELETE',
      headers: this.headers(scope, grant.device_credential)
    })

    if (!response.ok) {
      fail('request_rejected')
    }
  }

  /** Main-process seam for a runner that is already scoped to an account. */
  credentialForAccount(accountId: string): string | null {
    const scope = this.currentScopeOrNull()

    if (!scope || scope.accountId !== accountId) {
      return null
    }

    const record = this.record(this.storage(scope), scope)
    const grant = record.grant

    return grant && isUsable(grant, this.now()) ? grant.device_credential : null
  }

  /** Main-process-only authenticated request, limited to group conversation routes. */
  async authenticatedRequest(path: string, input: RequestInit = {}): Promise<unknown> {
    const scope = this.currentScope()
    const grant = this.usableGrant(this.record(this.storage(scope), scope))
    const route = this.allowedPath(path)
    const headers = new Headers(input.headers)

    for (const [key, value] of this.headers(scope, grant.device_credential)) {
      headers.set(key, value)
    }

    if (input.body !== undefined && input.body !== null) {
      headers.set('content-type', 'application/json')
    }

    const response = await this.request(scope, route, { ...input, headers })

    if (!response.ok) {
      const body = object(await this.json(scope, response).catch(() => null))
      const error = object(body?.error)

      if (response.status === 404 && /\/jobs\/[^/]+\/preflight$/u.test(route)
          && error?.code === 'not_found' && object(error.details)?.reason === 'shared_job_gone') {
        fail('job_gone')
      }

      fail('request_rejected')
    }

    return this.json(scope, response)
  }

  private currentScopeOrNull(): AccountScope | null {
    const session = this.options.tokens.current()

    if (!session) {
      return null
    }

    const accountId = string(session.user?.id, 512)

    if (!accountId) {
      return null
    }

    try {
      return { accountId, baseUrl: normalizeBaseUrl(session.baseUrl), session }
    } catch {
      return null
    }
  }

  private currentScope(): AccountScope {
    return this.currentScopeOrNull() ?? fail('not_authenticated')
  }

  private assertScope(scope: AccountScope): void {
    const current = this.currentScopeOrNull()

    if (!current || current.accountId !== scope.accountId || current.baseUrl !== scope.baseUrl) {
      fail('account_changed')
    }
  }

  private storage(scope: AccountScope): SafeStorageAuthStorage {
    let storage: SafeStorageAuthStorage | null | undefined

    try {
      storage = this.options.storageForAccount(scope.accountId)
    } catch {
      fail('storage_unavailable')
    }

    if (!storage || storage.failureCode()) {
      fail('storage_unavailable')
    }

    return storage
  }

  private blankRecord(scope: AccountScope): StoredDeviceRecord {
    return { version: 1, account_id: scope.accountId, base_url: scope.baseUrl, grant: null, pending_rotation_id: null }
  }

  private record(storage: SafeStorageAuthStorage, scope: AccountScope): StoredDeviceRecord {
    const raw = storage.getItem(STORAGE_KEY)

    if (storage.failureCode()) {
      fail('storage_unavailable')
    }

    if (raw === null) {
      return this.blankRecord(scope)
    }

    const record = parseRecord(raw, scope)

    if (!record) {
      fail('storage_invalid')
    }

    return record
  }

  private write(storage: SafeStorageAuthStorage, record: StoredDeviceRecord): void {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(record))
    } catch {
      fail('storage_unavailable')
    }

    if (storage.failureCode()) {
      fail('storage_unavailable')
    }
  }

  private usableGrant(record: StoredDeviceRecord): DeviceGrant {
    if (!record.grant || !isUsable(record.grant, this.now())) {
      fail('not_enabled')
    }

    return record.grant
  }

  private headers(scope: AccountScope, credential?: string): Headers {
    const headers = new Headers({
      authorization: `Bearer ${scope.session.tokens.accessToken}`,
      [GROUP_CONVERSATIONS_HEADER]: GROUP_CONVERSATIONS_VERSION,
      [GROUP_SHARED_AGENTS_HEADER]: GROUP_SHARED_AGENTS_VERSION
    })

    if (credential) {
      headers.set('x-atum-device-credential', credential)
    }

    return headers
  }

  private jsonHeaders(scope: AccountScope, credential?: string): Headers {
    const headers = this.headers(scope, credential)
    headers.set('content-type', 'application/json')

    return headers
  }

  private async request(scope: AccountScope, route: string, input: RequestInit): Promise<Response> {
    let response = await this.fetch(scope, route, input)

    if (response.status !== 401 && response.status !== 403) {
      return response
    }

    this.assertScope(scope)
    let refreshed: MessagingAccountSession | null

    try {
      refreshed = await this.options.tokens.refresh(scope.session)
    } catch {
      this.assertScope(scope)
      fail('authentication_failed')
    }

    this.assertScope(scope)

    if (!refreshed || !this.sameAccount(scope, refreshed)) {
      fail('authentication_failed')
    }

    const retryHeaders = new Headers(input.headers)
    retryHeaders.set('authorization', `Bearer ${refreshed.tokens.accessToken}`)
    response = await this.fetch(scope, route, { ...input, headers: retryHeaders })

    return response
  }

  private async fetch(scope: AccountScope, route: string, input: RequestInit): Promise<Response> {
    let response: Response

    try {
      response = await this.fetchImpl(`${scope.baseUrl}${route}`, input)
    } catch {
      this.assertScope(scope)
      fail('request_failed')
    }

    this.assertScope(scope)

    return response
  }

  private sameAccount(scope: AccountScope, session: MessagingAccountSession): boolean {
    try {
      return session.user.id === scope.accountId && normalizeBaseUrl(session.baseUrl) === scope.baseUrl
    } catch {
      return false
    }
  }

  private async rotate(
    scope: AccountScope,
    storage: SafeStorageAuthStorage,
    record: StoredDeviceRecord,
    grant: DeviceGrant
  ): Promise<void> {
    const idempotencyKey = record.pending_rotation_id ?? this.uuid()
    this.write(storage, { ...record, pending_rotation_id: idempotencyKey })

    const response = await this.request(scope, `${DEVICE_PREFIX}/rotate`, {
      method: 'POST',
      headers: this.jsonHeaders(scope, grant.device_credential),
      body: JSON.stringify({ idempotency_key: idempotencyKey })
    })

    if (!response.ok) {
      fail('request_rejected')
    }

    const nextGrant = parseGrant(await this.json(scope, response))
    this.assertScope(scope)

    if (!nextGrant) {
      fail('invalid_response')
    }

    this.write(storage, { ...record, grant: nextGrant, pending_rotation_id: null })
  }

  private uuid(): string {
    const value = this.newUuid()

    if (!validUuid(value)) {
      fail('invalid_idempotency_key')
    }

    return value
  }

  private allowedPath(path: string): string {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/api/desktop/v1/group-conversations/') ||
      path.includes('..') ||
      path.includes('\\') ||
      path.includes('#')
    ) {
      fail('invalid_request_path')
    }

    return path
  }

  private async json(scope: AccountScope, response: Response): Promise<unknown> {
    let text: string

    try {
      text = await response.text()
    } catch {
      this.assertScope(scope)
      fail('invalid_response')
    }

    this.assertScope(scope)

    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      fail('invalid_response')
    }

    try {
      return JSON.parse(text)
    } catch {
      fail('invalid_response')
    }
  }
}

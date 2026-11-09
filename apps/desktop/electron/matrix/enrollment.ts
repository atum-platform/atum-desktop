import type {
  MatrixAppEnrollmentIdentity,
  MatrixDomainIdentity,
  MatrixEnrollment,
  MatrixEnrollmentIdentity
} from '../../shared/matrix'

import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'
import type { MatrixAppTurn } from './invocation'

/** One delivery attempt. The platform consumes the dispatch fence, strips
 * Matrix mentions and constructs the external provider envelope itself. */
export async function requestAppTurn(
  resource: string,
  grant: NativeGrant,
  app: string,
  input: MatrixAppTurn
): Promise<{ text: string }> {
  input.signal.throwIfAborted()
  const remaining = input.deadlineAt - Date.now()

  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error('matrix_invocation_expired')
  }

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.min(90_000, remaining))])

  const response = await fetch(`${resource}${matrixExecutorPath(app)}/turns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invocationId: input.invocationId,
      text: input.text,
      mentionedUserIds: input.mentionedUserIds
    }),
    redirect: 'error',
    signal
  })

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_app_turn_unavailable')
  }

  const value = (await readDomainJson(response, 128_000)) as { text?: unknown } | null
  signal.throwIfAborted()

  if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 16000) {
    throw new Error('matrix_app_turn_invalid')
  }

  return { text: value.text }
}

/** Main-only credential. Never returned from UI IPC or human SDK configuration. */
export interface AgentCredential extends MatrixEnrollmentIdentity {
  accessToken: string
}

export interface AppCredential extends MatrixAppEnrollmentIdentity {
  accessToken: string
}

/** Native selection from the authenticated, approved app catalog. */
export interface AppEnrollmentSelection {
  slug: string
  appId: string
  appVersionId: string
}

export function validateAppEnrollmentSelection(app: AppEnrollmentSelection): void {
  if (!app || !uuid(app.appId) || !uuid(app.appVersionId)) {
    throw new Error('matrix_enrollment_invalid')
  }

  matrixExecutorPath(app.slug)

  if (typeof app.slug !== 'string') {
    throw new Error('matrix_enrollment_invalid')
  }
}

/** Main-chosen registration slug only, never an arbitrary endpoint from a view. */
export function matrixExecutorPath(app?: string): string {
  if (app === undefined) {
    return '/local-hermes'
  }

  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(app)) {
    throw new Error('matrix_enrollment_invalid')
  }

  return `/apps/${app}/proxy`
}

export async function requestInvocation(
  resource: string,
  grant: NativeGrant,
  input: Record<string, unknown>,
  app?: string
): Promise<unknown> {
  const response = await fetch(`${resource}${matrixExecutorPath(app)}/invocations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (response.status === 429 && response.headers.get('content-type')?.startsWith('application/json')) {
    const value = await readDomainJson(response).catch(() => null) as { details?: { reason?: unknown } } | null
    throw new Error(value?.details?.reason === 'room_cap' ? 'matrix_group_room_cap' : 'matrix_invocation_unavailable')
  }

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_invocation_unavailable')
  }

  return readDomainJson(response)
}

/** Free group notice authority; unavailable routes never permit a local send. */
export async function requestGroupNotice(resource: string, grant: NativeGrant, input: unknown): Promise<unknown> {
  const response = await fetch(`${resource}/local-hermes/group-notice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_group_notice_unavailable')
  }

  return readDomainJson(response)
}

/** The answering-executor lease (platform 0145), taken once per session. A missing
 * route or service outage leaves authority to the existing per-message provider;
 * authentication is refreshable, but a 403 refuses this executor's authority. Normal
 * contention/stale terms are held:false. The redacted response does not identify which
 * owner/agent/executor condition failed; account custody must correlate the refusal. */
export async function requestLease(
  resource: string,
  grant: NativeGrant,
  input: { operation: 'acquire' | 'release'; executorId: string; protocol?: 2; leaseToken?: string }
): Promise<unknown> {
  const response = await fetch(`${resource}/local-hermes/lease`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_lease_authentication')
  }

  if (response.status === 403) {
    await response.body?.cancel()
    throw new Error('matrix_lease_denied')
  }

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_lease_unavailable')
  }

  return readDomainJson(response)
}

/** Permanent first-initializer claim. Failure is never permission to create keys. */
export async function requestAgentIdentity(resource: string, grant: NativeGrant, executorId: string): Promise<unknown> {
  const response = await fetch(`${resource}/local-hermes/identity`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ executorId }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_agent_identity_unavailable')
  }

  return readDomainJson(response)
}

/**
 * A compatibility read for the local-enrollment extension.  This has no authority of
 * its own: only the exact supported response permits adding the optional creation
 * binding.  Every missing, unavailable, or malformed read keeps the established
 * enrollment body so an older installed provider remains usable.
 */
export async function requestLocalEnrollmentCapabilities(resource: string, grant: NativeGrant): Promise<boolean> {
  try {
    const response = await fetch(`${resource}/local-hermes/capabilities`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${grant.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()

      return false
    }

    const value = await readDomainJson(response)

    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 2 && (value as { protocol?: unknown }).protocol === 2 &&
      (value as { hostDevice?: unknown }).hostDevice === true
  } catch {
    return false
  }
}

export async function requestEnrollment(
  resource: string,
  grant: NativeGrant,
  executorId: string,
  method: 'POST' | 'DELETE',
  app?: { slug: string; appVersionId?: string; disclosureAccepted?: true },
  /** Another of the person's agents (0146): the executor serves that agent. */
  agentPrincipal?: string,
  /** Creation-only ranking hint for a native local executor, never an app proxy. */
  hostDevice?: string
): Promise<unknown> {
  if (agentPrincipal !== undefined && (app || !uuid(agentPrincipal))) {
    throw new Error('matrix_enrollment_invalid')
  }

  if (hostDevice !== undefined && (method !== 'POST' || app || !printableDeviceId(hostDevice))) {
    throw new Error('matrix_enrollment_invalid')
  }

  if (app && method === 'POST' && (!uuid(app.appVersionId) || app.disclosureAccepted !== true)) {
    throw new Error('matrix_enrollment_invalid')
  }

  const response = await fetch(`${resource}${matrixExecutorPath(app?.slug)}`, {
    method,
    headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executorId,
      ...(app && method === 'POST'
        ? {
            appVersionId: app.appVersionId,
            disclosureAccepted: true
          }
        : {}),
      ...(agentPrincipal !== undefined && method === 'POST' ? { agentPrincipal } : {}),
      ...(hostDevice !== undefined ? { hostDevice } : {})
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_enrollment_authentication')
  }

  // A per-owner bound (platform 0150): nothing changed, and the same request succeeds
  // after Retry-After. Never retried sooner, and never shown as a failure.
  if (response.status === 429) {
    await response.body?.cancel()
    throw new MatrixEnrollmentRateLimited(matrixRetryAfterMs(response.headers.get('retry-after')))
  }

  // Authority refused this binding. The provider redacts matrix_denied/matrix_conflict
  // alike, so this is not proof of a particular suspension or tombstone. Account custody
  // correlates only an existing agent's POST refusal; DELETE remains cleanup only.
  if (response.status === 403) {
    await response.body?.cancel()
    throw new Error('matrix_enrollment_denied')
  }

  if (method === 'DELETE' && response.status === 204) {
    await response.body?.cancel()

    return null
  }

  if (
    method !== 'POST' ||
    response.status !== 200 ||
    !response.headers.get('content-type')?.startsWith('application/json')
  ) {
    await response.body?.cancel()
    throw new Error('matrix_enrollment_unavailable')
  }

  return readDomainJson(response)
}

/** An enrollment the platform refused under its per-owner bounds (0150), with how long to
 * wait before the same request can succeed. */
export class MatrixEnrollmentRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('matrix_enrollment_rate_limited')
  }
}

const RETRY_AFTER_DEFAULT_MS = 60_000
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000

/** Retry-After as milliseconds: delay-seconds (what the platform sends) or an HTTP date,
 * between 1 s and a day. Missing or unreadable, a minute. */
export function matrixRetryAfterMs(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? ''

  const ms = /^\d{1,9}$/.test(value)
    ? Number(value) * 1000
    : /[a-z]/i.test(value) && Number.isFinite(Date.parse(value))
      ? Date.parse(value) - now
      : RETRY_AFTER_DEFAULT_MS

  return Math.min(RETRY_AFTER_MAX_MS, Math.max(1000, ms))
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function printableDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,255}$/.test(value)
}

export function appCredential(
  value: unknown,
  owner: MatrixDomainIdentity,
  executorId: string,
  expected: { appId: string; appVersionId: string; ownerUserId: string },
  options: { allowExpired?: boolean } = {}
): AppCredential {
  const common = agentCredential(value, owner, executorId, options)
  const row = value as AppCredential

  if (
    !uuid(row.appId) ||
    !uuid(row.appVersionId) ||
    !uuid(row.installationId) ||
    row.appId !== expected.appId ||
    row.appVersionId !== expected.appVersionId ||
    common.userId === expected.ownerUserId ||
    !Number.isSafeInteger(row.linkEpoch) ||
    row.linkEpoch < 1
  ) {
    throw new Error('matrix_enrollment_invalid')
  }

  return {
    ...common,
    appId: row.appId,
    appVersionId: row.appVersionId,
    installationId: row.installationId,
    linkEpoch: row.linkEpoch
  }
}

export function appEnrollmentIdentity(credential: AppCredential): MatrixAppEnrollmentIdentity {
  return {
    ...enrollmentIdentity(credential),
    appId: credential.appId,
    appVersionId: credential.appVersionId,
    installationId: credential.installationId,
    linkEpoch: credential.linkEpoch
  }
}

export function agentCredential(
  value: unknown,
  owner: MatrixDomainIdentity,
  executorId: string,
  options: { allowExpired?: boolean; agentPrincipal?: string } = {}
): AgentCredential {
  const row = value as AgentCredential

  if (
    !row ||
    (options.agentPrincipal !== undefined && row.agentPrincipal !== options.agentPrincipal) ||
    row.issuer !== owner.issuer ||
    row.subject !== owner.subject ||
    row.principal !== owner.principal ||
    row.executorId !== executorId ||
    typeof row.agentPrincipal !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.agentPrincipal) ||
    row.agentPrincipal === row.principal ||
    typeof row.userId !== 'string' ||
    !/^@[^:]+:.+/.test(row.userId) ||
    row.userId.length > 1024 ||
    typeof row.deviceId !== 'string' ||
    !row.deviceId ||
    row.deviceId.length > 255 ||
    typeof row.accessToken !== 'string' ||
    !row.accessToken ||
    row.accessToken.length > 8192 ||
    !Number.isFinite(row.expiresAt) ||
    (!options.allowExpired && row.expiresAt <= Date.now()) ||
    row.expiresAt > Date.now() + 3605000
  ) {
    throw new Error('matrix_enrollment_invalid')
  }

  return {
    issuer: row.issuer,
    subject: row.subject,
    principal: row.principal,
    executorId,
    agentPrincipal: row.agentPrincipal,
    userId: row.userId,
    deviceId: row.deviceId,
    accessToken: row.accessToken,
    expiresAt: row.expiresAt
  }
}

export function enrollmentIdentity(credential: AgentCredential): MatrixEnrollmentIdentity {
  const { issuer, subject, principal, executorId, agentPrincipal, userId, deviceId, expiresAt } = credential

  return { issuer, subject, principal, executorId, agentPrincipal, userId, deviceId, expiresAt }
}

/** An enrollment's identity without its expiry: what a renewal keeps. The platform's
 * rotation re-issues the same MAS session and device with a new token and a later expiry. */
export function withoutMatrixExpiry<T extends { expiresAt: number }>(identity: T): Omit<T, 'expiresAt'> {
  const { expiresAt: _expiresAt, ...rest } = identity

  return rest
}

/** The same enrollment, even if it was renewed since: the same state, executor, agent, user
 * and device. A check made before a renewal still holds after it. */
export function sameMatrixEnrollment(current: MatrixEnrollment, previous: MatrixEnrollment): boolean {
  return (
    current.state === previous.state &&
    JSON.stringify(current.identity && withoutMatrixExpiry(current.identity)) ===
      JSON.stringify(previous.identity && withoutMatrixExpiry(previous.identity))
  )
}

/**
 * Agents that answer in the cloud, from this Mac's side (S1 WS-3b; build plan §3.1–§3.3, §4 3b).
 *
 * - **S1 owner routes:** the device-service registry, the public controller keys, an agent's
 *   answering mode and its cloud enrollment, the owner reader's enrollment and the cloud trial,
 *   each a named resource on the native domain base (never a renderer-selected URL), with strict
 *   response shapes from the contract packs.
 * - **`MacDeviceIdentity`:** this Mac's device service for the signed-in owner: the Secure Enclave
 *   keys (a key directory per owner), the device store (its own encrypted file, so the account
 *   epoch survives sign-out), the enrollment, the origin log and the hub connection. It never
 *   prompts for enrollment: sign-in reconciles it silently, and Touch ID is reserved for risky
 *   commands, browser data and cloud credentials.
 * - **`CloudAgentEnrollment`:** the owner side of an agent's cloud enrollment: create it for this
 *   Mac's Matrix device (`ownerDevice`), open the handoff window, and answer the controller's
 *   identity request through `CloudOwnerHandoff`, so the cloud device restores the agent's
 *   identity and becomes trusted.
 *
 * Main (`electron/matrix/main.ts`, its cloud-agent section) keeps a cloud agent off every local
 * writer: no executor, lease, listening or cron, and its questions go to the room for the cloud.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

import { fleetStatus } from '../../../../../packages/device-protocol/fleet-status'
import type {
  MatrixAgentServiceStatus,
  MatrixCloudAccess,
  MatrixDevicePresence,
  MatrixOriginAssertion
} from '../../../shared/matrix'
import { isMatrixCloudAccessReason } from '../../../shared/matrix-cloud-access'
import { CloudOwnerHandoff } from '../../../src/matrix/cloud-handoff-owner'
import { EncryptedStore, type SafeStorageLike } from '../../encrypted-store'
import { readDomainJson } from '../domain'

import type { ApprovalSigner } from './approvals'
import {
  DEVICE_CONNECTION,
  DeviceConnection,
  type DeviceFrameSink,
  type DeviceHelloFacts,
  type DeviceSocketFactory
} from './connection'
import type { DeviceCapability } from './contracts'
import { b64u, type DeviceKeyRun, type DeviceSigner, SecureEnclaveDeviceKeys, sha256 } from './device-key'
import {
  type ControllerKeyRecord,
  DeviceEnrollment,
  type DeviceEnrollmentOwner,
  type DeviceEnrollmentRecord,
  type DeviceEnrollmentTransport,
  DeviceRegistryError,
  type DeviceServiceRecord,
  type EnrollDeviceRequest
} from './enrollment'
import { DeviceEpochs } from './epochs'
import type { ApprovalKeyRef } from './grants-store'
import { DeviceOrigin, type OriginReceiptBody } from './origin'

export type MatrixAnswering = 'local' | 'cloud'

/** A Word document or a linked document beside a cloud agent's chat: not in S1 (plan §6, S2). */
export const MATRIX_CLOUD_AGENT_UNSUPPORTED = 'matrix_cloud_agent_unsupported'

// ------------------------------------------------------------------ S1 owner routes

export type S1Resource =
  | { kind: 'controller-keys' }
  | { kind: 'device-services' }
  | { kind: 'source-authority'; agentPrincipal: string; gate: string; expectedRevision: number | null }
  | { kind: 'device-enroll'; request: EnrollDeviceRequest }
  | { kind: 'device-revoke'; deviceServiceId: string }
  | { kind: 'answering'; agentPrincipal: string; mode: MatrixAnswering; expectedMode: MatrixAnswering }
  | { kind: 'agent-service-status'; agentPrincipal: string }
  | { kind: 'cloud-disclosure' }
  | { kind: 'cloud-enrollments' }
  | { kind: 'cloud-enroll'; requestId: string; agentPrincipal: string; ownerDevice: string; disclosureVersion: number }
  | { kind: 'cloud-enrollment-revoke'; enrollmentId: string }
  | { kind: 'cloud-handoff'; enrollmentId: string; ownerDevice: string }
  /** The owner reader (`atum.cloud-execution/1` §3.1 `owner_reader`): owner-bound, no agent. */
  | { kind: 'reader-enroll'; requestId: string; ownerDevice: string; disclosureVersion: number }
  | { kind: 'workspace'; agentPrincipal: string }
  | { kind: 'cloud-stop'; requestId: string; agentPrincipal: string; roomId: string; eventId: string }
  /** `atum.cloud-first-use/1` §4 status (its `trial` offer) and §3.3 accepting the trial. */
  | { kind: 'cloud-status' }
  | { kind: 'trial-accept'; requestId: string; offerVersion: number; disclosureVersion: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KID = /^[A-Za-z0-9_-]{43}$/
const SPKI_ED25519 = /^[A-Za-z0-9_-]{59}$/
const DEVICE = /^[!-~]{1,255}$/
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/
const CAPABILITIES: readonly DeviceCapability[] = ['terminal', 'files', 'computer', 'send_file']

const version = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2 ** 31 - 1

/** The method, path and body each S1 resource maps to (contract routes, native base). */
export function s1Route(resource: S1Resource): {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  bearer: boolean
} {
  switch (resource.kind) {
    case 'controller-keys':
      return { method: 'GET', path: '/cloud/controller-keys', bearer: false }

    case 'source-authority':
      if (!UUID.test(resource.agentPrincipal) || !['messages', 'browser', 'location', 'folders'].includes(resource.gate) ||
        !(resource.expectedRevision === null || Number.isSafeInteger(resource.expectedRevision) && resource.expectedRevision >= 0)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return { method: 'POST', path: `/agents/${resource.agentPrincipal}/source-authority`, bearer: true,
        body: { gate: resource.gate, expectedRevision: resource.expectedRevision } }

    case 'device-services':
      return { method: 'GET', path: '/device-services', bearer: true }

    case 'device-enroll':
      return { method: 'POST', path: '/device-services', body: resource.request, bearer: true }

    case 'device-revoke':
      if (!UUID.test(resource.deviceServiceId)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return { method: 'DELETE', path: `/device-services/${resource.deviceServiceId}`, bearer: true }

    case 'answering':
      if (!UUID.test(resource.agentPrincipal)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return {
        method: 'POST',
        path: `/agents/${resource.agentPrincipal}/answering`,
        body: { mode: resource.mode, expectedMode: resource.expectedMode },
        bearer: true
      }

    case 'agent-service-status':
      if (!UUID.test(resource.agentPrincipal)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return { method: 'GET', path: `/agents/${resource.agentPrincipal}/service-status`, bearer: true }

    case 'cloud-disclosure':
      return { method: 'GET', path: '/cloud/disclosure', bearer: true }

    case 'cloud-stop':
      if (
        !UUID.test(resource.requestId) ||
        !UUID.test(resource.agentPrincipal) ||
        !/^!.{1,1023}$/.test(resource.roomId) ||
        !/^\$.{1,1023}$/.test(resource.eventId)
      ) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return {
        method: 'POST',
        path: '/cloud/stop',
        bearer: true,
        body: {
          requestId: resource.requestId,
          agentPrincipal: resource.agentPrincipal,
          target: { kind: 'turn', roomId: resource.roomId, eventId: resource.eventId }
        }
      }

    case 'cloud-enrollments':
      return { method: 'GET', path: '/cloud/enrollments', bearer: true }

    case 'cloud-enrollment-revoke':
      if (!UUID.test(resource.enrollmentId)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return { method: 'DELETE', path: `/cloud/enrollments/${resource.enrollmentId}`, bearer: true }

    case 'workspace':
      if (!UUID.test(resource.agentPrincipal)) {throw new DeviceRegistryError(400, 'invalid')}

      return { method: 'POST', path: '/cloud/workspaces', body: { agentPrincipal: resource.agentPrincipal }, bearer: true }

    case 'cloud-enroll':
      return {
        method: 'POST',
        path: '/cloud/enrollments',
        body: {
          requestId: resource.requestId,
          kind: 'cloud',
          agentPrincipal: resource.agentPrincipal,
          ownerDevice: resource.ownerDevice,
          disclosureVersion: resource.disclosureVersion
        },
        bearer: true
      }

    case 'reader-enroll':
      if (!UUID.test(resource.requestId) || !DEVICE.test(resource.ownerDevice) || !version(resource.disclosureVersion)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      // No `agentPrincipal`: the Shell refuses one on an owner reader (`enrollmentInput`).
      return {
        method: 'POST',
        path: '/cloud/enrollments',
        body: {
          requestId: resource.requestId,
          kind: 'owner_reader',
          ownerDevice: resource.ownerDevice,
          disclosureVersion: resource.disclosureVersion
        },
        bearer: true
      }

    case 'cloud-status':
      return { method: 'GET', path: '/cloud/status', bearer: true }

    case 'trial-accept':
      if (!UUID.test(resource.requestId) || !version(resource.offerVersion) || !version(resource.disclosureVersion)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return {
        method: 'POST',
        path: '/cloud/trial',
        body: {
          requestId: resource.requestId,
          operation: 'accept',
          offerVersion: resource.offerVersion,
          disclosureVersion: resource.disclosureVersion
        },
        bearer: true
      }

    case 'cloud-handoff':
      if (!UUID.test(resource.enrollmentId)) {
        throw new DeviceRegistryError(400, 'invalid')
      }

      return {
        method: 'POST',
        path: `/cloud/enrollments/${resource.enrollmentId}/handoff`,
        body: { ownerDevice: resource.ownerDevice },
        bearer: true
      }
  }
}

/** The authority's workspace label for this agent; never accept a renderer path or another agent. */
export function workspaceLabelFor(value: unknown, agentPrincipal: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return null}
  const grant = value as Record<string, unknown>

  if (Object.keys(grant).sort().join(',') !== 'agentPrincipal,createdAt,grantId,label'
    || grant.agentPrincipal !== agentPrincipal || typeof grant.grantId !== 'string' || !UUID.test(grant.grantId)
    || !Number.isSafeInteger(grant.createdAt) || (grant.createdAt as number) < 0
    || typeof grant.label !== 'string' || !/^\/[!-~ ]{1,254}$/.test(grant.label)) {return null}

  return grant.label
}

export function endpoint(base: string, route: string): string {
  const url = new URL(base)

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new DeviceRegistryError(400, 'invalid')
  }

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${route}`

  return url.href
}

/**
 * One S1 request. A 401 is `matrix_s1_authentication` (the account refreshes its grant once); any
 * other refusal is a `DeviceRegistryError` with the contract's reason; no answer is status 0.
 */
export async function requestS1(
  base: string,
  resource: S1Resource,
  accessToken: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  matrixProof?: string
): Promise<unknown> {
  const route = s1Route(resource)

  if (route.bearer && !accessToken) {
    throw new Error('matrix_s1_authentication')
  }

  if (resource.kind === 'source-authority' && (!matrixProof || /[\r\n]/.test(matrixProof))) {
    throw new DeviceRegistryError(401, 'matrix_proof_required')
  }

  let response: Response

  try {
    response = await fetchImpl(endpoint(base, route.path), {
      method: route.method,
      headers: {
        ...(route.bearer ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(resource.kind === 'source-authority' ? { 'X-Atum-Matrix-Authorization': `Bearer ${matrixProof}` } : {}),
        ...(route.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    })
  } catch {
    signal.throwIfAborted()
    throw new DeviceRegistryError(0)
  }

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_s1_authentication')
  }

  if (!response.ok) {
    let reason: string | undefined

    try {
      const value = (await readDomainJson(response, 4_096)) as { details?: { reason?: unknown } } | null
      reason = typeof value?.details?.reason === 'string' ? value.details.reason : undefined
    } catch {
      // No envelope: the status alone.
    }

    throw new DeviceRegistryError(response.status, reason)
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new DeviceRegistryError(0, 'invalid')
  }

  try {
    return await readDomainJson(response, 65_536)
  } catch {
    throw new DeviceRegistryError(0, 'invalid')
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function invalid(): never {
  throw new DeviceRegistryError(0, 'invalid')
}

export function parseControllerKeys(value: unknown): ControllerKeyRecord[] {
  if (!isObject(value) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8) {
    invalid()
  }

  return value.keys.map(key => {
    if (
      !isObject(key) ||
      typeof key.kid !== 'string' ||
      !KID.test(key.kid) ||
      key.alg !== 'Ed25519' ||
      typeof key.publicKey !== 'string' ||
      !SPKI_ED25519.test(key.publicKey) ||
      (key.state !== 'active' && key.state !== 'retired') ||
      !timestamp(key.createdAt)
    ) {
      invalid()
    }

    return { kid: key.kid, alg: 'Ed25519', publicKey: key.publicKey, state: key.state, createdAt: key.createdAt }
  })
}

export function parseDeviceService(value: unknown): DeviceServiceRecord {
  const row = isObject(value) ? value : invalid()
  const matrix = isObject(row.matrix) ? row.matrix : invalid()

  if (
    typeof row.deviceServiceId !== 'string' ||
    !UUID.test(row.deviceServiceId) ||
    typeof row.displayName !== 'string' ||
    row.platform !== 'macos' ||
    typeof row.identityKeyId !== 'string' ||
    !KID.test(row.identityKeyId) ||
    typeof row.approvalKeyId !== 'string' ||
    !KID.test(row.approvalKeyId) ||
    typeof matrix.deviceId !== 'string' ||
    !DEVICE.test(matrix.deviceId) ||
    typeof matrix.fingerprint !== 'string' ||
    !FINGERPRINT.test(matrix.fingerprint) ||
    !Number.isSafeInteger(row.enrollmentEpoch) ||
    (row.enrollmentEpoch as number) < 1 ||
    !Array.isArray(row.scopes) ||
    !row.scopes.length ||
    !row.scopes.every(scope => CAPABILITIES.includes(scope as DeviceCapability)) ||
    new Set(row.scopes).size !== row.scopes.length ||
    !Array.isArray(row.pinnedControllerKeys) ||
    row.pinnedControllerKeys.length < 1 ||
    row.pinnedControllerKeys.length > 8 ||
    !row.pinnedControllerKeys.every(kid => typeof kid === 'string' && KID.test(kid)) ||
    (row.state !== 'active' && row.state !== 'revoked') ||
    !Number.isSafeInteger(row.revokeSeq) ||
    (row.revokeSeq as number) < 0 ||
    !timestamp(row.createdAt) ||
    !(row.rotatedAt === null || timestamp(row.rotatedAt)) ||
    !(row.revokedAt === null || timestamp(row.revokedAt))
  ) {
    invalid()
  }

  return {
    deviceServiceId: row.deviceServiceId,
    displayName: row.displayName,
    platform: 'macos',
    identityKeyId: row.identityKeyId,
    approvalKeyId: row.approvalKeyId,
    matrix: { deviceId: matrix.deviceId, fingerprint: matrix.fingerprint },
    enrollmentEpoch: row.enrollmentEpoch as number,
    scopes: row.scopes as DeviceCapability[],
    pinnedControllerKeys: row.pinnedControllerKeys as string[],
    state: row.state,
    revokeSeq: row.revokeSeq as number,
    createdAt: row.createdAt as number,
    rotatedAt: row.rotatedAt as number | null,
    revokedAt: row.revokedAt as number | null,
    ...fleetStatus(row)
  }
}

export function parseDeviceServices(value: unknown): DeviceServiceRecord[] {
  if (!isObject(value) || !Array.isArray(value.deviceServices) || value.deviceServices.length > 64) {
    invalid()
  }

  return value.deviceServices.map(parseDeviceService)
}

/** Registration absence is a DA fact; a disconnected socket says nothing about other Macs. */
export async function hasEnrolledCloudMac(call: S1Call, signal: AbortSignal): Promise<boolean> {
  const records = parseDeviceServices(await call({ kind: 'device-services' }, signal))
  signal.throwIfAborted()

  return records.some(record => record.state === 'active')
}

export interface AnsweringChange {
  agentPrincipal: string
  mode: MatrixAnswering
  changedAt: number
}

export function parseAnswering(value: unknown, agentPrincipal: string, mode: MatrixAnswering): AnsweringChange {
  if (
    !isObject(value) ||
    value.agentPrincipal !== agentPrincipal ||
    value.mode !== mode ||
    !timestamp(value.changedAt)
  ) {
    invalid()
  }

  return { agentPrincipal, mode, changedAt: value.changedAt }
}

const STATUS_REASON = /^[a-z][a-z0-9_]{0,63}$/

/** The Shell result is closed before it crosses main's renderer boundary. */
export function parseAgentServiceStatus(value: unknown, agentPrincipal: string): MatrixAgentServiceStatus {
  const row = isObject(value) ? value : invalid()

  const common =
    row.profile === 'atum.agent-service-status/1' &&
    row.agentPrincipal === agentPrincipal &&
    timestamp(row.asOf) &&
    (row.presentSince === undefined || timestamp(row.presentSince))

  const keys = Object.keys(row).sort().join(',')

  const exact = (required: string[]) =>
    keys === [...required, ...(row.presentSince === undefined ? [] : ['presentSince'])].sort().join(',')

  if (!common) {
    invalid()
  }

  if (row.state === 'working' && exact(['agentPrincipal', 'asOf', 'profile', 'state'])) {
    return row as MatrixAgentServiceStatus
  }

  if (
    row.state === 'server_down' &&
    timestamp(row.serverDownSince) &&
    (row.serverDownSince as number) <= (row.asOf as number) &&
    exact(['agentPrincipal', 'asOf', 'profile', 'serverDownSince', 'state'])
  ) {
    return row as MatrixAgentServiceStatus
  }

  if (
    row.state === 'refused' &&
    typeof row.reason === 'string' &&
    STATUS_REASON.test(row.reason) &&
    exact(['agentPrincipal', 'asOf', 'profile', 'reason', 'state'])
  ) {
    return row as MatrixAgentServiceStatus
  }

  invalid()
}

/** An agent's cloud enrollment as DA lists it (`atum.cloud-execution/1` `enrollment`). */
export interface CloudEnrollmentRecord {
  enrollmentId: string
  kind: 'cloud' | 'owner_reader'
  executorId: string
  deviceId: string
  state: 'provisioning' | 'awaiting_trust' | 'active' | 'revoking' | 'revoked' | 'failed'
  trust: 'pending' | 'trusted' | 'recovery_needed'
  /** Current authenticated controller lease advertises the Plan 7 turn contract. */
  conversationReady: boolean
  disclosureVersion: number
  agentPrincipal?: string
  ownerDevice?: string
  handoffUntil?: number
  createdAt: number
  updatedAt: number
}

const ENROLLMENT_STATES = new Set(['provisioning', 'awaiting_trust', 'active', 'revoking', 'revoked', 'failed'])
const TRUST = new Set(['pending', 'trusted', 'recovery_needed'])

export function parseCloudEnrollment(value: unknown): CloudEnrollmentRecord {
  const row = isObject(value) ? value : invalid()

  if (
    typeof row.enrollmentId !== 'string' ||
    !UUID.test(row.enrollmentId) ||
    (row.kind !== 'cloud' && row.kind !== 'owner_reader') ||
    typeof row.executorId !== 'string' ||
    !UUID.test(row.executorId) ||
    typeof row.deviceId !== 'string' ||
    !DEVICE.test(row.deviceId) ||
    !ENROLLMENT_STATES.has(row.state as string) ||
    !TRUST.has(row.trust as string) ||
    !Number.isSafeInteger(row.disclosureVersion) ||
    !timestamp(row.createdAt) ||
    !timestamp(row.updatedAt) ||
    (row.agentPrincipal !== undefined && (typeof row.agentPrincipal !== 'string' || !UUID.test(row.agentPrincipal))) ||
    (row.ownerDevice !== undefined && (typeof row.ownerDevice !== 'string' || !DEVICE.test(row.ownerDevice))) ||
    (row.handoffUntil !== undefined && !timestamp(row.handoffUntil))
  ) {
    invalid()
  }

  return {
    enrollmentId: row.enrollmentId,
    kind: row.kind,
    executorId: row.executorId,
    deviceId: row.deviceId,
    state: row.state as CloudEnrollmentRecord['state'],
    trust: row.trust as CloudEnrollmentRecord['trust'],
    // Older platforms omit this additive projection; malformed values are never readiness.
    conversationReady: row.conversationReady === true,
    disclosureVersion: row.disclosureVersion as number,
    ...(typeof row.agentPrincipal === 'string' ? { agentPrincipal: row.agentPrincipal } : {}),
    ...(typeof row.ownerDevice === 'string' ? { ownerDevice: row.ownerDevice } : {}),
    ...(timestamp(row.handoffUntil) ? { handoffUntil: row.handoffUntil } : {}),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number
  }
}

export type S1Call = (resource: S1Resource, signal: AbortSignal) => Promise<unknown>

/** The registry calls enrollment makes, over S1 requests. */
export function deviceRegistryTransport(call: S1Call): DeviceEnrollmentTransport {
  return {
    controllerKeys: async signal => parseControllerKeys(await call({ kind: 'controller-keys' }, signal)),
    list: async signal => parseDeviceServices(await call({ kind: 'device-services' }, signal)),
    enroll: async (request, signal) => parseDeviceService(await call({ kind: 'device-enroll', request }, signal)),
    revoke: async (deviceServiceId, signal) =>
      parseDeviceService(await call({ kind: 'device-revoke', deviceServiceId }, signal))
  }
}

/** Switches where an agent answers (`POST /agents/{p}/answering`), fenced by the mode expected. */
export async function setAgentAnswering(
  call: S1Call,
  input: { agentPrincipal: string; mode: MatrixAnswering; expectedMode: MatrixAnswering },
  signal: AbortSignal
): Promise<AnsweringChange> {
  return parseAnswering(await call({ kind: 'answering', ...input }, signal), input.agentPrincipal, input.mode)
}

// ------------------------------------------------------------------ the cloud trial (atum.cloud-first-use/1 §3)

const TRIAL_STATUSES = new Set(['eligible', 'declined', 'preparing', 'active', 'expired'])
/** `atum.cloud-first-use/1` §3.1 fixes these terms; the trial copy states them as facts. */
const TRIAL_DURATION_MS = 604_800_000
/** Every key a trial may carry (any state, §3) and exactly the terms the contract defines: an
 * unknown term would be one main's confirmation never showed, so the offer is refused. */
const TRIAL_KEYS = new Set(['offerVersion', 'status', 'startableNow', 'blockedReason', 'terms', 'acceptedAt', 'startsAt', 'endsAt', 'extendedByMs', 'reminders'])
const TRIAL_TERM_KEYS = ['autoRenew', 'cardRequired', 'concurrentTasks', 'disclosureVersion', 'durationMs', 'includedComputeSeconds', 'includedMicroProtons', 'includedStorageBytes', 'modelAliases'].join(',')
const TRIAL_STORAGE_MAX = 1_099_511_627_776
const TRIAL_BLOCKED = new Set(['cohort_budget_exhausted', 'capacity_unavailable', 'verification_required'])

const ACCESS_EFFECTIVE = new Set<MatrixCloudAccess['effective']>(['trial', 'paid', 'none'])

/**
 * The account's access from the same `GET /cloud/status` answer the offer comes from. Only the
 * two fields the window needs are read (`access.effective` and `access.reason`); the rest of the
 * response stays the trial reader's, unchanged. A reason is optional, because an access response
 * that names only `none` still means the assistant cannot answer.
 */
export function parseCloudAccess(value: unknown): MatrixCloudAccess {
  if (!isObject(value) || !isObject(value.access)) {
    invalid()
  }

  const access = value.access

  if (!ACCESS_EFFECTIVE.has(access.effective as MatrixCloudAccess['effective'])) {
    invalid()
  }

  if (access.effective === 'none') {
    if (access.reason !== undefined && !isMatrixCloudAccessReason(access.reason)) {
      invalid()
    }

    return {
      effective: 'none',
      ...(isMatrixCloudAccessReason(access.reason) ? { reason: access.reason } : {})
    }
  }

  return { effective: access.effective as 'trial' | 'paid' }
}

/**
 * Remembers the last access fact logged, keyed by the account it was read for: the line appears
 * once when the fact changes and an account switch never inherits the previous account's fact.
 */
export class CloudAccessLog {
  private last: { owner: string; fact: string } | undefined

  /** Whether this account's fact is new (and records it for the next read). */
  changed(owner: string, access: MatrixCloudAccess): boolean {
    const fact = `${access.effective}:${access.reason ?? ''}`

    if (this.last?.owner === owner && this.last.fact === fact) {
      return false
    }

    this.last = { owner, fact }

    return true
  }
}

/** The account's trial offer as `GET /cloud/status` states it (`trial` and its `terms`). */
export interface CloudTrialOffer {
  offerVersion: number
  status: 'eligible' | 'declined' | 'preparing' | 'active' | 'expired'
  startableNow: boolean
  blockedReason?: 'cohort_budget_exhausted' | 'capacity_unavailable' | 'verification_required'
  /** The cloud disclosure the offer is made under: accepting sends it back. */
  disclosureVersion: number
  durationMs: number
  computeSeconds: number
  concurrentTasks: number
  /** Read so an acceptance can be matched to the whole offer shown, not only its versions. */
  includedMicroProtons: number
  includedStorageBytes: number
}

/** The offer in a status response; null when no offer applies to this account. Terms that differ
 * from the contract's (a card, a renewal, another model) are refused: the copy promises neither. */
export function parseCloudTrial(value: unknown): CloudTrialOffer | null {
  if (!isObject(value) || !('trial' in value)) {
    invalid()
  }

  if (value.trial === null) {
    return null
  }

  const trial = isObject(value.trial) ? value.trial : invalid()
  const terms = isObject(trial.terms) ? trial.terms : invalid()

  if (Object.keys(trial).some(key => !TRIAL_KEYS.has(key)) || Object.keys(terms).sort().join(',') !== TRIAL_TERM_KEYS) {
    invalid()
  }

  if (
    !version(trial.offerVersion) ||
    !TRIAL_STATUSES.has(trial.status as string) ||
    typeof trial.startableNow !== 'boolean' ||
    (trial.blockedReason !== undefined && !TRIAL_BLOCKED.has(trial.blockedReason as string)) ||
    !version(terms.disclosureVersion) ||
    terms.durationMs !== TRIAL_DURATION_MS ||
    terms.cardRequired !== false ||
    terms.autoRenew !== false ||
    !Array.isArray(terms.modelAliases) ||
    terms.modelAliases.length !== 1 ||
    terms.modelAliases[0] !== 'default' ||
    !Number.isSafeInteger(terms.includedMicroProtons) ||
    (terms.includedMicroProtons as number) < 0 ||
    !Number.isSafeInteger(terms.includedComputeSeconds) ||
    (terms.includedComputeSeconds as number) < 0 ||
    (terms.includedComputeSeconds as number) > 604_800 ||
    !Number.isSafeInteger(terms.includedStorageBytes) ||
    (terms.includedStorageBytes as number) < 0 ||
    (terms.includedStorageBytes as number) > TRIAL_STORAGE_MAX ||
    !Number.isSafeInteger(terms.concurrentTasks) ||
    (terms.concurrentTasks as number) < 1 ||
    (terms.concurrentTasks as number) > 5
  ) {
    invalid()
  }

  return {
    offerVersion: trial.offerVersion,
    status: trial.status as CloudTrialOffer['status'],
    startableNow: trial.startableNow,
    ...(trial.blockedReason ? { blockedReason: trial.blockedReason as CloudTrialOffer['blockedReason'] } : {}),
    disclosureVersion: terms.disclosureVersion,
    durationMs: terms.durationMs as number,
    computeSeconds: terms.includedComputeSeconds as number,
    concurrentTasks: terms.concurrentTasks as number,
    includedMicroProtons: terms.includedMicroProtons as number,
    includedStorageBytes: terms.includedStorageBytes as number
  }
}

/** The same offer, term for term: what was shown is what is accepted. */
export function sameCloudTrial(a: CloudTrialOffer, b: CloudTrialOffer): boolean {
  return (
    a.offerVersion === b.offerVersion &&
    a.disclosureVersion === b.disclosureVersion &&
    a.durationMs === b.durationMs &&
    a.computeSeconds === b.computeSeconds &&
    a.concurrentTasks === b.concurrentTasks &&
    a.includedMicroProtons === b.includedMicroProtons &&
    a.includedStorageBytes === b.includedStorageBytes
  )
}

/** The offer as the window may show it: the terms the copy names, never more. */
export function shownCloudTrial(offer: CloudTrialOffer) {
  return {
    offerVersion: offer.offerVersion,
    status: offer.status,
    startableNow: offer.startableNow,
    ...(offer.blockedReason ? { blockedReason: offer.blockedReason } : {}),
    disclosureVersion: offer.disclosureVersion,
    durationMs: offer.durationMs,
    computeSeconds: offer.computeSeconds,
    concurrentTasks: offer.concurrentTasks
  }
}

/**
 * Accepts the trial the person was shown (`POST /cloud/trial`). One trial per owner and offer
 * version on every device, so the request ID is that intent's own; the clock starts only with the
 * first cloud task, never here.
 */
export async function acceptCloudTrial(
  call: S1Call,
  input: { ownerUserId: string; offerVersion: number; disclosureVersion: number },
  signal: AbortSignal
): Promise<'preparing' | 'active'> {
  const value = await call(
    {
      kind: 'trial-accept',
      requestId: cloudRequestId(`atum.cloud-trial:${input.ownerUserId}:${input.offerVersion}:${input.disclosureVersion}`),
      offerVersion: input.offerVersion,
      disclosureVersion: input.disclosureVersion
    },
    signal
  )

  const status = isObject(value) && isObject(value.trial) ? value.trial.status : undefined

  if (status !== 'preparing' && status !== 'active') {
    invalid()
  }

  return status
}

// ------------------------------------------------------------------ this Mac's device service

/**
 * Why this Mac's device service has no owner to enroll for or sign as right now: one code for the
 * log line and for what Settings tells the person.
 */
export type DeviceOwnerRefusal = 'matrix_signed_out' | 'device_owner_not_ready' | 'device_owner_fingerprint_unavailable'

export interface DeviceOwnerFacts {
  /** The signed-in person (the account's identity), or null while signed out. */
  human: { userId: string; deviceId: string } | null | undefined
  /**
   * The human SDK's snapshot state. The human host's readiness is the snapshot's: `host.ready` is
   * set only for agent and app hosts (`matrixHumanSdkReady`), so it can never gate the owner.
   */
  sdkState: string
  host: { identity: { userId: string; deviceId: string } } | undefined
  /** The person's Matrix devices as their own SDK lists them (the `devices` command). */
  devices(userId: string): Promise<unknown>
  /** Fingerprints already read on this Mac: a device's never changes. */
  fingerprints: Map<string, string>
}

/** The owner's Matrix device on this Mac and its ed25519 fingerprint, or why it has none yet. */
export async function resolveDeviceOwner(facts: DeviceOwnerFacts): Promise<DeviceEnrollmentOwner | DeviceOwnerRefusal> {
  const { human, host } = facts

  if (!human) {
    return 'matrix_signed_out'
  }

  if (
    facts.sdkState !== 'ready' ||
    !host ||
    host.identity.userId !== human.userId ||
    host.identity.deviceId !== human.deviceId
  ) {
    return 'device_owner_not_ready'
  }

  const key = `${human.userId}\n${human.deviceId}`
  let fingerprint = facts.fingerprints.get(key)

  if (!fingerprint) {
    const devices = await facts.devices(human.userId).catch(() => null)

    const own = Array.isArray(devices)
      ? (devices as { deviceId?: unknown; fingerprint?: unknown }[]).find(each => each?.deviceId === human.deviceId)
      : undefined

    if (typeof own?.fingerprint !== 'string' || !own.fingerprint) {
      return 'device_owner_fingerprint_unavailable'
    }

    fingerprint = own.fingerprint
    facts.fingerprints.set(key, fingerprint)
  }

  return { userId: human.userId, deviceId: human.deviceId, fingerprint }
}

/** A closed code for one enrollment failure, for the log line and the Settings message. */
export function deviceEnrollmentCode(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'device_enrollment_timeout'
  }

  return error instanceof Error && /^[a-z0-9_:]{1,120}$/u.test(error.message) ? error.message : 'unexpected'
}

/** A short, stable scope for one owner (key directory and store namespace). */
export function deviceOwnerScope(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32)
}

type OwnerSigner = DeviceSigner & { discard?(): Promise<void> }

interface OwnerDevice {
  userId: string
  keys: OwnerSigner
  store: EncryptedStore
  enrollment: DeviceEnrollment
  origin: DeviceOrigin
  connection: DeviceConnection
  approvalKey?: ApprovalKeyRef
}

export interface MacDeviceIdentityOptions {
  userData: string
  safeStorage: SafeStorageLike
  /** The Secure Enclave helper, or null when this build has none. */
  helper: string | null
  hubUrl: string
  /** S1 owner routes, with the owner's native grant (the controller keys need none). */
  call: S1Call
  /** The owner's Matrix device on this Mac, with its fingerprint; null while signed out, or why it
   * cannot be read yet (`resolveDeviceOwner`). */
  owner(): Promise<DeviceEnrollmentOwner | DeviceOwnerRefusal | null>
  hello(): DeviceHelloFacts
  locale(): string | undefined
  displayName(): string
  osVersion(): string
  socket?: DeviceSocketFactory
  run?: DeviceKeyRun
  /** Tests only: a software signer in place of the Secure Enclave helper. */
  signerFor?(keyDir: string): OwnerSigner
  /** Main's one notification after every successful enrollment entry point. */
  onEnrolled?(): Promise<void> | void
  log(line: string): void
}

/** This Mac's device service as the renderer sees it (`shared/matrix.ts`). */
export type MacDevicePresence = MatrixDevicePresence

/** This Mac's name as the owner set it (System Settings › General › About), for the registry;
 * the host name when it cannot be read. */
export function macComputerName(
  read: () => string = () =>
    execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 5_000 })
): string {
  try {
    const name = read().trim()

    if (name) {
      return Array.from(name).slice(0, 64).join('')
    }
  } catch {
    // Not macOS, or no name set.
  }

  return Array.from(hostname().replace(/\.local$/u, '') || 'Mac')
    .slice(0, 64)
    .join('')
}

export class MacDeviceIdentity {
  readonly store: EncryptedStore
  readonly epochs: DeviceEpochs
  private device?: OwnerDevice
  private sink?: DeviceFrameSink
  private helloFacts?: () => DeviceHelloFacts
  private suspended = false

  constructor(private readonly options: MacDeviceIdentityOptions) {
    this.store = new EncryptedStore(path.join(options.userData, 'device', 'device-service.json'), options.safeStorage)
    this.epochs = new DeviceEpochs({ store: this.store })
  }

  /** The device service for this owner, made once; another owner gets their own keys and store. */
  private deviceFor(userId: string): OwnerDevice {
    if (this.device?.userId === userId) {
      return this.device
    }

    this.device?.connection.stop('account_switch')
    const scope = deviceOwnerScope(userId)
    const store = this.store.scope(`owner:${scope}:`)

    const keyDir = path.join(this.options.userData, 'device', 'keys', scope)

    const keys: OwnerSigner =
      this.options.signerFor?.(keyDir) ??
      new SecureEnclaveDeviceKeys({ binary: this.options.helper, keyDir, run: this.options.run })

    const enrollment = new DeviceEnrollment({
      store,
      signer: keys,
      transport: deviceRegistryTransport(this.options.call),
      displayName: () => this.options.displayName(),
      osVersion: () => this.options.osVersion(),
      log: line => this.options.log(line)
    })

    const origin = new DeviceOrigin({
      store,
      signer: keys,
      identity: () => {
        const record = enrollment.current()

        return record?.state === 'active'
          ? {
              deviceServiceId: record.deviceServiceId,
              identityKid: record.identityKid,
              enrollmentEpoch: record.enrollmentEpoch
            }
          : null
      },
      accountEpoch: () => this.epochs.accountEpoch(),
      bootId: () => this.epochs.bootId()
    })

    const connection = new DeviceConnection({
      url: this.options.hubUrl,
      socket: this.options.socket,
      enrollment,
      signer: keys,
      epochs: this.epochs,
      hello: () => (this.helloFacts ?? this.options.hello)(),
      ...(this.sink ? { sink: this.sink } : {}),
      origin,
      log: line => this.options.log(line)
    })


    this.device = { userId, keys, store, enrollment, origin, connection }

    return this.device
  }

  /** The signed-in owner's device service when its enrollment is bound to this Matrix device, or
   * why there is no owner to bind it to. */
  private async bound(): Promise<{ device: OwnerDevice; owner: DeviceEnrollmentOwner } | { refused: DeviceOwnerRefusal }> {
    const epoch = this.epochs.accountEpoch()
    const owner = await this.options.owner()

    // Signed out (or out and in again) while the owner was read: nothing of that account is used.
    if (!owner || epoch !== this.epochs.accountEpoch()) {
      return { refused: 'matrix_signed_out' }
    }

    return typeof owner === 'string' ? { refused: owner } : { device: this.deviceFor(owner.userId), owner }
  }

  /** At sign-in and on the background cadence, reconcile this owner/Mac with the registry and
   * connect it. A missing row, account switch or stale binding is repaired silently. */
  async activate(): Promise<MacDevicePresence> {
    if (!this.options.helper) {
      return { state: 'unavailable' }
    }

    const bound = await this.bound()

    if ('refused' in bound) {
      return { state: 'signed_out' }
    }

    await bound.device.enrollment.ensure(bound.owner, AbortSignal.timeout(30_000), { verifyRegistry: true })
    await this.loadApprovalKey(bound.device)

    if (this.device !== bound.device) {return this.presence()}

    if (!this.suspended) {
      bound.device.connection.start()
    }

    try {
      await this.options.onEnrolled?.()
    } catch {
      this.options.log('[Device] enrollment succeeded; its visible status will refresh on the next sync')
    }

    return this.presence()
  }

  /**
   * Enrolls this Mac silently, then connects. A failure logs one line with its code and rejects.
   */
  async enroll(signal: AbortSignal, options: { refreshPins?: boolean } = {}): Promise<DeviceEnrollmentRecord> {
    try {
      return await this.enrollNow(signal, options)
    } catch (error) {
      this.options.log(`[Device] this Mac was not enrolled: ${deviceEnrollmentCode(error)}`)
      throw error
    }
  }

  private async enrollNow(signal: AbortSignal, options: { refreshPins?: boolean }): Promise<DeviceEnrollmentRecord> {
    if (!this.options.helper) {
      throw new Error('device_unavailable')
    }

    const bound = await this.bound()

    if ('refused' in bound) {
      throw new Error(bound.refused)
    }

    const record = await bound.device.enrollment.ensure(bound.owner, signal, options)
    await this.loadApprovalKey(bound.device)

    if (this.device !== bound.device) {throw new Error('matrix_signed_out')}

    if (!this.suspended) {
      bound.device.connection.start()
    }

    try {
      await this.options.onEnrolled?.()
    } catch {
      // The enrollment succeeded. Main will also reconcile on the next ready/sync snapshot.
      this.options.log('[Device] enrollment succeeded; its visible status will refresh on the next sync')
    }

    return record
  }

  /**
   * This Mac's origin assertion for a question to a cloud agent: `content` is exactly what the SDK
   * sends (`matrixTurnContent`). With `enroll`, an unenrolled Mac is enrolled silently first;
   * without it, or if enrollment is unavailable, the question goes without one (the cloud then treats it
   * like the phone: cloud work, no reach-down to this Mac). A question asked for enrollment that
   * goes without an origin always logs one line saying why.
   */
  async originFor(
    input: { transactionId: string; roomId: string; agentUserId: string; content: Record<string, unknown> },
    options: { enroll: boolean; signal?: AbortSignal }
  ): Promise<MatrixOriginAssertion | null> {
    const without = (code: string): null => {
      this.options.log(`[Device] question sent without an origin: ${code}`)

      return null
    }

    const bound = await this.bound()

    if ('refused' in bound) {
      return options.enroll ? without(bound.refused) : null
    }

    if (!this.options.helper) {
      return options.enroll ? without('device_unavailable') : null
    }

    if (!bound.device.enrollment.activeFor(bound.owner)) {
      if (!options.enroll) {
        return null
      }

      try {
        await this.enrollNow(options.signal ?? new AbortController().signal, {})
      } catch (error) {
        const code = deviceEnrollmentCode(error)

        return without(code)
      }
    }

    if (!bound.device.enrollment.activeFor(bound.owner)) {
      return without('device_enrollment_inactive')
    }

    await this.loadApprovalKey(bound.device)

    if (this.device !== bound.device) {return without('matrix_signed_out')}

    // Enrolled: the hub connection should be up for the turn this question starts.
    if (!this.suspended) {
      bound.device.connection.start()
    }

    try {
      return await bound.device.origin.assert({ ...input, owner: bound.owner })
    } catch (error) {
      return without(error instanceof Error ? error.message : 'unsigned')
    }
  }

  /** The chat server holds the question (`eventId`): log its origin and offer the receipt. */
  questionSent(transactionId: string, roomId: string, eventId: string): void {
    const device = this.device

    if (!device) {
      return
    }

    try {
      if (device.origin.sent(transactionId, roomId, eventId).length) {
        void device.connection.flushOriginReceipts()
      }
    } catch (error) {
      this.options.log(`[Device] origin log not written: ${error instanceof Error ? error.message : 'unexpected'}`)
    }
  }

  /** Device admission step 9 (WS-4): this Mac logged this assertion for exactly this event. */
  originMatches(receipt: OriginReceiptBody): boolean {
    return this.device?.origin.matches(receipt) ?? false
  }

  /** The origin log as WS-4's `DeviceService` reads it (`originLog()`); empty while signed out. */
  originLog(): OriginReceiptBody[] {
    return this.device?.origin.entries() ?? []
  }

  /**
   * A `device_send_file` artifact the device host wrote (WS-4 `DeviceService` `sendArtifact`): read
   * without following a link, checked against the size and SHA-256 the Receipt will sign, then sent
   * as chunk frames on the current connection. False when it cannot be sent as signed.
   */
  async sendArtifact(
    commandId: string,
    artifact: { name: string; size: number; sha256: string; path: string }
  ): Promise<boolean> {
    const connection = this.device?.connection

    if (!connection || !Number.isSafeInteger(artifact.size) || artifact.size > DEVICE_CONNECTION.artifactMaxBytes) {
      return false
    }

    let bytes: Buffer

    try {
      const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW)

      try {
        const info = await handle.stat()

        if (!info.isFile() || info.size !== artifact.size) {
          return false
        }

        bytes = await handle.readFile()
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }

    if (bytes.length !== artifact.size || b64u(sha256(bytes)) !== artifact.sha256) {
      this.options.log('[Device] a file was not sent: it changed after the command read it')

      return false
    }

    try {
      return connection.sendArtifact(commandId, artifact.name, bytes)
    } catch {
      return false
    }
  }

  /** WS-4's device service takes over admission, and says what this Mac can do in each Hello. */
  attach(sink: DeviceFrameSink, hello?: () => DeviceHelloFacts): void {
    this.sink = sink
    this.helloFacts = hello ?? this.helloFacts
    this.device?.connection.attach(sink)
  }

  connection(): DeviceConnection | null {
    return this.device?.connection ?? null
  }

  private async loadApprovalKey(device: OwnerDevice): Promise<void> {
    const key = (await device.keys.publicKeys()).approval

    if (this.device === device && device.enrollment.current()?.approvalKid === key.kid) {
      device.approvalKey = key
    }
  }

  /** Main-only live approval handles; no key material crosses renderer IPC. */
  approvalSigner(): ApprovalSigner | null {
    return this.approvalKey() ? this.device!.keys : null
  }

  approvalKey(): ApprovalKeyRef | null {
    const device = this.device
    const enrollment = device?.enrollment.current()

    return enrollment?.state === 'active' && enrollment.approvalKid === device?.approvalKey?.kid
      ? device!.approvalKey!
      : null
  }

  enrollment(): DeviceEnrollmentRecord | null {
    return this.device?.enrollment.current() ?? null
  }

  /**
   * This Mac's signing handle as an `atum.agent-home/2.1` executor (agent-home-placement/executor-auth.ts):
   * the active enrollment's `deviceServiceId`, its epoch and its identity key. The platform pins exactly
   * this key per device service; the Secure Enclave signs it without a prompt and no key material leaves
   * the helper. Null while there is no active enrollment.
   */
  executorKey(): {
    deviceServiceId: string
    enrollmentEpoch: number
    identityKid: string
    signIdentity(bytes: Uint8Array): Promise<{ kid: string; sig: string }>
  } | null {
    const device = this.device
    const record = device?.enrollment.current()

    return device && record?.state === 'active'
      ? {
          deviceServiceId: record.deviceServiceId,
          enrollmentEpoch: record.enrollmentEpoch,
          identityKid: record.identityKid,
          signIdentity: bytes => device.keys.signIdentity(bytes)
        }
      : null
  }

  /**
   * What a browser import signs with: this owner's enrolled device, its Secure Enclave keys, and the controller
   * keys this Mac pinned at enrollment. Main-only and read live; null until this Mac is enrolled with its approval
   * key loaded (`browser-import/service.ts` enrolls first when it is not).
   */
  browserImportDevice(): {
    userId: string
    deviceServiceId: string
    signer: DeviceSigner
    approvalKey: ApprovalKeyRef
    identityKid: string
    controllerKeys: { kid: string; publicKey: string }[]
  } | null {
    const device = this.device
    const enrollment = device?.enrollment.current()
    const approvalKey = this.approvalKey()

    if (!device || enrollment?.state !== 'active' || !approvalKey) {
      return null
    }

    return {
      userId: device.userId,
      deviceServiceId: enrollment.deviceServiceId,
      signer: device.keys,
      approvalKey,
      identityKid: enrollment.identityKid,
      controllerKeys: enrollment.controllerKeys.filter(key => enrollment.pinnedControllerKeys.includes(key.kid))
    }
  }

  presence(): MacDevicePresence {
    const device = this.device

    if (!device) {
      return { state: 'signed_out' }
    }

    if (!this.options.helper) {
      return { state: 'unavailable' }
    }

    const record = device.enrollment.current()

    return record?.state === 'active'
      ? {
          state: 'enrolled',
          connection: device.connection.state(),
          deviceServiceId: record.deviceServiceId,
          enrollmentEpoch: record.enrollmentEpoch
        }
      : { state: 'not_enrolled' }
  }

  /** Sleep: the connection's epoch is dead before anything else happens. */
  suspend(): void {
    this.suspended = true
    this.device?.connection.suspend()
  }

  resume(): void {
    this.suspended = false
    this.device?.connection.resume()
  }

  /**
   * Sign-out or an account switch: synchronous, before any await. The account epoch moves on (no
   * grant, approval or command of the old account is admitted again) and the connection closes
   * with a signed Stop. The keys and the enrollment stay for this owner's next sign-in.
   */
  signOut(reason: 'sign_out' | 'account_switch' = 'sign_out'): void {
    this.epochs.bumpAccountEpoch()
    this.device?.connection.stop(reason)
    this.device = undefined
  }
}

// ------------------------------------------------------------------ the owner side of a cloud enrollment

/** A request ID the platform keeps idempotent: the same intent always names the same request. */
export function cloudRequestId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * The owner-reader disclosure this build shows the person (Settings › Cloud and devices): an Atum
 * device in the cloud reads the conversations they include while every Mac is off. The platform
 * accepts the enrollment only while its active `owner_reader` disclosure is this version
 * (`400 consent_required` otherwise); the Shell has no read of that version, so it is the text's.
 */
export const OWNER_READER_DISCLOSURE_VERSION = 1

/** The owner reader as Settings shows it: none, being made, its trust being checked with this
 * Mac, ready, or stuck (failed or needing recovery). An active reader is ready whatever its
 * trust (0.20): it reads plain rooms without it, and trust only adds keys for encrypted ones. */
export type OwnerReaderState = 'none' | 'provisioning' | 'awaiting_trust' | 'ready' | 'needs_attention'

/** The owner's reader in DA's enrollment list (newest first): the newest that is not revoked. */
export function ownerReaderState(rows: readonly CloudEnrollmentRecord[]): OwnerReaderState {
  const row = rows.find(each => each.kind === 'owner_reader' && each.state !== 'revoked' && each.state !== 'revoking')

  if (!row) {
    return 'none'
  }

  if (row.state === 'active' && row.trust !== 'recovery_needed') {
    return 'ready'
  }

  return (row.state === 'provisioning' || row.state === 'awaiting_trust') && row.trust === 'pending'
    ? row.state
    : 'needs_attention'
}

export interface CloudAgentEnrollmentDeps {
  call: S1Call
  /** The owner's Matrix device on this Mac (the enrollment's `ownerDevice`). */
  ownerDevice(): string | null
  /** The roster as DA returns it (`GET /agents`), for the handoff's own agent check. */
  roster(): Promise<unknown>
  /** The owner's SDK host: to-device events with the agent's cloud device, and the recovery slot. */
  receive(sender: { userId: string; deviceId: string }): Promise<unknown>
  send(recipient: { userId: string; deviceId: string }, event: { type: string; content: unknown }): Promise<void>
  recoveryKey(agentUserId: string, key?: string): Promise<string | null>
  log(line: string): void
  now?(): number
  pumpMs?: number
  revokeSweepMs?: number
}

export interface CloudEnrollmentAttempt {
  enrollment: CloudEnrollmentRecord
  /** True only when this call issued the create after observing no live enrollment. */
  created: boolean
}

/**
 * Moves an agent's cloud enrollment to trusted from this Mac: the platform needs it before an agent
 * may answer in the cloud (`cloud_enrollment_required`).
 */
export class CloudAgentEnrollment {
  private handoff?: CloudOwnerHandoff
  private timer?: ReturnType<typeof setInterval>
  private revocationTimer?: ReturnType<typeof setInterval>
  private revocationSweep?: Promise<void>
  private pendingRevocations = new Set<string>()
  private watching = new Set<string>()

  constructor(private readonly deps: CloudAgentEnrollmentDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async list(signal: AbortSignal): Promise<CloudEnrollmentRecord[]> {
    const value = await this.deps.call({ kind: 'cloud-enrollments' }, signal)

    if (!isObject(value) || !Array.isArray(value.enrollments) || value.enrollments.length > 64) {
      invalid()
    }

    return value.enrollments.map(parseCloudEnrollment)
  }

  /** This agent's live cloud enrollment (not revoked or failed), newest first. */
  async current(agentPrincipal: string, signal: AbortSignal): Promise<CloudEnrollmentRecord | null> {
    return (
      (await this.list(signal)).find(
        row =>
          row.kind === 'cloud' &&
          row.agentPrincipal === agentPrincipal &&
          row.state !== 'revoked' &&
          row.state !== 'revoking' &&
          row.state !== 'failed'
      ) ?? null
    )
  }

  /** The owner reader as Settings shows it (`ownerReaderState`). */
  async reader(signal: AbortSignal): Promise<OwnerReaderState> {
    return ownerReaderState(await this.list(signal))
  }

  /**
   * Creates the owner reader for this Mac's Matrix device, or returns the one there is (the
   * platform keeps one per owner and converges concurrent requests on it). Its trust then moves on
   * through main's owner-reader trust poll: the handoff window to this device, cross-signing, and
   * the SAS compared through the owner domain (`owner-reader-trust.ts`).
   */
  async enrollReader(signal: AbortSignal): Promise<OwnerReaderState> {
    const ownerDevice = this.deps.ownerDevice()

    if (!ownerDevice) {
      throw new Error('device_owner_not_ready')
    }

    const rows = await this.list(signal)
    const state = ownerReaderState(rows)

    if (state !== 'none') {
      return state
    }

    // A reader revoked before keeps its request receipt: a new one is a new request.
    const previous = rows.find(row => row.kind === 'owner_reader')?.enrollmentId ?? 'first'

    const enrollment = this.enrollmentOf(
      await this.deps.call(
        {
          kind: 'reader-enroll',
          requestId: cloudRequestId(
            `atum.reader-enroll:${ownerDevice}:${OWNER_READER_DISCLOSURE_VERSION}:${previous}`
          ),
          ownerDevice,
          disclosureVersion: OWNER_READER_DISCLOSURE_VERSION
        },
        signal
      )
    )

    if (enrollment.kind !== 'owner_reader') {
      invalid()
    }

    return ownerReaderState([enrollment])
  }

  private enrollmentOf(value: unknown): CloudEnrollmentRecord {
    if (!isObject(value)) {
      invalid()
    }

    return parseCloudEnrollment(value.enrollment)
  }

  private agentEnrollmentOf(value: unknown, agentPrincipal: string): CloudEnrollmentRecord {
    const enrollment = this.enrollmentOf(value)

    if (enrollment.kind !== 'cloud' || enrollment.agentPrincipal !== agentPrincipal) {
      invalid()
    }

    return enrollment
  }

  /**
   * Creates (or reuses) the agent's cloud enrollment for this Mac's Matrix device and, while it
   * awaits trust, keeps the handoff window open to this Mac and answers the controller's identity
   * request. Resolves with the enrollment as it stands; `waitTrusted` polls it until it is active.
   */
  async beginAttempt(agentPrincipal: string, signal: AbortSignal): Promise<CloudEnrollmentAttempt> {
    const ownerDevice = this.deps.ownerDevice()

    if (!ownerDevice || !UUID.test(agentPrincipal)) {
      throw new DeviceRegistryError(400, 'invalid')
    }

    let enrollment = await this.current(agentPrincipal, signal)
    const created = !enrollment

    if (!enrollment) {
      const disclosure = await this.deps.call({ kind: 'cloud-disclosure' }, signal)

      if (!isObject(disclosure) || disclosure.kind !== 'cloud' || !Number.isSafeInteger(disclosure.version)) {
        invalid()
      }

      const disclosureVersion = disclosure.version as number

      enrollment = this.agentEnrollmentOf(
        await this.deps.call(
          {
            kind: 'cloud-enroll',
            requestId: cloudRequestId(`atum.cloud-enroll:${agentPrincipal}:${ownerDevice}:${disclosureVersion}`),
            agentPrincipal,
            ownerDevice,
            disclosureVersion
          },
          signal
        ),
        agentPrincipal
      )

      this.remember(enrollment.enrollmentId)
    }

    // Awaiting trust: the window must be open to THIS device, and this device must have made or
    // renewed it (the handoff's own rule), so it is renewed from here.
    if (enrollment.state === 'awaiting_trust') {
      enrollment = this.agentEnrollmentOf(
        await this.deps.call({ kind: 'cloud-handoff', enrollmentId: enrollment.enrollmentId, ownerDevice }, signal),
        agentPrincipal
      )

      this.remember(enrollment.enrollmentId)
    }

    if (enrollment.state === 'provisioning' || enrollment.state === 'awaiting_trust') {
      this.watch(agentPrincipal)
    }

    return { enrollment, created }
  }

  async begin(agentPrincipal: string, signal: AbortSignal): Promise<CloudEnrollmentRecord> {
    return (await this.beginAttempt(agentPrincipal, signal)).enrollment
  }

  /** Polls until the agent's cloud enrollment is active (trusted), or the window closes. */
  async waitTrusted(
    agentPrincipal: string,
    signal: AbortSignal,
    timeoutMs = 10 * 60_000
  ): Promise<CloudEnrollmentRecord> {
    const deadline = this.now() + timeoutMs

    while (this.now() < deadline) {
      signal.throwIfAborted()
      await this.handoff?.pump()
      const enrollment = await this.current(agentPrincipal, signal)

      if (!enrollment) {
        throw new DeviceRegistryError(404, 'enrollment_missing')
      }

      if (enrollment.state === 'active' && enrollment.trust === 'trusted') {
        this.watching.delete(agentPrincipal)

        return enrollment
      }

      // The controller provisions its device first; the window may need opening once it is there.
      if (
        enrollment.state === 'awaiting_trust' &&
        (enrollment.ownerDevice !== this.deps.ownerDevice() || (enrollment.handoffUntil ?? 0) <= this.now())
      ) {
        await this.begin(agentPrincipal, signal)
      }

      await new Promise(resolve => setTimeout(resolve, this.deps.pumpMs ?? 5_000))
    }

    throw new DeviceRegistryError(0, 'handoff_expired')
  }

  /**
   * Finishes one owner-requested cloud enrollment revocation. The platform makes the authority
   * row `revoking` before it calls MAS, so a 503 is durable cleanup work rather than a refusal.
   * Keep that ID for a later sweep while the local agent is allowed to resume.
   */
  async revoke(enrollmentId: string, signal: AbortSignal): Promise<CloudEnrollmentRecord> {
    try {
      const enrollment = this.enrollmentOf(
        await this.deps.call({ kind: 'cloud-enrollment-revoke', enrollmentId }, signal)
      )

      if (enrollment.enrollmentId !== enrollmentId || enrollment.state !== 'revoked') {
        invalid()
      }

      this.pendingRevocations.delete(enrollmentId)
      this.stopRevocationTimerWhenIdle()

      return enrollment
    } catch (error) {
      this.pendingRevocations.add(enrollmentId)
      this.scheduleRevocationSweep()
      throw error
    }
  }

  /** Retries every authoritative `revoking` enrollment, including work left by an earlier run. */
  sweepRevocations(signal: AbortSignal): Promise<void> {
    this.revocationSweep ??= this.runRevocationSweep(signal).finally(() => {
      this.revocationSweep = undefined
      this.stopRevocationTimerWhenIdle()
    })

    return this.revocationSweep
  }

  private async runRevocationSweep(signal: AbortSignal): Promise<void> {
    let rows: CloudEnrollmentRecord[]

    try {
      rows = await this.list(signal)
    } catch (error) {
      this.deps.log(`[Device] cloud enrollment cleanup scan pending: ${deviceEnrollmentCode(error)}`)

      return
    }

    const byId = new Map(rows.map(row => [row.enrollmentId, row]))

    for (const enrollmentId of [...this.pendingRevocations]) {
      if (byId.get(enrollmentId)?.state === 'revoked') {
        this.pendingRevocations.delete(enrollmentId)
      }
    }

    const revoking = new Set([
      ...this.pendingRevocations,
      ...rows.filter(row => row.state === 'revoking').map(row => row.enrollmentId)
    ])

    for (const enrollmentId of revoking) {
      try {
        await this.revoke(enrollmentId, signal)
      } catch (error) {
        this.deps.log(
          `[Device] cloud enrollment ${enrollmentId.slice(0, 8)} cleanup pending: ${deviceEnrollmentCode(error)}`
        )
      }
    }
  }

  private scheduleRevocationSweep(): void {
    this.revocationTimer ??= setInterval(() => {
      void this.sweepRevocations(AbortSignal.timeout(20_000))
    }, this.deps.revokeSweepMs ?? 60_000)
    this.revocationTimer.unref?.()
  }

  private stopRevocationTimerWhenIdle(): void {
    if (!this.pendingRevocations.size && this.revocationTimer) {
      clearInterval(this.revocationTimer)
      this.revocationTimer = undefined
    }
  }

  private remember(enrollmentId: string): void {
    const ownerDevice = this.deps.ownerDevice()

    if (!ownerDevice) {
      return
    }

    this.handoff ??= new CloudOwnerHandoff(
      {
        deviceId: ownerDevice,
        enrollments: () => this.deps.call({ kind: 'cloud-enrollments' }, new AbortController().signal),
        roster: () => this.deps.roster(),
        receive: sender => this.deps.receive(sender),
        send: (recipient, event) => this.deps.send(recipient, event),
        recoveryKey: (agentUserId, key) => this.deps.recoveryKey(agentUserId, key)
      },
      () => this.now()
    )

    this.handoff.remember(enrollmentId)
  }

  private watch(agentPrincipal: string): void {
    this.watching.add(agentPrincipal)
    this.timer ??= setInterval(() => {
      if (!this.watching.size) {
        clearInterval(this.timer)
        this.timer = undefined

        return
      }

      void this.handoff?.pump()
    }, this.deps.pumpMs ?? 5_000)
    this.timer.unref?.()
    void this.handoff?.pump()
  }

  stop(): void {
    this.handoff?.stop()
    this.handoff = undefined
    clearInterval(this.timer)
    this.timer = undefined
    clearInterval(this.revocationTimer)
    this.revocationTimer = undefined
    this.pendingRevocations.clear()
    this.watching.clear()
  }
}

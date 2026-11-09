/**
 * The Mac side of `atum.agent-home/2.1` (frozen pack: `contracts/atum-agent-home-v2.1`, platform
 * `spec/agent-home/v2.1`, `@atum/protocol` 0.7.35 `agent-home-placement.ts`).
 *
 * One agent has exactly one writable home: the cloud, or one exact Mac `deviceServiceId`. The
 * platform owns the placement record, its epochs and its time. This module is the Mac's reading
 * and writing of that contract and nothing else: strict parsers for what the platform answers
 * (never repaired, anything else is `null`), the signed bytes of what this Mac says, and the
 * portable path grammar that decides what a checkpoint may carry.
 *
 * The parsers are hand-written in the house style (`parseCloudHomeManifest`), not a schema
 * library; `contract.test.ts` runs every fixture of the vendored pack that this Mac consumes or
 * produces through them, so a drift from the frozen bytes fails there.
 */
import { createHash } from 'node:crypto'

import { canonicalJson } from '../device/canonical'

export const AGENT_HOME_PROFILE = 'atum.agent-home/2.1'
export const AGENT_HOME_WIRE_HEADER = 'Atum-Agent-Home-Wire'
export const AGENT_HOME_WIRE_VERSION = '2.1'

const NUL = String.fromCharCode(0)

/** `utf8("atum.agent-home/2.1" NUL action NUL canonicalJson(body without meta.signature))`. */
export const AGENT_HOME_SIGNING_DOMAIN = `${AGENT_HOME_PROFILE}${NUL}`

/** Every executor frame lives at most two hours (`executorAuthentication.expiry`). */
export const SIGNED_MESSAGE_MAX_MS = 7_200_000

export const AGENT_HOME_DEFAULT_CHECKPOINT_CADENCE_MS = 900_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const B64U_SHA256 = /^[A-Za-z0-9_-]{43}$/u
const B64U_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u
const MATRIX_USER = /^@[!-9;-~]+:[!-~]+$/u

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)
export const isKeyId = (value: unknown): value is string => typeof value === 'string' && B64U_SHA256.test(value)

const safeInteger = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min

const positive = (value: unknown): value is number => safeInteger(value, 1)
const nonnegative = (value: unknown): value is number => safeInteger(value, 0)

const matrixUser = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 4 && value.length <= 1024 && MATRIX_USER.test(value)

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The row has exactly these keys (the contract's schemas are all `.strict()`). */
function exactly(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(row).sort()

  return have.length === keys.length && [...keys].sort().every((key, index) => have[index] === key)
}

// --------------------------------------------------------------------------------- placement

export type HomeLocation = { kind: 'cloud' } | { kind: 'mac'; deviceServiceId: string }

export function parseLocation(value: unknown): HomeLocation | null {
  const row = record(value)

  if (row?.kind === 'cloud' && exactly(row, ['kind'])) {
    return { kind: 'cloud' }
  }

  if (row?.kind === 'mac' && exactly(row, ['kind', 'deviceServiceId']) && isUuid(row.deviceServiceId)) {
    return { kind: 'mac', deviceServiceId: row.deviceServiceId }
  }

  return null
}

export function sameLocation(left: HomeLocation, right: HomeLocation): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'cloud' ||
      left.deviceServiceId === (right as Extract<HomeLocation, { kind: 'mac' }>).deviceServiceId)
  )
}

export const locationKey = (location: HomeLocation): string =>
  location.kind === 'cloud' ? 'cloud' : `mac:${location.deviceServiceId}`

export type MoveIntent = 'manual' | 'automatic_failover' | 'sleep_handoff' | 'go_home_when_idle'
export type MoveStatus = 'requested' | 'draining' | 'ready_to_commit' | 'committed' | 'aborted' | 'superseded'

const INTENTS: readonly string[] = ['manual', 'automatic_failover', 'sleep_handoff', 'go_home_when_idle']

const STATUSES: readonly string[] = [
  'requested',
  'draining',
  'ready_to_commit',
  'committed',
  'aborted',
  'superseded'
]

export interface HomeMove {
  moveId: string
  idempotencyKey: string
  intent: MoveIntent
  status: MoveStatus
  source: HomeLocation
  target: HomeLocation
  expectedHomeEpoch: number
  expectedPlacementRevision: number
  requestedAtPlatform: number
}

export function parseMove(value: unknown): HomeMove | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, [
      'moveId',
      'idempotencyKey',
      'intent',
      'status',
      'source',
      'target',
      'expectedHomeEpoch',
      'expectedPlacementRevision',
      'requestedAtPlatform'
    ]) ||
    !isUuid(row.moveId) ||
    !isUuid(row.idempotencyKey) ||
    typeof row.intent !== 'string' ||
    !INTENTS.includes(row.intent) ||
    typeof row.status !== 'string' ||
    !STATUSES.includes(row.status) ||
    !positive(row.expectedHomeEpoch) ||
    !positive(row.expectedPlacementRevision) ||
    !nonnegative(row.requestedAtPlatform)
  ) {
    return null
  }

  const source = parseLocation(row.source)
  const target = parseLocation(row.target)

  if (!source || !target || sameLocation(source, target)) {
    return null
  }

  return {
    moveId: row.moveId,
    idempotencyKey: row.idempotencyKey,
    intent: row.intent as MoveIntent,
    status: row.status as MoveStatus,
    source,
    target,
    expectedHomeEpoch: row.expectedHomeEpoch,
    expectedPlacementRevision: row.expectedPlacementRevision,
    requestedAtPlatform: row.requestedAtPlatform
  }
}

export interface HomePlacement {
  ownerUserId: string
  agentPrincipal: string
  homeId: string
  location: HomeLocation
  homeEpoch: number
  placementRevision: number
  selectedGeneration: number
  rollbackFloorGeneration: number
  activeMove: HomeMove | null
  policyRevision: number
}

export function parsePlacement(value: unknown): HomePlacement | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, [
      'ownerUserId',
      'agentPrincipal',
      'homeId',
      'location',
      'homeEpoch',
      'placementRevision',
      'selectedGeneration',
      'rollbackFloorGeneration',
      'activeMove',
      'policyRevision'
    ]) ||
    !matrixUser(row.ownerUserId) ||
    !isUuid(row.agentPrincipal) ||
    !isUuid(row.homeId) ||
    !positive(row.homeEpoch) ||
    !positive(row.placementRevision) ||
    !positive(row.selectedGeneration) ||
    !positive(row.rollbackFloorGeneration) ||
    row.selectedGeneration < row.rollbackFloorGeneration ||
    !positive(row.policyRevision)
  ) {
    return null
  }

  const location = parseLocation(row.location)
  const activeMove = row.activeMove === null ? null : parseMove(row.activeMove)

  // A committed move clears `activeMove`: the record never shows one.
  if (!location || (row.activeMove !== null && (!activeMove || activeMove.status === 'committed'))) {
    return null
  }

  return {
    ownerUserId: row.ownerUserId,
    agentPrincipal: row.agentPrincipal,
    homeId: row.homeId,
    location,
    homeEpoch: row.homeEpoch,
    placementRevision: row.placementRevision,
    selectedGeneration: row.selectedGeneration,
    rollbackFloorGeneration: row.rollbackFloorGeneration,
    activeMove,
    policyRevision: row.policyRevision
  }
}

// --------------------------------------------------------------------------------- the fence

/** The lease half of the fence: what a readiness report carries. */
export interface HomeLeaseFence {
  ownerUserId: string
  agentPrincipal: string
  homeId: string
  homeEpoch: number
  executorTerm: number
  leaseId: string
  leaseExpiresAtPlatform: number
}

export type HomeOperation = { kind: 'invocation' | 'job'; id: string }

/** The whole fence: the lease plus the invocation or job the effect belongs to. */
export interface HomeAuthorityFence extends HomeLeaseFence {
  operation: HomeOperation
}

export function validLeaseFence(value: unknown): value is HomeLeaseFence {
  const row = record(value)

  return Boolean(
    row &&
    exactly(row, [
      'ownerUserId',
      'agentPrincipal',
      'homeId',
      'homeEpoch',
      'executorTerm',
      'leaseId',
      'leaseExpiresAtPlatform'
    ]) &&
    matrixUser(row.ownerUserId) &&
    isUuid(row.agentPrincipal) &&
    isUuid(row.homeId) &&
    positive(row.homeEpoch) &&
    positive(row.executorTerm) &&
    isUuid(row.leaseId) &&
    nonnegative(row.leaseExpiresAtPlatform)
  )
}

export function validAuthorityFence(value: unknown): value is HomeAuthorityFence {
  const row = record(value)

  if (!row) {
    return false
  }

  const { operation, ...lease } = row
  const op = record(operation)

  return (
    validLeaseFence(lease) &&
    Boolean(op && exactly(op, ['kind', 'id']) && (op.kind === 'invocation' || op.kind === 'job') && isUuid(op.id))
  )
}

// ---------------------------------------------------------------------------- the signed frame

export type HomeSignedAction =
  | 'MacJobFire'
  | 'MacJobOccurrence'
  | 'MacJobGrant'
  | 'MacJobSnapshot'
  | 'MacJobModel'
  | 'DrainAck'
  | 'CheckpointReserve'
  | 'CheckpointCommit'
  | 'ReadinessReport'
  | 'MatrixPublicationEnqueue'
  // The archive and key routes (atum-platform #664): one action per call, so none can be replayed as another.
  | 'HomeKeyRead'
  | 'CheckpointArchiveBegin'
  | 'CheckpointArchiveFinalize'
  | 'CheckpointArchiveDownload'

export interface ExecutorSignedMeta {
  requestId: string
  commandId: string
  /** A Mac signs as `mac_executor`; the cloud's workload frames (read from fixtures) differ only here. */
  signer: 'mac_executor' | 'cloud_workload'
  signerKeyId: string
  deviceServiceId: string
  sequence: number
  issuedAt: number
  expiresAt: number
  nonce: string
  signature: string
}

const META_KEYS = [
  'requestId',
  'commandId',
  'signer',
  'signerKeyId',
  'deviceServiceId',
  'sequence',
  'issuedAt',
  'expiresAt',
  'nonce',
  'signature'
] as const

/** A well-formed executor frame header: ES256 sizes, a positive window of at most two hours. */
export function validExecutorMeta(value: unknown): value is ExecutorSignedMeta {
  const row = record(value)

  return Boolean(
    row &&
    exactly(row, META_KEYS) &&
    isUuid(row.requestId) &&
    isUuid(row.commandId) &&
    (row.signer === 'mac_executor' || row.signer === 'cloud_workload') &&
    isKeyId(row.signerKeyId) &&
    isUuid(row.deviceServiceId) &&
    positive(row.sequence) &&
    nonnegative(row.issuedAt) &&
    nonnegative(row.expiresAt) &&
    row.expiresAt > row.issuedAt &&
    row.expiresAt <= row.issuedAt + SIGNED_MESSAGE_MAX_MS &&
    isKeyId(row.nonce) &&
    typeof row.signature === 'string' &&
    B64U_SIGNATURE.test(row.signature)
  )
}

/**
 * What a Mac executor signs: the domain, the action (so a drain can never be replayed as a
 * checkpoint), and the canonical JSON of the whole body with only `meta.signature` removed. The
 * platform's Shell builds the same bytes (`agentHomeSignedBytes`, matrix-agent-home.ts) and checks
 * them with the pinned key.
 */
export function agentHomeSignedBytes<T extends { meta: Omit<ExecutorSignedMeta, 'signature'> }>(
  action: HomeSignedAction,
  body: T
): Buffer {
  const { signature: _signature, ...meta } = body.meta as ExecutorSignedMeta
  const unsigned = { ...body, meta }

  return Buffer.from(`${AGENT_HOME_SIGNING_DOMAIN}${action}${NUL}${canonicalJson(unsigned)}`, 'utf8')
}

// ------------------------------------------------------------ the portable path grammar (§ checkpointPolicy)

export type PortableCategory = 'memory' | 'skills' | 'non_secret_config' | 'routine_definitions' | 'portable_app_data'

export const PORTABLE_CATEGORIES: readonly PortableCategory[] = [
  'memory',
  'skills',
  'non_secret_config',
  'routine_definitions',
  'portable_app_data'
]

export const PORTABLE_PATH_ROOTS: Record<PortableCategory, string> = {
  memory: 'memory/',
  skills: 'skills/',
  non_secret_config: 'config/',
  routine_definitions: 'routines/',
  portable_app_data: 'apps/portable/'
}

export type PortableSkipReason =
  | 'invalid_relative_path'
  | 'outside_category'
  | 'credential_or_key_material'
  | 'browser_profile'
  | 'database_or_sidecar'
  | 'package_tree'
  | 'machine_workspace'
  | 'non_regular_file'
  | 'symlink_escape'

export const PORTABLE_SKIP_REASONS: readonly PortableSkipReason[] = [
  'invalid_relative_path',
  'outside_category',
  'credential_or_key_material',
  'browser_profile',
  'database_or_sidecar',
  'package_tree',
  'machine_workspace',
  'non_regular_file',
  'symlink_escape'
]

const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'u'
)

const PACKAGE_DIRECTORIES = new Set(['node_modules', 'site-packages', 'venv', '.venv', 'package', 'packages'])

const BROWSER_DIRECTORIES = new Set([
  'browser',
  'browsers',
  'chrome',
  'chromium',
  'firefox',
  'safari',
  'user data',
  '.mozilla',
  'google-chrome',
  'default'
])

const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.kube'])
const CREDENTIAL_NAMES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials'])
const CREDENTIAL_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa']
const CREDENTIAL_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

function fileSkipReason(fileName: string): PortableSkipReason | null {
  const name = fileName.toLocaleLowerCase('en-US')

  if (
    name.startsWith('cookies') ||
    name.startsWith('login data') ||
    name === 'local state' ||
    name.startsWith('web data')
  ) {
    return 'browser_profile'
  }

  if (
    name === 'auth.json' ||
    (name.startsWith('credentials') && name.endsWith('.json')) ||
    name.startsWith('.env') ||
    CREDENTIAL_NAMES.has(name) ||
    name.includes('.keychain') ||
    CREDENTIAL_PREFIXES.some(prefix => name.startsWith(prefix)) ||
    CREDENTIAL_SUFFIXES.some(suffix => name.endsWith(suffix))
  ) {
    return 'credential_or_key_material'
  }

  if (name.endsWith('.db') || name.includes('.sqlite') || name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) {
    return 'database_or_sidecar'
  }

  return null
}

export type PortableClassification =
  | { outcome: 'included'; normalizedPath: string }
  | { outcome: 'skipped'; reasonCode: PortableSkipReason }

/**
 * A byte-for-byte port of the platform's `classifyAgentHomePortablePath`: the one decision on
 * whether a relative path may travel in a checkpoint. NFC names and spaces are admitted; absolute
 * and parent paths, control characters, credentials, key material, browser stores, databases and
 * their sidecars, package trees and `workspace/` are not. A name that merely contains `secret`
 * or `token`, `package.json` and lockfiles are ordinary files.
 */
export function classifyPortablePath(category: PortableCategory, path: string): PortableClassification {
  if (path !== path.normalize('NFC') || path.startsWith('/') || path.includes('\\') || CONTROL_CHARACTERS.test(path)) {
    return { outcome: 'skipped', reasonCode: 'invalid_relative_path' }
  }

  const parts = path.split('/')

  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return { outcome: 'skipped', reasonCode: 'invalid_relative_path' }
  }

  const rootParts = PORTABLE_PATH_ROOTS[category].slice(0, -1).split('/')

  if (parts.length <= rootParts.length || rootParts.some((part, index) => parts[index] !== part)) {
    return { outcome: 'skipped', reasonCode: 'outside_category' }
  }

  const lower = parts.map(part => part.toLocaleLowerCase('en-US'))

  if (lower.some(part => PACKAGE_DIRECTORIES.has(part))) {
    return { outcome: 'skipped', reasonCode: 'package_tree' }
  }

  if (lower.some(part => part === 'workspace')) {
    return { outcome: 'skipped', reasonCode: 'machine_workspace' }
  }

  if (lower.some(part => BROWSER_DIRECTORIES.has(part) || part.startsWith('profile '))) {
    return { outcome: 'skipped', reasonCode: 'browser_profile' }
  }

  if (
    lower.some(part => CREDENTIAL_DIRECTORIES.has(part)) ||
    lower.some((part, index) => part === '.config' && lower[index + 1] === 'gcloud')
  ) {
    return { outcome: 'skipped', reasonCode: 'credential_or_key_material' }
  }

  const reason = fileSkipReason(parts[parts.length - 1]!)

  return reason === null ? { outcome: 'included', normalizedPath: path } : { outcome: 'skipped', reasonCode: reason }
}

// ------------------------------------------------------------------------ the portable manifest

export interface PortableManifestEntry {
  category: PortableCategory
  path: string
  sha256: string
  bytes: number
  stable: true
  fileType: 'regular_file'
  symlinkTraversal: 'none'
}

/** What a checkpoint never carries, stated in every manifest (`contentPolicy`). */
export const PORTABLE_CONTENT_POLICY = {
  memory: 'included',
  skills: 'included',
  nonSecretConfig: 'included',
  routineDefinitions: 'included',
  portableAppData: 'included',
  sessionHistoryStateDb: 'excluded',
  packages: 'excluded',
  browserSessions: 'excluded',
  machineWorkspace: 'excluded',
  credentials: 'excluded_all'
} as const

export const PORTABLE_ENCRYPTION = {
  encrypted: true,
  keyScope: 'owner_agent_home',
  credentialMaterialIncluded: false
} as const

export interface PortableManifest {
  homeId: string
  generation: number
  parentGeneration: number
  producingHomeEpoch: number
  manifestSha256: string
  entries: PortableManifestEntry[]
  encryption: typeof PORTABLE_ENCRYPTION
  contentPolicy: typeof PORTABLE_CONTENT_POLICY
}

const MAX_MANIFEST_ENTRIES = 100_000

function parseManifestEntry(value: unknown): PortableManifestEntry | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, ['category', 'path', 'sha256', 'bytes', 'stable', 'fileType', 'symlinkTraversal']) ||
    typeof row.category !== 'string' ||
    !(PORTABLE_CATEGORIES as readonly string[]).includes(row.category) ||
    typeof row.path !== 'string' ||
    row.path.length < 1 ||
    row.path.length > 4096 ||
    !isSha256(row.sha256) ||
    !nonnegative(row.bytes) ||
    row.stable !== true ||
    row.fileType !== 'regular_file' ||
    row.symlinkTraversal !== 'none' ||
    classifyPortablePath(row.category as PortableCategory, row.path).outcome !== 'included'
  ) {
    return null
  }

  return {
    category: row.category as PortableCategory,
    path: row.path,
    sha256: row.sha256,
    bytes: row.bytes,
    stable: true,
    fileType: 'regular_file',
    symlinkTraversal: 'none'
  }
}

/**
 * A manifest as the contract states it. A path outside the closed grammar, an unencrypted or
 * credential-bearing manifest, a parent that does not precede the generation, or any content
 * policy other than the frozen one is refused whole.
 */
export function parsePortableManifest(value: unknown): PortableManifest | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, [
      'homeId',
      'generation',
      'parentGeneration',
      'producingHomeEpoch',
      'manifestSha256',
      'entries',
      'encryption',
      'contentPolicy'
    ]) ||
    !isUuid(row.homeId) ||
    !positive(row.generation) ||
    !positive(row.parentGeneration) ||
    row.parentGeneration >= row.generation ||
    !positive(row.producingHomeEpoch) ||
    !isSha256(row.manifestSha256) ||
    !Array.isArray(row.entries) ||
    row.entries.length < 1 ||
    row.entries.length > MAX_MANIFEST_ENTRIES
  ) {
    return null
  }

  const encryption = record(row.encryption)
  const policy = record(row.contentPolicy)

  if (
    !encryption ||
    !exactly(encryption, ['encrypted', 'keyScope', 'credentialMaterialIncluded']) ||
    encryption.encrypted !== true ||
    encryption.keyScope !== PORTABLE_ENCRYPTION.keyScope ||
    encryption.credentialMaterialIncluded !== false ||
    !policy ||
    canonicalJson(policy) !== canonicalJson(PORTABLE_CONTENT_POLICY)
  ) {
    return null
  }

  const entries: PortableManifestEntry[] = []
  const seen = new Set<string>()

  for (const raw of row.entries) {
    const entry = parseManifestEntry(raw)

    if (!entry || seen.has(entry.path)) {
      return null
    }

    seen.add(entry.path)
    entries.push(entry)
  }

  return {
    homeId: row.homeId,
    generation: row.generation,
    parentGeneration: row.parentGeneration,
    producingHomeEpoch: row.producingHomeEpoch,
    manifestSha256: row.manifestSha256,
    entries,
    encryption: PORTABLE_ENCRYPTION,
    contentPolicy: PORTABLE_CONTENT_POLICY
  }
}

/**
 * The digest a checkpoint commits as `manifestSha256`: SHA-256 of the canonical manifest with that
 * one field left out. The contract leaves the function to the executor; it is fixed here so the
 * Python capture, this module and a restoring Mac agree on it.
 */
export function portableManifestDigest(manifest: Omit<PortableManifest, 'manifestSha256'> | PortableManifest): string {
  const { manifestSha256: _digest, ...rest } = manifest as PortableManifest

  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

export interface CheckpointSkippedPath {
  category: PortableCategory
  reasonCode: PortableSkipReason
  count: number
  /** SHA-256 of the skipped paths (sorted, one per line): a name is never recorded. */
  pathSha256: string
}

export function parseSkippedPaths(value: unknown): CheckpointSkippedPath[] | null {
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) {
    return null
  }

  const out: CheckpointSkippedPath[] = []

  for (const raw of value) {
    const row = record(raw)

    if (
      !row ||
      !exactly(row, ['category', 'reasonCode', 'count', 'pathSha256']) ||
      typeof row.category !== 'string' ||
      !(PORTABLE_CATEGORIES as readonly string[]).includes(row.category) ||
      typeof row.reasonCode !== 'string' ||
      !(PORTABLE_SKIP_REASONS as readonly string[]).includes(row.reasonCode) ||
      !positive(row.count) ||
      !isSha256(row.pathSha256)
    ) {
      return null
    }

    out.push({
      category: row.category as PortableCategory,
      reasonCode: row.reasonCode as PortableSkipReason,
      count: row.count,
      pathSha256: row.pathSha256
    })
  }

  return out
}

// ----------------------------------------------------------------------- what the platform answers

/** Why an authority check refused (`AuthorityRefusedSchema`), plus the readiness route's own word. */
export type HomeRefusalReason =
  | 'wrong_owner'
  | 'wrong_agent'
  | 'wrong_home'
  | 'stale_home_epoch'
  | 'stale_executor_term'
  | 'wrong_operation'
  | 'wrong_lease'
  | 'lease_expired'
  | 'wrong_signer_location'
  | 'unpinned_signer_key'
  | 'bad_signature'
  | 'signature_expired'
  | 'stale_authority'
  /** The final platform's own words beyond the frozen enum: a nonce, command id or sequence used twice. */
  | 'replayed'
  /** A move is draining or ready: work, connector and device effects wait for it to end. */
  | 'move_in_progress'

const REFUSAL_REASONS: readonly string[] = [
  'wrong_owner',
  'wrong_agent',
  'wrong_home',
  'stale_home_epoch',
  'stale_executor_term',
  'wrong_operation',
  'wrong_lease',
  'lease_expired',
  'wrong_signer_location',
  'unpinned_signer_key',
  'bad_signature',
  'signature_expired',
  'stale_authority',
  'replayed',
  'move_in_progress'
]

export function parseRefusal(value: unknown): { outcome: 'refused'; reason: HomeRefusalReason } | null {
  const row = record(value)

  return row &&
    exactly(row, ['outcome', 'reason']) &&
    row.outcome === 'refused' &&
    typeof row.reason === 'string' &&
    REFUSAL_REASONS.includes(row.reason)
    ? { outcome: 'refused', reason: row.reason as HomeRefusalReason }
    : null
}

export interface HomeReadinessObservation {
  ownerUserId: string
  agentPrincipal: string
  homeId: string
  homeEpoch: number
  receivedAtPlatform: number
  lastReadyAtPlatform: number | null
  reachable: boolean
  powerState: 'awake' | 'asleep_wakeable' | 'asleep_not_wakeable' | 'unknown'
}

const POWER_STATES = ['awake', 'asleep_wakeable', 'asleep_not_wakeable', 'unknown'] as const

export type HomePowerState = (typeof POWER_STATES)[number]

export function parseReadinessObservation(value: unknown): HomeReadinessObservation | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, [
      'ownerUserId',
      'agentPrincipal',
      'homeId',
      'homeEpoch',
      'receivedAtPlatform',
      'lastReadyAtPlatform',
      'reachable',
      'powerState',
      'basis'
    ]) ||
    !matrixUser(row.ownerUserId) ||
    !isUuid(row.agentPrincipal) ||
    !isUuid(row.homeId) ||
    !positive(row.homeEpoch) ||
    !nonnegative(row.receivedAtPlatform) ||
    !(row.lastReadyAtPlatform === null || nonnegative(row.lastReadyAtPlatform)) ||
    typeof row.reachable !== 'boolean' ||
    typeof row.powerState !== 'string' ||
    !(POWER_STATES as readonly string[]).includes(row.powerState) ||
    row.basis !== 'authenticated_agent_service_readiness' ||
    (row.lastReadyAtPlatform !== null && (row.lastReadyAtPlatform as number) > row.receivedAtPlatform) ||
    (row.reachable === true && row.powerState === 'asleep_not_wakeable')
  ) {
    return null
  }

  return {
    ownerUserId: row.ownerUserId,
    agentPrincipal: row.agentPrincipal,
    homeId: row.homeId,
    homeEpoch: row.homeEpoch,
    receivedAtPlatform: row.receivedAtPlatform,
    lastReadyAtPlatform: row.lastReadyAtPlatform as number | null,
    reachable: row.reachable,
    powerState: row.powerState as HomePowerState
  }
}

export interface HomeReadinessReport {
  meta: ExecutorSignedMeta
  fence: HomeLeaseFence
  reportedAtLocal: number
  powerState: HomePowerState
  checks: { homeAccessible: boolean; runtimeUsable: boolean; matrixIntakeWorking: boolean }
}

/** What this Mac sends to `…/home/readiness`: the agent service's three facts, never device-hub presence. */
export function validReadinessReport(value: unknown): value is HomeReadinessReport {
  const row = record(value)
  const checks = record(row?.checks)

  return Boolean(
    row &&
    exactly(row, ['meta', 'fence', 'reportedAtLocal', 'powerState', 'checks']) &&
    validExecutorMeta(row.meta) &&
    validLeaseFence(row.fence) &&
    nonnegative(row.reportedAtLocal) &&
    typeof row.powerState === 'string' &&
    (POWER_STATES as readonly string[]).includes(row.powerState) &&
    checks &&
    exactly(checks, ['homeAccessible', 'runtimeUsable', 'matrixIntakeWorking']) &&
    typeof checks.homeAccessible === 'boolean' &&
    typeof checks.runtimeUsable === 'boolean' &&
    typeof checks.matrixIntakeWorking === 'boolean'
  )
}

export type CheckpointReason = 'cadence_dirty' | 'idle' | 'manual' | 'move_drain'

export interface CheckpointCapture {
  meta: ExecutorSignedMeta
  fence: HomeAuthorityFence
  expectedPlacementRevision: number
  generation: number
  parentGeneration: number
  dirty: true
  reason: CheckpointReason
  manifestSha256: string
  includedFiles: number
  skipped: CheckpointSkippedPath[]
  consistency: { writersQuiesced: true; sqliteMethod: 'sqlite_backup'; stableFilesStaged: true }
}

/**
 * The capture record (`home.checkpoint.capture`): what one capture included and what it skipped,
 * by category, reason, count and path digest only. The platform's routes of this slice do not take
 * it, so a capture keeps it beside the sealed archive and in the local journal.
 */
export function validCheckpointCapture(value: unknown): value is CheckpointCapture {
  const row = record(value)
  const consistency = record(row?.consistency)

  return Boolean(
    row &&
    exactly(row, [
      'meta',
      'fence',
      'expectedPlacementRevision',
      'generation',
      'parentGeneration',
      'dirty',
      'reason',
      'manifestSha256',
      'includedFiles',
      'skipped',
      'consistency'
    ]) &&
    validExecutorMeta(row.meta) &&
    validAuthorityFence(row.fence) &&
    positive(row.expectedPlacementRevision) &&
    positive(row.generation) &&
    positive(row.parentGeneration) &&
    row.parentGeneration < row.generation &&
    row.dirty === true &&
    typeof row.reason === 'string' &&
    ['cadence_dirty', 'idle', 'manual', 'move_drain'].includes(row.reason) &&
    isSha256(row.manifestSha256) &&
    positive(row.includedFiles) &&
    parseSkippedPaths(row.skipped) !== null &&
    consistency &&
    exactly(consistency, ['writersQuiesced', 'sqliteMethod', 'stableFilesStaged']) &&
    consistency.writersQuiesced === true &&
    consistency.sqliteMethod === 'sqlite_backup' &&
    consistency.stableFilesStaged === true
  )
}

export type MoveRequestOutcome =
  | { outcome: 'requested' | 'replay' | 'superseded_previous'; move: HomeMove; placement: HomePlacement }

export function parseMoveRequestResult(value: unknown, agent: string): MoveRequestOutcome | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, ['outcome', 'move', 'placement']) ||
    !(row.outcome === 'requested' || row.outcome === 'replay' || row.outcome === 'superseded_previous')
  ) {
    return null
  }

  const move = parseMove(row.move)
  const placement = parsePlacement(row.placement)

  return move && placement && placement.agentPrincipal === agent
    ? { outcome: row.outcome as MoveRequestOutcome['outcome'], move, placement }
    : null
}

export type MoveCommitOutcome =
  | {
      outcome: 'committed'
      homeEpoch: number
      placementRevision: number
      selectedGeneration: number
      rollbackFloorGeneration: number
      committedAtPlatform: number
      placement: HomePlacement
    }
  | { outcome: 'already_committed'; homeEpoch: number; placementRevision: number; committedAtPlatform: number }

export function parseMoveCommitResult(value: unknown, agent: string): MoveCommitOutcome | null {
  const row = record(value)

  if (!row) {
    return null
  }

  if (
    row.outcome === 'already_committed' &&
    exactly(row, ['outcome', 'homeEpoch', 'placementRevision', 'committedAtPlatform']) &&
    positive(row.homeEpoch) &&
    positive(row.placementRevision) &&
    nonnegative(row.committedAtPlatform)
  ) {
    return {
      outcome: 'already_committed',
      homeEpoch: row.homeEpoch,
      placementRevision: row.placementRevision,
      committedAtPlatform: row.committedAtPlatform
    }
  }

  if (
    row.outcome === 'committed' &&
    exactly(row, [
      'outcome',
      'homeEpoch',
      'placementRevision',
      'selectedGeneration',
      'rollbackFloorGeneration',
      'committedAtPlatform',
      'placement'
    ]) &&
    positive(row.homeEpoch) &&
    positive(row.placementRevision) &&
    positive(row.selectedGeneration) &&
    positive(row.rollbackFloorGeneration) &&
    nonnegative(row.committedAtPlatform)
  ) {
    const placement = parsePlacement(row.placement)

    return placement && placement.agentPrincipal === agent
      ? {
          outcome: 'committed',
          homeEpoch: row.homeEpoch,
          placementRevision: row.placementRevision,
          selectedGeneration: row.selectedGeneration,
          rollbackFloorGeneration: row.rollbackFloorGeneration,
          committedAtPlatform: row.committedAtPlatform,
          placement
        }
      : null
  }

  return null
}

export type MoveAbortOutcome = 'aborted' | 'already_aborted' | 'stale_cas' | 'committed_epoch_preserved'

export function parseMoveAbortResult(value: unknown): MoveAbortOutcome | null {
  const row = record(value)

  return row &&
    exactly(row, ['outcome']) &&
    (row.outcome === 'aborted' ||
      row.outcome === 'already_aborted' ||
      row.outcome === 'stale_cas' ||
      row.outcome === 'committed_epoch_preserved')
    ? (row.outcome as MoveAbortOutcome)
    : null
}

export type DrainAckOutcome = { outcome: 'draining' | 'replay' | 'aborted'; move: HomeMove }

export function parseDrainAckResult(value: unknown): DrainAckOutcome | null {
  const row = record(value)

  if (!row || !exactly(row, ['outcome', 'move']) || !(row.outcome === 'draining' || row.outcome === 'replay' || row.outcome === 'aborted')) {
    return null
  }

  const move = parseMove(row.move)

  return move ? { outcome: row.outcome as DrainAckOutcome['outcome'], move } : null
}

export type CheckpointReserveOutcome =
  | {
      outcome: 'reserved'
      replayed: boolean
      checkpointId: string
      generation: number
      parentGeneration: number
      homeEpoch: number
      placementRevision: number
    }
  | { outcome: 'stale_revision'; placementRevision: number }

export function parseCheckpointReserveResult(value: unknown): CheckpointReserveOutcome | null {
  const row = record(value)

  if (!row) {
    return null
  }

  if (row.outcome === 'stale_revision' && exactly(row, ['outcome', 'placementRevision']) && positive(row.placementRevision)) {
    return { outcome: 'stale_revision', placementRevision: row.placementRevision }
  }

  if (
    row.outcome === 'reserved' &&
    exactly(row, [
      'outcome',
      'replayed',
      'checkpointId',
      'generation',
      'parentGeneration',
      'homeEpoch',
      'placementRevision'
    ]) &&
    typeof row.replayed === 'boolean' &&
    isUuid(row.checkpointId) &&
    positive(row.generation) &&
    positive(row.parentGeneration) &&
    row.parentGeneration < row.generation &&
    positive(row.homeEpoch) &&
    positive(row.placementRevision)
  ) {
    return {
      outcome: 'reserved',
      replayed: row.replayed,
      checkpointId: row.checkpointId,
      generation: row.generation,
      parentGeneration: row.parentGeneration,
      homeEpoch: row.homeEpoch,
      placementRevision: row.placementRevision
    }
  }

  return null
}

export type CheckpointCommitOutcome =
  | {
      outcome: 'committed' | 'already_committed'
      checkpointId: string
      generation: number
      selectedGeneration: number
      placementRevision: number
      manifestSha256: string
    }
  | {
      /** `reservation_expired`: the platform lets a reservation live 15 minutes and fails it after. */
      outcome: 'stale_cas' | 'verification_failed' | 'reservation_expired'
      selectedGeneration: number
      placementRevision: number
    }

export function parseCheckpointCommitResult(value: unknown): CheckpointCommitOutcome | null {
  const row = record(value)

  if (!row) {
    return null
  }

  if (
    (row.outcome === 'stale_cas' || row.outcome === 'verification_failed' || row.outcome === 'reservation_expired') &&
    exactly(row, ['outcome', 'selectedGeneration', 'placementRevision']) &&
    positive(row.selectedGeneration) &&
    positive(row.placementRevision)
  ) {
    return {
      outcome: row.outcome,
      selectedGeneration: row.selectedGeneration,
      placementRevision: row.placementRevision
    }
  }

  if (
    (row.outcome === 'committed' || row.outcome === 'already_committed') &&
    exactly(row, ['outcome', 'checkpointId', 'generation', 'selectedGeneration', 'placementRevision', 'manifestSha256']) &&
    isUuid(row.checkpointId) &&
    positive(row.generation) &&
    positive(row.selectedGeneration) &&
    positive(row.placementRevision) &&
    isSha256(row.manifestSha256)
  ) {
    return {
      outcome: row.outcome,
      checkpointId: row.checkpointId,
      generation: row.generation,
      selectedGeneration: row.selectedGeneration,
      placementRevision: row.placementRevision,
      manifestSha256: row.manifestSha256
    }
  }

  return null
}

// ------------------------------------------------------------------ publication (the platform's outbox)

/**
 * A migrated agent never sends into a room itself. It hands the platform the final Matrix event bytes, signed
 * (`matrix.publication.enqueue`), and the platform's worker sends them under the placement lock, so the database
 * orders a send against a move commit. The Mac observes the result through the invocation or occurrence ledger.
 */
export const PUBLICATION_MAX_PAYLOAD_BYTES = 131_072
export const PUBLICATION_MAX_PAYLOAD_BASE64 = 174_764
export const PUBLICATION_MAX_PARTS = 1_024

const MATRIX_ROOM = /^![!-~]+$/u
const MATRIX_EVENT = /^\$[!-~]+$/u
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u

export const isMatrixRoomId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 2 && value.length <= 1024 && MATRIX_ROOM.test(value)

export const isMatrixEventId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 2 && value.length <= 1024 && MATRIX_EVENT.test(value)

export type PublicationEventType = 'm.room.message' | 'm.room.encrypted'

/** The frozen `matrix.publication.enqueue` frame: signed, and carrying the hash of the exact bytes. */
export interface PublicationEnqueueFrame {
  meta: ExecutorSignedMeta
  fence: HomeAuthorityFence
  expectedPlacementRevision: number
  moveSerializationRevision: number
  outboxId: string
  roomId: string
  transactionId: string
  payloadSha256: string
}

export function validPublicationEnqueue(value: unknown): value is PublicationEnqueueFrame {
  const row = record(value)

  return Boolean(
    row &&
    exactly(row, [
      'meta',
      'fence',
      'expectedPlacementRevision',
      'moveSerializationRevision',
      'outboxId',
      'roomId',
      'transactionId',
      'payloadSha256'
    ]) &&
    validExecutorMeta(row.meta) &&
    validAuthorityFence(row.fence) &&
    positive(row.expectedPlacementRevision) &&
    // The serialization revision IS the placement revision the Mac saw: the platform refuses any other.
    row.moveSerializationRevision === row.expectedPlacementRevision &&
    isUuid(row.outboxId) &&
    isMatrixRoomId(row.roomId) &&
    typeof row.transactionId === 'string' &&
    row.transactionId.length >= 1 &&
    row.transactionId.length <= 255 &&
    isSha256(row.payloadSha256)
  )
}

/** What is POSTed to `…/home/publications`: the frame plus the exact bytes it hashes (and, for a split answer, the part). */
export interface PublicationEnvelope {
  publication: PublicationEnqueueFrame
  eventType: PublicationEventType
  payloadBase64: string
  part?: { index: number; count: number }
}

/** The bytes of a base64 payload when it is canonical base64 of 2..131072 bytes, else null. */
export function publicationPayloadBytes(payloadBase64: unknown): Buffer | null {
  if (
    typeof payloadBase64 !== 'string' ||
    payloadBase64.length < 4 ||
    payloadBase64.length > PUBLICATION_MAX_PAYLOAD_BASE64 ||
    !BASE64.test(payloadBase64)
  ) {
    return null
  }

  const bytes = Buffer.from(payloadBase64, 'base64')

  return bytes.length >= 2 && bytes.length <= PUBLICATION_MAX_PAYLOAD_BYTES && bytes.toString('base64') === payloadBase64 ? bytes : null
}

export function validPublicationEnvelope(value: unknown): value is PublicationEnvelope {
  const row = record(value)

  if (
    !row ||
    !(exactly(row, ['publication', 'eventType', 'payloadBase64']) || exactly(row, ['publication', 'eventType', 'payloadBase64', 'part'])) ||
    !validPublicationEnqueue(row.publication) ||
    (row.eventType !== 'm.room.message' && row.eventType !== 'm.room.encrypted')
  ) {
    return false
  }

  const bytes = publicationPayloadBytes(row.payloadBase64)

  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.publication.payloadSha256) {
    return false
  }

  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown

    if (!record(parsed)) {
      return false
    }
  } catch {
    return false
  }

  if (row.part === undefined) {
    return true
  }

  const part = record(row.part)

  return Boolean(
    part &&
    exactly(part, ['index', 'count']) &&
    nonnegative(part.index) &&
    positive(part.count) &&
    part.index < part.count &&
    part.index <= PUBLICATION_MAX_PARTS - 1 &&
    part.count <= PUBLICATION_MAX_PARTS
  )
}

export type PublicationState = 'queued' | 'admitted' | 'sending' | 'published' | 'refused' | 'uncertain'
export type PublicationReason = 'stale_authority' | 'move_in_progress' | 'matrix_error' | 'effect_unknown'

const PUBLICATION_REASONS: readonly string[] = ['stale_authority', 'move_in_progress', 'matrix_error', 'effect_unknown']

/** The frozen `matrix.publication.receipt`: where an outbox row stands. */
export interface PublicationReceipt {
  outboxId: string
  fence: HomeAuthorityFence
  moveSerializationRevision: number
  state: PublicationState
  eventId: string | null
  reason: PublicationReason | null
}

export function parsePublicationReceipt(value: unknown): PublicationReceipt | null {
  const row = record(value)

  if (
    !row ||
    !exactly(row, ['outboxId', 'fence', 'moveSerializationRevision', 'state', 'eventId', 'reason']) ||
    !isUuid(row.outboxId) ||
    !validAuthorityFence(row.fence) ||
    !positive(row.moveSerializationRevision)
  ) {
    return null
  }

  const eventId = row.eventId === null ? null : isMatrixEventId(row.eventId) ? row.eventId : undefined
  const reason = row.reason === null ? null : typeof row.reason === 'string' && PUBLICATION_REASONS.includes(row.reason) ? (row.reason as PublicationReason) : undefined

  if (eventId === undefined || reason === undefined) {
    return null
  }

  const shape = (state: PublicationState): PublicationReceipt => ({
    outboxId: row.outboxId as string,
    fence: row.fence as HomeAuthorityFence,
    moveSerializationRevision: row.moveSerializationRevision as number,
    state,
    eventId,
    reason
  })

  switch (row.state) {
    case 'published':
      return eventId !== null && reason === null ? shape('published') : null

    case 'refused':
      return eventId === null && reason !== null ? shape('refused') : null

    case 'sending':
      return reason === null ? shape('sending') : null

    case 'queued':

    case 'admitted':

    case 'uncertain':
      return shape(row.state)

    default:
      return null
  }
}

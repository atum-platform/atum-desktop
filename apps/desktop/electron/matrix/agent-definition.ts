import {
  agentProfileRequest,
  type AgentProfileRequest,
  agentProfileResult,
  type AgentProfileResult
} from '../../shared/agent-profile-management'
import { type AtumPersonalPet, parsePersonalPet, parsePetBundle } from '../../shared/atum-account-pets'
import { type AtumPetBinding, parsePetBinding } from '../../shared/atum-account-preferences'
import {
  type AtumCloudMemory,
  type AtumMemorySnapshot,
  type AtumSkillBundle,
  parseCloudMemory,
  parseMemorySnapshot,
  parseSkillBundle
} from '../../shared/atum-agent-content'
import {
  assistantDefinitionWriteWire,
  type AtumAssistantDefinitionWrite,
  type AtumPortableAssistantDefinition,
  type AtumPortableAssistantRecord,
  parseAtumAssistantDefinitionSnapshot,
  parseAtumPortableAssistantRecord
} from '../../shared/atum-agent-portability'
import { type MatrixPetCatalog, parseMatrixPetCatalog, parseMatrixPetSnapshot } from '../../shared/matrix-pet'
import {
  matrixProfilePhoto,
  type MatrixProfilePhotoType
} from '../../shared/matrix-profile'

import type { NativeGrant } from './authorization'
import { readCloudDisclosureVersion, readDomainJson } from './domain'
import { TIME_ZONE_ACK_HEADER } from './time-zone'

const REQUEST_TIMEOUT_MS = 10_000
// A skill bundle is up to 3 MiB each way: a slow link gets longer than a definition read.
const SKILL_REQUEST_TIMEOUT_MS = 60_000
// A full 256 KiB write is returned with canonical identity/revision metadata.
const MAXIMUM_AGENT_RESPONSE_BYTES = 524_288
/** The platform's cap on one stored bundle (`MAX_SKILL_BUNDLE_REQUEST_BYTES`). */
export const MAXIMUM_SKILL_RESPONSE_BYTES = 3 * 1_024 * 1_024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[a-f0-9]{64}$/u

export type MatrixAgentDefinitionErrorCode = 'denied' | 'conflict' | 'missing' | 'unavailable' | 'invalid' | 'hire_required'

/** The `details` the platform carried beside a refusal (the hire price, say). */
export interface MatrixAgentRefusalDetails {
  reason?: string
  hire?: { price_protons: number; price_micro_protons?: number }
}

/** A deliberately small native-only failure vocabulary for the account owner. */
export class MatrixAgentDefinitionError extends Error {
  constructor(readonly code: MatrixAgentDefinitionErrorCode, readonly refusal?: MatrixAgentRefusalDetails) {
    super(`matrix_agent_definition_${code}`)
    this.name = 'MatrixAgentDefinitionError'
  }
}

/** The authenticated domain's assistant projection includes its agent principal, and
 * (0146) the Matrix user it answers as. */
export interface MatrixAgentDefinitionRecord extends AtumPortableAssistantRecord {
  principal: string
  matrixUser?: string
  /** Where the agent answers (atum.cloud-answering/1, 0179): `cloud` once it moved to the cloud
   * brain; absent (an older platform) or `local` keeps today's path on the owner's Macs. */
  answering?: 'local' | 'cloud'
  /** Public owner-roster capability, published only for enrolled host-runtime agents. */
  runtime?: 'hermes'
  /** Its hire (atum.agent-hire/1): absent when free, else `active` or `paused` with the price. */
  hire?: MatrixAgentHire
}

/** The platform's per-agent hire state: `paused` means a renewal debit failed. */
export interface MatrixAgentHire {
  state: 'active' | 'paused'
  price_protons: number
  period_end?: string
  renewal_error?: 'insufficient_protons' | null
}

/** Where the platform put a newly created agent (atum.agent-lifecycle/1.1 A3). Only `placed`
 * and `pending_trust` mean the cloud owns its room and executor; the rest are why it answers on
 * this Mac, and an unknown value (or none) is an older platform: today's Mac-run flow. */
export type MatrixAgentCloudPlacement = 'placed' | 'pending_trust' | 'capacity' | 'no_access' | 'consent_mismatch'

/** A retirement: final. `sessionCleanup` says whether its executors' MAS sessions are all
 * revoked (`complete`), more remain for a repeated call (`pending`), or one failed. */
export interface MatrixAgentRetirement {
  id: string
  status: 'retired'
  sessionCleanup: 'complete' | 'pending' | 'unconfirmed'
}

/** `definition: null` is the explicit not-yet-materialized state, not a parse failure. */
export interface MatrixAgentDefinitionSnapshot {
  assistant: MatrixAgentDefinitionRecord
  definition: AtumPortableAssistantDefinition | null
  definitionRevision: number
  identityRevision: number
}

/** A38 (`spec/owner-time-zone/v1`): the roster read is the one carrier of the time-zone report. */
export interface MatrixAgentRosterOptions {
  /** Additive request headers for the roster read; no other caller's request carries any. */
  headers?: Record<string, string>
  /** The platform's ack, only when it stored the report; the caller records it then. */
  onTimeZoneAck?: (zone: string | undefined) => void
}

/** Lists canonical assistant records for the native grant's principal. */
export async function listMatrixAgentDefinitions(
  resource: string,
  grant: NativeGrant,
  signal: AbortSignal,
  options: MatrixAgentRosterOptions = {}
): Promise<MatrixAgentDefinitionRecord[]> {
  const value = await requestJson(
    resource,
    grant,
    '/agents',
    {},
    signal,
    MAXIMUM_AGENT_RESPONSE_BYTES,
    REQUEST_TIMEOUT_MS,
    options.headers,
    options.onTimeZoneAck
      ? headers => options.onTimeZoneAck!(headers.get(TIME_ZONE_ACK_HEADER) ?? undefined)
      : undefined
  )

  if (!Array.isArray(value)) {
    throw invalid()
  }

  const assistants = value.map((row, index) => parseAgentRecord(row, `agents[${index}]`))

  // The active-only roster stays compatible with older clients. The platform's
  // default record carries explicit owner-scoped tombstones for local cleanup;
  // absence alone is never authority to erase the physical root's enrollment.
  const retired = value.flatMap((row, index) => {
    const record = object(row)

    if (record.retired_agents === undefined) {
      return []
    }

    if (!assistants[index]!.isDefault || !Array.isArray(record.retired_agents)) {
      throw invalid()
    }

    return record.retired_agents.map((entry, retiredIndex) => {
      const tombstone = parseAgentRecord(entry, `agents[${index}].retired_agents[${retiredIndex}]`, true)

      if (tombstone.status !== 'retired' || tombstone.isDefault || object(entry).retired_agents !== undefined) {
        throw invalid()
      }

      return tombstone
    })
  })

  assistants.push(...retired)

  if (
    new Set(assistants.map(assistant => assistant.id)).size !== assistants.length ||
    new Set(assistants.map(assistant => assistant.principal)).size !== assistants.length
  ) {
    throw invalid()
  }

  return assistants
}

/** Creates another agent (0146). The request ID makes it idempotent: a retry returns the
 * same agent. The platform names its Matrix account; the client names only the agent.
 *
 * The body also carries the active Cloud disclosure version when this Mac can read it
 * (`/cloud/disclosure`): the platform may then place the agent in the cloud and says so in
 * `cloudPlacement` (atum.agent-lifecycle/1.1). When the read fails the body is today's exactly,
 * so no placement is asked for. The production Shell that predates the placement deploy refuses
 * the three-key body with the same 400/422 as a bad request; it is retried once with today's
 * two-key body, so an older Shell and a newer one both create the agent as before. */
export async function createMatrixAgent(
  resource: string,
  grant: NativeGrant,
  input: { requestId: string; displayName: string; hireConfirmed?: boolean },
  signal: AbortSignal
): Promise<MatrixAgentDefinitionRecord & { matrixUser: string; cloudPlacement?: MatrixAgentCloudPlacement }> {
  const name = input.displayName.trim()

  if (!uuid(input.requestId) || !name || Array.from(name).length > 40) {
    throw invalid()
  }

  const disclosureVersion = await readCloudDisclosureVersion(resource, grant)
  const body = (version: number | undefined) =>
    JSON.stringify(
      version === undefined
        ? { requestId: input.requestId, displayName: input.displayName,
            ...(input.hireConfirmed ? { hireConfirmed: true } : {}) }
        : { requestId: input.requestId, displayName: input.displayName, disclosureVersion: version,
            ...(input.hireConfirmed ? { hireConfirmed: true } : {}) }
    )
  const post = (version: number | undefined) =>
    requestJson(resource, grant, '/agents', { method: 'POST', body: body(version) }, signal)

  let value: unknown

  try {
    value = await post(disclosureVersion)
  } catch (error) {
    // A hire-confirmation refusal carries the price; the caller shows it and retries with `hireConfirmed`.
    if (error instanceof MatrixAgentDefinitionError && error.code === 'conflict' && error.refusal?.reason === 'hire_required') {
      throw new MatrixAgentDefinitionError('hire_required', error.refusal)
    }
    // The current production Shell rejects the third key (`400`/`422`) until it ships the
    // placement route. Retry exactly once with the old two-key body, which it still accepts.
    if (disclosureVersion === undefined || !(error instanceof MatrixAgentDefinitionError) || error.code !== 'invalid') {
      throw error
    }

    value = await post(undefined)
  }

  const record = parseAgentRecord(value)
  const cloudPlacement = parseCloudPlacement(object(value).cloud_placement)

  if (!record.matrixUser || record.isDefault) {
    throw invalid()
  }

  return {
    ...record,
    matrixUser: record.matrixUser,
    ...(cloudPlacement === undefined ? {} : { cloudPlacement })
  }
}

/** Retires an agent for good (0146). The default agent cannot be retired. */
export async function retireMatrixAgent(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  signal: AbortSignal
): Promise<MatrixAgentRetirement> {
  const id = agentId(assistantId)
  const row = object(await requestJson(resource, grant, `/agents/${id}`, { method: 'DELETE' }, signal))

  if (
    row.id !== assistantId ||
    row.status !== 'retired' ||
    !['complete', 'pending', 'unconfirmed'].includes(row.sessionCleanup as string)
  ) {
    throw invalid()
  }

  return {
    id: assistantId,
    status: 'retired',
    sessionCleanup: row.sessionCleanup as MatrixAgentRetirement['sessionCleanup']
  }
}

/** Reads one owner-scoped definition without ever exposing the resource or grant to a renderer. */
export async function readMatrixAgentDefinition(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  signal: AbortSignal
): Promise<MatrixAgentDefinitionSnapshot> {
  return parseDefinitionSnapshot(
    await requestJson(resource, grant, `/agents/${agentId(assistantId)}/definition`, {}, signal),
    assistantId
  )
}

/** Writes only a version-fenced portable definition and identity fields. */
export async function writeMatrixAgentDefinition(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  input: AtumAssistantDefinitionWrite,
  signal: AbortSignal
): Promise<MatrixAgentDefinitionSnapshot> {
  const id = agentId(assistantId)
  const body = assistantDefinitionWriteWire(input)

  const snapshot = parseDefinitionSnapshot(
    await requestJson(
      resource,
      grant,
      `/agents/${id}/definition`,
      {
        method: 'PUT',
        body: JSON.stringify(body)
      },
      signal
    ),
    assistantId
  )

  if (snapshot.definition === null) {
    throw invalid()
  }

  return snapshot
}

/** Writes a principal-owned assistant photo through the platform's canonical avatar store. */
export async function writeMatrixAgentAvatar(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  originPrincipal: string | null,
  targetPrincipal: string,
  avatar: { type: MatrixProfilePhotoType; bytes: Uint8Array } | null,
  signal: AbortSignal
): Promise<MatrixAgentDefinitionSnapshot> {
  if ((originPrincipal !== null && !uuid(originPrincipal)) || !uuid(targetPrincipal)) {throw invalid()}
  const photo = avatar === null ? null : matrixProfilePhoto(avatar)
  const snapshot = parseDefinitionSnapshot(
    await requestJson(
      resource,
      grant,
      `/agents/${agentId(assistantId)}/avatar`,
      {
        method: 'PUT',
        body: JSON.stringify({
          originPrincipal,
          targetPrincipal,
          avatar: photo ? { type: photo.type, base64: Buffer.from(photo.bytes).toString('base64') } : null
        })
      },
      signal,
      MAXIMUM_AGENT_RESPONSE_BYTES,
      60_000
    ),
    assistantId
  )

  if (snapshot.assistant.principal !== targetPrincipal) {throw invalid()}

  return snapshot
}

/**
 * One model-facing profile request. The native bearer establishes the owner while the
 * explicit origin principal is re-authorized against current Main state by the platform.
 */
export async function requestMatrixAgentProfiles(
  resource: string,
  grant: NativeGrant,
  originPrincipal: string,
  input: Exclude<AgentProfileRequest, { operation: 'avatar' }>,
  signal: AbortSignal
): Promise<AgentProfileResult> {
  if (!uuid(originPrincipal)) {throw invalid()}
  const request = agentProfileRequest(input)
  if (!request || request.operation === 'avatar') {throw invalid()}
  const value = await requestJson(
    resource,
    grant,
    '/agent-profiles',
    { method: 'POST', body: JSON.stringify({ originPrincipal, request }) },
    signal,
    MAXIMUM_AGENT_RESPONSE_BYTES
  )
  const targetPrincipal = request.operation === 'list' ? undefined : request.target ?? originPrincipal
  const result = agentProfileResult(value, { originPrincipal, targetPrincipal })
  if (!result) {throw invalid()}
  return result
}

/** Retrieves a content-addressed skill bundle only when it is exactly the requested hash. */
export async function getMatrixAgentSkill(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  sha256: string,
  signal: AbortSignal
): Promise<AtumSkillBundle> {
  const hash = skillHash(sha256)

  const bundle = parseBundle(
    await requestJson(
      resource,
      grant,
      `/agents/${agentId(assistantId)}/skills/${hash}`,
      {},
      signal,
      MAXIMUM_SKILL_RESPONSE_BYTES,
      SKILL_REQUEST_TIMEOUT_MS
    )
  )

  if (bundle.sha256 !== hash) {
    throw invalid()
  }

  return bundle
}

/** Uploads a content-addressed bundle and requires the frozen available acknowledgement. */
export async function putMatrixAgentSkill(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  input: AtumSkillBundle,
  signal: AbortSignal
): Promise<{ sha256: string; status: 'available' }> {
  const bundle = parseBundle(input)
  const hash = skillHash(bundle.sha256)

  const value = await requestJson(
    resource,
    grant,
    `/agents/${agentId(assistantId)}/skills/${hash}`,
    { method: 'PUT', body: JSON.stringify(bundle) },
    signal,
    MAXIMUM_AGENT_RESPONSE_BYTES,
    SKILL_REQUEST_TIMEOUT_MS
  )

  const row = object(value)

  if (row.sha256 !== hash || row.status !== 'available') {
    throw invalid()
  }

  return { sha256: hash, status: 'available' }
}

/** Reads the existing revision-fenced portable memory snapshot for one owned agent. */
export async function readMatrixAgentMemory(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  signal: AbortSignal
): Promise<AtumCloudMemory> {
  return parseAgentMemory(
    await requestJson(resource, grant, `/agents/${agentId(assistantId)}/memory`, {}, signal),
    assistantId
  )
}

/** Writes portable MEMORY.md / USER.md entries only, under the platform's exact revision fence. */
export async function writeMatrixAgentMemory(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
  signal: AbortSignal
): Promise<AtumCloudMemory> {
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || typeof input.enabled !== 'boolean') {
    throw invalid()
  }

  let snapshot: AtumMemorySnapshot

  try {
    snapshot = parseMemorySnapshot(input.snapshot)
  } catch {
    throw invalid()
  }

  return parseAgentMemory(
    await requestJson(
      resource,
      grant,
      `/agents/${agentId(assistantId)}/memory`,
      { method: 'PUT', body: JSON.stringify({ ...input, snapshot }) },
      signal
    ),
    assistantId
  )
}

function parseAgentMemory(value: unknown, assistantId: string): AtumCloudMemory {
  let memory: AtumCloudMemory

  try {
    memory = parseCloudMemory(value)
  } catch {
    throw invalid()
  }

  if (memory.assistantId !== assistantId) {
    throw invalid()
  }

  return memory
}

function parseDefinitionSnapshot(value: unknown, expectedAssistantId: string): MatrixAgentDefinitionSnapshot {
  const root = object(value)
  const assistant = parseAgentRecord(root.assistant)

  if (assistant.id !== expectedAssistantId) {
    throw invalid()
  }

  if (root.definition === null) {
    const definitionRevision = revision(root.definition_revision, true)
    const identityRevision = revision(root.identity_revision)

    if (
      definitionRevision !== 0 ||
      assistant.definitionRevision !== definitionRevision ||
      assistant.identityRevision !== identityRevision
    ) {
      throw invalid()
    }

    return { assistant, definition: null, definitionRevision, identityRevision }
  }

  let parsed: ReturnType<typeof parseAtumAssistantDefinitionSnapshot>

  try {
    parsed = parseAtumAssistantDefinitionSnapshot(root)
  } catch {
    throw invalid()
  }

  if (
    parsed.definitionRevision === 0 ||
    assistant.id !== parsed.assistant.id ||
    assistant.identityRevision !== parsed.identityRevision ||
    assistant.definitionRevision !== parsed.definitionRevision
  ) {
    throw invalid()
  }

  return {
    assistant,
    definition: parsed.definition,
    definitionRevision: parsed.definitionRevision,
    identityRevision: parsed.identityRevision
  }
}

/** A value this client does not know (or none) is absent: an older platform, or nothing to say. */
function parseCloudPlacement(value: unknown): MatrixAgentCloudPlacement | undefined {
  return value === 'placed' ||
    value === 'pending_trust' ||
    value === 'capacity' ||
    value === 'no_access' ||
    value === 'consent_mismatch'
    ? value
    : undefined
}

/** Keep record validation in the portability parser; this only projects the domain principal. */
function parseAgentRecord(value: unknown, label?: string, allowRetired = false): MatrixAgentDefinitionRecord {
  const row = object(value)

  if (!uuid(row.principal)) {
    throw invalid()
  }

  let assistant: AtumPortableAssistantRecord

  try {
    assistant = parseAtumPortableAssistantRecord(row, label, allowRetired)
  } catch {
    throw invalid()
  }

  if (
    row.matrixUser !== undefined &&
    (typeof row.matrixUser !== 'string' || !/^@[^:]+:.+$/u.test(row.matrixUser) || row.matrixUser.length > 1024)
  ) {
    throw invalid()
  }

  return {
    ...assistant,
    principal: row.principal,
    ...(typeof row.matrixUser === 'string' ? { matrixUser: row.matrixUser } : {}),
    // A value this client does not know reads as local: the platform's fences decide anyway.
    ...(row.answering === 'cloud' || row.answering === 'local' ? { answering: row.answering } : {}),
    ...(row.runtime === 'hermes' ? { runtime: 'hermes' as const } : {}),
    ...(parseHire(row.hire) === undefined ? {} : { hire: parseHire(row.hire) })
  }
}

/** The hire seat projection, or undefined when the row carries none. */
function parseHire(value: unknown): MatrixAgentHire | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const row = value as Record<string, unknown>
  if (row.state !== 'active' && row.state !== 'paused') {
    return undefined
  }
  if (!Number.isSafeInteger(row.price_protons)) {
    return undefined
  }
  return {
    state: row.state as 'active' | 'paused',
    price_protons: row.price_protons as number,
    ...(typeof row.period_end === 'string' ? { period_end: row.period_end } : {}),
    ...(row.renewal_error === 'insufficient_protons' || row.renewal_error === null
      ? { renewal_error: row.renewal_error as 'insufficient_protons' | null } : {})
  }
}

/** Same native MAS transport and ownership projection as agent definitions. */
export async function requestMatrixAgentPet(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  expected: { owner: string; agent: string },
  signal: AbortSignal,
  write?: { revision: number; pet: AtumPetBinding }
) {
  if (write && (!Number.isSafeInteger(write.revision) || write.revision < 0)) {
    throw invalid()
  }
  const pet = write ? parsePetBinding(write.pet) : undefined

  const value = await requestJson(
    resource,
    grant,
    `/agents/${agentId(assistantId)}/pet`,
    write
      ? {
          method: 'PUT',
          body: JSON.stringify({ expected_revision: write.revision, pet })
        }
      : {},
    signal,
    4096
  )

  const result = parseMatrixPetSnapshot(value, expected.owner, expected.agent)

  if (
    write &&
    (result.provenance !== 'explicit' ||
      !result.pet ||
      result.revision < write.revision ||
      result.revision > write.revision + 1 ||
      result.pet.enabled !== pet!.enabled ||
      result.pet.scale !== pet!.scale ||
      JSON.stringify(result.pet.ref && Object.entries(result.pet.ref).sort()) !==
        JSON.stringify(pet!.ref && Object.entries(pet!.ref).sort()))
  ) {
    throw invalid()
  }

  return result
}

/** The authoritative shelf for one agent.  The renderer cannot address this
 * endpoint itself: it receives only its parsed catalog through MatrixPets. */
export async function requestMatrixAgentPetCatalog(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  expected: { owner: string; agent: string },
  signal: AbortSignal
): Promise<MatrixPetCatalog> {
  return parseMatrixPetCatalog(
    await requestJson(resource, grant, `/agents/${agentId(assistantId)}/pets`, {}, signal, 256 * 1024),
    expected.owner,
    expected.agent
  )
}

/** Starts the one-time server-timed visit for the creation-default agent. The
 * response deliberately carries no renderer state; callers always read the
 * authoritative preference afterwards. */
export async function requestMatrixAgentPetVisit(
  resource: string,
  grant: NativeGrant,
  assistantId: string,
  signal: AbortSignal
): Promise<void> {
  const value = await requestJson(
    resource,
    grant,
    `/agents/${agentId(assistantId)}/pets/visit`,
    {
      method: 'POST',
      body: '{}'
    },
    signal,
    4096
  )

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid()
  }
}

/** Owner-private personal-pet metadata.  This never gives the renderer either
 * a bearer token or a byte URL. */
export async function listMatrixPersonalPets(
  resource: string,
  grant: NativeGrant,
  signal: AbortSignal
): Promise<AtumPersonalPet[]> {
  const value = await requestJson(resource, grant, '/pets', {}, signal, 256 * 1024)
  const row = object(value)

  if (!Array.isArray(row.pets) || row.pets.length > 500 || Object.keys(row).some(key => key !== 'pets')) {
    throw invalid()
  }

  const pets = row.pets.map(entry => {
    try {
      return parsePersonalPet(entry)
    } catch {
      throw invalid()
    }
  })

  if (new Set(pets.map(pet => pet.pet_id)).size !== pets.length) {
    throw invalid()
  }

  return pets
}

/** Fetches one immutable personal-pet bundle exactly by its verified account
 * content digest.  The caller must still compare the returned digest with the
 * catalog record before placing bytes in the local cache. */
export async function getMatrixPersonalPetContent(
  resource: string,
  grant: NativeGrant,
  sha256: string,
  signal: AbortSignal
): Promise<AtumSkillBundle> {
  const hash = skillHash(sha256)
  let bundle: AtumSkillBundle

  try {
    bundle = parsePetBundle(
      await requestJson(
        resource,
        grant,
        `/pets/content/${hash}`,
        {},
        signal,
        MAXIMUM_SKILL_RESPONSE_BYTES,
        SKILL_REQUEST_TIMEOUT_MS
      )
    )
  } catch {
    throw invalid()
  }

  if (bundle.sha256 !== hash) {
    throw invalid()
  }

  return bundle
}

/** Publishes a fully validated, immutable personal-pet artifact after the
 * Store has granted a fixed hatch credit. The idempotency key belongs to the
 * durable hatch intent, never a renderer retry. */
export async function publishMatrixPersonalPet(
  resource: string,
  grant: NativeGrant,
  input: {
    requestId: string
    creditEntitlementId: string
    displayName: string
    description: string
    bundle: AtumSkillBundle
  },
  signal: AbortSignal
): Promise<AtumPersonalPet> {
  const displayName = input.displayName.trim()
  const description = input.description.trim()
  if (
    !uuid(input.requestId) ||
    !uuid(input.creditEntitlementId) ||
    !validPetText(displayName, 100, 400, true) ||
    !validPetText(description, 2000, 8000, false)
  ) {
    throw invalid()
  }
  let bundle: AtumSkillBundle
  try {
    bundle = parsePetBundle(input.bundle)
  } catch {
    throw invalid()
  }

  const row = object(
    await requestJson(
      resource,
      grant,
      '/pets/personal',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: input.requestId,
          creditEntitlementId: input.creditEntitlementId,
          display_name: displayName,
          description,
          bundle
        })
      },
      signal,
      MAXIMUM_SKILL_RESPONSE_BYTES,
      SKILL_REQUEST_TIMEOUT_MS
    )
  )

  if (Object.keys(row).some(key => key !== 'pet')) {
    throw invalid()
  }
  let pet: AtumPersonalPet
  try {
    pet = parsePersonalPet(row.pet)
  } catch {
    throw invalid()
  }
  if (pet.content_sha256 !== bundle.sha256 || pet.deleted_at !== null) {
    throw invalid()
  }
  return pet
}

async function requestJson(
  resource: string,
  grant: NativeGrant,
  path: string,
  init: Pick<RequestInit, 'method' | 'body'>,
  signal: AbortSignal,
  maximumResponseBytes = MAXIMUM_AGENT_RESPONSE_BYTES,
  timeoutMs = REQUEST_TIMEOUT_MS,
  extraHeaders?: Record<string, string>,
  onResponseHeaders?: (headers: Headers) => void
): Promise<unknown> {
  signal.throwIfAborted()
  const deadline = AbortSignal.timeout(timeoutMs)
  const requestSignal = AbortSignal.any([signal, deadline])
  let response: Response

  try {
    response = await fetch(endpoint(resource, path), {
      ...init,
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${grant.accessToken}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      redirect: 'error',
      signal: requestSignal
    })
  } catch {
    signal.throwIfAborted()
    throw unavailable()
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    throw denied()
  }

  if (response.status === 404) {
    await response.body?.cancel().catch(() => {})
    throw missing()
  }

  if (response.status === 409) {
    // A closed refusal may carry details (a hire price, say). The body is read once.
    throw conflict(await refusalDetails(response))
  }

  if (response.status === 400 || response.status === 422) {
    await response.body?.cancel().catch(() => {})
    throw invalid()
  }

  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw unavailable()
  }

  try {
    const value = await readDomainJson(response, maximumResponseBytes)
    signal.throwIfAborted()
    onResponseHeaders?.(response.headers)

    return value
  } catch {
    signal.throwIfAborted()

    if (deadline.aborted) {
      throw unavailable()
    }

    throw invalid()
  }
}

function endpoint(resource: string, path: string): string {
  let url: URL

  try {
    url = new URL(resource)
  } catch {
    throw invalid()
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw invalid()
  }

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`

  return url.href
}

function agentId(value: string): string {
  if (!uuid(value)) {
    throw invalid()
  }

  return encodeURIComponent(value)
}

function skillHash(value: string): string {
  if (!SHA256.test(value)) {
    throw invalid()
  }

  return value
}

function revision(value: unknown, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) {
    throw invalid()
  }

  return Number(value)
}

function parseBundle(value: unknown): AtumSkillBundle {
  try {
    return parseSkillBundle(value)
  } catch {
    throw invalid()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid()
  }

  return value as Record<string, unknown>
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Match Shell/Marketplace UTF-16 limits before charging. Names reject C0;
 * descriptions allow normal whitespace but never NUL or malformed UTF-16. */
function validPetText(value: string, maximumCharacters: number, maximumBytes: number, required: boolean): boolean {
  const trimmed = value.trim()
  if (
    (required && !trimmed) ||
    value.includes('\0') ||
    value.length > maximumCharacters ||
    (maximumCharacters === 100 && Array.from(value).some(character => character.charCodeAt(0) < 32))
  ) {
    return false
  }
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength > maximumBytes) {
    return false
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(encoded) === value
  } catch {
    return false
  }
}

function denied(refusal?: MatrixAgentRefusalDetails): MatrixAgentDefinitionError {
  return new MatrixAgentDefinitionError('denied', refusal)
}

function conflict(refusal?: MatrixAgentRefusalDetails): MatrixAgentDefinitionError {
  return new MatrixAgentDefinitionError('conflict', refusal)
}

function missing(): MatrixAgentDefinitionError {
  return new MatrixAgentDefinitionError('missing')
}

function unavailable(): MatrixAgentDefinitionError {
  return new MatrixAgentDefinitionError('unavailable')
}

/** The closed refusal details a refusal body carries, read at most once. */
async function refusalDetails(response: Response): Promise<MatrixAgentRefusalDetails | undefined> {
  try {
    const body = await response.json() as { details?: { reason?: string; hire?: { price_protons?: number; price_micro_protons?: number } } }
    const { reason, hire } = body?.details ?? {}
    if (hire !== undefined && typeof hire.price_protons === 'number') {
      return { reason, hire: { price_protons: hire.price_protons, ...(typeof hire.price_micro_protons === 'number' ? { price_micro_protons: hire.price_micro_protons } : {}) } }
    }
    if (reason !== undefined) {
      return { reason }
    }
  } catch {
    // no details: the refusal still means what the status said
  }
  return undefined
}

function invalid(): MatrixAgentDefinitionError {
  return new MatrixAgentDefinitionError('invalid')
}

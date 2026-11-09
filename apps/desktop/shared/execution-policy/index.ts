export const EXECUTION_POLICY_PROFILE = 'atum.execution-policy/1' as const
export const EXECUTION_STATUS_PROFILE = 'atum.execution-status/1' as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DESTINATION = /^(?:cloud|mac:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u
const CASE_ID = /^[a-z][a-z0-9_-]*$/u
const MAX_DESTINATIONS = 65

type JsonObject = Record<string, unknown>

export type ExecutionDestinationId = 'cloud' | `mac:${string}`
export type ExecutionStatusState = 'idle' | 'working' | 'yielding' | 'paused' | 'unavailable'
export type ExecutionDestinationState = 'ready' | 'working' | 'busy' | 'yielding' | 'offline' | 'disabled' | 'degraded'
export type ExecutionDestinationReason =
  | 'busy'
  | 'higher_priority'
  | 'not_present'
  | 'locked'
  | 'stale'
  | 'owner_disabled'
  | 'server_down'
  | 'upgrade_required'
  | 'model_incompatible'
  | 'data_incompatible'
  | 'entitlement_required'
  | 'consent_required'
  | 'execution_failed'

export type ExecutionDestinationStatus =
  | { state: 'ready'; observedAt: number }
  | { state: 'working'; observedAt: number }
  | { state: 'busy'; reason: 'busy'; observedAt: number }
  | { state: 'yielding'; reason: 'higher_priority'; observedAt: number }
  | { state: 'offline'; reason: 'not_present' | 'locked' | 'stale'; observedAt: number }
  | { state: 'disabled'; reason: 'owner_disabled'; observedAt: number }
  | {
      state: 'degraded'
      reason:
        | 'server_down'
        | 'upgrade_required'
        | 'model_incompatible'
        | 'data_incompatible'
        | 'entitlement_required'
        | 'consent_required'
        | 'execution_failed'
      observedAt: number
    }

export interface ExecutionPolicySnapshot {
  profile: typeof EXECUTION_POLICY_PROFILE
  agentPrincipal: string
  revision: number
  source: 'default' | 'saved'
  order: ExecutionDestinationId[]
  disabled: ExecutionDestinationId[]
}

export interface ExecutionPolicyUpdate {
  requestId: string
  expectedRevision: number
  order: ExecutionDestinationId[]
  disabled: ExecutionDestinationId[]
}

/**
 * The per-agent off switch (0238 `atum.matrix_execution_policy_off`; reliability plan R5): deletes
 * the saved policy and returns the agent to the legacy local path. Idempotent by `requestId`,
 * fenced by the revision the owner last saw. Its Shell route (`DELETE .../execution-policy`) is not
 * built yet, so a client offers it only after the capability check (`MatrixExecutionPolicyView.off`).
 */
export interface ExecutionPolicyOff {
  requestId: string
  expectedRevision: number
}

export interface ExecutionStatusSnapshot {
  profile: typeof EXECUTION_STATUS_PROFILE
  agentPrincipal: string
  policyRevision: number
  asOf: number
  state: ExecutionStatusState
  current: ExecutionDestinationId | null
  desired: ExecutionDestinationId | null
  order: ExecutionDestinationId[]
  disabled: ExecutionDestinationId[]
  destinations: Record<ExecutionDestinationId, ExecutionDestinationStatus>
}

export type ExecutionPolicyError =
  | { error: 'matrix_400'; details: { reason: 'invalid' } }
  | { error: 'matrix_409'; details: { reason: 'request_conflict' } }
  | { error: 'matrix_409'; details: { reason: 'revision_conflict' | 'inventory_changed' }; revision: number }
  /** The off switch only: a cloud reply is in flight and has to commit first. */
  | { error: 'matrix_409'; details: { reason: 'queue_busy' } }
  | { error: 'matrix_503'; details: { reason: 'unavailable' } }

/** Desktop bridge-only classification for a provider response that returned HTTP success but
 * failed the strict execution-policy parser/invariants. This is not part of the provider contract. */
export type MatrixExecutionPolicyClientError = {
  error: 'matrix_client'
  details: { reason: 'invalid_response' }
}

export type MatrixExecutionPolicySaveError = ExecutionPolicyError | MatrixExecutionPolicyClientError

export interface ExecutionPolicyDraft {
  order: ExecutionDestinationId[]
  disabled: ExecutionDestinationId[]
}

export interface ExecutionPolicyDestinationView {
  id: ExecutionDestinationId
  kind: 'cloud' | 'mac'
  macOrdinal: number | null
  enabled: boolean
}

export interface ExecutionDestinationView extends ExecutionPolicyDestinationView {
  state: ExecutionDestinationState
  reason?: ExecutionDestinationReason
  current: boolean
  desired: boolean
}

/**
 * One Mac's name for the failover rows and the closed trigger (§9.4 "Real names"), keyed by
 * device service id in `MatrixExecutionPolicyView.deviceNames`. Main projects it from the
 * platform's own device registry: the owner's `displayName` for that Mac (its macOS Computer
 * Name), this Mac's own model as the fallback, and whether it is this Mac. Never the rest of
 * the device record.
 */
export interface ExecutionDeviceName {
  displayName: string
  /** The Mac's model, when main knows it (this Mac reads it locally); the fallback name. */
  model?: string
  thisMac: boolean
}

/** Main-owned cache projection. `stale` retains the last valid facts but never authorizes new work. */
export interface MatrixExecutionPolicyView {
  policy: ExecutionPolicySnapshot
  status?: ExecutionStatusSnapshot
  stale: boolean
  /** The platform answers the per-agent off switch (capability check, `OPTIONS` allows `DELETE`). */
  off?: boolean
  /**
   * The owner's names for its Macs (§9.4), by device service id; cosmetic and optional, never
   * part of the contract. Absent on a build older than it, or when the registry did not answer:
   * a missing entry keeps the stable ordinal name (`Mac 2` / `Máy Mac 2`).
   */
  deviceNames?: Record<string, ExecutionDeviceName>
}

export type MatrixExecutionPolicySaveResult =
  | { ok: true; value: ExecutionPolicySnapshot }
  | { ok: false; error: MatrixExecutionPolicySaveError }

export interface MatrixExecutionPolicyBridge {
  read(agentPrincipal: string): Promise<MatrixExecutionPolicyView>
  save(agentPrincipal: string, update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult>
  /** Absent in a build without the control; offered only when `MatrixExecutionPolicyView.off`. */
  turnOff?(agentPrincipal: string, off: ExecutionPolicyOff): Promise<MatrixExecutionPolicySaveResult>
}

function object(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as JsonObject
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function destination(value: unknown): value is ExecutionDestinationId {
  return typeof value === 'string' && DESTINATION.test(value)
}

function destinationList(value: unknown, cloudRequired: boolean): ExecutionDestinationId[] | null {
  if (!Array.isArray(value) || value.length < (cloudRequired ? 1 : 0) || value.length > MAX_DESTINATIONS) {
    return null
  }

  if (!value.every(destination) || new Set(value).size !== value.length) {
    return null
  }

  if (cloudRequired && value.filter(id => id === 'cloud').length !== 1) {
    return null
  }

  return [...value]
}

function policyLists(value: JsonObject): ExecutionPolicyDraft | null {
  const order = destinationList(value.order, true)
  const disabled = destinationList(value.disabled, false)

  if (!order || !disabled || disabled.some(id => !order.includes(id))) {
    return null
  }

  return { order, disabled }
}

export function parseExecutionPolicySnapshot(value: unknown): ExecutionPolicySnapshot | null {
  const row = object(value)

  if (!row || !exact(row, ['profile', 'agentPrincipal', 'revision', 'source', 'order', 'disabled'])) {
    return null
  }

  const lists = policyLists(row)

  if (
    row.profile !== EXECUTION_POLICY_PROFILE ||
    !uuid(row.agentPrincipal) ||
    !integer(row.revision) ||
    (row.source !== 'default' && row.source !== 'saved') ||
    !lists ||
    (row.source === 'default' ? row.revision !== 0 : row.revision === 0)
  ) {
    return null
  }

  return {
    profile: EXECUTION_POLICY_PROFILE,
    agentPrincipal: row.agentPrincipal,
    revision: row.revision,
    source: row.source,
    ...lists
  }
}

export function parseExecutionPolicyUpdate(value: unknown): ExecutionPolicyUpdate | null {
  const row = object(value)

  if (!row || !exact(row, ['requestId', 'expectedRevision', 'order', 'disabled'])) {
    return null
  }

  const lists = policyLists(row)

  if (!uuid(row.requestId) || !integer(row.expectedRevision) || !lists) {
    return null
  }

  return { requestId: row.requestId, expectedRevision: row.expectedRevision, ...lists }
}

export function parseExecutionPolicyOff(value: unknown): ExecutionPolicyOff | null {
  const row = object(value)

  if (!row || !exact(row, ['requestId', 'expectedRevision']) || !uuid(row.requestId) || !integer(row.expectedRevision)) {
    return null
  }

  return { requestId: row.requestId, expectedRevision: row.expectedRevision }
}

const destinationReasons: Record<ExecutionDestinationState, readonly ExecutionDestinationReason[]> = {
  ready: [],
  working: [],
  busy: ['busy'],
  yielding: ['higher_priority'],
  offline: ['not_present', 'locked', 'stale'],
  disabled: ['owner_disabled'],
  degraded: [
    'server_down',
    'upgrade_required',
    'model_incompatible',
    'data_incompatible',
    'entitlement_required',
    'consent_required',
    'execution_failed'
  ]
}

function parseDestinationStatus(value: unknown): ExecutionDestinationStatus | null {
  const row = object(value)

  if (!row || typeof row.state !== 'string' || !(row.state in destinationReasons) || !integer(row.observedAt)) {
    return null
  }

  const state = row.state as ExecutionDestinationState
  const reasons = destinationReasons[state]

  if (reasons.length === 0) {
    if (!exact(row, ['state', 'observedAt'])) {
      return null
    }

    return { state, observedAt: row.observedAt } as ExecutionDestinationStatus
  }

  if (
    !exact(row, ['state', 'reason', 'observedAt']) ||
    typeof row.reason !== 'string' ||
    !reasons.includes(row.reason as ExecutionDestinationReason)
  ) {
    return null
  }

  return { state, reason: row.reason, observedAt: row.observedAt } as ExecutionDestinationStatus
}

export function parseExecutionStatusSnapshot(value: unknown): ExecutionStatusSnapshot | null {
  const row = object(value)

  if (
    !row ||
    !exact(row, [
      'profile',
      'agentPrincipal',
      'policyRevision',
      'asOf',
      'state',
      'current',
      'desired',
      'order',
      'disabled',
      'destinations'
    ])
  ) {
    return null
  }

  const lists = policyLists(row)
  const states: readonly ExecutionStatusState[] = ['idle', 'working', 'yielding', 'paused', 'unavailable']
  const current = row.current === null ? null : destination(row.current) ? row.current : undefined
  const desired = row.desired === null ? null : destination(row.desired) ? row.desired : undefined
  const rawDestinations = object(row.destinations)

  if (
    row.profile !== EXECUTION_STATUS_PROFILE ||
    !uuid(row.agentPrincipal) ||
    !integer(row.policyRevision) ||
    !integer(row.asOf) ||
    typeof row.state !== 'string' ||
    !states.includes(row.state as ExecutionStatusState) ||
    current === undefined ||
    desired === undefined ||
    !lists ||
    !rawDestinations
  ) {
    return null
  }

  const ids = Object.keys(rawDestinations)

  if (
    ids.length !== lists.order.length ||
    ids.some(id => !destination(id)) ||
    lists.order.some(id => !Object.hasOwn(rawDestinations, id)) ||
    (current !== null && !lists.order.includes(current)) ||
    (desired !== null && !lists.order.includes(desired))
  ) {
    return null
  }

  const destinations = {} as Record<ExecutionDestinationId, ExecutionDestinationStatus>

  for (const id of lists.order) {
    const entry = parseDestinationStatus(rawDestinations[id])

    if (!entry || entry.observedAt > row.asOf) {
      return null
    }

    const disabled = lists.disabled.includes(id)

    const drainingDisabledHolder =
      disabled &&
      id === current &&
      ((row.state === 'working' && current === desired && entry.state === 'working') ||
        (row.state === 'yielding' && entry.state === 'yielding'))

    if (!drainingDisabledHolder && disabled !== (entry.state === 'disabled')) {
      return null
    }

    destinations[id] = entry
  }

  const state = row.state as ExecutionStatusState
  const currentStatus = current === null ? undefined : destinations[current]
  const desiredStatus = desired === null ? undefined : destinations[desired]
  const holders = Object.entries(destinations).filter(([, entry]) => ['working', 'yielding'].includes(entry.state))

  if (holders.length > 1 || holders.some(([id]) => id !== current)) {
    return null
  }

  if (
    (state === 'paused' &&
      (current !== null ||
        desired !== null ||
        Object.values(destinations).some(entry => entry.state !== 'disabled'))) ||
    (state === 'unavailable' &&
      (current !== null ||
        desired !== null ||
        Object.values(destinations).some(entry => ['ready', 'working', 'yielding'].includes(entry.state)))) ||
    (state === 'idle' && (current !== null || !desiredStatus || desiredStatus.state !== 'ready')) ||
    (state === 'working' && (current === null || current !== desired || currentStatus?.state !== 'working')) ||
    (state === 'yielding' &&
      (current === null ||
        desired === null ||
        current === desired ||
        currentStatus?.state !== 'yielding' ||
        currentStatus.reason !== 'higher_priority' ||
        desiredStatus?.state !== 'ready'))
  ) {
    return null
  }

  return {
    profile: EXECUTION_STATUS_PROFILE,
    agentPrincipal: row.agentPrincipal,
    policyRevision: row.policyRevision,
    asOf: row.asOf,
    state,
    current,
    desired,
    ...lists,
    destinations
  }
}

export function parseExecutionPolicyError(value: unknown): ExecutionPolicyError | null {
  const row = object(value)
  const details = row ? object(row.details) : null

  if (!row || !details || !exact(details, ['reason']) || typeof details.reason !== 'string') {
    return null
  }

  if (exact(row, ['error', 'details']) && row.error === 'matrix_400' && details.reason === 'invalid') {
    return { error: 'matrix_400', details: { reason: 'invalid' } }
  }

  if (exact(row, ['error', 'details']) && row.error === 'matrix_409' && details.reason === 'request_conflict') {
    return { error: 'matrix_409', details: { reason: 'request_conflict' } }
  }

  if (exact(row, ['error', 'details']) && row.error === 'matrix_409' && details.reason === 'queue_busy') {
    return { error: 'matrix_409', details: { reason: 'queue_busy' } }
  }

  if (exact(row, ['error', 'details']) && row.error === 'matrix_503' && details.reason === 'unavailable') {
    return { error: 'matrix_503', details: { reason: 'unavailable' } }
  }

  if (
    exact(row, ['error', 'details', 'revision']) &&
    row.error === 'matrix_409' &&
    (details.reason === 'revision_conflict' || details.reason === 'inventory_changed') &&
    integer(row.revision)
  ) {
    return { error: 'matrix_409', details: { reason: details.reason }, revision: row.revision }
  }

  return null
}

/** Parses both the frozen provider error contract and the desktop bridge's one closed local error. */
export function parseMatrixExecutionPolicySaveError(value: unknown): MatrixExecutionPolicySaveError | null {
  const provider = parseExecutionPolicyError(value)

  if (provider) {
    return provider
  }

  const row = object(value)
  const details = row ? object(row.details) : null

  return row &&
    details &&
    exact(row, ['error', 'details']) &&
    exact(details, ['reason']) &&
    row.error === 'matrix_client' &&
    details.reason === 'invalid_response'
    ? { error: 'matrix_client', details: { reason: 'invalid_response' } }
    : null
}

interface ExecutionInventoryEntry {
  authority: 'valid' | 'lost'
  eligible: boolean
  stable: boolean
  activity: 'idle' | 'working' | 'busy'
}

interface ExecutionSelectionInput {
  policy: ExecutionPolicySnapshot
  inventory: Record<ExecutionDestinationId, ExecutionInventoryEntry>
  current: ExecutionDestinationId | null
  activeTurn: boolean
}

function parseSelectionInput(value: unknown): ExecutionSelectionInput | null {
  const row = object(value)

  if (!row || !exact(row, ['policy', 'inventory', 'current', 'activeTurn'])) {
    return null
  }

  const policy = parseExecutionPolicySnapshot(row.policy)
  const rawInventory = object(row.inventory)
  const current = row.current === null ? null : destination(row.current) ? row.current : undefined

  if (!policy || !rawInventory || current === undefined || typeof row.activeTurn !== 'boolean') {
    return null
  }

  const ids = Object.keys(rawInventory)

  if (
    ids.length !== policy.order.length ||
    ids.some(id => !destination(id)) ||
    policy.order.some(id => !Object.hasOwn(rawInventory, id)) ||
    (current !== null && !policy.order.includes(current)) ||
    (row.activeTurn && current === null)
  ) {
    return null
  }

  const inventory = {} as Record<ExecutionDestinationId, ExecutionInventoryEntry>

  for (const id of policy.order) {
    const entry = object(rawInventory[id])

    if (
      !entry ||
      !exact(entry, ['authority', 'eligible', 'stable', 'activity']) ||
      (entry.authority !== 'valid' && entry.authority !== 'lost') ||
      typeof entry.eligible !== 'boolean' ||
      typeof entry.stable !== 'boolean' ||
      !['idle', 'working', 'busy'].includes(String(entry.activity))
    ) {
      return null
    }

    inventory[id] = {
      authority: entry.authority,
      eligible: entry.eligible,
      stable: entry.stable,
      activity: entry.activity as ExecutionInventoryEntry['activity']
    }
  }

  return { policy, inventory, current, activeTurn: row.activeTurn }
}

function parseSelectionCase(value: unknown): boolean {
  const row = object(value)

  if (!row || !exact(row, ['caseId', 'policy', 'inventory', 'current', 'activeTurn', 'expected'])) {
    return false
  }

  const expected = object(row.expected)

  return Boolean(
    typeof row.caseId === 'string' &&
    row.caseId.length <= 80 &&
    CASE_ID.test(row.caseId) &&
    parseSelectionInput({
      policy: row.policy,
      inventory: row.inventory,
      current: row.current,
      activeTurn: row.activeTurn
    }) &&
    expected &&
    exact(expected, ['action', 'desired', 'reason']) &&
    ['acquire', 'retain', 'yield', 'pause', 'wait', 'stop'].includes(String(expected.action)) &&
    (expected.desired === null || destination(expected.desired)) &&
    [
      'policy_first',
      'current_preferred',
      'active_turn',
      'all_disabled',
      'no_eligible',
      'higher_priority',
      'authority_lost'
    ].includes(String(expected.reason))
  )
}

type ValidationSubject = 'policy.snapshot' | 'status.snapshot' | 'selection.input'

function validSubject(subject: ValidationSubject, value: unknown): boolean {
  if (subject === 'policy.snapshot') {
    return parseExecutionPolicySnapshot(value) !== null
  }

  if (subject === 'status.snapshot') {
    return parseExecutionStatusSnapshot(value) !== null
  }

  return parseSelectionInput(value) !== null
}

function parseValidationCase(value: unknown): boolean {
  const row = object(value)

  if (!row) {
    return false
  }

  const hasViolation = Object.hasOwn(row, 'violation')
  const subject = row.subject as ValidationSubject

  return Boolean(
    exact(
      row,
      hasViolation
        ? ['caseId', 'subject', 'value', 'accepted', 'violation']
        : ['caseId', 'subject', 'value', 'accepted']
    ) &&
    typeof row.caseId === 'string' &&
    row.caseId.length <= 80 &&
    CASE_ID.test(row.caseId) &&
    ['policy.snapshot', 'status.snapshot', 'selection.input'].includes(String(row.subject)) &&
    typeof row.accepted === 'boolean' &&
    row.accepted !== hasViolation &&
    (!hasViolation ||
      [
        'cloud_required',
        'disabled_subset',
        'revision_source',
        'future_observation',
        'status_coherence',
        'inventory_mismatch'
      ].includes(String(row.violation))) &&
    validSubject(subject, row.value) === row.accepted
  )
}

export function executionContractAccepts(message: string, value: unknown): boolean {
  switch (message) {
    case 'policy.snapshot':
      return parseExecutionPolicySnapshot(value) !== null

    case 'policy.update.request':
      return parseExecutionPolicyUpdate(value) !== null

    case 'status.snapshot':
      return parseExecutionStatusSnapshot(value) !== null

    case 'error.response':
      return parseExecutionPolicyError(value) !== null

    case 'selection.case':
      return parseSelectionCase(value)

    case 'validation.case':
      return parseValidationCase(value)

    default:
      return false
  }
}

export function executionPolicyDraft(policy: ExecutionPolicySnapshot): ExecutionPolicyDraft {
  return { order: [...policy.order], disabled: [...policy.disabled] }
}

export function setExecutionDestinationEnabled(
  draft: ExecutionPolicyDraft,
  id: ExecutionDestinationId,
  enabled: boolean
): ExecutionPolicyDraft {
  if (!draft.order.includes(id)) {
    throw new Error('execution_policy_destination_unknown')
  }

  const disabled = new Set(draft.disabled)

  if (enabled) {
    disabled.delete(id)
  } else {
    disabled.add(id)
  }

  return { order: [...draft.order], disabled: draft.order.filter(each => disabled.has(each)) }
}

export function moveExecutionDestination(
  draft: ExecutionPolicyDraft,
  id: ExecutionDestinationId,
  targetIndex: number
): ExecutionPolicyDraft {
  const from = draft.order.indexOf(id)

  if (from < 0) {
    throw new Error('execution_policy_destination_unknown')
  }

  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= draft.order.length) {
    throw new Error('execution_policy_order_invalid')
  }

  const order = [...draft.order]
  order.splice(from, 1)
  order.splice(targetIndex, 0, id)

  return { order, disabled: order.filter(each => draft.disabled.includes(each)) }
}

export function buildExecutionPolicyUpdate(
  policy: ExecutionPolicySnapshot,
  draft: ExecutionPolicyDraft,
  requestId: string
): ExecutionPolicyUpdate {
  const update = parseExecutionPolicyUpdate({
    requestId,
    expectedRevision: policy.revision,
    order: draft.order,
    disabled: draft.disabled
  })

  if (!update || update.order.length !== policy.order.length || policy.order.some(id => !update.order.includes(id))) {
    throw new Error('execution_policy_update_invalid')
  }

  return update
}

function sameDestinationList(
  left: readonly ExecutionDestinationId[],
  right: readonly ExecutionDestinationId[]
): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameDestinationSet(
  left: readonly ExecutionDestinationId[],
  right: readonly ExecutionDestinationId[]
): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

/** A status is displayable with a policy only when it describes that exact authoritative revision. */
export function executionStatusMatchesPolicy(
  policy: ExecutionPolicySnapshot,
  status: ExecutionStatusSnapshot
): boolean {
  return (
    policy.agentPrincipal === status.agentPrincipal &&
    policy.revision === status.policyRevision &&
    sameDestinationList(policy.order, status.order) &&
    sameDestinationSet(policy.disabled, status.disabled)
  )
}

export function executionPolicyDestinationViews(
  policy: Pick<ExecutionPolicySnapshot, 'order' | 'disabled'>
): ExecutionPolicyDestinationView[] {
  // The contract intentionally carries no device name. Keep the privacy-safe fallback label stable
  // when the owner changes priority: policy order moves icons, but it must not rename Mac 1 to Mac 2.
  const macOrdinals = new Map(
    policy.order
      .filter((id): id is `mac:${string}` => id !== 'cloud')
      .toSorted()
      .map((id, index) => [id, index + 1])
  )

  return policy.order.map(id => {
    const kind = id === 'cloud' ? 'cloud' : 'mac'

    return {
      id,
      kind,
      macOrdinal: kind === 'mac' ? (macOrdinals.get(id as `mac:${string}`) ?? null) : null,
      enabled: !policy.disabled.includes(id)
    }
  })
}

export function executionDestinationViews(status: ExecutionStatusSnapshot): ExecutionDestinationView[] {
  return executionPolicyDestinationViews(status).map(view => {
    const entry = status.destinations[view.id]

    return {
      ...view,
      state: entry.state,
      ...('reason' in entry ? { reason: entry.reason } : {}),
      current: status.current === view.id,
      desired: status.desired === view.id
    }
  })
}

/**
 * The owner's list of scheduled tasks for one agent (`atum.agent-routines/1`, and the /1.1
 * additive `interval` schedule). Phase 1 of the routines UI: once/daily/weekly/monthly are
 * editable; `interval` and any kind this build does not know are kept in the list and marked
 * read-only, never rejected, so one newer row cannot hide every other row.
 *
 * The window names an assistant by its agent principal; native translates that to the
 * assistant id the owner route takes. The renderer never sees the owner token or an assistant
 * id. Every schedule hour/minute is a wall clock in the routine's own `timezone`.
 */

export const AGENT_ROUTINES_PROFILE = 'atum.agent-routines/1' as const
export const AGENT_ROUTINE_RUNS_PROFILE = 'atum.agent-routine-runs/1' as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::[0-9]{2})?)$/u
const SKIP_REASON = /^[a-z][a-z0-9_]*$/u
const PUBLISHED_EVENT = /^\$[!-~]+$/u
const MAX_ROUTINES = 64
const MAX_RUNS = 20

type JsonObject = Record<string, unknown>

export type MatrixAgentRoutineLegacyState = 'unknown' | 'clear' | 'present'

export type MatrixAgentRoutineSchedule =
  | { kind: 'once'; runAt: string }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; weekdays: number[] }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'interval'; everyHours: number }
  | { kind: 'unsupported'; kindName: string }

/** The kinds this build can write. `interval` waits for the phone decoder (M1). */
export type MatrixAgentRoutineWriteSchedule =
  | { kind: 'once'; runAt: string }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; weekdays: number[] }
  | { kind: 'monthly'; day: number; hour: number; minute: number }

export type MatrixAgentRoutineRunState = 'claimed' | 'dispatched' | 'skipped' | 'completed'
export type MatrixAgentRoutineRunOutcome = 'answered' | 'stopped' | 'failed' | 'uncertain'
export type MatrixAgentRoutineRunDeliveryDisposition = 'delivered' | 'silent'

export interface MatrixAgentRoutineRun {
  occurrenceId: string
  scheduledAt: number
  state: MatrixAgentRoutineRunState
  outcome?: MatrixAgentRoutineRunOutcome
  skipReason?: string
  publishedEvent?: string
  deliveryDisposition?: MatrixAgentRoutineRunDeliveryDisposition
}

export interface MatrixAgentRoutine {
  id: string
  title: string
  instruction: string
  schedule: MatrixAgentRoutineSchedule
  timezone: string
  enabled: boolean
  notifications: boolean
  revision: number
  nextRunAt: number | null
  lastRun: MatrixAgentRoutineRun | null
}

export interface MatrixAgentRoutinesSnapshot {
  assistantId: string
  assistantPrincipal: string
  serverTime: number
  legacyState: MatrixAgentRoutineLegacyState
  routines: MatrixAgentRoutine[]
}

export interface MatrixAgentRoutineRunsSnapshot {
  routineId: string
  runs: MatrixAgentRoutineRun[]
}

/** What the window may write. `title` is the person's name for the routine; the form leaves it
 * empty to fall back to the instruction's first words (`matrixRoutineTitle`). */
export interface MatrixAgentRoutineCreate {
  principal: string
  title: string
  instruction: string
  schedule: MatrixAgentRoutineWriteSchedule
  timezone: string
  enabled: boolean
  notifications: boolean
}

export interface MatrixAgentRoutineUpdate extends MatrixAgentRoutineCreate {
  routineId: string
  expectedRevision: number
}

export interface MatrixAgentRoutineAction {
  principal: string
  routineId: string
  expectedRevision: number
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The closed mutation body the owner route takes, with main's stable request id. */
export type MatrixAgentRoutineMutation =
  | ({ operation: 'create'; requestId: string } & Omit<MatrixAgentRoutineCreate, 'principal'>)
  | ({ operation: 'update'; requestId: string } & Omit<MatrixAgentRoutineUpdate, 'principal'>)
  | { operation: 'run' | 'delete'; requestId: string; routineId: string; expectedRevision: number }

/** One mutation before main assigns its request id (the ledger keys this exact body). */
export type MatrixAgentRoutineMutationDraft = DistributiveOmit<MatrixAgentRoutineMutation, 'requestId'>

export type MatrixRoutineError =
  | 'conflict'
  | 'quota'
  | 'legacy'
  | 'missing'
  | 'invalid'
  | 'denied'
  | 'offline'
  | 'unavailable'

export type MatrixRoutineReadResult =
  | { ok: true; snapshot: MatrixAgentRoutinesSnapshot }
  | { ok: false; error: MatrixRoutineError }

export type MatrixRoutineRunsResult =
  | { ok: true; snapshot: MatrixAgentRoutineRunsSnapshot }
  | { ok: false; error: MatrixRoutineError }

export type MatrixRoutineMutationResult =
  | { ok: true; routine: MatrixAgentRoutine }
  | { ok: true; deleted: { id: string; revision: number } }
  | { ok: false; error: MatrixRoutineError }

/** The assistant card's bridge: a principal in, owner-scoped routines out. */
export interface MatrixRoutinesBridge {
  read(principal: string): Promise<MatrixRoutineReadResult>
  create(input: MatrixAgentRoutineCreate): Promise<MatrixRoutineMutationResult>
  update(input: MatrixAgentRoutineUpdate): Promise<MatrixRoutineMutationResult>
  run(input: MatrixAgentRoutineAction): Promise<MatrixRoutineMutationResult>
  delete(input: MatrixAgentRoutineAction): Promise<MatrixRoutineMutationResult>
  runs(principal: string, routineId: string): Promise<MatrixRoutineRunsResult>
  /** A38: the owner zone the platform last acknowledged for this sign-in, or undefined when
   * none was ever recorded (a new routine then defaults to this device's zone). */
  ownerZone?(): Promise<string | undefined>
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function exact(row: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(row).sort().join(',') === [...keys].sort().join(',')
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function control(value: string, forbidden: (code: number) => boolean): boolean {
  return Array.from(value).some(char => forbidden(char.codePointAt(0)!))
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Array.from(value).length <= maximum &&
    value === value.trim() &&
    !control(value, code => code <= 0x1f || code === 0x7f)
  )
}

function instruction(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Array.from(value).length <= 20_000 &&
    value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= 65_536 &&
    !control(value, code => code === 0 || code === 0x0b || code === 0x0c || code === 0x7f)
  )
}

export function matrixRoutineTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)

    return true
  } catch {
    return false
  }
}

function clock(value: unknown, maximum: number): value is number {
  return safeInteger(value) && (value as number) <= maximum
}

/** A schedule from the platform. Unknown kinds are kept (`unsupported`) for a read-only row. */
export function parseMatrixAgentRoutineSchedule(value: unknown): MatrixAgentRoutineSchedule | null {
  const row = object(value)

  if (!row || typeof row.kind !== 'string' || row.kind.length === 0 || row.kind.length > 64) {
    return null
  }

  switch (row.kind) {
    case 'once':
      return exact(row, ['kind', 'runAt']) &&
        typeof row.runAt === 'string' &&
        row.runAt.length <= 40 &&
        INSTANT.test(row.runAt) &&
        Number.isFinite(Date.parse(row.runAt))
        ? { kind: 'once', runAt: row.runAt }
        : null

    case 'daily':
      return exact(row, ['kind', 'hour', 'minute']) && clock(row.hour, 23) && clock(row.minute, 59)
        ? { kind: 'daily', hour: row.hour, minute: row.minute }
        : null
    case 'weekly': {
      if (!exact(row, ['kind', 'hour', 'minute', 'weekdays']) || !clock(row.hour, 23) || !clock(row.minute, 59)) {
        return null
      }

      const days = row.weekdays

      if (
        !Array.isArray(days) ||
        days.length < 1 ||
        days.length > 7 ||
        !days.every(day => safeInteger(day) && day >= 1 && day <= 7) ||
        new Set(days).size !== days.length
      ) {
        return null
      }

      return { kind: 'weekly', hour: row.hour, minute: row.minute, weekdays: [...days].sort((a, b) => a - b) }
    }

    case 'monthly':
      return exact(row, ['kind', 'day', 'hour', 'minute']) &&
        safeInteger(row.day) &&
        row.day >= 1 &&
        row.day <= 28 &&
        clock(row.hour, 23) &&
        clock(row.minute, 59)
        ? { kind: 'monthly', day: row.day, hour: row.hour, minute: row.minute }
        : null

    case 'interval':
      return exact(row, ['kind', 'everyHours']) && safeInteger(row.everyHours) && row.everyHours >= 1 && row.everyHours <= 8_760
        ? { kind: 'interval', everyHours: row.everyHours }
        : null

    default:
      // v1.1 requires an older consumer to keep and show an unknown kind read-only.
      return { kind: 'unsupported', kindName: row.kind }
  }
}

/** A schedule the window wants to write: the four kinds this build owns. */
export function parseMatrixAgentRoutineWriteSchedule(value: unknown): MatrixAgentRoutineWriteSchedule | null {
  const schedule = parseMatrixAgentRoutineSchedule(value)

  if (!schedule || schedule.kind === 'interval' || schedule.kind === 'unsupported') {
    return null
  }

  return schedule
}

export function parseMatrixAgentRoutineRun(value: unknown): MatrixAgentRoutineRun | null {
  const row = object(value)
  const required = ['occurrenceId', 'scheduledAt', 'state']
  const optional = ['outcome', 'skipReason', 'publishedEvent', 'deliveryDisposition']

  if (
    !row ||
    !required.every(key => Object.hasOwn(row, key)) ||
    Object.keys(row).some(key => !required.includes(key) && !optional.includes(key)) ||
    !uuid(row.occurrenceId) ||
    !safeInteger(row.scheduledAt)
  ) {
    return null
  }

  const state = row.state
  const outcome = row.outcome === undefined ? undefined : row.outcome
  const skipReason = row.skipReason === undefined ? undefined : row.skipReason
  const publishedEvent = row.publishedEvent === undefined ? undefined : row.publishedEvent
  const deliveryDisposition = row.deliveryDisposition === undefined ? undefined : row.deliveryDisposition

  if (
    !['claimed', 'dispatched', 'skipped', 'completed'].includes(state as string) ||
    (outcome !== undefined && !['answered', 'stopped', 'failed', 'uncertain'].includes(outcome as string)) ||
    (skipReason !== undefined &&
      (typeof skipReason !== 'string' || Array.from(skipReason).length > 64 || !SKIP_REASON.test(skipReason))) ||
    (publishedEvent !== undefined &&
      (typeof publishedEvent !== 'string' ||
        Array.from(publishedEvent).length > 1_024 ||
        !PUBLISHED_EVENT.test(publishedEvent))) ||
    (state === 'completed') !== (outcome !== undefined) ||
    (state === 'skipped') !== (skipReason !== undefined) ||
    (publishedEvent !== undefined && state !== 'completed') ||
    (deliveryDisposition !== undefined &&
      (!['delivered', 'silent'].includes(deliveryDisposition as string) || state !== 'completed'))
  ) {
    return null
  }

  return {
    occurrenceId: row.occurrenceId,
    scheduledAt: row.scheduledAt,
    state: state as MatrixAgentRoutineRunState,
    ...(outcome === undefined ? {} : { outcome: outcome as MatrixAgentRoutineRunOutcome }),
    ...(skipReason === undefined ? {} : { skipReason: skipReason as string }),
    ...(publishedEvent === undefined ? {} : { publishedEvent: publishedEvent as string }),
    ...(deliveryDisposition === undefined
      ? {}
      : { deliveryDisposition: deliveryDisposition as MatrixAgentRoutineRunDeliveryDisposition })
  }
}

export function parseMatrixAgentRoutine(value: unknown): MatrixAgentRoutine | null {
  const row = object(value)

  if (
    !row ||
    !exact(row, ['id', 'title', 'instruction', 'schedule', 'timezone', 'enabled', 'notifications', 'revision', 'nextRunAt', 'lastRun']) ||
    !uuid(row.id) ||
    !text(row.title, 120) ||
    !instruction(row.instruction) ||
    !matrixRoutineTimeZone(row.timezone) ||
    typeof row.enabled !== 'boolean' ||
    typeof row.notifications !== 'boolean' ||
    !safeInteger(row.revision, 1) ||
    !(row.nextRunAt === null || safeInteger(row.nextRunAt)) ||
    !(row.lastRun === null || parseMatrixAgentRoutineRun(row.lastRun))
  ) {
    return null
  }

  const schedule = parseMatrixAgentRoutineSchedule(row.schedule)

  if (!schedule) {
    return null
  }

  return {
    id: row.id,
    title: row.title,
    instruction: row.instruction,
    schedule,
    timezone: row.timezone,
    enabled: row.enabled,
    notifications: row.notifications,
    revision: row.revision,
    nextRunAt: row.nextRunAt as number | null,
    lastRun: row.lastRun === null ? null : parseMatrixAgentRoutineRun(row.lastRun)
  }
}

/** The one routines read. `assistantId`/`assistantPrincipal` are checked by native against
 * the agent the principal names, so a mismatched envelope is never shown under another agent. */
export function parseMatrixAgentRoutinesSnapshot(value: unknown): MatrixAgentRoutinesSnapshot | null {
  const row = object(value)

  if (!row || !exact(row, ['profile', 'assistantId', 'assistantPrincipal', 'serverTime', 'legacyState', 'routines'])) {
    return null
  }

  if (
    row.profile !== AGENT_ROUTINES_PROFILE ||
    !uuid(row.assistantId) ||
    !uuid(row.assistantPrincipal) ||
    !safeInteger(row.serverTime) ||
    !['unknown', 'clear', 'present'].includes(row.legacyState as string) ||
    !Array.isArray(row.routines) ||
    row.routines.length > MAX_ROUTINES
  ) {
    return null
  }

  const routines = row.routines.map(parseMatrixAgentRoutine)

  if (routines.some(routine => routine === null) || new Set(routines.map(routine => routine!.id)).size !== routines.length) {
    return null
  }

  return {
    assistantId: row.assistantId,
    assistantPrincipal: row.assistantPrincipal,
    serverTime: row.serverTime,
    legacyState: row.legacyState as MatrixAgentRoutineLegacyState,
    routines: routines as MatrixAgentRoutine[]
  }
}

export function parseMatrixAgentRoutineRunsSnapshot(
  value: unknown,
  routineId: string
): MatrixAgentRoutineRunsSnapshot | null {
  const row = object(value)

  if (
    !row ||
    !exact(row, ['profile', 'routineId', 'runs']) ||
    row.profile !== AGENT_ROUTINE_RUNS_PROFILE ||
    row.routineId !== routineId ||
    !Array.isArray(row.runs) ||
    row.runs.length > MAX_RUNS
  ) {
    return null
  }

  const runs = row.runs.map(parseMatrixAgentRoutineRun)

  if (runs.some(run => run === null) || new Set(runs.map(run => run!.occurrenceId)).size !== runs.length) {
    return null
  }

  return { routineId, runs: runs as MatrixAgentRoutineRun[] }
}

/** create/update answer the routine; delete answers its id and the revision it had. */
export function parseMatrixAgentRoutineMutation(value: unknown): MatrixAgentRoutine | { id: string; revision: number } | null {
  const row = object(value)

  if (!row || row.profile !== AGENT_ROUTINES_PROFILE) {
    return null
  }

  if (exact(row, ['profile', 'routine'])) {
    return parseMatrixAgentRoutine(row.routine)
  }

  if (
    exact(row, ['profile', 'outcome', 'routineId', 'revision']) &&
    row.outcome === 'deleted' &&
    uuid(row.routineId) &&
    safeInteger(row.revision, 1)
  ) {
    return { id: row.routineId, revision: row.revision }
  }

  return null
}

/** A create from the trusted renderer boundary (main adds `requestId`). */
export function matrixRoutineCreateInput(value: unknown): MatrixAgentRoutineCreate | null {
  const row = object(value)
  const schedule = row ? parseMatrixAgentRoutineWriteSchedule(row.schedule) : null

  if (
    !row ||
    !exact(row, ['principal', 'title', 'instruction', 'schedule', 'timezone', 'enabled', 'notifications']) ||
    !uuid(row.principal) ||
    !text(row.title, 120) ||
    !instruction(row.instruction) ||
    !matrixRoutineTimeZone(row.timezone) ||
    typeof row.enabled !== 'boolean' ||
    typeof row.notifications !== 'boolean' ||
    !schedule
  ) {
    return null
  }

  return {
    principal: row.principal,
    title: row.title,
    instruction: row.instruction,
    schedule,
    timezone: row.timezone,
    enabled: row.enabled,
    notifications: row.notifications
  }
}

export function matrixRoutineUpdateInput(value: unknown): MatrixAgentRoutineUpdate | null {
  const row = object(value)
  const schedule = row ? parseMatrixAgentRoutineWriteSchedule(row.schedule) : null

  if (
    !row ||
    !exact(row, ['principal', 'routineId', 'expectedRevision', 'title', 'instruction', 'schedule', 'timezone', 'enabled', 'notifications']) ||
    !uuid(row.principal) ||
    !uuid(row.routineId) ||
    !safeInteger(row.expectedRevision, 1) ||
    !text(row.title, 120) ||
    !instruction(row.instruction) ||
    !matrixRoutineTimeZone(row.timezone) ||
    typeof row.enabled !== 'boolean' ||
    typeof row.notifications !== 'boolean' ||
    !schedule
  ) {
    return null
  }

  return {
    principal: row.principal,
    routineId: row.routineId,
    expectedRevision: row.expectedRevision,
    title: row.title,
    instruction: row.instruction,
    schedule,
    timezone: row.timezone,
    enabled: row.enabled,
    notifications: row.notifications
  }
}

export function matrixRoutineActionInput(value: unknown): MatrixAgentRoutineAction | null {
  const row = object(value)

  if (
    !row ||
    !exact(row, ['principal', 'routineId', 'expectedRevision']) ||
    !uuid(row.principal) ||
    !uuid(row.routineId) ||
    !safeInteger(row.expectedRevision, 1)
  ) {
    return null
  }

  return { principal: row.principal, routineId: row.routineId, expectedRevision: row.expectedRevision }
}

/** The title the platform stores when the person does not name a routine: its first words. */
export function matrixRoutineTitle(instruction: string): string {
  const collapsed = instruction.replace(/\s+/gu, ' ').trim()
  const sentence = collapsed.split(/(?<=[.!?…])\s/u)[0] ?? collapsed
  const words = sentence.split(' ')
  const title = Array.from(words.slice(0, 8).join(' ')).slice(0, 120).join('').trim()

  return title || Array.from(collapsed).slice(0, 120).join('').trim()
}

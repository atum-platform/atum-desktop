/**
 * A paid assistant's scheduled runs happen once per household, not once per Mac.
 *
 * Every Mac of the owner has the assistant's Store jobs (each Hermes backend keeps its own
 * jobs), and a Mac that was asleep at fire time catches the job up when it wakes. The
 * answering lease only stops two Macs running at the same moment. This ledger stops a late
 * Mac repeating a run another Mac already did, which would charge the owner twice and post
 * twice. Like check-ins' ledger it lives in the owner's account data, synced to every Mac,
 * one event per assistant holding one claim per Store job. A run claims its job's occurrence
 * there, holding the assistant's lease, before its Store task is minted
 * (electron/matrix/store-schedules.ts).
 *
 * An occurrence is the schedule slot a run belongs to: the latest minute, at or before now,
 * when its job's spec fired. It is a wall-clock label ('YYYY-MM-DDTHH:MM'), not an instant,
 * because each Mac fires its jobs in its own local time: two Macs whose clocks or time zones
 * differ name the same slot alike. Claims are per job (the proxy knows the job from its
 * model name, `matrixStoreRunModel`): a Mac catching up an assistant's two jobs repeats
 * neither one another Mac already ran.
 */
import type { MatrixStoreScheduleSpec } from './matrix-store-schedules'

/** One assistant's ledger event in the owner's account data. */
export const matrixStoreRunsEvent = (assistantId: string) => `io.atum.store_runs.${assistantId}`

/** Assistant IDs are the Store's UUIDs; nothing else names an account-data event here. */
export const matrixStoreRunsAssistant = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)

export interface MatrixStoreRunClaim {
  /** The slot claimed, as a wall-clock label. */
  occurrence: string
  /** The Mac (the assistant's executor there) that runs it. */
  executorId: string
  /** When it was claimed, on that Mac's clock. */
  claimedAt: number
}

export interface MatrixStoreRunLedger {
  version: 2
  /** Each Store job's latest claim, by job key (`matrixStoreRunJobKey`: `<item>/<schedule>`). */
  runs: Readonly<Record<string, MatrixStoreRunClaim>>
}

/** How long the Mac that claimed an occurrence may bind it again (a run that lost its
 * lease or outlived its linger between calls). Hermes stops a cron run after minutes; past
 * this, the same slot coming round again on that Mac (its time zone changed, or Hermes
 * re-ran a job it lost track of) is a repeat and stays silent. */
export const MATRIX_STORE_RUN_REBIND_MS = 30 * 60_000

/** An assistant has a handful of jobs; a ledger is never allowed to grow past this. */
const MAX_RUNS = 32

export const emptyMatrixStoreRunLedger = (): MatrixStoreRunLedger => ({ version: 2, runs: {} })

const OCCURRENCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const JOB_KEY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/

function parseClaim(value: unknown): MatrixStoreRunClaim | null {
  const claim = value as Partial<Record<keyof MatrixStoreRunClaim, unknown>> | null

  if (
    !claim ||
    typeof claim !== 'object' ||
    Array.isArray(claim) ||
    typeof claim.occurrence !== 'string' ||
    !OCCURRENCE.test(claim.occurrence) ||
    typeof claim.executorId !== 'string' ||
    !claim.executorId ||
    claim.executorId.length > 256 ||
    typeof claim.claimedAt !== 'number' ||
    !Number.isFinite(claim.claimedAt)
  ) {
    return null
  }

  return { occurrence: claim.occurrence, executorId: claim.executorId, claimedAt: claim.claimedAt }
}

/**
 * The ledger from account data: none yet is empty, and so is the pre-release per-assistant
 * shape (version 1: its one claim names no job). A newer schema, or a claim this build cannot
 * read, is null: the run stays silent rather than risk running twice.
 */
export function parseMatrixStoreRunLedger(raw: unknown): MatrixStoreRunLedger | null {
  if (raw === undefined || raw === null) {
    return emptyMatrixStoreRunLedger()
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const { version, runs } = raw as { version?: unknown; runs?: unknown }

  if (version === 1) {
    return emptyMatrixStoreRunLedger()
  }

  if (version !== 2) {
    return null
  }

  if (runs === undefined || runs === null) {
    return emptyMatrixStoreRunLedger()
  }

  if (typeof runs !== 'object' || Array.isArray(runs)) {
    return null
  }

  const entries = Object.entries(runs as Record<string, unknown>)

  if (entries.length > MAX_RUNS) {
    return null
  }

  const parsed: Record<string, MatrixStoreRunClaim> = {}

  for (const [key, value] of entries) {
    const claim = parseClaim(value)

    if (key.length > 160 || !JOB_KEY.test(key) || !claim) {
      return null
    }

    parsed[key] = claim
  }

  return { version: 2, runs: parsed }
}

/**
 * This executor's claim on one job's `occurrence`: the ledger to write, the same ledger when
 * it already holds the claim (and may bind it again), or null when the run must stay silent:
 * another Mac claimed this slot of the job or a later one, or this Mac's own claim is too old
 * to be the same run. Other jobs' claims are kept as they are.
 */
export function claimMatrixStoreRun(
  ledger: MatrixStoreRunLedger,
  jobKey: string,
  occurrence: string,
  executorId: string,
  now: number
): MatrixStoreRunLedger | null {
  const last = ledger.runs[jobKey]

  if (last && last.occurrence > occurrence) {
    return null
  }

  if (last && last.occurrence === occurrence) {
    return last.executorId === executorId && Math.abs(now - last.claimedAt) <= MATRIX_STORE_RUN_REBIND_MS
      ? ledger
      : null
  }

  const runs: Record<string, MatrixStoreRunClaim> = {
    ...ledger.runs,
    [jobKey]: { occurrence, executorId, claimedAt: now }
  }

  // Bounded: the claims longest unused go first (a job a lapsed hire left behind).
  const stale = Object.keys(runs)
    .sort((a, b) => runs[a]!.claimedAt - runs[b]!.claimedAt)
    .slice(0, Math.max(0, Object.keys(runs).length - MAX_RUNS))

  for (const key of stale) {
    delete runs[key]
  }

  return { version: 2, runs }
}

/** One cron field's values: `*`, `n`, `a-b`, `*\/s`, `a-b/s` and lists of them. */
function cronField(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()

  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)

    if (!match) {
      return null
    }

    const from = match[1] === '*' ? min : Number(match[2])
    const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from
    const step = match[4] ? Number(match[4]) : 1

    if (from < min || to > max || from > to || step < 1) {
      return null
    }

    for (let value = from; value <= to; value += step) {
      values.add(value)
    }
  }

  return values
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** The latest wall-clock minute at or before `wallNow` (ms, wall clock read as UTC) when a
 * five-field cron fired, within a year; null for a cron this does not read. */
function lastFire(cron: string, wallNow: number): number | null {
  const fields = cron.trim().split(/\s+/)

  if (fields.length !== 5) {
    return null
  }

  const minutes = cronField(fields[0]!, 0, 59)
  const hours = cronField(fields[1]!, 0, 23)
  const days = cronField(fields[2]!, 1, 31)
  const months = cronField(fields[3]!, 1, 12)
  const weekdays = cronField(fields[4]!, 0, 7)

  if (!minutes || !hours || !days || !months || !weekdays) {
    return null
  }

  if (weekdays.has(7)) {
    weekdays.add(0)
  }

  const byMinute = [...minutes].sort((a, b) => b - a)
  const byHour = [...hours].sort((a, b) => b - a)
  // Cron's rule: with both day fields restricted, either one matching is enough.
  const either = fields[2] !== '*' && fields[4] !== '*'
  const today = new Date(wallNow)

  for (let back = 0; back <= 366; back++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back))
    const dayOfMonth = days.has(day.getUTCDate())
    const dayOfWeek = weekdays.has(day.getUTCDay())

    if (!months.has(day.getUTCMonth() + 1) || !(either ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek)) {
      continue
    }

    for (const hour of byHour) {
      for (const minute of byMinute) {
        const at = day.getTime() + (hour * 60 + minute) * 60_000

        if (at <= wallNow) {
          return at
        }
      }
    }
  }

  return null
}

/**
 * The occurrence a run at `now` belongs to: the latest fire of any of `specs` (its job's
 * one) at or before now, in the wall-clock time of a Mac whose zone is `zoneOffsetMinutes`
 * (Date#getTimezoneOffset). Null when none fired within a year.
 */
export function matrixStoreRunOccurrence(
  specs: readonly MatrixStoreScheduleSpec[],
  now: number,
  zoneOffsetMinutes = new Date(now).getTimezoneOffset()
): string | null {
  const wallNow = now - zoneOffsetMinutes * 60_000
  let latest: number | null = null

  for (const spec of specs) {
    const at = lastFire(spec.cron, wallNow)

    if (at !== null && (latest === null || at > latest)) {
      latest = at
    }
  }

  if (latest === null) {
    return null
  }

  const at = new Date(latest)

  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
}

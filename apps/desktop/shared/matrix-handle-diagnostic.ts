import type { MatrixAliasErrorCode } from './matrix-aliases'

/**
 * How the "Trợ lý mới" sheet settled a new assistant's handle, for main.log. Main already writes
 * one line per directory request (`[Matrix] handle action=…`); this adds the one thing only the
 * sheet knows: where the handle came from and how the sheet finished. Closed values only, never
 * the handle, the name or any ID.
 *
 * `source`: `derived` (made from the name, untouched), `typed` (the person changed it),
 * `suggested` (the person took the numbered handle offered when theirs was taken).
 * `check`: the last answer the field showed before Create.
 * `outcome`: `claimed` (the handle shown), `claimed_other` (a later candidate, after a race or a
 * refusal), `retry` (the sheet offers Retry), `later` (a refusal Retry cannot change: the card
 * offers a handle later), `skipped` (no directory, or an older host returned no assistant ID).
 */
export interface MatrixHandleSheetDiagnostic {
  source: 'derived' | 'typed' | 'suggested'
  check: 'available' | 'taken' | 'reserved' | 'invalid' | 'unchecked'
  outcome: 'claimed' | 'claimed_other' | 'retry' | 'later' | 'skipped'
}

const VALUES: { [K in keyof MatrixHandleSheetDiagnostic]: ReadonlySet<string> } = {
  source: new Set(['derived', 'typed', 'suggested']),
  check: new Set(['available', 'taken', 'reserved', 'invalid', 'unchecked']),
  outcome: new Set(['claimed', 'claimed_other', 'retry', 'later', 'skipped'])
}

/** Main's reading of what the window sent: exactly these three closed fields, or nothing. */
export function parseMatrixHandleSheetDiagnostic(value: unknown): MatrixHandleSheetDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const row = value as Record<string, unknown>
  const keys = Object.keys(row)

  if (keys.length !== 3) {
    return undefined
  }

  for (const key of Object.keys(VALUES) as Array<keyof MatrixHandleSheetDiagnostic>) {
    if (typeof row[key] !== 'string' || !VALUES[key].has(row[key] as string)) {
      return undefined
    }
  }

  return { source: row.source, check: row.check, outcome: row.outcome } as MatrixHandleSheetDiagnostic
}

/** `[Matrix] handle sheet=create source=typed check=taken outcome=claimed_other` */
export function formatMatrixHandleSheetDiagnostic(line: MatrixHandleSheetDiagnostic): string {
  return `[Matrix] handle sheet=create source=${line.source} check=${line.check} outcome=${line.outcome}`
}

/**
 * How giving an existing assistant its missing handle ended, once per assistant per launch
 * (src/matrix/agent-handle-backfill.ts), for main.log. Closed values only: `agent` is the first
 * eight characters of the assistant's principal, as main's other agent lines print it, never the
 * handle, the name or the directory ID.
 *
 * `outcome`: `claimed` (it had none and has one now), `kept` (it already had one: nothing was
 * changed), `refused` (a refusal another try cannot change, `code` says which), `failed` (worth
 * one more try this launch), `limit` (the directory's limit: the walk stops for this launch),
 * `held` (a change of the person's own handle is still waiting: the walk stops without touching it, and
 * the launch's one retry looks again).
 * `attempt`: 1, or 2 for the one retry a launch allows.
 */
export interface MatrixHandleBackfillDiagnostic {
  backfill: 'claimed' | 'kept' | 'refused' | 'failed' | 'limit' | 'held'
  agent: string
  code: MatrixHandleBackfillCode
  attempt: 1 | 2
}

/** `none` on success; otherwise the directory's refusal, or `exhausted` (every candidate taken). */
export type MatrixHandleBackfillCode = 'none' | 'exhausted' | MatrixAliasErrorCode

const BACKFILL_OUTCOMES: ReadonlySet<string> = new Set(['claimed', 'kept', 'refused', 'failed', 'limit', 'held'])

const BACKFILL_CODES: ReadonlySet<string> = new Set([
  'none',
  'authentication',
  'denied',
  'closed',
  'missing',
  'conflict',
  'limit',
  'invalid',
  'unavailable',
  'cancelled',
  'exhausted'
])

const AGENT_PREFIX = /^[A-Za-z0-9-]{1,8}$/

/** Main's reading of a backfill line: exactly these four closed fields, or nothing. */
export function parseMatrixHandleBackfillDiagnostic(value: unknown): MatrixHandleBackfillDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 4 ||
    typeof row.backfill !== 'string' ||
    !BACKFILL_OUTCOMES.has(row.backfill) ||
    typeof row.agent !== 'string' ||
    !AGENT_PREFIX.test(row.agent) ||
    typeof row.code !== 'string' ||
    !BACKFILL_CODES.has(row.code) ||
    (row.attempt !== 1 && row.attempt !== 2)
  ) {
    return undefined
  }

  return {
    backfill: row.backfill,
    agent: row.agent,
    code: row.code,
    attempt: row.attempt
  } as MatrixHandleBackfillDiagnostic
}

/** `[Matrix] handle backfill agent=1a2b3c4d outcome=claimed code=none attempt=1` */
export function formatMatrixHandleBackfillDiagnostic(line: MatrixHandleBackfillDiagnostic): string {
  return `[Matrix] handle backfill agent=${line.agent} outcome=${line.backfill} code=${line.code} attempt=${line.attempt}`
}

/** Anything the window may send on the handle diagnostic channel. */
export type MatrixHandleDiagnostic = MatrixHandleSheetDiagnostic | MatrixHandleBackfillDiagnostic

/** The one main.log line for what the window sent, or undefined for anything else. */
export function formatMatrixHandleDiagnostic(value: unknown): string | undefined {
  const sheet = parseMatrixHandleSheetDiagnostic(value)

  if (sheet) {
    return formatMatrixHandleSheetDiagnostic(sheet)
  }

  const backfill = parseMatrixHandleBackfillDiagnostic(value)

  return backfill ? formatMatrixHandleBackfillDiagnostic(backfill) : undefined
}

/**
 * Check-ins: the default assistant's heartbeat, v1 (plan
 *  §2 and §5 item 4; Hermes's side is
 * cron/check_ins.py). What the owner's devices, the app's main process and the SDK host
 * share: the owner's synced records, the nudge a check-in posts, the brief's times, the
 * cost shown, and the words that turn check-ins off.
 *
 * Three account-data records, each with one kind of writer, so no device's write clobbers
 * another's field:
 * - `settings`: the owner's choices (Settings, the chat's buttons, "stop checking in");
 * - `feedback`: the owner's taps on nudges (less like this, snooze) and when they last
 *   answered one;
 * - `ledger`: the check-ins' own bookkeeping, written only by the Mac that holds the
 *   assistant's answering lease while it claims a check or posts a nudge.
 */

/** Account data types (the owner's, synced to every device). */
export const MATRIX_CHECK_IN_EVENTS = {
  settings: 'io.atum.check_ins',
  feedback: 'io.atum.check_ins.feedback',
  ledger: 'io.atum.check_ins.ledger'
} as const

/** The key of a check-in post's nudge in its event content, beside the cron marker. */
export const MATRIX_CHECK_IN_NUDGE_KEY = 'io.atum.nudge'

/** cron/check_ins.py CHECK_IN_JOB_ID: every Mac's copy of the job has this ID. */
export const MATRIX_CHECK_IN_JOB_ID = 'a7c4ec4e0001'

export const MATRIX_CHECK_IN_KINDS = ['meeting', 'waiting', 'conflict', 'deadline', 'brief'] as const
export const MATRIX_CHECK_IN_SOURCES = ['files', 'memory', 'calendar', 'mail'] as const
export const MATRIX_CHECK_IN_ACTIONS = ['draft', 'prepare', 'review'] as const

export type MatrixCheckInKind = (typeof MATRIX_CHECK_IN_KINDS)[number]
export type MatrixCheckInSource = (typeof MATRIX_CHECK_IN_SOURCES)[number]
export type MatrixCheckInAction = (typeof MATRIX_CHECK_IN_ACTIONS)[number]

/** What a check-in post carries for its card: one line, where it came from, one offer. */
export interface MatrixCheckInNudge {
  kind: MatrixCheckInKind
  key: string
  text: string
  source: MatrixCheckInSource
  ref?: string
  action: MatrixCheckInAction
}

/** The morning brief's times a person can pick. `null` is no brief. */
export const MATRIX_CHECK_IN_BRIEF_TIMES = ['07:00', '07:30', '08:00', '08:30', '09:00', '10:00'] as const
export type MatrixCheckInBriefTime = (typeof MATRIX_CHECK_IN_BRIEF_TIMES)[number]
export const MATRIX_CHECK_IN_DEFAULT_BRIEF: MatrixCheckInBriefTime = '08:00'

export interface MatrixCheckInSettings {
  /** On by default: an account that never chose has check-ins. */
  enabled: boolean
  brief: MatrixCheckInBriefTime | null
  /** When the one-line first-run mention was shown and closed. */
  introducedAt?: number
  /** When and how check-ins were turned off: from Settings, by asking, or after the
   * "Keep these coming?" question. */
  offAt?: number
  offBy?: 'settings' | 'asked' | 'paused'
}

export interface MatrixCheckInSnooze {
  key: string
  until: number
  nudge: MatrixCheckInNudge
}

export interface MatrixCheckInFeedback {
  /** Kinds the owner asked for fewer of ("Less like this"). */
  muted: MatrixCheckInKind[]
  /** Nudges to bring back later ("Snooze"), by the lease holder, without a model call. */
  snoozed: MatrixCheckInSnooze[]
  /** When the owner last answered a nudge (a tap, or a message in the assistant's chat). */
  ackAt: number
}

export interface MatrixCheckInSent {
  key: string
  text: string
  at: number
  /** The run that posted it: a resumed post of the same run is not a repeat. */
  run?: string
}

export interface MatrixCheckInLedger {
  /** The local day the counters belong to (YYYY-MM-DD). */
  day: string
  runs: number
  nudges: number
  /** The local day the morning brief last ran. */
  briefed?: string
  lastRunAt: number
  lastNudgeAt: number
  /** Nudges posted since the owner last answered one. */
  ignored: number
  sent: MatrixCheckInSent[]
  /** Snoozes already brought back, each as `matrixCheckInSnoozeToken` writes it. */
  resurfaced: string[]
}

export interface MatrixCheckInsState {
  settings: MatrixCheckInSettings
  feedback: MatrixCheckInFeedback
  ledger: MatrixCheckInLedger
}

/** The renderer's projection: the synced records, and whether the owner's SDK may write. */
export interface MatrixCheckInsSnapshot extends MatrixCheckInsState {
  writable: boolean
}

/** A change the owner makes to their settings. */
export type MatrixCheckInChange =
  | { field: 'enabled'; value: boolean; by?: 'settings' | 'asked' | 'paused' }
  | { field: 'brief'; value: MatrixCheckInBriefTime | null }
  | { field: 'introduced' }

/** The owner's answer to a nudge. */
export type MatrixCheckInFeedbackChange =
  | { kind: 'less'; nudge: MatrixCheckInKind }
  | { kind: 'snooze'; nudge: MatrixCheckInNudge; until: number }
  | { kind: 'ack' }

export const MATRIX_CHECK_IN_LIMITS = {
  /** Model runs per local day, across every Mac. */
  dailyRuns: 20,
  /** Nudges per local day besides the morning brief. */
  dailyNudges: 3,
  /** Nudges in a row without an answer before they pause and ask. */
  ignoredBeforeAsking: 5,
  /** A check at most this often. */
  checkEveryMs: 60 * 60_000,
  /** Local hours, [start, end): 08:00–22:00 (an earlier brief starts the day earlier). */
  dayStartMinutes: 8 * 60,
  dayEndMinutes: 22 * 60,
  /** The morning brief runs late after a sleeping Mac, but never after noon. */
  briefLatestMinutes: 12 * 60,
  /** The owner's own messages win: nothing within this long after the chat was active. */
  quietAfterActivityMs: 10 * 60_000,
  /** A snoozed nudge comes back after this long. */
  snoozeMs: 3 * 60 * 60_000,
  sentKept: 30,
  snoozedKept: 10,
  resurfacedKept: 20
} as const

// ---------------------------------------------------------------------------
// Cost (owner decision 2026-10-04: charged in Protons, with the cost shown)
// ---------------------------------------------------------------------------

/**
 * The inputs of the cost Settings shows. A check-in is one call on the everyday model
 * (Nguyệt Thực) with no tools, a context capped at 6,000 characters and an answer capped
 * at 1,000 tokens (cron/check_ins.py); this Mac's proxy forwards one call per claimed check
 * (managed-model.ts) and the ledger allows 20 claims a day, so a day can be bounded. Prices
 * mirror the gateway's pinned list prices (atum-platform services/gateway/atum-models.yaml)
 * and the platform's default Protons per US dollar (27,000 VND × 1.5 markup, migration
 * 0109); the gateway settles the real cost per call.
 */
export const MATRIX_CHECK_IN_COST = {
  protonsPerUsd: 40_500,
  inputUsdPerMillion: 0.1,
  outputUsdPerMillion: 0.5,
  /** A typical run: the assistant's persona, the instructions, a few changed files. */
  typical: { input: 2_400, output: 200 },
  /** The most one run can send and get back: the persona, Hermes's own prompt and the
   * instructions (about 2,000 tokens), the context at its cap (6,000 characters, at most a
   * token each, as in Chinese or Japanese), and the answer at its cap. */
  max: { input: 2_000 + 6_000, output: 1_000 },
  /** The morning brief and about two checks with something new. */
  typicalRunsPerDay: 3
} as const

function runProtons(tokens: { input: number; output: number }) {
  const cost = MATRIX_CHECK_IN_COST

  return (
    ((tokens.input * cost.inputUsdPerMillion + tokens.output * cost.outputUsdPerMillion) / 1_000_000) *
    cost.protonsPerUsd
  )
}

/** Whole Protons, in round tens: "≈ 40 a day", and the hard ceiling, "at most 1,060". */
export function matrixCheckInCost(): { perDay: number; atMost: number; perRunMax: number } {
  const typical = runProtons(MATRIX_CHECK_IN_COST.typical) * MATRIX_CHECK_IN_COST.typicalRunsPerDay
  const perRunMax = runProtons(MATRIX_CHECK_IN_COST.max)

  return {
    perDay: Math.max(10, Math.round(typical / 10) * 10),
    atMost: Math.ceil((perRunMax * MATRIX_CHECK_IN_LIMITS.dailyRuns) / 10) * 10,
    perRunMax: Math.ceil(perRunMax)
  }
}

// ---------------------------------------------------------------------------
// Parsing: anything unreadable falls back to defaults, never to a broader setting.
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''

export function isMatrixCheckInBriefTime(value: unknown): value is MatrixCheckInBriefTime {
  return MATRIX_CHECK_IN_BRIEF_TIMES.some(item => item === value)
}

export function parseMatrixCheckInKind(value: unknown): MatrixCheckInKind | undefined {
  return MATRIX_CHECK_IN_KINDS.find(kind => kind === value)
}

export function defaultMatrixCheckInSettings(): MatrixCheckInSettings {
  return { enabled: true, brief: MATRIX_CHECK_IN_DEFAULT_BRIEF }
}

export function emptyMatrixCheckInLedger(): MatrixCheckInLedger {
  return { day: '', runs: 0, nudges: 0, lastRunAt: 0, lastNudgeAt: 0, ignored: 0, sent: [], resurfaced: [] }
}

/** The settings record, or the defaults when there is none (version 1 only). */
export function parseMatrixCheckInSettings(raw: unknown): MatrixCheckInSettings | null {
  if (raw === undefined || raw === null) {
    return defaultMatrixCheckInSettings()
  }

  const row = record(raw)

  if (!row || row.version !== 1) {
    return null
  }

  const offBy = row.offBy === 'settings' || row.offBy === 'asked' || row.offBy === 'paused' ? row.offBy : undefined

  return {
    enabled: row.enabled !== false,
    brief: row.brief === null ? null : isMatrixCheckInBriefTime(row.brief) ? row.brief : MATRIX_CHECK_IN_DEFAULT_BRIEF,
    ...(time(row.introducedAt) !== undefined ? { introducedAt: time(row.introducedAt) } : {}),
    ...(time(row.offAt) !== undefined ? { offAt: time(row.offAt) } : {}),
    ...(offBy ? { offBy } : {})
  }
}

/** A nudge as a check-in post or a snooze carries it; anything else is no nudge. */
export function parseMatrixCheckInNudge(raw: unknown): MatrixCheckInNudge | undefined {
  const row = record(raw)
  const kind = parseMatrixCheckInKind(row?.kind)
  const source = MATRIX_CHECK_IN_SOURCES.find(item => item === row?.source)
  const action = MATRIX_CHECK_IN_ACTIONS.find(item => item === row?.action)
  const line = text(row?.text, 280)
  const key = text(row?.key, 64)

  if (!row || !kind || !source || !action || !line || !/^[a-z0-9-]{1,64}$/.test(key)) {
    return undefined
  }

  const ref = text(row.ref, 80).replace(/[\\/]/g, '')

  return { kind, key, text: line, source, action, ...(ref ? { ref } : {}) }
}

export function parseMatrixCheckInFeedback(raw: unknown): MatrixCheckInFeedback | null {
  if (raw === undefined || raw === null) {
    return { muted: [], snoozed: [], ackAt: 0 }
  }

  const row = record(raw)

  if (!row || row.version !== 1) {
    return null
  }

  const muted = Array.isArray(row.muted)
    ? [...new Set(row.muted.map(parseMatrixCheckInKind).filter((kind): kind is MatrixCheckInKind => Boolean(kind)))]
    : []

  const snoozed = Array.isArray(row.snoozed)
    ? row.snoozed.flatMap(item => {
        const entry = record(item)
        const nudge = parseMatrixCheckInNudge(entry?.nudge)
        const until = time(entry?.until)

        return nudge && until !== undefined ? [{ key: nudge.key, until, nudge }] : []
      })
    : []

  return { muted, snoozed: snoozed.slice(-MATRIX_CHECK_IN_LIMITS.snoozedKept), ackAt: count(row.ackAt) }
}

export function parseMatrixCheckInLedger(raw: unknown): MatrixCheckInLedger | null {
  if (raw === undefined || raw === null) {
    return emptyMatrixCheckInLedger()
  }

  const row = record(raw)

  if (!row || row.version !== 1) {
    return null
  }

  const sent = Array.isArray(row.sent)
    ? row.sent.flatMap(item => {
        const entry = record(item)
        const key = text(entry?.key, 64)
        const at = time(entry?.at)

        return key && at !== undefined
          ? [{ key, text: text(entry?.text, 280), at, ...(typeof entry?.run === 'string' ? { run: entry.run.slice(0, 64) } : {}) }]
          : []
      })
    : []

  const resurfaced = Array.isArray(row.resurfaced)
    ? row.resurfaced.filter((key): key is string => typeof key === 'string').map(key => key.slice(0, 96))
    : []

  return {
    day: typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : '',
    runs: count(row.runs),
    nudges: count(row.nudges),
    ...(typeof row.briefed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.briefed) ? { briefed: row.briefed } : {}),
    lastRunAt: count(row.lastRunAt),
    lastNudgeAt: count(row.lastNudgeAt),
    ignored: count(row.ignored),
    sent: sent.slice(-MATRIX_CHECK_IN_LIMITS.sentKept),
    resurfaced: resurfaced.slice(-MATRIX_CHECK_IN_LIMITS.resurfacedKept)
  }
}

/** Validates an owner change at the IPC boundary. */
export function matrixCheckInChange(value: unknown): MatrixCheckInChange {
  const row = record(value)

  if (row?.field === 'enabled' && typeof row.value === 'boolean') {
    const by = row.by === 'asked' || row.by === 'paused' ? row.by : 'settings'

    return { field: 'enabled', value: row.value, by }
  }

  if (row?.field === 'brief' && (row.value === null || isMatrixCheckInBriefTime(row.value))) {
    return { field: 'brief', value: row.value as MatrixCheckInBriefTime | null }
  }

  if (row?.field === 'introduced') {
    return { field: 'introduced' }
  }

  throw new Error('matrix_check_in_invalid')
}

/** Validates an owner's answer to a nudge at the IPC boundary. */
export function matrixCheckInFeedbackChange(value: unknown): MatrixCheckInFeedbackChange {
  const row = record(value)

  if (row?.kind === 'less') {
    const nudge = parseMatrixCheckInKind(row.nudge)

    if (nudge) {
      return { kind: 'less', nudge }
    }
  }

  if (row?.kind === 'snooze') {
    const nudge = parseMatrixCheckInNudge(row.nudge)
    const until = time(row.until)

    if (nudge && until !== undefined) {
      return { kind: 'snooze', nudge, until }
    }
  }

  if (row?.kind === 'ack') {
    return { kind: 'ack' }
  }

  throw new Error('matrix_check_in_invalid')
}

/** Applies a change to the settings record (the SDK host writes the result). */
export function applyMatrixCheckInChange(
  settings: MatrixCheckInSettings,
  change: MatrixCheckInChange,
  now: number
): MatrixCheckInSettings {
  if (change.field === 'enabled') {
    if (change.value) {
      const { offAt: _offAt, offBy: _offBy, ...rest } = settings

      return { ...rest, enabled: true }
    }

    return { ...settings, enabled: false, offAt: now, offBy: change.by ?? 'settings' }
  }

  if (change.field === 'brief') {
    return { ...settings, brief: change.value }
  }

  return { ...settings, introducedAt: settings.introducedAt ?? now }
}

/** Applies an answer to the feedback record. Every answer counts as answering. */
export function applyMatrixCheckInFeedback(
  feedback: MatrixCheckInFeedback,
  change: MatrixCheckInFeedbackChange,
  now: number
): MatrixCheckInFeedback {
  const answered = { ...feedback, ackAt: Math.max(feedback.ackAt, now) }

  if (change.kind === 'less') {
    return { ...answered, muted: [...new Set([...feedback.muted, change.nudge])] }
  }

  if (change.kind === 'snooze') {
    return {
      ...answered,
      snoozed: [
        ...feedback.snoozed.filter(item => item.key !== change.nudge.key && item.until > now - 48 * 60 * 60_000),
        { key: change.nudge.key, until: change.until, nudge: change.nudge }
      ].slice(-MATRIX_CHECK_IN_LIMITS.snoozedKept)
    }
  }

  return answered
}

/**
 * A snooze as the ledger remembers it came back: the item and the time it was due, so an
 * item snoozed again after it came back comes back again.
 */
export function matrixCheckInSnoozeToken(snooze: Pick<MatrixCheckInSnooze, 'key' | 'until'>): string {
  return `${snooze.key}@${snooze.until}`
}

/** True while check-ins are paused after unanswered nudges, until the owner answers. */
export function matrixCheckInsAsking(state: Pick<MatrixCheckInsState, 'feedback' | 'ledger'>): boolean {
  return (
    state.ledger.ignored >= MATRIX_CHECK_IN_LIMITS.ignoredBeforeAsking && state.feedback.ackAt < state.ledger.lastNudgeAt
  )
}

/**
 * When a snoozed nudge comes back: after `snoozeMs`, inside the day's hours; one that
 * would land after the day ends comes back the next morning.
 */
export function matrixCheckInSnoozeUntil(now: Date, settings: MatrixCheckInSettings): number {
  const until = new Date(now.getTime() + MATRIX_CHECK_IN_LIMITS.snoozeMs)
  const minutes = until.getHours() * 60 + until.getMinutes()

  if (until.toDateString() === now.toDateString() && minutes < MATRIX_CHECK_IN_LIMITS.dayEndMinutes) {
    return until.getTime()
  }

  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const start = matrixCheckInDayStart(settings)
  morning.setHours(Math.floor(start / 60), start % 60, 0, 0)

  return morning.getTime()
}

/** Minutes after midnight for `HH:MM`. */
export function matrixCheckInMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)

  return hours * 60 + minutes
}

/** The day starts at 08:00, or with an earlier brief. */
export function matrixCheckInDayStart(settings: Pick<MatrixCheckInSettings, 'brief'>): number {
  return Math.min(
    MATRIX_CHECK_IN_LIMITS.dayStartMinutes,
    settings.brief ? matrixCheckInMinutes(settings.brief) : MATRIX_CHECK_IN_LIMITS.dayStartMinutes
  )
}

// ---------------------------------------------------------------------------
// "Stop checking in": the owner's words in any of Atum's languages
// ---------------------------------------------------------------------------

/** Lowercase, Vietnamese marks folded (people type with and without them), punctuation
 * and extra spaces gone. */
function folded(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Recompose what the Latin marks left (Japanese voiced kana keep their marks).
      .normalize('NFC')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const STOP_PHRASES: readonly RegExp[] = [
  // English
  /^(please )?(stop|quit) (checking in|the check ins|check ins|nudging me|nudging|the nudges|nudges)( please)?$/,
  /^(please )?(turn|switch) off (the )?(check ins|nudges)( please)?$/,
  /^no more (check ins|nudges)( please)?$/,
  // Vietnamese ("đừng nhắc nữa", "thôi đừng nhắc mình nữa nhé", "tắt nhắc nhở")
  /^(thoi )?(dung|ngung) nhac( (minh|toi|em|anh|chi))?( nua)?( (nhe|nha|di))?$/,
  /^thoi( dung)? nhac( nua)?( (nhe|nha|di))?$/,
  /^tat (nhac nho|check ins?)( (di|nhe|nha))?$/,
  // Japanese
  /^(もう)?(チェックイン|通知|リマインド)(を)?(やめて|止めて|停止して|オフにして)(ください)?$/,
  // Chinese, simplified and traditional
  /^(请|請)?(别|別|不要)(再)?提醒(我)?(了)?$/,
  /^(请|請)?(停止|关闭|關閉)(主动|主動)?提醒(吧)?$/
]

/**
 * Whether a message the owner sent their assistant is asking to stop check-ins. Only a short
 * message that is just that request counts, so "how do I stop checking in at the hotel?"
 * never turns anything off.
 */
export function matrixCheckInStopRequested(body: string): boolean {
  if (typeof body !== 'string' || body.length > 60) {
    return false
  }

  const value = folded(body)

  return value.length > 0 && value.length <= 40 && STOP_PHRASES.some(pattern => pattern.test(value))
}

// ---------------------------------------------------------------------------
// The envelope Hermes delivers (cron/check_ins.py envelope)
// ---------------------------------------------------------------------------

export interface MatrixCheckInEnvelope {
  nudge: MatrixCheckInNudge
  slot: 'check' | 'brief'
  claimedAt: number
  /** A snoozed nudge the app itself brought back: not a repeat, not counted. */
  resurfaced?: boolean
}

export function parseMatrixCheckInEnvelope(text: string): MatrixCheckInEnvelope | undefined {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  const row = record(value)
  const checkIn = record(row?.check_in)
  const nudge = parseMatrixCheckInNudge(checkIn)
  const claimedAt = time(checkIn?.claimed_at)
  const slot = checkIn?.slot === 'brief' ? 'brief' : checkIn?.slot === 'check' ? 'check' : undefined

  if (row?.v !== 1 || !nudge || !claimedAt || !slot || (slot === 'brief') !== (nudge.kind === 'brief')) {
    return undefined
  }

  return { nudge, slot, claimedAt, ...(checkIn?.resurfaced === true ? { resurfaced: true } : {}) }
}

export function matrixCheckInEnvelope(envelope: MatrixCheckInEnvelope): string {
  return JSON.stringify({
    v: 1,
    check_in: {
      ...envelope.nudge,
      slot: envelope.slot,
      claimed_at: envelope.claimedAt,
      ...(envelope.resurfaced ? { resurfaced: true } : {})
    }
  })
}

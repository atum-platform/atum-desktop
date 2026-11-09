import type { DesktopLocale } from '../../shared/desktop-locale'
/**
 * Check-ins, the app's side (plan  §2
 * and §5 item 4; Hermes's side is cron/check_ins.py, the shared records
 * shared/matrix-check-ins.ts).
 *
 * The default assistant's one check-in job ticks in its Hermes every 15 minutes and asks
 * here first (`heartbeat.gate.request`). The app answers from what must agree across the
 * owner's Macs, in the owner's synced records:
 * - on or off, 08:00–22:00 local, the morning brief or an hourly check due (missed
 *   ones coalesce: one check, however long the Mac slept), the daily caps (20 model runs,
 *   3 nudges besides the brief), paused after 5 unanswered nudges;
 * - the owner first: nothing while the assistant is answering or within 10 minutes of the
 *   chat's last activity, and a nudge whose check started before the owner spoke is dropped;
 * - Protons: nothing when the balance cannot pay for a run (the out-of-Protons notice says
 *   the rest);
 * - one Mac: the claim is written only while this Mac holds the assistant's answering
 *   lease, taken on demand when nobody holds it, so two Macs never claim the same check.
 *
 * A nudge Hermes delivers is admitted here again before it is posted (`admit`): not a
 * repeat, under the day's cap, not a muted kind, the owner not in the middle of things.
 * A snoozed nudge comes back from here, without a model call.
 *
 * The owner's setting is the one control. When the owner asks their assistant to stop
 * check-ins in words the app does not catch itself, its cron tool asks here
 * (`heartbeat.off.request`) and they turn off on every Mac; nothing from Hermes turns them on.
 */
import {
  MATRIX_CHECK_IN_LIMITS,
  matrixCheckInDayStart,
  type MatrixCheckInEnvelope,
  type MatrixCheckInLedger,
  matrixCheckInMinutes,
  type MatrixCheckInNudge,
  matrixCheckInsAsking,
  type MatrixCheckInSnooze,
  matrixCheckInSnoozeToken,
  type MatrixCheckInsState,
  parseMatrixCheckInEnvelope
} from '../../shared/matrix-check-ins'

export type MatrixCheckInRefusal =
  | 'unavailable'
  | 'off'
  | 'asking'
  | 'quiet_hours'
  | 'busy'
  | 'recent_activity'
  | 'out_of_protons'
  | 'daily_cap'
  | 'not_due'
  | 'nudge_cap'
  | 'lease_elsewhere'
  | 'unreadable'

export type MatrixCheckInDecision =
  | { run: true; slot: 'brief' | 'check' }
  | { run: false; reason: MatrixCheckInRefusal }
  | { run: false; reason: 'resurface'; snooze: MatrixCheckInSnooze }

/** What the decision needs besides the records: this Mac's view of the owner and wallet. */
export interface MatrixCheckInContext {
  /** The assistant is answering (a turn running or waiting) on this Mac. */
  busy: boolean
  /** When the assistant's chat last had a message, from any device. */
  lastActivity?: number
  /** The balance pays for a run's ceiling (unknown counts as yes: the gateway refuses). */
  canAfford: boolean
  /** False once the platform-owned sweep replaces legacy between-brief checks. */
  betweenBriefChecks?: boolean
}

/** The local day, as the ledger keys its counters. */
export function matrixCheckInDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Local time with its offset, for the check's own words ("Sunday 10:00"). */
export function matrixCheckInLocalTime(now: Date): string {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0')
  const offset = -now.getTimezoneOffset()

  return (
    `${matrixCheckInDay(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:00` +
    `${offset >= 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  )
}

/** The ledger as of `day`: a new day starts its counters again. */
export function rolledMatrixCheckInLedger(ledger: MatrixCheckInLedger, day: string): MatrixCheckInLedger {
  return ledger.day === day ? ledger : { ...ledger, day, runs: 0, nudges: 0 }
}

/** Whether this tick runs, and as what. Pure: the records, the time, this Mac's view. */
export function decideMatrixCheckIn(
  now: Date,
  state: MatrixCheckInsState,
  context: MatrixCheckInContext
): MatrixCheckInDecision {
  const { settings, feedback } = state
  const at = now.getTime()
  const minutes = now.getHours() * 60 + now.getMinutes()

  if (!settings.enabled) {
    return { run: false, reason: 'off' }
  }

  if (matrixCheckInsAsking(state)) {
    return { run: false, reason: 'asking' }
  }

  if (minutes < matrixCheckInDayStart(settings) || minutes >= MATRIX_CHECK_IN_LIMITS.dayEndMinutes) {
    return { run: false, reason: 'quiet_hours' }
  }

  if (context.busy) {
    return { run: false, reason: 'busy' }
  }

  if (context.lastActivity !== undefined && at - context.lastActivity < MATRIX_CHECK_IN_LIMITS.quietAfterActivityMs) {
    return { run: false, reason: 'recent_activity' }
  }

  const day = matrixCheckInDay(now)
  const ledger = rolledMatrixCheckInLedger(state.ledger, day)
  // A snooze the owner asked for comes back first; it costs no model call.
  const snooze = feedback.snoozed.find(
    item => item.until <= at && !ledger.resurfaced.includes(matrixCheckInSnoozeToken(item))
  )

  if (snooze) {
    return { run: false, reason: 'resurface', snooze }
  }

  if (!context.canAfford) {
    return { run: false, reason: 'out_of_protons' }
  }

  if (ledger.runs >= MATRIX_CHECK_IN_LIMITS.dailyRuns) {
    return { run: false, reason: 'daily_cap' }
  }

  if (
    settings.brief &&
    ledger.briefed !== day &&
    minutes >= matrixCheckInMinutes(settings.brief) &&
    minutes < MATRIX_CHECK_IN_LIMITS.briefLatestMinutes
  ) {
    return { run: true, slot: 'brief' }
  }

  // The morning brief remains. Only the legacy hourly nudges are replaced.
  if (context.betweenBriefChecks === false) {
    return { run: false, reason: 'not_due' }
  }

  // One check per hour, however many ticks (or a whole night asleep) came between.
  if (at - ledger.lastRunAt < MATRIX_CHECK_IN_LIMITS.checkEveryMs) {
    return { run: false, reason: 'not_due' }
  }

  if (ledger.nudges >= MATRIX_CHECK_IN_LIMITS.dailyNudges) {
    return { run: false, reason: 'nudge_cap' }
  }

  return { run: true, slot: 'check' }
}

/** The ledger once this Mac has claimed a check. */
export function claimMatrixCheckIn(
  ledger: MatrixCheckInLedger,
  now: Date,
  slot: 'brief' | 'check'
): MatrixCheckInLedger {
  const day = matrixCheckInDay(now)
  const rolled = rolledMatrixCheckInLedger(ledger, day)

  return { ...rolled, runs: rolled.runs + 1, lastRunAt: now.getTime(), ...(slot === 'brief' ? { briefed: day } : {}) }
}

export type MatrixCheckInAdmission =
  | { post: true; ledger: MatrixCheckInLedger }
  | { post: false; reason: 'off' | 'muted' | 'owner_first' | 'repeat' | 'nudge_cap' }

/** Whether a delivered nudge is posted, and the ledger once it is. Pure. */
export function admitMatrixCheckIn(
  state: MatrixCheckInsState,
  envelope: MatrixCheckInEnvelope,
  now: Date,
  run: string,
  context: Pick<MatrixCheckInContext, 'busy' | 'lastActivity'>
): MatrixCheckInAdmission {
  const { settings, feedback } = state
  const { nudge } = envelope
  const at = now.getTime()

  if (!settings.enabled) {
    return { post: false, reason: 'off' }
  }

  if (feedback.muted.includes(nudge.kind)) {
    return { post: false, reason: 'muted' }
  }

  // The owner's own messages always win: a check that started before they spoke is stale.
  if (context.busy || (context.lastActivity !== undefined && context.lastActivity > envelope.claimedAt)) {
    return { post: false, reason: 'owner_first' }
  }

  const ledger = rolledMatrixCheckInLedger(state.ledger, matrixCheckInDay(now))

  if (!envelope.resurfaced) {
    const text = nudge.text.trim().toLowerCase()

    // The same run's post again (a resumed delivery) is not a repeat.
    if (
      ledger.sent.some(
        item =>
          (item.key === nudge.key && item.run !== run) || (item.run !== run && item.text.trim().toLowerCase() === text)
      )
    ) {
      return { post: false, reason: 'repeat' }
    }

    if (envelope.slot === 'check' && ledger.nudges >= MATRIX_CHECK_IN_LIMITS.dailyNudges) {
      return { post: false, reason: 'nudge_cap' }
    }
  }

  const resumed = ledger.sent.some(item => item.key === nudge.key && item.run === run)

  if (resumed) {
    return { post: true, ledger }
  }

  return {
    post: true,
    ledger: {
      ...ledger,
      nudges: ledger.nudges + (envelope.slot === 'check' && !envelope.resurfaced ? 1 : 0),
      lastNudgeAt: at,
      // Unanswered in a row: the owner answered since the last one, so this one starts again.
      ignored: feedback.ackAt >= ledger.lastNudgeAt ? 1 : ledger.ignored + 1,
      sent: envelope.resurfaced
        ? ledger.sent
        : [...ledger.sent.filter(item => item.key !== nudge.key), { key: nudge.key, text: nudge.text, at, run }].slice(
            -MATRIX_CHECK_IN_LIMITS.sentKept
          )
    }
  }
}

/** Whether check-ins can run for the default assistant on this Mac at all. */
export type MatrixCheckInAvailability =
  | { ok: true; locale: DesktopLocale; watched: string[]; model: string }
  | { ok: false }

/** The answering lease for a short critical section. */
export interface MatrixCheckInLeaseHold {
  /** Still held: a lapse or a revocation since `hold` fences the write. */
  held(): boolean
  release(): void
}

export interface MatrixCheckInsDeps {
  available(): MatrixCheckInAvailability
  /** The owner's records from sync: cheap refusals before any network. */
  cached(): MatrixCheckInsState | undefined
  context(): MatrixCheckInContext
  /** Takes the lease on demand when nobody holds it; null when another Mac answers. */
  hold(): Promise<MatrixCheckInLeaseHold | null>
  /** The records fresh from the server, never the sync cache. */
  read(): Promise<MatrixCheckInsState>
  writeLedger(ledger: MatrixCheckInLedger): Promise<void>
  /** Posts a snoozed nudge again, as the assistant, without a model call. */
  resurface(snooze: MatrixCheckInSnooze, claimedAt: number): Promise<void>
  /** Turns check-ins off in the owner's settings, on every Mac: the owner asked their
   * assistant to stop them, in words the app does not catch itself. True once off. */
  turnOff(): Promise<boolean>
  now?(): number
  log(line: string): void
}

/** The answer Hermes reads (cron/check_ins.py parse_gate). */
export type MatrixCheckInGateAnswer =
  | { run: false; reason: string }
  | {
      run: true
      slot: 'brief' | 'check'
      claimed_at: number
      since: number
      day: string
      locale: DesktopLocale
      /** The default assistant's active model: Atum's check-in alias or its connected model. */
      model: string
      now_local: string
      sent: { key: string; text: string }[]
      muted: string[]
      nudges_left: number
      watched: string[]
      /** New Gmail and Calendar items, once the assistant can use Google (G2-08). */
      signals: string[]
    }

export interface MatrixCheckInGateway {
  on(type: string, handler: (event: { payload?: unknown }) => void): () => void
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

/** How long the model call of a check this Mac claimed stays open (a check's call follows its
 * claim within seconds; the window only bounds a lost one). */
export const MATRIX_CHECK_IN_CALL_WINDOW_MS = 10 * 60_000

export class MatrixCheckIns {
  /** One claim or admission at a time on this Mac; the lease orders them across Macs. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The one model call each check this Mac claimed may make: its claim time, open until. */
  private readonly calls = new Map<number, number>()

  constructor(private readonly deps: MatrixCheckInsDeps) {}

  private now(): Date {
    return new Date(this.deps.now?.() ?? Date.now())
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})

    return next
  }

  /** Answers one tick: claims a check in the shared ledger, or says why not. */
  gate(): Promise<MatrixCheckInGateAnswer> {
    return this.serial(() => this.claim())
  }

  /**
   * Takes the model call of a check this Mac claimed, once. The loopback proxy asks before it
   * forwards a check-in request (managed-model.ts) and answers any other with silence, so a
   * check costs at most one call: the cost Settings shows is a ceiling, not an estimate.
   */
  takeCall(): boolean {
    const now = this.now().getTime()

    for (const [claim, until] of this.calls) {
      if (until <= now) {
        this.calls.delete(claim)
      }
    }

    const [claim] = this.calls.keys()

    if (claim === undefined) {
      return false
    }

    this.calls.delete(claim)

    return true
  }

  private async claim(): Promise<MatrixCheckInGateAnswer> {
    const available = this.deps.available()

    if (!available.ok) {
      return { run: false, reason: 'unavailable' }
    }

    // Most ticks end here, from the synced records, with no network at all.
    const cached = this.deps.cached()

    if (cached) {
      const early = decideMatrixCheckIn(this.now(), cached, this.deps.context())

      if (early.run === false && early.reason !== 'resurface') {
        return { run: false, reason: early.reason }
      }
    }

    const lease = await this.deps.hold()

    if (!lease) {
      return { run: false, reason: 'lease_elsewhere' }
    }

    try {
      let state: MatrixCheckInsState

      try {
        state = await this.deps.read()
      } catch {
        return { run: false, reason: 'unreadable' }
      }

      const now = this.now()
      const decision = decideMatrixCheckIn(now, state, this.deps.context())

      if (!lease.held()) {
        return { run: false, reason: 'lease_elsewhere' }
      }

      if (decision.run === false && decision.reason === 'resurface') {
        const ledger = rolledMatrixCheckInLedger(state.ledger, matrixCheckInDay(now))

        await this.deps.writeLedger({
          ...ledger,
          resurfaced: [...ledger.resurfaced, matrixCheckInSnoozeToken(decision.snooze)].slice(
            -MATRIX_CHECK_IN_LIMITS.resurfacedKept
          )
        })
        this.deps.log(`[Matrix] check-in snooze due key=${decision.snooze.key.slice(0, 16)}`)
        // Posted after the lease is let go, outside this critical section.
        setImmediate(() => {
          void this.deps.resurface(decision.snooze, now.getTime()).catch(() => {
            this.deps.log('[Matrix] check-in snooze not posted')
          })
        })

        return { run: false, reason: 'resurface' }
      }

      if (decision.run === false) {
        return { run: false, reason: decision.reason }
      }

      await this.deps.writeLedger(claimMatrixCheckIn(state.ledger, now, decision.slot))
      const ledger = rolledMatrixCheckInLedger(state.ledger, matrixCheckInDay(now))
      this.calls.set(now.getTime(), now.getTime() + MATRIX_CHECK_IN_CALL_WINDOW_MS)
      this.deps.log(`[Matrix] check-in claimed slot=${decision.slot} run=${ledger.runs + 1}`)

      return {
        run: true,
        slot: decision.slot,
        claimed_at: now.getTime(),
        since: state.ledger.lastRunAt,
        day: matrixCheckInDay(now),
        locale: available.locale,
        model: available.model,
        now_local: matrixCheckInLocalTime(now),
        sent: ledger.sent.slice(-20).map(item => ({ key: item.key, text: item.text })),
        muted: [...state.feedback.muted],
        nudges_left: Math.max(0, MATRIX_CHECK_IN_LIMITS.dailyNudges - ledger.nudges),
        watched: available.watched,
        signals: []
      }
    } finally {
      lease.release()
    }
  }

  /**
   * A delivered check-in, admitted again before it is posted: the nudge to post, or why
   * not. The ledger records it first, so a crash between the two under-notifies.
   */
  admit(text: string, run: string): Promise<{ nudge: MatrixCheckInNudge } | { drop: string }> {
    return this.serial(async () => {
      const envelope = parseMatrixCheckInEnvelope(text)

      if (!envelope) {
        return { drop: 'malformed' }
      }

      const lease = await this.deps.hold()

      if (!lease) {
        return { drop: 'lease_elsewhere' }
      }

      try {
        const state = await this.deps.read()
        const admission = admitMatrixCheckIn(state, envelope, this.now(), run, this.deps.context())

        if (admission.post === false) {
          return { drop: admission.reason }
        }

        if (!lease.held()) {
          return { drop: 'lease_elsewhere' }
        }

        if (admission.ledger !== state.ledger) {
          await this.deps.writeLedger(admission.ledger)
        }

        return { nudge: envelope.nudge }
      } catch {
        return { drop: 'unreadable' }
      } finally {
        lease.release()
      }
    })
  }

  /** Answers every gate request on one backend connection until the returned stop. */
  listen(gateway: MatrixCheckInGateway): () => void {
    const offGate = gateway.on('heartbeat.gate.request', event => {
      const requestId = checkInRequestId(event.payload)

      if (!requestId) {
        return
      }

      void this.gate()
        .catch((): MatrixCheckInGateAnswer => ({ run: false, reason: 'unavailable' }))
        .then(answer => {
          if (answer.run === false && answer.reason !== 'not_due' && answer.reason !== 'quiet_hours') {
            this.deps.log(`[Matrix] check-in declined reason=${answer.reason}`)
          }

          return gateway.request(
            'heartbeat.gate.respond',
            { request_id: requestId, result: JSON.stringify(answer) },
            10_000
          )
        })
        .catch(() => this.deps.log('[Matrix] check-in gate answer not acknowledged'))
    })

    const offSettled = gateway.on('heartbeat.settled', event => {
      const { outcome, claimed_at: claimedAt } = (event.payload ?? {}) as { outcome?: unknown; claimed_at?: unknown }

      // Settled: a call it did not make (nothing new, the cap) is not left open.
      if (typeof claimedAt === 'number') {
        this.calls.delete(claimedAt)
      }

      if (typeof outcome === 'string' && /^[a-z_]{1,20}$/.test(outcome)) {
        this.deps.log(`[Matrix] check-in settled outcome=${outcome}`)
      }
    })

    // The assistant's cron tool, aimed at the check-in job (cron/check_ins.py
    // manage_from_tool): the owner asked it to stop check-ins. Only ever off, never on.
    const offAsked = gateway.on('heartbeat.off.request', event => {
      const requestId = checkInRequestId(event.payload)

      if (!requestId) {
        return
      }

      void this.deps
        .turnOff()
        .catch(() => false)
        .then(off => {
          this.deps.log(`[Matrix] check-ins off from the assistant ok=${off}`)

          return gateway.request(
            'heartbeat.off.respond',
            { request_id: requestId, result: JSON.stringify({ off }) },
            10_000
          )
        })
        .catch(() => this.deps.log('[Matrix] check-ins off answer not acknowledged'))
    })

    return () => {
      offGate()
      offSettled()
      offAsked()
    }
  }
}

/** A host request's ID from Hermes (`_host_request`), or nothing when malformed. */
function checkInRequestId(payload: unknown): string | undefined {
  const requestId = (payload as { request_id?: unknown } | undefined)?.request_id

  return typeof requestId === 'string' && /^(?:[\da-f]{1,64}|srq-[\da-f]{12})$/.test(requestId) ? requestId : undefined
}

/** Another agent's backend: its job (if it ever had one) is always declined, and it never
 * changes the default assistant's check-ins. */
export function refuseMatrixCheckIns(gateway: MatrixCheckInGateway): () => void {
  const refuse = (type: string, respond: string, result: unknown) =>
    gateway.on(type, event => {
      const requestId = checkInRequestId(event.payload)

      if (requestId) {
        void gateway.request(respond, { request_id: requestId, result: JSON.stringify(result) }, 10_000).catch(() => {})
      }
    })

  const offGate = refuse('heartbeat.gate.request', 'heartbeat.gate.respond', { run: false, reason: 'unavailable' })
  const offAsked = refuse('heartbeat.off.request', 'heartbeat.off.respond', { off: false })

  return () => {
    offGate()
    offAsked()
  }
}

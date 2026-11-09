import { type MatrixClient, Method } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  applyMatrixCheckInChange,
  applyMatrixCheckInFeedback,
  defaultMatrixCheckInSettings,
  emptyMatrixCheckInLedger,
  MATRIX_CHECK_IN_EVENTS,
  type MatrixCheckInChange,
  type MatrixCheckInFeedbackChange,
  type MatrixCheckInLedger,
  type MatrixCheckInsSnapshot,
  type MatrixCheckInsState,
  parseMatrixCheckInFeedback,
  parseMatrixCheckInLedger,
  parseMatrixCheckInSettings
} from '../../shared/matrix-check-ins'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.check_ins': Record<string, unknown>
    'io.atum.check_ins.feedback': Record<string, unknown>
    'io.atum.check_ins.ledger': Record<string, unknown>
  }
}

type CheckInEvent = (typeof MATRIX_CHECK_IN_EVENTS)[keyof typeof MATRIX_CHECK_IN_EVENTS]

/**
 * Check-ins' records in the owner's account data (shared/matrix-check-ins.ts), through the
 * real human SDK. Sync feeds the window; every write first reads the record fresh from the
 * server, so a device whose last sync is behind never writes an older record back, and a
 * newer schema is refused rather than overwritten.
 */
export function matrixCheckIns(client: MatrixClient, identity: MatrixIdentity, active: () => boolean, now: () => number = Date.now) {
  const busy = new Set<CheckInEvent>()

  const fresh = (type: CheckInEvent) =>
    client.http
      .authedRequest<unknown>(Method.Get, `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`)
      .catch(error => {
        if (error?.errcode === 'M_NOT_FOUND') {
          return undefined
        }

        throw error
      })

  const live = () => active() && client.getUserId() === identity.userId

  const owner = (input: MatrixIdentity) => {
    if (!live() || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
      throw new Error('matrix_check_in_stale')
    }
  }

  async function update<T>(
    type: CheckInEvent,
    parse: (raw: unknown) => T | null,
    change: (current: T) => T
  ): Promise<void> {
    if (busy.has(type)) {
      throw new Error('matrix_check_in_pending')
    }

    busy.add(type)

    try {
      const current = parse(await fresh(type))

      if (current === null) {
        throw new Error('matrix_check_in_readonly')
      }

      if (!live()) {
        throw new Error('matrix_check_in_stale')
      }

      // An HTTP acknowledgement, never an optimistic cache write: sync brings it back.
      await client.setAccountDataRaw(type, { ...change(current), version: 1 })
    } finally {
      busy.delete(type)
    }
  }

  return {
    /** The window's view, from sync. Unreadable records show defaults and are not writable. */
    snapshot(ready: boolean): MatrixCheckInsSnapshot {
      const cached = (type: CheckInEvent) => client.getAccountData(type)?.getContent()
      const settings = parseMatrixCheckInSettings(cached(MATRIX_CHECK_IN_EVENTS.settings))
      const feedback = parseMatrixCheckInFeedback(cached(MATRIX_CHECK_IN_EVENTS.feedback))
      const ledger = parseMatrixCheckInLedger(cached(MATRIX_CHECK_IN_EVENTS.ledger))

      return {
        settings: settings ?? defaultMatrixCheckInSettings(),
        feedback: feedback ?? { muted: [], snoozed: [], ackAt: 0 },
        ledger: ledger ?? emptyMatrixCheckInLedger(),
        writable: ready && settings !== null && feedback !== null && ledger !== null
      }
    },

    /** All three records fresh from the server (main's gate, while it holds the lease). */
    async read(): Promise<MatrixCheckInsState> {
      if (!live()) {
        throw new Error('matrix_check_in_stale')
      }

      const [settings, feedback, ledger] = await Promise.all([
        fresh(MATRIX_CHECK_IN_EVENTS.settings).then(parseMatrixCheckInSettings),
        fresh(MATRIX_CHECK_IN_EVENTS.feedback).then(parseMatrixCheckInFeedback),
        fresh(MATRIX_CHECK_IN_EVENTS.ledger).then(parseMatrixCheckInLedger)
      ])

      if (!settings || !feedback || !ledger) {
        throw new Error('matrix_check_in_readonly')
      }

      return { settings, feedback, ledger }
    },

    /** The ledger, written only by main while this Mac holds the answering lease. */
    async writeLedger(ledger: MatrixCheckInLedger): Promise<void> {
      const value = parseMatrixCheckInLedger({ ...ledger, version: 1 })

      if (!value || !live()) {
        throw new Error('matrix_check_in_invalid')
      }

      await update(MATRIX_CHECK_IN_EVENTS.ledger, parseMatrixCheckInLedger, () => value)
    },

    async change(input: { identity: MatrixIdentity; change: MatrixCheckInChange }): Promise<void> {
      owner(input.identity)

      return update(MATRIX_CHECK_IN_EVENTS.settings, parseMatrixCheckInSettings, current =>
        applyMatrixCheckInChange(current, input.change, now())
      )
    },

    async feedback(input: { identity: MatrixIdentity; feedback: MatrixCheckInFeedbackChange }): Promise<void> {
      owner(input.identity)

      return update(MATRIX_CHECK_IN_EVENTS.feedback, parseMatrixCheckInFeedback, current =>
        applyMatrixCheckInFeedback(current, input.feedback, now())
      )
    }
  }
}

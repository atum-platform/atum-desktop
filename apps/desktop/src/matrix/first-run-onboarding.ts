import { ClientEvent, type MatrixClient, Method } from 'matrix-js-sdk'

import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import { createMatrixSyncHealth, matrixSyncedAfter } from '../../shared/matrix-sync-health'

/**
 * The first run's answer (golden path §3 step 1), as account data: whether the person let
 * the assistant look through their folders or said not now, on any device. One versioned
 * record (`{ v: 1, folders: 'allowed' | 'declined', at }`), written once through the real
 * human SDK; the first answer stands, and any record at all counts as an answer.
 */
export const MATRIX_FIRST_RUN_MARKER = 'io.atum.onboarding.first_run'

/**
 * Whether the primary assistant's welcome is on offer to the account, on
 * every device (conversational first run): a second record, separate from the folder answer above
 * so that answer keeps its meaning for older builds. `{ v: 2, state, at }`:
 *
 * - `open`: main's first evaluation found a new account (no folder answer, no dialogue with its
 *   primary: shared/matrix-first-run-eligibility.ts).
 * - `done`: the first evaluation found an account that already has a
 *   folder answer or talks to its assistant, so the welcome never shows above its history.
 * - `dismissed`: retained for an older first-run surface.
 *
 * A terminal record (`done`, `dismissed`) is never replaced, `open` only gives way to one, and a record
 * this build cannot read is read as `done`: never offered again.
 */
export const MATRIX_FIRST_RUN_WELCOME = 'io.atum.onboarding.first_run.v2'

type WelcomeRecord = 'open' | 'done' | 'dismissed'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.onboarding.first_run': Record<string, unknown>
    'io.atum.onboarding.first_run.v2': Record<string, unknown>
  }
}

function readWelcome(content: unknown): WelcomeRecord {
  const record = content as { v?: unknown; state?: unknown } | null | undefined

  return record?.v === 2 && (record.state === 'open' || record.state === 'done' || record.state === 'dismissed')
    ? record.state
    : 'done'
}

export function matrixFirstRunOnboarding(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  changed: () => void,
  now: () => number = Date.now
) {
  let synced = false
  let stopped = false
  let answered = false
  // The welcome's own record, as this device wrote or read it, so the window follows its own write
  // before the account data echoes back. A terminal record is final.
  let welcomeKnown: WelcomeRecord | undefined
  let pending: Promise<void> | undefined
  let pendingWelcome: Promise<void> | undefined

  const live = () =>
    !stopped && active() && client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId

  function snapshot(): NonNullable<MatrixSnapshot['firstRunMarker']> {
    if (!live() || !synced) {
      return 'unknown'
    }

    if (answered) {
      return 'answered'
    }

    try {
      const event = client.getAccountData(MATRIX_FIRST_RUN_MARKER)

      if (!event) {
        return 'unseen'
      }

      // A record this build cannot read is someone's answer all the same: never offer again.
      answered = true

      return 'answered'
    } catch {
      return 'unknown'
    }
  }

  function welcome(): NonNullable<MatrixSnapshot['firstRunWelcome']> {
    if (!live() || !synced) {
      return 'unknown'
    }

    if (welcomeKnown === 'done' || welcomeKnown === 'dismissed') {
      return welcomeKnown
    }

    try {
      const event = client.getAccountData(MATRIX_FIRST_RUN_WELCOME)

      if (!event) {
        return welcomeKnown ?? 'unseen'
      }

      const state = readWelcome(event.getContent())
      welcomeKnown = state

      return state
    } catch {
      return 'unknown'
    }
  }

  // Known after a real sync, and a reconnecting one does not unmake it (matrix-sync-health.ts);
  // an outage that outlasts its grace does, by timer, since no sync event says so.
  const health = createMatrixSyncHealth({
    onChange: next => {
      if (next === 'offline' && synced && !stopped) {
        synced = false
        changed()
      }
    }
  })

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    synced = matrixSyncedAfter(synced, state, health.observe(state, data))
    changed()
  }

  client.on(ClientEvent.Sync, sync)

  /** The record as the server has it now (another device may have written since this one synced). */
  async function serverRecord(type: string): Promise<unknown> {
    return client.http
      .authedRequest<unknown>(
        Method.Get,
        `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`
      )
      .catch(error => {
        if (error?.errcode === 'M_NOT_FOUND') {
          return undefined
        }

        throw error
      })
  }

  function timestamp(): number {
    const at = now()

    if (!Number.isSafeInteger(at) || at < 0) {
      throw new Error('matrix_first_run_unavailable')
    }

    return at
  }

  async function write(input: MatrixIdentity, folders: 'allowed' | 'declined') {
    if (!live() || !synced || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
      throw new Error('matrix_first_run_stale')
    }

    // Another device may have answered since this one synced: its answer stands.
    const raw = await serverRecord(MATRIX_FIRST_RUN_MARKER)

    if (!live() || !synced) {
      throw new Error('matrix_first_run_stale')
    }

    // Any record already there is an answer (a newer build's included): it is never replaced.
    if (raw === undefined) {
      await client.setAccountDataRaw(MATRIX_FIRST_RUN_MARKER, { v: 1, folders, at: timestamp() })

      if (!live() || !synced) {
        throw new Error('matrix_first_run_stale')
      }
    }

    // A successful HTTP receipt (or an answer already there), not an optimistic cache write.
    answered = true
    changed()
  }

  // `evaluation` (settle) only ever writes the first record: another device's `open` stands, so a Mac
  // that judges the account differently cannot close a welcome mid-first-exchange. Only the person's
  // own answer (`answer`) moves `open` to a terminal state.
  async function writeWelcome(input: MatrixIdentity, next: WelcomeRecord, evaluation = false) {
    if (!live() || !synced || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
      throw new Error('matrix_first_run_stale')
    }

    const raw = await serverRecord(MATRIX_FIRST_RUN_WELCOME)

    if (!live() || !synced) {
      throw new Error('matrix_first_run_stale')
    }

    const current = raw === undefined ? undefined : readWelcome(raw)
    // What is there stands: a terminal record is never replaced, and `open` only yields to one.
    const replace = current === undefined || (!evaluation && current === 'open' && next !== 'open')

    if (replace) {
      await client.setAccountDataRaw(MATRIX_FIRST_RUN_WELCOME, { v: 2, state: next, at: timestamp() })

      if (!live() || !synced) {
        throw new Error('matrix_first_run_stale')
      }
    }

    if (welcomeKnown !== 'done' && welcomeKnown !== 'dismissed') {
      welcomeKnown = replace ? next : current
    }

    changed()
  }

  return {
    snapshot,
    welcome,
    answer(
      input: MatrixIdentity,
      folders: 'allowed' | 'declined',
      ending: 'done' | 'dismissed' = 'dismissed'
    ): Promise<void> {
      if (!live() || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
        return Promise.reject(new Error('matrix_first_run_stale'))
      }

      if (folders !== 'allowed' && folders !== 'declined') {
        return Promise.reject(new Error('matrix_first_run_invalid'))
      }

      if (ending !== 'done' && ending !== 'dismissed') {
        return Promise.reject(new Error('matrix_first_run_invalid'))
      }

      if (snapshot() === 'answered' && (welcome() === 'done' || welcome() === 'dismissed')) {
        return Promise.resolve()
      }

      if (snapshot() !== 'unseen' && snapshot() !== 'answered') {
        return Promise.reject(new Error('matrix_first_run_unavailable'))
      }

      // The folder answer first: it is the record every reader has (older Macs, the phone, this
      // build's place rule), so a failure between the two writes can leave nothing worse than a
      // welcome still marked `open` that no one offers (the place rule needs the folder answer
      // unanswered). Each step keeps what is already there, so a retry repeats nothing.
      pending ??= (async () => {
        await write(input, folders)
        await writeWelcome(input, ending)
      })().finally(() => {
        pending = undefined
      })

      return pending
    },
    /**
     * The welcome's first evaluation, written once for an account nobody has evaluated: `open`
     * (a new account) or `done` (one that already has a folder answer or talks to its primary).
     * A record that is already there, from any device, stands.
     */
    settle(input: MatrixIdentity, state: 'open' | 'done'): Promise<void> {
      if (!live() || input.userId !== identity.userId || input.deviceId !== identity.deviceId) {
        return Promise.reject(new Error('matrix_first_run_stale'))
      }

      if (state !== 'open' && state !== 'done') {
        return Promise.reject(new Error('matrix_first_run_invalid'))
      }

      if (welcome() !== 'unseen') {
        return welcome() === 'unknown'
          ? Promise.reject(new Error('matrix_first_run_unavailable'))
          : Promise.resolve()
      }

      pendingWelcome ??= writeWelcome(input, state, true).finally(() => {
        pendingWelcome = undefined
      })

      return pendingWelcome
    },
    stop() {
      stopped = true
      synced = false
      health.dispose()
      client.off(ClientEvent.Sync, sync)
    }
  }
}

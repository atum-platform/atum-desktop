import type { MatrixRefreshResult, MatrixSnapshot } from '../../shared/matrix'

/**
 * What main does once the sign-in server has answered about the person's chat sign-in
 * . One rule throughout: only the sign-in server
 * refusing this Mac's grant ends the session. A full disk, the network, the Atum account or a
 * Google fence never do; a homeserver refusing a token is a question for the sign-in server,
 * not an answer.
 */

/** A token refused again within this long after an automatic restart is not retried. */
export const MATRIX_SESSION_RESTART_MS = 60_000

export type MatrixSessionAction =
  /** Nothing changes: the engine took a new token, or asks again by itself. */
  | 'none'
  /** The session is over: the compact sign-in, saying so (matrixSessionEndedSnapshot), never
   * the Try again screen, which could never work. Nothing is revoked or forgotten. */
  | 'session_ended'
  /** Main asked because the homeserver refused the token, and got a new token or no answer:
   * the engine stopped on that refusal, so it starts again (and keeps asking by itself). */
  | 'restart'
  /** The same, refused again right after a restart: stop there (Try again, or feedback). */
  | 'stopped'
  /** Main asked, and the sign-in server's new token could not be saved: this Mac's disk is
   * full even for the room kept for it. Restarting can't help; the window says so
   * (`matrix_disk_full`) and the engine starts again by itself once a save lands. */
  | 'disk_full'

/**
 * `asked`: the engine's own refresh (`engine`), or main's question after the homeserver refused
 * the engine's token (`main`). `lastRestart`: when main last restarted the engine for that.
 */
export function matrixSessionAction(
  result: MatrixRefreshResult,
  asked: 'engine' | 'main',
  lastRestart?: number,
  now = Date.now()
): MatrixSessionAction {
  if (result.ok === false && result.cause === 'session_ended') {
    return 'session_ended'
  }

  // An old engine, or a sign-in or sign-out in progress: main's own operation owns the window.
  if (asked === 'engine' || (result.ok === false && result.reauthenticate)) {
    return 'none'
  }

  if (result.ok === false && result.cause === 'disk_full') {
    return 'disk_full'
  }

  return lastRestart !== undefined && now - lastRestart < MATRIX_SESSION_RESTART_MS ? 'stopped' : 'restart'
}

/** The window for an ended session: no account open, the compact sign-in with its notice. */
export function matrixSessionEndedSnapshot(current: MatrixSnapshot): MatrixSnapshot {
  return {
    ...current,
    state: 'signed_out',
    identity: null,
    rooms: [],
    roomId: null,
    messages: [],
    error: 'matrix_session_ended'
  }
}

/** The person's engine says the homeserver refused its token (sdk.ts, `M_UNKNOWN_TOKEN`). */
export function matrixChatTokenRefused(snapshot: Pick<MatrixSnapshot, 'error' | 'state'>): boolean {
  return snapshot.state === 'error' && snapshot.error === 'matrix_signed_out'
}

/**
 * What waits for a command that holds main (`operation`: a sign-in, a sign-out, an app's chat or
 * message). A refused chat token that arrives meanwhile is never dropped: it is checked once
 * the command ends, if the engine that reported it is still the person's. Dropping it left the
 * window on that refusal for good, since main ignores the engine's later snapshots while it
 * shows one (pass 4, MEDIUM 3). A rotation saved meanwhile (`renewed`) restarts a stopped
 * engine the same way, once the command ends.
 */
export function matrixSessionChecks<Host>(options: {
  busy(): boolean
  /** The person's engine now, or undefined when there is none (closing, signed out). */
  current(): Host | undefined
  check(host: Host): void
  resume(): void
}) {
  let pending: Host | undefined
  let resume = false

  return {
    /** The engine `host` reported its token refused. */
    refused(host: Host) {
      if (options.busy()) {
        pending = host
      } else {
        options.check(host)
      }
    },
    /** A rotation the vault could not keep is saved now. */
    renewed() {
      if (options.busy()) {
        resume = true
      } else {
        options.resume()
      }
    },
    /** The command that held main has ended. */
    released() {
      const host = pending
      const resuming = resume
      pending = undefined
      resume = false

      if (options.busy()) {
        return
      }

      if (host !== undefined && host === options.current()) {
        options.check(host)
      } else if (resuming) {
        options.resume()
      }
    }
  }
}

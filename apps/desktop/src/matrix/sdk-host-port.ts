import type {
  MatrixInvocationHint,
  MatrixNotificationHint,
  MatrixRefreshResult,
  MatrixSdkCommand,
  MatrixSdkConfiguration,
  MatrixSnapshot
} from '../../shared/matrix'
import type { MatrixGoogleFenceObservation } from '../../shared/matrix-google-fence'
import type { MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'

import type { MatrixAppBotEvent } from './sdk-app-bot'

/**
 * The Matrix SDK's host seam (plan G8-36): what one SDK engine (sdk.ts) needs from whoever
 * runs it. Three hosts share it:
 * - **the desktop:** a hidden, sandboxed window whose preload bridges this port to the main
 *   process over IPC (`window.matrixSdkHost`, electron/matrix/sdk-preload.ts, served by
 *   sdk-entry.ts);
 * - **a browser client:** the page, or a worker, hosts the SDK for its own controller;
 * - **a headless executor:** a trusted server process hosts an agent's SDK.
 *
 * The host owns identity and custody. It supplies the account and device (the SDK never
 * chooses its own) and refreshes tokens; the SDK owns rooms, devices and end-to-end
 * encryption. The same values cross on every host: closed-code snapshots, invocation hints,
 * and commands by id with a result each. Nothing raw crosses: a failed command reports one of
 * Atum's own closed codes, or `matrix_operation_failed` (sdk-error-code.ts).
 *
 * sdk-host-serve.ts runs an engine behind a port, and sdk-host-queue.ts is the host's side:
 * the command queue the desktop's main process uses, and an in-process pairing for hosts
 * without IPC.
 */
export interface MatrixSdkHostPort {
  /** The host's account and device: the only identity this SDK may use. */
  configuration(): Promise<MatrixSdkConfiguration>
  /** A new access token through the host's own custody of the refresh token. */
  refresh(handle: string): Promise<MatrixRefreshResult>
  /** The SDK's current state, after every change that matters to the host. Called from the
   * SDK's own event handling, like `invocation`: it returns at once and never throws. */
  snapshot(value: MatrixSnapshot): void
  /** An event in a watched room that may be an invocation; a hint only, which the host
   * re-reads through the SDK before acting on it. */
  invocation(value: MatrixInvocationHint): void
  /** Identifier-only event hint for the app-bot runtime. The host must re-read it before use. */
  appBotEvent?(value: MatrixAppBotEvent): void
  /** Optional for headless hosts: a desktop alert is not execution authority. */
  notification?(value: MatrixNotificationHint): void
  /** Owner account-data control, separate from display snapshots. Native hosts
   * authenticate the human SDK sender before applying this sticky notice. */
  googleFence?(value: MatrixGoogleFenceObservation): void
  /** Optional: a message this SDK could not decrypt, its room and the SDK's reason only, for
   * the host's diagnostics (shared/matrix-undecryptable.ts). Never content or authority. */
  undecryptable?(value: MatrixUndecryptableObservation): void
  /** The one listener for the host's commands (one port serves one SDK); `stop` ends it. */
  commands(listener: (id: string, command: MatrixSdkHostCommand) => void): void
  /** The outcome of the command with this id. */
  result(id: string, ok: boolean, value: unknown): void
}

/**
 * What a host may ask of its SDK: any SDK command, to stop, or to take a renewed token.
 * - `renewed`: the host renewed this device's credential ahead of its expiry (an agent's
 *   executor session: a new token for the same session and device). The SDK asks `refresh`
 *   at once, with its refresh handle, rather than waiting for the server to refuse the old
 *   token. No credential crosses in the command itself. Its result is whether the SDK took
 *   a new token; an SDK without a refresh handle takes none.
 */
export type MatrixSdkHostCommand = MatrixSdkCommand | { kind: 'stop' } | { kind: 'renewed' }

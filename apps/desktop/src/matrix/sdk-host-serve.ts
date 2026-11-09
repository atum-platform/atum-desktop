import type { MatrixSnapshot } from '../../shared/matrix'

import { startMatrixSdk } from './sdk'
import { matrixSdkErrorPayload } from './sdk-error-code'
import type { MatrixSdkHostPort } from './sdk-host-port'

export type MatrixSdk = Awaited<ReturnType<typeof startMatrixSdk>>

/** What a host sees when its SDK cannot start: a closed code, nothing raw. A new value each
 * time, since a host may keep it. */
const startFailed = (): MatrixSnapshot => ({
  state: 'error',
  identity: null,
  rooms: [],
  roomId: null,
  messages: [],
  error: 'matrix_sdk_start_failed'
})

/**
 * Runs one SDK engine behind one host (sdk-host-port.ts), the same way on every host:
 * - it starts with the host's configuration, and refreshes, publishes and offers hints
 *   through the host;
 * - if the configuration or the start fails, the host gets one `matrix_sdk_start_failed`
 *   snapshot, and every command then fails;
 * - each command waits for the start, then runs, and its result goes back under its id;
 *   a failure reports one of Atum's own closed codes, or `matrix_operation_failed` for
 *   anything raw (sdk-error-code.ts);
 * - `renewed` takes the host's renewed token through `refresh` (sdk-host-port.ts);
 * - `stop` stops the SDK.
 *
 * The engine needs a Web environment. A browser in a secure context and the desktop's
 * renderer have all of it, and so does Node 22 except two globals: IndexedDB (the sync
 * store, and the Rust crypto store that `initRustCrypto` opens by name) and `localStorage`.
 * A headless host installs those before it serves. The rest is fetch with its Request,
 * Response, Headers and streams, URL, AbortSignal's `timeout` and `any`, Blob, atob,
 * Web Crypto and WebAssembly. Bundling for Node is tested (sdk-host-seam-boundary.test.ts);
 * running the engine there is the headless executor's first proof (CX, S1).
 */
export function serveMatrixSdk(
  host: MatrixSdkHostPort,
  start: typeof startMatrixSdk = startMatrixSdk
): { started: Promise<MatrixSdk> } {
  const started = host.configuration().then(config =>
    start(
      config,
      handle => host.refresh(handle),
      snapshot => host.snapshot(snapshot),
      hint => host.invocation(hint),
      hint => host.notification?.(hint),
      observation => host.googleFence?.(observation),
      hint => host.appBotEvent?.(hint),
      observation => host.undecryptable?.(observation)
    )
  )

  void started.catch(() => {
    host.googleFence?.({ state: 'unknown' })
    host.snapshot(startFailed())
  })
  host.commands((id, command) => {
    void started
      .then(async sdk =>
        command.kind === 'stop' ? sdk.stop() : command.kind === 'renewed' ? sdk.renewed() : sdk.command(command)
      )
      .then(
        value => host.result(id, true, value),
        error => host.result(id, false, matrixSdkErrorPayload(error))
      )
  })

  return { started }
}

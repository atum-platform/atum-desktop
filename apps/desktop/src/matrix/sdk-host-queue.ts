import type {
  MatrixInvocationHint,
  MatrixNotificationHint,
  MatrixRefreshResult,
  MatrixSdkConfiguration,
  MatrixSnapshot
} from '../../shared/matrix'

import { APP_BOT_ROOM_WAIT_MS } from './app-bot-room-wait'
import type { MatrixAppBotEvent } from './sdk-app-bot'
import { MATRIX_SDK_FAILED, matrixSdkCommandError, matrixSdkErrorPayload } from './sdk-error-code'
import type { MatrixSdkHostCommand, MatrixSdkHostPort } from './sdk-host-port'

export const MATRIX_SDK_COMMAND_TIMEOUT_MS = 30_000
export const MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS = 120_000

/** Uploads have their own 90-second abort inside the SDK and authenticated media reads have a
 * 60-second bound; their outer command reserve leaves time for the event send and closed-code
 * delivery. Opening an official bot's chat ends by waiting for
 * its room to reach the SDK's store (`APP_BOT_ROOM_WAIT_MS`), which the ordinary bound must not
 * spend: the wait runs out on its own and fails with a closed code before this bound does. Every
 * other command keeps the ordinary bound. */
export function matrixSdkCommandTimeout(value: unknown): number {
  const command = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  const kind = command?.kind

  if (
    kind === 'attach' ||
    kind === 'appBotReadMedia' ||
    kind === 'roomSharedThumbnail' ||
    (kind === 'appBotApiSend' && command?.photo !== undefined)
  ) {
    return MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS
  }

  return kind === 'openAppBotDm' || kind === 'openAppBotRoom'
    ? MATRIX_SDK_COMMAND_TIMEOUT_MS + APP_BOT_ROOM_WAIT_MS
    : MATRIX_SDK_COMMAND_TIMEOUT_MS
}

/**
 * The host's side of the SDK seam (sdk-host-port.ts): one command queue per SDK. Each
 * command gets an id and a time limit, and its result settles only that command, so
 * responses cannot cross hosts. `stop` asks the SDK to stop, bounded, and closing rejects
 * whatever is still pending. A command never throws at its caller; it fails. The desktop's
 * main process keeps one per SDK window (electron/matrix/sdk-host.ts); connectMatrixSdk
 * below joins one to an SDK in the same process. It needs Web Crypto's `randomUUID`: Node,
 * the desktop's main process, and a browser in a secure context (HTTPS or localhost).
 */
export class MatrixSdkHost {
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private closed = false
  private stopping?: Promise<void>

  constructor(
    private readonly send: (id: string, value: unknown) => void,
    private readonly destroy: () => void
  ) {}

  /** Native lifecycle changes must wait for ordinary SDK requests as well as turns. */
  get busy(): boolean {
    return !this.closed && (this.pending.size > 0 || Boolean(this.stopping))
  }

  command(value: unknown, timeoutMs = MATRIX_SDK_COMMAND_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.stopping) {
      return Promise.reject(new Error('matrix_sdk_stopped'))
    }

    return this.request(value, timeoutMs)
  }

  private request(value: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let id: string

      try {
        id = crypto.randomUUID()
      } catch {
        // A browser offers Web Crypto's ids only in a secure context. The command fails;
        // it never throws at its caller.
        reject(new Error(MATRIX_SDK_FAILED))

        return
      }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('matrix_operation_timeout'))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.send(id, value)
      } catch {
        this.result(id, false, null)
      }
    })
  }

  result(id: string, ok: boolean, value: unknown) {
    const request = this.pending.get(id)

    if (!request) {
      return
    }

    clearTimeout(request.timer)
    this.pending.delete(id)

    if (ok) {
      request.resolve(value)
    } else {
      // Only a closed code survives; the value came from another process.
      request.reject(matrixSdkCommandError(value))
    }
  }

  stop(): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }

    this.stopping ??= this.request({ kind: 'stop' }, 5_000)
      .catch(() => {})
      .then(() => this.close())

    return this.stopping
  }

  close() {
    if (this.closed) {
      return
    }

    this.closed = true

    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('matrix_sdk_stopped'))
    }

    this.pending.clear()
    this.destroy()
  }
}

/** What a host in the same process as its SDK supplies: its identity and custody, and where
 * the SDK's state goes. A host that watches no invocations leaves `invocation` out.
 * `snapshot` and `invocation` run inside the SDK's own event handling: they should return at
 * once and not throw. One that throws loses that value, never the SDK's handling of it. */
export interface MatrixSdkLocalHost {
  configuration(): Promise<MatrixSdkConfiguration>
  refresh(handle: string): Promise<MatrixRefreshResult>
  snapshot(value: MatrixSnapshot): void
  invocation?(value: MatrixInvocationHint): void
  appBotEvent?(value: MatrixAppBotEvent): void
  notification?(value: MatrixNotificationHint): void
}

/**
 * A host in the same process as its SDK: a browser page or worker, or a headless executor.
 * It returns the port to serve the SDK on (serveMatrixSdk) and the queue its controller
 * commands, joined without IPC.
 * - Every value that crosses is copied, as IPC would copy it, so neither side can change
 *   what the other holds. A result that cannot be copied fails its command.
 * - A command sent before the SDK is served fails at once, where IPC would lose it and
 *   time out.
 * - One port serves one SDK: a second `commands` listener is refused.
 * - `destroy` runs when the queue closes, after a stop or a failed one.
 */
export function connectMatrixSdk(
  host: MatrixSdkLocalHost,
  destroy: () => void = () => {}
): { port: MatrixSdkHostPort; queue: MatrixSdkHost } {
  let listener: ((id: string, command: MatrixSdkHostCommand) => void) | undefined

  const queue = new MatrixSdkHost((id, value) => {
    if (!listener) {
      throw new Error('matrix_sdk_not_served')
    }

    listener(id, structuredClone(value) as MatrixSdkHostCommand)
  }, destroy)

  // The host's handler runs inside the SDK's event handling, which it must never break.
  const deliver = (handler: () => void) => {
    try {
      handler()
    } catch {
      /* That value is lost; the SDK's next change sends a new one. */
    }
  }

  const port: MatrixSdkHostPort = {
    configuration: async () => structuredClone(await host.configuration()),
    refresh: async handle => structuredClone(await host.refresh(handle)),
    snapshot: value => deliver(() => host.snapshot(structuredClone(value))),
    invocation: value => deliver(() => host.invocation?.(structuredClone(value))),
    appBotEvent: value => deliver(() => host.appBotEvent?.(structuredClone(value))),
    notification: value => deliver(() => host.notification?.(structuredClone(value))),
    commands: next => {
      if (listener) {
        throw new Error('matrix_sdk_already_served')
      }

      listener = next
    },
    result: (id, ok, value) => {
      // Copy only declared closed-code/identifier failure data, as process IPC does.
      if (!ok) {
        queue.result(id, false, structuredClone(matrixSdkErrorPayload(value)))

        return
      }

      let copy: unknown

      try {
        copy = structuredClone(value)
      } catch {
        queue.result(id, false, null)

        return
      }

      queue.result(id, true, copy)
    }
  }

  return { port, queue }
}

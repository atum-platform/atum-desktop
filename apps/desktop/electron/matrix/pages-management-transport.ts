import type { MatrixHermesConnection } from './hermes-runtime'
import type { MatrixPagesForwardRequest } from './pages-bridge'
import type { MatrixHermesTurnLock } from './turn-lock'

interface Options {
  isCurrent(): boolean
  connection(): MatrixHermesConnection | undefined
  connect(): Promise<unknown>
  busy(): boolean
  lock: MatrixHermesTurnLock
}

/** One management view stays on its original owned backend. A replaced process
 * cannot inherit an old OAuth/install operation, even in the same agent home. */
export class MatrixPagesManagementTransport {
  private pinned?: MatrixHermesConnection
  private connecting?: Promise<MatrixHermesConnection>
  private retired = false

  constructor(private readonly options: Options) {}

  current(): boolean {
    return (
      !this.retired &&
      this.options.isCurrent() &&
      (!this.pinned || (this.options.connection() === this.pinned && !this.pinned.signal.aborted))
    )
  }

  private assertCurrent(): void {
    if (!this.current()) {
      throw new Error('pages_agent_unavailable')
    }
  }

  private async connection(): Promise<MatrixHermesConnection> {
    this.assertCurrent()

    if (this.pinned) {
      return this.pinned
    }

    this.connecting ??= (async () => {
      if (!this.options.connection()) {
        await this.options.connect()
      }

      this.assertCurrent()
      const connection = this.options.connection()

      if (!connection?.pages || connection.signal.aborted) {
        throw new Error('pages_hermes_starting')
      }

      this.pinned = connection

      return connection
    })().finally(() => {
      this.connecting = undefined
    })

    return this.connecting
  }

  /** Use the same lock as local/listener turns. Never queue a configuration
   * change behind unknown active work, and never restart that work. */
  private async write<T>(connection: MatrixHermesConnection, action: () => Promise<T>): Promise<T> {
    this.assertCurrent()

    if (this.options.busy() || this.options.lock.holder || this.options.lock.waiting) {
      throw new Error('pages_agent_busy')
    }

    const release = await this.options.lock.acquire('*', 'management', connection.signal)

    try {
      this.assertCurrent()

      if (this.options.busy()) {
        throw new Error('pages_agent_busy')
      }

      const result = await action()
      this.assertCurrent()

      return result
    } finally {
      release()
    }
  }

  async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    const connection = await this.connection()
    this.assertCurrent()

    if (request.method !== 'GET') {
      return this.write(connection, async () => {
        const result = await connection.pages!(request)

        // A start response contains the only cancellation handle. Retire it
        // before the write fence discards a late result; never publish that
        // handle or continue the browser flow after the view has closed.
        if (
          !this.current() &&
          request.method === 'POST' &&
          /^\/api\/providers\/oauth\/[a-z0-9_-]+\/start\?profile=default$/.test(request.path) &&
          result !== null &&
          typeof result === 'object' &&
          'session_id' in result &&
          typeof result.session_id === 'string'
        ) {
          await this.cancelOAuth(result.session_id).catch(() => {})
        }

        return result
      })
    }

    const result = await connection.pages!(request)
    this.assertCurrent()

    return result
  }

  async reload(): Promise<unknown> {
    const connection = await this.connection()

    return this.write(connection, () =>
      connection.gateway.request('reload.mcp', { confirm: true }, 60_000, connection.signal)
    )
  }

  /** Cleanup can outlive its view, but only on the originally pinned process.
   * It can cancel a retained provider OAuth operation, never start/rebind one. */
  async cancelOAuth(sessionId: string): Promise<void> {
    const connection = this.pinned

    if (!connection?.pages || connection.signal.aborted || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
      return
    }

    await connection.pages({
      path: `/api/providers/oauth/sessions/${sessionId}?profile=default`,
      method: 'DELETE'
    })
  }

  retire(): void {
    this.retired = true
  }
}

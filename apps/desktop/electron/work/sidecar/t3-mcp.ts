import { issueT3McpSession, type PairingCodes, type SecretStore, type SessionIdSource } from '../gate/sessions'
import { ensureConnectMcpUrl } from '../surface/connect-endpoint'

const RENEW_BEFORE_MS = 7 * 86_400_000
const SESSION_LABEL = 'Atum Work'
const STORE_KEY = 't3-mcp-publication'

interface Published {
  deviceServiceId: string
  connectUrl: string
  sessionId: string
  expiresAt: number
}

interface Pending extends Published {
  credential: string
}

interface PublicationState {
  published?: Published
  pending?: Pending
  retiring?: true
}

type DeviceCall = (operation: string, body: Record<string, unknown>) => Promise<unknown>
type PublicationAuth = SessionIdSource & { sessionIds(label?: string): Promise<string[]> }

interface Custody {
  accountKey: string
  store: SecretStore
  auth: PublicationAuth
}

interface PublicationTarget extends Custody {
  deviceServiceId: string
  workOrigin: string
  ownerFetch: typeof fetch
  assertion(): Promise<string>
  pairing: PairingCodes
  current(): boolean
  call: DeviceCall
}

interface ClearOptions {
  shell?: { deviceServiceId: string; call: DeviceCall }
  revokedDeviceServiceId?: string
}

export class WorkT3McpPublication {
  private running?: { accountKey: string; deviceServiceId: string; abort: AbortController; done: Promise<void> }
  private clearing?: Promise<void>
  private checked?: { accountKey: string; workOrigin: string }

  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  refresh(target: PublicationTarget): Promise<void> {
    if (this.clearing) {return this.clearing}
    if (this.running) {return this.running.done}

    const abort = new AbortController()
    const done = this.publish(target, abort.signal).finally(() => { this.running = undefined })
    this.running = { accountKey: target.accountKey, deviceServiceId: target.deviceServiceId, abort, done }

    return done
  }

  private load(store: SecretStore): PublicationState {
    const raw = store.get(STORE_KEY)

    return raw ? JSON.parse(raw) as PublicationState : {}
  }

  private async revoke(auth: PublicationAuth, sessionId: string): Promise<void> {
    try {
      await auth.revokeSession(sessionId)
    } catch (error) {
      if (await auth.sessionIds().then(ids => ids.includes(sessionId), () => true)) {throw error}
    }
  }

  private async publish(target: PublicationTarget, signal: AbortSignal): Promise<void> {
    const current = () => !signal.aborted && target.current()

    if (!current()) {return}

    const { accountKey, deviceServiceId, workOrigin, auth, store } = target
    let state = this.load(store)

    if (state.retiring || [state.published, state.pending].some(record => record && record.deviceServiceId !== deviceServiceId)) {
      await this.withdraw(target)
      state = {}
    }

    if (this.checked?.accountKey !== accountKey || this.checked.workOrigin !== workOrigin) {
      const sessions = await auth.sessionIds(SESSION_LABEL)
      const known = [state.published?.sessionId, state.pending?.sessionId]
      await Promise.all(sessions.filter(id => !known.includes(id)).map(id => this.revoke(auth, id)))

      // An auth reset or native revoke can invalidate a stored session even though its advertised expiry is later.
      const live = (record?: Published) => record && sessions.includes(record.sessionId)
      const published = live(state.published) ? state.published : undefined
      const pending = live(state.pending) ? state.pending : undefined

      if (published !== state.published || pending !== state.pending) {
        state = { published, pending }
        store.set(STORE_KEY, JSON.stringify(state))
      }

      this.checked = { accountKey, workOrigin }
    }

    const connectUrl = await ensureConnectMcpUrl({
      origin: workOrigin, ownerFetch: target.ownerFetch, relayFetch: this.request,
      assertion: target.assertion, signal, current,
      disconnect: async () => {
        if (!current() || !(state.published || state.pending)) {return}

        await this.withdraw(target, { shell: { deviceServiceId, call: target.call } })
        state = {}
      }
    })

    if (!connectUrl || !current()) {return}

    const reusable = (record: Published) => record.deviceServiceId === deviceServiceId &&
      record.connectUrl === connectUrl && record.expiresAt - this.now() >= RENEW_BEFORE_MS
    const { pending, published } = state

    if (pending && !reusable(pending)) {
      await this.revoke(auth, pending.sessionId)
      delete state.pending
      store.set(STORE_KEY, JSON.stringify(state))
    }
    if (!state.pending && published && reusable(published)) {return}
    if (!current()) {return}

    if (!state.pending) {
      const connect = new URL(connectUrl)
      const response = await this.request(`${connect.origin}/.well-known/oauth-authorization-server`, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })

      if (!response.ok) {throw new Error('work_t3_mcp_invalid_metadata')}
      const { registration_endpoint } = await response.json()
      const registration = typeof registration_endpoint === 'string' ? new URL(registration_endpoint) : undefined

      if (!registration || registration.origin !== connect.origin || registration.username || registration.password) {
        throw new Error('work_t3_mcp_invalid_registration_endpoint')
      }
      if (!current()) {return}

      // Let the local exchange finish if retirement starts during mint. Clear joins this task and can then revoke it.
      this.checked = undefined
      const { token, sessionId, expiresAt } = await issueT3McpSession({
        origin: workOrigin, registrationEndpoint: registration.href, pairing: target.pairing,
        peer: false, name: SESSION_LABEL, access: 'full-access', fetch: this.request, now: this.now
      })

      try {
        if (Buffer.byteLength(token) > 8192 || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
          throw new Error('work_t3_mcp_invalid_token')
        }

        state.pending = { deviceServiceId, connectUrl, sessionId, expiresAt, credential: token }
        store.set(STORE_KEY, JSON.stringify(state))
      } catch (error) {
        await this.revoke(auth, sessionId)
        throw error
      }
    }

    if (!current()) {return}

    // Keep the candidate in encrypted storage until C1 acknowledges it, so an ambiguous response retries the same token.
    const { credential, sessionId, expiresAt } = state.pending
    await target.call('work_t3_mcp_set', { deviceServiceId, connectUrl, credential, expiresAt })
    store.set(STORE_KEY, JSON.stringify({ published: { deviceServiceId, connectUrl, sessionId, expiresAt } }))
    this.checked = undefined

    if (published) {await this.revoke(auth, published.sessionId)}
    this.checked = { accountKey, workOrigin }
  }

  stop(): void {
    this.running?.abort.abort()
  }

  private async withdraw(target: Custody, options: ClearOptions = {}): Promise<void> {
    const { shell, revokedDeviceServiceId } = options

    try {
      // If the keychain is locked, the native session list can still identify the relay sessions by label.
      let state: PublicationState = {}

      try {
        state = this.load(target.store)
        const recorded = state.pending ?? state.published

        if (revokedDeviceServiceId && recorded && recorded.deviceServiceId !== revokedDeviceServiceId) {return}
        if ((state.published || state.pending) && !state.retiring) {
          target.store.set(STORE_KEY, JSON.stringify({ ...state, retiring: true }))
        }
      } catch {
        // A failed keychain write must never stop the native revoke.
      }
      const ids = new Set([state.published?.sessionId, state.pending?.sessionId].filter(id => id !== undefined))

      // Revoke recorded sessions even if session listing fails. Also recover mints interrupted before the store write.
      const results = await Promise.allSettled([...ids].map(id => this.revoke(target.auth, id)))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) {throw failed.reason}

      const orphans = await target.auth.sessionIds(SESSION_LABEL)
      await Promise.all(orphans.filter(id => !ids.has(id)).map(id => this.revoke(target.auth, id)))
      target.store.delete(STORE_KEY)
    } finally {
      this.checked = undefined
      if (shell) {await shell.call('work_t3_mcp_clear', { deviceServiceId: shell.deviceServiceId })}
    }
  }

  async clear(target: Custody, options: ClearOptions = {}): Promise<void> {
    // A device-revoke callback and retirement can overlap. Serialize both with publication and each other.
    const previous = this.clearing
    const running = this.running?.accountKey === target.accountKey ? this.running : undefined
    if (running && (!options.revokedDeviceServiceId || running.deviceServiceId === options.revokedDeviceServiceId)) {
      running.abort.abort()
    }
    const done = (async () => {
      await previous?.catch(() => undefined)
      await running?.done.catch(() => undefined)
      await this.withdraw(target, options)
    })()
    this.clearing = done

    try {
      await done
    } finally {
      if (this.clearing === done) {this.clearing = undefined}
    }
  }
}

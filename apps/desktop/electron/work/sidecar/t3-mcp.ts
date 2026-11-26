import type { WorkAgentPlans } from '../../../shared/matrix-work'
import { WORK_RELAY_PLANS } from '../../../shared/matrix-work-relay'
import { issueT3McpSession, type PairingCodes, type SecretStore, type SessionIdSource } from '../gate/sessions'
import { ensureConnectMcpUrl } from '../surface/connect-endpoint'

const RENEW_BEFORE_MS = 7 * 86_400_000
const SESSION_LABEL = 'Atum Work'
const STORE_KEY = 't3-mcp-publication'
const CATALOG_KEY = 't3-mcp-plan-catalog'
const LINK_KEY = 't3-mcp-desktop-link'
const FIRST_LINK_RETRY_MS = 2 * 60_000
const MAX_LINK_RETRY_MS = 30 * 60_000

interface Published {
  deviceServiceId: string
  connectUrl: string
  sessionId: string
  expiresAt: number
  /** Legacy records retained only the receipt. */
  credential?: string
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

export class T3McpWithdrawalError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(failures.join(', '))
  }
}

export class WorkT3McpPublication {
  private running?: { accountKey: string; deviceServiceId: string; abort: AbortController; done: Promise<void> }
  private clearing?: Promise<void>
  private checked?: { accountKey: string; workOrigin: string }
  private linkRetry?: { accountKey: string; delay: number; at: number }

  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  refresh(target: PublicationTarget): Promise<void> {
    if (this.clearing) {return this.clearing}
    if (this.running) {return this.running.done}

    const abort = new AbortController()
    const done = this.publish(target, abort.signal).finally(() => { this.running = undefined })
    this.running = { accountKey: target.accountKey, deviceServiceId: target.deviceServiceId, abort, done }

    return done
  }

  allowConnectLink(accountKey: string, store: SecretStore): void {
    store.delete(LINK_KEY)
    if (this.linkRetry?.accountKey === accountKey) {this.linkRetry = undefined}
  }

  /** Only an acknowledged, unexpired publication counts. No online check is needed. */
  isPublished(store: SecretStore, deviceServiceId: string): boolean {
    const { published, retiring } = this.load(store)

    return !retiring && published?.deviceServiceId === deviceServiceId && published.expiresAt > this.now()
  }

  /** Keep the last native observations across Work restarts and transient probe failures. */
  planCatalog(store: SecretStore, deviceServiceId: string, observed: WorkAgentPlans['plans']): WorkAgentPlans['plans'] {
    const raw = store.get(CATALOG_KEY)
    const cached = raw ? JSON.parse(raw) as { deviceServiceId: string; plans: WorkAgentPlans['plans'] } : undefined
    const plans = cached?.deviceServiceId === deviceServiceId ? cached.plans : {}

    for (const plan of WORK_RELAY_PLANS) {
      const capability = observed[plan]

      if (!capability) {continue}

      const models = capability.state === 'connected' ? capability.models ?? plans[plan]?.models : undefined

      plans[plan] = { state: capability.state, ...(models ? { models } : {}) }
    }

    const next = JSON.stringify({ deviceServiceId, plans })

    if (Object.keys(observed).length && next !== raw) {store.set(CATALOG_KEY, next)}

    return plans
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

  private async probe(connectUrl: string, credential: string, signal: AbortSignal): Promise<'accepted' | 'rejected' | 'unavailable'> {
    // Native stateless discovery authenticates the bearer without opening a session or calling a tool.
    const version = '2026-07-28'
    const response = await this.request(connectUrl, {
      method: 'POST', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      headers: {
        authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json', 'mcp-method': 'server/discover', 'mcp-protocol-version': version
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: SESSION_LABEL, version: '1.0.0' }
          }
        }
      })
    }).catch(() => undefined)

    if (response?.status === 401 && response.headers.get('www-authenticate')?.includes('error="invalid_token"')) {
      await response.body?.cancel().catch(() => undefined)

      return 'rejected'
    }

    // A proxy response or an outage is inconclusive. Only native discovery proves acceptance.
    const reply = response?.ok ? await response.json().catch(() => undefined) : undefined

    if (!response?.ok) {await response?.body?.cancel().catch(() => undefined)}

    return Array.isArray(reply?.result?.supportedVersions) && reply.result.supportedVersions.includes(version)
      ? 'accepted' : 'unavailable'
  }

  private async publish(target: PublicationTarget, signal: AbortSignal): Promise<void> {
    const current = () => !signal.aborted && target.current()

    if (!current()) {return}

    const { accountKey, deviceServiceId, workOrigin, auth, store } = target
    let state = this.load(store)
    const shell = { deviceServiceId, call: target.call }
    const otherDevice = [state.published, state.pending].some(record => record && record.deviceServiceId !== deviceServiceId)

    if (state.retiring || otherDevice) {
      await this.withdraw(target, otherDevice ? {} : { shell })
      state = {}
      this.checked = { accountKey, workOrigin }
    }

    const checked = () => this.checked?.accountKey === accountKey && this.checked.workOrigin === workOrigin
    const retry = this.linkRetry?.accountKey === accountKey ? this.linkRetry : undefined
    let attemptedLink = false
    const connectUrl = await ensureConnectMcpUrl({
      origin: workOrigin, ownerFetch: target.ownerFetch, relayFetch: this.request,
      assertion: target.assertion, signal, current,
      canLink: () => {
        attemptedLink = !store.get(LINK_KEY) && (!retry || this.now() >= retry.at)

        return attemptedLink
      },
      rememberLink: () => store.set(LINK_KEY, 'linked'),
      disconnect: async () => {
        if (!current()) {return}

        if (state.published || state.pending) {
          await this.withdraw(target, { shell })
          state = {}
        } else if (!checked()) {
          // An interrupted mint may have left a native session before a record could be written.
          await this.withdraw(target)
        }
        this.checked = { accountKey, workOrigin }
      }
    }).catch((error: unknown) => {
      if (attemptedLink && current()) {
        const delay = retry ? Math.min(retry.delay * 2, MAX_LINK_RETRY_MS) : FIRST_LINK_RETRY_MS
        this.linkRetry = { accountKey, delay, at: this.now() + delay }
      }
      throw error
    })

    if (attemptedLink || connectUrl) {this.linkRetry = undefined}
    if (!current()) {return}

    if (!checked()) {
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

    if (!connectUrl || !current()) {return}

    const reusable = (record: Published) => record.deviceServiceId === deviceServiceId &&
      record.connectUrl === connectUrl && record.expiresAt - this.now() >= RENEW_BEFORE_MS
    const { pending, published } = state

    if (pending && !reusable(pending)) {
      await this.revoke(auth, pending.sessionId)
      delete state.pending
      store.set(STORE_KEY, JSON.stringify(state))
    }
    if (!state.pending && published?.credential && reusable(published) &&
        await this.probe(connectUrl, published.credential, signal) !== 'rejected') {return}
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
    const acceptance = await this.probe(connectUrl, credential, signal)

    if (!current()) {return}
    if (acceptance === 'rejected') {
      await this.revoke(auth, sessionId)
      delete state.pending
      store.set(STORE_KEY, JSON.stringify(state))
      throw new Error('work_t3_mcp_token_rejected')
    }
    if (acceptance !== 'accepted') {throw new Error('work_t3_mcp_probe_unavailable')}

    await target.call('work_t3_mcp_set', { deviceServiceId, connectUrl, credential, expiresAt })
    store.set(STORE_KEY, JSON.stringify({ published: state.pending }))
    this.checked = undefined

    if (published) {await this.revoke(auth, published.sessionId)}
    this.checked = { accountKey, workOrigin }
  }

  stop(): void {
    this.running?.abort.abort()
  }

  private async withdraw(target: Custody, options: ClearOptions = {}): Promise<void> {
    const { shell, revokedDeviceServiceId } = options

    // If the keychain is locked, the native session list can still identify the relay sessions by label.
    let state: PublicationState = {}

    try {
      state = this.load(target.store)
      const recorded = state.pending ?? state.published

      if (revokedDeviceServiceId && recorded && recorded.deviceServiceId !== revokedDeviceServiceId) {return}
      if ((recorded || shell) && !state.retiring) {
        target.store.set(STORE_KEY, JSON.stringify({ ...state, retiring: true }))
      }
    } catch {
      // A failed keychain write must never stop the native revoke.
    }

    const ids = new Set([state.published?.sessionId, state.pending?.sessionId].filter(id => id !== undefined))
    const revokeNative = async () => {
      // Revoke recorded sessions even if session listing fails. Also recover mints interrupted before the store write.
      const results = await Promise.allSettled([...ids].map(id => this.revoke(target.auth, id)))

      if (results.some(result => result.status === 'rejected')) {throw new Error('t3_mcp_native_revoke_failed')}

      const orphans = await target.auth.sessionIds(SESSION_LABEL)
      await Promise.all(orphans.filter(id => !ids.has(id)).map(id => this.revoke(target.auth, id)))
    }

    this.checked = undefined
    const [native, remote] = await Promise.allSettled([
      revokeNative(),
      shell && Promise.resolve().then(() => shell.call('work_t3_mcp_clear', { deviceServiceId: shell.deviceServiceId }))
    ])
    const failures: string[] = []

    if (native.status === 'rejected') {failures.push('t3_mcp_native_revoke_failed')}
    if (remote.status === 'rejected') {failures.push('t3_mcp_shell_clear_failed')}
    if (failures.length) {throw new T3McpWithdrawalError(failures)}

    target.store.delete(STORE_KEY)
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

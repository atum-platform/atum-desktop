import type { MatrixGoogleAssistantAccess, MatrixGoogleServices } from '../../shared/matrix-google-tools'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixGoogleTools, MatrixGoogleToolsGate } from './google-tools'
import { matrixGoogleHermesEnvironment } from './hermes-runtime'

/** The default assistant's host role: the one agent whose Google use the protected path (latch, fence) is built for. */
export const MATRIX_GOOGLE_ASSISTANT_ROLE = 'agent'

/**
 * Every owner-controlled agent on this Mac: the default assistant (`agent`) and the person's other
 * agents (`agent:<principal>`), never the human or an app host. Each gets its own broker key per
 * launch, so one agent's key is revoked when only its own process stops.
 */
export function isMatrixGoogleAgentRole(role: string): boolean {
  return role === MATRIX_GOOGLE_ASSISTANT_ROLE || /^agent:.+/.test(role)
}

/** A served route is rechecked every 10 minutes; an unserved or unknown one every 2. */
const ROUTE_TTL_MS = 10 * 60_000
const ROUTE_RETRY_MS = 2 * 60_000

interface Connections {
  readonly configured: boolean
  services(): MatrixGoogleServices | null
}

export interface MatrixGoogleAssistantDeps {
  /** Main's app-wide encrypted store; the latch follows the stable agent and keeps a legacy key. */
  store(): Pick<EncryptedStore, 'getItem' | 'setItems' | 'failureCode'> | undefined
  /** The stable default-agent principal. Its home now survives executor replacement. */
  agentPrincipal?(): string | undefined
  /** The default assistant's current executor, retained as a rollback-build latch key. */
  executorId(): string | undefined
  /** The default assistant answers with a model the person brought. */
  ownModel(): boolean
  connections(): Connections | undefined
  /** Whether the gateway lists the protected alias for this person (null: couldn't tell). */
  servesProtected(signal?: AbortSignal): Promise<boolean | null>
  /** The local model proxy's address; the only route a latched agent may use. */
  proxyBaseUrl(): string | undefined
  tools(): Pick<MatrixGoogleTools, 'mint' | 'url' | 'running'> | undefined
  /** Google full power (config `googleFullPower`, on unless set to false): the default assistant
   * may use the Google broker without the protected model route, latch or fence. Absent means off,
   * so a caller that never names it keeps the protected design. */
  fullPower?(): boolean
  /** Authoritative owner consent, checked at the broker boundary on every call. */
  sourceEnabled?(): boolean
  now?(): number
}

export interface MatrixGoogleLaunch {
  env: NodeJS.ProcessEnv
  /** What this launch was given, to compare with what main wants later. */
  tools: boolean
  fence: boolean
}

const any = (services: MatrixGoogleServices | null | undefined) =>
  Boolean(services && (services.gmail || services.calendar || services.drive))

/**
 * Main's Google policy for the assistants (G2-08, G2-19), in one place. The protected path below is the
 * default assistant's alone; under full power (the default) every owner agent on the Mac gets the same
 * broker capability:
 * - **The tools.** Only the default assistant, on Atum's model, with the protected route
 *   served, gets the broker's key: from its launch, whether or not Google is connected yet.
 *   Connecting Google then needs no restart, and the tool list stays the same for the life
 *   of the process (prompt caching). The launch also carries the fence (every model call
 *   of that process stays on Atum's proxy).
 * - **The latch.** The first broker call that could reach the person's Google data latches
 *   the assistant's stable home lineage on this Mac, durably, before anything is read. From then on
 *   its history and memory may hold Google data, so disconnecting doesn't lift it
 *   (spec/awareness/v1 §4.1), and every later launch says so (`ATUM_GOOGLE_LATCHED`).
 * - **The model route.** A latched assistant's model calls all go to the protected alias;
 *   when the gateway is known not to serve it they are refused here, before leaving the Mac.
 * - **The mark.** What a latched assistant posts carries the Google provenance mark, so
 *   the cloud companion never indexes it.
 *
 * The first-run card and the heartbeat read `view()` (MatrixSnapshot.googleAssistant), and
 * the heartbeat's posts go through `marks()` like every other post of this assistant.
 *
 * **Full power** (public-launch decision 2026-10-25, `fullPower()`): every user keeps Hermes in
 * full, including a model they brought, web, browser and MCP, while the existing local broker gives
 * the default assistant Google. The tool is fixed at launch but carries no latch, fence, protected
 * alias or mark; memory sync remains allowed. The stored latch is left exactly as it is (nothing is
 * cleared, no token is touched), so switching full power off brings the protected design back as it
 * was.
 */
export class MatrixGoogleAssistant {
  private served: boolean | null = null
  private checkedAt = 0
  private probing: Promise<boolean | null> | undefined
  /** Positive proofs stay sticky in this process; a different account has a different primary key. */
  private readonly latches = new Set<string>()

  constructor(private readonly deps: MatrixGoogleAssistantDeps) {}

  /** Full power is read at every decision, so a changed configuration needs no new instance. */
  fullPower(): boolean {
    return this.deps.fullPower?.() === true
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private latchKeys(): { primary: string; legacy?: string } | undefined {
    const agent = this.deps.agentPrincipal?.()
    const executor = this.deps.executorId()

    if (agent) {
      return {
        primary: `matrix-google-agent-latch:${agent}`,
        ...(executor ? { legacy: `matrix-google-latch:${executor}` } : {})
      }
    }

    return executor ? { primary: `matrix-google-latch:${executor}` } : undefined
  }

  private readLatch(
    store: Pick<EncryptedStore, 'getItem' | 'failureCode'>,
    keys: { primary: string; legacy?: string }
  ): { latched: boolean; durable: boolean } {
    const primary = store.getItem(keys.primary)

    if (store.failureCode()) {
      return { latched: true, durable: false }
    }

    const legacy = keys.legacy ? store.getItem(keys.legacy) : null

    if (store.failureCode()) {
      return { latched: true, durable: false }
    }

    return {
      latched: primary === '1' || legacy === '1',
      durable: primary === '1' && (!keys.legacy || legacy === '1')
    }
  }

  private saveLatch(
    store: Pick<EncryptedStore, 'getItem' | 'setItems' | 'failureCode'>,
    keys: { primary: string; legacy?: string }
  ): boolean {
    try {
      store.setItems({ [keys.primary]: '1', ...(keys.legacy ? { [keys.legacy]: '1' } : {}) })
    } catch {
      return false
    }

    const saved = this.readLatch(store, keys).durable

    if (saved) {
      this.latches.add(keys.primary)
    }

    return saved
  }

  /** The default assistant on this Mac may hold Google data (sticky across its local homes). */
  latched(): boolean {
    // Full power: a stored latch restricts nothing and is neither migrated nor rewritten.
    if (this.fullPower()) {
      return false
    }

    const keys = this.latchKeys()

    if (!keys) {
      return false
    }

    const store = this.deps.store()

    if (!store) {
      return this.latches.has(keys.primary)
    }

    const proof = this.readLatch(store, keys)
    const value = proof.latched || this.latches.has(keys.primary)

    if (!value) {
      return false
    }

    // A prior build knew only the executor key. Atomically preserve that proof under the stable
    // agent key and the current rollback key. Failure still keeps this process fenced; gate()
    // separately refuses Google data until both durable keys can be verified.
    this.latches.add(keys.primary)

    if (!proof.durable) {
      this.saveLatch(store, keys)
    }

    return true
  }

  private latch(): boolean {
    const keys = this.latchKeys()
    const store = this.deps.store()

    if (!keys || !store) {
      return false
    }

    return this.saveLatch(store, keys)
  }

  private durablyLatched(): boolean {
    const keys = this.latchKeys()
    const store = this.deps.store()

    if (!keys || !store) {
      return false
    }

    const durable = this.readLatch(store, keys).durable

    if (durable) {
      this.latches.add(keys.primary)
    }

    return durable
  }

  /** The last known answer: true served, false not served, null not known yet. */
  routeServed(): boolean | null {
    return this.served
  }

  /** Asks the gateway again when the last answer is stale; concurrent callers share one probe. */
  refreshRoute(signal?: AbortSignal, force = false): Promise<boolean | null> {
    // Full power does not use the protected route, so nothing asks the gateway about it.
    if (this.fullPower()) {
      return Promise.resolve(this.served)
    }

    const age = this.now() - this.checkedAt
    const fresh = this.checkedAt > 0 && age < (this.served === true ? ROUTE_TTL_MS : ROUTE_RETRY_MS)

    if (!force && fresh) {
      return Promise.resolve(this.served)
    }

    this.probing ??= this.deps
      .servesProtected(signal)
      .catch(() => null)
      .then(served => {
        // An unknown answer never overturns a known one until it is stale.
        if (served !== null || this.served === null || this.now() - this.checkedAt >= ROUTE_TTL_MS) {
          this.served = served
        }

        this.checkedAt = this.now()

        return this.served
      })
      .finally(() => {
        this.probing = undefined
      })

    return this.probing
  }

  /** The proxy's route for one agent's model call. Unknown (before the first probe) still
   * goes to the protected alias: the gateway refuses an alias it doesn't serve before any
   * provider sees the request, and nothing is ever sent under another model. */
  route(role: string): 'open' | 'protected' | 'refused' {
    if (role !== MATRIX_GOOGLE_ASSISTANT_ROLE || !this.latched()) {
      return 'open'
    }

    return this.served === false ? 'refused' : 'protected'
  }

  /**
   * The broker policy for one call. Full power admits the default assistant without a latch or
   * fence. The protected path requires Atum's model, a known-served protected route, and the latch
   * durable before any Google data can be read. With nothing connected the call can't return
   * Google data (the broker answers "not connected"), so it doesn't latch; when the saved grants
   * can't be read, it latches to be safe.
   */
  gate(role: string): MatrixGoogleToolsGate {
    if (!isMatrixGoogleAgentRole(role) || this.deps.sourceEnabled?.() === false) {
      return 'not_available'
    }

    // Full power's broker is intentionally unfenced. It never reads, migrates or writes a latch.
    // Every owner agent on this Mac gets the same capability (agent email control, 2026-11-08).
    if (this.fullPower()) {
      return 'ok'
    }

    // The protected path's latch and fence belong to the default assistant's home alone; another
    // agent has neither, so with full power switched off it gets no Google at all.
    if (role !== MATRIX_GOOGLE_ASSISTANT_ROLE) {
      return 'not_available'
    }

    if (this.deps.ownModel()) {
      return 'not_available'
    }

    if (this.served !== true) {
      return 'protected_route_unavailable'
    }

    const services = this.deps.connections()?.services()
    const mayReachGoogle = services === null || services === undefined || any(services)

    // Both the stable key and the current executor key must be one atomic durable write before
    // broker data can flow. The latter keeps a rollback build fenced too.
    if (mayReachGoogle && !this.durablyLatched() && !this.latch()) {
      return 'fence'
    }

    return 'ok'
  }

  /** Whether what the default assistant posts must carry the Google mark. */
  marks(role: string): boolean {
    return role === MATRIX_GOOGLE_ASSISTANT_ROLE && this.latched()
  }

  /** Whether main should run the local broker. The protected path still needs its proxy; full
   * power needs only the installed Google client because its broker calls are intentionally
   * unfenced. */
  wantsBroker(): boolean {
    return Boolean(this.deps.connections()?.configured && (this.fullPower() || this.deps.proxyBaseUrl()))
  }

  /** What the running assistant should have been launched with, from what is known now.
   * Connecting or disconnecting Google doesn't change it: full power gives the available broker
   * at launch; the protected path gives it with the served route. */
  wantsTools(role: string = MATRIX_GOOGLE_ASSISTANT_ROLE): boolean {
    if (role !== MATRIX_GOOGLE_ASSISTANT_ROLE && !this.fullPower()) {
      return false
    }

    if (this.fullPower()) {
      return Boolean(this.deps.connections()?.configured && this.deps.tools()?.running)
    }

    return Boolean(
      this.deps.connections()?.configured &&
        this.deps.proxyBaseUrl() &&
        this.deps.tools()?.running &&
        !this.deps.ownModel() &&
        this.served === true
    )
  }

  /**
   * The Google part of a launch of `role`'s Hermes. Decided once per launch, so the tool
   * list stays fixed for the life of the process (prompt caching). Full power may grant the tool
   * without a fence; on the protected path, a latched home always gets the fence even when it gets
   * no tools.
   */
  async launch(role: string, signal?: AbortSignal): Promise<MatrixGoogleLaunch> {
    const none: MatrixGoogleLaunch = { env: {}, tools: false, fence: false }

    if (!isMatrixGoogleAgentRole(role) || (role !== MATRIX_GOOGLE_ASSISTANT_ROLE && !this.fullPower())) {
      return none
    }

    if (this.fullPower()) {
      if (!this.deps.connections()?.configured) {
        return none
      }

      const tools = this.deps.tools()

      if (!tools?.running) {
        return none
      }

      return {
        env: matrixGoogleHermesEnvironment({ unfencedTools: { url: tools.url, key: tools.mint(role) } }),
        tools: true,
        fence: false
      }
    }

    const latched = this.latched()
    // Without the proxy a latched home may use no model at all: an impossible route.
    const fence = this.deps.proxyBaseUrl() ?? 'none'

    const fenced: MatrixGoogleLaunch = {
      env: matrixGoogleHermesEnvironment({ fence, latched }),
      tools: false,
      fence: true
    }

    const tools = this.deps.tools()

    if (!this.deps.connections()?.configured || !this.deps.proxyBaseUrl() || !tools?.running || this.deps.ownModel()) {
      return latched ? fenced : none
    }

    const served = await this.refreshRoute(signal).catch(() => null)

    if (served !== true) {
      return latched ? fenced : none
    }

    // The latch waits for the first call that could reach Google data (gate()).
    return {
      env: matrixGoogleHermesEnvironment({ fence, latched, tools: { url: tools.url, key: tools.mint(role) } }),
      tools: true,
      fence: true
    }
  }

  /** The golden-path seam and Settings' assistant line (MatrixSnapshot.googleAssistant). */
  view(): MatrixGoogleAssistantAccess | undefined {
    const connections = this.deps.connections()

    if (!connections) {
      return undefined
    }

    if (!connections.configured) {
      return { state: 'unavailable', reason: 'not_configured' }
    }

    if (this.fullPower()) {
      // A configured client is not usable when its local broker failed to start. Do not offer a
      // connection that the assistant could never receive until a later app launch retries it.
      if (!this.deps.tools()?.running) {
        return { state: 'unavailable', reason: 'not_configured' }
      }

      const services = connections.services()

      return any(services) ? { state: 'ready', services: services! } : { state: 'connect' }
    }

    const latched = this.latched()

    if (this.deps.ownModel()) {
      return { state: latched ? 'paused' : 'unavailable', reason: 'own_model' }
    }

    if (this.served === false || (!latched && this.served !== true)) {
      return { state: latched ? 'paused' : 'unavailable', reason: 'route' }
    }

    const services = connections.services()

    return any(services) ? { state: 'ready', services: services! } : { state: 'connect' }
  }
}

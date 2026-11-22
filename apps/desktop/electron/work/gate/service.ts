import { join } from 'node:path'

import { AccessVerifier, type AssertionResult } from './assertion'
import { type GateEvent, type GateOptions, type GateState, WorkGate } from './gate'
import { createGateHandler } from './http'
import { GateLedger } from './ledger'
import { PlanFact } from './plan-fact'
import type { GateSessions, WorkPlatform } from './ports'
import { bindGateSocket, type BoundGateSocket, GateSocketError } from './socket'
import { readFacts, WorkSync } from './sync'

// The Work gate as main holds it: the ledger, the gate, the socket listener and the sync client in one object.
// Main calls this and never the parts. It is account-scoped: one account's gate per signed-in account, and its
// socket is bound only while that account is signed in and removed before another account's home opens.

export interface GateAccount {
  key: string
  generation: number
  root: string
}

export function workGatePaths(account: Pick<GateAccount, 'root'>): { dir: string; ledger: string } {
  const dir = join(account.root, 'work', 'gate')

  return { dir, ledger: join(dir, 'ledger.sqlite') }
}

export interface WorkGateServiceOptions extends Omit<GateOptions, 'ledger' | 'hooks' | 'sessions'> {
  account: GateAccount
  /**
   * The agents' sessions and the owner session. A factory gets the gate's ledger so that `unfinished` and
   * `knownAgents` read the same store the gate writes: `ledger => new T3Sessions({ ..., unfinished: p => ledger.hasUnfinished(p), knownAgents: () => ledger.agents().map(a => a.principal) })`.
   */
  sessions: GateSessions | ((ledger: GateLedger) => GateSessions)
  platform: WorkPlatform
  /** The short, protected socket path main created for this enrollment (at most 100 bytes). */
  socketPath: string
  fetchJwks?: (url: string) => Promise<unknown>
  hooks?: GateOptions['hooks']
  syncIntervalMs?: number
  /** The most `retire` waits to deliver the cutoff and settled reports before the credential is lost. */
  retireFlushMs?: number
}

export interface GateServiceState extends GateState {
  enrolled: boolean
  hostname: string | null
  /** Settings: "Assistants may start work here". */
  switchOn: boolean
  socket: 'bound' | 'unbound' | 'down'
  socketReason: string | null
  /** Gate 4b, "Agents may use my ChatGPT plan here" on this Mac. OFF until the owner turns it on. */
  planSwitchOn: boolean
  /** What T3 last said about the plan on this Mac (the fact this Mac reports), `unknown` before the first read or while no server runs. */
  planConnected: 'connected' | 'disconnected' | 'unknown'
  /** What the owner's consent says about this Mac, `unknown` while its snapshot is missing or stale. */
  planConsent: 'on' | 'off' | 'unknown'
}

export class WorkGateService {
  readonly ledger: GateLedger
  readonly gate: WorkGate
  readonly sync: WorkSync
  readonly planFact: PlanFact | undefined
  private bound: BoundGateSocket | undefined
  private down: string | null = null
  private readonly verifiers = new Map<string, AccessVerifier>()
  private readonly now: () => number

  constructor(private readonly options: WorkGateServiceOptions) {
    this.now = options.now ?? Date.now
    this.ledger = new GateLedger(workGatePaths(options.account).ledger, options.accountId, this.now)
    const sessions = typeof options.sessions === 'function' ? options.sessions(this.ledger) : options.sessions

    this.gate = new WorkGate({ ...options, ledger: this.ledger, sessions })

    // Gate 4a: only a T3 client that has a plan instance configured can read the plan's status, and only a platform that speaks 1.2
    // can take the fact. Either absent (a stand-in, an older composition): nothing is read and nothing is reported.
    const planProvider = options.t3.planProvider?.bind(options.t3)

    this.planFact =
      planProvider && options.platform.reportSubscription
        ? new PlanFact({
            ledger: this.ledger,
            platform: options.platform,
            accountId: options.accountId,
            deviceServiceId: options.deviceServiceId,
            now: this.now,
            log: options.log,
            status: async () => {
              const owner = await sessions.owner()

              return (await planProvider(owner.token)).status
            }
          })
        : undefined

    this.sync = new WorkSync({
      gate: this.gate,
      ledger: this.ledger,
      platform: options.platform,
      accountId: options.accountId,
      deviceServiceId: options.deviceServiceId,
      now: this.now,
      socketPath: () => options.socketPath,
      log: options.log,
      planFact: this.planFact
    })
  }

  /** The signed assertion, checked against THIS Mac's Work application (read from the enrollment on every call). */
  private verify = async (token: string): Promise<AssertionResult> => {
    const facts = readFacts(this.ledger)

    if (!facts) {
      return { ok: false, detail: 'not_enrolled' }
    }

    const key = `${facts.accessTeamDomain}|${facts.accessAudienceTag}`
    let verifier = this.verifiers.get(key)

    if (!verifier) {
      verifier = new AccessVerifier({
        teamDomain: facts.accessTeamDomain,
        audience: facts.accessAudienceTag,
        clientIds: () => readFacts(this.ledger)?.accessClientIds ?? [],
        fetchJwks: this.options.fetchJwks,
        now: this.now
      })
      this.verifiers.set(key, verifier)
    }

    return verifier.verify(token)
  }

  on(listener: (event: GateEvent) => void): () => void {
    return this.gate.on(listener)
  }

  /** Report this Mac to the platform and keep what it answers. Null while the platform has no Work facts for it. */
  enroll() {
    return this.sync.enroll()
  }

  /** Whether the platform is still owed an event or a report (the gate may be closed and the server down). */
  hasPendingDelivery(): boolean {
    return this.sync.hasPendingDelivery()
  }

  /** Deliver what is owed without the server, until nothing is (see `WorkSync.resumeDelivery`). */
  resumeDelivery(onIdle?: () => void): void {
    this.sync.resumeDelivery(this.options.syncIntervalMs ?? 60_000, onIdle)
  }

  /** After the session server is up and `WorkSession.held()` is false. */
  async start(): Promise<void> {
    await this.gate.start()
    this.sync.start(this.options.syncIntervalMs ?? 60_000)
  }

  /** Bind the gate's only listener. A taken path or an unprotected directory means the route is down; nothing moves. */
  async openRoute(): Promise<void> {
    if (this.bound) {
      return
    }

    if (!readFacts(this.ledger)) {
      throw new GateSocketError('bind_failed')
    }

    try {
      this.bound = await bindGateSocket(
        this.options.socketPath,
        createGateHandler({ gate: this.gate, verifier: { verify: this.verify }, hostname: () => readFacts(this.ledger)?.workHostname, log: this.options.log })
      )
      this.down = null
    } catch (error) {
      this.down = error instanceof GateSocketError ? error.code : 'bind_failed'
      throw error
    }

  }

  async closeRoute(): Promise<void> {
    const bound = this.bound

    this.bound = undefined
    await bound?.close()
  }

  /** The Work screen was accepted (D9): record the grant and its epoch, and open the route. */
  async acceptWorkGrant(): Promise<void> {
    this.ledger.tx(() => {
      this.ledger.setMeta('work_grant_accepted_at', this.now())
      this.ledger.setMeta('work_grant_epoch', this.ledger.routeEpoch())
      this.ledger.setMeta('route_open', '1')
      this.ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: this.ledger.routeEpoch() })
    })
    await this.enroll().catch(() => null)
    void this.sync.tick()
  }

  /** "Agents may use my ChatGPT plan here" (gate 4b local switch). Off interrupts every plan thread at once. */
  setPlanSwitch(on: boolean): void {
    this.gate.setPlanSwitch(on)
  }

  /** "Assistants may start work here". Off: the cutoff at once; the edge follows within seconds. On: new work, nothing resumed. */
  async setSwitch(on: boolean): Promise<void> {
    if (on) {
      if (!this.gate.workGrantAccepted()) {
        throw new Error('work_grant_not_accepted')
      }

      this.ledger.tx(() => {
        this.ledger.setMeta('switch_on', '1')
        this.ledger.setMeta('route_open', '1')
        this.ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: this.ledger.routeEpoch() })
      })
      void this.sync.tick()

      return
    }

    this.closeRouteState('switch_off')
  }

  /** Cutoff for the whole route, marking it closed in the same durable write. */
  private closeRouteState(reason: string): void {
    const input = { scope: 'route', reason } as const

    const result = this.ledger.tx(() => {
      this.ledger.setMeta('switch_on', reason === 'switch_off' ? '0' : (this.ledger.meta('switch_on') ?? '1'))
      this.ledger.setMeta('route_open', '0')

      return this.gate.beginRevoke(input)
    })

    this.gate.finishRevoke(input, result)
  }

  /**
   * Sign-out, account switch, Work off: the cutoff, the origin closed and its socket removed BEFORE the next account's
   * home opens, then the cleanup while the session server still runs. Resolves with whether every stop settled; if the
   * server cannot be reached the stops stay owed in the ledger and settle at the next start (§8.5).
   */
  async retire(reason: 'sign_out' | 'work_off' | 'switch'): Promise<{ settled: boolean }> {
    this.sync.stop()
    this.closeRouteState(reason === 'switch' ? 'sign_out' : reason)
    await this.closeRoute()
    await this.gate.scheduleSettle()
    // The owner's credential is about to go: deliver the cutoff and the settled stop reports now, within a bound.
    await this.sync.flushBounded(this.options.retireFlushMs ?? 10_000)
    this.gate.stop()

    return { settled: this.ledger.owedRows().length === 0 }
  }

  state(): GateServiceState {
    const facts = readFacts(this.ledger)

    return {
      ...this.gate.state(),
      enrolled: Boolean(facts),
      hostname: facts?.workHostname ?? null,
      switchOn: this.ledger.meta('switch_on') !== '0',
      socket: this.bound ? 'bound' : this.down ? 'down' : 'unbound',
      socketReason: this.down,
      planSwitchOn: this.ledger.planSwitchOn(),
      planConnected: this.planFact?.current() ?? 'unknown',
      planConsent: this.gate.planConsentState()
    }
  }

  async close(): Promise<void> {
    this.sync.stop()
    await this.closeRoute()
    this.gate.stop()
    this.ledger.close()
  }
}

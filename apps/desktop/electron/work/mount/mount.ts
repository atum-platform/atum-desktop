import { existsSync } from 'node:fs'

import { type GateServiceState, workGatePaths, type WorkGateService } from '../gate'
import type { WorkSession } from '../session'

import type { WorkMountAccount } from './gate-factory'

// How main holds Work: the one place that starts, retires and tears down the Work gate together with the Work
// session. It is composition-agnostic: every main-owned dependency arrives as a port, so the public main and the
// Matrix composition mount it the same way.
//
// Order is the point (plan §6.4, §8.4, §8.5; lane G and R's interfaces):
//   start   `WorkSession.start()` (recover + reset reconcile: no home serves before a restore and reset finish)
//           -> enroll with the platform -> `gate.start()` only while `held()` is false -> bind the socket only when the
//           owner's Work grant is accepted and the switch is on.
//   retire  gate cutoff, socket closed, stops settled WHILE T3 still runs  ->  gate closed  ->  `WorkSession.retire`
//           (views closed, process group stopped, partition cleared, auth reset). Sign-out and account switch are one
//           path: the gate serves one account, and its socket is gone before another account's home opens.
//   quit    gate closed (no new admission, no cutoff: quitting is not a revocation) -> the process group stopped.
//
// The server is not started at sign-in (plan D7). It starts on first use (the owner opens Work: `wantServer`) or while
// there is an active delegation (the owner's Work grant is accepted and the assistants' switch is on, or a stop is
// still owed), and from then on for the rest of the account's run.
//
// Hiding the Work entry (`surface` not `on`) is presentation (§8.5): it only keeps the gate from STARTING. It never
// stops anything that already runs; turning Work off is `workOff()`.

export type MountSurfaceState = 'on' | 'needs_setup' | 'coming_soon' | 'needs_update' | 'hidden'

export type WorkMountPhase = 'idle' | 'starting' | 'holding' | 'running' | 'retiring' | 'failed'

export interface WorkMountDeps {
  /** The signed-in, committed account, or undefined. After sign-out this is undefined: `retire` takes the account. */
  account(): WorkMountAccount | undefined
  session: Pick<WorkSession, 'start' | 'held' | 'retire' | 'onResetDone'>
  host: { stop(): Promise<void>; setEnabled(enabled: boolean): Promise<void> }
  /**
   * Whether Work was ever provisioned for this account on this Mac (its server home exists). A sign-out of an account
   * that never used Work has nothing to reset, and must not run the session server's tools at all. Default: true.
   */
  homeExists?(account: WorkMountAccount): boolean
  /**
   * The account's gate, built from main's ports (`createWorkGateService`), or undefined when this composition cannot
   * supply them (no device enrollment, no platform client). Without a gate the owner's own Work still works through
   * `WorkSession.openOwnerView`; the assistants' route simply does not exist.
   */
  createGate(account: WorkMountAccount): WorkGateService | undefined
  surface?: MountSurfaceState
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

export interface WorkMountState {
  phase: WorkMountPhase
  surface: MountSurfaceState
  /** Why the gate is not running, in a closed vocabulary. Null while it runs. */
  reason: 'surface_off' | 'no_account' | 'not_composed' | 'start_failed' | 'held' | 'retiring' | 'not_needed' | null
  /** The gate's own state (read-only), including `undeliveredReports`: stop reports waiting for the platform. */
  gate: GateServiceState | null
}

export interface RetireResult {
  /** Every stop owed at the cutoff settled before the server stopped. False: they stay owed in the ledger and settle at next start. */
  settled: boolean
  /** Stable codes of steps that failed; the remaining steps still ran. */
  failed: string[]
}

const code = (error: unknown): string => (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message) ? error.message : 'unexpected_error')

export class WorkMount {
  private gate: { service: WorkGateService; account: WorkMountAccount } | undefined
  private surface: MountSurfaceState
  private phase: WorkMountPhase = 'idle'
  private reason: WorkMountState['reason'] = 'surface_off'
  /** Moves on every retire, quit and work-off: a start that began before it must not finish after it. */
  private epoch = 0
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  /** The owner opened Work this run: the server is needed from now until the account retires. */
  private wanted = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: WorkMountDeps) {
    this.surface = deps.surface ?? 'hidden'

    // "Reset done, re-issue sessions" (lane R -> lane G): an auth reset killed every session of that account.
    deps.session.onResetDone(account => {
      if (this.gate && this.gate.account.root === account.root) {
        void this.gate.service.gate.onResetDone().catch(error => this.deps.log?.('reset_done_failed', { code: code(error) }))
      }
    })
  }

  /** First use: the owner opened Work (or asked for something that needs its gate). Starts what a sign-in does not. */
  wantServer(): Promise<void> {
    this.wanted = true

    return this.reconcile()
  }

  /** The gate service for the Settings and enrollment surfaces. Undefined until the gate has started. */
  service(): WorkGateService | undefined {
    return this.gate?.service
  }

  state(): WorkMountState {
    return { phase: this.phase, surface: this.surface, reason: this.reason, gate: this.gate?.service.state() ?? null }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** A service that only delivers what is owed (no gate, no server), until it has nothing left. */
  private delivering: WorkGateService | undefined

  private async endDelivery(): Promise<void> {
    const service = this.delivering

    this.delivering = undefined
    await service?.close().catch(() => undefined)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)

    return run
  }

  /** The `work` surface's server-declared state. Only `on` lets the gate start. */
  setSurface(surface: MountSurfaceState): Promise<void> {
    this.surface = surface
    this.changed()

    return surface === 'on' ? this.reconcile() : Promise.resolve()
  }

  /**
   * Start what should be running. Safe to call whenever something that can unblock it changed: sign-in, the surface
   * turning on, an update or reset finishing, Work turned back on.
   */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.gate) {
        return
      }

      const account = this.deps.account()

      if (this.surface !== 'on' || !account) {
        this.reason = account ? 'surface_off' : 'no_account'
        this.changed()

        return
      }

      // A delivery-only service of an earlier pass holds this account's ledger file: it ends before the gate is built afresh.
      await this.endDelivery()

      const epoch = this.epoch
      const stale = () => this.closed || epoch !== this.epoch || this.deps.account()?.root !== account.root
      this.phase = 'starting'
      this.reason = null
      this.changed()

      let started: WorkGateService | undefined

      try {
        started = this.deps.createGate(account)

        if (!started) {
          this.phase = 'idle'
          this.reason = 'not_composed'

          return
        }

        // No server for an account that has not used Work and delegates nothing: sign-in starts nothing (plan D7).
        if (!this.needsServer(started)) {
          this.phase = 'idle'
          this.reason = 'not_needed'

          // What this account still owes the platform (a cutoff's events, settled stop reports a failed retirement flush left)
          // goes out without the owner opening Work and without the server: the ledger and the platform are all it needs.
          if (started.hasPendingDelivery()) {
            this.delivering = started
            started.resumeDelivery(() => {
              if (this.delivering === started) {
                this.delivering = undefined
              }

              void started.close().catch(() => undefined)
            })
          } else {
            await started.close()
          }

          return
        }

        // Lane R's door: recovery and the reset marker first, so no home serves before they finish.
        await this.deps.session.start()

        if (stale()) {
          await started.close()

          return
        }

        await started.enroll().catch(() => null)

        if (stale() || this.deps.session.held()) {
          // An update or an owed reset owns the account (or the account moved on): the gate admits nothing now and
          // `reconcile()` builds it afresh once that is over.
          const held = !stale()
          this.phase = held ? 'holding' : 'idle'
          this.reason = held ? 'held' : 'no_account'
          await started.close()

          return
        }

        this.gate = { service: started, account }

        await started.start()
        const state = started.state()

        if (state.routeOpen && state.enrolled) {
          await started.openRoute().catch(error => this.deps.log?.('route_open_failed', { code: code(error) }))
        }

        this.phase = 'running'
      } catch (error) {
        this.deps.log?.('work_start_failed', { code: code(error) })
        this.phase = 'failed'
        this.reason = 'start_failed'

        if (this.gate?.service === started) {
          this.gate = undefined
        }

        await started?.close().catch(() => undefined)
      } finally {
        this.changed()
      }
    })
  }

  /** Used by the owner this run, an accepted grant with the switch on (an active delegation), or a stop still owed. */
  private needsServer(service: WorkGateService): boolean {
    // A restore or reset an earlier run left pending is healed at once, before anything else can find the home torn.
    if (this.wanted || this.deps.session.held()) {
      return true
    }

    const state = service.state()

    return (state.workGrantAccepted && state.routeOpen && state.switchOn) || state.stopsOwed.total > 0
  }

  /** The owner accepted the enrollment screen (D9): record it, enroll, and open the route. */
  async acceptWorkGrant(): Promise<void> {
    await this.wantServer()
    const service = this.requireService()

    await service.acceptWorkGrant()
    await service.openRoute().catch(error => this.deps.log?.('route_open_failed', { code: code(error) }))
    this.changed()
  }

  /** "Assistants may start work here". Off is the cutoff at once and keeps answering typed `revoked`; on opens the route. */
  async setSwitch(on: boolean): Promise<void> {
    await this.wantServer()
    const service = this.requireService()

    await service.setSwitch(on)

    if (on) {
      await service.openRoute().catch(error => this.deps.log?.('route_open_failed', { code: code(error) }))
    }

    this.changed()
  }

  /** "Agents may use my ChatGPT plan here" (gate 4b). Off interrupts every plan thread; on starts nothing by itself. */
  async setPlanSwitch(on: boolean): Promise<void> {
    await this.wantServer()
    this.requireService().setPlanSwitch(on)
    this.changed()
  }

  /** Withdraw an existing fact even if Work has not started this run. */
  setMacPlanFactsEnabled(deviceServiceId: string, enabled: boolean): Promise<void> {
    const account = this.deps.account()

    return this.serial(async () => {
      const current = this.deps.account()

      if (!account || current?.key !== account.key || current.generation !== account.generation || this.closed) {
        return
      }

      const gate = this.gate

      if (gate?.account.generation === account.generation && gate.account.key === account.key) {
        await gate.service.setPlanFactsEnabled(deviceServiceId, enabled)
        this.changed()

        return
      }

      if (!existsSync(workGatePaths(account).ledger)) {
        return
      }

      const offline = this.deps.createGate(account)

      if (!offline) {
        throw new Error('work_gate_unavailable')
      }

      try {
        await offline.setPlanFactsEnabled(deviceServiceId, enabled)
      } finally {
        await offline.close()
      }
    })
  }

  private requireService(): WorkGateService {
    if (!this.gate) {
      throw new Error('work_gate_not_running')
    }

    return this.gate.service
  }

  /**
   * Sign-out and account switch. `account` is passed in because main no longer has it by now. The gate is retired
   * first, while T3 still runs, so owed stops settle; then `WorkSession.retire` stops the server, clears the
   * partition and resets auth. A failed step does not skip the next one: what could not finish stays owed in the
   * ledger (stops) or leaves the home refused (`work_account_teardown_required`), never half open.
   */
  async retire(account: WorkMountAccount): Promise<RetireResult> {
    this.epoch += 1
    this.wanted = false
    this.phase = 'retiring'
    this.reason = 'retiring'
    this.changed()

    return this.serial(async () => {
      const result: RetireResult = { settled: true, failed: [] }
      await this.endDelivery()
      let current = this.gate

      if (current && current.account.root !== account.root) {
        await current.service.close().catch(() => undefined)
        current = undefined
      }

      // A gate that was never started this run still owes the cutoff, and its sessions must be forgotten at the reset.
      let service = current?.service

      if (!service) {
        try {
          service = this.deps.createGate(account)
        } catch (error) {
          result.settled = false
          result.failed.push(`gate_build:${code(error)}`)
        }
      }

      this.gate = service ? { service, account } : undefined

      try {
        const outcome = await service?.retire('sign_out')

        result.settled = outcome?.settled ?? true
      } catch (error) {
        result.settled = false
        result.failed.push(`gate_retire:${code(error)}`)
      }

      try {
        if (this.deps.homeExists?.(account) ?? true) {
          await this.deps.session.retire(account, 'sign-out')
        } else {
          await this.deps.host.stop()
        }
      } catch (error) {
        result.settled = false
        result.failed.push(`session_retire:${code(error)}`)
      }

      try {
        await service?.close()
      } catch (error) {
        result.failed.push(`gate_close:${code(error)}`)
      }

      this.gate = undefined
      this.phase = 'idle'
      this.reason = 'no_account'
      this.changed()

      return result
    })
  }

  /** "Work off": the cutoff for the whole Mac, then the process group stopped and refused to start (§8.5). */
  async workOff(): Promise<RetireResult> {
    this.epoch += 1
    this.wanted = false

    return this.serial(async () => {
      const result: RetireResult = { settled: true, failed: [] }
      await this.endDelivery()
      const gate = this.gate

      try {
        result.settled = (await gate?.service.retire('work_off'))?.settled ?? true
      } catch (error) {
        result.settled = false
        result.failed.push(`gate_retire:${code(error)}`)
      }

      try {
        await gate?.service.close()
      } catch (error) {
        result.failed.push(`gate_close:${code(error)}`)
      }

      this.gate = undefined

      try {
        await this.deps.host.setEnabled(false)
      } catch (error) {
        result.settled = false
        result.failed.push(`host_disable:${code(error)}`)
      }

      this.phase = 'idle'
      this.reason = 'surface_off'
      this.changed()

      return result
    })
  }

  /** Work turned back on: the host may start again. The route stays closed until the owner turns the switch on. */
  async workOn(): Promise<void> {
    await this.deps.host.setEnabled(true)
    await this.reconcile()
  }

  /**
   * App quit. Quitting is not a revocation: no cutoff, so the owner's switch stays as it was. The gate stops
   * admitting and its socket goes first; then the process group stops. A stop owed stays in the ledger.
   */
  async quit(): Promise<void> {
    this.closed = true
    this.epoch += 1

    await this.serial(async () => {
      const gate = this.gate
      this.gate = undefined

      await this.endDelivery()
      await gate?.service.close().catch(error => this.deps.log?.('gate_close_failed', { code: code(error) }))
      await this.deps.host.stop()
      this.phase = 'idle'
      this.changed()
    })
  }
}

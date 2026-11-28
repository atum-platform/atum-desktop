import semver from 'semver'

import type { WorkIncarnation } from '../sidecar/process'

import { type OwnerViewPort, pairOwnerView } from './pairing'
import { partitionFor, type WorkSessionAccount, workSessionPaths, type WorkSessionPaths } from './paths'
import { WorkSessionError } from './redact'
import { homeRunningFromRuntimeFile, ResetCoordinator, type ResetReport } from './reset'
import { createPairingGrantLookup, createT3AuthCli, type PairingGrantLookup, type T3AuthCli } from './t3-auth'
import { type PinHost, type PinRef, type UpdateDeps, UpdateDriver, type UpdateOutcome, type WorkUpdateSelection } from './update'

export type { WorkSessionAccount } from './paths'

export interface WorkSessionOptions {
  account(): WorkSessionAccount | undefined
  /** The running pin's host (`WorkHost`). Replaced by the committed pin after an update. */
  host: PinHost
  /** `<resources>/work-runtime/t3` of the CURRENT pin, and the sidecar's environment (HOME, PATH). */
  authTools(paths: WorkSessionPaths): { executable: string; environment: Record<string, string> } | {
    cli: T3AuthCli
    grants: PairingGrantLookup
  }
  /** Wipes a partition's cookies and storage even when no view exists. */
  clearPartition(partition: string): Promise<void>
  /** Whether the start resumes interrupted threads. Defaults to false. */
  continuation?(): boolean
  plannedUpdate?(account: WorkSessionAccount): WorkUpdateSelection | undefined
  /** Update wiring; omit to run without an update driver. */
  update?: Omit<UpdateDeps, 'paths' | 'coordinator' | 'stopRunning'>
  pairing?: { timeoutMs?: number; pollMs?: number }
  /** Whether a server may still hold this home. Default: the pid in T3's `server-runtime.json`. */
  homeRunning?(paths: WorkSessionPaths): boolean | Promise<boolean>
}

interface AccountState {
  account: WorkSessionAccount
  paths: WorkSessionPaths
  coordinator: ResetCoordinator
  driver?: UpdateDriver
  views: Map<OwnerViewPort, () => void>
  pairedIncarnation?: string
}

export type OpenOwnerView =
  | { state: 'paired' | 'reused'; view: OwnerViewPort; incarnation: WorkIncarnation }
  | { state: 'failed'; reason: string }

/**
 * The owner session handles sign-in, reset and update. The shell calls
 * this, never `WorkHost.start` directly: every start passes the marker first,
 * so no home serves before an interrupted restore and reset have finished.
 */
export class WorkSession {
  private readonly accounts = new Map<string, AccountState>()
  private host: PinHost

  constructor(private readonly options: WorkSessionOptions) {
    this.host = options.host
  }

  /** True while an update or an unfinished reset owns the account. */
  held(): boolean {
    const account = this.options.account()

    // The marker is read from disk (`stateFor` only builds the account's paths): a restore or reset a crash left pending counts
    // before this run has touched the account at all.
    return Boolean(account && (this.stateFor(account).coordinator.pending() || this.updating.has(account.root)))
  }

  private readonly updating = new Set<string>()

  private readonly starting = new Map<string, Promise<WorkIncarnation>>()

  start(): Promise<WorkIncarnation> {
    const state = this.state()
    const key = state.paths.home
    const pending = this.starting.get(key)

    if (pending) {return pending}

    const run = this.startAccount(state).finally(() => {
      if (this.starting.get(key) === run) {this.starting.delete(key)}
    })

    this.starting.set(key, run)

    return run
  }

  private async startAccount(state: AccountState): Promise<WorkIncarnation> {
    await state.driver?.recover()
    await state.coordinator.reconcile()

    // A pin this build ships that is newer than the one the home last committed goes through the update driver (reset, snapshot,
    // trial, commit or restore) BEFORE the home is opened: starting the new binary on the old home directly is not an update.
    const planned = this.options.plannedUpdate?.(state.account)
    const updated = await this.applyShippedPin(state, planned)

    if (updated) {
      return updated
    }

    const incarnation = await this.host.start({ continuation: Boolean(planned) || (this.options.continuation?.() ?? false) })

    if (incarnation.home !== state.paths.home) {
      await this.host.stop().catch(() => undefined)
      throw new WorkSessionError('work_home_mismatch')
    }

    return incarnation
  }

  /**
   * The pin check at every start. No record yet: this pin is the baseline. A shipped pin below the committed one is never started
   * (an older server on a newer home). A newer one is an update, through the same door as `update()`; its refusals leave the home
   * and the server alone, and so does a trial that rolled back (the previous binary is not part of this build).
   */
  private async applyShippedPin(state: AccountState, planned?: WorkUpdateSelection): Promise<WorkIncarnation | undefined> {
    const { driver } = state
    const shipped = this.options.update?.currentPin()

    if (!driver || !shipped) {
      return undefined
    }

    const known = driver.readState()

    if (!known) {
      driver.adopt(shipped)

      return undefined
    }

    if (semver.lt(shipped.version, known.pin)) {
      throw new WorkSessionError('work_pin_downgrade')
    }

    if (!semver.gt(shipped.version, known.pin)) {
      return undefined
    }

    const outcome = await this.runUpdate(state, shipped, { closeViews: false }, planned)

    if (outcome.outcome === 'committed' && outcome.incarnation) {
      return outcome.incarnation
    }

    if (outcome.outcome === 'rolled_back') {
      await outcome.host.stop().catch(() => undefined)
      throw new WorkSessionError('work_update_rolled_back')
    }

    throw new WorkSessionError(outcome.outcome === 'refused' ? `work_update_${outcome.reason}` : 'work_update_failed')
  }

  /**
   * Stop, reset, start: the only restart. Awaiting the stop first matters: the
   * signing key is cached by a running server, so a reset on a live home is void.
   */
  async restart(reason: 'pairing-failed' | 'sign-out' = 'pairing-failed'): Promise<WorkIncarnation> {
    const state = this.state()
    await this.starting.get(state.paths.home)?.catch(() => undefined)
    this.closeViews(state)
    await this.host.stop()
    await state.coordinator.reset(reason)

    return this.start()
  }

  /**
   * Open the one owner view. The first view of an incarnation is paired with
   * its startup grant. A view opened later in the same incarnation uses the
   * partition's cookie and takes no grant. A failed pairing recycles the
   * server (stop, full reset, start) and tries once more with a fresh grant.
   */
  async openOwnerView(
    createView: (incarnation: WorkIncarnation) => OwnerViewPort | Promise<OwnerViewPort>,
    signal?: AbortSignal
  ): Promise<OpenOwnerView> {
    const state = this.state()

    for (let attempt = 0; attempt < 2; attempt++) {
      const incarnation = this.host.current() ?? (await this.start())

      signal?.throwIfAborted()

      if (state.views.size > 0) {
        throw new WorkSessionError('work_view_exists')
      }

      const view = await createView(incarnation)
      let detach: () => void

      try {
        signal?.throwIfAborted()
        detach = this.host.bindOwnerView(incarnation, view.contents)
      } catch (error) {
        view.close()
        throw error
      }

      state.views.set(view, detach)
      view.onClosed(() => {
        if (state.views.delete(view)) {
          detach()
        }
      })

      if (state.pairedIncarnation === incarnation.id && (await view.signedIn().catch(() => false))) {
        signal?.throwIfAborted()
        await view.load(`${incarnation.origin}/`)

        return { state: 'reused', view, incarnation }
      }

      signal?.throwIfAborted()
      const { cli, grants } = this.tools(state.paths)
      const outcome = await pairOwnerView({ incarnation, view, cli, grants, ...this.options.pairing })

      signal?.throwIfAborted()

      if (outcome.state === 'paired') {
        state.pairedIncarnation = incarnation.id

        return { state: 'paired', view, incarnation }
      }

      this.closeViews(state)
      await this.options.clearPartition(partitionFor(state.account.key))
      signal?.throwIfAborted()
      await this.restart('pairing-failed')

      if (attempt === 1) {
        return { state: 'failed', reason: outcome.reason }
      }
    }

    return { state: 'failed', reason: 'timeout' }
  }

  /**
   * Sign-out and account switch: every view of the outgoing account closed, its
   * partition cleared, its process group stopped (awaited), then the full auth
   * reset on its home. Switch-back is a new start with a new grant and cookie.
   */
  async retire(account: WorkSessionAccount, reason: 'switch' | 'sign-out' = 'switch'): Promise<ResetReport> {
    const state = this.stateFor(account)
    this.closeViews(state)
    await this.host.stop()
    await this.options.clearPartition(partitionFor(account.key))
    const report = await state.coordinator.reset(reason)
    this.accounts.delete(account.root)

    return report
  }

  /** Main-owned update (§8.4, G5b). Closes every view first: the server restarts and the reset voids the cookie. */
  async update(target: PinRef): Promise<UpdateOutcome> {
    const state = this.state()

    if (!state.driver) {
      throw new WorkSessionError('work_update_unavailable')
    }

    await this.starting.get(state.paths.home)?.catch(() => undefined)

    // A refusal that can be known up front (a stop owed above all) is answered before a view is closed, the partition cleared or
    // anything restarted: the running home keeps serving exactly as it was.
    const refusal = await state.driver.preflight(target)

    if (refusal) {
      return refusal
    }

    return this.runUpdate(state, target, { closeViews: true })
  }

  private async runUpdate(state: AccountState, target: PinRef, options: { closeViews: boolean }, planned?: WorkUpdateSelection): Promise<UpdateOutcome> {
    const driver = state.driver as UpdateDriver

    this.updating.add(state.account.root)

    try {
      if (options.closeViews) {
        this.closeViews(state)
        await this.options.clearPartition(partitionFor(state.account.key))
      }

      const outcome = await driver.update(target, planned)

      if (outcome.outcome !== 'refused') {
        this.host = outcome.host
        state.pairedIncarnation = undefined
      } else if (options.closeViews) {
        // Refused after the preflight (a race): the running pin is still up, but its owner view was closed above, so it will
        // pair again from a fresh grant.
        state.pairedIncarnation = undefined
        await this.restart('pairing-failed')
      }

      return outcome
    } finally {
      this.updating.delete(state.account.root)
    }
  }

  private tools(paths: WorkSessionPaths): { cli: T3AuthCli; grants: PairingGrantLookup } {
    const tools = this.options.authTools(paths)

    if ('cli' in tools) {
      return tools
    }

    return {
      cli: createT3AuthCli({ executable: tools.executable, home: paths.home, environment: tools.environment }),
      grants: createPairingGrantLookup(paths.database)
    }
  }

  private state(): AccountState {
    const account = this.options.account()

    if (!account) {
      throw new WorkSessionError('work_unavailable')
    }

    return this.stateFor(account)
  }

  private stateFor(account: WorkSessionAccount): AccountState {
    const existing = this.accounts.get(account.root)

    if (existing) {
      return existing
    }

    const paths = workSessionPaths(account)

    // Resolved on every call: after an update the pin's `t3` has changed.
    const cli: T3AuthCli = {
      sessionIds: () => this.tools(paths).cli.sessionIds(),
      revokeSession: id => this.tools(paths).cli.revokeSession(id),
      pairingIds: () => this.tools(paths).cli.pairingIds(),
      revokePairing: id => this.tools(paths).cli.revokePairing(id)
    }

    const grants: PairingGrantLookup = {
      idForCredential: credential => this.tools(paths).grants.idForCredential(credential),
      unusedIds: () => this.tools(paths).grants.unusedIds()
    }

    const coordinator = new ResetCoordinator({
      paths,
      cli,
      grants,
      homeRunning: this.options.homeRunning ? () => this.options.homeRunning!(paths) : homeRunningFromRuntimeFile(paths)
    })

    const state: AccountState = {
      account,
      paths,
      coordinator,
      views: new Map(),
      driver: this.options.update
        ? new UpdateDriver({
            ...this.options.update,
            paths,
            coordinator,
            stopRunning: () => this.host.stop()
          })
        : undefined
    }

    this.accounts.set(account.root, state)

    return state
  }

  private closeViews(state: AccountState): void {
    for (const [view, detach] of state.views) {
      detach()
      view.close()
    }

    state.views.clear()
    state.pairedIncarnation = undefined
  }
}

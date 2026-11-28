import type { AccountConnectionsView, AccountPlan } from '../../../shared/account-connections'
import type { FirstRunLabels } from '../../../shared/first-run-labels'
import type {
  MatrixWorkPlanConsent,
  MatrixWorkPlanConsentInput,
  MatrixWorkProjection,
  MatrixWorkRect,
  MatrixWorkViewState,
  WorkAgentPlans,
  WorkAttentionSnapshot,
  WorkBandCommand,
  WorkSidebarSnapshot,
  WorkSurfaceModeSnapshot
} from '../../../shared/matrix-work'
import type { WorkRelayPlan, WorkRelaySelection } from '../../../shared/matrix-work-relay'
import type { WorkLocalPlan, WorkLocalPlanAction, WorkLocalPlanAuthAction, WorkLocalPlanStates } from '../../../shared/work-local-plans'
import type { OwnerViewPort } from '../session/pairing'
import type { OpenOwnerView } from '../session/session'
import type { WorkAccess } from '../sidecar/host'
import type { WorkIncarnation } from '../sidecar/process'

import type { WorkConsentClient } from './platform'
import { projectWorkConsent, workPlanConnectPath } from './projection'

/** The owner view as main paints it: R's port, plus where it sits in the Matrix window (null: off the window). */
export interface WorkViewHandle {
  port: OwnerViewPort
  place(rect: MatrixWorkRect | null): void
  /** Moves keyboard focus into the view, so a band command that lands in its composer shows the caret. */
  focus?(): void
}

/** The parts of one signed-in account's Work. Main builds them (lanes S, R, G) and hands them over. */
export interface WorkSurfaceParts {
  relay?: {
    readPlans(principal: string): Promise<WorkAgentPlans | null>
    select(principal: string, model: string, plan?: WorkRelayPlan): Promise<WorkRelaySelection>
  }
  session: { openOwnerView(createView: (incarnation: WorkIncarnation) => OwnerViewPort): Promise<OpenOwnerView> }
  /** S's per-account Work off marker (§8.5). Off: nothing starts, the page says so. */
  enabled(): boolean
  /** S's balance read for the Atum provider (`readModelAccess`). */
  readAccess?(): Promise<WorkAccess>
  readPlanUsage?(): Promise<MatrixWorkProjection['planLimits']>
  /** The account's legacy cloud login must be retired before opening native Codex setup. */
  prepareChatGptConnect?(): Promise<void>
  /** `atum.account-connections/1`, or this Mac's own plan facts when the registry cannot be read. */
  readConnections?(): Promise<AccountConnectionsView | null>
  /** This Mac's four first-run connections and T3's plan names (local only). */
  readPlanLabels?(): Promise<FirstRunLabels>
  readLocalPlans?(): Promise<WorkLocalPlanStates>
  setupLocalPlan?(plan: WorkLocalPlan, action: WorkLocalPlanAuthAction): Promise<string | void>
  /** The owner's consent client (gate 4b-2), and this Mac's device-service id so the page can name "This Mac". */
  consent?: Pick<WorkConsentClient, 'read' | 'revoke' | 'set'>
  deviceServiceId?(): string | undefined
  eligiblePlanAgents?(): Promise<string[]>
}

export interface WorkSurfaceOptions {
  /** Defer speculative work while the host is busy; foreground opens never wait for this. */
  canPrewarm?(): boolean
  getSurfaceMode?(): Promise<WorkSurfaceModeSnapshot | null>
  getSidebar?(): WorkSidebarSnapshot | null
  getAttention?(): WorkAttentionSnapshot | null
  runCommand?(command: WorkBandCommand): Promise<boolean>
  setSurfaceMode?(projectId: string, mode: 'work' | 'code'): Promise<void>
  createView(incarnation: WorkIncarnation): WorkViewHandle
  publish(projection: MatrixWorkProjection | null): void
  /** Stable codes only: never a URL, a token or a path. */
  log?(line: string): void
  /** The owner's Work switch (§8.5): off runs the cutoff and stops the server, on lets it start again. */
  setWork?(on: boolean): Promise<void>
}

/** A run must last this long before a crash resets the reconnect backoff (matches the sidecar). */
const HEALTHY_RUN_MS = 60_000

const PROTONS: Record<WorkAccess, MatrixWorkProjection['protons']> = {
  allowed: 'ok',
  empty: 'empty',
  unavailable: 'unknown'
}

type ViewPhase = 'idle' | 'starting' | 'ready' | 'unavailable'

/**
 * Lane DW's main-side half: one owner view at a time (R's rule), placed where the Work page asks, and one
 * projection for the Matrix window.
 */
export class WorkSurface {
  private parts: WorkSurfaceParts | undefined
  private handle: WorkViewHandle | undefined
  private prewarmTimer?: ReturnType<typeof setTimeout>
  private warmed = false
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recovering = false
  private recoveryFailures = 0
  private phase: ViewPhase = 'idle'
  private opening: Promise<void> | undefined
  private rect: MatrixWorkRect | null = null
  private protons: MatrixWorkProjection['protons'] = 'unknown'
  private planLimits: MatrixWorkProjection['planLimits']
  private generation = 0
  /** T3’s own provider setup screen, opened once the view is painted. */
  private pendingPath: string | undefined

  constructor(private readonly options: WorkSurfaceOptions) {}

  /** Main calls this when an account's Work is built (parts) or torn down (undefined): sign-out, switch. */
  attach(parts: WorkSurfaceParts | undefined): void {
    clearTimeout(this.prewarmTimer)
    this.warmed = false
    this.planLimits = undefined
    this.cancelRecovery()
    this.generation++
    this.closeView()
    this.parts = parts
    this.pendingPath = undefined
    this.phase = 'idle'
    this.protons = 'unknown'
    this.publish()

    if (parts) {this.schedulePrewarm()}
  }

  /** One hidden owner view, using the same pairing, account teardown and crash recovery as a visible open. */
  private schedulePrewarm(): void {
    clearTimeout(this.prewarmTimer)
    this.prewarmTimer = setTimeout(() => {
      if (!this.parts?.enabled()) {return}

      if (this.options.canPrewarm?.() === false) {
        this.schedulePrewarm()

        return
      }

      this.warmed = true
      void this.open()
    }, 2_000)
    this.prewarmTimer.unref?.()
  }

  projection(): MatrixWorkProjection | null {
    const parts = this.parts

    if (!parts) {
      return null
    }

    return {
      ...(this.planLimits?.length ? { planLimits: this.planLimits } : {}),
      view: this.viewState(parts),
      protons: this.protons
    }
  }

  /** The renderer's read also refreshes the balance, so the Add Protons action follows a top-up. */
  async read(): Promise<MatrixWorkProjection | null> {
    const generation = this.generation
    const readUsage = this.parts?.readPlanUsage
    const [, limits] = await Promise.all([this.refreshProtons(), readUsage?.().catch(() => undefined)])

    if (generation === this.generation && readUsage) {
      this.planLimits = limits
      this.publish()
    }

    return this.projection()
  }

  async readAgentPlans(principal: string): Promise<WorkAgentPlans | null> {
    const generation = this.generation
    const plans = await this.parts?.relay?.readPlans(principal)

    return generation === this.generation ? plans ?? null : null
  }

  async selectRelay(principal: string, model: string, plan?: WorkRelayPlan): Promise<WorkRelaySelection> {
    if (!this.parts?.relay) {throw new Error('work_relay_unavailable')}

    return this.parts.relay.select(principal, model, plan)
  }

  async show(rect: MatrixWorkRect): Promise<void> {
    if (!this.rect) {this.options.log?.('[atum-work] startup phase=click ms=0 at=' + Date.now())}
    clearTimeout(this.prewarmTimer)
    this.rect = rect

    if (this.phase === 'ready') {
      this.handle?.place(rect)

      return
    }

    if (this.phase === 'idle' || this.phase === 'starting' || this.recovering) {
      await this.open()
    }
  }

  async hide(): Promise<void> {
    this.rect = null
    this.handle?.place(null)
  }

  async retry(): Promise<void> {
    if (this.phase === 'starting') {
      return
    }

    clearTimeout(this.recoveryTimer)
    this.closeView()
    this.phase = 'idle'
    await this.open()
  }

  getSurfaceMode() { return this.options.getSurfaceMode?.() ?? Promise.resolve(null) }

  async getSidebar() { return this.options.getSidebar?.() ?? null }
  async getAttention() { return this.options.getAttention?.() ?? null }

  async runCommand(command: WorkBandCommand): Promise<boolean> {
    // The click lands in the Atum renderer; New thread ends in the view's composer, so the view takes focus first.
    if (command === 'chat.new') {
      this.handle?.focus?.()
    }

    return (await this.options.runCommand?.(command)) ?? false
  }

  setSurfaceMode(projectId: string, mode: 'work' | 'code') {
    if (!this.options.setSurfaceMode) {return Promise.reject(new Error('work_unavailable'))}

    return this.options.setSurfaceMode(projectId, mode)
  }

  async openPlanConnect(plan: AccountPlan = 'codex'): Promise<void> {
    const parts = this.parts

    if (!parts?.enabled()) {
      return
    }

    // Only ChatGPT ever had a cloud copy (S2 carry); Claude and Antigravity open their screen at once.
    if (plan === 'codex') {
      await parts.prepareChatGptConnect?.()
    }

    if (this.parts !== parts || !parts.enabled()) {
      return
    }

    this.pendingPath = workPlanConnectPath(plan)

    if (this.phase === 'ready') {
      await this.followPendingPath()
    }
  }

  /** The account's connections. Null while no account's Work is attached here (nothing to read with). */
  async readConnections(): Promise<AccountConnectionsView | null> {
    return (await this.parts?.readConnections?.()) ?? null
  }

  /** First run: this Mac's four connections. Empty while no account's Work is attached or T3 has not answered. */
  async readPlanLabels(): Promise<FirstRunLabels> {
    const generation = this.generation
    const labels = await this.parts?.readPlanLabels?.()

    return generation === this.generation ? labels ?? {} : {}
  }

  async readLocalPlans(): Promise<WorkLocalPlanStates> {
    const parts = this.parts
    const states = await parts?.readLocalPlans?.()

    return this.parts === parts ? states ?? {} : {}
  }

  async localPlanAction(plan: WorkLocalPlan, action: WorkLocalPlanAction): Promise<string | void> {
    const parts = this.parts

    if (action === 'manage') {
      this.pendingPath = `/settings/providers?instanceId=${plan}`
      if (this.phase === 'ready') {await this.followPendingPath()}

      return
    }

    if (this.phase !== 'ready') {
      clearTimeout(this.prewarmTimer)
      await this.open()
    }
    if (this.parts !== parts || !parts?.enabled() || !parts.setupLocalPlan) {
      throw new Error('work_setup_unavailable')
    }
    return parts.setupLocalPlan(plan, action)
  }

  /** Project the owner’s account consent and the eligible assistants. */
  async readPlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const parts = this.parts
    const consent = this.consentDoor()
    const [record, entitled] = await Promise.all([
      consent.read(plan), parts?.eligiblePlanAgents?.().catch(() => []) ?? []
    ])

    if (this.parts !== parts) {throw new Error('work_account_changed')}

    return projectWorkConsent(record, parts?.deviceServiceId?.(), entitled)
  }

  /** Express opt-in: the owner named these assistants and Macs. Main sends nothing the page did not name. */
  async setPlanConsent(input: MatrixWorkPlanConsentInput, plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const parts = this.parts
    const consent = this.consentDoor()
    await consent.set({ ...(plan ? { provider: plan } : {}), agents: input.agents, devices: input.macs, alsoWhenScheduled: input.alsoWhenScheduled })
    if (this.parts !== parts) {throw new Error('work_account_changed')}

    return this.readPlanConsent(plan)
  }

  async revokePlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const parts = this.parts
    const consent = this.consentDoor()

    if (plan) {await consent.revoke(plan)}
    else {await consent.revoke()}

    if (this.parts !== parts) {throw new Error('work_account_changed')}

    return this.readPlanConsent(plan)
  }

  /**
   * Settings: Work off or on for this account on this Mac. Off closes the view, stops the server, and clears native
   * publication. On clears the marker so the next open can start the server.
   */
  async setWork(on: boolean): Promise<void> {
    if (!this.parts) {
      return
    }

    if (!on) {
      clearTimeout(this.prewarmTimer)
      this.warmed = false
      this.cancelRecovery()
      this.closeView()
      this.phase = 'idle'
      this.protons = 'unknown'
    }

    try {
      await this.options.setWork?.(on)
    } finally {
      this.publish()
    }
  }

  private consentDoor(): NonNullable<WorkSurfaceParts['consent']> {
    const consent = this.parts?.consent

    if (!consent) {
      throw Object.assign(new Error('work_consent_unavailable'), { code: 'work_consent_unavailable' })
    }

    return consent
  }

  private async followPendingPath(): Promise<void> {
    const path = this.pendingPath
    const port = this.handle?.port

    if (!path || !port) {
      return
    }

    this.pendingPath = undefined

    try {
      const origin = new URL(port.currentUrl()).origin
      await port.load(`${origin}${path}`)
    } catch {
      this.options.log?.('[work-surface] plan_connect_open_failed')
    }
  }

  private viewState(parts: WorkSurfaceParts): MatrixWorkViewState {
    if (!parts.enabled()) {
      return 'off'
    }

    return this.phase === 'ready' ? 'ready' : this.phase === 'unavailable' ? 'unavailable' : 'starting'
  }

  private open(): Promise<void> {
    const parts = this.parts

    if (!parts || !parts.enabled()) {
      this.publish()

      return Promise.resolve()
    }

    this.opening ??= this.openOnce(parts, this.generation).finally(() => {
      this.opening = undefined
    })

    return this.opening
  }

  private async openOnce(parts: WorkSurfaceParts, generation: number): Promise<void> {
    const startedAt = Date.now()
    this.options.log?.(`[atum-work] startup phase=view-start ms=0 at=${startedAt}`)
    this.phase = 'starting'
    this.publish()

    let outcome: OpenOwnerView

    try {
      outcome = await parts.session.openOwnerView(incarnation => {
        if (generation !== this.generation || !parts.enabled()) {throw new Error('work_open_cancelled')}
        const handle = this.options.createView(incarnation)
        this.handle = handle

        return handle.port
      })
    } catch (error) {
      outcome = { state: 'failed', reason: (error as { code?: string }).code ?? 'open_failed' }
    }

    if (generation !== this.generation || !parts.enabled()) {
      // The account changed or Work was turned off while the view opened.
      if (outcome.state !== 'failed') {
        outcome.view.close()
      }

      return
    }

    if (outcome.state === 'failed') {
      this.options.log?.(`[work-surface] view_failed ${outcome.reason}`)
      this.closeView()
      this.phase = 'unavailable'
      this.publish()

      if (this.recovering) {this.scheduleRecovery(generation)}

      return
    }

    const handle = this.handle
    this.phase = 'ready'
    this.recovering = false
    const readyAt = Date.now()
    void outcome.incarnation.unexpectedExit?.then(unexpected => {
      if (unexpected && this.handle === handle && generation === this.generation) {
        // Only a healthy run earns a fresh backoff; a view that pairs and dies at once keeps backing off.
        if (Date.now() - readyAt >= HEALTHY_RUN_MS) {this.recoveryFailures = 0}
        this.closeView()
        this.phase = 'unavailable'
        this.recovering = true
        this.publish()
        this.scheduleRecovery(generation)
      }
    })
    outcome.view.onClosed(() => {
      if (this.handle === handle && generation === this.generation) {
        // Crashed or closed underneath us: say so, with "Try again". A view that dies at once must not reopen in a loop.
        this.handle = undefined
        this.phase = 'unavailable'
        this.publish()
      }
    })
    handle?.place(this.rect)
    this.options.log?.(`[atum-work] startup phase=view-ready ms=${Date.now() - startedAt} at=${Date.now()}`)
    this.publish()
    void this.refreshProtons().then(() => {if (generation === this.generation) {this.publish()}})
    await this.followPendingPath()
  }

  private cancelRecovery(): void {
    clearTimeout(this.recoveryTimer)
    this.recovering = false
    this.recoveryFailures = 0
  }

  private scheduleRecovery(generation: number): void {
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = setTimeout(() => {
      if (generation === this.generation && this.recovering && (this.rect || this.warmed) && this.parts?.enabled()) {
        void this.retry()
      }
    }, Math.min(30_000, 1_000 * 2 ** Math.min(this.recoveryFailures++, 5)))
    this.recoveryTimer.unref?.()
  }

  private closeView(): void {
    const handle = this.handle
    this.handle = undefined
    handle?.place(null)
    handle?.port.close()
  }

  private async refreshProtons(): Promise<void> {
    const read = this.parts?.readAccess
    const generation = this.generation

    if (!read || this.phase !== 'ready') {
      return
    }

    try {
      const access = await read()

      if (generation === this.generation) {this.protons = PROTONS[access]}
    } catch {
      if (generation === this.generation) {this.protons = 'unknown'}
    }
  }

  private publish(): void {
    this.options.publish(this.projection())
  }
}

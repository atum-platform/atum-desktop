import type { AccountConnectionsView, AccountPlan } from '../../../shared/account-connections'
import type {
  MatrixWorkPlanConsent,
  MatrixWorkPlanConsentInput,
  MatrixWorkProjection,
  MatrixWorkRect,
  MatrixWorkViewState,
  WorkAttentionSnapshot,
  WorkBandCommand,
  WorkSidebarSnapshot,
  WorkSurfaceModeSnapshot
} from '../../../shared/matrix-work'
import type { WorkRelayPlan, WorkRelayRoomView, WorkRelaySelection } from '../../../shared/matrix-work-relay'
import type { GateEvent } from '../gate/gate'
import type { WorkConsentClient } from '../gate/platform'
import type { OwnerViewPort } from '../session/pairing'
import type { OpenOwnerView } from '../session/session'
import type { WorkAccess } from '../sidecar/host'
import type { WorkIncarnation } from '../sidecar/process'

import {
  type GateSurfaceState,
  projectWorkAgents,
  projectWorkAssistants,
  projectWorkConsent,
  projectWorkPlan,
  projectWorkPlanConnect,
  workPlanConnectPath
} from './projection'

/** The owner view as main paints it: R's port, plus where it sits in the Matrix window (null: off the window). */
export interface WorkViewHandle {
  port: OwnerViewPort
  place(rect: MatrixWorkRect | null): void
  /** Moves keyboard focus into the view, so a band command that lands in its composer shows the caret. */
  focus?(): void
}

/** The parts of one signed-in account's Work. Main builds them (lanes S, R, G) and hands them over. */
export interface WorkSurfaceParts {
  planConnectOpen?(): boolean
  relay?: {
    read(principal: string, roomId: string): Promise<WorkRelayRoomView>
    select(principal: string, expectedRevision: number, model: string, plan?: WorkRelayPlan): Promise<WorkRelaySelection>
    stop(roomId: string, eventId: string): Promise<void>
    chats(): string[]
  }
  session: { openOwnerView(createView: (incarnation: WorkIncarnation) => OwnerViewPort): Promise<OpenOwnerView> }
  /** S's per-account Work off marker (§8.5). Off: nothing starts, the page says so. */
  enabled(): boolean
  /** Lane G's door. Absent while this Mac has no Work route for the account. */
  gate?: {
    state(): GateSurfaceState
    on(listener: (event: GateEvent) => void): () => void
    acceptWorkGrant(): Promise<void>
    setSwitch(on: boolean): Promise<void>
    /** Gate 4b: "Agents may use my ChatGPT plan here" on this Mac. */
    setPlanSwitch?(on: boolean): Promise<void>
    openRoute(): Promise<void>
    closeRoute(): Promise<void>
  }
  /** S's balance read for the Atum provider (`readModelAccess`). */
  readAccess?(): Promise<WorkAccess>
  readPlanUsage?(): Promise<MatrixWorkProjection['planLimits']>
  /** The account's legacy cloud login must be retired before opening native Codex setup. */
  prepareChatGptConnect?(): Promise<void>
  /** `atum.account-connections/1`, or this Mac's own plan facts when the registry cannot be read. */
  readConnections?(): Promise<AccountConnectionsView | null>
  /** The owner's consent client (gate 4b-2), and this Mac's device-service id so the page can name "This Mac". */
  consent?: Pick<WorkConsentClient, 'read' | 'revoke' | 'set'>
  deviceServiceId?(): string | undefined
  /** First use: the owner opened Work, so main starts what a sign-in does not (the server and the gate). Never rejects. */
  wantServer?(): Promise<void>
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
 * projection of S, R and G for the Matrix window. It holds no credential and decides no admission.
 */
export class WorkSurface {
  private parts: WorkSurfaceParts | undefined
  private detachGate: (() => void) | undefined
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
  private planLimit: MatrixWorkProjection['planLimit']
  private planLimits: MatrixWorkProjection['planLimits']
  private generation = 0
  /** While a restart of the session server runs, nothing opens a view: it would start a second server. */
  private holds = 0
  /** Gate 4a: T3's own connect screen, opened in the view as soon as it is painted. */
  private pendingPath: string | undefined

  constructor(private readonly options: WorkSurfaceOptions) {}

  /** Main calls this when an account's Work is built (parts) or torn down (undefined): sign-out, switch. */
  attach(parts: WorkSurfaceParts | undefined): void {
    clearTimeout(this.prewarmTimer)
    this.warmed = false
    this.planLimit = undefined
    this.planLimits = undefined
    this.cancelRecovery()
    this.generation++
    this.detachGate?.()
    this.detachGate = undefined
    this.closeView()
    this.parts = parts
    this.pendingPath = undefined
    this.phase = 'idle'
    this.protons = 'unknown'
    this.detachGate = parts?.gate?.on(() => this.publish())
    this.publish()

    if (parts) {this.schedulePrewarm()}
  }

  /** One hidden owner view, using the same pairing, account teardown and crash recovery as a visible open. */
  private schedulePrewarm(): void {
    clearTimeout(this.prewarmTimer)
    this.prewarmTimer = setTimeout(() => {
      if (!this.parts?.enabled()) {return}

      if (this.holds > 0 || this.options.canPrewarm?.() === false) {
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

    const gate = parts.gate?.state()

    const plan = projectWorkPlan(gate)
    const planConnect = parts.enabled() ? projectWorkPlanConnect(gate) : undefined

    return {
      ...(parts.relay ? { relayChats: parts.relay.chats() } : {}),
      ...(this.planLimit ? { planLimit: this.planLimit } : {}),
      ...(this.planLimits?.length ? { planLimits: this.planLimits } : {}),
      ...(gate?.relayAccountConsent ? { relayAccountConsent: true } : {}),
      ...(gate?.connectedPlans?.length ? { connectedPlans: gate.connectedPlans } : {}),
      view: this.viewState(parts),
      assistants: projectWorkAssistants(gate),
      ...(plan ? { plan } : {}),
      ...(planConnect ? { planConnect } : {}),
      agents: projectWorkAgents(gate),
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

  async readRelay(principal: string, roomId: string): Promise<WorkRelayRoomView> {
    if (!this.parts?.relay) {throw new Error('work_relay_unavailable')}
    const generation = this.generation
    const view = await this.parts.relay.read(principal, roomId)

    if (generation !== this.generation) {throw new Error('work_relay_account_changed')}
    const limit = view.status?.limits.find(limit => limit.plan === view.status?.selection?.plan)
    this.planLimit = limit
    this.publish()

    return view
  }

  async selectRelay(principal: string, expectedRevision: number, model: string, plan?: WorkRelayPlan): Promise<WorkRelaySelection> {
    if (!this.parts?.relay) {throw new Error('work_relay_unavailable')}

    return this.parts.relay.select(principal, expectedRevision, model, plan)
  }

  async stopRelay(roomId: string, eventId: string): Promise<void> {
    if (!this.parts?.relay) {throw new Error('work_relay_unavailable')}
    await this.parts.relay.stop(roomId, eventId)
    this.publish()
  }

  async show(rect: MatrixWorkRect): Promise<void> {
    if (!this.rect) {this.options.log?.('[atum-work] startup phase=click ms=0 at=' + Date.now())}
    clearTimeout(this.prewarmTimer)
    this.rect = rect

    if (this.holds > 0) {
      return
    }

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

  /**
   * Run `work` (a restart of the session server) with the view closed, then paint it again if the page is still
   * showing. Whatever asks for a view meanwhile (a resize, "Try again") waits: a second open would start a second
   * server beside the one being restarted.
   */
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    this.cancelRecovery()
    this.holds++
    this.closeView()
    this.phase = 'idle'
    this.publish()

    try {
      return await work()
    } finally {
      this.holds--

      if (this.holds === 0 && (this.rect || this.warmed) && this.parts?.enabled()) {
        void this.open()
      }
    }
  }

  async retry(): Promise<void> {
    if (this.holds > 0 || this.phase === 'starting') {
      return
    }

    clearTimeout(this.recoveryTimer)
    this.closeView()
    this.phase = 'idle'
    await this.open()
  }

  /** D9: the enrollment text was read and accepted here. The grant opens the route; the switch follows it. */
  async allowAssistants(): Promise<void> {
    const gate = this.parts?.gate

    if (!gate) {
      return
    }

    await gate.acceptWorkGrant()
    await gate.setSwitch(true)
    await this.bindRoute()
  }

  async setAssistants(on: boolean): Promise<void> {
    const gate = this.parts?.gate

    if (!gate) {
      return
    }

    await gate.setSwitch(on)

    if (on) {
      await this.bindRoute()
    } else {
      await gate.closeRoute()
      this.publish()
    }
  }

  async setPlan(on: boolean): Promise<void> {
    await this.parts?.gate?.setPlanSwitch?.(on)
    this.publish()
  }

  /**
   * Gate 4a: open T3's own Codex provider screen in the owner view (the page shows Work). Atum draws no login and never sees the
   * token: the screen, the browser sign-in and Codex's own store are T3's and Codex's.
   */
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

  /** Gate 4b-2: the account's consent, as the owner's page reads it. */
  async readPlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const consent = this.consentDoor()

    const entitled = (this.parts?.gate?.state().agents ?? []).map(agent => agent.principal)

    return projectWorkConsent(await (plan ? consent.read(plan) : consent.read()), this.parts?.deviceServiceId?.(), entitled)
  }

  /** Express opt-in: the owner named these assistants and Macs. Main sends nothing the page did not name. */
  async setPlanConsent(input: MatrixWorkPlanConsentInput, plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const consent = this.consentDoor()
    await consent.set({ ...(plan ? { provider: plan } : {}), agents: input.agents, devices: input.macs, alsoWhenScheduled: input.alsoWhenScheduled })
    return this.readPlanConsent(plan)
  }

  async revokePlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent> {
    const consent = this.consentDoor()

    if (plan) {await consent.revoke(plan)}
    else {await consent.revoke()}

    return this.readPlanConsent(plan)
  }

  async reconnectAssistants(): Promise<void> {
    await this.bindRoute()
  }

  /**
   * Settings: Work off or on for this account on this Mac. Off first stops what is painted, then main's cutoff and
   * server stop run; on only clears the marker, and the page opens the view again the next time it is shown.
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

  private async bindRoute(): Promise<void> {
    try {
      await this.parts?.gate?.openRoute()
    } catch (error) {
      // The gate records why (socket down); the page shows it. Nothing else moves.
      this.options.log?.(`[work-surface] route_bind_failed ${(error as { code?: string }).code ?? 'unknown'}`)
    }

    this.publish()
  }

  private viewState(parts: WorkSurfaceParts): MatrixWorkViewState {
    if (!parts.enabled()) {
      return 'off'
    }

    return this.phase === 'ready' ? 'ready' : this.phase === 'unavailable' ? 'unavailable' : 'starting'
  }

  private open(): Promise<void> {
    const parts = this.parts

    if (this.holds > 0) {
      return Promise.resolve()
    }

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
      // Enrollment is independent of the owner view. WorkSession itself serializes server startup.
      void parts.wantServer?.().catch(() => undefined)
      outcome = await parts.session.openOwnerView(incarnation => {
        if (generation !== this.generation || this.holds > 0 || !parts.enabled()) {throw new Error('work_open_cancelled')}
        const handle = this.options.createView(incarnation)
        this.handle = handle

        return handle.port
      })
    } catch (error) {
      outcome = { state: 'failed', reason: (error as { code?: string }).code ?? 'open_failed' }
    }

    if (generation !== this.generation) {
      // The account changed while the view opened: whatever opened belongs to the old one.
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
      if (unexpected && this.handle === handle && generation === this.generation && this.holds === 0) {
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
      if (generation === this.generation && this.recovering && (this.rect || this.warmed) && this.parts?.enabled() && this.holds === 0) {
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

import type { MatrixWorkProjection, MatrixWorkRect, MatrixWorkViewState } from '../../../shared/matrix-work'
import type { GateEvent } from '../gate/gate'
import type { OwnerViewPort } from '../session/pairing'
import type { OpenOwnerView } from '../session/session'
import type { WorkAccess } from '../sidecar/host'
import type { WorkIncarnation } from '../sidecar/process'

import { type GateSurfaceState, projectWorkAgents, projectWorkAssistants } from './projection'

/** The owner view as main paints it: R's port, plus where it sits in the Matrix window (null: off the window). */
export interface WorkViewHandle {
  port: OwnerViewPort
  place(rect: MatrixWorkRect | null): void
}

/** The parts of one signed-in account's Work. Main builds them (lanes S, R, G) and hands them over. */
export interface WorkSurfaceParts {
  session: { openOwnerView(createView: (incarnation: WorkIncarnation) => OwnerViewPort): Promise<OpenOwnerView> }
  /** S's per-account Work off marker (§8.5). Off: nothing starts, the page says so. */
  enabled(): boolean
  /** Lane G's door. Absent while this Mac has no Work route for the account. */
  gate?: {
    state(): GateSurfaceState
    on(listener: (event: GateEvent) => void): () => void
    acceptWorkGrant(): Promise<void>
    setSwitch(on: boolean): Promise<void>
    openRoute(): Promise<void>
    closeRoute(): Promise<void>
  }
  /** S's balance read for the Atum provider (`readModelAccess`). */
  readAccess?(): Promise<WorkAccess>
}

export interface WorkSurfaceOptions {
  createView(incarnation: WorkIncarnation): WorkViewHandle
  publish(projection: MatrixWorkProjection | null): void
  /** Stable codes only: never a URL, a token or a path. */
  log?(line: string): void
}

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
  private phase: ViewPhase = 'idle'
  private opening: Promise<void> | undefined
  private rect: MatrixWorkRect | null = null
  private protons: MatrixWorkProjection['protons'] = 'unknown'
  private generation = 0

  constructor(private readonly options: WorkSurfaceOptions) {}

  /** Main calls this when an account's Work is built (parts) or torn down (undefined): sign-out, switch. */
  attach(parts: WorkSurfaceParts | undefined): void {
    this.generation++
    this.detachGate?.()
    this.detachGate = undefined
    this.closeView()
    this.parts = parts
    this.phase = 'idle'
    this.protons = 'unknown'
    this.detachGate = parts?.gate?.on(() => this.publish())
    this.publish()
  }

  projection(): MatrixWorkProjection | null {
    const parts = this.parts

    if (!parts) {
      return null
    }

    const gate = parts.gate?.state()

    return {
      view: this.viewState(parts),
      assistants: projectWorkAssistants(gate),
      agents: projectWorkAgents(gate),
      protons: this.protons
    }
  }

  /** The renderer's read also refreshes the balance, so the Add Protons action follows a top-up. */
  async read(): Promise<MatrixWorkProjection | null> {
    await this.refreshProtons()

    return this.projection()
  }

  async show(rect: MatrixWorkRect): Promise<void> {
    this.rect = rect

    if (this.phase === 'ready') {
      this.handle?.place(rect)

      return
    }

    if (this.phase === 'idle') {
      await this.open()
    }
  }

  async hide(): Promise<void> {
    this.rect = null
    this.handle?.place(null)
  }

  async retry(): Promise<void> {
    if (this.phase !== 'unavailable') {
      return
    }

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

  async reconnectAssistants(): Promise<void> {
    await this.bindRoute()
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
    this.phase = 'starting'
    this.publish()

    let outcome: OpenOwnerView

    try {
      outcome = await parts.session.openOwnerView(incarnation => {
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

      return
    }

    const handle = this.handle
    this.phase = 'ready'
    outcome.view.onClosed(() => {
      if (this.handle === handle && generation === this.generation) {
        // Crashed or closed underneath us: the next show opens it again.
        this.handle = undefined
        this.phase = 'idle'
        this.publish()
      }
    })
    handle?.place(this.rect)
    await this.refreshProtons()
    this.publish()
  }

  private closeView(): void {
    const handle = this.handle
    this.handle = undefined
    handle?.place(null)
    handle?.port.close()
  }

  private async refreshProtons(): Promise<void> {
    const read = this.parts?.readAccess

    if (!read || this.phase !== 'ready') {
      return
    }

    try {
      this.protons = PROTONS[await read()]
    } catch {
      this.protons = 'unknown'
    }
  }

  private publish(): void {
    this.options.publish(this.projection())
  }
}

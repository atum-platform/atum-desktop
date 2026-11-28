/**
 * The Screen's one transport seam: how the side panel reaches the agent's cloud screen. Every call
 * the viewer makes goes through `AgentScreenTransport`; nothing else in the pane knows where the
 * screen lives. Workstream B (atum-platform `feat/agent-browser-contract`, plan step S2) owns the
 * wire contract and S3 the controller/hub route. Until they land, the shapes below follow the
 * plan's S2 description and the native Hermes lease they map onto:
 *
 * - `observe` = `display.observe`: mints this window's viewer id and a single-use, short-lived
 *   stream grant (≤30 s), bound by the server to the owner, the agent and this device. Watching is
 *   read-only; input reaches the screen only from the lease holder (the native RFB filter).
 * - `acquire` = `display.lease.acquire` (`mode: control`): the owner takes control. The lease
 *   epoch is the contract's control revision.
 * - `release` = `display.lease.release`: the owner hands back. `released` is true only for the call
 *   that actually ended this owner's control, so a retry, a second window or a second device never
 *   gets `true` twice: that is what makes the "carry on" message once-only (owner D2).
 * - `status` = `display.status`: running and the lease, polled while the panel is open.
 *
 * Swapping in the real transport is one change: give the preload bridge an `agentScreen` that
 * implements this interface. Without one the Screen stays hidden (no dead buttons).
 */

/** Who drives the screen. `agent` is also the resting state (nobody is watching). */
export type AgentScreenHolder = 'agent' | 'human'

export interface AgentScreenLease {
  holder: AgentScreenHolder
  /** The native lease epoch; the contract's control revision. Advances on takeover and release. */
  epoch: number
  /** First 12 hex of sha256(viewer id) of the human holder. The raw id never travels. */
  viewerHash: string | null
}

export interface AgentScreenStatus {
  running: boolean
  lease: AgentScreenLease
}

/** One watch attach: the minted viewer and the stream it may dial once. */
export interface AgentScreenGrant {
  viewerId: string
  /** The hub's stream URL carrying the single-use ticket. Never logged. */
  streamUrl: string
  expiresAt: number
  status: AgentScreenStatus
}

/** Who the screen belongs to: the agent and its owner's chat with it. The server checks the caller
 * against the agent's authoritative owner binding (owner D3); the client only names the agent. */
export interface AgentScreenBinding {
  agentPrincipal: string
  roomId: string
}

export type AgentScreenRefusal =
  | 'not_owner'
  | 'ticket_reused'
  | 'ticket_expired'
  | 'stale_revision'
  | 'not_holder'
  | 'unavailable'

export class AgentScreenError extends Error {
  constructor(readonly reason: AgentScreenRefusal) {
    super(`agent_screen_${reason}`)
  }
}

export interface AgentScreenTransport {
  status(binding: AgentScreenBinding): Promise<AgentScreenStatus>
  /** `viewerId`: re-present this window's id so a reconnect keeps its control. */
  observe(binding: AgentScreenBinding, input: { viewerId?: string }): Promise<AgentScreenGrant>
  acquire(
    binding: AgentScreenBinding,
    input: { viewerId: string; expectedEpoch: number }
  ): Promise<{ lease: AgentScreenLease }>
  release(
    binding: AgentScreenBinding,
    input: { viewerId: string } | { force: true }
  ): Promise<{ lease: AgentScreenLease; released: boolean }>
}

/** The bridge's transport, when this build has one. */
export function agentScreenTransport(): AgentScreenTransport | null {
  const bridge = (globalThis as { atumMatrix?: { agentScreen?: AgentScreenTransport } }).atumMatrix

  return bridge?.agentScreen ?? null
}

/** `viewer_hash` as the lease names its holder: first 12 hex of sha256(viewer id). */
export async function agentScreenViewerHash(viewerId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(viewerId))

  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/**
 * An in-memory screen that behaves like the native lease, for the playground, screenshots and
 * tests until workstream B lands. `streamUrl` is empty: the pane paints no frames from it.
 */
export function mockAgentScreenTransport(
  options: { running?: boolean; owner?: boolean; now?: () => number } = {}
): AgentScreenTransport & { lease(): AgentScreenLease; setRunning(running: boolean): void } {
  const now = options.now ?? Date.now
  let running = options.running ?? true
  let lease: AgentScreenLease = { holder: 'agent', epoch: 0, viewerHash: null }
  let minted = 0
  const viewers = new Set<string>()

  const guard = () => {
    if (options.owner === false) {
      throw new AgentScreenError('not_owner')
    }
  }

  return {
    lease: () => lease,
    setRunning: value => {
      running = value
    },
    async status() {
      guard()

      return { running, lease }
    },
    async observe(_binding, input) {
      guard()

      const viewerId = input.viewerId && viewers.has(input.viewerId) ? input.viewerId : `viewer-${++minted}`
      viewers.add(viewerId)

      return { viewerId, streamUrl: '', expiresAt: now() + 30_000, status: { running, lease } }
    },
    async acquire(_binding, input) {
      guard()

      if (!viewers.has(input.viewerId)) {
        throw new AgentScreenError('not_holder')
      }

      if (input.expectedEpoch !== lease.epoch) {
        throw new AgentScreenError('stale_revision')
      }

      const viewerHash = await agentScreenViewerHash(input.viewerId)

      // The holder taking over again is idempotent, like the native lease.
      if (lease.holder !== 'human' || lease.viewerHash !== viewerHash) {
        lease = { holder: 'human', epoch: lease.epoch + 1, viewerHash }
      }

      return { lease }
    },
    async release(_binding, input) {
      guard()

      // Forced recovery clears whoever holds control, and never counts as this owner's hand back:
      // it must not author a "carry on" (Astra D2).
      if ('force' in input) {
        if (lease.holder === 'human') {
          lease = { holder: 'agent', epoch: lease.epoch + 1, viewerHash: null }
        }

        return { lease, released: false }
      }

      const viewerHash = await agentScreenViewerHash(input.viewerId)

      if (lease.holder !== 'human' || lease.viewerHash !== viewerHash) {
        return { lease, released: false }
      }

      lease = { holder: 'agent', epoch: lease.epoch + 1, viewerHash: null }

      return { lease, released: true }
    }
  }
}

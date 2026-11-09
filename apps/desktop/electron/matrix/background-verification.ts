import type { MatrixVerification } from '../../shared/matrix-security'

/** The agent device main is checking by itself (agent-trust.ts), while it does. */
export interface MatrixBackgroundPeer {
  userId: string
  deviceId: string
}

/** Ids kept hidden after the check ends, so its last state ("cancelled", "done") never shows. */
const KEEP = 32

/**
 * Whether a verification the person's device shows is main's own background check of an agent
 * (docs: quiet verification, C1). Only a request this device sent to that exact agent device is
 * main's: one the other side started (`incoming`) or one to any other device never is, even on
 * the agent's own account. Before the agent accepts, the SDK leaves the device ID of a request
 * this device sent empty; only then is the account enough, and only while main's own start is
 * under way or done (the SDK runs one verification at a time, so that request is main's).
 */
export function matrixBackgroundVerificationMatch(
  verification: MatrixVerification,
  peer: MatrixBackgroundPeer | undefined
): boolean {
  if (!peer || verification.incoming || verification.userId !== peer.userId) {
    return false
  }

  return verification.deviceId === peer.deviceId || (verification.state === 'requested' && verification.deviceId === '')
}

/**
 * Main's background checks of agents, kept out of the window. The window gets a verification
 * only when it is the person's: one they started from Settings, or one another person or device
 * started. The person's controls cannot answer a hidden one either (`hidden`).
 */
export class MatrixBackgroundVerifications {
  private peer: MatrixBackgroundPeer | undefined
  private label = ''
  private started = 0
  /** Ids first matched while main's own start had not succeeded yet. */
  private pending = new Set<string>()
  private ids: string[] = []
  private ended = new Set<string>()
  /** A request already on screen when the check began: the person's, never hidden. */
  private foreign: string | undefined
  /** An incoming request seen while a check ran, and whether its cancel was logged. */
  private incoming = new Map<string, boolean>()

  constructor(
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Main is about to start its own request to this agent device. `current`: the verification the
   * person's device holds right now, which is theirs.
   */
  begin(peer: MatrixBackgroundPeer, label: string, current: MatrixVerification | undefined): void {
    this.peer = { userId: peer.userId, deviceId: peer.deviceId }
    this.label = label
    this.started = this.now()
    this.pending.clear()
    this.foreign = current && current.state !== 'done' && current.state !== 'cancelled' ? current.id : undefined
  }

  /** Main's start went through: what it matched is main's. */
  confirm(): void {
    this.pending.clear()
  }

  /** Main's start was refused (another verification was pending): what it matched is not main's. */
  abandon(): void {
    this.ids = this.ids.filter(id => !this.pending.has(id))
    this.pending.clear()
    this.peer = undefined
  }

  /** The check is over, however it ended. Its ids stay hidden. */
  end(): void {
    this.pending.clear()
    this.peer = undefined
    this.incoming.clear()
  }

  /** Whether the person's device must not show, or answer, this request. */
  hidden(id: string): boolean {
    return this.ids.includes(id)
  }

  /** The verification as the window may see it: undefined when it is main's own. */
  view(verification: MatrixVerification | undefined): MatrixVerification | undefined {
    if (!verification) {
      return verification
    }

    if (verification.incoming) {
      this.noteIncoming(verification)

      return verification
    }

    if (
      !this.hidden(verification.id) &&
      verification.id !== this.foreign &&
      matrixBackgroundVerificationMatch(verification, this.peer)
    ) {
      this.ids.push(verification.id)
      this.pending.add(verification.id)

      if (this.ids.length > KEEP) {
        this.ids.splice(0, this.ids.length - KEEP)
      }
    }

    if (!this.hidden(verification.id)) {
      return verification
    }

    if ((verification.state === 'done' || verification.state === 'cancelled') && !this.ended.has(verification.id)) {
      this.ended.add(verification.id)

      if (this.ended.size > KEEP) {
        this.ended.delete(this.ended.values().next().value!)
      }

      this.log(
        `[Matrix] agent ${this.label || 'root'} trust handshake=background state=${verification.state} code=${verification.cancelCode ?? '-'} ms=${this.now() - this.started}`
      )
    }

    return undefined
  }

  /** The person's device cancels a request from elsewhere while a check runs (security.ts): the
   * cost of keeping the check quiet, so it is counted. */
  private noteIncoming(verification: MatrixVerification): void {
    if (!this.peer) {
      return
    }

    const logged = this.incoming.get(verification.id)

    if (logged === undefined) {
      this.incoming.set(verification.id, false)
    }

    if (verification.state === 'cancelled' && logged !== true) {
      this.incoming.set(verification.id, true)
      this.log('[Matrix] security incoming verification cancelled during background handshake')
    }
  }
}

/** A launch that has not settled by then is summed up anyway. */
const LAUNCH_SUMMARY_MS = 120_000

/**
 * One log line per launch in place of anything on screen (quiet verification, §6): how many
 * agents, how many ready, how their trust went and how long it took, counted once every agent's
 * start has settled, or at two minutes. Closed counts only, never an ID.
 */
export class MatrixLaunchSummary {
  private started: number | undefined
  private logged = false
  private trust = { cross_signed: 0, verified: 0, failed: 0 }

  constructor(
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  /** One agent's trust step ended. */
  trusted(result: 'cross_signed' | 'verified' | 'failed'): void {
    this.trust[result] += 1
  }

  /** The agents as the window sees them now; `undefined` while signed out. */
  observe(agents: readonly { readiness?: { phase: string; code?: string } }[] | undefined): void {
    if (this.logged || !agents?.length) {
      return
    }

    const now = this.now()
    this.started ??= now
    const reconnecting = agents.filter(agent => agent.readiness?.code === 'agent_reconnecting').length

    const settled = agents.every(agent => agent.readiness && agent.readiness.phase !== 'starting') && !reconnecting

    if (!settled && now - this.started < LAUNCH_SUMMARY_MS) {
      return
    }

    this.logged = true
    const ready = agents.filter(agent => agent.readiness?.phase === 'ready').length
    const { cross_signed, verified, failed } = this.trust

    this.log(
      `[Matrix] launch quiet agents=${agents.length} ready=${ready} cross_signed=${cross_signed} verified=${verified} failed=${failed} reconnecting=${reconnecting} ms=${now - this.started}`
    )
  }
}

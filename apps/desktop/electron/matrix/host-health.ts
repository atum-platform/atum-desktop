import type { MatrixSnapshot } from '../../shared/matrix'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export type MatrixHostLiveness = 'live' | 'degraded' | 'down'

export function matrixHostLiveness(snapshot: Pick<MatrixSnapshot, 'state' | 'degraded'>): MatrixHostLiveness {
  if (snapshot.state !== 'ready') {
    return 'down'
  }

  return snapshot.degraded === true ? 'degraded' : 'live'
}

/** The host cannot carry a turn's question or answer: the turns that read or post through it end. */
export function matrixHostEndsTurns(liveness: MatrixHostLiveness, humanReplacement = false): boolean {
  return liveness === 'down' && !humanReplacement
}

/** What main keeps of a host between snapshots. `ready` includes degraded; `degraded` marks it. */
export interface MatrixHostState {
  ready?: boolean
  degraded?: boolean
}

/**
 * Whether new claims may start through these hosts: each one is ready and none is degraded. A
 * claim already in flight (a watch armed, a turn running, a lease held) does not ask.
 */
export function matrixHostsTakeNewClaims(hosts: ReadonlyArray<MatrixHostState | undefined>): boolean {
  return hosts.every(host => host?.ready === true && host.degraded !== true)
}

/**
 * What the lease does about the hosts it answers through (main.ts reconcileLease):
 *
 *   release   a host is down (or enrollment is gone): the lease is given up, as before.
 *   hold      a host is degraded: neither give up what is held (it keeps renewing in the
 *             background, and a turn in flight keeps its authority) nor claim anything new. The
 *             lease ends here only through a real loss: a renewal refused, the wall clock past its
 *             term, or authority withdrawn (lease.ts), none of which is a host blip. An admitted
 *             room turn also holds through an SDK renderer restart: the main-owned Hermes process
 *             and lease do not belong to that renderer.
 *   proceed   the hosts are live: demand decides, as before.
 */
export type MatrixLeaseHostAction = 'release' | 'hold' | 'proceed'

export function matrixLeaseHostAction(input: {
  /** The agent is enrolled with an identity. */
  enrolled: boolean
  /** The agent's host. */
  agent: MatrixHostState | undefined
  /** The person's host: `ready` is main's human readiness (state.state, not host.ready). */
  human: MatrixHostState | undefined
  /** A room turn already admitted under the exact held term. */
  admitted?: boolean
  /** Main-authorized same-account human replacement; never a renderer flag. */
  humanReplacement?: boolean
}): MatrixLeaseHostAction {
  if (!input.enrolled) {
    return 'release'
  }

  if (input.humanReplacement && input.agent?.ready === true) {
    return 'hold'
  }

  if (input.admitted && input.agent?.ready !== false && input.human?.ready !== false) {
    return 'hold'
  }

  if (input.agent?.ready !== true || input.human?.ready !== true) {
    return 'release'
  }

  return input.agent.degraded === true || input.human.degraded === true ? 'hold' : 'proceed'
}

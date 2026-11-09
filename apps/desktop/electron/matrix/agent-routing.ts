import type { MatrixRoom } from '../../shared/matrix'
import { isAssistantRoom } from '../../shared/matrix-assistant-room'
/**
 * The decisions main makes about the person's several agents (per-agent runtime plan §2.3,
 * §2.4), kept pure so they are tested: which agent a room belongs to, which turns an authority
 * stop or expiry ends, and what a roster means for this Mac.
 */
import { resolveProjectedConversation } from '../../src/matrix/conversation-marker'

import type { MatrixAgentDefinitionRecord } from './agent-definition'
import { type MatrixHostRole, matrixInvocationUses } from './sdk-host'

/** The agent a room belongs to: the one that is the other member of the owner's private room
 * with it. Display state only picks the agent; every turn re-reads the room before it acts. */
export function matrixRoomAgent<T extends { userId?: string }>(
  rooms: readonly MatrixRoom[],
  roomId: string,
  ownerId: string | undefined,
  agents: readonly T[]
): T | undefined {
  const room = rooms.find(each => each.id === roomId)

  return room ? agents.find(each => isAssistantRoom(room, ownerId, each.userId)) : undefined
}

/**
 * The agent's home room: its own private room with its owner, where its scheduled jobs and its
 * check-ins (the heartbeat) post (D7, one room per agent). Never a group it is in: a group is
 * not its private room (isAssistantRoom), so nothing scheduled ever posts there. The room marked
 * main wins; unmarked private rooms: the lowest ID, so the choice is stable across starts.
 *
 * Never a room marked Earlier: a turn there is refused, so a home (or keep listening's default
 * room) there answers nothing. Rooms all marked Earlier with no main (two Macs' moves crossed,
 * 0.20.1) have no home until the conversation reconcile restores a main.
 */
export function matrixAgentHomeRoom(
  rooms: readonly MatrixRoom[],
  ownerId: string | undefined,
  agentId: string | undefined
): string | undefined {
  const resolution = resolveProjectedConversation(rooms, ownerId, agentId)

  return (
    resolution.main ??
    (ownerId && agentId
      ? rooms
          .filter(room => isAssistantRoom(room, ownerId, agentId) && !resolution.earlier.includes(room.id))
          .map(room => room.id)
          .sort()[0]
      : undefined)
  )
}

/** Retained turns belong to their original runtime, never the current default. */
export function matrixTurnAgent<T extends { localTurns?: { get(id: string): unknown } }>(
  turnId: string,
  agents: readonly T[]
): T | undefined {
  return agents.find(agent => agent.localTurns?.get(turnId))
}

/** The turns an intentional host stop or authority expiry ends: every agent's for the human host,
 * the agent's own for its host, an app's for its host. A replaceable core SDK renderer crash is
 * handled separately and preserves main-owned Hermes; one agent's host never ends another's. */
export function matrixTurnsUsing<T extends { app?: { slug: string } }>(
  role: MatrixHostRole,
  agents: ReadonlyArray<{ role: MatrixHostRole; invocation?: T }>
): T[] {
  return agents.flatMap(agent => {
    const turn = agent.invocation

    if (!turn) {
      return []
    }

    // App turns may be booked against the product-default agent while their work runs
    // in the app host. They never depend on that agent's own Hermes host.
    const uses = turn.app ? matrixInvocationUses(role, turn.app.slug) : role === 'human' || role === agent.role

    return uses ? [turn] : []
  })
}

/**
 * The turns a host's outage ends (it reports any state but ready: starting, offline,
 * signed out): those of matrixTurnsUsing that read or post through a host. A model check
 * (`setup`) only configures the agent's Hermes on this Mac, so it keeps running.
 *
 * Every host reports "connecting" first, once its page has loaded and before its first
 * sync, and the model check starts as soon as the agent's host has loaded. Ending setup
 * here killed the check's Hermes before it announced its port, at every launch and every
 * re-enrollment ("exited before port announcement (SIGTERM)", then a 3 s retry; G1-13).
 */
export function matrixTurnsNeedingHost<T extends { app?: { slug: string }; setup?: true }>(
  role: MatrixHostRole,
  agents: ReadonlyArray<{ role: MatrixHostRole; invocation?: T }>
): T[] {
  return matrixTurnsUsing(role, agents).filter(turn => !turn.setup)
}

/** An existing physical root stays pinned. A fresh root may reserve the
 * authoritative default only when that agent has no named slot on this Mac. */
export function matrixRootEnrollmentPrincipal(
  root: string | undefined,
  primary: string | undefined,
  named: ReadonlySet<string>
): string | undefined {
  return root ?? (primary && !named.has(primary) ? primary : undefined)
}

/**
 * What a roster means for this Mac's other agents. The active agents that answer in Matrix
 * run here. An agent this Mac knows that is not on the roster was retired, the only way off
 * it, so its local state goes. A roster without the person's default agent is not a whole
 * roster and retires nothing; neither does anything being created or retired here.
 * The root custody principal need not still hold the product-default role.
 */
export function matrixRosterChanges(input: {
  roster: readonly MatrixAgentDefinitionRecord[]
  /** The default agent's principal, from its enrollment; undefined before it is set up. */
  defaultPrincipal?: string
  /** Every other agent this Mac knows: its runtimes and its enrollments. */
  known: Iterable<string>
  /** Agents being created or retired here, which a roster read meanwhile must not touch. */
  keep: ReadonlySet<string>
}): { active: MatrixAgentDefinitionRecord[]; retired: string[] } {
  const known = new Set(input.known)
  const primary = input.roster.find(agent => agent.isDefault && agent.status === 'active')?.principal
  // A new root gets first choice of the default. Existing named custody keeps
  // that choice instead; neither path creates a second runtime for one agent.
  const root = matrixRootEnrollmentPrincipal(input.defaultPrincipal, primary, known)
  const active = input.roster.filter(agent => agent.status === 'active' && agent.matrixUser && agent.principal !== root)

  const whole =
    input.defaultPrincipal !== undefined &&
    input.roster.some(agent => agent.isDefault && agent.status === 'active') &&
    input.roster.some(agent => agent.principal === input.defaultPrincipal)

  const listed = new Set(input.roster.filter(agent => agent.status === 'active').map(agent => agent.principal))

  const retired = whole
    ? [...known].filter(
        principal => principal !== input.defaultPrincipal && !listed.has(principal) && !input.keep.has(principal)
      )
    : []

  return { active, retired }
}

/** Product default comes from the authenticated roster, never a vault slot or a name.
 * Refuse malformed role projections before main can relabel any runtime. */
export function matrixDefaultAgent(roster: readonly MatrixAgentDefinitionRecord[]): MatrixAgentDefinitionRecord {
  const defaults = roster.filter(agent => agent.isDefault && agent.status === 'active')

  if (
    defaults.length !== 1 ||
    !defaults[0]!.matrixUser ||
    new Set(roster.map(agent => agent.principal)).size !== roster.length
  ) {
    throw new Error('matrix_agent_roster_invalid')
  }

  return defaults[0]!
}

/** Choose the exact runtime without changing physical storage or falling back to another
 * identity when an authoritative primary is temporarily unavailable. */
export function matrixDefaultRuntime<T extends { agentPrincipal?: string }>(
  principal: string | undefined,
  root: T,
  agents: readonly T[]
): T | undefined {
  return principal === undefined ? root : agents.find(agent => agent.agentPrincipal === principal)
}

/** Resolve a requested retirement without confusing the physical root custody slot with
 * the product default. The product default is never retireable, including on a new Mac
 * where it still occupies the root slot. */
export function matrixRetirementTarget<T extends { agentPrincipal?: string }>(
  principal: string,
  rootPrincipal: string | undefined,
  root: T,
  agents: readonly T[],
  productDefault: T | undefined
): T | undefined {
  const target = rootPrincipal === principal ? root : agents.find(agent => agent.agentPrincipal === principal)

  return target === productDefault ? undefined : target
}

/** A retired root is authoritative only when the roster retains its tombstone. A missing
 * entry can be a partial roster and must never trigger local credential cleanup. */
export function matrixRetiredRootCustody(input: {
  roster: readonly MatrixAgentDefinitionRecord[]
  rootPrincipal?: string
  productDefaultPrincipal: string
}): MatrixAgentDefinitionRecord | undefined {
  if (!input.rootPrincipal || input.rootPrincipal === input.productDefaultPrincipal) {
    return undefined
  }

  const root = input.roster.find(agent => agent.principal === input.rootPrincipal)

  return root?.status === 'retired' ? root : undefined
}

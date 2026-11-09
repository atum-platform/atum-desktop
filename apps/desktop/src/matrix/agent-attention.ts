import { useEffect, useState } from 'react'

import type { MatrixAgentView, MatrixNewSignIn, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixUnverifiedOwnDevice } from '../../shared/matrix-device-trust'

/**
 * Who needs the person, and where it shows (quiet verification spec, 2026-10-05): work the app
 * does by itself never shows; an agent's own trouble stays on its row and in its chat; what the
 * whole window needs the person for is one item in the title bar's indicator. One table drives
 * the row's dot, the agent's chat and the indicator, so the three never disagree.
 */

/** `ready`: it can answer. `needs_you`: something the person does brings it back. `not_running`:
 * not answering yet, for a reason the app clears by itself or one the indicator already holds. */
export type MatrixAgentAttentionState = 'ready' | 'needs_you' | 'not_running'

/** What the title bar's indicator can hold, in the order it lists them. */
export type MatrixAttentionKind =
  | 'approval'
  | 'device_damaged'
  | 'new_sign_in'
  | 'disk_critical'
  | 'recovery'
  | 'sign_in'
  | 'protons'
  | 'runtime'
  | 'connect'
  | 'plan_sign_in'
  | 'agent'
  | 'device_unverified'
  | 'disk_low'

interface Rule {
  /** `account`: the same cause for every agent (this Mac, the account, the install): one
   * indicator item, every row a hollow ring. `agent`: this agent alone needs the person.
   * `passing`: the app clears it by itself; never shown beyond the row's ring. */
  scope: 'account' | 'agent' | 'passing'
  item?: MatrixAttentionKind
  /** How long an agent-scoped state must last before it asks for the person; absent for one
   * that is final by nature. */
  graceMs?: number
}

/** A launch's ordinary steps settle in seconds: a passing outage says nothing in its chat before
 * this. */
export const MATRIX_ATTENTION_GRACE_MS = 4_000
/** A failure the readiness gate retries by itself (a Hermes start, a model not set up yet, a step
 * that threw): its first retries (5 and 10 s, ±20%) run before it asks for the person. */
export const MATRIX_GATE_GRACE_MS = 30_000
/** A code this table does not know: past the gate's first retry and that retry's own run. */
export const MATRIX_UNKNOWN_GRACE_MS = 20_000
/** An agent's trust step that failed is tried again by the readiness watch; it asks for the
 * person only when that keeps failing this long. */
export const MATRIX_TRUST_GRACE_MS = 90_000
/** A start still running this long says so in its own chat ("it can take a minute"). */
export const MATRIX_SLOW_START_MS = 30_000

const RULES: Record<string, Rule> = {
  recovery_required: { scope: 'account', item: 'recovery' },
  device_replaced: { scope: 'account', item: 'device_damaged' },
  sign_in_required: { scope: 'account', item: 'sign_in' },
  signed_out: { scope: 'account', item: 'sign_in' },
  out_of_protons: { scope: 'account', item: 'protons' },
  action_required: { scope: 'account', item: 'connect' },
  runtime_invalid: { scope: 'account', item: 'runtime' },
  runtime_unavailable: { scope: 'account', item: 'runtime' },
  agent_reconnect_required: { scope: 'agent' },
  authority_withdrawn: { scope: 'agent' },
  setup_failed: { scope: 'agent' },
  // The person's own plan (their ChatGPT plan) has no usable native connection: its own item,
  // which opens the account connection flow (main.ts `plan_sign_in`).
  plan_sign_in: { scope: 'agent', item: 'plan_sign_in' },
  agent_trust_failed: { scope: 'agent', graceMs: MATRIX_TRUST_GRACE_MS },
  // Its identity is not made yet: still being set up, retried by its gate (a hire whose purchase
  // never finished stays here). Its row says so; nothing for the person to do.
  agent_initializing: { scope: 'passing' },
  // The gate's own failures (main.ts `startAssistantHermes`, managed-model.ts, readiness.ts).
  hermes_unavailable: { scope: 'agent', graceMs: MATRIX_GATE_GRACE_MS },
  setup_required: { scope: 'agent', graceMs: MATRIX_GATE_GRACE_MS },
  unexpected: { scope: 'agent', graceMs: MATRIX_GATE_GRACE_MS },
  offline: { scope: 'passing' },
  platform_unavailable: { scope: 'passing' },
  chat_unavailable: { scope: 'passing' },
  chat_unreachable: { scope: 'passing' },
  ai_unavailable: { scope: 'passing' },
  agent_roster_unavailable: { scope: 'passing' },
  assistant_unreachable: { scope: 'passing' },
  agent_reconnecting: { scope: 'passing' },
  rate_limited: { scope: 'passing' }
}

/** Any other code is this agent's own trouble, once it has outlasted the gate's first retry. */
const UNKNOWN: Rule = { scope: 'agent', graceMs: MATRIX_UNKNOWN_GRACE_MS }

function rule(code: string | undefined): Rule {
  return (code && RULES[code]) || UNKNOWN
}

/** Listening the person can lift: only their own Stop that this Mac could not save (the
 * reply settings say so, and its switch presses Stop again). Everything else listening meets
 * recovers by itself (0.20: an interrupted turn, an unknown outcome, an unavailable or
 * overflowing watch retry; a Mac that keeps failing hands the agent over, lease-handover.ts),
 * and renewing, busy, offline, another Mac or room, a document are the app's own business. */
export function matrixListeningNeedsYou(listening: MatrixAgentView['listening']): boolean {
  return listening?.state === 'paused' && listening.reason === 'storage'
}

export interface MatrixAgentAttention {
  state: MatrixAgentAttentionState
  /** The indicator item this agent waits on (an account-wide cause). */
  waitsOn?: MatrixAttentionKind
  /** It asks for the person because of its listening, not its readiness. */
  listening?: true
  /** Its own chat says why it cannot answer (launch-notice.tsx): what it needs, a cause the
   * indicator holds, a passing outage that outlasted a launch's settling, or a slow start. */
  chatLine?: true
  /** When this would change by time alone (a grace running out). */
  wakeAt?: number
}

type AgentFacts = Pick<MatrixAgentView, 'readiness' | 'setup' | 'listening'>

/** One agent's attention at `now`. */
export function matrixAgentAttention(agent: AgentFacts, now: number): MatrixAgentAttention {
  const readiness = agent.readiness

  if (agent.setup === 'action_required') {
    return { state: 'not_running', waitsOn: 'connect', chatLine: true }
  }

  if (agent.setup === 'failed') {
    return { state: 'needs_you', chatLine: true }
  }

  if (readiness && (readiness.phase === 'blocked' || readiness.phase === 'degraded')) {
    const found = rule(readiness.code)

    if (found.scope === 'account') {
      return { state: 'not_running', waitsOn: found.item, chatLine: true }
    }

    const wakeAt = readiness.since + (found.scope === 'passing' ? MATRIX_ATTENTION_GRACE_MS : (found.graceMs ?? 0))

    if (now < wakeAt) {
      return { state: 'not_running', wakeAt }
    }

    return found.scope === 'passing' ? { state: 'not_running', chatLine: true } : { state: 'needs_you', chatLine: true }
  }

  if (readiness?.phase === 'starting') {
    const wakeAt = readiness.since + MATRIX_SLOW_START_MS

    return now < wakeAt ? { state: 'not_running', wakeAt } : { state: 'not_running', chatLine: true }
  }

  if ((readiness && readiness.phase !== 'ready') || agent.setup === 'working') {
    return { state: 'not_running' }
  }

  if (matrixListeningNeedsYou(agent.listening)) {
    return { state: 'needs_you', listening: true }
  }

  // An older snapshot without readiness: not known to be running.
  return readiness ? { state: 'ready' } : { state: 'not_running' }
}

export interface MatrixAttentionItem {
  kind: MatrixAttentionKind
  /** `agent`: which one. */
  principal?: string
  /** `device_unverified`: which of the person's devices, by its own name. */
  device?: MatrixUnverifiedOwnDevice
  /** `new_sign_in`: the other device this account just signed in on. */
  newSignIn?: MatrixNewSignIn
  /** `danger`: data or this Mac's own keys at risk. */
  tone: 'warn' | 'danger'
}

const ORDER: MatrixAttentionKind[] = [
  'approval',
  'device_damaged',
  'new_sign_in',
  'disk_critical',
  'recovery',
  'sign_in',
  'protons',
  'runtime',
  'connect',
  'plan_sign_in',
  'agent',
  'disk_low'
]

const LIVE_APPROVAL = new Set(['asked', 'waiting', 'compare', 'unlocking'])

/** The agents the window knows, with the default one from an older snapshot's singular fields. */
export function matrixAttentionAgents(snapshot: MatrixSnapshot): (AgentFacts & { principal: string })[] {
  if (snapshot.agents?.length) {
    return snapshot.agents
  }

  return snapshot.readiness
    ? [
        {
          principal: '',
          readiness: snapshot.readiness,
          setup: snapshot.assistantSetup,
          listening: snapshot.hermesListening
        }
      ]
    : []
}

/**
 * What the indicator holds, most pressing first, one item per cause: a cause every agent shares
 * is one item, never one per agent. `diskLowSnoozed`: the person asked to be reminded later.
 *
 * Never a device of the person's to verify (0.20): new chats are plain, so no assistant refuses
 * a device there and the reminder's words would be false. An assistant's refusal of an
 * unverified device in an encrypted room made before 0.20 starts Matrix's own comparison from
 * main instead (unverified-devices.ts `denied`).
 */
export function matrixAttentionItems(
  snapshot: MatrixSnapshot,
  now: number,
  options: { diskLowSnoozed?: boolean } = {}
): MatrixAttentionItem[] {
  if (!snapshot.identity) {
    return []
  }

  const kinds = new Set<MatrixAttentionKind>()
  const agents: string[] = []
  const planSignIns: string[] = []
  const approval = snapshot.security?.approval

  if (approval?.role === 'approve' && LIVE_APPROVAL.has(approval.state)) {
    kinds.add('approval')
  }

  if (snapshot.deviceDamaged) {
    kinds.add('device_damaged')
  }

  if (snapshot.disk?.state === 'critical') {
    kinds.add('disk_critical')
  } else if (snapshot.disk?.state === 'low' && !options.diskLowSnoozed) {
    kinds.add('disk_low')
  }

  // This Mac's own facts (a request main holds, its device, its disk) stay through a connection
  // blip; the agents' readiness is read once the connection is back.
  for (const agent of snapshot.state === 'ready' ? matrixAttentionAgents(snapshot) : []) {
    const attention = matrixAgentAttention(agent, now)

    if (attention.waitsOn) {
      kinds.add(attention.waitsOn)
    } else if (attention.state === 'needs_you' && agent.principal) {
      const list = rule(agent.readiness?.code).item === 'plan_sign_in' ? planSignIns : agents
      list.push(agent.principal)
    }
  }

  const items: MatrixAttentionItem[] = []

  for (const kind of ORDER) {
    if (kind === 'agent') {
      items.push(...agents.map(principal => ({ kind, principal, tone: 'warn' as const })))
    } else if (kind === 'new_sign_in') {
      // Preserve user-visible identity, state and recovery behavior across connection changes.
      // band pushed the Team space side panel down).
      if (snapshot.newSignIn) {
        items.push({ kind, newSignIn: snapshot.newSignIn, tone: 'warn' })
      }
    } else if (kind === 'plan_sign_in') {
      items.push(...planSignIns.map(principal => ({ kind, principal, tone: 'warn' as const })))
    } else if (kinds.has(kind)) {
      items.push({ kind, tone: kind === 'device_damaged' || kind === 'disk_critical' ? 'danger' : 'warn' })
    }
  }

  return items
}

/** The next moment any agent's attention changes by time alone. */
export function matrixAttentionWakeAt(snapshot: MatrixSnapshot, now: number): number | undefined {
  let wake: number | undefined

  for (const agent of matrixAttentionAgents(snapshot)) {
    const at = matrixAgentAttention(agent, now).wakeAt

    if (at !== undefined && (wake === undefined || at < wake)) {
      wake = at
    }
  }

  return wake
}

/** The clock the attention reads: it ticks only when a grace runs out, never on a timer. */
export function useMatrixAttentionNow(snapshot: MatrixSnapshot): number {
  const [now, setNow] = useState(() => Date.now())
  const wake = matrixAttentionWakeAt(snapshot, now)

  useEffect(() => {
    if (wake === undefined) {
      return
    }

    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, wake - Date.now()) + 50)

    return () => window.clearTimeout(timer)
  }, [wake])

  return Math.max(now, Date.now())
}

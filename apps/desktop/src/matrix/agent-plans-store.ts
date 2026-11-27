import { atom } from 'nanostores'

import type { WorkAgentPlans } from '../../shared/matrix-work'
import type { WorkRelaySelection } from '../../shared/matrix-work-relay'

/**
 * A cloud agent's Mac-plan view (`work.readAgentPlans`), shared by every picker mounted for it.
 *
 * The composer's chip and the side panel's Model row are separate pickers for the same agent. Each
 * used to hold its own copy, so a switch made in one left the other naming the old plan (and treating
 * a click on it as "already current") until its own re-read came back. One entry per account and agent
 * fixes that: both read it, and a write acknowledged by either updates it for both.
 *
 * Ordering, so nothing late brings back what a newer write replaced:
 * - Writes are numbered when they start. An acknowledgement applies only if no later-started write
 *   has been acknowledged already (a plan pick acknowledged after the Atum write that cleared it
 *   stays cleared).
 * - A read is dropped if any write was acknowledged after it began, or if a newer read settled first.
 * - Clearing the plan (an acknowledged Atum write: 0536's `work_selection_clear`) keeps a tombstone at
 *   the highest plan revision known, so a read or acknowledgement at or below it cannot resurrect it.
 *   A new plan pick gets a higher revision on the server and passes.
 * - Everything belongs to one signed-in session: signing out or changing account empties the store,
 *   and any read or write begun in an earlier session is ignored when it settles.
 *
 * Acknowledgements are store-level: they never depend on the picker that started them staying open.
 */
export interface AgentPlansEntry {
  value: WorkAgentPlans | null
}

interface KeyState {
  /** Acknowledged writes, so a read begun before one is dropped. */
  acknowledged: number
  /** The start number of the latest write acknowledged. */
  appliedWrite: number
  /** The latest read that settled. */
  settledRead: number
  /** The plan was cleared at or below this revision; nothing at or below it may come back. */
  tombstone?: number
  /** The highest plan revision this session has seen for the agent. */
  highestRevision: number
}

export const $agentPlans = atom<Readonly<Record<string, AgentPlansEntry>>>({})

let generation = 0
let account: string | null = null
let sequence = 0
let keys = new Map<string, KeyState>()

function state(key: string): KeyState {
  let found = keys.get(key)

  if (!found) {
    found = { acknowledged: 0, appliedWrite: 0, settledRead: 0, highestRevision: 0 }
    keys.set(key, found)
  }

  return found
}

export function agentPlansKey(scope: string, agentPrincipal: string): string {
  return JSON.stringify([scope, agentPrincipal])
}

/**
 * The signed-in account (its Matrix user ID), or null once signed out. A change of account, including
 * signing out and back in as the same person, starts a new session: the store empties and anything
 * still in flight from before is ignored.
 */
export function bindAgentPlansAccount(next: string | null): void {
  if (next === account) {
    return
  }

  account = next
  generation += 1
  keys = new Map()
  $agentPlans.set({})
}

export interface AgentPlansRead {
  key: string
  generation: number
  acknowledged: number
  read: number
}

/** Marks the start of a read, so a later acknowledged write or a newer read can retire it. */
export function beginAgentPlansRead(key: string): AgentPlansRead {
  sequence += 1

  return { key, generation, acknowledged: state(key).acknowledged, read: sequence }
}

function readCurrent(read: AgentPlansRead): boolean {
  if (read.generation !== generation) {
    return false
  }

  const known = state(read.key)

  return known.acknowledged === read.acknowledged && known.settledRead < read.read
}

function seen(key: string, selection: WorkRelaySelection | null): void {
  if (selection) {
    const known = state(key)
    known.highestRevision = Math.max(known.highestRevision, selection.revision)
  }
}

/** A selection at or below the tombstone was cleared after it was made. */
function alive(key: string, selection: WorkRelaySelection | null): WorkRelaySelection | null {
  const tombstone = state(key).tombstone

  return selection && (tombstone === undefined || selection.revision > tombstone) ? selection : null
}

function put(key: string, value: WorkAgentPlans | null): void {
  $agentPlans.set({ ...$agentPlans.get(), [key]: { value } })
}

/** A read's answer: kept unless a write was acknowledged, or a newer read settled, since it began. */
export function settleAgentPlansRead(read: AgentPlansRead, value: WorkAgentPlans | null): void {
  if (!readCurrent(read)) {
    return
  }

  state(read.key).settledRead = read.read
  seen(read.key, value?.selection ?? null)
  put(read.key, value ? { ...value, selection: alive(read.key, value.selection) } : null)
}

/** A failed read keeps what the entry already knows; with nothing known it settles as unavailable. */
export function failAgentPlansRead(read: AgentPlansRead): void {
  if (!readCurrent(read)) {
    return
  }

  state(read.key).settledRead = read.read

  if (!$agentPlans.get()[read.key]) {
    put(read.key, null)
  }
}

export interface AgentPlansWrite {
  key: string
  generation: number
  write: number
}

/** Numbers a write when it starts: a plan pick, or an Atum model write that clears the plan. */
export function beginAgentPlansWrite(key: string): AgentPlansWrite {
  sequence += 1

  return { key, generation, write: sequence }
}

/** Whether this acknowledgement may apply, and if so records it. */
function acknowledge(write: AgentPlansWrite): boolean {
  if (write.generation !== generation) {
    return false
  }

  const known = state(write.key)

  // A later-started write already acknowledged is the newer intent.
  if (write.write < known.appliedWrite) {
    return false
  }

  known.appliedWrite = write.write
  known.acknowledged += 1

  return true
}

/** The server acknowledged a plan selection (`work_selection_set`). */
export function acknowledgeAgentPlanSelection(write: AgentPlansWrite, saved: WorkRelaySelection): void {
  if (!acknowledge(write)) {
    return
  }

  seen(write.key, saved)
  const entry = $agentPlans.get()[write.key]
  const selection = alive(write.key, saved)

  if (entry?.value && selection && selection.revision >= (entry.value.selection?.revision ?? 0)) {
    put(write.key, { ...entry.value, selection })
  }
}

/**
 * The server acknowledged an Atum model write for this agent: 0536's `work_selection_clear` trigger
 * clears the plan selection there, so every picker forgets it now instead of after its next read.
 */
export function acknowledgeAgentPlanCleared(write: AgentPlansWrite): void {
  if (!acknowledge(write)) {
    return
  }

  const known = state(write.key)
  const entry = $agentPlans.get()[write.key]
  known.tombstone = Math.max(known.tombstone ?? 0, known.highestRevision, entry?.value?.selection?.revision ?? 0)

  if (entry?.value?.selection) {
    put(write.key, { ...entry.value, selection: null })
  }
}

/**
 * A plan selection written outside a picker (the first-run automatic pick): every entry already held for this agent, in any
 * scope, takes it under the same ordering rules as a picker's own write, so the chip moves without waiting for a re-read.
 */
export function acknowledgeAgentPlanSelectionForAgent(agentPrincipal: string, saved: WorkRelaySelection): void {
  for (const key of Object.keys($agentPlans.get())) {
    let principal: unknown

    try {
      principal = (JSON.parse(key) as unknown[])[1]
    } catch {
      continue
    }

    if (principal === agentPrincipal) {
      acknowledgeAgentPlanSelection(beginAgentPlansWrite(key), saved)
    }
  }
}

/** Tests only: a fresh store with no session. */
export function resetAgentPlansForTests(): void {
  generation += 1
  account = null
  sequence = 0
  keys = new Map()
  $agentPlans.set({})
}

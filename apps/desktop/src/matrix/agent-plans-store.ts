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
 * `writes` counts the writes acknowledged for the entry. A read records the count when it starts and is
 * dropped if a write was acknowledged meanwhile, because the server may have answered it with the
 * selection from before that write. `read` orders the reads themselves: an older read that comes back
 * after a newer one is dropped too.
 */
export interface AgentPlansEntry {
  value: WorkAgentPlans | null
  writes: number
  read: number
}

export const $agentPlans = atom<Readonly<Record<string, AgentPlansEntry>>>({})

let readSequence = 0
const writesByKey = new Map<string, number>()
const settledReadByKey = new Map<string, number>()

export function agentPlansKey(scope: string, agentPrincipal: string): string {
  return JSON.stringify([scope, agentPrincipal])
}

export interface AgentPlansRead {
  key: string
  writes: number
  read: number
}

/** Marks the start of a read, so a write acknowledged before it settles can retire it. */
export function beginAgentPlansRead(key: string): AgentPlansRead {
  readSequence += 1

  return { key, writes: writesByKey.get(key) ?? 0, read: readSequence }
}

function current(read: AgentPlansRead): boolean {
  return (writesByKey.get(read.key) ?? 0) === read.writes && (settledReadByKey.get(read.key) ?? 0) < read.read
}

function put(key: string, value: WorkAgentPlans | null): void {
  $agentPlans.set({
    ...$agentPlans.get(),
    [key]: { value, writes: writesByKey.get(key) ?? 0, read: settledReadByKey.get(key) ?? 0 }
  })
}

/** A read's answer: kept unless a write was acknowledged, or a newer read settled, since it began. */
export function settleAgentPlansRead(read: AgentPlansRead, value: WorkAgentPlans | null): void {
  if (!current(read)) {
    return
  }

  settledReadByKey.set(read.key, read.read)
  put(read.key, value)
}

/** A failed read keeps what the entry already knows; with nothing known it settles as unavailable. */
export function failAgentPlansRead(read: AgentPlansRead): void {
  if (!current(read)) {
    return
  }

  settledReadByKey.set(read.key, read.read)

  if (!$agentPlans.get()[read.key]) {
    put(read.key, null)
  }
}

function acknowledge(key: string, selection: (previous: WorkRelaySelection | null) => WorkRelaySelection | null): void {
  writesByKey.set(key, (writesByKey.get(key) ?? 0) + 1)
  const entry = $agentPlans.get()[key]

  if (entry?.value) {
    put(key, { ...entry.value, selection: selection(entry.value.selection) })
  } else if (entry) {
    put(key, entry.value)
  }
}

/** The server acknowledged a plan selection (`work_selection_set`). */
export function acknowledgeAgentPlanSelection(key: string, saved: WorkRelaySelection): void {
  acknowledge(key, previous => (saved.revision >= (previous?.revision ?? 0) ? saved : previous))
}

/**
 * The server acknowledged an Atum model write for this agent: 0536's `work_selection_clear` trigger
 * clears the plan selection there, so every picker forgets it now instead of after its next read.
 */
export function acknowledgeAgentPlanCleared(key: string): void {
  acknowledge(key, () => null)
}

/** Tests only: a fresh store. */
export function resetAgentPlansForTests(): void {
  readSequence = 0
  writesByKey.clear()
  settledReadByKey.clear()
  $agentPlans.set({})
}

import { atom, map } from 'nanostores'

import type { MatrixBackgroundSweepSetting } from '../../../shared/background-sweep'
import type { MatrixSnapshot } from '../../../shared/matrix'

/**
 * The assistant card's own state (feature-local, DESIGN.md › Assistant card): which card is
 * open, and the names it has just given that the roster, the chat header and the palette
 * show before the next snapshot confirms them (paint first; a failed write rolls back).
 */

/** An assistant's card, or an official app's read-only one. */
export type AssistantCardTarget =
  | { kind: 'agent'; principal: string; focus?: 'name' | 'routines' }
  | { kind: 'app'; appId: string }

export const $assistantCard = atom<AssistantCardTarget | null>(null)

/** Optimistic names, by agent principal, until a snapshot says the same. */
export const $assistantNameOverrides = map<Record<string, string>>({})

export interface BackgroundSweepCacheEntry {
  setting?: MatrixBackgroundSweepSetting
  loading: boolean
  pending: boolean
  error?: 'read' | 'save'
  retryEnabled?: boolean
}

export const $backgroundSweepSettings = map<Record<string, BackgroundSweepCacheEntry>>({})

const backgroundSweepGenerations = new Map<string, number>()

export function backgroundSweepCacheKey(owner: string, agent: string): string {
  return `${owner}\n${agent}`
}

function nextBackgroundSweepGeneration(key: string): number {
  const generation = (backgroundSweepGenerations.get(key) ?? 0) + 1
  backgroundSweepGenerations.set(key, generation)
  return generation
}

function setBackgroundSweepEntry(key: string, entry: BackgroundSweepCacheEntry): void {
  $backgroundSweepSettings.setKey(key, entry)
}

export function beginBackgroundSweepRead(key: string): number {
  const generation = nextBackgroundSweepGeneration(key)
  const current = $backgroundSweepSettings.get()[key]
  setBackgroundSweepEntry(key, {
    ...(current?.setting ? { setting: current.setting } : {}),
    loading: true,
    pending: current?.pending ?? false
  })
  return generation
}

export function finishBackgroundSweepRead(
  key: string,
  generation: number,
  setting?: MatrixBackgroundSweepSetting
): void {
  if (backgroundSweepGenerations.get(key) !== generation) {
    return
  }
  setBackgroundSweepEntry(key, setting
    ? { setting, loading: false, pending: false }
    : { loading: false, pending: false, error: 'read' })
}

export function beginBackgroundSweepSave(
  key: string,
  enabled: boolean
): { generation: number; previous: MatrixBackgroundSweepSetting } | null {
  const current = $backgroundSweepSettings.get()[key]
  if (!current?.setting || current.pending) {
    return null
  }
  const generation = nextBackgroundSweepGeneration(key)
  setBackgroundSweepEntry(key, {
    setting: { ...current.setting, enabled },
    loading: false,
    pending: true,
    retryEnabled: enabled
  })
  return { generation, previous: current.setting }
}

export function finishBackgroundSweepSave(
  key: string,
  generation: number,
  result: { setting: MatrixBackgroundSweepSetting; retryEnabled?: boolean }
): void {
  if (backgroundSweepGenerations.get(key) !== generation) {
    return
  }
  setBackgroundSweepEntry(key, {
    setting: result.setting,
    loading: false,
    pending: false,
    ...(result.retryEnabled === undefined
      ? {}
      : { error: 'save' as const, retryEnabled: result.retryEnabled })
  })
}

export function openAssistantCard(target: AssistantCardTarget): void {
  $assistantCard.set(target)
}

export function closeAssistantCard(): void {
  $assistantCard.set(null)
}

export function setAssistantNameOverride(principal: string, name: string | undefined): void {
  $assistantNameOverrides.setKey(principal, name as string)
}

/**
 * The snapshot as the window shows it: an assistant renamed on the card goes by its new
 * name at once. The same object comes back when nothing is overridden, so nothing
 * re-renders for nothing.
 */
export function withAssistantNames(snapshot: MatrixSnapshot, overrides: Record<string, string | undefined>): MatrixSnapshot {
  const entries = Object.entries(overrides).filter((entry): entry is [string, string] => Boolean(entry[1]))

  if (!entries.length || !snapshot.agents?.length) {
    return snapshot
  }

  const names = new Map(entries)
  let changed = false

  const agents = snapshot.agents.map(agent => {
    const name = names.get(agent.principal)

    if (name === undefined || name === agent.name) {
      return agent
    }

    changed = true

    return { ...agent, name }
  })

  return changed ? { ...snapshot, agents } : snapshot
}

/** Drops each override the snapshot now agrees with (or whose assistant is gone). */
export function settleAssistantNames(snapshot: MatrixSnapshot): void {
  const overrides = $assistantNameOverrides.get()

  for (const [principal, name] of Object.entries(overrides)) {
    if (!name) {
      continue
    }

    const agent = snapshot.agents?.find(each => each.principal === principal)

    if (!agent || agent.name === name) {
      setAssistantNameOverride(principal, undefined)
    }
  }
}

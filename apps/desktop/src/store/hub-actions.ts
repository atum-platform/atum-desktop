import { atom, map } from 'nanostores'

import {
  getActionStatus,
  type HubTarget,
  installSkillFromHub,
  uninstallSkillFromHub,
  updateSkillsFromHub
} from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { upsertDesktopActionTask } from '@/store/activity'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

const POLL_MS = 1200

// Shared with hub.tsx's sources useQuery so a finished action refreshes the
// installed map.
export const HUB_SOURCES_KEY = ['skill-hub-sources'] as const
// The Capabilities Skills-list query key (see app/skills/index.tsx) — kept in
// sync here so a hub (un)install updates the Skills tab, not just the hub.
const SKILLS_LIST_KEY = ['skills-list'] as const
// Non-identifier key for the fleet-wide "Update installed" action.
export const UPDATE_ALL_KEY = '__update_all__'

export type HubActionKind = 'install' | 'uninstall' | 'update'

export interface HubAction {
  exitCode: number | null
  kind: HubActionKind
  running: boolean
  lines: string[]
}

// Per-item action status, keyed by skill identifier (or UPDATE_ALL_KEY). Each
// row drives its own button off ITS entry — one install never touches another.
export const $hubActions = map<Record<string, HubAction | undefined>>({})

// Optimistic installed overrides so a row flips to its resolved state the instant
// its own action finishes, instead of waiting on (and racing) the sources
// refetch. install/update → true, uninstall → false; sources reconciles after.
export const $hubInstalledOverride = map<Record<string, boolean | undefined>>({})

// The key whose log the bottom pane currently tails (the latest-started action).
export const $hubActiveLog = atom<null | string>(null)

// Legacy hub action state is per active gateway profile, while explicit-target
// actions always run on the primary backend. A profile switch clears and
// abandons only legacy state; target-prefixed entries keep polling and remain
// visible to the Atum adapter regardless of which gateway is active.
let _hubProfile: null | string = null
let _hubEpoch = 0

$activeGatewayProfile.subscribe(value => {
  const key = normalizeProfileKey(value)

  if (_hubProfile !== null && _hubProfile !== key) {
    _hubEpoch += 1

    const actions = Object.fromEntries(Object.entries($hubActions.get()).filter(([key]) => key.startsWith('target:')))

    const overrides = Object.fromEntries(
      Object.entries($hubInstalledOverride.get()).filter(([key]) => key.startsWith('target:'))
    )

    const activeLog = $hubActiveLog.get()

    $hubActions.set(actions)
    $hubInstalledOverride.set(overrides)

    if (!activeLog?.startsWith('target:')) {
      $hubActiveLog.set(null)
    }
  }

  _hubProfile = key
})

// The backend names a hub action after the skill identifier alone
// (web_server._hub_action_name), so two operations on one identifier at the
// same time would share a name and one poller would follow the other's
// process. Every install or uninstall of an identifier, whether it comes from
// the Skills Hub page or the Atum adapter, therefore queues behind the
// previous one here, in the one place all of them pass through. A task that
// rejects releases its turn like any other.
const identifierQueues = new Map<string, Promise<void>>()

export function withHubIdentifierLock<T>(identifier: string, task: () => Promise<T>): Promise<T> {
  const previous = identifierQueues.get(identifier) ?? Promise.resolve()
  const run = previous.then(task)

  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined
  )

  identifierQueues.set(identifier, settled)
  void settled.then(() => {
    if (identifierQueues.get(identifier) === settled) {
      identifierQueues.delete(identifier)
    }
  })

  return run
}

/** Drop an action's stored outcome once a caller has confirmed the goal state
 *  from a fresh read of the authoritative installed map — a poll can fail
 *  after the action itself succeeded, and only such a read may clear that. */
export function forgetHubAction(key: string): void {
  $hubActions.setKey(key, undefined)
}

// One self-contained task: spawn → tail its own action log into the store →
// mark resolved. Concurrency-safe: state is per-key, so parallel installs never
// stomp each other, and the sources query is invalidated once at the end.
async function runHubAction(
  key: string,
  kind: HubActionKind,
  spawn: () => Promise<{ name: string }>,
  { target }: { target?: HubTarget } = {}
): Promise<void> {
  const epoch = _hubEpoch
  const switched = () => target === undefined && _hubEpoch !== epoch

  $hubActions.setKey(key, { exitCode: null, kind, running: true, lines: [] })
  $hubActiveLog.set(key)

  try {
    const started = await spawn()
    let exitCode: number | null = null

    for (;;) {
      const status = await getActionStatus(started.name, 200, target)

      // Profile switched mid-flight: the store was cleared for the new profile,
      // so drop this A-profile result instead of writing it back into B.
      if (switched()) {
        return
      }

      upsertDesktopActionTask(status)
      $hubActions.setKey(key, {
        exitCode: status.running ? null : status.exit_code,
        kind,
        running: status.running,
        lines: status.lines
      })

      if (!status.running) {
        exitCode = status.exit_code

        break
      }

      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }

    // Only flip the row on a clean exit — a failed install/uninstall must not
    // render as installed/removed.
    if (key !== UPDATE_ALL_KEY && exitCode === 0) {
      $hubInstalledOverride.setKey(key, kind !== 'uninstall')
    }

    // Refresh the hub's installed map AND the Capabilities Skills list — a hub
    // (un)install adds/removes a skill, so its count/rows must update too.
    void queryClient.invalidateQueries({ queryKey: HUB_SOURCES_KEY })
    void queryClient.invalidateQueries({ queryKey: SKILLS_LIST_KEY })
  } catch (err) {
    // A profile switch points the next poll at the new backend, which 404s the
    // old action name — that's an abandonment, not a failure, so swallow it
    // instead of letting the caller toast a phantom error. Real (same-profile)
    // failures still propagate.
    if (switched()) {
      return
    }

    // Explicit-target callers read outcomes from the store, not from the
    // rejection (the Atum adapter moves on to the next assistant), so a spawn
    // or poll failure is recorded as a failed action carrying its message.
    // The synthetic exit code only has to be non-zero.
    if (target !== undefined) {
      const current = $hubActions.get()[key]

      $hubActions.setKey(key, {
        exitCode: 1,
        kind,
        running: false,
        lines: [...(current?.lines ?? []), err instanceof Error ? err.message : String(err)]
      })
    }

    throw err
  } finally {
    // Skip the running=false write after a switch — it would re-add the key the
    // profile-switch clear just dropped.
    const current = $hubActions.get()[key]

    if (current && !switched()) {
      $hubActions.setKey(key, { ...current, running: false })
    }
  }
}

export function installHubSkill(identifier: string): Promise<void> {
  return withHubIdentifierLock(identifier, () =>
    runHubAction(identifier, 'install', () => installSkillFromHub(identifier))
  )
}

export function hubTargetKey(profile: null | string, identifier: string): string {
  return `target:${profile ?? 'default'}::${identifier}`
}

export function installHubSkillFor(target: HubTarget, identifier: string): Promise<void> {
  return withHubIdentifierLock(identifier, () =>
    runHubAction(hubTargetKey(target.profile, identifier), 'install', () => installSkillFromHub(identifier, target), {
      target
    })
  )
}

export function uninstallHubSkill(identifier: string, name: string): Promise<void> {
  return withHubIdentifierLock(identifier, () =>
    runHubAction(identifier, 'uninstall', () => uninstallSkillFromHub(name))
  )
}

/**
 * `name` may be a resolver, run only once this call holds the identifier's
 * turn: a removal queued behind an install then uses the name that install
 * actually recorded, read fresh, instead of one captured before it ran.
 */
export function uninstallHubSkillFor(
  target: HubTarget,
  identifier: string,
  name: string | (() => Promise<string> | string)
): Promise<void> {
  return withHubIdentifierLock(identifier, async () => {
    const resolved = typeof name === 'function' ? await name() : name

    return runHubAction(
      hubTargetKey(target.profile, identifier),
      'uninstall',
      () => uninstallSkillFromHub(resolved, target),
      { target }
    )
  })
}

export function updateHubSkills(): Promise<void> {
  return runHubAction(UPDATE_ALL_KEY, 'update', () => updateSkillsFromHub())
}

export function closeHubLog(): void {
  $hubActiveLog.set(null)
}

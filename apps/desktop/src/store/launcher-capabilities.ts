import { atom } from 'nanostores'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { addBundledSkill, getLauncherReadiness, getSkills, toggleSkill } from '@/hermes'
import type { LauncherCapabilityState } from '@/lib/launcher-capability-types'

import type { NativeAppEntry, NativeAppLaunchResult } from '../../shared/skills-launcher'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumAccountScopeId } from './atum-messaging'
import { launchNativeApp } from './native-apps'
import { $gatewaySwapTarget, normalizeProfileKey } from './profile'
import { $currentCwd } from './session'
import { $workbenchScope, ATUM_CHAT_WORKBENCH_SCOPE_PREFIX } from './workbench-tabs'

const EMPTY: LauncherCapabilityState = {
  scopeKey: null,
  profile: null,
  skills: [],
  support: null,
  loading: false,
  error: null,
  busySkill: null
}

export const $launcherCapabilities = atom<LauncherCapabilityState>(EMPTY)
let generation = 0

function capture(scopeKey: string) {
  const owner = $actionPanelOwner.get()

  if (
    !owner ||
    $gatewaySwapTarget.get() !== null ||
    $atumAccountScopeId.get() !== owner.accountId ||
    scopeKey !== $workbenchScope.get() ||
    !scopeKey.startsWith(`${ATUM_CHAT_WORKBENCH_SCOPE_PREFIX}${panelOwnerKey(owner)}:`)
  ) {
    return null
  }

  return {
    scopeKey,
    ownerKey: panelOwnerKey(owner),
    epoch: $actionPanelEpoch.get(),
    profile: normalizeProfileKey(owner.profile),
    cwd: $currentCwd.get()
  }
}

type Scope = NonNullable<ReturnType<typeof capture>>
const current = (scope: Scope) => JSON.stringify(capture(scope.scopeKey)) === JSON.stringify(scope)
const requestProfile = (scope: Scope) => (scope.profile === 'default' ? null : scope.profile)

const sameState = (scope: Scope) =>
  $launcherCapabilities.get().scopeKey === scope.scopeKey && $launcherCapabilities.get().profile === scope.profile

export async function refreshLauncherCapabilities(scopeKey: string, refresh = false): Promise<void> {
  const id = ++generation
  const scope = capture(scopeKey)

  if (!scope) {
    $launcherCapabilities.set({ ...EMPTY, scopeKey })

    return
  }

  const previous = $launcherCapabilities.get()
  $launcherCapabilities.set({ ...EMPTY, scopeKey, profile: scope.profile, loading: true,
    skills: previous.profile === scope.profile ? previous.skills : [] })

  const [skills, support] = await Promise.allSettled([
    getSkills({ profile: requestProfile(scope) }),
    getLauncherReadiness({ profile: requestProfile(scope), cwd: scope.cwd, refresh })
  ])

  if (id !== generation || !current(scope)) {
    return
  }

  $launcherCapabilities.set({
    ...EMPTY,
    scopeKey,
    profile: scope.profile,
    skills: skills.status === 'fulfilled' ? skills.value : [],
    support: support.status === 'fulfilled' ? support.value : null,
    error: skills.status === 'rejected' || support.status === 'rejected' ? 'unavailable' : null
  })
}

/** Preparing a skill never submits, changes chat, or replaces a draft. */
export function prepareLauncherSkill(name: string, scopeKey: string): boolean {
  const scope = capture(scopeKey)
  const state = $launcherCapabilities.get()

  if (!scope || !sameState(scope) || state.loading || state.error || !state.support || state.busySkill) {
    return false
  }

  const matches = state.skills.filter(skill => skill.name === name)

  if (matches.length !== 1 || !matches[0]?.enabled) {
    return false
  }

  const readiness = state.support.routes[name]?.operations.read

  if ((readiness && readiness.state !== 'ready') || (state.support.verified_bundled.includes(name) && !readiness)) {
    return false
  }

  const command = state.support.commands[name]
  requestComposerInsert(command ?? `Use the installed skill ${JSON.stringify(name)} for this request.`, {
    mode: 'prefix',
    scope: { epoch: scope.epoch, ownerKey: scope.ownerKey, scopeKey },
    target: 'main'
  })

  return true
}

/** Explicit setup action prepares a request; it never installs or sends. */
export function prepareLauncherSetup(name: string, scopeKey: string, message: string): boolean {
  const scope = capture(scopeKey)
  const state = $launcherCapabilities.get()

  if (!scope || !sameState(scope) || state.loading || state.error || state.busySkill) {return false}
  const matches = state.skills.filter(skill => skill.name === name && skill.enabled)

  if (matches.length !== 1) {return false}
  requestComposerInsert(message, {
    mode: 'prefix', scope: { epoch: scope.epoch, ownerKey: scope.ownerKey, scopeKey }, target: 'main'
  })

  return true
}

async function changeSkill(name: string, scopeKey: string, add: boolean): Promise<void> {
  const scope = capture(scopeKey)
  const state = $launcherCapabilities.get()

  if (!scope || !sameState(scope) || state.loading || state.busySkill) {
    return
  }

  if (
    add
      ? !state.support?.bundled.some(row => row.name === name)
      : !state.skills.some(row => row.name === name && !row.enabled)
  ) {
    return
  }

  $launcherCapabilities.set({ ...state, busySkill: name, error: null })

  try {
    if (add) {
      await addBundledSkill(name, { profile: requestProfile(scope) })
    } else {
      await toggleSkill(name, true, { profile: requestProfile(scope) })
    }

    if (current(scope)) {
      await refreshLauncherCapabilities(scopeKey)
    }
  } catch (error) {
    if (current(scope) && sameState(scope)) {
      $launcherCapabilities.set({ ...$launcherCapabilities.get(), busySkill: null, error: 'action' })
    }

    throw error
  }
}

export const enableLauncherSkill = (name: string, scopeKey: string) => changeSkill(name, scopeKey, false)
export const addBundledLauncherSkill = (name: string, scopeKey: string) => changeSkill(name, scopeKey, true)

export async function launchLauncherApp(
  app: NativeAppEntry,
  scopeKey: string,
  options: { normal?: boolean; windowId?: number; skillName?: string } = {}
): Promise<NativeAppLaunchResult | null> {
  // Native launch has its own panel ownership checks and remains available
  // while the assistant handshake or skill service is unavailable.
  if (options.normal || !options.skillName) {
    return launchNativeApp(app, scopeKey, options)
  }

  const scope = capture(scopeKey)

  if (!scope) {
    return null
  }

  const result = await launchNativeApp(app, scopeKey, options)

  if (result && result.status !== 'choose-window' && !options.normal && options.skillName && current(scope)) {
    prepareLauncherSkill(options.skillName, scopeKey)
  }

  return result
}

function invalidate() {
  generation += 1
  $launcherCapabilities.set(EMPTY)
}

$actionPanelEpoch.listen(invalidate)
$actionPanelOwner.listen(invalidate)
$workbenchScope.listen(invalidate)
$gatewaySwapTarget.listen(invalidate)
$atumAccountScopeId.listen(invalidate)
$currentCwd.listen(() => {
  generation += 1
  // Keep the grid while its operation evidence is refreshed for the new cwd.
  $launcherCapabilities.set({ ...$launcherCapabilities.get(), scopeKey: null, support: null, loading: true })
})

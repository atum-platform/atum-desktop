/**
 * The sanctioned crossing from the skills hub into the Atum product.
 *
 * This adapter translates hub identifiers and profile targets into skills a
 * person can add to an assistant. Hub organisation stays behind this module.
 *
 * WHAT THE SHELVES READ changed with the Atum Store (plan
 * 2026-09-10-atum-store.md): the catalog rows come from `$atumStoreCatalog` —
 * the catalog the owner publishes — never from a constant compiled into the
 * app. The hub still owns installing; the store owns what is for sale, at what
 * price, and what this account owns.
 */

import { atom, computed, type ReadableAtom } from 'nanostores'

import { getSkillHubSources, type HubTarget, previewSkillHub } from '@/hermes'
import {
  type AtumStoreSkillEntry,
  isStoreItemFulfillable,
  isStoreItemOwned,
  projectSkillEntry,
  storeSkillLockName
} from '@/lib/atum-store-items'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $railDestination } from '@/store/atum-shell'
import { $atumStoreCatalog } from '@/store/atum-store-catalog'
import { prepareAtumTraining } from '@/store/atum-training'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import {
  $hubActions,
  forgetHubAction,
  hubTargetKey,
  installHubSkillFor,
  uninstallHubSkillFor
} from '@/store/hub-actions'
import type { SkillHubInstalledEntry } from '@/types/hermes'

import { $atumAgents, ATUM_AGENT_ID, talkToAtumAgent } from './agents'

export interface AtumSkillAssistantState {
  action: 'failed' | 'idle' | 'installing' | 'removing'
  agentId: string
  installedName: string | null
  lastLogLine: string | null
}

export interface AtumSkillRow {
  assistants: AtumSkillAssistantState[]
  entry: AtumStoreSkillEntry
  installedFor: string[]
}

type InstalledMap = Record<string, SkillHubInstalledEntry>
type InstalledByAgent = Record<string, InstalledMap | undefined>

const $installedByAgent = atom<InstalledByAgent>({})

/**
 * Which `official/…` identifiers the bundled Hermes actually ships — the
 * skills half of fulfilment (plan decision 11). `null` is "not probed yet":
 * rows stay visible while the probe is out, because blanking the shelf on a
 * slow gateway is worse. A KNOWN absence (a probe answer without the
 * identifier) hides the row rather than selling what this build cannot
 * install.
 */
export const $fulfillableSkillIds = atom<ReadonlySet<string> | null>(null)

export const $atumSkillRefresh = atom<{
  error: null | string
  state: 'failed' | 'idle' | 'loading' | 'ready'
}>({ error: null, state: 'idle' })

function lastLogLine(lines: readonly string[]): string | null {
  return [...lines].reverse().find(line => line.trim())?.trim() ?? null
}

export function atumSkillTarget(agentId: string): HubTarget {
  return { profile: agentId === ATUM_AGENT_ID ? null : agentId }
}

/** Preview only file names; hub metadata and raw instructions stay behind the adapter. */
export async function loadAtumSkillPreview(entry: AtumStoreSkillEntry): Promise<{ files: string[] }> {
  if (entry.cloudProtected) { return { files: [] } }
  const preview = await previewSkillHub(entry.identifier)

  return { files: preview.files }
}

export const $atumSkillRows: ReadableAtom<AtumSkillRow[]> = computed(
  [$atumAgents, $installedByAgent, $hubActions, $atumStoreCatalog, $fulfillableSkillIds],
  (agents, installedByAgent, actions, storeView, fulfillable) => {
    const catalog = storeView.catalog

    if (!catalog) {
      return []
    }

    const caps = { bundledPetSlugs: null, skillIdentifiers: fulfillable }

    return catalog.items
      .filter(item => item.kind === 'skill' && isStoreItemFulfillable(item, caps))
      .sort((left, right) => left.sort_order - right.sort_order)
      .flatMap(item => {
        const trained = catalog.entitlements.filter(entitlement => entitlement.kind === 'skill' && entitlement.id === item.id && entitlement.state === 'active').flatMap(entitlement => entitlement.assistant_id ? [entitlement.assistant_id] : [])
        const entry = projectSkillEntry(item, trained.length > 0)

        if (!entry) {
          return []
        }

        entry.trainedAssistantIds = trained

        const assistants = agents.map<AtumSkillAssistantState>(agent => {
          const trained = Boolean(agent.hostedId && isStoreItemOwned(catalog, 'skill', entry.id, agent.hostedId))
          const installed = trained && agent.localProfileId !== null ? (entry.cloudProtected ? { name: entry.id } : installedByAgent[agent.id]?.[entry.identifier]) : undefined
          const target = atumSkillTarget(agent.id)
          const hubAction = actions[hubTargetKey(target.profile, entry.identifier)]
          let action: AtumSkillAssistantState['action'] = 'idle'

          // A failed action stays failed until `settleAfterAction` has confirmed
          // the goal state from a fresh read and forgotten it; a stale installed
          // map is never allowed to hide a failure.
          if (hubAction?.running) {
            action = hubAction.kind === 'uninstall' ? 'removing' : 'installing'
          } else if (hubAction && hubAction.exitCode !== null && hubAction.exitCode !== 0) {
            action = 'failed'
          }

          return {
            action,
            agentId: agent.id,
            installedName: installed ? installed.name || storeSkillLockName(entry.identifier) : null,
            lastLogLine: hubAction ? lastLogLine(hubAction.lines) : null
          }
        })

        return [{
          assistants,
          entry,
          installedFor: assistants.filter(assistant => assistant.installedName).map(assistant => assistant.agentId)
        }]
      })
  }
)

async function loadInstalledFor(agentId: string): Promise<InstalledMap> {
  const { installed } = await getSkillHubSources(atumSkillTarget(agentId))

  return installed
}

/** Commit one assistant's map, unless that assistant has gone away meanwhile. */
function commitAgent(agentId: string, installed: InstalledMap): void {
  if (!$atumAgents.get().some(agent => agent.id === agentId)) {
    return
  }

  $installedByAgent.set({ ...$installedByAgent.get(), [agentId]: installed })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve each listed `official/…` identifier through the hub the way an
 * install would — local, no network for the official source. A resolution
 * answer (found or not) updates the fulfilment set; a probe FAILURE keeps the
 * previous knowledge for that identifier, so a gateway hiccup never blanks
 * the shelf.
 *
 * The hub answers "no" with a 404 ('Skill not found'), which arrives as a
 * REJECTED promise, not a falsy preview — a 404 is a verdict, not a transport
 * failure: the identifier is known-absent and comes out of the set. Only a
 * genuine transport failure (and the route-missing 404 of a gateway that
 * predates the preview endpoint) leaves the previous knowledge standing.
 */
function isHubSkillNotFound(error: unknown): boolean {
  const message = errorMessage(error)

  return /(?:^|\s|error:\s*)404\b/iu.test(message) && !/no such api endpoint/iu.test(message)
}

async function probeFulfillableSkills(): Promise<void> {
  const catalog = $atumStoreCatalog.get().catalog

  const identifiers = (catalog?.items ?? []).flatMap(item =>
    item.kind === 'skill' && item.source?.type === 'hermes_optional' ? [item.source.identifier] : []
  )

  if (identifiers.length === 0) {
    return
  }

  const next = new Set($fulfillableSkillIds.get() ?? [])
  let answered = false

  await Promise.all(
    identifiers.map(async identifier => {
      try {
        const preview = await previewSkillHub(identifier)

        answered = true

        if (preview) {
          next.add(identifier)
        } else {
          next.delete(identifier)
        }
      } catch (error) {
        if (isHubSkillNotFound(error)) {
          // The hub looked and found nothing: a known absence hides the row.
          next.delete(identifier)
          answered = true
        }
        // Anything else is unknown: keep the last answer for this identifier.
      }
    })
  )

  // A probe that produced NO answers (gateway down) is not a verdict: keep the
  // previous knowledge rather than blanking the shelf.
  if (answered) {
    $fulfillableSkillIds.set(next)
  }
}

// Refreshes overlap when the roster changes quickly. Only the newest one may
// commit, and it commits all of its assistants in one write, so an older
// refresh finishing late can neither resurrect a removed assistant's map nor
// drop the newcomer's.
let refreshGeneration = 0

export async function refreshAtumSkills(): Promise<void> {
  const generation = ++refreshGeneration
  const agents = $atumAgents.get()

  $atumSkillRefresh.set({ error: null, state: 'loading' })

  const results = await Promise.allSettled(agents.map(agent => loadInstalledFor(agent.id)))

  if (generation !== refreshGeneration) {
    return
  }

  const previous = $installedByAgent.get()
  const next: InstalledByAgent = {}
  let firstFailure: null | string = null

  agents.forEach((agent, index) => {
    const result = results[index]!

    if (result.status === 'fulfilled') {
      next[agent.id] = result.value
    } else {
      // Keep what we last knew about this assistant rather than blanking it.
      next[agent.id] = previous[agent.id]
      firstFailure ??= errorMessage(result.reason)
    }
  })

  $installedByAgent.set(next)
  $atumSkillRefresh.set(firstFailure === null ? { error: null, state: 'ready' } : { error: firstFailure, state: 'failed' })

  // The fulfilment probe rides the same refresh but never fails it: a store
  // the app cannot price is one thing, a shelf that blanks on a hiccup is worse.
  await probeFulfillableSkills()
}

export async function refreshAtumSkillsFor(agentId: string): Promise<void> {
  $atumSkillRefresh.set({ error: null, state: 'loading' })

  try {
    commitAgent(agentId, await loadInstalledFor(agentId))
    $atumSkillRefresh.set({ error: null, state: 'ready' })
  } catch (error) {
    $atumSkillRefresh.set({ error: errorMessage(error), state: 'failed' })
  }
}

/**
 * After an action, read the assistant's installed map again. A poll can fail
 * after the action itself succeeded, so a failure is cleared only when this
 * fresh read shows the goal state; if the read fails, the failure stands.
 */
async function settleAfterAction(agentId: string, entry: AtumStoreSkillEntry, kind: 'install' | 'uninstall'): Promise<void> {
  $atumSkillRefresh.set({ error: null, state: 'loading' })

  try {
    const installed = await loadInstalledFor(agentId)

    commitAgent(agentId, installed)
    $atumSkillRefresh.set({ error: null, state: 'ready' })

    const present = Boolean(installed[entry.identifier])

    if (kind === 'install' ? present : !present) {
      forgetHubAction(hubTargetKey(atumSkillTarget(agentId).profile, entry.identifier))
    }
  } catch (error) {
    $atumSkillRefresh.set({ error: errorMessage(error), state: 'failed' })
  }
}

export async function addAtumSkill(entry: AtumStoreSkillEntry, agentIds: readonly string[]): Promise<void> {
  for (const agentId of agentIds) {
    const agent = $atumAgents.get().find(candidate => candidate.id === agentId)

    if (!agent?.hostedId || !isStoreItemOwned($atumStoreCatalog.get().catalog, 'skill', entry.id, agent.hostedId)) { throw new Error('training_required') }

    if (entry.cloudProtected) { continue }

    try {
      // Serialized per identifier inside hub-actions, across every caller.
      await installHubSkillFor(atumSkillTarget(agentId), entry.identifier)
    } catch {
      // The action store retains spawn/poll failures for the surface to show.
    }

    await settleAfterAction(agentId, entry, 'install')
  }
}

export async function removeAtumSkill(entry: AtumStoreSkillEntry, agentId: string): Promise<void> {
  if (entry.cloudProtected) { return }

  try {
    await uninstallHubSkillFor(atumSkillTarget(agentId), entry.identifier, async () => {
      // Resolved once this removal holds the identifier's turn: an install
      // that just finished may have recorded a name the cached map predates.
      try {
        const installed = await loadInstalledFor(agentId)

        commitAgent(agentId, installed)

        return installed[entry.identifier]?.name || storeSkillLockName(entry.identifier)
      } catch {
        return $installedByAgent.get()[agentId]?.[entry.identifier]?.name || storeSkillLockName(entry.identifier)
      }
    })
  } catch {
    // The action store retains spawn/poll failures for the surface to show.
  }

  await settleAfterAction(agentId, entry, 'uninstall')
}

export function tryAtumSkill(prompt: string, agentId: string, entry?: AtumStoreSkillEntry): void {
  const agent = $atumAgents.get().find(candidate => candidate.id === agentId)
  const accountId = $atumAccountScopeId.get()

  if (entry?.cloudProtected && (!accountId || !agent?.hostedId || !agent.identityId || agent.localProfileId === null ||
      !isStoreItemOwned($atumStoreCatalog.get().catalog, 'skill', entry.id, agent.hostedId))) { return }

  // Discover unmounts the composer, so its event bus has no listener. The
  // new-session draft is consumed when the fresh chat mounts and survives
  // that gap. Anything the person already typed in a new chat is kept as
  // written and the prompt goes underneath it; nothing is sent on their behalf.
  const existing = takeSessionDraft(null)
  const prior = existing.text.trimEnd()
  const text = prior.trim() ? `${prior}\n\n${prompt.trim()}` : prompt.trim()

  stashSessionDraft(null, text, existing.attachments)
  talkToAtumAgent(agentId)

  if (entry?.cloudProtected && accountId && agent?.hostedId) {
    prepareAtumTraining({ accountId, assistantId: agent.hostedId, assistantIdentityId: agent.identityId, profileId: agent.id, skillId: entry.id })
  }

  $railDestination.set('chat')
}

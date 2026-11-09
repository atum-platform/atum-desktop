/**
 * The second sanctioned crossing from Hermes into the Atum product.
 *
 * Atum is one assistant the user already knows, plus any agents they make:
 * a personal assistant, a marketing assistant, a household one. Each is a
 * Hermes profile, which is why this module is allowed to read `$profiles` and
 * why `design-contract.test.ts` names it in its `SANCTIONED` map.
 *
 * What crosses is only what a person would recognise as theirs: the agent's
 * name, its avatar, what it is for, and whether Atum made it. What does not
 * cross is everything a profile carries for the engine's benefit — aliases,
 * distributions, skill counts, gateway service state, wrapper scripts, and
 * the profile's path on disk. Those are Hermes organisation and they stay out,
 * exactly as projects, worktrees, session pins, and cron do.
 *
 * What ALSO lives here is how a person has arranged their own assistants —
 * which are pinned to the top of their section and the order they dragged
 * the rest into. That is product state keyed by agent id, kept beside the
 * projection so the roster receives agents already in the user's order.
 */

import { atom, computed } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import {
  $activeGatewayProfile,
  $newChatProfile,
  $profiles,
  newSessionInProfile,
  normalizeProfileKey
} from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import type { ParticipantDisplay } from '../../../shared/atum-participants'

import {
  $atumAssistantDirectory,
  type AtumAssistantDirectory,
  displayAtumAssistant,
  hostedAtumAssistant
} from './assistant-directory'

/** The master assistant. Always present, never renamed, never deleted. */
export const ATUM_AGENT_ID = 'default'

/** Products stamp the profiles they create so they never rewrite a hand-made one. */
export const ATUM_MANAGED_BY = 'atum'

export interface AtumAgent {
  /** Local routing key. The Hermes profile name, and the key every chat is grouped by. Never leaves this machine. */
  id: string
  /** Stable account identity for local agents and the hosted id for setup-only rows.
   *  Arrangement must use this, never a profile directory name. */
  arrangementId?: string
  /** A cloud-only row deliberately has no profile until the person selects Set up here. */
  localProfileId?: string | null
  /**
   * The agent's stable identity: a UUID the backend minted once. This is the
   * only id that may leave the machine, because the profile name is a
   * directory — renamed by Hermes, copied by a clone, and identical on two
   * machines that each made a "Marketing". Empty while the backend has not
   * reported one (an older backend, or a profile it could not write).
   */
  identityId: string
  /** Bumped on every identity write, so a hosted copy can tell it is behind. 0 when unknown. */
  lifecycleRevision: number
  /**
   * What the roster shows. Empty on the master assistant, whose name is
   * localized product copy the roster supplies; a named agent always carries
   * its own title, falling back to a readable form of its id.
   */
  title: string
  /** A short symbol, an emoji in practice. Empty when the agent has none. */
  avatar: string
  /** Hosted assistant row id; account scoped and absent before registration. */
  hostedId?: string | null
  /** Server-derived image URL; never persisted with the local profile. */
  avatarUrl?: string | null
  /** Account-scoped hosted display identity, absent until this profile is registered. */
  participant?: ParticipantDisplay
  /** One quiet line under the title. Empty renders nothing, never a placeholder. */
  description: string
  /** The master Atum assistant, which owns the new-chat affordance. */
  isDefault: boolean
  /**
   * Created by Atum rather than by hand in the terminal. Only these may have
   * their settings repaired or be deleted from the product.
   */
  isManaged: boolean
  /**
   * Kept at the top of the user's own assistants. The master is never pinned:
   * it is above the pinnable section altogether, not first within it.
   */
  pinned: boolean
  /** A hosted definition is required before another device can materialize this assistant. */
  definitionState?: 'available' | 'local_only' | 'setup'
}

/**
 * How a person has arranged their assistants. Product state, not engine
 * state: the ids are Atum agent ids and nothing here reaches a profile.
 * `order` is every subordinate agent in the order the user last left them;
 * `pins` is the subset held at the top of that section.
 */
export interface AtumAgentArrangement {
  order: readonly string[]
  pins: readonly string[]
}

const NO_ARRANGEMENT: AtumAgentArrangement = { order: [], pins: [] }

function arrangementRecord(value: unknown): Record<string, AtumAgentArrangement> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return {}}

  return Object.fromEntries(
    Object.entries(value).flatMap(([accountId, candidate]) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {return []}

      const record = candidate as Record<string, unknown>

      const clean = (item: unknown) =>
        Array.isArray(item)
          ? [...new Set(item.filter((id): id is string => typeof id === 'string' && id.length > 0))]
          : []

      return [[accountId, { order: clean(record.order), pins: clean(record.pins) }]]
    })
  )
}

/** Arrangement belongs to an Atum account. Legacy global profile-name entries
 * intentionally remain unclaimed: a profile name is not a portable identity. */
export const $atumAgentArrangements = persistentAtom<Record<string, AtumAgentArrangement>>(
  'atum.desktop.agentArrangementByAccount.v1',
  {},
  Codecs.json(arrangementRecord)
)

// Before account status resolves, keep a purely in-memory arrangement. It is
// never written under a global key, so ambiguous old profile names stay
// unclaimed while the roster remains usable during local startup.
const $atumUnscopedArrangement = atom<AtumAgentArrangement>(NO_ARRANGEMENT)

export const $atumAgentArrangement = computed(
  [$atumAgentArrangements, $atumAssistantDirectory, $atumAccountScopeId, $atumUnscopedArrangement],
  (all, directory, accountId, unscoped) =>
    (directory.accountId ?? accountId) ? (all[directory.accountId ?? accountId!] ?? NO_ARRANGEMENT) : unscoped
)

// Compatibility exports for older narrow callers. They are account-scoped and
// never read the old global keys, which avoids claiming ambiguous profile ids.
export const $atumAgentOrder = computed($atumAgentArrangement, arrangement => [...arrangement.order])
export const $atumAgentPins = computed($atumAgentArrangement, arrangement => [...arrangement.pins])

/** Title case a bare profile id so `mkt-taylor` reads as `Mkt Taylor`. */
function titleFromId(id: string): string {
  return id
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toLocaleUpperCase('en-US') + part.slice(1))
    .join(' ')
}

/**
 * Sort a person's own assistants the way they arranged them: pinned ones
 * first, then the manual order, with anything they have not placed yet (a
 * freshly made agent, one made in the terminal) after the placed ones in
 * name order. Stable, so two unplaced agents keep their name order.
 */
export function arrangeAtumAgents(agents: readonly AtumAgent[], arrangement: AtumAgentArrangement): AtumAgent[] {
  const placed = new Map(arrangement.order.map((id, index) => [id, index]))

  const rank = (agent: AtumAgent) =>
    placed.get(agent.arrangementId ?? agent.id) ?? placed.get(agent.id) ?? Number.MAX_SAFE_INTEGER

  return [...agents].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) || rank(left) - rank(right) || left.title.localeCompare(right.title)
  )
}

/**
 * Pure projection so ordering and fallbacks are testable without stores.
 * The master assistant is always first and always present, even before the
 * profile list has loaded, so the roster never renders without its home row.
 */
export function projectAtumAgents(
  profiles: readonly ProfileInfo[],
  arrangement: AtumAgentArrangement = NO_ARRANGEMENT,
  directory: AtumAssistantDirectory = { accountId: null, entries: [], state: 'empty' }
): AtumAgent[] {
  // The master row exists before the profile list has loaded; its identity
  // arrives with the list and is empty until then, never invented.
  const defaultProfile = profiles.find(
    profile => profile.is_default || normalizeProfileKey(profile.name) === ATUM_AGENT_ID
  )

  const defaultIdentityId = (defaultProfile?.identity_id ?? '').trim()
  const defaultHosted = hostedAtumAssistant(directory, defaultIdentityId, true)

  const master: AtumAgent = {
    id: ATUM_AGENT_ID,
    arrangementId: defaultIdentityId || ATUM_AGENT_ID,
    localProfileId: ATUM_AGENT_ID,
    identityId: defaultIdentityId,
    lifecycleRevision: defaultProfile?.lifecycle_revision ?? 0,
    // The master is hosted identity: its name follows the account-scoped row
    // rather than a local profile slug or product fallback.
    title: defaultHosted?.displayName.trim() ?? '',
    avatar: '',
    hostedId: defaultHosted?.id ?? null,
    avatarUrl: defaultHosted?.avatarUrl ?? null,
    participant: displayAtumAssistant(directory, defaultIdentityId, true),
    description: '',
    isDefault: true,
    isManaged: true,
    pinned: false,
    definitionState: defaultHosted?.definitionRevision ? 'available' : 'local_only'
  }

  const pins = new Set(arrangement.pins)

  const localIdentityIds = new Set<string>()

  const others = profiles
    .filter(profile => !profile.is_default && normalizeProfileKey(profile.name) !== ATUM_AGENT_ID)
    .map<AtumAgent>(profile => {
      const id = normalizeProfileKey(profile.name)
      const identityId = (profile.identity_id ?? '').trim()
      const hosted = hostedAtumAssistant(directory, identityId, false)
      localIdentityIds.add(identityId)

      return {
        id,
        arrangementId: identityId || `local:${id}`,
        localProfileId: id,
        identityId,
        lifecycleRevision: profile.lifecycle_revision ?? 0,
        title: hosted?.displayName.trim() || (profile.display_name ?? '').trim() || titleFromId(profile.name),
        avatar: (profile.avatar ?? '').trim(),
        hostedId: hosted?.id ?? null,
        avatarUrl: hosted?.avatarUrl ?? null,
        participant: displayAtumAssistant(directory, identityId, false),
        description: (profile.description ?? '').trim(),
        isDefault: false,
        isManaged: (profile.managed_by ?? '').trim().toLowerCase() === ATUM_MANAGED_BY,
        pinned: pins.has(identityId || `local:${id}`) || pins.has(id),
        definitionState: (hosted?.definitionRevision ?? 0) > 0 ? 'available' : 'local_only'
      }
    })

  // Retired hosted identities are authoritative. Keep their local files, but
  // neither render nor re-register them after a successful directory read.
  const visibleLocal =
    directory.state === 'ready'
      ? others.filter(
          agent => !directory.entries.some(row => row.status === 'retired' && row.identityId === agent.identityId)
        )
      : others

  const setupRows = directory.entries
    .filter(row => row.status === 'active' && !row.isDefault && row.identityId && !localIdentityIds.has(row.identityId))
    .map<AtumAgent>(row => ({
      id: `cloud:${row.id}`,
      arrangementId: row.identityId!,
      localProfileId: null,
      identityId: row.identityId!,
      lifecycleRevision: row.lifecycleRevision,
      title: row.displayName,
      avatar: row.avatar ?? '',
      hostedId: row.id,
      avatarUrl: row.avatarUrl,
      participant: displayAtumAssistant(directory, row.identityId!, false),
      description: '',
      isDefault: false,
      isManaged: true,
      pinned: pins.has(row.identityId!) || pins.has(`cloud:${row.id}`),
      definitionState: (row.definitionRevision ?? 0) > 0 ? 'setup' : 'local_only'
    }))

  return [master, ...arrangeAtumAgents([...visibleLocal, ...setupRows], arrangement)]
}

/** Which agent owns a session, for a list that spans every agent. */
export function agentIdForSession(profile: null | string | undefined): string {
  return normalizeProfileKey(profile)
}

export const $atumAgents = computed(
  [$profiles, $atumAgentArrangement, $atumAssistantDirectory],
  (profiles, arrangement, directory) => projectAtumAgents(profiles, arrangement, directory)
)

/**
 * Pin an assistant to the top of the user's own section, or release it.
 * Pinning also moves it to the front of the manual order, so "pin to top"
 * means exactly that even among several pinned assistants; unpinning leaves
 * it where the order says, which is now just below the remaining pins.
 */
function mutateArrangement(mutator: (current: AtumAgentArrangement) => AtumAgentArrangement): void {
  const accountId = $atumAssistantDirectory.get().accountId ?? $atumAccountScopeId.get()
  const next = mutator($atumAgentArrangement.get())

  if (!accountId) {
    $atumUnscopedArrangement.set(next)

    return
  }

  $atumAgentArrangements.set({ ...$atumAgentArrangements.get(), [accountId]: next })
}

export function setAtumAgentPinned(agentId: string, pinned: boolean): void {
  const agent = $atumAgents.get().find(candidate => candidate.id === agentId)
  const id = agent?.arrangementId ?? agent?.id ?? ''

  if (!id || id === ATUM_AGENT_ID) {
    return
  }

  mutateArrangement(current => {
    const pins = current.pins.filter(candidate => candidate !== id)

    return {
      pins: pinned ? [id, ...pins] : pins,
      order: pinned ? [id, ...current.order.filter(candidate => candidate !== id)] : [...current.order]
    }
  })
}

/**
 * Record the order the user dragged their assistants into. `ids` is the full
 * subordinate list as it now reads on screen — pinned block first — so the
 * next render reproduces it exactly.
 */
export function reorderAtumAgents(ids: readonly string[]): void {
  const byId = new Map($atumAgents.get().map(agent => [agent.id, agent.arrangementId ?? agent.id]))
  const order = [...new Set(ids.map(id => byId.get(id) ?? '').filter(id => id && id !== ATUM_AGENT_ID))]
  mutateArrangement(current => ({ ...current, order }))
}

/**
 * Remote account snapshots must never resolve through the directory: it can
 * still describe the outgoing account while the account-scope atom has already
 * advanced. Guard the target directly, then write only that record.
 */
export function setAtumAgentArrangementForAccount(accountId: string, next: AtumAgentArrangement): boolean {
  if ($atumAccountScopeId.get() !== accountId) {
    return false
  }

  const isUuid = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)

  const clean = (values: readonly string[]) => [...new Set(values.filter(isUuid))]

  $atumAgentArrangements.set({
    ...$atumAgentArrangements.get(),
    [accountId]: { order: clean(next.order), pins: clean(next.pins) }
  })

  return true
}

/** Test seam: forget every pin and manual placement. */
export function resetAtumAgentArrangement(): void {
  $atumUnscopedArrangement.set(NO_ARRANGEMENT)
  mutateArrangement(() => NO_ARRANGEMENT)
}

/**
 * Which agent a new chat belongs to. Never empty, so the roster always has
 * exactly one agent showing as current.
 *
 * This mirrors how a session is actually created — `$newChatProfile` when one
 * was chosen, otherwise whichever agent the gateway is on. Answering "the
 * master" for an unset choice would be a lie the moment the gateway is on
 * someone else (⌘N clears the choice without moving the gateway), and the
 * roster would highlight Atum while the next message went elsewhere.
 */
export const $atumNewChatAgent = computed([$newChatProfile, $activeGatewayProfile], (chosen, gateway) =>
  normalizeProfileKey(chosen ?? gateway)
)

/**
 * Talk to `agentId`: point the next chat at it and open its backend.
 *
 * The roster calls this rather than the profile store directly, so the one
 * place that knows an agent IS a profile stays this module. Starting a chat
 * is the only thing choosing an agent does — there is no separate "switch
 * workspace" step for the user to understand.
 */
export function talkToAtumAgent(agentId: string): void {
  newSessionInProfile(normalizeProfileKey(agentId) || ATUM_AGENT_ID)
}

/**
 * Follow whichever agent owns the chat being opened.
 *
 * Opening a chat is not choosing who the next new chat is for — it is moving to
 * where that chat already lives, and resuming it swaps the app onto that
 * agent. Clearing the explicit choice lets the composer track that move, so
 * reading one of Atum's chats after making an assistant no longer leaves the
 * roster showing the new assistant as current and sending the next message to
 * it. It deliberately does NOT start a fresh session: the user is opening an
 * existing chat, not asking for a new one.
 */
export function followAtumAgentOfOpenChat(): void {
  $newChatProfile.set(null)
}

/**
 * Atum product-shell selection state.
 *
 * This is the ONLY store the Atum shell owns. It deliberately does not model
 * sessions, profiles, projects, worktrees, pins, or cron — the Atum product
 * surface shows one local assistant conversation plus hosted Atum DMs, and the
 * Hermes organisation of those things stays where it already lives.
 *
 * Scope: every key below is window/presentation state, so it is global-scoped
 * (`hermes.desktop.atum.*`) rather than connection- or profile-scoped.
 */

import { atom } from 'nanostores'

import { ATUM_ROSTER_WIDTH, ATUM_WORKSPACE_DEFAULT_PERCENT, ATUM_WORKSPACE_MAX_PERCENT, ATUM_WORKSPACE_MIN_PERCENT } from '@/lib/atum-shell-geometry'
import { Codecs, persistentAtom } from '@/lib/persisted'

export { ATUM_ROSTER_WIDTH } from '@/lib/atum-shell-geometry'

/** Geometry the Atum shell is specified in. Exported so tests and the panels
 *  read one copy instead of re-deriving the numbers. */
export const ATUM_RAIL_WIDTH = 58
/** Collapsing the left sidebar keeps the rail — account, chat and Settings stay
 *  one click away — and only narrows it. A rail-less collapsed state used to be
 *  the design; it traded the whole navigation instrument for ~44px. */
export const ATUM_RAIL_COLLAPSED_WIDTH = 44
/** The roster is user-resizable. The floor keeps a title plus its unread pill
 *  legible; the ceiling stops it from crowding the chat on a narrow window. */
export const ATUM_ROSTER_MIN_WIDTH = 208
export const ATUM_ROSTER_MAX_WIDTH = 420
export const ATUM_CHAT_MIN_WIDTH = 420

/** Inline chat/workspace split. Percentages describe the two-column main
 *  region after the left sidebar, so 50 is a real equal split at every window
 *  width rather than a pixel approximation that immediately drifts. */
export { ATUM_WORKSPACE_DEFAULT_PERCENT, ATUM_WORKSPACE_MAX_PERCENT, ATUM_WORKSPACE_MIN_PERCENT } from '@/lib/atum-shell-geometry'

/** Below this (SPEC §2 narrow) the sidebar becomes a drawer over an ink scrim
 *  and the workspace goes full-frame. Presentation only — it never changes
 *  `$workspaceOpen`. */
export { ATUM_COMPACT_BREAKPOINT_PX } from '@/lib/atum-shell-geometry'
/** Below this the workspace replaces the chat full-frame instead of splitting it. */
export const ATUM_WORKSPACE_DRAWER_BREAKPOINT_PX = 1024

/** Rail destinations that actually render. `discover` swaps the chat plate for
 *  the Discover surface; the roster and workspace are untouched. */
export type AtumRailDestination = 'chat' | 'discover'
export type AtumMaterialMode = 'floating-glass' | 'legacy-solid'

const SHELL_KEY = 'hermes.desktop.atum.shell'
const MATERIAL_KEY = 'hermes.desktop.atum.material'
const SIDEBAR_OPEN_KEY = 'hermes.desktop.atum.sidebarOpen'
// V2 intentionally starts every upgraded dogfood install with the requested
// open, equal-width workspace instead of inheriting the former closed/380px
// defaults from the old keys.
const WORKSPACE_OPEN_KEY = 'hermes.desktop.atum.workspaceOpenV3'
const WORKSPACE_PERCENT_KEY = 'hermes.desktop.atum.workspacePercentV2'
const WORKSPACE_EXPANDED_KEY = 'hermes.desktop.atum.workspaceExpanded'
const ROSTER_WIDTH_KEY = 'hermes.desktop.atum.rosterWidth'

export function clampRosterWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return ATUM_ROSTER_WIDTH
  }

  return Math.round(Math.min(Math.max(width, ATUM_ROSTER_MIN_WIDTH), ATUM_ROSTER_MAX_WIDTH))
}

export function clampWorkspacePercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return ATUM_WORKSPACE_DEFAULT_PERCENT
  }

  return Math.round(Math.min(Math.max(percent, ATUM_WORKSPACE_MIN_PERCENT), ATUM_WORKSPACE_MAX_PERCENT))
}

/** The Atum product shell. `false` restores the legacy Hermes chrome verbatim
 *  (titlebar tool clusters, pane tree, statusbar) for debugging and fallback. */
export const $atumShellEnabled = persistentAtom(SHELL_KEY, true, Codecs.bool)

/** The floating-glass material is Atum's default visual language. The former
 * solid desk remains addressable as an undocumented recovery/debug fallback;
 * it is deliberately not exposed as a second product theme. */
export const $atumMaterialMode = persistentAtom<AtumMaterialMode>(MATERIAL_KEY, 'floating-glass', {
  decode: raw => (raw === 'legacy-solid' ? 'legacy-solid' : 'floating-glass'),
  encode: value => value
})

/** Roster search box. Ephemeral: a query is not worth restoring across launches. */
export const $rosterQuery = atom('')

/** Wide-window left rail + roster. Compact windows keep the rail and present
 *  the roster as the existing drawer. */
export const $sidebarOpen = persistentAtom(SIDEBAR_OPEN_KEY, true, Codecs.bool)

const workspaceInitiallyOpen =
  typeof window === 'undefined' ? true : window.innerWidth >= ATUM_WORKSPACE_DRAWER_BREAKPOINT_PX

export const $workspaceOpen = persistentAtom(WORKSPACE_OPEN_KEY, workspaceInitiallyOpen, Codecs.bool)

/** Full-frame workspace (SPEC §1a's "phóng to"). The panel leaves the split
 *  and takes the whole window, exactly as it does under the narrow breakpoint
 *  (mock 2g): same 44px tab bar, the traffic-light pill leading it, the chat
 *  still mounted underneath. A mode the person chose, so it is persisted like
 *  the split percentage — and presentation only, so a narrow window (already
 *  full-frame) ignores it and restores the split when the window widens. */
export const $workspaceExpanded = persistentAtom(WORKSPACE_EXPANDED_KEY, false, Codecs.bool)

export const $workspacePercent = persistentAtom<number>(WORKSPACE_PERCENT_KEY, ATUM_WORKSPACE_DEFAULT_PERCENT, {
  decode: raw => {
    const parsed = Number.parseInt(raw, 10)

    return clampWorkspacePercent(parsed)
  },
  encode: value => String(value)
})

/** Roster width in px. Persisted absolute rather than proportional: the roster
 *  holds a fixed-size row, so it should keep the width the person chose when the
 *  window resizes, unlike the chat/workspace split. */
export const $rosterWidth = persistentAtom<number>(ROSTER_WIDTH_KEY, ATUM_ROSTER_WIDTH, {
  decode: raw => clampRosterWidth(Number.parseInt(raw, 10)),
  encode: value => String(value)
})

/** Only value in P0. Kept as an atom so the rail's active state has one owner
 *  when devices/other destinations become real. */
/**
 * Discover collapses the roster on arrival — it is a surface for adding things
 * to Atum, not a conversation with a contact list beside it. This remembers
 * that the person asked for the roster back *while on Discover*, so the
 * collapse is a default and not a lock. It resets on every arrival, so the next
 * visit collapses again.
 *
 * `$sidebarOpen` is never touched by any of this: leaving Discover restores
 * exactly what the person had in chat.
 */
export const $rosterShownOnDiscover = atom(false)

/** The shelves of the one storefront. Discover renders one at a time; Featured
 *  keeps the cross-catalog mix and is what a plain arrival opens on. */
export type AtumDiscoverShelf = 'featured' | 'agents' | 'skills' | 'apps' | 'pets' | 'people'

const DEFAULT_DISCOVER_SHELF: AtumDiscoverShelf = 'featured'

/** Which shelf Discover opens on — an ARRIVAL INTENT, not panel truth, in the
 *  `$rosterShownOnDiscover` shape: whoever sends the user to Discover seeds it,
 *  the panel owns its own `useState` initialized from the seed, and every
 *  arrival resets it (the `$railDestination.listen` below) so the next plain
 *  visit opens on Featured. A docked route-tile pane never reads this — its
 *  shelf identity comes from its path, so switching the storefront's shelf
 *  never retargets a docked Pets pane. */
export const $discoverShelf = atom<AtumDiscoverShelf>(DEFAULT_DISCOVER_SHELF)

/** Bumped on every `setDiscoverShelf`, even a re-seed of the shelf already
 *  held: nanostores skips an unchanged set, so the VALUE cannot carry "open
 *  the shelf I'm already seeded with" to a panel that has since switched away.
 *  The panel adopts the seed whenever the nonce moves. */
export const $discoverShelfNonce = atom(0)

export const $railDestination = atom<AtumRailDestination>('chat')

// Every arrival at Discover starts collapsed and on Featured, whatever the
// last visit ended on. Seeding a shelf therefore has to happen AFTER the rail
// flips — `useOpenStorefront` owns that ordering.
$railDestination.listen(next => {
  if (next === 'discover') {
    $rosterShownOnDiscover.set(false)
    $discoverShelf.set(DEFAULT_DISCOVER_SHELF)
  }
})

/** Compact presentations open the roster over the chat instead of beside it. */
export const $rosterDrawerOpen = atom(false)

export function setRosterQuery(query: string): void {
  if (query !== $rosterQuery.get()) {
    $rosterQuery.set(query)
  }
}

export function setWorkspaceOpen(open: boolean): void {
  if (open !== $workspaceOpen.get()) {
    $workspaceOpen.set(open)
  }

  // Closing the panel means "back to the chat". Reopening it later should give
  // the split back rather than silently swallowing the whole window again.
  if (!open) {
    setWorkspaceExpanded(false)
  }
}

export function setWorkspaceExpanded(expanded: boolean): void {
  if (expanded !== $workspaceExpanded.get()) {
    $workspaceExpanded.set(expanded)
  }
}

export function setSidebarOpen(open: boolean): void {
  if (open !== $sidebarOpen.get()) {
    $sidebarOpen.set(open)
  }
}

export function toggleWorkspace(): void {
  setWorkspaceOpen(!$workspaceOpen.get())
}

/** Persist a resize as a proportion so relaunching or resizing the window
 *  preserves the relationship between transcript and workspace. */
export function setWorkspacePercent(percent: number): void {
  const next = clampWorkspacePercent(percent)

  if (next !== $workspacePercent.get()) {
    $workspacePercent.set(next)
  }
}

export function setRosterWidth(width: number): void {
  const next = clampRosterWidth(width)

  if (next !== $rosterWidth.get()) {
    $rosterWidth.set(next)
  }
}

export function setRosterDrawerOpen(open: boolean): void {
  if (open !== $rosterDrawerOpen.get()) {
    $rosterDrawerOpen.set(open)
  }
}

/** Seed the shelf Discover opens on. An arrival intent only — see
 *  `$discoverShelf`. Callers arriving at Discover must set the rail FIRST: the
 *  arrival listener reseeds Featured, so this seed has to be planted after the
 *  flip (`useOpenStorefront` owns that ordering). The nonce always moves, so
 *  re-opening the shelf already seeded still reaches an open panel. */
export function setDiscoverShelf(shelf: AtumDiscoverShelf): void {
  if (shelf !== $discoverShelf.get()) {
    $discoverShelf.set(shelf)
  }

  $discoverShelfNonce.set($discoverShelfNonce.get() + 1)
}

/** Test seam: reset every Atum shell atom to its default. */
export function resetAtumShellState(): void {
  $atumMaterialMode.set('floating-glass')
  $rosterQuery.set('')
  $sidebarOpen.set(true)
  $workspaceOpen.set(workspaceInitiallyOpen)
  $workspacePercent.set(ATUM_WORKSPACE_DEFAULT_PERCENT)
  $workspaceExpanded.set(false)
  $rosterWidth.set(ATUM_ROSTER_WIDTH)
  $railDestination.set('chat')
  $rosterShownOnDiscover.set(false)
  $discoverShelf.set(DEFAULT_DISCOVER_SHELF)
  $discoverShelfNonce.set(0)
  $rosterDrawerOpen.set(false)
}

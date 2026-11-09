import { atom, computed } from 'nanostores'

import { persistString, storedBoolean, storedString } from '@/lib/storage'
import {
  $petActivityByAgent,
  $petInfoByAgent,
  $petReplyByAgent,
  $petUnreadByAgent,
  clearPetUnread,
  type PetActivity,
  petActivityFor,
  petDrawScale,
  type PetInfo,
  petInfoFor,
  petProfile,
  petReplyFor,
  petUnreadFor
} from '@/store/pet'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $awaitingResponse, $busy } from '@/store/session'

/**
 * Controller for the pop-out pet overlays (main-renderer side).
 *
 * Shift-clicking an in-window pet "pops it out" into a transparent,
 * always-on-top OS window (created in electron/main.ts) that can leave the
 * app's bounds and stays visible while Hermes is minimized. One assistant, one
 * pet, one window: several can be out at once, each keyed by its agent key.
 *
 * Those windows carry NO gateway connection — this renderer remains the single
 * source of truth and pushes each pet's live state to its own window over IPC.
 * Control flows back (pop the pet back in, submit a composer message) via
 * `onControl`, where the main process stamps the sending window's agent so a
 * handler can route a message by it.
 *
 * An overlay renders the same `PetSprite` / `PetBubble` as the in-window pet by
 * mirroring the reactive inputs of `$petState` (`$petInfo`, `$petActivity`,
 * `$busy`, `$awaitingResponse`) into its own copies of those atoms — so a
 * popped-out mascot is pixel-identical and needs zero bespoke render logic. An
 * overlay window holds exactly one pet, which is why it keeps using the plain
 * active-agent atoms rather than the keyed ones this module reads.
 */

export interface PetOverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Request to open the overlay window. `screen` says whether `bounds` are already
 * in absolute screen coordinates (a remembered/dragged spot) or in the main
 * window's viewport space (a fresh shift-click pop-out, which main.ts converts
 * by adding the content origin).
 */
export interface PetOverlayOpenRequest {
  bounds: PetOverlayBounds
  /**
   * Which assistant's pet this window is — its agent key, i.e. its Hermes
   * profile key. The main process keys its window map on this. Omitted
   * addresses the shared default window.
   */
  petId?: string
  screen?: boolean
}

/** Everything the overlay needs to reproduce the live mascot. */
export interface PetOverlayStatePayload {
  /** Which overlay window this push is addressed to; omitted means the default. */
  petId?: string
  info: PetInfo
  activity: PetActivity
  busy: boolean
  awaiting: boolean
  /** Drives the overlay's mail icon: a finish landed while you were away. */
  unread: boolean
  /** The last thing this assistant said, for the pet to speak. Empty when quiet. */
  reply: string
  /** Latest reaction — bumping its id forwards a burst to the overlay. */
  reaction: PetReaction | null
}

/**
 * Control messages from an overlay. `petId` is stamped by the main process from
 * the sending window — never taken from the overlay's own claim — so a handler
 * can route a submit into that assistant's session and trust the attribution.
 */
export type PetOverlayControl = { petId?: string } & (
  | { type: 'pop-in' }
  | { type: 'ready' }
  | { type: 'submit'; text: string }
  | { type: 'bounds'; bounds: PetOverlayBounds }
  | { type: 'open-app' }
  | { type: 'toggle-app' }
  | { type: 'scale'; scale: number }
  | { type: 'hide' }
  | { type: 'settings' }
  | { type: 'store' }
)

// Persisted across restarts: which pets were popped out, and where on the
// desktop the user left each one. v1 held a single boolean + one bounds blob for
// the one overlay there could be; v2 is per agent.
const OVERLAY_ACTIVE_KEY_V1 = 'hermes.desktop.pet-overlay-active.v1'
const OVERLAY_BOUNDS_KEY_V1 = 'hermes.desktop.pet-overlay-bounds.v1'
// v4, because v3 shipped the opposite default: it popped the master's pet onto
// the desktop on first run, so every v3 value reads `["default"]` whether or not
// anyone chose that. There is no way to tell an applied default from a real
// preference in those values, so they are discarded rather than migrated — the
// in-window default below applies once, and every choice made from here is
// recorded under v4 and honoured.
const OVERLAY_AGENTS_KEY = 'hermes.desktop.pet-overlay-agents.v4'
const overlayBoundsKey = (agent: string) => `hermes.desktop.pet-overlay-bounds.v2.${agent}`

/** The master assistant — the only pet a pre-per-agent build could have had. */
const MASTER_AGENT = 'default'

function storedAgents(): string[] {
  const raw = storedString(OVERLAY_AGENTS_KEY)

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown

      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string' && Boolean(value))
      }
    } catch {
      // Corrupt value — fall through and treat it as never written.
    }
  }

  // v1 → v4: a popped-out pet belonged to whichever profile was active, and the
  // only one we can attribute it to now is the master. Only `true` is honoured:
  // the v1 atom persisted on *subscribe*, which fires immediately, so `false`
  // was written for everyone who ever launched a pre-per-agent build whether or
  // not they touched the pet. `true`, though, could only be written by someone
  // who actually popped the pet out, so it is a real preference worth keeping.
  if (storedBoolean(OVERLAY_ACTIVE_KEY_V1, false)) {
    return [MASTER_AGENT]
  }

  // Nothing chosen yet: the pet lives in the app window. That is where it can be
  // ignored — it shares the window it decorates, and closing Atum puts it away
  // with everything else. A window that floats above every other app until you
  // dismiss it is a thing you opt into, so popping out is a choice (right-click
  // the pet, or the account menu's Pet submenu) and it sticks once made.
  return []
}

/** Agents whose pet is currently popped out into its own desktop window. */
export const $petOverlayAgents = atom<readonly string[]>(storedAgents())

$petOverlayAgents.subscribe(agents => persistString(OVERLAY_AGENTS_KEY, JSON.stringify(agents)))

/** Is the *active* agent's pet popped out — what the in-window surfaces ask. */
export const $petOverlayActive = computed([$petOverlayAgents, $activeGatewayProfile], (agents, profile) =>
  agents.includes(normalizeProfileKey(profile))
)

function setOverlayOpen(agent: string, open: boolean): void {
  const agents = $petOverlayAgents.get()
  const has = agents.includes(agent)

  if (has === open) {
    return
  }

  $petOverlayAgents.set(open ? [...agents, agent] : agents.filter(id => id !== agent))
}

/**
 * Reaction signal forwarded to the popped-out overlay window via the state
 * mirror below. `id` is a monotonic nonce so the overlay fires once per bump;
 * `kind` selects the renderer (today only `vibe` → hearts). Generic on purpose
 * so future reactions (emoji, etc.) ride the same channel.
 */
export interface PetReaction {
  id: number
  kind: string
}

export const $petReaction = atom<PetReaction | null>(null)

export const forwardPetReaction = (kind: string) => $petReaction.set({ id: ($petReaction.get()?.id ?? 0) + 1, kind })

function loadSavedBounds(agent: string): null | PetOverlayBounds {
  try {
    // Fall back to the v1 blob so the first pet to pop out after an upgrade
    // reopens where the user last left it.
    const raw = storedString(overlayBoundsKey(agent)) || storedString(OVERLAY_BOUNDS_KEY_V1)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<PetOverlayBounds>

    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return { height: parsed.height, width: parsed.width, x: parsed.x, y: parsed.y }
    }
  } catch {
    // fall through to null
  }

  return null
}

function saveBounds(agent: string, bounds: PetOverlayBounds): void {
  persistString(overlayBoundsKey(agent), JSON.stringify(bounds))
}

// The overlay window is padded around the sprite so the bubble (above), the
// drag area, and the pop-up composer all have room; the pet sits near the
// bottom and the rest of the rectangle is transparent + click-through.
const OVERLAY_PAD_X = 100
const OVERLAY_PAD_Y = 200
const OVERLAY_MIN_W = 240
const OVERLAY_MIN_H = 300

/**
 * Window bounds (width/height) that fully contain the pet at a given scale, plus
 * the padding for its bubble/composer/drag margins. The single source of truth
 * for both the initial pop-out size and the live wheel-to-scale resize, so the
 * sprite is never cropped by the window edge no matter how big it's scaled.
 */
export function overlayWindowSize(frameW: number, frameH: number, scale: number): { width: number; height: number } {
  return {
    width: Math.max(OVERLAY_MIN_W, Math.round(frameW * scale + OVERLAY_PAD_X)),
    height: Math.max(OVERLAY_MIN_H, Math.round(frameH * scale + OVERLAY_PAD_Y))
  }
}

// One entry per open overlay: the subscriptions mirroring that agent's state
// into its window.
const stateUnsubs = new Map<string, Array<() => void>>()
let controlUnsub: (() => void) | null = null
let submitHandler: ((text: string, agent: string) => void) | null = null
let openAppHandler: ((agent: string) => void) | null = null
let scaleHandler: ((scale: number, agent: string) => void) | null = null
let hideHandler: ((agent: string) => void) | null = null
let settingsHandler: (() => void) | null = null
let storeHandler: (() => void) | null = null

function currentPayload(agent: string): PetOverlayStatePayload {
  // `$busy` / `$awaitingResponse` describe the chat in front of you, so they are
  // only true of the active agent; a background agent's pet takes its coarse
  // state from its own `activity` slice (fed by `usePetBridge`).
  const isActive = agent === petProfile()

  return {
    petId: agent,
    info: petInfoFor(agent),
    activity: petActivityFor(agent),
    busy: isActive && $busy.get(),
    awaiting: isActive && $awaitingResponse.get(),
    unread: petUnreadFor(agent),
    reply: petReplyFor(agent),
    reaction: $petReaction.get()
  }
}

function pushNow(agent: string): void {
  window.hermesDesktop?.petOverlay?.pushState(currentPayload(agent))
}

/**
 * Open one agent's overlay window and start mirroring its state into it. The
 * main process echoes back the actual screen bounds it used — which may differ
 * from the request, since it cascades a window clear of any pet already at that
 * spot — so persist what comes back, not what we asked for.
 */
function openOverlay(agent: string, request: PetOverlayOpenRequest): void {
  const api = window.hermesDesktop?.petOverlay

  if (!api || stateUnsubs.has(agent)) {
    return
  }

  setOverlayOpen(agent, true)
  void api.open({ ...request, petId: agent }).then(res => {
    if (res?.bounds) {
      saveBounds(agent, res.bounds)
    }

    pushNow(agent)
  })

  // Mirror live state into the overlay. subscribe() fires immediately, so the
  // overlay also gets a first frame the moment it's ready (it asks via 'ready').
  // The keyed atoms republish on any agent's change; pushing this agent's own
  // payload on each is cheap and keeps the wiring uniform.
  //
  // A pet turned off has nothing to draw, and an overlay showing nothing is an
  // invisible always-on-top window the user cannot find or close. Closing on the
  // state change rather than at each call site covers every way a pet can be
  // disabled — the settings panel, the account menu, either context menu, a
  // `/pet` command — including ones that do not exist yet.
  //
  // Only a transition counts. `petInfoFor` reports an agent whose info has never
  // been fetched as disabled, and `restorePetOverlay` deliberately opens windows
  // for exactly those agents on boot; treating "not known yet" as "turned off"
  // would close every restored overlay before its sprite arrived.
  let sawEnabled = false

  const push = () => {
    if (petInfoFor(agent).enabled) {
      sawEnabled = true
    } else if (sawEnabled) {
      popInPet(agent)

      return
    }

    pushNow(agent)
  }

  stateUnsubs.set(agent, [
    $petInfoByAgent.subscribe(push),
    $petActivityByAgent.subscribe(push),
    $busy.subscribe(push),
    $awaitingResponse.subscribe(push),
    $petUnreadByAgent.subscribe(push),
    $petReplyByAgent.subscribe(push),
    $petReaction.subscribe(push)
  ])
}

/**
 * Pop the pet out of the window. `petRect` is the in-window sprite's viewport
 * rect; we grow it to the padded overlay size and center the window on the
 * pet's old spot (main.ts adds the window's screen origin). If the user has
 * popped out before, reopen at that remembered desktop spot instead.
 */
export function popOutPet(petRect: PetOverlayBounds, agent: string = petProfile()): void {
  if (stateUnsubs.has(agent)) {
    return
  }

  const saved = loadSavedBounds(agent)

  if (saved) {
    openOverlay(agent, { bounds: saved, screen: true })

    return
  }

  // Size the window off the pet's scale (not the measured rect, which includes
  // the shadow) so it matches the live resize math exactly — no jump on open.
  const pet = petInfoFor(agent)
  const { width, height } = overlayWindowSize(pet.frameW ?? 192, pet.frameH ?? 208, petDrawScale(pet))
  const x = Math.round(petRect.x - (width - petRect.width) / 2)
  const y = Math.round(petRect.y - (height - petRect.height) / 2)

  openOverlay(agent, { bounds: { height, width, x, y }, screen: false })
}

/**
 * Restore the overlay on boot if the pet was popped out when the app last
 * closed. Requires a remembered desktop spot — without one we fall back to the
 * in-window pet rather than spawning an orphan window at the origin.
 */
export function restorePetOverlay(): void {
  if (!window.hermesDesktop?.petOverlay) {
    return
  }

  for (const agent of $petOverlayAgents.get()) {
    if (stateUnsubs.has(agent)) {
      continue
    }

    // `popOutPet` prefers a remembered desktop spot and otherwise sizes the
    // window around the rect we hand it. On a first run there is no remembered
    // spot, so hand it where the in-window pet would have been standing: the pet
    // appears to step out of its usual corner rather than at the screen origin.
    // The window is sized off whatever `pet.info` has loaded so far and
    // self-corrects when the real scale arrives (see the overlay's resize
    // effect), so racing the first `pet.info` is harmless.
    popOutPet(defaultPetRect(agent), agent)
  }
}

/**
 * Where the in-window pet sits before anyone has dragged it: the lower-left
 * corner, in the main window's viewport space. Mirrors `loadPosition`'s fallback
 * in floating-pet.tsx.
 */
function defaultPetRect(agent: string): PetOverlayBounds {
  const pet = petInfoFor(agent)
  const scale = petDrawScale(pet)

  return {
    height: Math.round((pet.frameH ?? 208) * scale),
    width: Math.round((pet.frameW ?? 192) * scale),
    x: 24,
    y: (window.innerHeight || 600) - 220
  }
}

/**
 * Pop a pet out from a surface with no sprite to measure — the account menu,
 * a keybind. Same path as the pet's own gesture: a remembered desktop spot wins,
 * and otherwise the window opens where the in-window pet would have been
 * standing, so the pet appears to step out of its corner either way.
 */
export function popOutPetFromMenu(agent: string = petProfile()): void {
  popOutPet(defaultPetRect(agent), agent)
}

/** Pop one pet back into the window (closes its overlay window). */
export function popInPet(agent: string = petProfile()): void {
  for (const off of stateUnsubs.get(agent) ?? []) {
    off()
  }

  stateUnsubs.delete(agent)
  setOverlayOpen(agent, false)
  void window.hermesDesktop?.petOverlay?.close(agent)
}

/**
 * Register the handler that turns an overlay composer submit into a real send.
 * The agent is the pet that was typed into — main derives it from the sending
 * window, so it is trustworthy enough to route a message by.
 */
export function setPetOverlaySubmitHandler(fn: ((text: string, agent: string) => void) | null): void {
  submitHandler = fn
}

/** Register the handler that opens the app to that agent's most recent thread (mail icon). */
export function setPetOverlayOpenAppHandler(fn: ((agent: string) => void) | null): void {
  openAppHandler = fn
}

/** Register the handler that persists a scale resized via the overlay's Alt+wheel gesture. */
export function setPetOverlayScaleHandler(fn: ((scale: number, agent: string) => void) | null): void {
  scaleHandler = fn
}

/**
 * Register the handler that turns off the pet entirely (its context menu's
 * "Hide pet"). The overlay has no gateway, so the write has to happen here.
 */
export function setPetOverlayHideHandler(fn: ((agent: string) => void) | null): void {
  hideHandler = fn
}

/** Register the handler that opens the Pet Store for the overlay's "Pet Store…". */
export function setPetOverlayStoreHandler(fn: (() => void) | null): void {
  storeHandler = fn
}

/** Register the handler that opens Settings for the overlay's "Pet settings…". */
export function setPetOverlaySettingsHandler(fn: (() => void) | null): void {
  settingsHandler = fn
}

/**
 * Wire the overlay→renderer control channel once. Returns a disposer. Idempotent
 * — a second call while already wired is a no-op.
 */
export function initPetOverlayBridge(): () => void {
  const api = window.hermesDesktop?.petOverlay

  if (!api || controlUnsub) {
    return () => {}
  }

  controlUnsub = api.onControl(payload => {
    // Which pet spoke. The main process stamps this from the sending window, so
    // one overlay cannot claim another's id and act on its behalf; a message
    // without one predates per-agent binding and belongs to the active agent.
    const agent = payload?.petId || petProfile()

    if (payload?.type === 'pop-in') {
      popInPet(agent)
    } else if (payload?.type === 'ready') {
      // The overlay just mounted — hand it the current frame.
      pushNow(agent)
    } else if (payload?.type === 'submit' && typeof payload.text === 'string') {
      submitHandler?.(payload.text, agent)
    } else if (payload?.type === 'bounds' && payload.bounds) {
      // The user dragged the overlay to a new desktop spot — remember it.
      saveBounds(agent, payload.bounds)
    } else if (payload?.type === 'scale' && typeof payload.scale === 'number') {
      // The user resized the popped-out pet (Alt+wheel) — persist it through
      // the main renderer's gateway; the new scale rides $petInfo back to the
      // overlay on the next push, keeping both surfaces in sync.
      scaleHandler?.(payload.scale, agent)
    } else if (payload?.type === 'hide') {
      // Turning the pet off leaves nothing for the overlay to draw, so close the
      // window first — otherwise an empty always-on-top rectangle lingers until
      // the next restart. Popping in also means "Show pet" brings it back where
      // it can be seen rather than to a window the user has to hunt for.
      popInPet(agent)
      hideHandler?.(agent)
    } else if (payload?.type === 'settings') {
      settingsHandler?.()
    } else if (payload?.type === 'store') {
      storeHandler?.()
    } else if (payload?.type === 'open-app') {
      // Mail icon: surface the app on that agent's most recent thread (main.ts
      // already focused the window before forwarding this) and mark it read.
      clearPetUnread(agent)
      openAppHandler?.(agent)
    }
  })

  return () => {
    controlUnsub?.()
    controlUnsub = null
  }
}

import { atom, computed } from 'nanostores'

import { translateNow } from '@/i18n/runtime'
import { persistBoolean, readKey, storedBoolean } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $busy } from '@/store/session'

import type { PetHold, PetInfo, PetState } from '../../shared/pet'

export { PET_DRAW_SCALE_DEFAULT, petDrawScale, type PetHold, type PetInfo, type PetState } from '../../shared/pet'

/**
 * Petdex mascot state for the desktop floating pet.
 *
 * The spritesheet payload comes from the gateway `pet.info` RPC (shared with
 * the TUI). The animation *state* is derived here from the same activity
 * signals the chat already tracks, mirroring the priority order documented in
 * `agent/pet/state.py` so the Python and TS surfaces never drift.
 */

export interface PetActivity {
  busy?: boolean
  awaitingInput?: boolean
  toolRunning?: boolean
  reasoning?: boolean
  error?: boolean
  justCompleted?: boolean
  celebrate?: boolean
}

/**
 * Resolve the animation state from coarse activity signals.
 *
 * Priority (highest first) mirrors `agent.pet.state.derive_pet_state`:
 * error → celebrate → justCompleted → awaitingInput → toolRunning → reasoning →
 * busy → idle. `awaitingInput` (a clarify/approval blocking on the user) outranks
 * the in-flight signals because the turn is paused on you, not working.
 */
export function derivePetState(activity: PetActivity): PetState {
  if (activity.error) {
    return 'failed'
  }

  if (activity.celebrate) {
    return 'jump'
  }

  if (activity.justCompleted) {
    return 'wave'
  }

  if (activity.awaitingInput) {
    return 'waiting'
  }

  if (activity.toolRunning) {
    return 'run'
  }

  if (activity.reasoning) {
    return 'review'
  }

  if (activity.busy) {
    return 'run'
  }

  return 'idle'
}

/**
 * Pet state, keyed by agent.
 *
 * An agent's key is its Hermes profile key — the same value `petProfile()`
 * already sends with every pet RPC, and the same one sessions are grouped by
 * (`agentIdForSession`). Deliberately NOT the assistant's `identityId`: that is
 * the id allowed to leave the machine, but it is empty whenever the backend
 * never minted one, and every identity-less profile would then collapse onto a
 * single key and share one pet. `normalizeProfileKey` always yields a non-empty
 * key, and the binding it addresses (`display.pet.*`) lives inside the profile,
 * so a rename carries the pet with it rather than orphaning it.
 */
export const $petInfoByAgent = atom<Record<string, PetInfo>>({})
export const $petActivityByAgent = atom<Record<string, PetActivity>>({})

const NO_INFO: PetInfo = { enabled: false }
const NO_ACTIVITY: PetActivity = {}

/**
 * Profile the pet RPCs should resolve against, and the agent key everything
 * else here is stored under. Pets are per-profile — the active pet
 * (`display.pet.*`) and the installed sprites live under each profile's
 * HERMES_HOME — so every pet RPC carries this. The gateway no-ops it for the
 * launch profile (own-profile backends already resolve it) and rebinds for any
 * other profile, which is what makes per-profile pets work in app-global remote
 * mode (one backend serving every profile).
 */
export function petProfile(): string {
  return normalizeProfileKey($activeGatewayProfile.get())
}

export const petInfoFor = (agent: string): PetInfo => $petInfoByAgent.get()[agent] ?? NO_INFO
export const petActivityFor = (agent: string): PetActivity => $petActivityByAgent.get()[agent] ?? NO_ACTIVITY

/**
 * The active agent's pet, as a plain atom.
 *
 * Kept as an atom rather than a `computed` over the keyed record because the
 * pop-out overlay window runs this same module with no gateway: it writes its
 * one pet straight through `setPetInfo`, and a read-only computed would have
 * nowhere to land. Both surfaces therefore share one shape — the main renderer
 * republishes this whenever the active agent or its slice changes, the overlay
 * simply sets it.
 */
export const $petInfo = atom<PetInfo>(NO_INFO)
export const $petActivity = atom<PetActivity>(NO_ACTIVITY)

/** Re-point the active-agent views at `agent`'s slice. Main renderer only. */
export function syncActivePetViews(agent: string = petProfile()): void {
  const info = petInfoFor(agent)
  const activity = petActivityFor(agent)

  if ($petInfo.get() !== info) {
    $petInfo.set(info)
  }

  if ($petActivity.get() !== activity) {
    $petActivity.set(activity)
  }
}

// Switching assistant switches pet. Harmless in the overlay window, where the
// active profile never changes and the view already agrees with the record.
$activeGatewayProfile.subscribe(() => syncActivePetViews())

/** Pet installed + enabled with a loaded spritesheet (ready to show/react). */
export const $petActive = computed($petInfo, info => info.enabled && Boolean(info.spritesheetBase64))

/** The hold on the active pet, when there is one. */
export const $petHold = computed($petInfo, info => (info.enabled && info.held) || null)

// A pet that stops rendering is explained ONCE per hold, on the transition —
// never on the 3 s poll, and never as a dialog. The rows in Settings and the
// Pet Store carry the same reason from the same fact.
let noticedHold: null | string = null

$petHold.subscribe(hold => {
  const key = hold ? `${hold.slug}:${hold.reason}` : null

  if (key === noticedHold) {return}
  noticedHold = key

  if (!hold) {return}
  void import('@/store/notifications').then(({ notify }) => {
    notify({
      kind: 'info',
      message: petHoldMessage(hold),
      title: hold.displayName ?? hold.slug
    })
  }).catch(() => null)
})

export function petHoldMessage(hold: PetHold): string {
  const key = hold.reason === 'entitlement_revoked' ? 'atum.pets.petHoldRevoked'
    : hold.reason === 'entitlement_unavailable_offline' ? 'atum.pets.petHoldOffline'
    : 'atum.pets.petHoldPurchase'

  return translateNow(key)
}

/**
 * A command the assistant issued for its own pet ("go to the left of the
 * screen"), from the `pet.command` gateway event.
 *
 * Deliberately a *request*, not a position: the roam loop picks it up on its
 * next beat and walks there at the pet's own pace along whatever she is
 * standing on. Snapping her to a coordinate would read as furniture being
 * dragged rather than a dog being called.
 *
 * `id` is a monotonic nonce so a repeated identical command still fires.
 */
export interface PetCommand {
  id: number
  action: 'go' | 'wave' | 'jump' | 'sit' | 'lounge'
  place?: string
  agent: string
}

export const $petCommand = atom<null | PetCommand>(null)

let petCommandSeq = 0

export function issuePetCommand(command: Omit<PetCommand, 'id'>): void {
  petCommandSeq += 1
  $petCommand.set({ ...command, id: petCommandSeq })
}

/** Consume the pending command for `agent`, if it is theirs. */
export function takePetCommand(agent: string): null | PetCommand {
  const pending = $petCommand.get()

  if (!pending || pending.agent !== agent) {
    return null
  }

  $petCommand.set(null)

  return pending
}

/**
 * Pet-local "you have a new message" flag, surfaced as the overlay's mail icon.
 * Deliberately not real unread tracking: it flips on when a turn finishes while
 * the app isn't focused, and off when the user opens the app via the mail icon
 * (or returns to the window). No persistence — it's a glance hint, not state.
 */
export const $petUnreadByAgent = atom<Record<string, boolean>>({})
export const $petUnread = computed([$petUnreadByAgent, $activeGatewayProfile], (unread, profile) =>
  Boolean(unread[normalizeProfileKey(profile)])
)
export const petUnreadFor = (agent: string): boolean => Boolean($petUnreadByAgent.get()[agent])

function setUnread(agent: string, value: boolean): void {
  const current = $petUnreadByAgent.get()

  if (Boolean(current[agent]) === value) {
    return
  }

  $petUnreadByAgent.set({ ...current, [agent]: value })
}

export const markPetUnread = (agent: string = petProfile()) => setUnread(agent, true)
export const clearPetUnread = (agent: string = petProfile()) => setUnread(agent, false)

/**
 * Steady activity flags (toolRunning / reasoning) set + cleared by the stream.
 *
 * Defaults to the active agent because that is who the message stream is for.
 * Coarse per-agent state for everyone else (a background agent that is busy or
 * blocked on you) is derived from the session lists in `usePetBridge`, not from
 * here — see the caveat in that file.
 */
export const setPetActivity = (next: Partial<PetActivity>, agent: string = petProfile()) => {
  const current = $petActivityByAgent.get()
  $petActivityByAgent.set({ ...current, [agent]: { ...(current[agent] ?? NO_ACTIVITY), ...next } })
  syncActivePetViews()
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

/** Fire a transient reaction beat (error / celebrate / justCompleted) that
 *  decays back to the steady state after `ms`.
 *
 *  Each beat first clears its siblings so a stale one can't win the priority
 *  race: without this, a completion beat (`celebrate`) would merge on top of a
 *  lingering `error`, and `derivePetState` checks `error` first — so a clean
 *  finish would render the sad/failed pose. */
export const flashPetActivity = (next: Partial<PetActivity>, ms = 1600, agent: string = petProfile()) => {
  setPetActivity({ celebrate: false, error: false, justCompleted: false, ...next }, agent)
  clearTimeout(flashTimer)
  flashTimer = setTimeout(
    () => setPetActivity({ celebrate: false, error: false, justCompleted: false }, agent),
    ms
  )
}

export const setPetInfo = (info: PetInfo, agent: string = petProfile()) => {
  $petInfoByAgent.set({ ...$petInfoByAgent.get(), [agent]: info })
  syncActivePetViews()
}

/**
 * Resolve the live activity state from the dedicated activity atom, falling back
 * to the always-present `$busy` chat signal so the pet reacts out of the box.
 *
 * `awaitingInput` (a clarify/approval blocking on the user) is an explicit flag
 * on `$petActivity` — set by the controller from `$attentionSessionIds` and
 * mirrored to the pop-out overlay through the same atom, so both surfaces agree
 * without the overlay needing the session list.
 */
function deriveLivePetState(activity: PetActivity, busy: boolean): PetState {
  const live = activity.busy ?? busy

  return derivePetState({
    busy: live,
    awaitingInput: activity.awaitingInput,
    // Steady flags only count mid-turn — ignore stale ones once at rest so an
    // interrupted turn can't pin the pet on `run`/`review`.
    toolRunning: live && activity.toolRunning,
    reasoning: live && activity.reasoning,
    error: activity.error,
    justCompleted: activity.justCompleted,
    celebrate: activity.celebrate
  })
}

/**
 * Opt-in: let the floating mascot wander around the window on its own while
 * idle. Pure desktop-client behavior (no agent/config dependency), so it lives
 * in localStorage like the pet's drag position — per-device, not per-profile.
 */
const ROAM_KEY = 'hermes.desktop.pet-roam.v1'
// On by default: a pet that only ever sits still is scenery. The wander is
// calm — mostly resting, exponential dwell times (see roam-behavior.ts) — and it
// pauses the moment the agent is doing anything, so it costs attention only when
// nothing else is happening. Settings → Appearance turns it off.
export const $petRoam = atom<boolean>(storedBoolean(ROAM_KEY, true))

export const setPetRoam = (on: boolean) => {
  $petRoam.set(on)
  persistBoolean(ROAM_KEY, on)
}

/** Apply the account value without claiming it as a machine-local edit. */
export const applyPetRoam = (on: boolean) => $petRoam.set(on)

export const hasStoredPetRoam = () => readKey(ROAM_KEY) !== null

/**
 * The pose the roam loop is currently driving: `run` while walking a surface,
 * `jump` while hopping/falling between surfaces, or `null` at rest. Surfaced
 * through `$petState` (below) so the canvas animates the wander without any prop
 * change or re-render — it already subscribes to `$petState`.
 */
export const $petMotion = atom<PetState | null>(null)

/**
 * The last thing this assistant said, for the pet to speak in its bubble.
 *
 * A glance, not a transcript: the pet is a companion on the desktop, not a
 * second chat window, so this is one short line that decays. Anything longer
 * belongs in the app, which the mail icon already opens.
 */
export const $petReplyByAgent = atom<Record<string, string>>({})

export const petReplyFor = (agent: string): string => $petReplyByAgent.get()[agent] ?? ''

let replyTimer: ReturnType<typeof setTimeout> | undefined

/** How long she holds a reply before going quiet again. */
const REPLY_TTL_MS = 14_000

export function sayPetReply(text: string, agent: string = petProfile()): void {
  const line = text.replace(/\s+/gu, ' ').trim()

  if (!line) {
    return
  }

  $petReplyByAgent.set({ ...$petReplyByAgent.get(), [agent]: line })
  clearTimeout(replyTimer)

  replyTimer = setTimeout(() => {
    const current = $petReplyByAgent.get()
    const { [agent]: _spoken, ...rest } = current
    $petReplyByAgent.set(rest)
  }, REPLY_TTL_MS)
}

/**
 * A short pose she holds — sitting, waving, looking up — on top of the wander.
 *
 * One channel for both sources: the roam loop picks these spontaneously and the
 * `pet` tool drives the same function, so an assistant asking its pet to sit and
 * the pet deciding to sit are the same behaviour. If they were separate paths,
 * the commanded version would read as a puppet.
 *
 * A null pose is still a gesture: it means "stand still" — the wander resumes
 * from wherever she is rather than snapping back to a walk cycle.
 */
export const $petGestureUntil = atom(0)

let gestureTimer: ReturnType<typeof setTimeout> | undefined

export function playPetGesture(pose: null | PetState, ms = 1500): void {
  clearTimeout(gestureTimer)
  $petGestureUntil.set(Date.now() + ms)
  $petMotion.set(pose)

  gestureTimer = setTimeout(() => {
    $petGestureUntil.set(0)

    if ($petMotion.get() === pose) {
      $petMotion.set(null)
    }
  }, ms)
}

/** True while a gesture is playing; the wander holds position through it. */
export const petGestureActive = (): boolean => Date.now() < $petGestureUntil.get()

/**
 * Playback tempo: a multiplier on the sprite's animation loop, redrawn by the
 * wander each beat (`roam-behavior.tempoFor`), so consecutive idles never tick
 * like a metronome and a lounge breathes slower than a sit. 1 is the sheet's
 * own pace; the sprite reads it inside its frame loop, never through a prop.
 */
export const $petTempo = atom(1)

/**
 * Horizontal travel direction while roaming: -1 left, 1 right, 0 not walking.
 * The floating pet maps this to the directional run row + mirror, keeping the
 * wander loop free of sprite-row knowledge.
 */
export const $petRoamDir = atom<-1 | 0 | 1>(0)

/**
 * Whether the agent-driven state is at rest (plain `idle`). The roam loop gates
 * on this — never on `$petState` itself, which would feed back on its own
 * `$petMotion`-driven pose and stall the wander.
 */
export const $petAtRest = computed(
  [$petActivity, $busy],
  (activity, busy): boolean => deriveLivePetState(activity, busy) === 'idle'
)

/**
 * The live pet state. Activity always wins; only when the agent is at rest does
 * a roam pose (walking → `run`, hopping → `jump`) show through, so the wander
 * reads as deliberate movement.
 */
export const $petState = computed([$petActivity, $busy, $petMotion], (activity, busy, motion): PetState => {
  const base = deriveLivePetState(activity, busy)

  return base === 'idle' && motion ? motion : base
})

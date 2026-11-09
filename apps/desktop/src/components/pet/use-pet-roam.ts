import { type RefObject, useEffect } from 'react'

import {
  $petMotion,
  $petRoamDir,
  $petTempo,
  petGestureActive,
  petProfile,
  type PetState,
  playPetGesture,
  takePetCommand
} from '@/store/pet'

import {
  chooseGesture,
  chooseMove,
  chooseRoutine,
  dwellMs,
  PAUSE_DWELL,
  pickStrollTarget,
  type RoamGesture,
  type RoutineStep,
  tempoFor
} from './roam-behavior'
import {
  GROUND_EPS,
  groundTop,
  type Ledge,
  overlapsX,
  overlayLedge,
  resolveLedge,
  snapshotLedges
} from './roam-geometry'

interface Point {
  x: number
  y: number
}

// Foot-sync: advance this many body-widths per animation loop so the walk reads
// as steps, not a glide. Actual px/s is derived from the sprite's loop duration
// and on-screen size (see `walkSpeedPxS`).
const STRIDE_PER_LOOP = 0.8
// Downward acceleration for falls between ledges — fast enough to read as a drop.
const GRAVITY_PX_S2 = 5200
// Time to spring up onto a higher ledge.
const JUMP_DUR_MS = 460
// Tiny settle after a drag release before the pet re-plans (and usually falls),
// so dropping it in mid-air snaps down promptly instead of hanging for a beat.
const DROP_SETTLE_MS = 90
// Arrived at a walk target.
const ARRIVE_EPS = 1.5
// Cap dt so a backgrounded/throttled tab can't teleport the pet on resume.
const MAX_DT_S = 0.05

type Phase = 'pause' | 'walk' | 'fall' | 'jump'

// How long a lounge holds. Long enough to read as settling in, short enough
// that a beat later she can still be somewhere else.
const LOUNGE_MS = 6000
// Between the steps of a routine: a breath, not a loaf, so the sequence reads
// as one intention.
const ROUTINE_BEAT_MS: readonly [number, number] = [300, 800]
// A routine walk shorter than this is not worth taking: skip to the next step.
const ROUTINE_MIN_WALK_PX = 24

const rand = (min: number, max: number): number => min + Math.random() * (max - min)
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3
const signDir = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0)

/**
 * Where the pet lives and what it can stand on.
 *
 * The physics below is the same whether the pet is a div inside the window or a
 * transparent always-on-top window wandering the desktop; only "where am I",
 * "put me here" and "what can I stand on" differ. Injecting those three keeps
 * one wander loop rather than two that drift apart.
 */
export interface RoamSurface {
  /** Walkable ledges right now, in this surface's own coordinate space. */
  ledges: (petW: number, petH: number) => Ledge[]
  /** The pet's current top-left. */
  read: () => Point
  /** Move the pet. Called every frame while it is walking, falling or hopping. */
  write: (point: Point) => void
}

interface PetRoamOptions {
  /** Run the wander loop (roam opt-in + pet active + agent at rest). */
  enabled: boolean
  /** Omit to roam the DOM element in `containerRef` (the in-window pet). */
  surface?: RoamSurface
  containerRef?: RefObject<HTMLDivElement | null>
  /** True while the user is dragging — the loop yields so it never fights a drag. */
  isInteracting: () => boolean
  petW: number
  petH: number
  /** Sprite animation loop duration (ms) — paces the walk to the leg cadence. */
  loopMs: number
  /** A full-screen route overlay (settings/profiles/…) is up: patrol its base. */
  overlayOpen: boolean
  /** Persist the resting position back to React state when the loop settles. */
  commit: (point: Point) => void
}

/**
 * Drive the floating pet's wander as a platformer state machine: it loafs, then
 * walks along surfaces (the window floor, the top of the composer, …), hops up
 * onto higher ledges, and drops off them — instead of drifting through empty
 * space. The walkable surfaces come from `roam-geometry` (re-measured from the
 * live DOM every beat, so the pet tracks the composer growing, the sidebar
 * opening, the window resizing) and the beat-to-beat choices from
 * `roam-behavior`; this hook owns only the physics and the DOM writes.
 *
 * Movement mutates `el.style.left/top` directly each frame — like the drag
 * handler — so a steady wander triggers no React re-renders, and because it
 * re-asserts the DOM position every frame, an incidental parent re-render that
 * snaps `style` back self-heals within a frame. State is only committed (via
 * `commit`) when the pet settles, keeping React's `position` in sync once the
 * loop stops driving it.
 *
 * Two signals publish the wander so the canvas/sprite react without a prop
 * change: `$petMotion` (`run` while walking, `jump` while hopping/falling) flips
 * the shared `$petState`, and `$petRoamDir` (-1/0/1) lets the floating pet pick
 * the directional run row + mirror for the travel direction.
 */
export function usePetRoam({
  enabled,
  surface,
  containerRef,
  isInteracting,
  petW,
  petH,
  loopMs,
  overlayOpen,
  commit
}: PetRoamOptions): void {
  useEffect(() => {
    if (!enabled) {
      $petMotion.set(null)
      $petRoamDir.set(0)

      return
    }

    const el = containerRef?.current ?? null

    if (!surface && !el) {
      return
    }

    // The in-window pet's surface: the live DOM, measured fresh each beat so the
    // wander tracks the composer growing and the window resizing.
    const world: RoamSurface = surface ?? {
      ledges: (w, h) => (overlayOpen ? [overlayLedge(w)] : snapshotLedges(w, h)),
      read: () => {
        const rect = el!.getBoundingClientRect()

        return { x: rect.left, y: rect.top }
      },
      write: point => {
        el!.style.left = `${point.x}px`
        el!.style.top = `${point.y}px`
      }
    }

    // Pace the stride to the sprite: one body-width per animation loop.
    const walkSpeedPxS = (petW * STRIDE_PER_LOOP) / (loopMs / 1000)
    const restY = (ledge: Ledge): number => groundTop(ledge, petH)

    // Seed from where the pet actually is (after a drag, reclamp, or activity
    // pause) rather than from a stale closure.
    const cur: Point = { ...world.read() }

    let phase: Phase = 'pause'
    let pauseUntil = performance.now() + rand(400, 1200)
    let last = performance.now()
    let raf = 0

    let walkTargetX = cur.x
    let curLedge: Ledge | null = null
    let targetLedge: Ledge | null = null
    // When set, the current walk is the approach run before a hop to this ledge.
    let pendingHop: Ledge | null = null
    // Fall / jump integrators.
    let fallVel = 0
    let jumpFromY = 0
    let jumpElapsed = 0
    // A routine in progress: the steps left, and where it started (for `back`).
    let routine: RoutineStep[] = []
    let routineOrigin = 0

    const applyDom = () => world.write({ ...cur })

    // One chokepoint for the wander signals: the pose (drives `$petState`), the
    // travel direction (drives the floating pet's directional row + mirror), and
    // the tempo the sprite plays the pose at — redrawn per beat so nothing ticks
    // like a metronome.
    const signal = (pose: PetState | null, dir: -1 | 0 | 1) => {
      $petMotion.set(pose)
      $petRoamDir.set(dir)
      $petTempo.set(tempoFor(pose))
    }

    // A gesture through one door, so the tempo follows the pose here too.
    const gesture = (pose: RoamGesture, ms?: number) => {
      $petTempo.set(tempoFor(pose))
      playPetGesture(pose, ms)
    }

    const beginPause = (now: number) => {
      phase = 'pause'
      pauseUntil = now + (routine.length ? rand(...ROUTINE_BEAT_MS) : dwellMs(PAUSE_DWELL))
      signal(null, 0)
      commit({ ...cur })
    }

    // Take the next step of the routine in progress; a step that cannot be
    // taken here (a hop with nothing to hop to, a walk of a few pixels) is
    // skipped, so the routine never stalls.
    const runRoutineStep = (now: number, ledges: Ledge[]) => {
      const step = routine.shift()

      if (!step || !curLedge) {
        beginPause(now)

        return
      }

      if (step.kind === 'pose') {
        beginPause(now)
        pauseUntil = now + step.ms + 150
        gesture(step.pose, step.ms)

        return
      }

      if (step.kind === 'hop') {
        const reachable = ledges.filter(ledge => ledge !== curLedge && overlapsX(curLedge!, ledge))

        if (reachable.length === 0) {
          runRoutineStep(now, ledges)

          return
        }

        const next = reachable[Math.floor(Math.random() * reachable.length)]!
        pendingHop = next
        walkTargetX = Math.max(curLedge.left, next.left) + Math.random() * (Math.min(curLedge.right, next.right) - Math.max(curLedge.left, next.left))
        phase = 'walk'
        signal('run', signDir(walkTargetX - cur.x))

        return
      }

      const nearer = cur.x - curLedge.left <= curLedge.right - cur.x ? curLedge.left : curLedge.right
      const farther = nearer === curLedge.left ? curLedge.right : curLedge.left
      const target = step.to === 'back' ? routineOrigin : step.to === 'end' ? nearer : farther
      walkTargetX = Math.min(curLedge.right, Math.max(curLedge.left, target))

      if (Math.abs(walkTargetX - cur.x) < ROUTINE_MIN_WALK_PX) {
        runRoutineStep(now, ledges)

        return
      }

      pendingHop = null
      phase = 'walk'
      signal('run', signDir(walkTargetX - cur.x))
    }

    // Land flush on a ledge, then settle into the next idle beat.
    const settleOn = (ledge: Ledge, now: number) => {
      cur.y = restY(ledge)
      curLedge = ledge
      applyDom()
      beginPause(now)
    }

    const beginVertical = (ledge: Ledge) => {
      targetLedge = ledge

      if (restY(ledge) < cur.y - 1) {
        // Up onto a higher ledge: a quick spring.
        phase = 'jump'
        jumpFromY = cur.y
        jumpElapsed = 0
      } else {
        // Down off a ledge: let gravity take it.
        phase = 'fall'
        fallVel = 0
      }

      signal('jump', 0)
    }

    const planNext = (now: number) => {
      // An open overlay swaps the surface set to just its bottom edge, so the pet
      // patrols along it; closing it restores the normal surfaces (and the pet
      // drops to whatever's below).
      const ledges = world.ledges(petW, petH)
      curLedge = resolveLedge(ledges, cur.x, cur.y, petH)

      // A gesture in flight owns the pet: let it finish rather than walking out
      // from under a sit or a wave.
      if (petGestureActive()) {
        pauseUntil = now + 300

        return
      }

      // An assistant asked its pet to go somewhere (tools/pet_tool.py). Honoured
      // at a beat boundary rather than the instant it arrives, so a command
      // issued mid-stride finishes the stride first: she changes her mind
      // between steps, like a dog, instead of snapping direction mid-walk.
      const command = takePetCommand(petProfile())

      if (command) {
        // An instruction outranks whatever she was in the middle of.
        routine = []

        // `go` and `come` are walks; the rest are poses. Both kinds run through
        // the same machinery the wander uses on its own, so a commanded sit and
        // a spontaneous one are indistinguishable.
        const walkTo = (x: number) => {
          walkTargetX = Math.min(curLedge!.right, Math.max(curLedge!.left, x))
          pendingHop = null
          phase = 'walk'
          signal('run', signDir(walkTargetX - cur.x))
        }

        const span = curLedge.right - curLedge.left

        if (command.action === 'go' && command.place) {
          walkTo(curLedge.left + span * (command.place === 'left' ? 0.08 : command.place === 'right' ? 0.92 : 0.5))

          return
        }

        const pose: PetState =
          command.action === 'wave' ? 'wave' : command.action === 'jump' ? 'jump' : command.action === 'lounge' ? 'lounging' : 'waiting'

        // A lounge is a settle, not a flourish: it holds long enough to read as
        // the dog having decided to stay.
        gesture(pose as RoamGesture, pose === 'lounging' ? LOUNGE_MS : undefined)
        beginPause(now)

        return
      }

      if (Math.abs(cur.y - restY(curLedge)) > GROUND_EPS) {
        // Dragged into the air, or the surface moved out from under it: fall.
        routine = []
        beginVertical(curLedge)

        return
      }

      if (cur.x < curLedge.left - GROUND_EPS || cur.x > curLedge.right + GROUND_EPS) {
        // Standing where the surface gives way — spawned or dropped in front
        // of the navigation dock, whose footprint the floor leaves out — so
        // walk to the nearest spot the ledge allows instead of loafing there.
        // Getting out of the way outranks a routine in progress.
        routine = []
        pendingHop = null
        walkTargetX = Math.min(curLedge.right, Math.max(curLedge.left, cur.x))
        phase = 'walk'
        signal('run', signDir(walkTargetX - cur.x))

        return
      }

      // A routine in progress takes its next step before any new coin is flipped.
      if (routine.length) {
        runRoutineStep(now, ledges)

        return
      }

      const reachable = ledges.filter(ledge => ledge !== curLedge && overlapsX(curLedge!, ledge))
      const move = chooseMove(reachable.length > 0)

      if (move === 'rest') {
        // Stay put and loaf another beat — movement is the exception. Now and
        // then the loaf becomes a routine — a few beats that read as an
        // intention — or a single flourish: sit, glance, the odd wave.
        const chosen = chooseRoutine(Math.random, { canHop: reachable.length > 0 })

        if (chosen) {
          routine = [...chosen.steps]
          routineOrigin = cur.x
          runRoutineStep(now, ledges)

          return
        }

        beginPause(now)

        // The floor is always the first ledge; anything else is furniture she
        // has climbed onto, where a loaf is mostly a lounge.
        const flourish = chooseGesture(Math.random, { onPerch: curLedge !== ledges[0] })

        if (flourish) {
          gesture(flourish, flourish === 'lounging' ? LOUNGE_MS : undefined)
        }

        return
      }

      if (move === 'hop') {
        const next = reachable[Math.floor(Math.random() * reachable.length)]!
        const lo = Math.max(curLedge.left, next.left)
        const hi = Math.min(curLedge.right, next.right)
        pendingHop = next
        walkTargetX = lo + Math.random() * (hi - lo)
      } else {
        pendingHop = null
        walkTargetX = pickStrollTarget(curLedge, cur.x)
      }

      phase = 'walk'
      signal('run', signDir(walkTargetX - cur.x))
    }

    const step = (now: number) => {
      const dt = Math.min(MAX_DT_S, (now - last) / 1000)
      last = now

      // Yield to a drag: track the pet so we resume from the drop point, and
      // reset the idle beat so it doesn't bolt the instant it's let go.
      if (isInteracting()) {
        const live = world.read()
        cur.x = live.x
        cur.y = live.y
        phase = 'pause'
        pendingHop = null
        routine = [] // picked up mid-routine: whatever she meant to do, she has been moved
        // Short settle so the pet falls right after you drop it, not seconds later.
        pauseUntil = now + DROP_SETTLE_MS
        // Picked up: the v4 `carried` row while the drag lasts (a sheet without
        // it draws idle). The settle after the drop clears it.
        signal('carried', 0)
        raf = requestAnimationFrame(step)

        return
      }

      switch (phase) {
        case 'pause': {
          if (now >= pauseUntil) {
            planNext(now)
          }

          break
        }

        case 'walk': {
          const remaining = walkTargetX - cur.x
          const stepDist = walkSpeedPxS * dt

          if (Math.abs(remaining) <= Math.max(ARRIVE_EPS, stepDist)) {
            cur.x = walkTargetX
            applyDom()

            if (pendingHop) {
              const next = pendingHop
              pendingHop = null
              beginVertical(next)
            } else {
              beginPause(now)
            }
          } else {
            cur.x += Math.sign(remaining) * stepDist
            applyDom()
          }

          break
        }

        case 'fall': {
          if (!targetLedge) {
            beginPause(now)

            break
          }

          fallVel += GRAVITY_PX_S2 * dt
          cur.y += fallVel * dt

          if (cur.y >= restY(targetLedge)) {
            settleOn(targetLedge, now)
          } else {
            applyDom()
          }

          break
        }

        case 'jump': {
          if (!targetLedge) {
            beginPause(now)

            break
          }

          jumpElapsed += dt * 1000
          const t = Math.min(1, jumpElapsed / JUMP_DUR_MS)
          cur.y = jumpFromY + (restY(targetLedge) - jumpFromY) * easeOutCubic(t)

          if (t >= 1) {
            settleOn(targetLedge, now)
          } else {
            applyDom()
          }

          break
        }
      }

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(raf)
      signal(null, 0)
      // Hand the final position back to React so its `style` matches the DOM once
      // the loop stops re-asserting it.
      commit({ ...cur })
    }
  }, [enabled, surface, petW, petH, loopMs, overlayOpen, containerRef, isInteracting, commit])
}

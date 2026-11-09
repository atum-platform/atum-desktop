import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DEFAULT_STATE_ROWS, PetSpriteCanvas, roamWalkRow } from '@/components/pet/pet-sprite-canvas'
import { useAppViewOverlayHoldWhenOverlapping } from '@/store/use-app-view-overlay'

import type { PetInfo, PetState } from '../../../shared/pet'
import { type Rng, SLEEP_AFTER_MS } from '../../../shared/pet-engine/behaviour'
import { createEngineState, decide } from '../../../shared/pet-engine/decide'
import { roamSpeed } from '../../../shared/pet-engine/lane'
import { integrate } from '../../../shared/pet-engine/motion'
import { profileFor, stageSize } from '../../../shared/pet-engine/profile'
import type { PetEngineState, PetSignals, PetWorld } from '../../../shared/pet-engine/types'

import {
  type PetDiagnosticLine,
  petLogAgent,
  petStageDiagnostics,
  type PetStartReason,
  petSurfaceCode,
  petXBucket
} from './diagnostics'
import { observePetWindowWorld, petStageRoot, readPetWindowWorld } from './dom-world'
import { petHitBox } from './hit-box'
import { type PetAction, PetMenu } from './menu'
import {
  defaultPetLanding,
  type PetLanding,
  petRestingPlace,
  recallPetRest,
  rememberPetRest,
  samePetLanding,
  settlePet
} from './rest'
import { petSpriteKey } from './sprite-key'
import { holdPetPresentation } from './store'
import { petTopForSurface } from './surface-model'

export interface MatrixPetStageProps {
  info: PetInfo
  work: PetSignals['work']
  still: boolean
  principal?: string
  /** The agent principal, named in diagnostics by its first eight characters only. */
  agent?: string
  rng?: Rng
  actions?: readonly PetAction[]
  onMenuOpen?(open: boolean): void
  onPetClick?(): void
  roaming?: boolean
}

interface Paint {
  pose: PetState
  direction: -1 | 0 | 1
  paused: boolean
  visible: boolean
  mirror: boolean
}

interface StageStart {
  sprite: PetInfo
  width: number
  height: number
  footY: number
}

/** The pet paints above everything in the chat (the floating composer dock, `COMPOSER_DOCK_Z` in
 * composer-dock.tsx, and a side panel beside it) and below the layers that cover the whole chat (a
 * full-frame workspace, z-30). That is why the floor may run in front of the composer: nothing she
 * walks past can hide her. What does paint over her is the world model's job (surface-model.ts). */
export const PET_STAGE_Z = 25

/** Measure only the painted pet, rather than holding native views for the
 * whole chat-column portal. The child refs exist before this layout effect. */
function PetWindowLayer({
  host,
  box,
  children
}: {
  host: Element
  box: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  useAppViewOverlayHoldWhenOverlapping(box)

  return createPortal(children, host)
}

/**
 * One beat timer, motion-only frames, and no scheduled work while the window is hidden or the
 * chat is covered. A window that is merely unfocused stays live: she keeps walking beside
 * whatever the person is doing. The engine lives as long as this pet's sprite and stage size do;
 * wherever it stops (a remount, a room switch, a quit) she comes back to where she last rested.
 */
export function MatrixPetStage({
  info,
  work,
  still,
  principal = 'local',
  agent,
  rng = Math.random,
  actions = [],
  onMenuOpen,
  onPetClick,
  roaming = true
}: MatrixPetStageProps) {
  const anchor = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<Element | null>(null)
  const lane = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const update = useRef<() => void>(() => {})
  const signals = useRef({ work, still, roaming })
  const clickHandler = useRef(onPetClick)
  clickHandler.current = onPetClick
  const started = useRef<StageStart | null>(null)
  const [paint, setPaint] = useState<Paint>({ pose: 'idle', direction: 0, paused: true, visible: false, mirror: false })
  // Every window focus re-reads the pet and gets a new object for the same pet: keep the one
  // already drawn, so neither the engine nor the canvas restarts for a re-read.
  const spriteKey = petSpriteKey(info)
  const [held, setHeld] = useState({ key: spriteKey, info })

  if (held.key !== spriteKey) {
    setHeld({ key: spriteKey, info })
  }

  const sprite = held.key === spriteKey ? held.info : info
  const label = petLogAgent(agent ?? principal.split(':')[0] ?? '')
  const { width, height, zoom } = stageSize({ w: sprite.frameW ?? 192, h: sprite.frameH ?? 208 }, sprite, 'window')
  const footY = (height * (sprite.anchor?.footY ?? sprite.frameH ?? 208)) / (sprite.frameH ?? 208)

  useLayoutEffect(() => {
    if (anchor.current) {
      setHost(petStageRoot(anchor.current))
    }
  }, [])

  useEffect(() => {
    signals.current = { work, still, roaming }
    update.current()
  }, [work, still, roaming])

  useEffect(() => {
    const laneEl = lane.current
    const bodyEl = body.current

    if (!laneEl || !bodyEl) {
      return
    }

    const previous = started.current

    const startReason: PetStartReason = previous
      ? previous.sprite !== sprite
        ? 'sprite'
        : previous.width !== width || previous.height !== height || previous.footY !== footY
          ? 'size'
          : 'remount'
      : petStageDiagnostics.seen(principal)
        ? 'remount'
        : 'mount'

    started.current = { sprite, width, height, footY }

    let state: PetEngineState | undefined
    let world: PetWorld | undefined
    let saved: PetLanding | undefined
    let beatTimer: ReturnType<typeof setTimeout> | undefined
    let raf = 0
    let lastFrame = 0
    let disposed = false

    let drag:
      | { pointerId: number; dx: number; dy: number; x: number; top: number; origin: { x: number; top: number } }
      | undefined

    const presentation = holdPetPresentation(principal, performance.now())
    const profile = profileFor(sprite.locomotion)

    const rhythm = {
      restChance: profile.restChance,
      hopChance: profile.hopChance,
      routineChance: profile.routineChance,
      gestureChance: profile.gestureChance
    }

    if (profile.locomotion === 'walk') {
      profile.speedPxPerSecond = roamSpeed(width, sprite.loopMs ?? 1100)
    }

    const place = () => {
      if (state) {
        bodyEl.style.transform = `translateX(${Math.round(state.x)}px) translateY(${petTopForSurface(state.y, footY)}px)`
      }
    }

    const covered = () => Boolean(laneEl.closest('[inert]'))
    // Hidden (minimised, another Space, fully covered by other windows) or behind a covering
    // surface. Losing focus is neither: a visible, unfocused window keeps her moving.
    const inactive = () => window.document.hidden || covered()

    const clear = () => {
      cancelAnimationFrame(raf)
      raf = 0
      clearTimeout(beatTimer)
      beatTimer = undefined
    }

    // Where she rests is hers, per agent: kept on every settle, not only on a drop, so any
    // restart resumes there. A docked (roaming off) pet's spot is derived, never kept.
    const remember = (landing: PetLanding) => {
      if (!signals.current.roaming || samePetLanding(saved, landing)) {
        return
      }

      saved = landing
      rememberPetRest(principal, landing)
    }

    const settled = () => {
      if (state && state.visible && !state.motion && !drag) {
        remember({ ...(state.perchId ? { perchId: state.perchId } : {}), x: state.x, y: state.y })
      }
    }

    const doing = (): PetDiagnosticLine | undefined =>
      state && {
        event: 'state',
        agent: label,
        work: signals.current.work,
        pose: state.intent.pose,
        surface: petSurfaceCode(state),
        x: petXBucket(state.x, world, width),
        window: window.document.hidden
          ? 'hidden'
          : covered()
            ? 'covered'
            : window.document.hasFocus()
              ? 'focused'
              : 'unfocused'
      }

    const report = () => {
      const line = doing()

      if (line) {
        petStageDiagnostics.state(principal, line)
      }
    }

    const draw = () => {
      if (!state) {
        return
      }

      place()
      const rect = bodyEl.getBoundingClientRect()
      const root = petStageRoot(laneEl)?.getBoundingClientRect()
      const local = presentation.store.get()
      presentation.store.set({
        ...local,
        pose: state.intent.pose,
        position: { x: rect.left - (root?.left ?? 0), y: rect.top - (root?.top ?? 0) }
      })
      bodyEl.dataset.petSurface = state.perchId ?? 'floor'
      bodyEl.style.opacity = state.visible ? '1' : '0'

      // A walk draws the travel row; a leap keeps its own jump row.
      const direction =
        state.motion && state.motion.kind !== 'leap' ? (state.motion.toX > state.motion.fromX ? 1 : -1) : 0

      const paused =
        inactive() ||
        signals.current.still ||
        !state.visible ||
        (signals.current.work === 'idle' && (state.intent.pose === 'idle' || state.wakeAt === null))

      const next: Paint = {
        pose: state.intent.pose,
        direction,
        paused,
        visible: state.visible,
        mirror: state.intent.mirror
      }

      setPaint(previous =>
        Object.keys(next).every(key => previous[key as keyof Paint] === next[key as keyof Paint]) ? previous : next
      )
    }

    function frame(now: number) {
      raf = 0

      if (disposed || drag || inactive() || !state?.motion) {
        return
      }

      if (signals.current.work === 'idle' && now - presentation.store.get().lastActiveAt >= SLEEP_AFTER_MS) {
        beat()

        return
      }

      const dt = Math.max(0, Math.min(64, now - lastFrame))
      lastFrame = now
      const next = integrate(state, state.intent, dt)
      state = { ...state, ...next, now: state.now + dt }
      place()

      if (next.arrived) {
        beat()
      } else {
        raf = requestAnimationFrame(frame)
      }
    }

    function beat() {
      if (disposed || drag) {
        return
      }

      clear()
      const now = performance.now()

      if (inactive()) {
        if (state && world) {
          state = decide(
            { ...state, now },
            world,
            {
              work: signals.current.work,
              idleMs: 0,
              away: true,
              reducedMotion:
                signals.current.still ||
                Boolean(presentation.store.get().pickerOpen || presentation.store.get().menuOpen)
            },
            presentation.store.get().commands,
            rng
          ).state
          settled()
          // A freeze is news too: it says why she stopped (window=hidden or covered).
          report()
        }

        draw()

        return
      }

      Object.assign(
        profile,
        signals.current.roaming ? rhythm : { restChance: 1, hopChance: 0, routineChance: 0, gestureChance: 0 }
      )
      const lift = profile.locomotion === 'walk' ? 0 : profile.hopHeight
      world = readPetWindowWorld(
        laneEl!,
        bodyEl!,
        { width, height: height + Math.max(lift, profile.hopHeight), footY },
        signals.current.roaming ? undefined : (anchor.current ?? undefined)
      )

      const created = !state
      let restored: PetLanding | undefined

      if (!state) {
        restored = recallPetRest(principal)
        const landing = restored ? settlePet(world, width, restored) : defaultPetLanding(world, width)
        // Where she starts needs no keeping: a remount before she moves starts there again.
        saved = landing

        state = {
          ...createEngineState({
            now,
            x: landing.x,
            y: landing.y,
            profile,
            stateRows: sprite.stateRows ?? DEFAULT_STATE_ROWS
          }),
          ...(landing.perchId ? { perchId: landing.perchId } : {})
        }
      } else if (!state.motion) {
        const landing = settlePet(world, width, { ...(state.perchId ? { perchId: state.perchId } : {}), x: state.x, y: state.y })

        if (landing.x !== state.x || landing.y !== state.y || landing.perchId !== state.perchId) {
          state = {
            ...state,
            x: landing.x,
            y: landing.y,
            perchId: landing.perchId,
            hop: undefined,
            routine: undefined,
            intent: { pose: 'idle', mirror: state.facing > 0 }
          }
        }
      }

      const local = presentation.store.get()

      if (signals.current.work !== 'idle') {
        presentation.store.set({ ...local, lastActiveAt: now })
      }

      const idleMs = Math.max(0, now - presentation.store.get().lastActiveAt)
      state = decide(
        { ...state, now },
        world,
        {
          work: signals.current.work,
          idleMs,
          away: false,
          reducedMotion:
            signals.current.still ||
            Boolean(presentation.store.get().pickerOpen || presentation.store.get().menuOpen)
        },
        local.commands,
        rng
      ).state
      draw()
      settled()

      const line = created ? doing() : undefined

      if (line) {
        petStageDiagnostics.start(principal, {
          ...line,
          event: 'start',
          reason: startReason,
          restore: restored ? 'saved' : 'default'
        })
      } else {
        report()
      }

      if (state.motion) {
        lastFrame = now
        raf = requestAnimationFrame(frame)
      } else if (state.wakeAt !== null) {
        // Reaching the sleep threshold is itself a beat; no polling timer is needed.
        const delay = Math.min(state.wakeAt - now, Math.max(1, SLEEP_AFTER_MS - idleMs))
        beatTimer = setTimeout(beat, Math.max(1, delay))
      }
    }

    const look = () => {
      if (disposed || drag || inactive()) {
        return
      }

      beat()
    }

    const active = () => {
      if (inactive()) {
        return
      }

      const current = presentation.store.get()
      presentation.store.set({ ...current, lastActiveAt: performance.now() })

      // A new interaction wakes an asleep pet but does not redraw a live beat.
      if (state?.wakeAt === null && signals.current.work === 'idle' && !signals.current.still) {
        beat()
      }
    }

    // Coming back to the window is the person being here again: it can wake her, never restart her.
    const focus = () => active()

    const visibility = () => {
      if (!window.document.hidden) {
        active()
      }

      beat()
    }

    /** The window-stage companion is a real desktop pet: pick her up anywhere on the
     * painted sprite, move her without React render latency, then settle her onto the
     * nearest safe floor or ledge. */
    const pointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        !event.target.closest('[data-pet-hit-box]') ||
        !state
      ) {
        return
      }

      const stageBox = laneEl.getBoundingClientRect()
      const petBox = bodyEl.getBoundingClientRect()

      clear()
      drag = {
        pointerId: event.pointerId,
        dx: event.clientX - petBox.left,
        dy: event.clientY - petBox.top,
        x: petBox.left - stageBox.left,
        top: petBox.top - stageBox.top,
        origin: { x: petBox.left - stageBox.left, top: petBox.top - stageBox.top }
      }
      state = {
        ...state,
        visible: true,
        motion: undefined,
        hop: undefined,
        routine: undefined,
        perchId: undefined,
        wakeAt: null,
        intent: {
          pose: state.stateRows.includes('carried') ? 'carried' : 'idle',
          mirror: state.intent.mirror
        }
      }
      bodyEl.dataset.petDragging = 'true'
      bodyEl.style.cursor = 'grabbing'
      bodyEl.setPointerCapture?.(event.pointerId)
      draw()
      event.preventDefault()
    }

    const pointerMove = (event: PointerEvent) => {
      if (!drag || !state || event.pointerId !== drag.pointerId) {
        return
      }

      const stageBox = laneEl.getBoundingClientRect()
      const x = Math.max(0, Math.min(stageBox.width - width, event.clientX - stageBox.left - drag.dx))
      const top = Math.max(0, Math.min(stageBox.height - height, event.clientY - stageBox.top - drag.dy))

      const previousX = drag.x
      drag.x = x
      drag.top = top
      state = {
        ...state,
        now: performance.now(),
        x,
        y: top + footY,
        facing: x === previousX ? state.facing : x > previousX ? 1 : -1,
        intent: { ...state.intent, mirror: x === previousX ? state.intent.mirror : x > previousX }
      }
      draw()
      event.preventDefault()
    }

    const pointerUp = (event: PointerEvent) => {
      if (!drag || !state || event.pointerId !== drag.pointerId) {
        return
      }

      const released = drag
      const clicked = Math.hypot(released.x - released.origin.x, released.top - released.origin.top) < 4
      drag = undefined
      bodyEl.releasePointerCapture?.(event.pointerId)
      bodyEl.style.cursor = 'grab'
      delete bodyEl.dataset.petDragging

      world = readPetWindowWorld(
        laneEl,
        bodyEl,
        {
          width,
          height: height + Math.max(profile.locomotion === 'walk' ? 0 : profile.hopHeight, profile.hopHeight),
          footY
        },
        signals.current.roaming ? undefined : (anchor.current ?? undefined)
      )

      const landing = settlePet(world, width, { x: released.x, y: released.top + footY })
      // Nowhere to stand (the chat under a full-frame panel): she goes out of sight, never onto glass.
      const standable = world.free.length > 0 || world.perches.length > 0

      const now = performance.now()
      state = {
        ...state,
        now,
        visible: standable,
        x: landing.x,
        y: landing.y,
        perchId: landing.perchId,
        motion: undefined,
        routine: undefined,
        wakeAt: now + 1_000,
        intent: { pose: 'idle', mirror: state.facing > 0 }
      }
      draw()

      if (standable) {
        remember(landing)
      }

      beatTimer = setTimeout(beat, 1_000)
      event.preventDefault()

      if (clicked) {
        clickHandler.current?.()
      }
    }

    let wasCovered = covered()

    const cover =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            const next = covered()

            if (next !== wasCovered) {
              wasCovered = next

              if (!next) {
                active()
              }

              beat()
            }
          })

    const unobserve = observePetWindowWorld(laneEl, look)
    const root = petStageRoot(laneEl)
    bodyEl.addEventListener('pointerdown', pointerDown)
    bodyEl.addEventListener('pointermove', pointerMove)
    bodyEl.addEventListener('pointerup', pointerUp)
    bodyEl.addEventListener('pointercancel', pointerUp)
    root?.addEventListener('pointerdown', active, { capture: true, passive: true })
    root?.addEventListener('keydown', active, { capture: true })
    window.addEventListener('focus', focus)
    window.document.addEventListener('visibilitychange', visibility)
    cover?.observe(window.document.documentElement, { attributeFilter: ['inert'], attributes: true, subtree: true })

    const unlisten = presentation.store.listen((next, previous) => {
      if (
        !previous ||
        next.commands !== previous.commands ||
        next.pickerOpen !== previous.pickerOpen ||
        next.menuOpen !== previous.menuOpen ||
        next.glassOpen !== previous.glassOpen
      ) {
        beat()
      }
    })

    update.current = () => {
      active()
      beat()
    }

    beat()

    return () => {
      disposed = true

      // Wherever this engine stops, the next one starts from here (a walk's current point).
      if (state?.visible && !drag) {
        remember(petRestingPlace(state))
      }

      update.current = () => {}
      clear()
      unobserve()
      unlisten()
      cover?.disconnect()
      presentation.release()
      bodyEl.removeEventListener('pointerdown', pointerDown)
      bodyEl.removeEventListener('pointermove', pointerMove)
      bodyEl.removeEventListener('pointerup', pointerUp)
      bodyEl.removeEventListener('pointercancel', pointerUp)
      root?.removeEventListener('pointerdown', active, { capture: true })
      root?.removeEventListener('keydown', active, { capture: true })
      window.removeEventListener('focus', focus)
      window.document.removeEventListener('visibilitychange', visibility)
    }
  }, [sprite, principal, label, rng, width, height, footY, host])

  const gait = roamWalkRow(paint.direction, sprite.stateRows)
  const hit = petHitBox(sprite, paint.pose, zoom, paint.direction ? gait.mirror : paint.mirror)

  const stage = (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-matrix-pet-stroll
      data-pet-stage-window
      ref={lane}
      style={{ zIndex: PET_STAGE_Z }}
    >
      <div
        className="absolute top-0 left-0"
        data-pet-pose={paint.pose}
        data-walking={paint.direction ? 'true' : undefined}
        ref={body}
        style={{ width: width, height: height, opacity: 0, visibility: paint.visible ? undefined : 'hidden' }}
      >
        <PetMenu actions={actions} onOpenChange={onMenuOpen}>
          <div
            // The pet stays grabbable where it walks over the title strip.
            className="pointer-events-auto absolute cursor-grab touch-none select-none [-webkit-app-region:no-drag]"
            data-pet-hit-box
            style={hit}
          />
        </PetMenu>
        <div style={(paint.direction ? gait.mirror : paint.mirror) ? { transform: 'scaleX(-1)' } : undefined}>
          <PetSpriteCanvas
            info={sprite}
            paused={paint.paused}
            rowOverride={paint.direction ? gait.row : undefined}
            stateOverride={paint.pose}
            zoom={zoom}
          />
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0" data-pet-dock ref={anchor} />
      {host && (
        <PetWindowLayer box={body} host={host}>
          {stage}
        </PetWindowLayer>
      )}
    </>
  )
}

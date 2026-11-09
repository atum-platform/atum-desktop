import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SpriteCanvas from '@/components/pet/pet-sprite-canvas'

import type { MatrixPetDiagnostic } from '../../shared/matrix-pet-diagnostic'
import type { PetInfo } from '../../shared/pet'
import type { Rng } from '../../shared/pet-engine/behaviour'
import { seeded } from '../../shared/pet-engine/fixtures/worlds'

import { COMPOSER_DOCK_Z } from './composer-dock'
import { ROAM_CONTROL_GAP_PX, roamSize } from './pet-roam'
import { MatrixPetStage, PET_STAGE_Z } from './pet/stage'
import { holdPetPresentation } from './pet/store'

vi.mock('@/components/pet/pet-sprite-canvas', async importOriginal => ({
  ...(await importOriginal<typeof SpriteCanvas>()),
  PetSpriteCanvas: ({ paused, stateOverride }: SpriteCanvas.PetSpriteProps) => (
    <span data-paused={String(paused)} data-pose={stateOverride} data-testid="sprite" />
  )
}))

const info: PetInfo = { enabled: true, slug: 'gigi', frameW: 192, frameH: 208, scale: 1, size: 1, loopMs: 1100 }
const pet = roamSize({ w: 192, h: 208 }, 1)

// The portal fills the 600×500 chat column. The old companion strip remains an
// explicit-off dock above the composer; it is not the roaming floor.
const STAGE = { left: 100, right: 700, top: 0, bottom: 500 }
const DOCK = { left: 140, right: 660, top: 348, bottom: 380 }
const COMPOSER = { left: 250, right: 650, top: 388, bottom: 500 }

const box = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect

// Both in lane pixels: a message action above the rim, and the companion button. The action
// starts outside the composer's rim so the first stroll is unconstrained.
let action = { left: 560, right: 592 }
let actionTop = 300
const companion = { left: 568, right: 600 }
let measured = 0

function Chat({
  roaming = true,
  sprite = info,
  principal,
  agent,
  rng
}: {
  roaming?: boolean
  sprite?: PetInfo
  principal?: string
  agent?: string
  rng?: Rng
}) {
  return (
    <div data-atum-chat>
      <div data-slot="aui_thread-viewport">
        <button data-control="action" data-pet-avoid type="button">
          Copy
        </button>
      </div>
      <div className="relative h-8" data-lane-parent>
        <MatrixPetStage
          agent={agent}
          info={sprite}
          principal={principal}
          rng={rng}
          roaming={roaming}
          still={false}
          work="idle"
        />
      </div>
      <button data-control="companion" data-pet-paw type="button">
        Companion
      </button>
      <section data-pet-perch="composer">
        <textarea data-control="composer" />
      </section>
    </div>
  )
}

function petX(): number {
  const body = window.document.querySelector<HTMLElement>('[data-matrix-pet-stroll] > div')!
  const match = /translateX\((-?\d+)px\)/.exec(body.style.transform)

  return match ? Number(match[1]) : NaN
}

function petY(): number {
  const body = window.document.querySelector<HTMLElement>('[data-matrix-pet-stroll] > div')!
  const match = /translateY\((-?[\d.]+)px\)/.exec(body.style.transform)

  return match ? Number(match[1]) : NaN
}

function walking(): boolean {
  return window.document.querySelector('[data-matrix-pet-stroll] > div')!.getAttribute('data-walking') === 'true'
}

// Runs until `done` holds, in animation-frame-sized steps, for at most `limitMs`.
function until(done: () => boolean, limitMs = 120_000) {
  for (let elapsed = 0; elapsed < limitMs && !done(); elapsed += 16) {
    advance(16)
  }

  expect(done()).toBe(true)
}

function scroll() {
  act(() => void window.document.querySelector('[data-slot="aui_thread-viewport"]')!.dispatchEvent(new Event('scroll')))
}

function clear(x: number, control: { left: number; right: number }): boolean {
  // Whole-pixel placement may land a pixel inside the gap, never on the control.
  return x + pet.width <= control.left - ROAM_CONTROL_GAP_PX + 1 || x >= control.right + ROAM_CONTROL_GAP_PX - 1
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms))
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance']
  })
  action = { left: 560, right: 592 }
  actionTop = 300
  measured = 0
  // The window's own storage, minus jsdom's zero-delay `storage` event timer, which would
  // otherwise count as work the stage scheduled.
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, String(value)),
    removeItem: (key: string) => void kept.delete(key),
    clear: () => kept.clear(),
    key: (index: number) => [...kept.keys()][index] ?? null,
    get length() {
      return kept.size
    }
  })
  // A seeded generator (mulberry32): varied rolls, the same every run.
  let seed = 7
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  })
  // jsdom's document has focus only once an element took it; a desktop window has it.
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-matrix-pet-stroll')) {
      return box(STAGE.left, STAGE.right, STAGE.top, STAGE.bottom)
    }

    if (this.hasAttribute('data-pet-dock')) {
      return box(DOCK.left, DOCK.right, DOCK.top, DOCK.bottom)
    }

    if (this.hasAttribute('data-pet-pose')) {
      const x = Number(/translateX\((-?\d+)px\)/.exec(this.style.transform)?.[1] ?? 0)
      const y = Number(/translateY\((-?\d+)px\)/.exec(this.style.transform)?.[1] ?? 0)

      return box(STAGE.left + x, STAGE.left + x + pet.width, STAGE.top + y, STAGE.top + y + pet.height)
    }

    if (this.hasAttribute('data-pet-perch')) {
      return box(COMPOSER.left, COMPOSER.right, COMPOSER.top, COMPOSER.bottom)
    }

    if (this.getAttribute('data-control') === 'composer') {
      return box(COMPOSER.left + 24, COMPOSER.right - 24, COMPOSER.top + 16, COMPOSER.bottom - 30)
    }

    const control = this.getAttribute('data-control')

    if (control) {
      measured += 1
      const { left, right } = control === 'action' ? action : companion
      // The action stands in the band above the composer rim, where she walks. The
      // companion sits in the higher explicit-off dock and does not constrain roaming.
      const [top, bottom] = control === 'action' ? [actionTop, actionTop + 22] : [DOCK.top, DOCK.bottom]

      return box(STAGE.left + left, STAGE.left + right, top, bottom)
    }

    return box(0, 0, 0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('the strolling companion', () => {
  it('walks the floor in front of the composer, and leaps between it and the rim', () => {
    render(<Chat />)
    const rim = COMPOSER.top - STAGE.top
    const ground = STAGE.bottom - STAGE.top
    const cardLeft = COMPOSER.left - STAGE.left
    const cardRight = COMPOSER.right - STAGE.left
    const floorXs: number[] = []
    const transitions: Array<{ from: string; jumped: boolean; to: string }> = []
    let lastSurface = 'floor'
    let jumped = false

    expect(petY() + pet.height).toBe(ground)
    const stage = window.document.querySelector<HTMLElement>('[data-matrix-pet-stroll]')!
    // Her layer is above the glass: on the ground in front of it, the glass never hides her.
    expect(Number(stage.style.zIndex)).toBe(PET_STAGE_Z)
    expect(PET_STAGE_Z).toBeGreaterThan(COMPOSER_DOCK_Z)
    expect(stage.classList.contains('pointer-events-none')).toBe(true)
    expect(window.document.querySelector('[data-pet-hit-box]')!.classList.contains('pointer-events-auto')).toBe(true)

    for (let elapsed = 0; elapsed < 600_000; elapsed += 16) {
      if (elapsed % 60_000 === 0) {
        fireEvent.pointerDown(window.document.querySelector('[data-atum-chat]')!)
      }

      advance(16)
      const body = window.document.querySelector<HTMLElement>('[data-pet-surface]')!
      const x = petX()
      const pose = body.getAttribute('data-pet-pose')!
      const surface = body.getAttribute('data-pet-surface')!

      jumped ||= pose === 'jump'

      if (surface !== lastSurface) {
        transitions.push({ from: lastSurface, jumped, to: surface })
        lastSurface = surface
        jumped = false
      }

      // A leap passes beside the glass in mid-air; where she stands is what must stay clear.
      if (surface === 'floor' && pose !== 'jump') {
        floorXs.push(x)
      }

      if (pose !== 'jump') {
        expect(petY() + pet.height).toBe(surface === 'floor' ? ground : rim)
      }

      const climbed = transitions.some(
        value => value.from === 'floor' && value.to.startsWith('composer:') && value.jumped
      )

      const descended = transitions.some(
        value => value.from.startsWith('composer:') && value.to === 'floor' && value.jumped
      )

      if (floorXs.some(x => x + pet.width > cardLeft && x < cardRight) && climbed && descended) {
        break
      }
    }

    // The ground in front of the card is hers (0.20.27 kept every floor step beside it).
    expect(floorXs.some(x => x + pet.width > cardLeft && x < cardRight)).toBe(true)
    expect(transitions).toContainEqual(expect.objectContaining({ from: 'floor', jumped: true, to: 'composer:0:0' }))
    expect(transitions).toContainEqual(expect.objectContaining({ from: 'composer:0:0', jumped: true, to: 'floor' }))
  })

  it('never rests in mid-air while strolling and gesturing on either surface', () => {
    render(<Chat />)
    const rim = COMPOSER.top - STAGE.top
    const ground = STAGE.bottom - STAGE.top
    const gestures = new Set(['wave', 'jump', 'lounging', 'review'])
    const poses = new Set<string>()
    const surfaces = new Set<string>()
    let walks = 0
    let wasWalking = false
    let gestured = false

    const assertOnSurface = () => {
      const body = window.document.querySelector<HTMLElement>('[data-pet-surface]')!
      const pose = body.getAttribute('data-pet-pose')!
      const surface = body.getAttribute('data-pet-surface')!
      surfaces.add(surface)

      if (pose !== 'jump') {
        expect(petY() + pet.height).toBe(surface === 'floor' ? ground : rim)
      }
    }

    assertOnSurface()

    // The engine moves only on animation frames and re-decides only on beats, so a window
    // that has shown several strolls, rests and a gesture proves the same ground invariant
    // the old ten-minute sweep did — without 56k React flushes going over 15s under CI load.
    let elapsed = 0

    for (; elapsed < 600_000 && (walks < 3 || !gestured || surfaces.size < 2); elapsed += 16) {
      if (elapsed % 60_000 === 0) {
        fireEvent.pointerDown(window.document.querySelector('[data-atum-chat]')!)
      }

      advance(16)
      assertOnSurface()
      const pose = window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')!
      poses.add(pose)
      gestured ||= gestures.has(pose)

      if (walking() && !wasWalking) {
        walks += 1
      }

      wasWalking = walking()
    }

    // The window really did include the activities the invariant must hold through.
    expect(walks).toBeGreaterThanOrEqual(3)
    expect(gestured).toBe(true)
    expect(poses.has('run')).toBe(true)
    expect(poses.has('idle')).toBe(true)
    expect([...surfaces]).toContain('floor')
    expect([...surfaces].some(surface => surface.startsWith('composer:'))).toBe(true)
  })

  it("aligns Gigi's opaque foot anchor exactly instead of aligning transparent frame padding", () => {
    const anchored = { ...info, anchor: { centerX: 95.5, footY: 195 } }
    const footY = (pet.height * anchored.anchor.footY) / anchored.frameH!
    const rim = COMPOSER.top - STAGE.top
    const ground = STAGE.bottom - STAGE.top

    render(<Chat sprite={anchored} />)

    for (let elapsed = 0; elapsed < 90_000; elapsed += 50) {
      advance(50)
      const body = window.document.querySelector<HTMLElement>('[data-pet-surface]')!

      if (body.getAttribute('data-pet-pose') !== 'jump') {
        expect(petY() + footY).toBe(body.getAttribute('data-pet-surface') === 'floor' ? ground : rim)
      }
    }
  })

  it('cancels an unsafe walk and re-homes immediately when controls move during it', () => {
    render(<Chat />)
    action = { left: 0, right: 32 }
    actionTop = 0
    const surface = () => window.document.querySelector('[data-pet-surface]')!.getAttribute('data-pet-surface')!

    // The ground in front of the card is hers too, so the rim is one of two places she strolls:
    // nudge her the way the walk test does, once a minute, until she strolls on the rim.
    for (let elapsed = 0; elapsed < 1_200_000 && !(walking() && surface().startsWith('composer:')); elapsed += 16) {
      if (elapsed % 60_000 === 0) {
        fireEvent.pointerDown(window.document.querySelector('[data-atum-chat]')!)
      }

      advance(16)
    }

    expect(walking() && surface().startsWith('composer:')).toBe(true)
    // Mid-stroll on the rim, deliberately marked furniture moves under her. It leaves
    // a real free span, so re-homing is visible rather than hiding the pet.
    // (The rim runs from 150 to 550 in lane pixels.)
    action = { left: Math.max(150, petX() - 30), right: Math.min(550, petX() + 64) }
    actionTop = 300
    scroll()
    advance(400)
    expect(clear(petX(), action)).toBe(true)
  })

  it('uses the companion strip only when roaming is explicitly off', () => {
    const view = render(<Chat />)
    expect(petY() + pet.height).toBe(STAGE.bottom - STAGE.top)
    view.rerender(<Chat roaming={false} />)
    advance(400)
    expect(petY() + pet.height).toBe(DOCK.bottom - STAGE.top)
    expect(clear(petX(), companion)).toBe(true)
    const parked = window.document.querySelector<HTMLElement>('[data-pet-pose]')!.style.transform
    advance(60_000)
    expect(window.document.querySelector<HTMLElement>('[data-pet-pose]')!.style.transform).toBe(parked)
  })

  it('can be picked up, dragged across the window, and dropped on the nearest safe surface', () => {
    render(<Chat sprite={{ ...info, stateRows: ['idle', 'carried'] }} />)
    const hit = window.document.querySelector<HTMLElement>('[data-pet-hit-box]')!
    const startX = petX()
    const startY = petY()

    fireEvent.pointerDown(hit, {
      button: 0,
      clientX: STAGE.left + startX + 20,
      clientY: STAGE.top + startY + 20,
      pointerId: 7
    })
    expect(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')).toBe('carried')
    expect(window.document.querySelector('[data-pet-dragging]')).not.toBeNull()

    fireEvent.pointerMove(hit, {
      clientX: STAGE.left + 40 + 20,
      clientY: STAGE.top + 100 + 20,
      pointerId: 7
    })
    expect(petX()).toBe(40)
    expect(petY()).toBe(100)

    // Dropped over the floor beside the composer: she lands on it, not in mid-air.
    fireEvent.pointerUp(hit, { clientX: STAGE.left + 60, clientY: STAGE.top + 120, pointerId: 7 })
    expect(window.document.querySelector('[data-pet-dragging]')).toBeNull()
    expect(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')).toBe('idle')
    expect(petY() + pet.height).toBe(STAGE.bottom - STAGE.top)
  })

  it('keeps walking in a visible, unfocused window, and schedules nothing while hidden or covered', async () => {
    const view = render(<Chat />)
    advance(30_000)
    expect(measured).toBeGreaterThan(0)

    // The person is in another app with Atum still in view: she carries on with her day.
    vi.mocked(window.document.hasFocus).mockReturnValue(false)
    act(() => void window.dispatchEvent(new Event('blur')))
    const beforeBlur = measured
    const places = new Set<number>()

    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      advance(100)
      places.add(petX())
    }

    expect(measured).toBeGreaterThan(beforeBlur)
    expect(places.size).toBeGreaterThan(1)

    // Hidden (minimised, another Space, fully covered by other windows): nothing at all.
    const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true)
    act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
    const beforeHide = measured
    const frozenAt = petX()
    advance(120_000)
    expect(measured).toBe(beforeHide)
    expect(petX()).toBe(frozenAt)
    expect(vi.getTimerCount()).toBe(0)

    // Messages scrolling in the background schedule no second look either.
    scroll()
    expect(vi.getTimerCount()).toBe(0)
    advance(1_000)
    expect(measured).toBe(beforeHide)

    hidden.mockReturnValue(false)
    act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
    expect(measured).toBeGreaterThan(beforeHide)
    // Shown again, she is where she stopped.
    expect(petX()).toBe(frozenAt)

    const chat = view.container.querySelector('[data-atum-chat]')!
    await act(async () => chat.setAttribute('inert', ''))
    const beforeCover = measured
    advance(120_000)
    expect(measured).toBe(beforeCover)
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => chat.removeAttribute('inert'))
    expect(measured).toBeGreaterThan(beforeCover)
    advance(30_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('opened in a hidden window, takes her first look once it is shown; focus is not needed', () => {
    vi.mocked(window.document.hasFocus).mockReturnValue(false)
    const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true)
    render(<Chat />)
    advance(30_000)
    expect(measured).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    hidden.mockReturnValue(false)
    act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
    expect(measured).toBeGreaterThan(0)
    advance(30_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('opened in a visible window without focus, starts at once', () => {
    vi.mocked(window.document.hasFocus).mockReturnValue(false)
    render(<Chat />)
    expect(measured).toBeGreaterThan(0)
    advance(30_000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('keeps walking from where she is when the same pet is read again, as every window focus does', () => {
    const view = render(<Chat />)
    until(walking)
    advance(320)
    const before = { x: petX(), y: petY() }

    // A focus re-read: a new object for the same pet arrives mid-walk, then the focus itself.
    view.rerender(<Chat sprite={{ ...info }} />)
    act(() => void window.dispatchEvent(new Event('focus')))
    advance(16)

    expect(Math.abs(petX() - before.x)).toBeLessThanOrEqual(2)
    expect(petY()).toBe(before.y)
    expect(walking()).toBe(true)
  })

  it('comes back where she last rested after a remount (a room switch), not where she was dropped', () => {
    const sprite = { ...info, stateRows: ['idle', 'carried'] }
    const pose = () => window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')
    const first = render(<Chat sprite={sprite} />)
    const hit = window.document.querySelector<HTMLElement>('[data-pet-hit-box]')!

    fireEvent.pointerDown(hit, {
      button: 0,
      clientX: STAGE.left + petX() + 20,
      clientY: STAGE.top + petY() + 20,
      pointerId: 3
    })
    fireEvent.pointerMove(hit, { clientX: STAGE.left + 40, clientY: STAGE.top + 470, pointerId: 3 })
    fireEvent.pointerUp(hit, { clientX: STAGE.left + 40, clientY: STAGE.top + 470, pointerId: 3 })
    const dropped = petX()

    // She wanders off and settles somewhere else.
    until(walking)
    until(() => !walking() && pose() !== 'jump')
    const rested = { x: petX(), y: petY() }
    expect(Math.abs(rested.x - dropped)).toBeGreaterThan(4)

    first.unmount()
    render(<Chat sprite={sprite} />)
    expect(petX()).toBe(rested.x)
    expect(petY()).toBe(rested.y)
  })

  it('keeps each non-jump frame on the surface named by the engine', () => {
    // Own the engine's random stream: React and other mounted consumers must not consume it.
    render(<Chat rng={seeded(11)} />)
    const rim = COMPOSER.top - STAGE.top
    const ground = STAGE.bottom - STAGE.top
    const cardLeft = COMPOSER.left - STAGE.left
    const cardRight = COMPOSER.right - STAGE.left - pet.width
    const walks = new Set<string>()
    const rests = new Set<string>()
    const transitions = new Set<string>()
    let lastSurface = 'floor'

    const covered = () =>
      walks.size === 2 &&
      rests.size === 2 &&
      transitions.has('floor>composer:0:0') &&
      transitions.has('composer:0:0>floor')

    // Check every frame through walks, rests and a complete climb/descent. A fixed five-minute
    // sweep kept flushing React long after those witnesses, exceeding the wall-clock test
    // deadline under full-suite load even though the animation clock itself is fake.
    for (let elapsed = 0; elapsed < 300_000 && !covered(); elapsed += 16) {
      if (elapsed % 60_000 === 0) {
        fireEvent.pointerDown(window.document.querySelector('[data-atum-chat]')!)
      }

      advance(16)
      const body = window.document.querySelector<HTMLElement>('[data-pet-surface]')!
      const surface = body.getAttribute('data-pet-surface')!

      if (surface !== lastSurface) {
        transitions.add(`${lastSurface}>${surface}`)
        lastSurface = surface
      }

      if (!body.getAttribute('data-pet-pose')!.includes('jump')) {
        expect(petY() + pet.height).toBe(surface === 'floor' ? ground : rim)

        if (surface.startsWith('composer:')) {
          expect(petX()).toBeGreaterThanOrEqual(cardLeft)
          expect(petX()).toBeLessThanOrEqual(cardRight)
        }

        const activity = walking() ? walks : rests
        activity.add(surface)
      }
    }

    expect([...walks].sort()).toEqual(['composer:0:0', 'floor'])
    expect([...rests].sort()).toEqual(['composer:0:0', 'floor'])
    expect(transitions).toEqual(new Set(['floor>composer:0:0', 'composer:0:0>floor']))
  })

  it('plays seeded gestures, sleeps after idle and wakes on interaction with no polling', () => {
    render(<Chat />)
    const poses = new Set<string>()

    for (let elapsed = 0; elapsed < 180_000; elapsed += 200) {
      advance(200)
      poses.add(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')!)
    }

    expect([...poses].some(pose => ['wave', 'jump', 'waiting', 'lounging', 'review'].includes(pose))).toBe(true)
    expect(window.document.querySelector('[data-testid="sprite"]')!.getAttribute('data-paused')).toBe('true')
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.keyDown(window.document.querySelector('[data-atum-chat]')!, { key: 'a' })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('shows work and prompts standing, and reduced motion freezes on the first frame', () => {
    const view = render(<MatrixPetStage info={info} still={false} work="working" />)
    expect(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')).toBe('run')
    expect(walking()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(<MatrixPetStage info={info} still={false} work="waiting" />)
    expect(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')).toBe('waiting')
    view.rerender(<MatrixPetStage info={info} still={false} work="failed" />)
    expect(window.document.querySelector('[data-pet-pose]')!.getAttribute('data-pet-pose')).toBe('failed')
    view.rerender(<MatrixPetStage info={info} still work="idle" />)
    advance(120_000)
    expect(walking()).toBe(false)
    expect(window.document.querySelector('[data-testid="sprite"]')!.getAttribute('data-paused')).toBe('true')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops every scheduled task on document hide and on unmount', () => {
    const view = render(<Chat />)
    advance(10_000)
    vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true)
    act(() => window.document.dispatchEvent(new Event('visibilitychange')))
    advance(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(window.document.querySelector('[data-testid="sprite"]')!.getAttribute('data-paused')).toBe('true')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses approved nominal sizing through the actual stage while legacy Gigi stays unchanged', () => {
    const view = render(<MatrixPetStage info={info} still work="idle" />)
    const body = () => window.document.querySelector<HTMLElement>('[data-pet-pose]')!
    const gigiHeight = parseFloat(body().style.height)
    expect(gigiHeight).toBe(pet.height)

    const bernese: PetInfo = {
      ...info,
      size: 2,
      sizeClass: { naturalHeightPt: 210 },
      bounds: { idle: { x: 32, y: 78, width: 127, height: 117 } }
    }

    view.rerender(<MatrixPetStage info={bernese} still work="idle" />)
    const baileyVisible = (parseFloat(body().style.height) * 117) / 208
    const gigiVisible = (gigiHeight * 119) / 208
    expect(baileyVisible / gigiVisible).toBeGreaterThanOrEqual(2)
    expect(parseFloat(body().style.height)).toBeLessThanOrEqual(220)
  })

  it('renders the non-walk integrator arc inside its reserved control-clear band', () => {
    render(<Chat sprite={{ ...info, locomotion: 'fly' }} />)
    until(walking)
    const heights: number[] = []

    for (let index = 0; index < 50; index += 1) {
      advance(16)
      const body = window.document.querySelector<HTMLElement>('[data-pet-pose]')!

      const baseline =
        body.getAttribute('data-pet-surface') === 'floor' ? STAGE.bottom - STAGE.top : COMPOSER.top - STAGE.top

      heights.push(Number(/translateY\((-?[\d.]+)px\)/.exec(body.style.transform)?.[1]) + pet.height - baseline)
      expect(clear(petX(), action)).toBe(true)
    }

    expect(Math.min(...heights)).toBeLessThan(0)
    // The integrator may lift the painted sprite just above the stage, but
    // never farther than its bounded hop amplitude.
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(-32)
  })

  it('restores a user-dropped landing after the stage remounts', () => {
    const view = render(<Chat sprite={{ ...info, stateRows: ['idle', 'carried'] }} />)
    const hit = window.document.querySelector<HTMLElement>('[data-pet-hit-box]')!
    const startX = petX()
    const startY = petY()

    fireEvent.pointerDown(hit, {
      button: 0,
      clientX: STAGE.left + startX + 20,
      clientY: STAGE.top + startY + 20,
      pointerId: 11
    })
    fireEvent.pointerMove(hit, { clientX: STAGE.left + 220, clientY: STAGE.top + 120, pointerId: 11 })
    fireEvent.pointerUp(hit, { clientX: STAGE.left + 220, clientY: STAGE.top + 120, pointerId: 11 })

    const saved = JSON.parse(window.localStorage.getItem('atum.matrix.pet-stage-position.v1:local')!)
    expect(saved).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
    view.unmount()

    render(<Chat sprite={{ ...info, stateRows: ['idle', 'carried'] }} />)
    expect(petX()).toBe(saved.x)
    expect(petY() + pet.height).toBe(saved.y)
  })

  it('names every engine start and why in its diagnostics, and a focus re-read is not one', () => {
    const lines: MatrixPetDiagnostic[] = []
    vi.stubGlobal('atumMatrix', { pets: { diagnostic: (line: MatrixPetDiagnostic) => lines.push(line) } })
    const starts = () => lines.filter(line => line.event === 'start')
    const view = render(<Chat agent="diagnose-agent-principal" principal="diagnose" />)

    expect(starts()).toEqual([
      expect.objectContaining({
        reason: 'mount',
        restore: 'default',
        agent: 'diagnose',
        work: 'idle',
        surface: 'floor'
      })
    ])

    // Re-reads on focus hand over a new object for the same pet: nothing restarts.
    for (let index = 0; index < 3; index += 1) {
      view.rerender(<Chat agent="diagnose-agent-principal" principal="diagnose" sprite={{ ...info }} />)
      act(() => void window.dispatchEvent(new Event('focus')))
      advance(100)
    }

    expect(starts()).toHaveLength(1)

    // What she does shows up as it changes, with her place across the column.
    until(walking)
    until(() => !walking())
    expect(lines.some(line => line.pose === 'run' && line.x !== null)).toBe(true)
    expect(lines.some(line => line.event === 'state' && line.pose !== 'run')).toBe(true)

    view.unmount()
    const again = render(<Chat agent="diagnose-agent-principal" principal="diagnose" />)
    expect(starts().at(-1)).toMatchObject({ reason: 'remount', restore: 'saved' })

    again.rerender(<Chat agent="diagnose-agent-principal" principal="diagnose" sprite={{ ...info, slug: 'cookie' }} />)
    expect(starts().at(-1)).toMatchObject({ reason: 'sprite' })
    expect(lines.every(line => line.agent === 'diagnose')).toBe(true)
  })
})

it('keeps zero engine tasks until both picker and context menu close', () => {
  const hold = holdPetPresentation('local', performance.now())
  const view = render(<Chat />)
  act(() => hold.store.set({ ...hold.store.get(), pickerOpen: true, menuOpen: true }))
  expect(vi.getTimerCount()).toBe(0)
  const x = petX()
  act(() => hold.store.set({ ...hold.store.get(), pickerOpen: false }))
  advance(1000)
  expect(petX()).toBe(x)
  expect(vi.getTimerCount()).toBe(0)
  act(() => hold.store.set({ ...hold.store.get(), menuOpen: false }))
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  view.unmount()
  hold.release()
  expect(vi.getTimerCount()).toBe(0)
})

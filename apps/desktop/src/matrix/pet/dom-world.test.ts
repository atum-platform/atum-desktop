import { afterEach, describe, expect, it, vi } from 'vitest'

import { roamIsFree } from '../../../shared/pet-engine/lane'

import { observePetWindowWorld, readPetWindowWorld } from './dom-world'

const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top }) as DOMRect

afterEach(() => {
  window.document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('DOM lane world', () => {
  it('uses a broad floor, reserving only deliberate furniture', () => {
    window.document.body.innerHTML =
      '<main data-pet-stage><div data-pet-scroll><button id="message">Copy</button></div><div id="lane"><div id="pet"></div></div><button data-pet-paw id="paw">Pet</button><aside data-pet-avoid id="extra"></aside></main>'
    const lane = window.document.getElementById('lane')!
    const pet = window.document.getElementById('pet')!
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'lane') {
        return rect(100, 700, 468, 500)
      }

      if (this.id === 'message') {
        return rect(300, 330, 430, 450)
      }

      if (this.id === 'paw') {
        return rect(665, 700, 468, 500)
      }

      if (this.id === 'extra') {
        return rect(440, 470, 430, 450)
      }

      return rect(0, 0, 0, 0)
    })
    const world = readPetWindowWorld(lane, pet, { width: 89, height: 96 })
    // A transcript action is not permanent furniture. It cannot turn the
    // companion's one broad floor into a chain of tiny gaps.
    expect(roamIsFree(150, world.free)).toBe(true)
    // Explicit avoidance remains available for the rare place a surface owner
    // knows the pet must not cover.
    expect(roamIsFree(300, world.free)).toBe(false)
    expect(roamIsFree(500, world.free)).toBe(true)
    expect(roamIsFree(30, world.free)).toBe(true)
    // The paw remains clickable UI, but it is not a roaming obstacle.
    expect(roamIsFree(511, world.free)).toBe(true)
    expect(world.floorY).toBe(32)
    expect(world.perches).toEqual([])
  })

  it('does not turn transcript controls into movement obstacles', () => {
    window.document.body.innerHTML =
      '<main data-pet-stage><div data-pet-scroll><button id="old">old</button><button id="high">high</button><button id="hidden">hidden</button><button id="new">new</button></div><div id="lane"><div id="pet"></div></div></main>'
    const measured: string[] = []
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      measured.push(this.id)

      if (this.id === 'lane') {
        return rect(100, 700, 468, 500)
      }

      if (this.id === 'new') {
        return rect(300, 330, 430, 450)
      }

      if (this.id === 'high') {
        return rect(300, 330, 100, 120)
      }

      return rect(0, 0, 0, 0)
    })
    readPetWindowWorld(window.document.getElementById('lane')!, window.document.getElementById('pet')!, {
      width: 89,
      height: 96
    })
    expect(measured).toEqual(['lane'])
  })
})

describe('whole-column surfaces', () => {
  function fixture() {
    window.document.body.innerHTML =
      '<main data-pet-stage><div id="stage"><div id="pet"></div></div><section data-pet-perch="composer" id="composer"><button id="send">Send</button></section><button data-pet-avoid id="action">Action</button><button data-pet-paw id="paw">Pet</button><div id="dock"></div></main>'
    let actionTop = 500
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'stage') {
        return rect(100, 700, 100, 700)
      }

      if (this.id === 'composer') {
        return rect(250, 550, 450, 700)
      }

      if (this.id === 'send') {
        return rect(250, 280, 570, 600)
      }

      if (this.id === 'action') {
        return rect(550, 580, actionTop, actionTop + 30)
      }

      if (this.id === 'paw') {
        return rect(620, 650, 420, 450)
      }

      if (this.id === 'dock') {
        return rect(140, 660, 418, 450)
      }

      return rect(0, 0, 0, 0)
    })

    return {
      stage: window.document.getElementById('stage')!,
      pet: window.document.getElementById('pet')!,
      dock: window.document.getElementById('dock')!,
      blockHop: () => {
        actionTop = 520
      }
    }
  }

  it('keeps the window bottom and the composer as separate surfaces: the floor runs in front of the glass', () => {
    const f = fixture()
    const world = readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 })
    expect(world.floorY).toBe(600)
    // Her layer paints above the card, so the ground in front of it is hers, edge to edge.
    expect(world.free).toEqual([{ left: 0, right: 511 }])
    expect(world.perches).toEqual([{ id: 'composer:0:0', left: 150, right: 361, y: 350 }])
    expect(roamIsFree(200, world.free)).toBe(true)
    expect(roamIsFree(150, world.perches)).toBe(true)
    expect(roamIsFree(361, world.perches)).toBe(true)
    // A floor-level control is below the named rim and cannot invent or split it.
    f.blockHop()
    expect(readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }).perches).toEqual(world.perches)
    // Without a composer the stage keeps the real window bottom.
    window.document.getElementById('composer')!.remove()
    expect(readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }).floorY).toBe(600)
  })

  it('projects the active browser edge from the shared chat/workspace stage root', () => {
    window.document.body.innerHTML =
      '<div data-pet-stage-root id="root"><main data-pet-stage><div id="stage"><div id="pet"></div></div><section data-pet-walk-surface="composer" id="composer"></section></main><aside><div data-pet-walk-surface="browser" id="browser"></div></aside></div>'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'stage' || this.id === 'root') {
        return rect(0, 1200, 0, 760)
      }

      if (this.id === 'composer') {
        return rect(160, 730, 620, 760)
      }

      if (this.id === 'browser') {
        return rect(790, 1186, 92, 760)
      }

      return rect(0, 0, 0, 0)
    })

    const world = readPetWindowWorld(
      window.document.getElementById('stage')!,
      window.document.getElementById('pet')!,
      { width: 89, height: 120, footY: 90 }
    )

    const browser = world.perches.find(perch => perch.id.startsWith('browser:'))

    expect(browser).toEqual({ id: 'browser:0:0', left: 790, right: 1097, y: 92 })
    expect(world.perches.some(perch => perch.id.startsWith('composer:'))).toBe(true)
    // The floor runs in front of the composer and the browser page alike (split view).
    expect(world.free).toEqual([{ left: 0, right: 1111 }])

    window.document.getElementById('browser')!.setAttribute('hidden', '')
    expect(
      readPetWindowWorld(
        window.document.getElementById('stage')!,
        window.document.getElementById('pet')!,
        { width: 89, height: 120, footY: 90 }
      ).perches.some(perch => perch.id.startsWith('browser:'))
    ).toBe(false)
  })

  it('keeps the entire physical rim walkable, and a composer too narrow for her is no perch', () => {
    window.document.body.innerHTML =
      '<main data-pet-stage><div id="stage"><div id="pet"></div></div><section data-slot="composer-surface" id="composer"><div data-slot="composer-actions" id="actions"></div></section></main>'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'stage') {
        return rect(0, 600, 0, 600)
      }

      if (this.id === 'composer') {
        return rect(50, 550, 500, 600)
      }

      if (this.id === 'actions') {
        return rect(450, 540, 500, 540)
      }

      return rect(0, 0, 0, 0)
    })

    const world = readPetWindowWorld(
      window.document.getElementById('stage')!,
      window.document.getElementById('pet')!,
      { width: 89, height: 120 }
    )

    expect(world.floorY).toBe(600)
    expect(world.perches).toEqual([{ id: 'composer:0:0', left: 50, right: 461, y: 500 }])
    // 50 px each side is narrower than she is; the ground in front of the card is still hers.
    expect(world.free).toEqual([{ left: 0, right: 511 }])
    expect(roamIsFree(300, world.perches)).toBe(true)
    // The pet layer is pointer-transparent; action geometry cannot collapse the
    // rim into the tiny side gaps that caused this regression.
    expect(roamIsFree(400, world.perches)).toBe(true)

    // Narrower than she is: the card has no room on top, and the whole floor stays hers.
    window.document.getElementById('composer')!.style.width = '40px'
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.id === 'stage') {
        return rect(0, 300, 0, 300)
      }

      if (this.id === 'composer') {
        return rect(250, 290, 240, 300)
      }

      return rect(0, 0, 0, 0)
    })

    const narrow = readPetWindowWorld(
      window.document.getElementById('stage')!,
      window.document.getElementById('pet')!,
      { width: 89, height: 120 }
    )

    expect(narrow.floorY).toBe(300)
    expect(narrow.perches).toEqual([])
    expect(narrow.free).toEqual([{ left: 0, right: 211 }])
  })

  it('keeps roaming-off at one safe position beside the paw', () => {
    const f = fixture()
    const world = readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }, f.dock)
    expect(world.floorY).toBe(350)
    expect(world.perches).toEqual([])
    expect(world.free).toHaveLength(1)
    expect(world.free[0]!.left).toBe(world.free[0]!.right)
    expect(world.free[0]!.right + 89).toBeLessThanOrEqual(520 - 8)
  })

  it('keeps the explicit-off dock visible when a narrow row has no clear span', () => {
    window.document.body.innerHTML =
      '<main data-pet-stage><div id="stage"><div id="pet"></div></div><div id="dock"></div><button id="block">Blocked row</button><button data-pet-paw id="paw">Pet</button></main>'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'stage' || this.id === 'dock' || this.id === 'block') {
        return rect(0, 120, 0, 32)
      }

      if (this.id === 'paw') {
        return rect(90, 120, 0, 32)
      }

      return rect(0, 0, 0, 0)
    })

    const world = readPetWindowWorld(
      window.document.getElementById('stage')!,
      window.document.getElementById('pet')!,
      { width: 89, height: 120 },
      window.document.getElementById('dock')!
    )

    expect(world.free).toEqual([{ left: 0, right: 0 }])
  })

  it('observes the untagged actual composer surface resize and cleans up listeners', () => {
    const f = fixture()
    const composer = window.document.getElementById('composer')!
    composer.removeAttribute('data-pet-perch')
    composer.setAttribute('data-slot', 'composer-surface')
    const observed: Element[] = []
    const disconnect = vi.fn()
    const changed = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(element: Element) {
          observed.push(element)
        }
        disconnect = disconnect
      }
    )
    const stop = observePetWindowWorld(f.stage, changed)
    expect(observed).toContain(window.document.getElementById('composer'))
    f.stage.parentElement!.dispatchEvent(new Event('scroll'))
    expect(changed).toHaveBeenCalledOnce()
    stop()
    f.stage.parentElement!.dispatchEvent(new Event('scroll'))
    expect(changed).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

it('runs the floor in front of the centred composer, and docks beside the paw when roaming is off', () => {
  window.document.body.innerHTML =
    '<main data-atum-chat data-pet-stage><div id="stage"><div id="pet"></div></div><div data-matrix-composer-dock><div data-slot="composer-root"><div data-slot="composer-surface" id="composer"><textarea id="input"></textarea></div></div></div><div data-pet-dock id="dock"></div></main>'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.id === 'stage') {
      return rect(0, 800, 0, 808)
    }

    if (this.id === 'dock') {
      return rect(90, 710, 653, 685)
    }

    if (this.id === 'composer') {
      return rect(85, 715, 693, 808)
    }

    if (this.id === 'input') {
      return rect(99, 701, 702, 735)
    }

    return rect(0, 0, 0, 0)
  })

  const world = readPetWindowWorld(window.document.getElementById('stage')!, window.document.getElementById('pet')!, {
    width: 89,
    height: 120
  })

  expect(world.floorY).toBe(808)
  // The 0.20.27 regression: with the card solid this was [] (85 px beside it is less than her
  // width), so she could not set foot on the ground in front of the composer at all.
  expect(world.free).toEqual([{ left: 0, right: 711 }])
  expect(world.perches).toEqual([{ id: 'composer:0:0', left: 85, right: 626, y: 693 }])
  // The rim runs from the card's left edge to where she still stands clear of its actions.
  expect(roamIsFree(85, world.perches)).toBe(true)
  expect(roamIsFree(626, world.perches)).toBe(true)
  expect(roamIsFree(0, world.perches)).toBe(false)

  const parked = readPetWindowWorld(
    window.document.getElementById('stage')!,
    window.document.getElementById('pet')!,
    { width: 89, height: 120 },
    window.document.getElementById('dock')!
  )

  expect(parked).toMatchObject({ floorY: 685, free: [{ left: 613, right: 613 }], perches: [] })
})

describe('what may cover her', () => {
  function layered() {
    window.document.body.innerHTML = [
      '<div id="app"><main data-pet-stage><div id="stage"><div id="pet"></div></div>',
      '<div data-matrix-composer-dock><div data-matrix-pet id="anchor"></div><div id="notice"></div>',
      '<div data-slot="composer-root" id="composer-root"><div data-slot="composer-surface" id="composer"></div></div>',
      '</div></main></div>',
      '<div id="menu"><div role="menu"></div></div>',
      '<div id="own"><div data-pet-own></div></div>',
      '<div id="tip"><div role="tooltip"></div></div>',
      // react-textarea-autosize's measuring node: on the page, painting nothing.
      '<textarea id="measure" style="visibility: hidden"></textarea>'
    ].join('')

    const rects: Record<string, DOMRect> = {
      stage: rect(0, 1000, 0, 760),
      anchor: rect(0, 1000, 0, 760),
      composer: rect(120, 880, 620, 740),
      // The root's padding reaches above the rim: it must not count as furniture.
      'composer-root': rect(120, 880, 612, 752),
      notice: rect(500, 860, 560, 612),
      menu: rect(130, 330, 380, 610),
      own: rect(340, 400, 300, 610),
      tip: rect(340, 400, 590, 610),
      measure: rect(120, 880, 600, 608)
    }

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rects[this.id] ?? rect(0, 0, 0, 0)
    })

    return {
      rects,
      stage: window.document.getElementById('stage')!,
      pet: window.document.getElementById('pet')!
    }
  }

  it('keeps her out of the dock furniture and portalled menus, but not out of her own UI, a tooltip or a hidden node', () => {
    const f = layered()
    const world = readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 })

    // The menu takes the rim's left stretch and the notice its right: one stretch stays hers.
    expect(world.perches).toEqual([{ id: 'composer:0:0', left: 338, right: 403, y: 620 }])
    // The floor runs in front of the glass and the notice (both paint beneath her layer).
    expect(world.free).toEqual([{ left: 0, right: 911 }])

    // A menu that reaches down to the floor paints over her there: that stretch of ground goes.
    const menu = f.rects.menu
    f.rects.menu = rect(130, 330, 380, 760)
    expect(readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }).free).toEqual([
      { left: 0, right: 33 },
      { left: 338, right: 911 }
    ])
    f.rects.menu = menu

    // Closing the menu gives the stretch back.
    window.document.getElementById('menu')!.remove()
    expect(readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }).perches).toEqual([
      { id: 'composer:0:0', left: 120, right: 403, y: 620 }
    ])

    // The same box painting is a cover: the hidden node above was let through, not missed.
    window.document.getElementById('measure')!.style.visibility = 'visible'
    expect(readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 }).perches).toEqual([])
  })

  it('keeps an inert composer a surface: inert leaves the keyboard, not the screen', () => {
    const f = layered()
    window.document.getElementById('app')!.firstElementChild!.setAttribute('inert', '')
    window.document.getElementById('menu')!.remove()

    const world = readPetWindowWorld(f.stage, f.pet, { width: 89, height: 120 })

    expect(world.free).toEqual([{ left: 0, right: 911 }])
    expect(world.perches).toEqual([{ id: 'composer:0:0', left: 120, right: 403, y: 620 }])
  })

  it('re-reads when a portalled layer opens or is placed, and ignores her own portalled UI', async () => {
    const f = layered()
    const changed = vi.fn()
    const stop = observePetWindowWorld(f.stage, changed)
    const flush = () => new Promise(resolve => setTimeout(resolve, 0))

    const popover = window.document.createElement('div')
    window.document.body.append(popover)
    await flush()
    expect(changed).toHaveBeenCalled()

    changed.mockClear()
    popover.style.transform = 'translate(120px, 380px)'
    await flush()
    expect(changed).toHaveBeenCalled()

    changed.mockClear()
    window.document.getElementById('own')!.firstElementChild!.setAttribute('style', 'left: 3px')
    window.document.getElementById('app')!.setAttribute('style', 'color: red')
    await flush()
    expect(changed).not.toHaveBeenCalled()

    stop()
    popover.remove()
    await flush()
    expect(changed).not.toHaveBeenCalled()
  })
})

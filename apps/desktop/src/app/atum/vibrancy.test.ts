/**
 * Renderer-side glass geometry: the collector measures exactly the frosted
 * Atum surfaces (never the seams, never hidden/fading plates, never the solid
 * recovery material), and the sync engine pushes diffed frames to the native
 * bridge only when one exists — everywhere else stays CSS-only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ATUM_NATIVE_GLASS_ATTRIBUTE,
  type AtumVibrancyClient,
  collectAtumGlassRegions,
  ensureAtumVibrancySync,
  stopAtumVibrancySync
} from './vibrancy'

function glassElement(attributes: Record<string, string>, rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div')

  for (const [name, value] of Object.entries(attributes)) {
    el.setAttribute(name, value)
  }

  el.style.borderTopLeftRadius = '14px'
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    ...rect,
    toJSON: () => ({})
  } as DOMRect)
  document.body.appendChild(el)

  return el
}

async function flushFrames(): Promise<void> {
  // MutationObserver delivery is a microtask; the sync itself is rAF-gated.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  stopAtumVibrancySync()
  document.body.innerHTML = ''
  document.documentElement.classList.remove('dark')
  document.documentElement.removeAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)
  // @ts-expect-error test seam — clear the injected preload bridge
  delete window.hermesDesktop
})

describe('collectAtumGlassRegions', () => {
  it('measures every discrete frosted surface in document order, banded by density', () => {
    glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })
    // Rail and roster sit 2px apart across the fused seam: two 14px-radius
    // native views that close leave diamond holes at the seam corners, so the
    // UNION wrapper emits one region and the individual plates emit none.
    glassElement({ 'data-atum-sidebar-union': '' }, { height: 700, width: 328, x: 10, y: 60 })
    glassElement({ class: 'atum-plate-chat' }, { height: 700, width: 500, x: 356, y: 60 })
    glassElement({ 'data-atum-workspace': '' }, { height: 700, width: 400, x: 866, y: 60 })

    // The Kimi artifact's opacity hierarchy, mirrored into the native material:
    // rim thinnest, sidebar-union/workspace mid, transcript most present. A
    // single band for all surfaces is what collapsed the panels into one sheet.
    expect(collectAtumGlassRegions(document)).toEqual([
      { height: 40, material: 'thin', radius: 14, width: 1180, x: 10, y: 10 },
      { height: 700, material: 'regular', radius: 14, width: 328, x: 10, y: 60 },
      { height: 700, material: 'thick', radius: 14, width: 500, x: 356, y: 60 },
      { height: 700, material: 'regular', radius: 14, width: 400, x: 866, y: 60 }
    ])
  })

  it('bands the compact solo rail as its own regular surface', () => {
    glassElement({ 'data-atum-rail': '', 'data-atum-solo': 'true' }, { height: 700, width: 58, x: 10, y: 60 })

    expect(collectAtumGlassRegions(document)).toEqual([
      { height: 700, material: 'regular', radius: 14, width: 58, x: 10, y: 60 }
    ])
  })

  it('emits nothing for an inline rail or roster outside the union', () => {
    // Inline plates are backed by the union region; their own hooks must not
    // add a second stacked native material.
    glassElement({ 'data-atum-rail': '' }, { height: 700, width: 58, x: 10, y: 60 })
    glassElement({ 'data-atum-roster': '' }, { height: 700, width: 268, x: 70, y: 60 })

    expect(collectAtumGlassRegions(document)).toEqual([])
  })

  it('measures the auth and startup plates as their own thick surfaces', () => {
    glassElement({ class: 'atum-auth-plate' }, { height: 400, width: 400, x: 400, y: 200 })
    glassElement({ class: 'atum-startup-plate' }, { height: 300, width: 300, x: 450, y: 250 })
    glassElement({ 'data-atum-workspace-loading': '' }, { height: 700, width: 400, x: 866, y: 60 })

    expect(collectAtumGlassRegions(document)).toEqual([
      { height: 400, material: 'thick', radius: 14, width: 400, x: 400, y: 200 },
      { height: 300, material: 'thick', radius: 14, width: 300, x: 450, y: 250 },
      { height: 700, material: 'regular', radius: 14, width: 400, x: 866, y: 60 }
    ])
  })

  it('never sends the composer: an interior surface keeps its own CSS blur', () => {
    // Native glass sits behind ALL web content, so a region here would stack a
    // third material under the chat plate's tint AND still fail to blur the
    // transcript scrolling above the composer. CSS backdrop-filter owns it.
    const shell = document.createElement('div')
    shell.className = 'atum-shell'
    const composer = document.createElement('div')
    composer.setAttribute('data-slot', 'composer-surface')
    composer.style.borderTopLeftRadius = '14px'
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
      height: 44,
      width: 460,
      x: 380,
      y: 700
    } as DOMRect)
    shell.appendChild(composer)
    document.body.appendChild(shell)

    expect(collectAtumGlassRegions(document)).toEqual([])
  })

  it('skips zero-size and fully transparent plates so no ghost blur lingers', () => {
    glassElement({ 'data-atum-rim': '' }, { height: 0, width: 0, x: 10, y: 10 })
    const faded = glassElement({ class: 'atum-startup-plate' }, { height: 300, width: 300, x: 450, y: 250 })
    faded.style.opacity = '0'

    expect(collectAtumGlassRegions(document)).toEqual([])
  })

  it('reports nothing while the solid recovery material is active', () => {
    const shell = document.createElement('div')
    shell.className = 'atum-shell'
    shell.setAttribute('data-atum-material', 'legacy-solid')
    document.body.appendChild(shell)
    glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })

    expect(collectAtumGlassRegions(document)).toEqual([])
  })

  it('bands a surface that matches two tiers by the first (thinnest) match', () => {
    // A union wrapper that somehow also carries the rim hook must stay
    // deterministic: first tier in the table wins.
    glassElement({ 'data-atum-rim': '', 'data-atum-sidebar-union': '' }, { height: 700, width: 328, x: 10, y: 60 })

    expect(collectAtumGlassRegions(document)[0]?.material).toBe('thin')
  })

  it('falls back to the product radius when the computed style is unusable', () => {
    const el = glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })

    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      borderTopLeftRadius: '',
      opacity: '1'
    } as CSSStyleDeclaration)

    const [region] = collectAtumGlassRegions(document)

    expect(region?.radius).toBe(14)
    getComputedStyleSpy.mockRestore()
  })

  it('honors a legitimate zero border radius', () => {
    const el = glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })
    el.style.borderTopLeftRadius = '0px'

    const [region] = collectAtumGlassRegions(document)

    expect(region?.radius).toBe(0)
  })
})

describe('ensureAtumVibrancySync', () => {
  it('is a no-op without a native bridge (non-macOS keeps the CSS material)', async () => {
    ensureAtumVibrancySync()
    await flushFrames()

    expect(collectAtumGlassRegions(document)).toEqual([])
    // No attribute at all: the CSS recipe, blur included, must stay in charge.
    expect(document.documentElement.hasAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe(false)
  })

  it('pushes measured frames and dedupes unchanged layouts', async () => {
    const setRegions = vi.fn<AtumVibrancyClient['setRegions']>(async () => ({ ok: true }))
    // @ts-expect-error test seam — only the vibrancy slice of the preload bridge
    window.hermesDesktop = { atumVibrancy: { setRegions } }

    glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })

    ensureAtumVibrancySync()
    await flushFrames()

    expect(setRegions).toHaveBeenCalledTimes(1)
    expect(setRegions).toHaveBeenLastCalledWith({
      dark: false,
      regions: [{ height: 40, material: 'thin', radius: 14, width: 1180, x: 10, y: 10 }]
    })

    // A no-op mutation must not re-send the same frame.
    document.body.appendChild(document.createElement('span'))
    await flushFrames()

    expect(setRegions).toHaveBeenCalledTimes(1)
  })

  it('tracks mount/unmount and theme flips through the observers', async () => {
    const setRegions = vi.fn<AtumVibrancyClient['setRegions']>(async () => ({ ok: true }))
    // @ts-expect-error test seam — only the vibrancy slice of the preload bridge
    window.hermesDesktop = { atumVibrancy: { setRegions } }

    ensureAtumVibrancySync()
    await flushFrames()
    expect(setRegions).toHaveBeenLastCalledWith({ dark: false, regions: [] })

    const rim = glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })
    await flushFrames()
    expect(setRegions).toHaveBeenLastCalledWith({
      dark: false,
      regions: [{ height: 40, material: 'thin', radius: 14, width: 1180, x: 10, y: 10 }]
    })

    document.documentElement.classList.add('dark')
    await flushFrames()
    expect(setRegions).toHaveBeenLastCalledWith({
      dark: true,
      regions: [{ height: 40, material: 'thin', radius: 14, width: 1180, x: 10, y: 10 }]
    })

    rim.remove()
    await flushFrames()
    expect(setRegions).toHaveBeenLastCalledWith({ dark: true, regions: [] })
  })

  it('swallows a rejected frame instead of breaking rendering', async () => {
    const setRegions = vi.fn<AtumVibrancyClient['setRegions']>(async () => {
      throw new Error('ipc-gone')
    })

    // @ts-expect-error test seam — only the vibrancy slice of the preload bridge
    window.hermesDesktop = { atumVibrancy: { setRegions } }

    ensureAtumVibrancySync()
    await flushFrames()

    expect(setRegions).toHaveBeenCalledTimes(1)
    // A dead bridge must hand the blur back to CSS, not leave the plates bare.
    expect(document.documentElement.getAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe('off')
  })

  // The CSS material reads this attribute to decide whether to drop its own
  // (inert, and compositing-opaque) backdrop-filter. Getting it wrong either
  // re-stacks two materials into flat grey, or strips the blur on a build that
  // has no native glass at all — so it is asserted in both directions.
  it('flags the root only once a native frame has actually landed', async () => {
    const setRegions = vi.fn<AtumVibrancyClient['setRegions']>(async () => ({ ok: true }))
    // @ts-expect-error test seam — only the vibrancy slice of the preload bridge
    window.hermesDesktop = { atumVibrancy: { setRegions } }

    glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })

    // Before the first reply the CSS material is still the only one on screen.
    expect(document.documentElement.hasAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe(false)

    ensureAtumVibrancySync()
    await flushFrames()

    expect(document.documentElement.getAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe('on')

    stopAtumVibrancySync()
    expect(document.documentElement.hasAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe(false)
  })

  it('falls back to the CSS material when the main process refuses the frame', async () => {
    const setRegions = vi.fn<AtumVibrancyClient['setRegions']>(async () => ({
      error: 'native-unavailable',
      ok: false
    }))

    // @ts-expect-error test seam — only the vibrancy slice of the preload bridge
    window.hermesDesktop = { atumVibrancy: { setRegions } }

    glassElement({ 'data-atum-rim': '' }, { height: 40, width: 1180, x: 10, y: 10 })

    ensureAtumVibrancySync()
    await flushFrames()

    expect(document.documentElement.getAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)).toBe('off')
  })
})

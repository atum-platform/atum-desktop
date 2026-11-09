import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PetGallery from '@/store/pet-gallery'

import type * as SheetStore from './store'

/**
 * A card is alive only while it is near the viewport: the sprite mounts when
 * the card comes near and unmounts when it leaves, so scrolling a long shelf
 * never accumulates running canvases.
 */

const loadPetSheet = vi.fn()
const loadPetThumb = vi.fn()

vi.mock('@/store/pet-gallery', async importOriginal => ({ ...(await importOriginal<typeof PetGallery>()), loadPetThumb }))
vi.mock('./store', async importOriginal => ({ ...(await importOriginal<typeof SheetStore>()), loadPetSheet }))

const { $petSheets, isPetSheetHeld, resetPetSheets } = await import('./store')
const { LivePetCard } = await import('./live-card')

const SHEET = { displayName: 'Boba', enabled: true, frameH: 208, frameW: 192, framesPerState: 8, mime: 'image/webp', scale: 1, slug: 'boba', spritesheetBase64: 'AA==' }
const PET = { displayName: 'Boba', installed: false, price: { kind: 'free' as const }, slug: 'boba' }

/**
 * A hand-driven IntersectionObserver: tests decide when the card is near.
 * The thumbnail inside the card watches itself too, so a test picks the
 * observer by the element it watches — the card's own box.
 */
class FakeObserver {
  static all: FakeObserver[] = []
  readonly callback: IntersectionObserverCallback
  element: Element | null = null
  disconnected = false

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeObserver.all.push(this)
  }

  static watching(element: Element | null): FakeObserver {
    const found = FakeObserver.all.find(observer => observer.element === element)

    if (!found) {
      throw new Error('no observer watches that element')
    }

    return found
  }

  observe(element: Element): void {
    this.element = element
  }

  disconnect(): void {
    this.disconnected = true
  }

  near(isIntersecting: boolean): void {
    act(() => this.callback([{ isIntersecting } as IntersectionObserverEntry], this as never))
  }
}

beforeEach(() => {
  resetPetSheets()
  loadPetSheet.mockReset().mockResolvedValue(null)
  loadPetThumb.mockReset().mockResolvedValue(null)
  FakeObserver.all = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a live card', () => {
  it('asks for its sheet only once it is near, and goes live when the sheet is in', () => {
    const { container } = render(<LivePetCard onOpen={() => {}} owners={[]} pet={PET} />)
    const card = () => container.querySelector('[data-pet-card="boba"]')!
    const box = FakeObserver.watching(container.querySelector('button[aria-label="Boba"]'))

    expect(loadPetSheet).not.toHaveBeenCalled()
    expect(card().getAttribute('data-pet-live')).toBe('false')

    box.near(true)
    expect(loadPetSheet).toHaveBeenCalledOnce()

    act(() => $petSheets.set({ boba: SHEET }))
    expect(card().getAttribute('data-pet-live')).toBe('true')
    expect(container.querySelector('canvas')).toBeTruthy()
  })

  it('puts the sprite away when it scrolls out of view, and brings it back', () => {
    $petSheets.set({ boba: SHEET })
    const { container } = render(<LivePetCard onOpen={() => {}} owners={[]} pet={PET} />)
    const live = () => container.querySelector('[data-pet-card="boba"]')!.getAttribute('data-pet-live')
    const box = FakeObserver.watching(container.querySelector('button[aria-label="Boba"]'))

    box.near(true)
    expect(live()).toBe('true')

    box.near(false)
    expect(live()).toBe('false')
    expect(container.querySelector('canvas')).toBeNull()

    box.near(true)
    expect(live()).toBe('true')
    // The sheet was held; coming back cost no request.
    expect(loadPetSheet).not.toHaveBeenCalled()
  })

  it('holds its sheet while near and lets go when it leaves', () => {
    const { container, unmount } = render(<LivePetCard onOpen={() => {}} owners={[]} pet={PET} />)
    const box = FakeObserver.watching(container.querySelector('button[aria-label="Boba"]'))

    expect(isPetSheetHeld('boba')).toBe(false)
    box.near(true)
    expect(isPetSheetHeld('boba')).toBe(true)
    box.near(false)
    expect(isPetSheetHeld('boba')).toBe(false)

    box.near(true)
    unmount()
    expect(isPetSheetHeld('boba')).toBe(false)
  })

  it('keeps watching while mounted, and stops when unmounted', () => {
    const { container, unmount } = render(<LivePetCard onOpen={() => {}} owners={[]} pet={PET} />)
    const box = FakeObserver.watching(container.querySelector('button[aria-label="Boba"]'))

    box.near(true)
    box.near(false)
    expect(box.disconnected).toBe(false)

    unmount()

    expect(box.disconnected).toBe(true)
  })
})

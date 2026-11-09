import { act, cleanup, render } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PetInfo, PetState } from '../../../shared/pet'

import { PetSpriteCanvas } from './pet-sprite-canvas'

// A Matrix-compatible renderer must mount without loading the v1 account,
// session or profile state. This fails on an actual import, not source text.
vi.mock('@/store/pet', () => { throw new Error('legacy_pet_store_imported') })

const info: PetInfo = {
  enabled: true,
  displayName: 'Gigi',
  spritesheetBase64: 'fixture',
  frameW: 192,
  frameH: 208,
  scale: 0.5,
  size: 2,
  stateRows: ['idle', 'running', 'waiting'],
  framesPerState: 6,
  loopMs: 1200
}

let draw: ReturnType<typeof vi.fn>

// Runs every step timer due by `time` ms after mount.
function tick(time = 0) {
  act(() => vi.advanceTimersByTime(Math.max(0, time - performance.now())))
}

function setHidden(hidden: boolean) {
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: hidden })
  act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw, clearRect: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('Image', class { complete = true; naturalWidth = 1152; src = '' })
})

afterEach(() => {
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  Reflect.deleteProperty(window.document, 'hidden')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared pet canvas', () => {
  it('draws one still frame and releases animation work for reduced motion', () => {
    const view = render(<PetSpriteCanvas info={info} paused stateOverride="idle" />)
    tick(500)
    expect(draw.mock.lastCall?.slice(1, 3)).toEqual([0, 0])
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(<PetSpriteCanvas info={info} paused stateOverride="waiting" />)
    tick(600)
    expect(draw.mock.lastCall?.slice(1, 3)).toEqual([0, 416])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('renders idle without a running agent or legacy store, preserving scale × size', () => {
    const view = render(<PetSpriteCanvas info={info} />)
    tick()

    expect(view.getByLabelText('Gigi pet').getAttribute('width')).toBe('192')
    expect(view.getByLabelText('Gigi pet').getAttribute('height')).toBe('208')
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 192, 208, 0, 0, 192, 208)
  })

  it('switches activity sources without leaving another agent subscribed', () => {
    const first = atom<PetState>('run')
    const second = atom<PetState>('waiting')
    const view = render(<PetSpriteCanvas activity={first} info={info} />)
    tick()
    expect(draw.mock.lastCall?.[2]).toBe(208)

    view.rerender(<PetSpriteCanvas activity={second} info={info} />)
    tick()
    expect(draw.mock.lastCall?.[2]).toBe(416)
    expect(first.lc).toBe(0)
    expect(second.lc).toBe(1)

    act(() => first.set('failed'))
    tick(300)
    expect(draw.mock.lastCall?.[2]).toBe(416)
    act(() => second.set('idle'))
    tick(400)
    expect(draw.mock.lastCall?.[2]).toBe(0)
    view.unmount()
    expect(first.lc).toBe(0)
    expect(second.lc).toBe(0)
  })

  it('retains tempo updates and a forced state without restarting the animation', () => {
    const activity = atom<PetState>('run')
    const tempo = atom(2)
    const view = render(<PetSpriteCanvas activity={activity} info={info} stateOverride="idle" tempo={tempo} />)
    tick()
    tick(250)
    expect(draw).toHaveBeenCalledTimes(1)
    tick(400)
    expect(draw.mock.lastCall?.slice(1, 3)).toEqual([192, 0])
    act(() => tempo.set(1))
    tick(600)
    expect(draw.mock.lastCall?.slice(1, 3)).toEqual([384, 0])

    view.rerender(<PetSpriteCanvas activity={activity} info={info} tempo={tempo} />)
    tick(610)
    expect(draw.mock.lastCall?.slice(1, 3)).toEqual([0, 208])
    view.unmount()
    expect(tempo.lc).toBe(0)
  })

  it('keeps Hermes pose fallbacks and concrete row overrides', () => {
    const view = render(<PetSpriteCanvas info={info} stateOverride="sleep" />)
    tick()
    expect(draw.mock.lastCall?.[2]).toBe(416)
    view.rerender(<PetSpriteCanvas info={info} rowOverride="running" stateOverride="sleep" />)
    tick()
    expect(draw.mock.lastCall?.[2]).toBe(208)
  })

  it('drops the previous image and animation when there are no sprite bytes', () => {
    const view = render(<PetSpriteCanvas info={info} />)
    tick()
    view.rerender(<PetSpriteCanvas info={{ enabled: false }} />)
    expect(vi.getTimerCount()).toBe(0)
    tick(400)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('wakes once per cell, not every display frame, and rests while the window is hidden', () => {
    const wakes = vi.spyOn(globalThis, 'setTimeout')
    render(<PetSpriteCanvas info={info} stateOverride="run" />)
    tick(1000)
    // 1200 ms over 6 cells: a cell every 200 ms, so five steps after the first draw.
    expect(draw).toHaveBeenCalledTimes(6)
    expect(wakes.mock.calls.length).toBeLessThanOrEqual(8)

    setHidden(true)
    tick(1200)
    const drawsWhileShown = draw.mock.calls.length
    expect(vi.getTimerCount()).toBe(0)
    tick(5000)
    expect(draw).toHaveBeenCalledTimes(drawsWhileShown)

    setHidden(false)
    tick(5200)
    expect(draw.mock.calls.length).toBeGreaterThan(drawsWhileShown)
  })
})

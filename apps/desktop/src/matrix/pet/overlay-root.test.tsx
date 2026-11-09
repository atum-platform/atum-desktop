import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixPetOverlayBridge, MatrixPetOverlaySnapshot } from '../../../shared/matrix-pet-overlay'

import { MatrixPetOverlayRoot } from './overlay-root'

vi.mock('@/components/pet/pet-sprite-canvas', () => ({
  PetSpriteCanvas: () => <canvas />,
  roamWalkRow: () => ({ row: 'run', mirror: false })
}))

function setup() {
  let listener: (snapshot: MatrixPetOverlaySnapshot) => void = () => undefined
  const unsubscribe = vi.fn()

  const bridge: MatrixPetOverlayBridge = {
    onSnapshot: callback => {
      listener = callback

      return unsubscribe
    },
    drag: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    menu: vi.fn(async () => undefined),
    popIn: vi.fn(async () => undefined),
    setInteractive: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined)
  }

  const view = render(<MatrixPetOverlayRoot bridge={bridge} />)

  const snapshot: MatrixPetOverlaySnapshot = {
    sprite: { enabled: true, displayName: 'Gigi', spritesheetBase64: 'test' },
    locale: 'en',
    size: { width: 100, height: 110, zoom: 0.5 },
    intent: { pose: 'idle', mirror: false, direction: 0, paused: true },
    recent: [],
    unsaved: [],
    chatOpen: true
  }

  const paint = (value = snapshot) => act(() => listener(value))
  paint()

  return { ...view, bridge, snapshot, paint, unsubscribe }
}

function shown(role: 'user' | 'pet') {
  return [...globalThis.document.querySelectorAll(`[data-pet-turn="${role}"]`)].map(node => node.textContent)
}

describe('overlay snapshot presentation', () => {
  it('submits only text through its fixed bridge, showing it at once while the pet thinks', async () => {
    const { bridge } = setup()
    let accept: () => void = () => undefined
    vi.mocked(bridge.submit).mockImplementation(() => new Promise<void>(resolve => (accept = resolve)))
    const input = screen.getByRole('textbox')
    expect(globalThis.document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'Hello Gigi' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    expect(bridge.submit).toHaveBeenCalledExactlyOnceWith('Hello Gigi')
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(shown('user')).toEqual(['Hello Gigi'])
    expect(screen.getByRole('status', { name: 'Gigi is thinking…' })).toBeTruthy()
    await act(async () => accept())
    expect(screen.queryByRole('status', { name: 'Gigi is thinking…' })).toBeNull()
  })

  it('renders the pet own recent turns, never a room transcript', () => {
    const { paint, snapshot } = setup()
    paint({
      ...snapshot,
      recent: [
        { role: 'user', text: 'hello', at: '2026-10-27T02:00:00.000Z' },
        { role: 'pet', text: 'Mình nghe nè.', at: '2026-10-27T02:00:01.000Z' }
      ]
    })
    expect(shown('pet')).toEqual(['Mình nghe nè.'])
    expect(shown('user')).toEqual(['hello'])
  })

  it('shows the answer main holds outside the history, after the stored turns', () => {
    const { paint, snapshot } = setup()
    paint({
      ...snapshot,
      recent: [{ role: 'pet', text: 'Earlier.', at: '2026-10-27T01:00:00.000Z' }],
      unsaved: [
        { role: 'user', text: 'hello', at: '2026-10-27T02:00:00.000Z' },
        { role: 'pet', text: 'Gâu!', at: '2026-10-27T02:00:01.000Z' }
      ]
    })
    expect(shown('pet')).toEqual(['Earlier.', 'Gâu!'])
    expect(shown('user')).toEqual(['hello'])
  })

  it('keeps a failed message in the thread with a fixed line and Try again, never the backend error', async () => {
    const { bridge } = setup()
    vi.mocked(bridge.submit).mockRejectedValueOnce(new Error('private backend path'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Please try this' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    expect(shown('user')).toEqual(['Please try this'])
    expect(screen.getByRole('alert').textContent).toBe('Not sent.')
    expect(globalThis.document.body.textContent).not.toContain('private backend path')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
    expect(bridge.submit).toHaveBeenLastCalledWith('Please try this')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names a typed refusal in the pet voice', async () => {
    const { bridge } = setup()
    vi.mocked(bridge.submit).mockRejectedValueOnce(new Error('rate_limited'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    await act(async () => fireEvent.submit(screen.getByRole('textbox').closest('form')!))
    expect(screen.getByRole('alert').textContent).toBe('Gigi is dozing. Try again in a moment.')
  })

  it('keeps the fixed actions and pop-in behind one menu, with no target payload', async () => {
    const { bridge } = setup()
    expect(screen.queryByRole('menuitem', { name: 'Wave' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Wave' })))
    expect(bridge.menu).toHaveBeenCalledExactlyOnceWith('wave')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Back to Atum' })))
    expect(bridge.popIn).toHaveBeenCalledExactlyOnceWith()
  })

  it('closes the chat from its header and with Escape', async () => {
    const { bridge } = setup()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })))
    expect(bridge.menu).toHaveBeenLastCalledWith('chat')
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }))
    expect(bridge.menu).toHaveBeenCalledTimes(2)
  })

  it('clears a hidden draft and removes its listener on teardown', () => {
    const { paint, snapshot, unmount, unsubscribe } = setup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent private words' } })
    paint({ ...snapshot, chatOpen: false, bubble: { kind: 'done' } })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(globalThis.document.body.textContent).not.toContain('Unsent private words')
    paint()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    unmount()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith()
  })
})

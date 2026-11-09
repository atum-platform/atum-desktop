import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { petHitBox } from './hit-box'
import { PetActions, PetMenu } from './menu'

afterEach(cleanup)

it('shares every named action between the right-click menu and keyboard-accessible buttons', async () => {
  const run = vi.fn()

  const actions = ['Chat', 'Wave', 'Sit', 'Lounge', 'Change', 'Size', 'Hide', 'Store', 'Settings'].map(label => ({
    id: label,
    label,
    run
  }))

  render(
    <>
      <PetMenu actions={actions}>
        <div data-testid="sprite" />
      </PetMenu>
      <PetActions actions={actions} />
    </>
  )
  fireEvent.contextMenu(screen.getByTestId('sprite'), { button: 2, clientX: 20, clientY: 20 })

  for (const action of actions) {
    expect(screen.getByRole('menuitem', { name: action.label })).toBeTruthy()
  }

  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

  for (const action of actions) {
    const button = screen.getByRole('button', { name: action.label })
    button.focus()
    expect(window.document.activeElement).toBe(button)
  }

  fireEvent.click(screen.getByRole('button', { name: 'Wave' }))
  expect(run).toHaveBeenCalledOnce()
})

it('maps bounds and mirroring to only the current painted rectangle', () => {
  const info = {
    enabled: true,
    scale: 1,
    size: 1,
    frameW: 192,
    frameH: 208,
    bounds: { idle: { x: 30, y: 50, width: 100, height: 110 }, waving: { x: 20, y: 40, width: 120, height: 130 } }
  }

  expect(petHitBox(info, 'wave', 0.5)).toEqual({ left: 10, top: 20, width: 60, height: 65 })
  expect(petHitBox(info, 'wave', 0.5, true)).toEqual({ left: 26, top: 20, width: 60, height: 65 })
  expect(petHitBox(info, 'waiting', 0.5)).toEqual({ left: 15, top: 25, width: 50, height: 55 })
})


it('propagates disabled actions to both the menu and paw list', async () => {
  const run = vi.fn(); const actions = [{ id: 'chat', label: 'Chat', disabled: true, run }]
  render(<><PetMenu actions={actions}><div data-testid="sprite" /></PetMenu><PetActions actions={actions} /></>)
  fireEvent.contextMenu(screen.getByTestId('sprite'), { button: 2, clientX: 20, clientY: 20 })
  expect(screen.getByRole('menuitem').getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByRole('menuitem')); expect(run).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  const button = screen.getByRole('button'); expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button); expect(run).not.toHaveBeenCalled()
})

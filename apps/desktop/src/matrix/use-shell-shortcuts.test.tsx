import { cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $capture, endCapture, resetAllBindings, setBinding } from '@/store/keybinds'

import { useShellShortcuts } from './use-shell-shortcuts'

afterEach(() => {
  cleanup()
  window.document.body.replaceChildren()
  resetAllBindings()
  endCapture()
})

it('dispatches only supported actions through current shared bindings', () => {
  const run = vi.fn()
  renderHook(() => useShellShortcuts({ enabled: true, paletteOpen: false, handlers: { 'nav.settings': run } }))
  expect(fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })).toBe(false)
  expect(run).toHaveBeenCalledOnce()
  setBinding('nav.settings', ['mod+shift+s'])
  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  expect(run).toHaveBeenCalledOnce()
  fireEvent.keyDown(window, { key: 'S', code: 'KeyS', metaKey: true, shiftKey: true })
  expect(run).toHaveBeenCalledTimes(2)
  expect(fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })).toBe(true)
})

it('leaves editing, composition, repeats and local-owned combinations alone', () => {
  const run = vi.fn()
  renderHook(() => useShellShortcuts({ enabled: true, paletteOpen: false, handlers: { 'nav.settings': run } }))
  const input = window.document.createElement('input')
  window.document.body.append(input)
  input.dataset.localKeybinds = 'mod+,'
  fireEvent.keyDown(input, { key: ',', code: 'Comma', metaKey: true })
  input.removeAttribute('data-local-keybinds')
  fireEvent.keyDown(input, { key: ',', code: 'Comma', metaKey: true, isComposing: true })
  fireEvent.keyDown(input, { key: ',', code: 'Comma', metaKey: true, repeat: true })
  setBinding('nav.settings', ['s'])
  fireEvent.keyDown(input, { key: 's', code: 'KeyS' })
  expect(run).not.toHaveBeenCalled()
  setBinding('nav.settings', ['mod+,'])
  fireEvent.keyDown(input, { key: ',', code: 'Comma', metaKey: true })
  expect(run).toHaveBeenCalledOnce()
})

it('never acts through blockers, disabled state, binding capture or a handled event', () => {
  const run = vi.fn()

  const view = renderHook(
    ({ enabled }) => useShellShortcuts({ enabled, paletteOpen: false, handlers: { 'nav.settings': run } }),
    {
      initialProps: { enabled: false }
    }
  )

  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  view.rerender({ enabled: true })
  const dialog = window.document.createElement('section')
  dialog.setAttribute('role', 'dialog')
  window.document.body.append(dialog)
  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  dialog.hidden = true
  $capture.set('nav.settings')
  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  endCapture()
  const event = new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true, cancelable: true })
  event.preventDefault()
  window.dispatchEvent(event)
  expect(run).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  expect(run).toHaveBeenCalledOnce()
})

it('only allows its toggle while the palette owns focus and tears down on unmount', () => {
  const settings = vi.fn()
  const toggle = vi.fn()

  const view = renderHook(() =>
    useShellShortcuts({
      enabled: true,
      paletteOpen: true,
      handlers: { 'nav.settings': settings, 'nav.commandPalette': toggle }
    })
  )

  fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
  expect(settings).not.toHaveBeenCalled()
  expect(toggle).toHaveBeenCalledOnce()
  view.unmount()
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
  expect(toggle).toHaveBeenCalledOnce()
})

it('lets the company jump on ⌘⌥1 yield to a chord the user bound there themselves, and fires only one of them', () => {
  const company = vi.fn()
  const theirs = vi.fn()

  renderHook(() =>
    useShellShortcuts({
      enabled: true,
      paletteOpen: false,
      handlers: { 'nav.company.1': company, 'view.toggleReview': theirs }
    })
  )

  const chord = () => fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true, altKey: true })

  // Unbound by the user, the shipped company default runs.
  chord()
  expect(company).toHaveBeenCalledOnce()
  expect(theirs).not.toHaveBeenCalled()

  // The user binds the same chord to an action that sits later in the registry than the company jumps.
  setBinding('view.toggleReview', ['mod+alt+1'])
  chord()
  expect(theirs).toHaveBeenCalledOnce()
  expect(company).toHaveBeenCalledOnce()

  // Giving it back returns the chord to the company jump.
  setBinding('view.toggleReview', ['mod+g'])
  chord()
  expect(company).toHaveBeenCalledTimes(2)
  expect(theirs).toHaveBeenCalledOnce()
})

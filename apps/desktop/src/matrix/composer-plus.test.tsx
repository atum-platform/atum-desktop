import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type ComposerPlusAvailability,
  type ComposerPlusKind,
  composerPlusKinds,
  ComposerPlusMenu
} from './composer-plus'

afterEach(cleanup)

const ALL: ComposerPlusAvailability = { photos: true, files: true, routines: true, skills: true }

function openMenu(trigger = screen.getByRole('button', { name: 'Add' })) {
  // Radix's dropdown trigger opens on pointerdown, so fire the full mouse sequence.
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)

  return trigger
}

function renderMenu(availability: ComposerPlusAvailability = ALL, onAction = vi.fn()) {
  const view = render(<ComposerPlusMenu availability={availability} onAction={onAction} />)

  return { ...view, onAction }
}

describe('composerPlusKinds', () => {
  it('lists the four entries in the owner order, and only the ones that apply', () => {
    expect(composerPlusKinds(ALL)).toEqual(['photos', 'files', 'routines', 'skills'])
    expect(composerPlusKinds({ photos: true, files: true, routines: false, skills: false })).toEqual([
      'photos',
      'files'
    ])
    expect(composerPlusKinds({ photos: false, files: false, routines: true, skills: false })).toEqual(['routines'])
    expect(composerPlusKinds({ photos: false, files: false, routines: false, skills: false })).toEqual([])
  })
})

describe('the composer plus menu', () => {
  it('opens a short menu with the four entries, each with its own icon', async () => {
    renderMenu()
    openMenu()

    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')

    expect(items.map(item => item.textContent)).toEqual([
      'Photos and videos',
      'Files',
      'Set up a routine',
      'Add a skill'
    ])
    expect(items.every(item => item.querySelector('svg'))).toBe(true)
  })

  it.each([
    ['Photos and videos', 'photos'],
    ['Files', 'files'],
    ['Set up a routine', 'routines'],
    ['Add a skill', 'skills']
  ] satisfies [string, ComposerPlusKind][])('runs %s', async (label, kind) => {
    const { onAction } = renderMenu()
    openMenu()

    const item = within(await screen.findByRole('menu')).getByRole('menuitem', { name: label })
    fireEvent.pointerDown(item)
    fireEvent.pointerUp(item)
    fireEvent.click(item)

    expect(onAction).toHaveBeenCalledExactlyOnceWith(kind)
  })

  it('opens from the keyboard, moves with the arrow keys, and runs the focused entry on Enter', async () => {
    const { onAction } = renderMenu()
    const trigger = screen.getByRole('button', { name: 'Add' })

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })

    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(window.document.activeElement ?? menu, { key: 'Enter' })

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce())
    expect(['photos', 'files', 'routines', 'skills']).toContain(onAction.mock.calls[0]![0])
  })

  it('closes on Escape without running anything', async () => {
    const { onAction } = renderMenu()
    openMenu()

    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(onAction).not.toHaveBeenCalled()
  })

  it('hides the entries the chat does not have', async () => {
    renderMenu({ photos: true, files: true, routines: false, skills: true })
    openMenu()

    const labels = within(await screen.findByRole('menu'))
      .getAllByRole('menuitem')
      .map(item => item.textContent)

    expect(labels).toEqual(['Photos and videos', 'Files', 'Add a skill'])
  })

  it('is absent when nothing in this chat applies', () => {
    renderMenu({ photos: false, files: false, routines: false, skills: false })

    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })
})

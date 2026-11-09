import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $atumShellEnabled, $discoverShelf, $railDestination, type AtumDiscoverShelf, resetAtumShellState } from '@/store/atum-shell'

import { useOpenStorefront } from './use-open-storefront'

/**
 * The one opener into the storefront: rail + shelf intent first, navigation
 * second — and only when the current view is an overlay or a page, since from
 * chat or a DM the URL is already where Discover shows.
 */

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function Opener({ shelf }: { shelf: AtumDiscoverShelf }) {
  const openStorefront = useOpenStorefront()

  return <button data-testid="open" onClick={() => openStorefront(shelf)} type="button">open</button>
}

function renderOpener(path: string, shelf: AtumDiscoverShelf = 'pets') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Opener shelf={shelf} />
      <LocationProbe />
    </MemoryRouter>
  )

  fireEvent.click(screen.getByTestId('open'))
}

beforeEach(resetAtumShellState)
afterEach(() => {
  $atumShellEnabled.set(true)
  cleanup()
})

describe('useOpenStorefront', () => {
  it('sets the rail and seeds the shelf, then navigates out of an overlay', () => {
    renderOpener('/settings')

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('navigates out of a full page the same way', () => {
    renderOpener('/skills', 'skills')

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('skills')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('changes no URL from a chat route — the rail alone is the arrival', () => {
    renderOpener('/session-abc')

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.getByTestId('location').textContent).toBe('/session-abc')
  })

  it('changes no URL from a DM route either', () => {
    renderOpener('/dm/room-1')

    expect($railDestination.get()).toBe('discover')
    expect(screen.getByTestId('location').textContent).toBe('/dm/room-1')
  })

  it('keeps the seed planted while already on Discover — the rail-before-shelf ordering rule', () => {
    // Arriving at Discover reseeds Featured (the $railDestination.listen in
    // atum-shell.ts). If the hook seeded before flipping the rail, the seed
    // would be wiped; it must survive.
    $railDestination.set('discover')
    renderOpener('/')

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('seeds the shelf requested by the entry point, not always Pets', () => {
    renderOpener('/', 'people')

    expect($discoverShelf.get()).toBe('people')
  })

  it('runs beforeNavigate between the shell state and the navigation — a sheet closes over planted state, not over the storefront', () => {
    let currentPath = ''
    const seen: string[] = []

    function PathTracker() {
      currentPath = useLocation().pathname

      return null
    }

    function SheetOpener() {
      const openStorefront = useOpenStorefront()

      return (
        <button
          data-testid="open"
          onClick={() => openStorefront('pets', { beforeNavigate: () => seen.push(`${$railDestination.get()}@${currentPath}`) })}
          type="button"
        >
          open
        </button>
      )
    }

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SheetOpener />
        <PathTracker />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByTestId('open'))

    // The sheet's close saw the rail already flipped and the OLD path still
    // current: shell state first, close second, navigation last.
    expect(seen).toEqual(['discover@/settings'])
    expect($discoverShelf.get()).toBe('pets')
    expect(currentPath).toBe('/')
  })
})

describe('useOpenStorefront — legacy shell (Atum shell off)', () => {
  beforeEach(() => $atumShellEnabled.set(false))

  it.each(['/', '/session-abc', '/skills'])('falls back to the /pets page from %s — the legacy shell has no rail', path => {
    renderOpener(path)

    expect(screen.getByTestId('location').textContent).toBe('/pets')
    // The rail atom is meaningless without the shell; it must not move.
    expect($railDestination.get()).toBe('chat')
  })
})

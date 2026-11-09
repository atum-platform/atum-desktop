import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $atumShellEnabled, $discoverShelf, $railDestination, $workspaceOpen, resetAtumShellState } from '@/store/atum-shell'

import { PetsAppView } from './pets-deep-link'

/**
 * `/pets` is a one-shot deep link into the Discover storefront, never a
 * resting URL — and under the legacy shell it stays the Pet Store workspace
 * page it has always been (the rollback path).
 */

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

/** How the last navigation happened — REPLACE is the one-shot contract. */
function NavigationTypeProbe() {
  return <output data-testid="navigation-type">{useNavigationType()}</output>
}

function renderAtPets() {
  return render(
    <MemoryRouter initialEntries={['/pets']}>
      <Routes>
        <Route element={<div data-testid="chat-plate"><NavigationTypeProbe /></div>} path="/" />
        <Route element={<PetsAppView legacyPage={<div data-testid="pet-store-page" />} />} path="/pets" />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetAtumShellState()
  $atumShellEnabled.set(true)
})

afterEach(() => {
  cleanup()
  $atumShellEnabled.set(true)
})

describe('/pets as a one-shot deep link', () => {
  it('opens the storefront on the Pets shelf and never rests on /pets', () => {
    renderAtPets()

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(screen.getByTestId('chat-plate')).toBeTruthy()
    expect(screen.queryByTestId('pet-store-page')).toBeNull()
  })

  it('replaces the history entry rather than pushing, so Back never returns to /pets', () => {
    renderAtPets()

    expect(screen.getByTestId('navigation-type').textContent).toBe('REPLACE')
  })

  it('sets the shell state before the navigation — the ordering rule', () => {
    // If the rail and shelf were seeded after (or by) the navigation, the
    // arrival probe at `/` would read them still on their defaults.
    const arrivals: Array<{ path: string; rail: string; shelf: string }> = []

    function ArrivalProbe() {
      const { pathname } = useLocation()
      arrivals.push({ path: pathname, rail: $railDestination.get(), shelf: $discoverShelf.get() })

      return null
    }

    render(
      <MemoryRouter initialEntries={['/pets']}>
        <Routes>
          <Route element={<div data-testid="chat-plate" />} path="/" />
          <Route element={<PetsAppView legacyPage={<div data-testid="pet-store-page" />} />} path="/pets" />
        </Routes>
        <ArrivalProbe />
      </MemoryRouter>
    )

    const arrivalAtChat = arrivals.find(record => record.path === '/')

    expect(arrivalAtChat).toEqual({ path: '/', rail: 'discover', shelf: 'pets' })
  })

  it('lands somewhere visible from a closed workspace — the old nothing-happens case', () => {
    // With the workspace closed and the rail on chat, the old navigate('/pets')
    // rendered nothing at all. The deep link flips the rail, and Discover owns
    // the plate regardless of the workspace flag.
    $workspaceOpen.set(false)
    $railDestination.set('chat')

    renderAtPets()

    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })
})

describe('/pets under the legacy shell (rollback path)', () => {
  it('keeps rendering the Pet Store workspace page, untouched by the rail', () => {
    $atumShellEnabled.set(false)

    renderAtPets()

    expect(screen.getByTestId('pet-store-page')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/pets')
    expect($railDestination.get()).toBe('chat')
    expect($discoverShelf.get()).toBe('featured')
  })
})

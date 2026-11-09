import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $surfaces,
  activateSurfaceProfile,
  applySurfaceSource,
  DEFAULT_SURFACES,
  parseSurfaceSet,
  SURFACE_IDS,
  surfacesForProfile
} from './surfaces'

const entries = () => Object.values(DEFAULT_SURFACES).map(row => ({ ...row }))

beforeEach(() => {
  activateSurfaceProfile(null)
  localStorage.clear()
})
afterEach(() => activateSurfaceProfile(null))

describe('surface projection', () => {
  it('requires a reason for hidden, and accepts only platform exclusion or retirement', () => {
    for (const reason of [undefined, 'unlaunched', 'unknown']) {
      expect(
        parseSurfaceSet(entries().map(row => (row.id === 'drive' ? { ...row, state: 'hidden', reason } : row)))
      ).toBeNull()
    }

    for (const reason of ['not_for_platform', 'retired']) {
      expect(
        parseSurfaceSet(entries().map(row => (row.id === 'drive' ? { ...row, state: 'hidden', reason } : row)))?.drive
          .reason
      ).toBe(reason)
    }
  })

  it('refuses empty, incomplete, duplicate and invalid source sets without losing the rail', () => {
    activateSurfaceProfile('profile-a')
    applySurfaceSource(
      'profile-a',
      entries().map(row => ({ ...row, state: 'on' }))
    )
    const good = $surfaces.get()

    for (const value of [
      null,
      [],
      entries().slice(1),
      [...entries().slice(0, 3), entries()[0]],
      entries().map(row => ({ ...row, state: 'invalid' })),
      entries().map(row => ({ ...row, state: 'hidden', reason: 'retired' }))
    ]) {
      expect(applySurfaceSource('profile-a', value)).toBe(false)
      expect($surfaces.get()).toBe(good)
    }

    expect(Object.keys(good.places)).toEqual(SURFACE_IDS)
  })

  it('restores the last good set per profile and refuses late results from another one', () => {
    activateSurfaceProfile('profile-a')
    applySurfaceSource(
      'profile-a',
      entries().map(row => ({ ...row, state: 'on' }))
    )
    activateSurfaceProfile('profile-b')
    expect(surfacesForProfile('profile-b').drive.state).toBe('on')
    expect(surfacesForProfile('profile-a')).toBe(DEFAULT_SURFACES)
    const b = $surfaces.get()
    expect(applySurfaceSource('profile-a', entries())).toBe(false)
    expect($surfaces.get()).toBe(b)
    activateSurfaceProfile('profile-a')
    expect($surfaces.get().places.drive.state).toBe('on')
    expect($surfaces.get().places.teamSpace.state).toBe('on')
  })

  it('stays usable when storage reads or writes throw, without erasing current truth', () => {
    const cache = {
      getItem: vi.fn(() => {
        throw new Error('read refused')
      }),
      setItem: vi.fn(() => {
        throw new Error('quota')
      })
    }

    activateSurfaceProfile('profile-a', cache)
    expect($surfaces.get().places).toBe(DEFAULT_SURFACES)
    expect(
      applySurfaceSource(
        'profile-a',
        entries().map(row => ({ ...row, state: 'on' }))
      )
    ).toBe(true)
    expect($surfaces.get().places.drive.state).toBe('on')
    activateSurfaceProfile('profile-a', cache)
    expect($surfaces.get().places.drive.state).toBe('on')
    expect(cache.getItem).toHaveBeenCalledOnce()
    expect(cache.setItem).toHaveBeenCalledOnce()
  })

  it('preserves reference identity on no-ops and does not retain mutable source objects', () => {
    activateSurfaceProfile('profile-a')
    const value = entries().map(row => ({ ...row, state: 'on' }))
    applySurfaceSource('profile-a', value)
    const good = $surfaces.get()
    applySurfaceSource('profile-a', value)
    expect($surfaces.get()).toBe(good)
    value[1].state = 'hidden'
    expect(good.places.drive.state).toBe('on')
  })
})

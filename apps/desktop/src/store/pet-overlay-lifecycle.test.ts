import { beforeEach, describe, expect, it, vi } from 'vitest'

import { $petInfoByAgent, setPetInfo, syncActivePetViews } from './pet'
import { $petOverlayAgents, popOutPet } from './pet-overlay'
import { $activeGatewayProfile } from './profile'

/**
 * An overlay window has to close itself when its pet is turned off.
 *
 * The window is transparent, always-on-top, and click-through everywhere the
 * sprite is not — so an overlay with nothing to draw is not "an empty window",
 * it is a window the user cannot see, find, or close. Every path that can
 * disable a pet (Settings, the account menu, either context menu, `/pet`) has to
 * take the window with it, which is why the rule lives on the state change
 * rather than at the call sites.
 */

const GIGI = { displayName: 'Gigi', enabled: true, scale: 0.33, slug: 'gigi' }
const RECT = { height: 70, width: 64, x: 24, y: 400 }

const petOverlay = {
  close: vi.fn(() => Promise.resolve()),
  open: vi.fn(() => Promise.resolve({ bounds: RECT })),
  onControl: vi.fn(() => () => {}),
  pushState: vi.fn(),
  setBounds: vi.fn(),
  setFocusable: vi.fn()
}

beforeEach(() => {
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { petOverlay }
  // Clearing the pet atoms is itself a "pet turned off" for anything the last
  // test left open, so it closes those overlays — which is the rule working, not
  // a call this test made. Reset the spies afterwards so each case counts only
  // its own.
  $petInfoByAgent.set({})
  $activeGatewayProfile.set('default')
  syncActivePetViews()
  $petOverlayAgents.set([])
  vi.clearAllMocks()
})

describe('an overlay whose pet is turned off', () => {
  it('closes itself, so no invisible window is left behind', () => {
    setPetInfo(GIGI, 'default')
    popOutPet(RECT, 'default')
    expect($petOverlayAgents.get()).toEqual(['default'])

    setPetInfo({ ...GIGI, enabled: false }, 'default')

    expect($petOverlayAgents.get()).toEqual([])
    expect(petOverlay.close).toHaveBeenCalledWith('default')
  })

  it('takes only its own pet with it', () => {
    setPetInfo(GIGI, 'default')
    setPetInfo(GIGI, 'researcher')
    popOutPet(RECT, 'default')
    popOutPet(RECT, 'researcher')

    setPetInfo({ ...GIGI, enabled: false }, 'researcher')

    expect($petOverlayAgents.get()).toEqual(['default'])
  })

  it('stays open through a boot where the pet has not loaded yet', () => {
    // `restorePetOverlay` deliberately opens windows for agents whose info has
    // never been fetched, and `petInfoFor` reports those as disabled. Reading
    // that as "turned off" would close every restored overlay before its sprite
    // could arrive.
    popOutPet(RECT, 'default')
    expect($petOverlayAgents.get()).toEqual(['default'])

    // Unrelated state churn while the pet is still loading.
    setPetInfo({ enabled: false }, 'someone-else')

    expect($petOverlayAgents.get()).toEqual(['default'])
    expect(petOverlay.close).not.toHaveBeenCalled()

    // ...and it survives right up until its own pet actually arrives.
    setPetInfo(GIGI, 'default')
    expect($petOverlayAgents.get()).toEqual(['default'])
  })
})

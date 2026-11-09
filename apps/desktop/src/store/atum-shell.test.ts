import { beforeEach, describe, expect, it } from 'vitest'

import {
  $atumMaterialMode,
  $discoverShelf,
  $railDestination,
  $rosterShownOnDiscover,
  $rosterWidth,
  $sidebarOpen,
  $workspaceExpanded,
  $workspaceOpen,
  $workspacePercent,
  ATUM_RAIL_COLLAPSED_WIDTH,
  ATUM_RAIL_WIDTH,
  ATUM_ROSTER_MAX_WIDTH,
  ATUM_ROSTER_MIN_WIDTH,
  ATUM_ROSTER_WIDTH,
  ATUM_WORKSPACE_DEFAULT_PERCENT,
  ATUM_WORKSPACE_MAX_PERCENT,
  ATUM_WORKSPACE_MIN_PERCENT,
  clampRosterWidth,
  clampWorkspacePercent,
  resetAtumShellState,
  setDiscoverShelf,
  setRosterWidth,
  setSidebarOpen,
  setWorkspaceExpanded,
  setWorkspaceOpen,
  setWorkspacePercent,
} from './atum-shell'

beforeEach(resetAtumShellState)

describe('clampWorkspacePercent', () => {
  it('holds a requested split inside the supported range', () => {
    expect(clampWorkspacePercent(48)).toBe(48)
  })

  it('clamps to the documented bounds', () => {
    expect(clampWorkspacePercent(1)).toBe(ATUM_WORKSPACE_MIN_PERCENT)
    expect(clampWorkspacePercent(99)).toBe(ATUM_WORKSPACE_MAX_PERCENT)
  })

  it('falls back to the SPEC §2 50% panel split for a non-finite value', () => {
    expect(clampWorkspacePercent(Number.NaN)).toBe(ATUM_WORKSPACE_DEFAULT_PERCENT)
    expect(ATUM_WORKSPACE_DEFAULT_PERCENT).toBe(50)
  })
})

describe('workspace split persistence', () => {
  it('stores the user intent clamped by the proportional bounds', () => {
    setWorkspacePercent(9000)
    expect($workspacePercent.get()).toBe(ATUM_WORKSPACE_MAX_PERCENT)

    setWorkspacePercent(10)
    expect($workspacePercent.get()).toBe(ATUM_WORKSPACE_MIN_PERCENT)
  })

  it('writes through to the V2 key so old pixel preferences cannot defeat the equal default', () => {
    setWorkspacePercent(56)
    expect(localStorage.getItem('hermes.desktop.atum.workspacePercentV2')).toBe('56')
  })
})

describe('edge panel defaults', () => {
  it('uses the approved shell geometry', () => {
    // The sidebar is a same-level column now: no gutter constant exists.
    expect(ATUM_RAIL_WIDTH).toBe(58)
    expect(ATUM_ROSTER_WIDTH).toBe(268)
    // Collapsing narrows the rail rather than removing it; 44px still holds the
    // 32px controls and the 30px account tile.
    expect(ATUM_RAIL_COLLAPSED_WIDTH).toBe(44)
  })

  it('clamps a dragged roster width and persists it absolute', () => {
    expect(clampRosterWidth(300)).toBe(300)
    expect(clampRosterWidth(10)).toBe(ATUM_ROSTER_MIN_WIDTH)
    expect(clampRosterWidth(9_000)).toBe(ATUM_ROSTER_MAX_WIDTH)
    expect(clampRosterWidth(Number.NaN)).toBe(ATUM_ROSTER_WIDTH)

    setRosterWidth(312)
    expect($rosterWidth.get()).toBe(312)
    expect(localStorage.getItem('hermes.desktop.atum.rosterWidth')).toBe('312')

    // Out-of-range drags land on the bound, never past it.
    setRosterWidth(ATUM_ROSTER_MAX_WIDTH + 200)
    expect($rosterWidth.get()).toBe(ATUM_ROSTER_MAX_WIDTH)
  })

  it('makes floating glass the official default while retaining the solid recovery seam', () => {
    expect($atumMaterialMode.get()).toBe('floating-glass')

    $atumMaterialMode.set('legacy-solid')
    expect(localStorage.getItem('hermes.desktop.atum.material')).toBe('legacy-solid')
  })

  it('keeps the sidebar open and starts a sub-1024 workspace closed', () => {
    expect($sidebarOpen.get()).toBe(true)
    expect($workspaceOpen.get()).toBe(window.innerWidth >= 1024)
  })

  it('persists explicit collapses independently', () => {
    setSidebarOpen(false)
    setWorkspaceOpen(false)

    expect($sidebarOpen.get()).toBe(false)
    expect($workspaceOpen.get()).toBe(false)
    expect(localStorage.getItem('hermes.desktop.atum.sidebarOpen')).toBe('false')
    expect(localStorage.getItem('hermes.desktop.atum.workspaceOpenV3')).toBe('false')
  })
})

describe('full-frame workspace', () => {
  it('starts in the split and remembers an expansion the person asked for', () => {
    expect($workspaceExpanded.get()).toBe(false)

    setWorkspaceExpanded(true)

    expect($workspaceExpanded.get()).toBe(true)
    expect(localStorage.getItem('hermes.desktop.atum.workspaceExpanded')).toBe('true')
  })

  it('is a mode, not a drag: the split the person sized is waiting when they come back', () => {
    setWorkspacePercent(62)

    setWorkspaceExpanded(true)
    setWorkspaceExpanded(false)

    expect($workspacePercent.get()).toBe(62)
  })

  it('drops back to the split when the panel is closed, so reopening never swallows the window', () => {
    setWorkspaceExpanded(true)

    setWorkspaceOpen(false)

    expect($workspaceExpanded.get()).toBe(false)

    setWorkspaceOpen(true)

    expect($workspaceExpanded.get()).toBe(false)
  })
})


describe('Discover arrival state', () => {
  it('reseeds Featured on every arrival at Discover, and collapses the roster again', () => {
    $rosterShownOnDiscover.set(true)
    setDiscoverShelf('pets')

    $railDestination.set('discover')

    expect($rosterShownOnDiscover.get()).toBe(false)
    expect($discoverShelf.get()).toBe('featured')
  })

  it('keeps a seed planted after the rail flip — the ordering rule the opener relies on', () => {
    $railDestination.set('discover')
    setDiscoverShelf('pets')

    // Setting the rail to the destination it already holds is a no-op, so a
    // shelf seeded while Discover is showing (the Pets strip's button) is not
    // wiped by a redundant rail write.
    $railDestination.set('discover')

    expect($discoverShelf.get()).toBe('pets')
  })

  it('is restored by the shell reset, roster flag included', () => {
    $rosterShownOnDiscover.set(true)
    $discoverShelf.set('people')

    resetAtumShellState()

    expect($rosterShownOnDiscover.get()).toBe(false)
    expect($discoverShelf.get()).toBe('featured')
    expect($railDestination.get()).toBe('chat')
  })
})

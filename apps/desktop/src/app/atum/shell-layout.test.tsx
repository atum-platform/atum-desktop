import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  $discoverShelf,
  $railDestination,
  $rosterDrawerOpen,
  $rosterShownOnDiscover,
  $sidebarOpen,
  $workspaceExpanded,
  $workspaceOpen,
  resetAtumShellState,
  setDiscoverShelf
} from '@/store/atum-shell'
import { $nativeApps } from '@/store/native-apps'
import { $wordCompanionError, $wordCompanionOpening, resetWordCompanionForTests } from '@/store/word-companion'

import { useAtumShellLayout } from './shell-layout'

const viewport = vi.hoisted(() => ({ compact: false }))
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => viewport.compact }))

beforeEach(() => {
  resetAtumShellState()
  resetWordCompanionForTests()
  $nativeApps.set({ apps: [], loading: false, error: null, result: null, scopeKey: '' })
  viewport.compact = false
  $sidebarOpen.set(true)
  $workspaceOpen.set(true)
})

it('temporarily hides shell columns while beside a native app and restores preferences on exit', () => {
  $nativeApps.set({ ...$nativeApps.get(), result: { id: 'pair', status: 'beside', app: { id: 'app', name: 'Test app', bundleId: 'test.app' } } })
  const { result } = renderHook(useAtumShellLayout)
  expect(result.current.workspaceOpen).toBe(false)
  expect(result.current.sidebarShowing).toBe(false)
  expect($workspaceOpen.get()).toBe(true)
  expect($sidebarOpen.get()).toBe(true)
  act(() => result.current.toggleSidebar())
  expect($nativeApps.get().result).toBeNull()
  expect(result.current.workspaceOpen).toBe(true)
  expect(result.current.sidebarShowing).toBe(true)
})
afterEach(() => {cleanup(); resetWordCompanionForTests()})

it('keeps the file workspace visible after a Word open fails', () => {
  $workspaceExpanded.set(true)
  $wordCompanionError.set('WORD_AUTOMATION_DENIED')
  const { result } = renderHook(useAtumShellLayout)
  expect(result.current.workspaceFullFrame).toBe(true)
  expect(result.current.workspaceSuppressed).toBe(false)
  expect($workspaceOpen.get()).toBe(true)
})

it('keeps the conversation roster reachable in the narrow companion window', () => {
  viewport.compact = true
  $wordCompanionOpening.set(true)
  const { result } = renderHook(useAtumShellLayout)
  expect(result.current.workspaceOpen).toBe(false)
  expect(result.current.sidebarShowing).toBe(false)
  act(() => result.current.toggleSidebar())
  expect($rosterDrawerOpen.get()).toBe(true)
  expect(result.current.sidebarShowing).toBe(true)
  expect($wordCompanionOpening.get()).toBe(true)
  expect($workspaceOpen.get()).toBe(true)
  expect($sidebarOpen.get()).toBe(true)
})

it('resets the Discover arrival state — the roster collapse and the shelf intent — on every arrival', () => {
  $rosterShownOnDiscover.set(true)
  setDiscoverShelf('pets')

  act(() => $railDestination.set('discover'))

  // The next plain visit collapses again and opens on Featured; a seeded shelf
  // survives only when it is planted after the rail flip (the opener's rule).
  expect($rosterShownOnDiscover.get()).toBe(false)
  expect($discoverShelf.get()).toBe('featured')

  act(() => {
    $rosterShownOnDiscover.set(true)
    $railDestination.set('chat')
    $railDestination.set('discover')
  })
  expect($rosterShownOnDiscover.get()).toBe(false)
  expect($discoverShelf.get()).toBe('featured')
})

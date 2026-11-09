import { afterEach, expect, test, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'

import type { AtumUpdateStatus } from '../../shared/atum-update-flow'

import { $atumUpdate, $atumUpdateBusy, installAtumUpdates } from './atum-updates'
import { $backgroundStatusBySession } from './composer-status'
import { $sessionStates } from './session-states'

afterEach(() => { $sessionStates.set({}); $backgroundStatusBySession.set({}) })

test('a new unsaved turn and runtime-only background work both prevent restart', () => {
  expect($atumUpdateBusy.get()).toBe(false)
  const state = { ...createClientSessionState(null), busy: true }
  $sessionStates.set({ runtime: state })
  expect($atumUpdateBusy.get()).toBe(true)
  $sessionStates.set({ runtime: { ...state, busy: false } })
  expect($atumUpdateBusy.get()).toBe(false)
  $backgroundStatusBySession.set({ runtime: [{ id: 'process', state: 'running', title: 'Fixture', type: 'background' }] })
  expect($atumUpdateBusy.get()).toBe(true)
  $backgroundStatusBySession.set({})
  expect($atumUpdateBusy.get()).toBe(false)
})

test('bootstrap loads updater status, receives native readiness and reports local activity', async () => {
  const idle: AtumUpdateStatus = {
    armed: true, packaged: true, channel: 'latest', state: 'idle', version: null,
    checkedAt: null, progress: null, notes: [], error: null, requiredBelow: null
  }
  const setBusy = vi.fn()
  const onState = vi.fn<(listener: (status: AtumUpdateStatus) => void) => void>()

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { appUpdate: { status: vi.fn().mockResolvedValue(idle), onState, setBusy } }
  })
  installAtumUpdates()
  await Promise.resolve()
  expect($atumUpdate.get()).toEqual(idle)
  expect(setBusy).toHaveBeenLastCalledWith(false)

  const ready: AtumUpdateStatus = { ...idle, state: 'downloaded', version: '0.18.0' }
  onState.mock.calls[0][0](ready)
  expect($atumUpdate.get()).toEqual(ready)

  $sessionStates.set({ runtime: { ...createClientSessionState(null), busy: true } })
  expect(setBusy).toHaveBeenLastCalledWith(true)
  $sessionStates.set({})
  expect(setBusy).toHaveBeenLastCalledWith(false)
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_CHANNELS } from '../../shared/matrix'
import { MATRIX_PET_DISPLAY_ACTION } from '../../shared/matrix-pet-display'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), on: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

import { createMatrixPetDisplayBridge } from './pet-display-preload'

beforeEach(() => vi.clearAllMocks())

describe('trusted pet display controls', () => {
  it('routes only the three named requests through the ordinary trusted UI boundary', async () => {
    const bridge = createMatrixPetDisplayBridge()
    const target = { scope: 'account:1', agent: 'agent-a' }
    await bridge.popOut(target)
    await bridge.readPreferences()
    await bridge.writePreferences({ showReplyExcerpt: true })
    expect(ipc.invoke.mock.calls).toEqual([
      [MATRIX_CHANNELS.ui, { kind: 'petPopOut', target }],
      [MATRIX_CHANNELS.ui, { kind: 'petDisplayRead' }],
      [MATRIX_CHANNELS.ui, { kind: 'petDisplayWrite', value: { showReplyExcerpt: true } }]
    ])
  })

  it('holds one request until its exact keyed component consumes it, then never replays it', () => {
    const bridge = createMatrixPetDisplayBridge()
    expect(ipc.on.mock.calls[0]![0]).toBe(MATRIX_PET_DISPLAY_ACTION)
    const request = { target: { scope: 'account:1', agent: 'agent-a' }, action: 'size' }
    ipc.on.mock.calls[0]![1]({}, request)
    const foreign = vi.fn(() => false)
    bridge.onAction(foreign)
    const matched = vi.fn(() => true)
    const unsubscribe = bridge.onAction(matched)
    expect(matched).toHaveBeenCalledExactlyOnceWith(request)
    unsubscribe()
    const remounted = vi.fn(() => true)
    bridge.onAction(remounted)
    expect(remounted).not.toHaveBeenCalled()
  })
})

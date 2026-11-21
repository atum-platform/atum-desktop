import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { $work, $workActive, $workBandOpen, connectWorkBridge, resetWorkStoreForTests, setWorkActive, workOnRail } from './store'

const READY: MatrixWorkProjection = { view: 'ready', assistants: 'on', agents: [], protons: 'ok' }

function bridge(read: () => Promise<MatrixWorkProjection | null>) {
  let listener: ((projection: MatrixWorkProjection | null) => void) | undefined
  const unsubscribe = vi.fn()

  const value = {
    read: vi.fn(read),
    subscribe: vi.fn((next: (projection: MatrixWorkProjection | null) => void) => {
      listener = next

      return unsubscribe
    })
  } as unknown as MatrixWorkBridge

  return { value, unsubscribe, emit: (projection: MatrixWorkProjection | null) => listener?.(projection) }
}

afterEach(() => resetWorkStoreForTests())

describe('the Work store', () => {
  it('has no Work, and so no rail entry, without a bridge', () => {
    connectWorkBridge(undefined)

    expect($work.get()).toBeNull()
    expect(workOnRail($work.get())).toBe(false)
  })

  it('treats a read that fails as no Work on this build', async () => {
    connectWorkBridge(bridge(async () => Promise.reject(new Error('No handler registered'))).value)
    await vi.waitFor(() => expect($work.get()).toBeNull())
  })

  it('follows main and stops following on disconnect', async () => {
    const work = bridge(async () => READY)
    const disconnect = connectWorkBridge(work.value)

    await vi.waitFor(() => expect($work.get()).toEqual(READY))
    expect(workOnRail($work.get())).toBe(true)
    work.emit({ ...READY, assistants: 'off' })
    expect($work.get()?.assistants).toBe('off')

    disconnect()
    expect(work.unsubscribe).toHaveBeenCalled()
    work.emit(null)
    expect($work.get()?.assistants).toBe('off')
  })

  it('closes the band when the page closes', () => {
    setWorkActive(true)
    $workBandOpen.set(true)
    setWorkActive(false)

    expect($workActive.get()).toBe(false)
    expect($workBandOpen.get()).toBe(false)
  })
})

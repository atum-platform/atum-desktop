import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $surfaces,
  activateSurfaceProfile,
  applySurfaceSource,
  DEFAULT_SURFACES,
  parseSurfaceSet
} from '@/store/surfaces'

import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

import {
  attachLocalSurfaceSource,
  localSurfaceEntries,
  type LocalSurfaceFacts,
  surfaceProfile
} from './surface-sources'

const flags = { apps: false, companyWorkspace: false }
// Every place this build can open: the shipped public config with its native bridges.
const all = { apps: true, companyWorkspace: true }
const facts: LocalSurfaceFacts = { ...all, companyBridge: true, driveBridge: true, drive: { state: 'ready' } }

const view = (revision: number, state: MatrixDriveView['state'] = 'ready'): MatrixDriveView => ({
  revision,
  state,
  rows: [],
  canGoBack: false,
  truncated: false
})

beforeEach(() => {
  activateSurfaceProfile(null)
  localStorage.clear()
  activateSurfaceProfile('a')
})
afterEach(() => activateSurfaceProfile(null))

describe('local surface source', () => {
  it('hides a place this build cannot open instead of drawing it disabled', () => {
    const unavailable = parseSurfaceSet(localSurfaceEntries({ ...flags, companyBridge: false, driveBridge: false }))!

    // Never "Coming soon" or "Update required": a launch shows places that open, or nothing.
    for (const id of ['discover', 'teamSpace'] as const) {
      expect(unavailable[id], id).toMatchObject({ state: 'hidden', reason: 'not_for_platform' })
    }

    expect(unavailable.home.state).toBe('on')
    expect(unavailable.drive.state).toBe('on')

    // A company workspace the window has no bridge for is hidden too, never "needs update".
    const noBridge = parseSurfaceSet(localSurfaceEntries({ ...facts, companyBridge: false }))!
    expect(noBridge.teamSpace.state).toBe('hidden')
    expect(noBridge.discover.state).toBe('on')

    const enabled = parseSurfaceSet(localSurfaceEntries(facts))!
    expect(enabled.discover.state).toBe('on')
    expect(enabled.teamSpace.state).toBe('on')
    expect(enabled.drive.state).toBe('on')
  })

  it('never produces a placeholder state, whatever the facts', () => {
    for (const apps of [true, false]) {
      for (const companyWorkspace of [true, false]) {
        for (const companyBridge of [true, false]) {
          for (const driveBridge of [true, false]) {
            for (const state of ['unavailable', 'disconnected', 'ready', 'reauthenticate', 'error'] as const) {
              const states = localSurfaceEntries({
                apps,
                companyWorkspace,
                companyBridge,
                driveBridge,
                drive: { state }
              }).map(row => row.state)

              expect(states).not.toContain('coming_soon')
              expect(states).not.toContain('needs_update')
            }
          }
        }
      }
    }
  })

  it('keeps Drive accessible in every state, including an unavailable engine', () => {
    for (const state of [
      'ready',
      'offline',
      'error',
      'connecting',
      'paused',
      'disconnected',
      'reauthenticate',
      'unavailable'
    ] as const) {
      expect(parseSurfaceSet(localSurfaceEntries({ ...facts, drive: { state } }))!.drive.state).toBe('on')
    }

    expect(localSurfaceEntries(facts).every(row => row.state !== 'hidden')).toBe(true)
  })

  it('does not replace the good set on a native read failure', async () => {
    applySurfaceSource(
      'a',
      Object.values(DEFAULT_SURFACES).map(row => ({ ...row, state: 'on' }))
    )
    const good = $surfaces.get()

    const drive = {
      read: vi.fn(async () => {
        throw new Error('offline')
      }),
      subscribe: vi.fn(() => () => {})
    } as unknown as MatrixDriveBridge

    const stop = attachLocalSurfaceSource('a', flags, { drive })
    await Promise.resolve()
    await Promise.resolve()
    expect($surfaces.get()).toBe(good)
    stop()
  })

  it('retains the cache when the native subscription or read throws synchronously', async () => {
    applySurfaceSource(
      'a',
      Object.values(DEFAULT_SURFACES).map(row => ({ ...row, state: 'on' }))
    )
    const good = $surfaces.get()

    for (const subscriptionFails of [true, false]) {
      const drive = {
        read: () => {
          throw new Error('bridge closed')
        },
        subscribe: () => {
          if (subscriptionFails) {
            throw new Error('bridge closed')
          }

          return () => {}
        }
      } as unknown as MatrixDriveBridge

      const stop = attachLocalSurfaceSource('a', flags, { drive })
      await Promise.resolve()
      expect($surfaces.get()).toBe(good)
      stop()
    }
  })

  it('fences delayed reads, native revisions, cleanup and another account', async () => {
    let resolve!: (value: MatrixDriveView) => void
    let receive!: (value: MatrixDriveView) => void
    const unsubscribe = vi.fn()

    const drive = {
      read: () =>
        new Promise<MatrixDriveView>(done => {
          resolve = done
        }),
      subscribe: (callback: typeof receive) => {
        receive = callback

        return unsubscribe
      }
    } as unknown as MatrixDriveBridge

    const stop = attachLocalSurfaceSource('a', flags, { drive })
    receive(view(2))
    resolve(view(1, 'unavailable'))
    await Promise.resolve()
    expect($surfaces.get().places.drive.state).toBe('on')
    activateSurfaceProfile('b')
    const b = $surfaces.get()
    receive(view(3, 'disconnected'))
    expect($surfaces.get()).toBe(b)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
    activateSurfaceProfile('a')
    receive(view(4, 'unavailable'))
    expect($surfaces.get().places.drive.state).toBe('on')
  })

  it('keys cache by stable local profile identity, not the changing native generation', () => {
    const snapshot = {
      identity: { userId: '@a:example.test', deviceId: 'D' },
      state: 'ready' as const,
      homeserver: 'https://example.test'
    }

    const a = surfaceProfile(snapshot)
    expect(surfaceProfile({ ...snapshot, petScope: 'generation-2' })).toBe(a)
    expect(surfaceProfile({ ...snapshot, identity: { ...snapshot.identity, deviceId: 'OTHER' } })).not.toBe(a)
    expect(surfaceProfile({ ...snapshot, identity: null })).toBeNull()
  })
})

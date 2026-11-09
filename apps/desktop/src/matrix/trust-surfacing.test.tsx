import { EventEmitter } from 'node:events'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { MatrixClient } from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { MatrixUnverifiedDevices } from '../../electron/matrix/unverified-devices'
import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixOwnDevices } from '../../shared/matrix-security'

import { MatrixAttentionIndicator } from './attention-indicator'
import { matrixSecurity, recoveryKeyCache } from './security'

const stops: Array<() => void> = []

afterEach(() => {
  cleanup()
  stops.splice(0).forEach(stop => stop())
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

// 0.20: the tracker still learns the person's unsigned devices from real DevicesUpdated events (an
// assistant's refusal in an encrypted room made before starts a comparison from it), but the
// window, drawn from what main publishes, never raises a reminder for them.
it('tracks real DevicesUpdated events for refusals and raises no reminder in the window', async () => {
  const owner = '@owner:test'
  const client = new EventEmitter()
  let signed = false
  let visible = false

  const readDevices = vi.fn(
    async () =>
      new Map([[owner, visible ? new Map([['PHONE', { deviceId: 'PHONE', displayName: 'iPhone' }]]) : new Map()]])
  )

  const crypto = {
    getUserDeviceInfo: readDevices,
    getUserVerificationStatus: async () => ({ isCrossSigningVerified: () => true }),
    getDeviceVerificationStatus: async () => ({ signedByOwner: signed, crossSigningVerified: signed })
  }

  Object.assign(client, {
    getCrypto: () => crypto,
    getUserId: () => owner,
    getDeviceId: () => 'MAC',
    getDevices: async () => ({ devices: [{ device_id: 'PHONE', display_name: 'iPhone', last_seen_ts: Date.now() }] }),
    getAccountData: () => undefined,
    isInitialSyncComplete: () => false
  })

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )

  const base: MatrixSnapshot = {
    state: 'ready',
    identity: { userId: owner, deviceId: 'MAC' },
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    agents: []
  }

  const draw = (snapshot: MatrixSnapshot) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAttentionIndicator agentName={() => 'Atum'} onOpen={vi.fn()} snapshot={snapshot} />
    </I18nProvider>
  )

  const view = render(draw({ ...base, state: 'signed_out', identity: null }))

  let security: ReturnType<typeof matrixSecurity> | undefined

  const tracker = new MatrixUnverifiedDevices({
    read: async () => (await security!.nativeCommand({ kind: 'ownDevices' })) as MatrixOwnDevices,
    changed: () => view.rerender(draw({ ...base, security: security!.snapshot() }))
  })

  security = matrixSecurity(client as unknown as MatrixClient, recoveryKeyCache(), () => {
    if (security) {
      tracker.observe(client, security.snapshot(), true)
    }
  })

  stops.push(() => {
    tracker.clear()
    security!.stop()
  })
  tracker.observe(client, security.snapshot(), false)
  expect(readDevices).not.toHaveBeenCalled()
  // First ready sign-in discovers the phone without a denied invocation or a poll.
  visible = true
  await act(async () => tracker.observe(client, security.snapshot(), true))
  await waitFor(() => expect(tracker.view(client)?.map(device => device.deviceId)).toEqual(['PHONE']))
  expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull()
  const reads = readDevices.mock.calls.length
  await act(async () => {
    client.emit(CryptoEvent.DevicesUpdated, ['@someone-else:test'])
  })
  expect(readDevices).toHaveBeenCalledTimes(reads)

  // A trusted signature arrives through the actual security event handler.
  signed = true
  await act(async () => {
    client.emit(CryptoEvent.DevicesUpdated, [owner])
  })
  await waitFor(() => expect(tracker.view(client)).toBeUndefined())
  expect(readDevices).toHaveBeenCalledTimes(reads + 1)

  // A fresh unsigned device returns the row; stale activity removes it.
  signed = false
  await act(async () => {
    client.emit(CryptoEvent.DevicesUpdated, [owner])
  })
  await waitFor(() => expect(tracker.view(client)?.map(device => device.deviceId)).toEqual(['PHONE']))
  expect(screen.queryByRole('button', { name: /Needs you/ })).toBeNull()
  Object.assign(client, {
    getDevices: async () => ({ devices: [{ device_id: 'PHONE', last_seen_ts: Date.now() - 15 * 24 * 60 * 60_000 }] })
  })
  await act(async () => {
    client.emit(CryptoEvent.DevicesUpdated, [owner])
  })
  await waitFor(() => expect(tracker.view(client)).toBeUndefined())
})

import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

vi.mock('@matrix-org/matrix-sdk-crypto-wasm', () => ({
  UserId: class {
    constructor(readonly id: string) {}
  }
}))
import { loadDeviceForVerification, loadIdentityForVerification } from './sdk-device-verification'

it('keeps verification of a known device on the public crypto path', async () => {
  const crypto = { getDeviceVerificationStatus: vi.fn().mockResolvedValue({ localVerified: false }) }
  await loadDeviceForVerification(crypto as unknown as CryptoApi, '@known:test', 'KNOWN')
  expect(crypto.getDeviceVerificationStatus).toHaveBeenCalledWith('@known:test', 'KNOWN')
})

it('loads first-contact keys into Rust before the caller compares and grants trust', async () => {
  const request = { id: 'owned-key-query' }
  const queryKeysForUsers = vi.fn().mockReturnValue(request)
  const makeOutgoingRequest = vi.fn().mockResolvedValue(undefined)

  const crypto = {
    getDeviceVerificationStatus: vi.fn().mockResolvedValue(null),
    getOlmMachineOrThrow: () => ({ queryKeysForUsers }),
    outgoingRequestProcessor: { makeOutgoingRequest }
  }

  await loadDeviceForVerification(crypto as unknown as CryptoApi, '@first-contact:test', 'NEW')
  expect(queryKeysForUsers.mock.calls[0][0][0].id).toBe('@first-contact:test')
  expect(makeOutgoingRequest).toHaveBeenCalledWith(request)
})

it('tracks and imports a first-contact identity with separately owned UserIds', async () => {
  const request = { id: 'owned-identity-query' }
  const consumed = new WeakSet<object>()

  const updateTrackedUsers = vi.fn(async ([user]: object[]) => {
    consumed.add(user!)
  })

  const queryKeysForUsers = vi.fn(([user]: object[]) => {
    expect(consumed.has(user!)).toBe(false)

    return request
  })

  const makeOutgoingRequest = vi.fn().mockResolvedValue(undefined)

  const crypto = {
    getOlmMachineOrThrow: () => ({ queryKeysForUsers, updateTrackedUsers }),
    outgoingRequestProcessor: { makeOutgoingRequest }
  }

  await loadIdentityForVerification(crypto as unknown as CryptoApi, '@first-contact:test')
  const tracked = updateTrackedUsers.mock.calls[0]![0][0]
  const queried = queryKeysForUsers.mock.calls[0]![0][0]

  expect((tracked as { id: string }).id).toBe('@first-contact:test')
  expect((queried as { id: string }).id).toBe('@first-contact:test')
  expect(queried).not.toBe(tracked)
  expect(updateTrackedUsers.mock.invocationCallOrder[0]).toBeLessThan(queryKeysForUsers.mock.invocationCallOrder[0]!)
  expect(makeOutgoingRequest).toHaveBeenCalledWith(request)
})

it.each([
  ['private entrypoint', {}],
  [
    'tracked-user API',
    {
      getOlmMachineOrThrow: () => ({ queryKeysForUsers: () => ({}) }),
      outgoingRequestProcessor: { makeOutgoingRequest: async () => {} }
    }
  ],
  [
    'owned key query',
    {
      getOlmMachineOrThrow: () => ({ updateTrackedUsers: async () => {} }),
      outgoingRequestProcessor: { makeOutgoingRequest: async () => {} }
    }
  ],
  [
    'outgoing request processor',
    {
      getOlmMachineOrThrow: () => ({
        queryKeysForUsers: () => ({}),
        updateTrackedUsers: async () => {}
      })
    }
  ]
] as const)('fails closed when identity import loses its %s', async (_label, crypto) => {
  await expect(loadIdentityForVerification(crypto as unknown as CryptoApi, '@first:test')).rejects.toThrow(
    'matrix_device_query_unavailable'
  )
})

it('fails closed on key-query drift or network failure', async () => {
  await expect(
    loadDeviceForVerification(
      { getDeviceVerificationStatus: async () => null } as unknown as CryptoApi,
      '@first:test',
      'NEW'
    )
  ).rejects.toThrow('matrix_device_query_unavailable')

  const crypto = {
    getDeviceVerificationStatus: async () => null,
    getOlmMachineOrThrow: () => ({ queryKeysForUsers: () => ({}) }),
    outgoingRequestProcessor: {
      makeOutgoingRequest: async () => {
        throw new Error('owned_network_failure')
      }
    }
  }

  await expect(loadDeviceForVerification(crypto as unknown as CryptoApi, '@first:test', 'NEW')).rejects.toThrow(
    'owned_network_failure'
  )
})

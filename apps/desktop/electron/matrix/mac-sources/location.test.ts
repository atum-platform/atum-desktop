import { describe, expect, it, vi } from 'vitest'

import { MacLocationProvider } from './location'

describe('Mac location source', () => {
  it('returns only the existing city-level owner location by default', async () => {
    const provider = new MacLocationProvider({
      timeZone: () => 'Asia/Ho_Chi_Minh',
      ownerLocation: vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City', region: 'Ho Chi Minh', country: 'vn' }))
    })

    await expect(provider.current('city', new AbortController().signal, true)).resolves.toEqual({
      city: 'Ho Chi Minh City',
      region: 'Ho Chi Minh',
      country: 'VN',
      timeZone: 'Asia/Ho_Chi_Minh'
    })
  })

  it('fails precise requests closed without a helper and never calls a helper in background', async () => {
    const precise = vi.fn(async () => ({
      city: 'Ho Chi Minh City',
      lat: 10.77,
      lon: 106.69,
      accuracyMeters: 10
    }))
    const provider = new MacLocationProvider({
      timeZone: () => 'Asia/Ho_Chi_Minh',
      ownerLocation: vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City' })),
      precise
    })

    await expect(provider.current('precise', new AbortController().signal, false)).resolves.toEqual({
      error: 'permission_needed',
      permission: 'location'
    })
    expect(precise).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FREE } from '@/lib/atum-price'

import { $petInfoByAgent, petInfoFor, syncActivePetViews } from './pet'
import type { GatewayRequest } from './pet-gallery'
import { $petGallery, adoptPet, adoptPetFor } from './pet-gallery'
import { $activeGatewayProfile } from './profile'

/**
 * Giving a *named* assistant a pet.
 *
 * The picker in the assistant editor almost always runs against someone other
 * than the assistant in front of you, which is the whole point — so the two
 * things worth pinning down are that the write is addressed to that assistant's
 * profile, and that the active profile's own view of its pet is left alone.
 */

const GALLERY = {
  active: 'boba',
  enabled: true,
  pets: [
    { displayName: 'Boba', installed: true, price: FREE, slug: 'boba' },
    { displayName: 'Gigi', installed: false, price: FREE, slug: 'gigi' }
  ]
}

/** A gateway that answers the two RPCs an adoption makes. */
function gatewayReturning(byMethod: Record<string, unknown> = {}) {
  const request = vi.fn((method: string) =>
    Promise.resolve(byMethod[method] ?? (method === 'pet.select' ? { displayName: 'Gigi', ok: true, slug: 'gigi' } : {}))
  )

  return request as typeof request & GatewayRequest
}

beforeEach(() => {
  $petInfoByAgent.set({})
  $activeGatewayProfile.set('default')
  syncActivePetViews()
  $petGallery.set(structuredClone(GALLERY))
})

describe('adopting for a named assistant', () => {
  it('addresses the write to that assistant, not the one in front of you', async () => {
    const request = gatewayReturning()

    await adoptPetFor(request, 'gigi', 'marketing', 'failed')

    expect(request).toHaveBeenCalledWith('pet.select', { profile: 'marketing', slug: 'gigi' })
  })

  it('leaves the active profile’s gallery alone', async () => {
    const request = gatewayReturning()

    await adoptPetFor(request, 'gigi', 'marketing', 'failed')

    // Settings reads this to say which pet is on *here*. Patching it would make
    // it claim Marketing's new pet as the active profile's.
    expect($petGallery.get()?.active).toBe('boba')
    expect($petGallery.get()?.pets.find(p => p.slug === 'gigi')?.installed).toBe(false)
  })

  it('refreshes that assistant’s pet, not the active one', async () => {
    const request = gatewayReturning({
      'pet.info': { displayName: 'Gigi', enabled: true, slug: 'gigi' }
    })

    await adoptPetFor(request, 'gigi', 'marketing', 'failed')

    expect(petInfoFor('marketing').slug).toBe('gigi')
    expect(petInfoFor('default').slug).toBeUndefined()
    expect(request).toHaveBeenCalledWith('pet.info', { profile: 'marketing' })
  })

  it('still patches the gallery when the assistant IS the active one', async () => {
    const request = gatewayReturning()

    await adoptPetFor(request, 'gigi', 'default', 'failed')

    expect($petGallery.get()?.active).toBe('gigi')
    expect($petGallery.get()?.pets.find(p => p.slug === 'gigi')?.installed).toBe(true)
  })

  it('reports failure rather than leaving the picker looking successful', async () => {
    const request = vi.fn(() => Promise.reject(new Error('nope'))) as unknown as GatewayRequest

    await expect(adoptPetFor(request, 'gigi', 'marketing', 'failed')).resolves.toBe(false)
  })

  it('keeps adoptPet as the active-profile case of the same path', async () => {
    const request = gatewayReturning()

    await adoptPet(request, 'gigi', 'failed')

    expect(request).toHaveBeenCalledWith('pet.select', { profile: 'default', slug: 'gigi' })
    expect($petGallery.get()?.active).toBe('gigi')
  })
})

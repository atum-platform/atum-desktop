import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  ensureGatewayForProfile: vi.fn(),
  openGatewayForProfile: vi.fn()
}))
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

const { $profileAliases, $profileColors, $profileOrder, $profilePins, migrateProfilePreferences } =
  await import('./profile')

beforeEach(() => {
  $profileAliases.set({})
  $profileColors.set({})
  $profileOrder.set([])
  $profilePins.set([])
})

describe('migrateProfilePreferences', () => {
  it('moves pinned, ordered, alias, and color state to a renamed profile key', () => {
    $profileAliases.set({ 'atum-main': 'Atum' })
    $profileColors.set({ 'atum-main': '#ff00aa' })
    $profileOrder.set(['atum-main', 'atum-moon'])
    $profilePins.set(['atum-main'])

    migrateProfilePreferences('atum-main', 'atum-primary')

    expect($profileAliases.get()).toEqual({ 'atum-primary': 'Atum' })
    expect($profileColors.get()).toEqual({ 'atum-primary': '#ff00aa' })
    expect($profileOrder.get()).toEqual(['atum-primary', 'atum-moon'])
    expect($profilePins.get()).toEqual(['atum-primary'])
  })
})

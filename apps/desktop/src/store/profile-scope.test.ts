import { afterEach, describe, expect, it } from 'vitest'

import { $activeGatewayProfile, $profiles, $profileScope, ALL_PROFILES, setShowAllProfiles } from './profile'

const profile = (name: string, isDefault = false) => ({
  has_env: true,
  home: `/tmp/${name}`,
  is_default: isDefault,
  model: null,
  name,
  path: `/tmp/${name}`,
  provider: null,
  skill_count: 0
})

afterEach(() => {
  setShowAllProfiles(false)
  $activeGatewayProfile.set('default')
  $profiles.set([])
})

describe('profile sidebar scope', () => {
  it('follows the active gateway for a single-profile install', () => {
    $activeGatewayProfile.set('work')
    $profiles.set([profile('work', true)])

    expect($profileScope.get()).toBe('work')
  })

  it('stays unified while the active agent changes in a multi-profile workspace', () => {
    $profiles.set([profile('default', true), profile('atum-moon')])

    expect($profileScope.get()).toBe(ALL_PROFILES)

    $activeGatewayProfile.set('atum-moon')

    expect($profileScope.get()).toBe(ALL_PROFILES)
  })
})

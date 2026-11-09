import { describe, expect, it } from 'vitest'

import { AtumRuntimeHomeAuthority } from './atum-runtime-home'
describe('account runtime home', () => {
  it('preserves developer legacy use, then fails closed between account activations', () => {
    const homes = new AtumRuntimeHomeAuthority('/legacy')
    expect(homes.capture().home).toBe('/legacy')
    homes.requireAccount()
    expect(() => homes.capture()).toThrow('account_required')
    homes.activate('/accounts/a/hermes')
    expect(homes.capture().home).toBe('/accounts/a/hermes')
    homes.revoke()
    expect(() => homes.capture()).toThrow('account_required')
  })
  it('discards delayed backend results across A → B → A', async () => {
    const homes = new AtumRuntimeHomeAuthority('/legacy')
    homes.requireAccount(); homes.activate('/a')
    const scope = homes.capture()
    let release!: (value: string) => void
    const pending = homes.fence(scope, () => new Promise<string>(resolve => { release = resolve }))
    homes.revoke(); homes.activate('/b'); homes.revoke(); homes.activate('/a')
    release('private result')
    await expect(pending).rejects.toThrow('account_changed')
    expect(homes.current(scope)).toBe(false)
  })
  it('does not start work captured before a re-home boundary', async () => {
    const homes = new AtumRuntimeHomeAuthority('/legacy')
    homes.requireAccount(); homes.activate('/a')
    const staleScope = homes.capture()
    homes.revoke(); homes.activate('/b')
    let started = false

    await expect(homes.fence(staleScope, async () => { started = true;

 return 'connection' })).rejects.toThrow(
      'account_changed'
    )
    expect(started).toBe(false)
  })
})

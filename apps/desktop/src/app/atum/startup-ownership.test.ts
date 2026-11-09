import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { $atumStartupHolding, atumStartupOwnsWindow, setAtumStartupHolding } from './startup-ownership'

const source = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8')

const base = {
  bootError: null,
  bootProgress: 100,
  bootRunning: false,
  bootVisible: false,
  coldBootDone: false,
  gatewayState: 'open',
  gatewaySwitching: false
} as const

describe('atumStartupOwnsWindow — the one startup surface', () => {
  it('owns the window during a cold boot, so no shell or auth form can paint', () => {
    expect(atumStartupOwnsWindow({ ...base, bootProgress: 8, bootRunning: true, bootVisible: true, gatewayState: 'closed' })).toBe(true)
  })

  it('releases the moment the gateway opens', () => {
    expect(atumStartupOwnsWindow({ ...base, bootProgress: 100, gatewayState: 'open' })).toBe(false)
  })

  it('releases on a boot failure so BootFailureOverlay recovery actions stay reachable', () => {
    expect(
      atumStartupOwnsWindow({
        ...base,
        bootError: 'backend did not become ready',
        bootProgress: 12,
        bootVisible: true,
        gatewayState: 'error'
      })
    ).toBe(false)
  })

  it('never reclaims the window after a post-boot socket drop', () => {
    expect(
      atumStartupOwnsWindow({ ...base, coldBootDone: true, gatewayState: 'closed', bootProgress: 100 })
    ).toBe(false)
  })

  it('stays out of a soft gateway switch — the shell keeps running', () => {
    expect(
      atumStartupOwnsWindow({
        ...base,
        bootProgress: 4,
        bootRunning: true,
        bootVisible: true,
        gatewaySwitching: true,
        gatewayState: 'closed'
      })
    ).toBe(false)
  })

  it('stays out of a warm reload where the gateway is already up on the first frame', () => {
    expect(atumStartupOwnsWindow({ ...base })).toBe(false)
  })
})

describe('$atumStartupHolding — the exit-choreography lock', () => {
  it('defaults to released and only writes on a real change', () => {
    expect($atumStartupHolding.get()).toBe(false)

    const seen: boolean[] = []
    const stop = $atumStartupHolding.listen(value => seen.push(value))

    setAtumStartupHolding(true)
    setAtumStartupHolding(true)
    setAtumStartupHolding(false)
    stop()

    expect(seen).toEqual([true, false])
  })
})

// Ownership only works if BOTH ends agree, so pin the wiring itself. A render
// test of ContribController would boot the entire contribution registry; these
// assertions target exactly the two lines that can silently regress.
describe('startup ownership is actually wired', () => {
  it('does not mount the Atum shell (or its auth gate) while startup owns the window', () => {
    const controller = source('../contrib/controller.tsx')

    expect(controller).toContain('atumStartupOwnsWindow')
    expect(controller).toContain('$atumStartupHolding')
    expect(controller).toContain('startupOwnsWindow ? null : <AtumShellRoot />')
  })

  it('routes provider setup through the manual-only Atum gate', () => {
    const wiring = source('../contrib/wiring.tsx')

    expect(wiring).toMatch(/!isSecondaryWindow\(\)\s*&&\s*\(\s*<ProviderSetupOverlay\s+atumShell=\{atumShellEnabled\}/u)
  })

  it('drives the connecting overlay from the same predicate, so the two cannot disagree', () => {
    expect(source('../../components/gateway-connecting-overlay.tsx')).toContain('atumStartupOwnsWindow({')
  })
})

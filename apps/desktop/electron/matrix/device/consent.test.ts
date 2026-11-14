import { describe, expect, it } from 'vitest'

import { createModalPause, hitsConsent } from './consent'

describe('trusted consent regions at GUI authorization', () => {
  const classes = ['proposal', 'device approval', 'wallet fund', 'source consent', 'checkout', 'wallet', 'first-run connect', 'folder', 'permissions', 'cloud device', 'sharing', 'location', 'discovery', 'sign-in', 'subscriptions', 'browser import', 'confirm dialog', 'channel mention', 'app auth', 'approval', 'clarify', 'secret', 'sudo', 'billing', 'memory']
  it.each(classes)('refuses both answers and keyboard reach for %s while ordinary clicks pass', () => {
    const regions = [{ x: 10, y: 20, width: 200, height: 100 }]
    const request = { commandId: 'command', target: { pid: 7, windowId: 8 }, action: 'click' }
    expect(hitsConsent({ ...request, destination: { x: 20, y: 40 } }, regions)).toBe(true)
    expect(hitsConsent({ ...request, destination: { x: 180, y: 40 } }, regions)).toBe(true)
    expect(hitsConsent({ ...request, destination: { x: 400, y: 400 } }, regions)).toBe(false)

    for (const action of ['key', 'type', 'paste', 'set_value', 'press', 'ax_perform_action']) {
      expect(hitsConsent({ ...request, action }, regions)).toBe(true)
    }

    expect(hitsConsent(request, [])).toBe(false)
  })
  it('pauses through presentation, nested modals and dismissal and preserves an existing pause', async () => {
    let paused = false
    const modal = createModalPause(() => paused, value => { paused = value })
    await modal(async () => {
      expect(paused).toBe(true)
      await modal(async () => { expect(paused).toBe(true) })
      expect(paused).toBe(true)
    })
    expect(paused).toBe(false)
    paused = true
    await expect(modal(async () => { throw Error('dismiss') })).rejects.toThrow('dismiss')
    expect(paused).toBe(true)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { inAppLinkTarget, isProviderSignInUrl, openClickedLink, registerInAppBrowser } from './in-app-links'

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  unregister = undefined
})

describe('links clicked inside Atum', () => {
  it('open web pages in Atum’s own browser while the signed-in window hosts it', async () => {
    const host = vi.fn()
    const system = vi.fn(async () => undefined)
    unregister = registerInAppBrowser(host)

    await openClickedLink('https://vnexpress.net/some-story', system)

    expect(host).toHaveBeenCalledWith('https://vnexpress.net/some-story')
    expect(system).not.toHaveBeenCalled()
  })

  it('fall back to the system browser with no host (before sign-in)', async () => {
    const system = vi.fn(async () => undefined)

    await openClickedLink('https://example.com', system)

    expect(system).toHaveBeenCalledWith('https://example.com')
  })

  it('keep mail and other schemes in the system', () => {
    expect(inAppLinkTarget('mailto:support@atumplatform.com', true)).toBe('system')
    expect(inAppLinkTarget('x-apple.systempreferences:com.apple.settings', true)).toBe('system')
    expect(inAppLinkTarget('not a url', true)).toBe('system')
  })

  it('send provider sign-ins (OAuth) to the system browser and keep ordinary maker pages in-app', async () => {
    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://auth.openai.com/oauth/authorize?client_id=x',
      'https://claude.ai/oauth/authorize?code=true',
      'https://console.anthropic.com/oauth/authorize',
      'https://appleid.apple.com/auth/authorize'
    ]) {
      expect(isProviderSignInUrl(url)).toBe(true)
      expect(inAppLinkTarget(url, true)).toBe('system')
    }

    expect(inAppLinkTarget('https://claude.ai/pricing', true)).toBe('in_app')
    expect(inAppLinkTarget('https://chatgpt.com/', true)).toBe('in_app')

    const host = vi.fn()
    const system = vi.fn(async () => undefined)
    unregister = registerInAppBrowser(host)
    await openClickedLink('https://accounts.google.com/signin', system)
    expect(host).not.toHaveBeenCalled()
    expect(system).toHaveBeenCalledTimes(1)
  })
})

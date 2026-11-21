import { describe, expect, it, vi } from 'vitest'

import { createElectronOwnerView } from './owner-view'

function make(overrides: { cookies?: { name: string }[]; fetch?: () => Promise<unknown>; destroyed?: boolean } = {}) {
  let destroyed = overrides.destroyed ?? false
  const listeners: (() => void)[] = []

  const contents = {
    getURL: vi.fn(() => 'http://127.0.0.1:61275/'),
    loadURL: vi.fn(async () => undefined),
    isDestroyed: () => destroyed,
    close: vi.fn(() => void (destroyed = true)),
    once: (_event: string, listener: () => void) => void listeners.push(listener),
    navigationHistory: { clear: vi.fn() }
  }

  const session = {
    cookies: { get: vi.fn(async () => overrides.cookies ?? []) },
    fetch: vi.fn(overrides.fetch ?? (async () => ({ ok: true, json: async () => ({ authenticated: true }) }))),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearAuthCache: vi.fn(async () => undefined)
  }

  const view = createElectronOwnerView({ contents: contents as never, session: session as never, origin: 'http://127.0.0.1:61275' })

  return { view, contents, session, destroy: () => listeners.forEach(listener => listener()) }
}

describe('Electron owner view adapter', () => {
  it('sees the session cookie only when T3 set one for this origin', async () => {
    expect(await make({ cookies: [{ name: 'generaltranslation.locale' }] }).view.hasSessionCookie()).toBe(false)
    expect(await make({ cookies: [{ name: 't3_session_61275_ab12' }] }).view.hasSessionCookie()).toBe(true)
  })

  it('reads signed-in state with the partition cookies from main, and treats any failure as signed out', async () => {
    const ok = make()

    expect(await ok.view.signedIn()).toBe(true)
    expect(ok.session.fetch).toHaveBeenCalledWith('http://127.0.0.1:61275/api/auth/session', { credentials: 'include' })
    expect(await make({ fetch: async () => ({ ok: true, json: async () => ({ authenticated: false }) }) }).view.signedIn()).toBe(false)
    expect(await make({ fetch: async () => { throw new Error('net') } }).view.signedIn()).toBe(false)
    expect(await make({ fetch: async () => ({ ok: false, json: async () => ({ authenticated: true }) }) }).view.signedIn()).toBe(false)
  })

  it('wipes cookies, storage, cache and auth cache; never touches a destroyed view; reports closure once', async () => {
    const { view, contents, session, destroy } = make()
    const closed = vi.fn()
    view.onClosed(closed)

    await view.clearPartition()
    view.clearHistory()
    expect(session.clearStorageData).toHaveBeenCalled()
    expect(session.clearCache).toHaveBeenCalled()
    expect(session.clearAuthCache).toHaveBeenCalled()
    expect(contents.navigationHistory.clear).toHaveBeenCalledTimes(1)

    view.close()
    destroy()
    expect(closed).toHaveBeenCalledTimes(1)

    view.close()
    view.clearHistory()
    expect(contents.close).toHaveBeenCalledTimes(1)
    expect(contents.navigationHistory.clear).toHaveBeenCalledTimes(1)
    expect(view.currentUrl()).toBe('')
  })
})

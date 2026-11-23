import { describe, expect, it, vi } from 'vitest'

import { installWorkViewPolicy, type NavigationEventLike } from './view-policy'

function fakes() {
  const contentsHandlers = new Map<string, ((event: NavigationEventLike, url?: string) => void)[]>()
  let windowOpen: ((details: { url: string }) => { action: 'deny' }) | null = null

  const contents = {
    on: vi.fn((event: string, listener: never) => {
      contentsHandlers.set(event, [...(contentsHandlers.get(event) ?? []), listener])
    }),
    removeListener: vi.fn((event: string, listener: never) => {
      contentsHandlers.set(event, (contentsHandlers.get(event) ?? []).filter(item => item !== listener))
    }),
    setWindowOpenHandler: vi.fn(handler => void (windowOpen = handler))
  }

  let permission: ((c: unknown, p: string, cb: (granted: boolean) => void) => void) | null = null
  let check: (() => boolean) | null = null
  let download: ((e: unknown, item: { cancel(): void }) => void) | undefined
  let request: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null

  const session = {
    setPermissionRequestHandler: vi.fn(handler => void (permission = handler)),
    setPermissionCheckHandler: vi.fn(handler => void (check = handler)),
    on: vi.fn((_event: string, listener: never) => void (download = listener)),
    removeListener: vi.fn(() => void (download = undefined)),
    webRequest: { onBeforeRequest: vi.fn((_filter, listener) => void (request = listener)) }
  }

  const blocked: string[] = []

  const dispose = installWorkViewPolicy(contents as never, session as never, {
    origin: 'http://127.0.0.1:61275',
    onBlocked: (kind, origin) => blocked.push(`${kind}:${origin}`)
  })

  const navigate = (event: string, url: string) => {
    const e = { preventDefault: vi.fn() }
    contentsHandlers.get(event)?.forEach(handler => handler(e, url))

    return e.preventDefault.mock.calls.length > 0
  }

  return {
    dispose,
    blocked,
    navigate,
    windowOpen: (url: string) => windowOpen?.({ url }),
    permission: () => {
      const cb = vi.fn()
      permission?.({}, 'media', cb)

      return cb
    },
    check: () => check?.(),
    download: () => {
      const item = { cancel: vi.fn() }
      download?.({}, item)

      return item.cancel
    },
    request: (url: string) => {
      const cb = vi.fn()
      request?.({ url }, cb)

      return cb.mock.calls[0]?.[0]
    },
    state: () => ({ windowOpen, permission, check, download, request, handlers: contentsHandlers })
  }
}

describe('Work view policy', () => {
  it('lets the view stay on its own loopback origin and nothing else', () => {
    const view = fakes()

    expect(view.navigate('will-navigate', 'http://127.0.0.1:61275/threads/1')).toBe(false)
    expect(view.navigate('will-redirect', 'http://127.0.0.1:61275/')).toBe(false)

    for (const url of [
      'https://example.com/',
      'http://127.0.0.1:61276/',
      'http://127.0.0.1.evil.example:61275/',
      'http://localhost:61275/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url'
    ]) {
      expect(view.navigate('will-navigate', url)).toBe(true)
      expect(view.navigate('will-redirect', url)).toBe(true)
      expect(view.navigate('will-frame-navigate', url)).toBe(true)
    }
  })

  it('denies window.open outright, with no external open', () => {
    const view = fakes()

    expect(view.windowOpen('https://example.com/')).toEqual({ action: 'deny' })
    expect(view.windowOpen('http://127.0.0.1:61275/pair#token=abc')).toEqual({ action: 'deny' })
    // The observer is told an origin only, never a URL with the token.
    expect(view.blocked.join(',')).not.toContain('token')
  })

  it('refuses every permission, check and download, and any request to another origin', () => {
    const view = fakes()

    expect(view.permission()).toHaveBeenCalledWith(false)
    expect(view.check()).toBe(false)
    expect(view.download()).toHaveBeenCalled()
    expect(view.request('http://127.0.0.1:61275/api/auth/session')).toEqual({ cancel: false })
    expect(view.request('ws://127.0.0.1:61275/ws')).toEqual({ cancel: false })
    expect(view.request('https://api.example.com/x')).toEqual({ cancel: true })
    expect(view.request('http://127.0.0.1:9000/')).toEqual({ cancel: true })
  })

  it('prevents attaching a webview, and removes everything when disposed', () => {
    const view = fakes()
    const event = { preventDefault: vi.fn() }
    view.state().handlers.get('will-attach-webview')?.forEach(handler => handler(event))
    expect(event.preventDefault).toHaveBeenCalled()

    view.dispose()
    const after = view.state()

    expect(after.windowOpen).toBeNull()
    expect(after.permission).toBeNull()
    expect(after.handlers.get('will-navigate')).toEqual([])
  })
})

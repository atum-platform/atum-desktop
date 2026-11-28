import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

import type { Session, WebContents, WebPreferences } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixWorkGuest } from '../../../shared/matrix-work'

import { createWorkGuestHost } from './electron-view'

function setup() {
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() }
  })

  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 1.2 })

  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    close: vi.fn(),
    insertCSS: vi.fn(async (_css: string) => 'work-shell'),
    setWindowOpenHandler: vi.fn(),
    session
  })

  const owner = host as unknown as WebContents

  const guestHost = createWorkGuestHost({
    contents: () => owner,
    preload: 'work-preload.js',
    sessionFromPartition: () => session as unknown as Session
  })

  const start = (signal = new AbortController().signal) => {
    let guest!: MatrixWorkGuest

    const opening = guestHost.createView({
      id: 'work',
      accountKey: 'test',
      generation: 1,
      origin: 'http://127.0.0.1:12345',
      home: '',
      pid: 1,
      exited: Promise.resolve(),
      takePairingUrl: () => undefined
    }, signal, value => { guest = value })

    return { opening, guest }
  }

  return { contents, guestHost, host, owner, session, start }
}

describe('Work webview', () => {
  it('admits exactly the pending guest on its host with main-owned preferences and fences it before pairing', async () => {
    const { contents, guestHost, host, owner, session, start } = setup()
    const { guest, opening } = start()
    const prefs: WebPreferences = { preload: 'untrusted.js', nodeIntegration: true, webSecurity: false }

    expect(guestHost.allowAttach({} as WebContents, prefs, { ...guest })).toBe(false)
    expect(guestHost.allowAttach(owner, prefs, { ...guest, src: 'https://example.invalid' })).toBe(false)
    expect(guestHost.allowAttach(owner, prefs, { ...guest, partition: 'persist:other' })).toBe(false)
    expect(guestHost.allowAttach(owner, prefs, { ...guest })).toBe(true)
    expect(prefs).toMatchObject({ preload: 'work-preload.js', partition: guest.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, zoomFactor: 1.2 })
    expect(guestHost.allowAttach(owner, prefs, { ...guest })).toBe(false)

    host.emit('did-attach-webview', {}, contents)
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce()
    contents.emit('did-finish-load')
    expect((await opening).contents).toBe(contents)
    contents.emit('dom-ready')
    const css = contents.insertCSS.mock.calls[0]![0]
    // Exercise the scoped selector on both update states and the separate provider pill.
    const { JSDOM } = createRequire(import.meta.url)('jsdom')
    const dom = new JSDOM()
    const { document, getComputedStyle } = dom.window
    const footer = document.createElement('footer')
    footer.dataset.sidebar = 'footer'
    footer.innerHTML = `
      <ul>
        <li id="idle" data-slot="sidebar-menu-item" class="ml-auto shrink-0"></li>
        <li id="running" data-slot="sidebar-menu-item" class="@container/sidebar-update"></li>
        <li id="normal" data-slot="sidebar-menu-item"></li>
      </ul>
      <button data-provider-update-main></button>
    `
    const sheet = document.createElement('style')
    sheet.textContent = css
    document.head.append(sheet)
    document.body.append(footer)
    expect(getComputedStyle(footer.querySelector('#idle')!).display).toBe('none')
    expect(getComputedStyle(footer.querySelector('#running')!).display).toBe('none')
    expect(getComputedStyle(footer.querySelector('#normal')!).display).not.toBe('none')
    expect(getComputedStyle(footer.querySelector('[data-provider-update-main]')!).display).not.toBe('none')
    dom.window.close()

    contents.emit('destroyed')
    expect(session.listenerCount('will-download')).toBe(0)
  })

  it('withdraws a pending guest when the account is retired', async () => {
    const { guestHost, host, owner, start } = setup()
    const controller = new AbortController()
    const { guest, opening } = start(controller.signal)
    controller.abort()
    await expect(opening).rejects.toThrow('work_guest_unavailable')
    expect(guestHost.allowAttach(owner, {}, { ...guest })).toBe(false)
    expect(host.listenerCount('did-attach-webview')).toBe(0)
  })
})

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { createWorkViewFactory } from './electron-view'

const { fromPartition, views } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  views: [] as Array<{ webContents?: EventEmitter }>
}))

vi.mock('electron', () => ({
  session: { fromPartition },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => !this.webContents,
      focus: vi.fn(),
      insertCSS: vi.fn(async () => 'work-shell'),
      setWindowOpenHandler: vi.fn()
    })

    constructor() {
      views.push(this)
    }

    setBackgroundColor = vi.fn()
    setBorderRadius = vi.fn()
    setBounds = vi.fn()
  }
}))

describe('Work view teardown', () => {
  it.each([false, true])('handles destroyed contents when host destroyed is %s', hostDestroyed => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() }
    })

    fromPartition.mockReturnValue(session)

    let windowDestroyed = false
    const host = {
      isDestroyed: () => windowDestroyed,
      getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    }

    const zoomFactor = vi.fn(() => 1)

    const handle = createWorkViewFactory({
      window: () => host as unknown as BrowserWindow,
      preload: 'work-preload.js',
      zoomFactor
    })({
      id: 'work',
      accountKey: 'test',
      generation: 1,
      origin: 'http://127.0.0.1:12345',
      home: '',
      pid: 1,
      exited: Promise.resolve(),
      takePairingUrl: () => undefined
    })

    const view = views.at(-1)!
    const contents = view.webContents!
    contents.emit('dom-ready')
    const css = vi.mocked((contents as unknown as { insertCSS: (css: string) => Promise<string> }).insertCSS).mock.calls[0][0]
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

    const rect = { x: 20, y: 10, width: 400, height: 300 }

    handle.place(rect)
    expect(host.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view)

    windowDestroyed = hostDestroyed
    // Electron clears the getter before it notifies listeners on the original WebContents.
    view.webContents = undefined
    expect(() => contents.emit('destroyed')).not.toThrow()
    expect(() => handle.place(rect)).not.toThrow()
    expect(() => handle.focus?.()).not.toThrow()

    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(hostDestroyed ? 0 : 1)
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(zoomFactor).toHaveBeenCalledTimes(1)
    expect(session.listenerCount('will-download')).toBe(0)
  })
})

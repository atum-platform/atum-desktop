import { EventEmitter } from 'node:events'

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

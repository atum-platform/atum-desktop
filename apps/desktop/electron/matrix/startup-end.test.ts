import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createMatrixQuitHandler } from './quit'
import { endMatrixStartup, type MatrixStartupEnd, trackMatrixQuit } from './startup-end'

// What Electron's loadURL rejects with when the window's contents are destroyed mid-load.
const destroyedMidLoad = Object.assign(new Error("ERR_FAILED (-2) loading 'atum-matrix://ui/matrix.html'"), {
  errno: -2,
  code: 'ERR_FAILED'
})

const describeError = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : typeof error)

function ending(state: { quitRequested?: () => boolean; windowClosed?: boolean } = {}, quit: () => unknown = () => {}) {
  const calls: string[] = []

  const end: MatrixStartupEnd = {
    quitRequested: state.quitRequested ?? (() => false),
    windowClosed: () => state.windowClosed ?? false,
    describe: describeError,
    report: vi.fn(() => void calls.push('report')),
    log: vi.fn(line => void calls.push(`log ${line}`)),
    alert: vi.fn(() => void calls.push('alert')),
    quit: vi.fn(() => {
      calls.push('quit')
      quit()
    })
  }

  return { end, calls }
}

describe('a launch that does not finish (G1-13)', () => {
  it('quits quietly when a quit arrives while the window is still loading', () => {
    const { end, calls } = ending({ quitRequested: () => true })

    expect(endMatrixStartup(destroyedMidLoad, end)).toBe('quit')
    // No "could not start" alert, which would hold the quit open, and nothing reported.
    expect(end.alert).not.toHaveBeenCalled()
    expect(end.report).not.toHaveBeenCalled()
    expect(calls).toEqual([
      "log [Matrix] startup ended by a quit before the window loaded: Error: ERR_FAILED (-2) loading 'atum-matrix://ui/matrix.html'",
      'quit'
    ])
  })

  it('quits quietly, saying so, when the window is closed while it loads, before the quit is asked for', () => {
    const { end, calls } = ending({ windowClosed: true })

    expect(endMatrixStartup(destroyedMidLoad, end)).toBe('quit')
    expect(end.alert).not.toHaveBeenCalled()
    expect(calls[0]).toMatch(/^log \[Matrix\] startup ended by its window closing before the window loaded: /)
    expect(end.quit).toHaveBeenCalledOnce()
  })

  it('still reports, logs and explains a real failure before quitting', () => {
    const { end, calls } = ending()

    expect(endMatrixStartup(new TypeError('matrix_runtime_unavailable'), end)).toBe('failed')
    expect(calls).toEqual([
      'report',
      'log [Matrix] candidate startup failed: TypeError: matrix_runtime_unavailable',
      'alert',
      'quit'
    ])
  })

  it('treats the same ERR_FAILED as a failure when nothing ended the launch', () => {
    const { end } = ending()

    expect(endMatrixStartup(destroyedMidLoad, end)).toBe('failed')
    expect(end.alert).toHaveBeenCalledOnce()
  })
})

describe('knowing a quit was asked for (G1-13)', () => {
  it('knows at once, even while the quit handler holds the quit open for its shutdown', async () => {
    const app = new EventEmitter()
    const quitRequested = trackMatrixQuit(app)
    let finish!: () => void
    const close = vi.fn(() => new Promise<void>(resolve => (finish = resolve)))
    const quit = vi.fn()
    app.on('before-quit', createMatrixQuitHandler(close, quit))
    const event = { preventDefault: vi.fn() }

    expect(quitRequested()).toBe(false)
    app.emit('before-quit', event)
    // The quit is held open (shutdown runs asynchronously), and the launch already knows.
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quitRequested()).toBe(true)
    expect(quit).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })

  it('knows whichever listener was added first', () => {
    const app = new EventEmitter()
    app.on('before-quit', createMatrixQuitHandler(async () => {}, vi.fn()))
    const quitRequested = trackMatrixQuit(app)

    app.emit('before-quit', { preventDefault: vi.fn() })
    expect(quitRequested()).toBe(true)
  })

  it('ends a launch quietly, once, when a postponed quit leaves the app running', async () => {
    // An update postponed because shutdown failed ("retry") keeps the app running. A launch
    // that then fails is still one the person asked to end: it asks to quit again, once,
    // and that quit completes. Nothing loops and no alert appears.
    const app = new EventEmitter()
    const quitRequested = trackMatrixQuit(app)
    const quit = vi.fn()
    const afterClose = vi.fn<(success: boolean) => 'quit' | 'handled' | 'retry'>()
    afterClose.mockReturnValueOnce('retry').mockReturnValueOnce('quit')
    const close = vi.fn(async () => {})
    app.on('before-quit', createMatrixQuitHandler(close, quit, afterClose))

    app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(afterClose).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()

    const { end } = ending({ quitRequested }, () => app.emit('before-quit', { preventDefault: vi.fn() }))
    expect(endMatrixStartup(destroyedMidLoad, end)).toBe('quit')
    expect(end.alert).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(close).toHaveBeenCalledTimes(2)
    expect(end.quit).toHaveBeenCalledOnce()
  })
})

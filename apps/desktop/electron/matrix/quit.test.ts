import { describe, expect, it, vi } from 'vitest'

import { createMatrixQuitHandler } from './quit'

describe('Matrix quit barrier', () => {
  it('prevents repeated quits until SDK shutdown and credential persistence finish', async () => {
    let finish!: () => void

    const close = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )

    const quit = vi.fn()
    const handler = createMatrixQuitHandler(close, quit)
    const event = { preventDefault: vi.fn() }
    handler(event)
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    handler(event)
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(3)
    expect(quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('finishes a bounded failed shutdown without an unhandled rejection or quit loop', async () => {
    const close = vi.fn(async () => {
      throw new Error('closed producer')
    })

    const quit = vi.fn()
    const handler = createMatrixQuitHandler(close, quit)
    const event = { preventDefault: vi.fn() }
    handler(event)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

it('bounds ordinary quit after persistence and forces exit if a window vetoes it', async () => {
  vi.useFakeTimers()

  try {
    const cleanup = vi.fn()
    const forceExit = vi.fn()
    const quit = vi.fn()
    const afterClose = vi.fn(() => 'quit' as const)

    const handler = createMatrixQuitHandler(() => new Promise(() => {}), quit, afterClose, {
      prepare: async () => {}, deadlineMs: 30, forceCleanup: cleanup, forceExit
    })

    handler({ preventDefault() {} })
    await vi.advanceTimersByTimeAsync(30)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
    handler({ preventDefault: () => {throw new Error('second native quit was vetoed')} })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(forceExit).toHaveBeenCalledOnce()
    expect(afterClose).toHaveBeenCalledOnce()
  } finally {vi.useRealTimers()}
})

it('preserves a refused document checkpoint without killing children or arming forced exit', async () => {
  const close = vi.fn(async () => {})
  const cleanup = vi.fn()
  const forceExit = vi.fn()
  const afterClose = vi.fn(() => 'retry' as const)

  const handler = createMatrixQuitHandler(close, vi.fn(), afterClose, {
    prepare: async () => {throw new Error('unsaved document')}, forceCleanup: cleanup, forceExit
  })

  handler({ preventDefault() {} })
  await vi.waitFor(() => expect(afterClose).toHaveBeenCalledWith(false))
  expect(close).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
  expect(forceExit).not.toHaveBeenCalled()
})

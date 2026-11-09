import { describe, expect, it, vi } from 'vitest'

import { MATRIX_CLIPBOARD_IPC, MATRIX_CLIPBOARD_MAX_CHARS } from '../../shared/matrix-clipboard'

import { registerMatrixClipboard } from './clipboard'

type Handler = (event: object, ...args: unknown[]) => unknown

function setup(assertTrusted = vi.fn()) {
  const handlers = new Map<string, Handler>()
  const writeText = vi.fn()
  const ipc = { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) }

  registerMatrixClipboard(ipc, { assertTrusted, writeText })

  return { assertTrusted, handle: handlers.get(MATRIX_CLIPBOARD_IPC.write)!, writeText }
}

describe('Matrix clipboard IPC', () => {
  it('writes the text the window sends to the system clipboard', async () => {
    const { handle, writeText } = setup()

    await handle({}, 'Here is a **plan**.')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Here is a **plan**.')
  })

  it('refuses a caller that is not the Matrix UI window, before writing anything', async () => {
    const { handle, writeText } = setup(
      vi.fn(() => {
        throw new Error('matrix_ipc_denied')
      })
    )

    await expect(handle({}, 'secret')).rejects.toThrow('matrix_ipc_denied')
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each([[undefined], [42], [{}], [''], ['x'.repeat(MATRIX_CLIPBOARD_MAX_CHARS + 1)]])(
    'refuses a request that is not one non-empty bounded string (%#)',
    async value => {
      const { handle, writeText } = setup()

      await expect(handle({}, value)).rejects.toThrow('matrix_clipboard_invalid_request')
      expect(writeText).not.toHaveBeenCalled()
    }
  )

  it('refuses extra arguments', async () => {
    const { handle, writeText } = setup()

    await expect(handle({}, 'text', 'more')).rejects.toThrow('matrix_clipboard_invalid_request')
    expect(writeText).not.toHaveBeenCalled()
  })
})

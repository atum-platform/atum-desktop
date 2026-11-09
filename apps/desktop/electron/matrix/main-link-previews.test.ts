import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'
import { MATRIX_LINK_PREVIEW_IPC } from '../../shared/matrix-link-preview'

import { matrixLinkPreviewTarget, registerMatrixLinkPreviewIpc } from './main-link-previews'

const room = (id: string, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name: id,
  membership: 'join',
  encrypted: false,
  ...extra
})

const state = {
  rooms: [room('!plain:test'), room('!sealed:test', { encrypted: true }), room('!invited:test', { membership: 'invite' })]
}

describe('matrixLinkPreviewTarget', () => {
  it('lets through only a well-formed event in a joined plain room', () => {
    expect(matrixLinkPreviewTarget(state, '!plain:test', '$event')).toEqual({ roomId: '!plain:test', eventId: '$event' })
    expect(matrixLinkPreviewTarget(state, '!sealed:test', '$event')).toBeUndefined()
    expect(matrixLinkPreviewTarget(state, '!invited:test', '$event')).toBeUndefined()
    expect(matrixLinkPreviewTarget(state, '!unknown:test', '$event')).toBeUndefined()
    expect(matrixLinkPreviewTarget(state, '!plain:test', 'https://example.com/')).toBeUndefined()
    expect(matrixLinkPreviewTarget(state, '!plain:test', '$bad id')).toBeUndefined()
    expect(matrixLinkPreviewTarget(state, { id: '!plain:test' }, '$event')).toBeUndefined()
  })
})

describe('registerMatrixLinkPreviewIpc', () => {
  function setup(answer: () => Promise<unknown>) {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const ipc = { handle: vi.fn((name: string, fn: (...args: unknown[]) => Promise<unknown>) => void handlers.set(name, fn)) }
    const ask = vi.fn(answer)
    const guard = vi.fn()

    registerMatrixLinkPreviewIpc(ipc as never, () => state, ask, guard)

    return { handler: handlers.get(MATRIX_LINK_PREVIEW_IPC.read)!, ask, guard }
  }

  it('forwards a checked target and re-checks the answer', async () => {
    const { handler, ask, guard } = setup(async () => ({ url: 'https://example.com/a', host: 'example.com', title: 'A' }))

    await expect(handler({}, '!plain:test', '$event')).resolves.toEqual({ url: 'https://example.com/a', host: 'example.com', title: 'A' })
    expect(guard).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith({ roomId: '!plain:test', eventId: '$event' })
  })

  it('never reaches the SDK for an encrypted room, and turns failures and odd answers into no card', async () => {
    const odd = setup(async () => ({ url: 'file:///etc/passwd', title: 'x' }))

    await expect(odd.handler({}, '!sealed:test', '$event')).resolves.toBeNull()
    expect(odd.ask).not.toHaveBeenCalled()
    await expect(odd.handler({}, '!plain:test', '$event')).resolves.toBeNull()

    const failing = setup(async () => {
      throw new Error('sdk_gone')
    })

    await expect(failing.handler({}, '!plain:test', '$event')).resolves.toBeNull()
  })
})

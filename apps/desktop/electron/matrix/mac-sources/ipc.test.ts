import { expect, it, vi } from 'vitest'

import { MATRIX_MAC_SOURCES_IPC } from '../../../shared/matrix-mac-sources'

import { registerMatrixMacSourcesIpc } from './ipc'

it('exposes only trusted closed reads and boolean source writes', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const assertTrusted = vi.fn()
  const read = vi.fn(() => ({ google: true, folders: true, messages: true, browser: true, location: true, teamSpaces: true }))
  const set = vi.fn((source, enabled) => ({ ...read(), [source]: enabled }))

  registerMatrixMacSourcesIpc({ handle: (channel, handler) => void handlers.set(channel, handler) } as never, {
    assertTrusted,
    read,
    set
  })

  const event = { sender: {} } as never
  expect(handlers.get(MATRIX_MAC_SOURCES_IPC.read)!(event)).toEqual(read())
  expect(handlers.get(MATRIX_MAC_SOURCES_IPC.set)!(event, 'messages', false)).toMatchObject({ messages: false })
  expect(set).toHaveBeenCalledExactlyOnceWith('messages', false)
  expect(() => handlers.get(MATRIX_MAC_SOURCES_IPC.set)!(event, 'messages', 'off')).toThrow('matrix_mac_sources_invalid_request')
  expect(() => handlers.get(MATRIX_MAC_SOURCES_IPC.set)!(event, 'private', false)).toThrow('matrix_mac_sources_invalid_request')
  expect(assertTrusted).toHaveBeenCalledTimes(4)
})

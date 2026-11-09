import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppDescriptor } from '../../../shared/app-catalog'
import { ACME, botApp } from '../../../shared/app-catalog.test-support'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { matrixChatFailure, matrixFailureRetry, matrixFailureSubject } from '../chat-error'

import { openAppBotChat } from './open'
import { useOpenApp } from './use-open-app'

// An app this client has no code for: nothing below may depend on what it is called.
const unknown = botApp({ ...ACME, slug: 'quill_desk', name: 'Quill', appId: '00000000-0000-4000-8000-a499ea1345d3' })
const snapshot: Pick<MatrixSnapshot, 'apps'> = { apps: { state: 'ready', apps: [unknown], connections: {} } }

const ipc = (code: string) => new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  Object.assign(window, { atumMatrix: { apps: { chat: vi.fn(async () => '!room:test') } } })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const bridge = () => (window.atumMatrix as unknown as { apps: { chat: ReturnType<typeof vi.fn> } }).apps

describe('picking an official bot from the roster', () => {
  it('says the chat is opening until it is on the window, and opens one at a time', async () => {
    const opening = deferred<string>()
    bridge().chat.mockReturnValueOnce(opening.promise)
    const fail = vi.fn()
    const { result } = renderHook(() => useOpenApp(snapshot, 'vi', fail))

    act(() => result.current.openApp(unknown))
    expect(result.current.openingApp).toBe(unknown.app_id)
    expect(bridge().chat).toHaveBeenCalledExactlyOnceWith(unknown.app_id, 'vi')

    // A second pick while the first is opening is ignored.
    act(() => result.current.openApp(unknown))
    expect(bridge().chat).toHaveBeenCalledOnce()

    await act(async () => opening.resolve('!room:test'))
    await waitFor(() => expect(result.current.openingApp).toBeNull())
    expect(fail).not.toHaveBeenCalled()
  })

  it('opens an app with no bot on its page instead', async () => {
    const command = vi.fn(async () => null)
    Object.assign(window, { atumMatrix: { apps: bridge(), command } })
    const { result } = renderHook(() => useOpenApp(snapshot, 'en', vi.fn()))

    act(() => result.current.openApp({ ...unknown, bot: undefined } as AppDescriptor))
    expect(command).toHaveBeenCalledWith({ kind: 'selectApp', appId: unknown.app_id })
    expect(bridge().chat).not.toHaveBeenCalled()
  })

  it('ends in a failure that names the bot and carries a Retry, which is the same pick again', async () => {
    bridge().chat.mockRejectedValueOnce(ipc('matrix_app_bot_syncing'))
    const failures: unknown[] = []
    const { result } = renderHook(() => useOpenApp(snapshot, 'en', cause => failures.push(cause)))

    act(() => result.current.openApp(unknown))
    await waitFor(() => expect(failures).toHaveLength(1))
    await waitFor(() => expect(result.current.openingApp).toBeNull())

    const failure = failures[0]
    expect(matrixChatFailure(failure)).toBe('app_bot_syncing')
    expect(matrixFailureSubject(failure)).toBe('Quill')

    // Retry shows the row opening again, and opens the same app.
    const opening = deferred<string>()
    bridge().chat.mockReturnValueOnce(opening.promise)
    act(() => matrixFailureRetry(failure)!())
    expect(result.current.openingApp).toBe(unknown.app_id)
    expect(bridge().chat).toHaveBeenCalledTimes(2)
    expect(bridge().chat).toHaveBeenLastCalledWith(unknown.app_id, 'en')

    await act(async () => opening.resolve('!room:test'))
    await waitFor(() => expect(result.current.openingApp).toBeNull())
    expect(failures).toHaveLength(1)
  })

  it('fails again with a new Retry when the retry does not open it either', async () => {
    bridge().chat.mockRejectedValue(ipc('matrix_app_bot_syncing'))
    const failures: unknown[] = []
    const { result } = renderHook(() => useOpenApp(snapshot, 'en', cause => failures.push(cause)))

    act(() => result.current.openApp(unknown))
    await waitFor(() => expect(failures).toHaveLength(1))
    await waitFor(() => expect(result.current.openingApp).toBeNull())

    act(() => matrixFailureRetry(failures[0])!())
    await waitFor(() => expect(failures).toHaveLength(2))
    await waitFor(() => expect(result.current.openingApp).toBeNull())
    expect(matrixFailureRetry(failures[1])).toBeTypeOf('function')
  })

  it('tells the person, rather than doing nothing, when this window has no way to open a chat', async () => {
    Object.assign(window, { atumMatrix: {} })
    const failures: unknown[] = []
    const { result } = renderHook(() => useOpenApp(snapshot, 'en', cause => failures.push(cause)))

    act(() => result.current.openApp(unknown))
    await waitFor(() => expect(failures).toHaveLength(1))
    await waitFor(() => expect(result.current.openingApp).toBeNull())
    expect(matrixChatFailure(failures[0])).toBe('app_bot_unavailable')
    expect(matrixFailureSubject(failures[0])).toBe('Quill')
  })
})

describe('opening an official bot’s chat from anywhere else', () => {
  it('fails with the same words and a Retry that opens it again, whoever asked', async () => {
    bridge().chat.mockRejectedValueOnce(ipc('matrix_app_bot_syncing'))
    const failures: unknown[] = []

    await openAppBotChat(snapshot, unknown.app_id, 'vi', cause => failures.push(cause))
    expect(matrixChatFailure(failures[0])).toBe('app_bot_syncing')
    expect(matrixFailureSubject(failures[0])).toBe('Quill')

    matrixFailureRetry(failures[0])!()
    await waitFor(() => expect(bridge().chat).toHaveBeenCalledTimes(2))
    expect(bridge().chat).toHaveBeenLastCalledWith(unknown.app_id, 'vi')
    expect(failures).toHaveLength(1)
  })

  it('still names nothing and offers a Retry when the catalog has no name for the bot', async () => {
    bridge().chat.mockRejectedValueOnce(ipc('matrix_app_bot_syncing'))
    const failures: unknown[] = []

    await openAppBotChat({ apps: { state: 'ready', apps: [], connections: {} } }, unknown.app_id, 'en', cause =>
      failures.push(cause)
    )
    expect(matrixFailureSubject(failures[0])).toBeUndefined()
    expect(matrixFailureRetry(failures[0])).toBeTypeOf('function')
  })
})

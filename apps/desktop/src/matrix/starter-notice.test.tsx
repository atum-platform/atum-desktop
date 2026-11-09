import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { matrixStarterCopy } from './starter-copy'
import { MatrixStarterNotice } from './starter-notice'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'DEVICE' },
  petScope: 'account-a',
  readiness: { phase: 'ready', since: 1 },
  starterMarker: 'unseen',
  starter: { kind: 'founding', amount: 50_000_999_999 },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, reject, resolve }
}

function show(snapshot = base, command = vi.fn(() => deferred<unknown>().promise), defaultAssistantChat = true) {
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  return render(<MatrixStarterNotice defaultAssistantChat={defaultAssistantChat} locale="en" snapshot={snapshot} />)
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const title = () => window.document.querySelectorAll('[data-matrix-starter-notice] p')[0]?.textContent ?? ''
const line = () => window.document.querySelectorAll('[data-matrix-starter-notice] p')[1]?.textContent ?? ''

describe('Matrix starter notice', () => {
  it('keeps a fast acknowledged welcome readable for this visit, then clears it when leaving the assistant chat', async () => {
    const command = vi.fn(async () => undefined)
    const { rerender } = show(base, command)
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    const seen = { ...base, starterMarker: 'seen' as const, starter: undefined }
    rerender(<MatrixStarterNotice defaultAssistantChat locale="en" snapshot={seen} />)
    expect(title()).toBe('Free to try')
    expect(line()).toBe('Enough for about 20 chats.')
    rerender(<MatrixStarterNotice defaultAssistantChat={false} locale="en" snapshot={seen} />)
    expect(line()).toBe('')
    rerender(<MatrixStarterNotice defaultAssistantChat locale="en" snapshot={seen} />)
    expect(line()).toBe('')
    expect(command).toHaveBeenCalledOnce()
  })
  it('shows the kit notice with the allowance translated to an approximate chat count', async () => {
    const founding = deferred<unknown>()
    const command = vi.fn(() => founding.promise)
    const { rerender } = show(base, command)

    await waitFor(() => expect(line()).toBe('Enough for about 20 chats.'))
    expect(window.document.querySelector('[data-matrix-starter-notice]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-starter-notice] [data-proton-mark]')).toBeNull()
    expect(command).toHaveBeenCalledWith({
      kind: 'starterSeen',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      scope: 'account-a'
    })

    const standard = deferred<unknown>()
    command.mockImplementation(() => standard.promise)
    rerender(
      <MatrixStarterNotice
        defaultAssistantChat
        locale="en"
        snapshot={{ ...base, starter: { kind: 'standard', amount: 10_999_999 } }}
      />
    )
    await waitFor(() => expect(line()).toBe('Enough for about 1 chats.'))
  })

  it.each(['en', 'vi', 'zh', 'zh-hant', 'ja'])('has native starter copy for %s', locale => {
    expect(matrixStarterCopy(locale).title.trim()).not.toBe('')
    expect(matrixStarterCopy(locale).body('20')).not.toContain('undefined')
    expect(matrixStarterCopy(locale).retry).not.toBe('')
  })

  it.each([
    ['a deferred marker', { ...base, starterMarker: 'unknown' as const }],
    ['an absent grant', { ...base, starter: undefined }],
    ['a malformed amount', { ...base, starter: { kind: 'founding' as const, amount: 0 } }],
    ['a non-default chat', base, false]
  ])('does not offer %s', async (_label, snapshot, defaultAssistantChat = true) => {
    const command = vi.fn(async () => undefined)
    show(snapshot, command, defaultAssistantChat)

    expect(window.document.querySelector('[data-matrix-starter-notice]')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps the line visible and offers a quiet retry when acknowledgement fails', async () => {
    const command = vi.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValue(deferred<unknown>().promise)
    show(base, command)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
    expect(title()).toBe('Free to try')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
  })

  it('masks an outgoing account scope immediately and ignores its late acknowledgement', async () => {
    const old = deferred<unknown>()
    const next = deferred<unknown>()
    const command = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const { rerender } = show(base, command)

    await waitFor(() => expect(line()).toContain('20 chats'))

    const replacement: MatrixSnapshot = {
      ...base,
      identity: { userId: '@other:test', deviceId: 'OTHER' },
      petScope: 'account-b',
      starter: { kind: 'standard', amount: 10_000_000 }
    }

    rerender(<MatrixStarterNotice defaultAssistantChat locale="en" snapshot={replacement} />)
    expect(line()).not.toContain('20 chats')
    await waitFor(() => expect(line()).toContain('1 chats'))

    await act(async () => old.resolve(undefined))
    expect(line()).toContain('1 chats')
  })
})

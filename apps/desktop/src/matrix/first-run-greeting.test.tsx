import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $firstRunPick, resetFirstRunForTests } from '@/app/connections/first-run-store'

import type { MatrixMessage, MatrixRoom } from '../../shared/matrix'

import {
  firstRunGreetingSeed,
  firstRunGreetingSent,
  isFirstRunGreetingSeed,
  resetFirstRunGreetingForTests,
  sendFirstRunGreetingOnce,
  withoutFirstRunGreetingSeed
} from './first-run-greeting'
import { FIRST_RUN_GREETING_WAIT_MS, FirstRunGreetingSender } from './first-run-greeting-sender'

function message(id: string, over: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id,
    sender: '@owner:test',
    body: '',
    timestamp: 1,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...over
  } as MatrixMessage
}

beforeEach(() => {
  resetFirstRunForTests()
  resetFirstRunGreetingForTests()
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('first-run greeting intent', () => {
  it('builds the seed per the backend contract (locale, one-line name of at most 80 characters)', () => {
    expect(firstRunGreetingSeed('vi', 'Minh')).toBe('io.atum.first-run.greeting/1 vi Minh')
    expect(firstRunGreetingSeed('ja')).toBe('io.atum.first-run.greeting/1 en')
    const long = firstRunGreetingSeed('en', `An\nNguyen ${'x'.repeat(200)}`)
    expect(long.startsWith('io.atum.first-run.greeting/1 en An Nguyen ')).toBe(true)
    expect(isFirstRunGreetingSeed(long)).toBe(true)
    expect(isFirstRunGreetingSeed('io.atum.first-run.greeting/1 fr')).toBe(false)
    expect(isFirstRunGreetingSeed('hello')).toBe(false)
  })

  it('hides the owner’s seed from the chat and the chat list, and names the assistant’s answer', () => {
    const seed = 'io.atum.first-run.greeting/1 en An'
    const rooms = [{ id: '!a', name: 'Atum', membership: 'join', preview: { own: true, kind: 'text', text: seed, at: 1 } } as MatrixRoom]
    const view = withoutFirstRunGreetingSeed({
      rooms,
      messages: [message('$seed', { body: seed }), message('$reply', { own: false, sender: '@atum:test', body: 'Hi An.' })]
    })

    expect(view.messages.map(each => each.id)).toEqual(['$reply'])
    expect(view.rooms[0]?.preview).toBeUndefined()
    expect(view.firstRunGreetingReplyId).toBe('$reply')

    // Someone else's message that merely looks like a seed is not hidden; nothing to hide keeps the same object.
    const plain = { rooms: [], messages: [message('$x', { own: false, body: seed })] }
    expect(withoutFirstRunGreetingSeed(plain)).toBe(plain)
  })

  it('sends once per room, and lets the next launch retry after a failed send', async () => {
    const send = vi.fn(async () => undefined)

    expect(await sendFirstRunGreetingOnce('!a', 'io.atum.first-run.greeting/1 en', send)).toBe('sent')
    expect(await sendFirstRunGreetingOnce('!a', 'io.atum.first-run.greeting/1 en', send)).toBe('skipped')
    expect(send).toHaveBeenCalledTimes(1)
    expect(firstRunGreetingSent('!a')).toBe(true)

    const failing = vi.fn(async () => Promise.reject(new Error('offline')))
    expect(await sendFirstRunGreetingOnce('!b', 'io.atum.first-run.greeting/1 vi', failing)).toBe('failed')
    expect(firstRunGreetingSent('!b')).toBe(false)
  })

  it('waits for the launch pick, then sends once even across re-renders', async () => {
    const send = vi.fn(async () => undefined)
    const view = render(<FirstRunGreetingSender roomId="!a" seed="io.atum.first-run.greeting/1 en" send={send} />)

    expect(send).not.toHaveBeenCalled()
    await act(async () => {
      $firstRunPick.set({ kind: 'plan', plan: 'claude', model: 'claude-sonnet-5-5' })
    })
    view.rerender(<FirstRunGreetingSender roomId="!a" seed="io.atum.first-run.greeting/1 en" send={send} />)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('io.atum.first-run.greeting/1 en')
  })

  it('goes anyway after a short wait when the pick is slow', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => undefined)
    render(<FirstRunGreetingSender roomId="!c" seed="io.atum.first-run.greeting/1 en" send={send} />)

    await act(async () => {
      vi.advanceTimersByTime(FIRST_RUN_GREETING_WAIT_MS)
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

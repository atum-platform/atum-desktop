import { describe, expect, it, vi } from 'vitest'

import { sendAssistantMessage } from './assistant-send'

describe('sendAssistantMessage', () => {
  it('does not send when the native preflight fails, but always releases the reserved operation once', async () => {
    const check = vi.fn(async () => {
      throw new Error('matrix_private_assistant_room_required')
    })

    const send = vi.fn()
    const invoke = vi.fn()
    const release = vi.fn()

    await expect(sendAssistantMessage({ check, send, invoke, release })).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )
    expect(send).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledExactlyOnceWith()
  })

  it('keeps an unknown send as an error and never invokes without an acknowledged event id', async () => {
    const send = vi.fn(async () => {
      throw new Error('network')
    })

    const invoke = vi.fn()
    const release = vi.fn()

    await expect(sendAssistantMessage({ check: async () => {}, send, invoke, release })).rejects.toThrow('network')
    expect(invoke).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledExactlyOnceWith()
  })

  it('invokes exactly the one acknowledged message and maps a later invocation failure to an honest unknown result', async () => {
    const release = vi.fn()

    const invoke = vi.fn(async (eventId: string) => {
      expect(release).toHaveBeenCalledExactlyOnceWith()
      expect(eventId).toBe('$sent')
      throw new Error('executor unavailable')
    })

    await expect(
      sendAssistantMessage({
        check: async () => {},
        send: async () => '$sent',
        release,
        invoke
      })
    ).resolves.toEqual({ eventId: '$sent', result: { state: 'unknown' } })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('$sent')
    expect(release).toHaveBeenCalledExactlyOnceWith()
  })

  it('returns a known invocation outcome without resending the Matrix event', async () => {
    const send = vi.fn(async () => '$sent')
    const invoke = vi.fn(async () => ({ state: 'published' as const, eventId: '$result' }))

    await expect(sendAssistantMessage({ check: async () => {}, send, release: vi.fn(), invoke })).resolves.toEqual({
      eventId: '$sent',
      result: { state: 'published', eventId: '$result' }
    })
    expect(send).toHaveBeenCalledExactlyOnceWith()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('$sent')
  })

  it('does not let a late first invocation release a later operation', async () => {
    let finishFirst!: () => void

    const firstInvoke = new Promise<void>(resolve => {
      finishFirst = resolve
    })

    const firstRelease = vi.fn()
    const secondRelease = vi.fn()

    const first = sendAssistantMessage({
      check: async () => {},
      send: async () => '$first',
      release: firstRelease,
      invoke: async () => {
        await firstInvoke

        return { state: 'published' }
      }
    })

    await vi.waitFor(() => expect(firstRelease).toHaveBeenCalledExactlyOnceWith())

    const second = sendAssistantMessage({
      check: async () => {},
      send: async () => '$second',
      release: secondRelease,
      invoke: async () => ({ state: 'published' })
    })

    await second
    finishFirst()
    await first

    expect(firstRelease).toHaveBeenCalledExactlyOnceWith()
    expect(secondRelease).toHaveBeenCalledExactlyOnceWith()
  })
})

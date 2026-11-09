import { describe, expect, it, vi } from 'vitest'

import { MatrixInviteLinkBroker } from './invite-link-broker'

const token = 'A'.repeat(43)

describe('native Team Space invite-link broker', () => {
  it('keeps one validated cold-start token until the renderer takes it', () => {
    const broker = new MatrixInviteLinkBroker()

    expect(broker.deliver(`atum://join/${token}`)).toBe('accepted')
    expect(broker.take()).toBe(token)
    expect(broker.take()).toBeNull()
  })

  it('publishes warm-start delivery while retaining the in-memory cold-start copy', () => {
    const broker = new MatrixInviteLinkBroker()
    const publish = vi.fn()

    expect(broker.deliver(`atum://join/${token}`, publish)).toBe('accepted')
    expect(publish).toHaveBeenCalledExactlyOnceWith(token)
    expect(broker.take()).toBe(token)
  })

  it('drops malformed join routes, ignores unrelated routes, and never logs the bearer', () => {
    const broker = new MatrixInviteLinkBroker()
    const publish = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(broker.deliver('atum://join/not-a-token', publish)).toBe('invalid')
    expect(broker.deliver('atum://message/v1/value', publish)).toBe('not_invite_link')
    expect(publish).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(broker.take()).toBeNull()
    warn.mockRestore()
  })
})

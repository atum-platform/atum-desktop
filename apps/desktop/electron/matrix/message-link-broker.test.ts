import { describe, expect, it, vi } from 'vitest'

import { matrixMessageLink, type MatrixMessageLinkTarget } from '../../shared/matrix-message-link'

import { MatrixMessageLinkBroker } from './message-link-broker'

const target: MatrixMessageLinkTarget = {
  companyId: '00000000-0000-4000-8000-4423c334534f',
  roomId: '!general:atum.example',
  eventId: '$message'
}

describe('native Team space message-link broker', () => {
  it('keeps one validated cold-start target until the renderer takes it', () => {
    const broker = new MatrixMessageLinkBroker()

    expect(broker.deliver(matrixMessageLink(target))).toBe('accepted')
    expect(broker.take()).toEqual(target)
    expect(broker.take()).toBeNull()
  })

  it('publishes a live delivery while retaining it for a renderer that has not subscribed yet', () => {
    const broker = new MatrixMessageLinkBroker()
    const publish = vi.fn()

    expect(broker.deliver(matrixMessageLink(target), publish)).toBe('accepted')
    expect(publish).toHaveBeenCalledExactlyOnceWith(target)
    expect(broker.take()).toEqual(target)
  })

  it('consumes malformed message routes without publishing and ignores unrelated Atum routes', () => {
    const broker = new MatrixMessageLinkBroker()
    const publish = vi.fn()

    expect(broker.deliver('atum://message/v1/not+base64', publish)).toBe('invalid')
    expect(broker.deliver('atum://auth-callback/state', publish)).toBe('not_message_link')
    expect(publish).not.toHaveBeenCalled()
    expect(broker.take()).toBeNull()
  })
})

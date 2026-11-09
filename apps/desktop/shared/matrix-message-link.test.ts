import { describe, expect, it } from 'vitest'

import {
  isMatrixMessageLinkCandidate,
  matrixMessageLink,
  parseMatrixMessageLink,
  type MatrixMessageLinkTarget
} from './matrix-message-link'

const target: MatrixMessageLinkTarget = {
  companyId: '00000000-0000-4000-8000-4423c334534f',
  roomId: '!general:atum.example',
  eventId: '$event/with+matrix=characters',
  threadRootId: '$thread:atum.example'
}

describe('Team space message links', () => {
  it('round-trips stable identifiers without putting them or display copy in the URL surface', () => {
    const link = matrixMessageLink(target)

    expect(link).toMatch(/^atum:\/\/message\/v1\/[A-Za-z0-9_-]+$/u)
    expect(link).not.toContain(target.companyId)
    expect(link).not.toContain(target.roomId)
    expect(link).not.toContain(target.eventId)
    expect(parseMatrixMessageLink(link)).toEqual(target)
    expect(matrixMessageLink(parseMatrixMessageLink(link)!)).toBe(link)
  })

  it('round-trips a top-level event without manufacturing thread context', () => {
    const topLevel = { companyId: target.companyId, roomId: target.roomId, eventId: target.eventId }

    expect(parseMatrixMessageLink(matrixMessageLink(topLevel))).toEqual({
      companyId: target.companyId,
      roomId: target.roomId,
      eventId: target.eventId
    })
  })

  it.each([
    '',
    'https://message/v1/abc',
    'atum://auth-callback/state',
    'atum://message/v2/abc',
    'atum://message/v1/not+base64',
    'atum://message/v1/eyJjb21wYW55SWQiOiJmb3JnZWQifQ',
    `atum://message/v1/${'a'.repeat(5000)}`,
    'atum://message@evil.example/v1/abc',
    'atum://message/v1/abc?event=$forged',
    'atum://message/v1/abc#fragment'
  ])('rejects malformed or lookalike input: %s', value => {
    expect(parseMatrixMessageLink(value)).toBeNull()
  })

  it('claims malformed message-route attempts without claiming other Atum routes', () => {
    expect(isMatrixMessageLinkCandidate('atum://message/v1/bad+token')).toBe(true)
    expect(isMatrixMessageLinkCandidate('ATUM://message/v1/abc')).toBe(true)
    expect(isMatrixMessageLinkCandidate('atum://auth-callback/state')).toBe(false)
  })

  it('refuses a thread root that is the event itself', () => {
    expect(() => matrixMessageLink({ ...target, threadRootId: target.eventId })).toThrow('matrix_message_link_invalid')
  })
})

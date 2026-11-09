import { describe, expect, it } from 'vitest'

import { MATRIX_MESSAGE_MAX_BYTES, MATRIX_PROMPT_MAX, MATRIX_TURN_QUOTE_MAX, matrixMessageTooLong, matrixRoomTextTooLong } from './matrix'

const vietnamese = 'Xin chào, mình muốn hỏi về kế hoạch tuần tới của nhóm. '

describe('how long one message may be (FR20)', () => {
  it('lets long English and Vietnamese messages through, well past the old 16,000 characters', () => {
    expect(matrixMessageTooLong('a'.repeat(30_000))).toBe(false)
    expect(matrixMessageTooLong(vietnamese.repeat(Math.ceil(20_000 / vietnamese.length)))).toBe(false)
  })

  it('refuses what one encrypted event cannot carry, in any language', () => {
    expect(matrixMessageTooLong('a'.repeat(MATRIX_MESSAGE_MAX_BYTES))).toBe(true)
    // 16,000 Chinese characters are 48,000 bytes: they never fit, though the old limit let them try.
    expect(matrixMessageTooLong('字'.repeat(16_000))).toBe(true)
    expect(matrixMessageTooLong('字'.repeat(13_000))).toBe(false)
    // Escapes count: a body of line breaks doubles when it is written into the event.
    expect(matrixMessageTooLong('\n'.repeat(25_000))).toBe(true)
  })

  it('always fits the 64 KiB Matrix event once encrypted, with room for the event around it', () => {
    // Megolm wraps the JSON plaintext (body plus a few hundred bytes of event fields), pads it
    // and base64-encodes it; the server adds signatures, hashes and references.
    const plaintext = MATRIX_MESSAGE_MAX_BYTES + 1024
    const ciphertext = Math.ceil(((plaintext + 16 + 8 + 16) * 4) / 3)
    expect(ciphertext + 4096).toBeLessThan(64 * 1024)
  })

  it('hands Hermes the longest message with its quote', () => {
    expect(MATRIX_PROMPT_MAX).toBeGreaterThanOrEqual(MATRIX_MESSAGE_MAX_BYTES + MATRIX_TURN_QUOTE_MAX + 2)
  })

  it('still reads what earlier builds sent, and nothing longer than either limit', () => {
    expect(matrixRoomTextTooLong('字'.repeat(16_000))).toBe(false)
    expect(matrixRoomTextTooLong('a'.repeat(30_000))).toBe(false)
    expect(matrixRoomTextTooLong('字'.repeat(20_000))).toBe(true)
  })
})

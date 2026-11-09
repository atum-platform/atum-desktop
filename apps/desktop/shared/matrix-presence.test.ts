import { describe, expect, it } from 'vitest'

import {
  MATRIX_STATUS_TEXT_MAX,
  matrixOwnDnd,
  matrixPresenceState,
  matrixStatusMessage,
  parseMatrixStatusMessage,
  validMatrixStatusInput
} from './matrix-presence'

const NOW = Date.UTC(2026, 9, 30, 8)

describe('Matrix presence and status', () => {
  it('maps observed Matrix states and shows no dot when presence is disabled or absent', () => {
    expect(matrixPresenceState('online', true)).toBe('online')
    expect(matrixPresenceState('unavailable', true)).toBe('away')
    expect(matrixPresenceState('offline', true)).toBe('offline')
    expect(matrixPresenceState('offline', false)).toBeUndefined()
    expect(matrixPresenceState(undefined, false)).toBeUndefined()
  })

  it('round-trips readable emoji, text, DND and expiry through status_msg', () => {
    const input = { emoji: '🏡', text: 'Working from home', dnd: true, expiresAt: NOW + 60 * 60_000 }
    const wire = matrixStatusMessage(input)

    expect(wire).toBe('⛔ DND 🏡 Working from home · until 2026-10-30T09:00:00.000Z')
    expect(parseMatrixStatusMessage(wire, NOW)).toEqual(input)
  })

  it('hides an expired status and DND locally without requiring a server clear', () => {
    const wire = matrixStatusMessage({ text: 'Heads down', dnd: true, expiresAt: NOW + 1_000 })
    expect(parseMatrixStatusMessage(wire, NOW + 999)?.dnd).toBe(true)
    expect(parseMatrixStatusMessage(wire, NOW + 1_000)).toBeUndefined()

    const snapshot = {
      identity: { userId: '@me:test' },
      presence: { users: [{ userId: '@me:test', status: { dnd: true, expiresAt: NOW + 1_000 } }] }
    }
    expect(matrixOwnDnd(snapshot, NOW)).toBe(true)
    expect(matrixOwnDnd(snapshot, NOW + 1_000)).toBe(false)
  })

  it('enforces the 100-character status bound by code point', () => {
    expect(validMatrixStatusInput({ text: 'a'.repeat(MATRIX_STATUS_TEXT_MAX), dnd: false, expiresAt: NOW + 60_000 }, NOW)).toBe(true)
    expect(validMatrixStatusInput({ text: 'a'.repeat(MATRIX_STATUS_TEXT_MAX + 1), dnd: false, expiresAt: NOW + 60_000 }, NOW)).toBe(false)
    expect(validMatrixStatusInput({ text: '😀'.repeat(MATRIX_STATUS_TEXT_MAX), dnd: false, expiresAt: NOW + 60_000 }, NOW)).toBe(true)
    expect(validMatrixStatusInput({ text: '😀'.repeat(MATRIX_STATUS_TEXT_MAX + 1), dnd: false, expiresAt: NOW + 60_000 }, NOW)).toBe(false)
  })
})

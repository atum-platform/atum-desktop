import { describe, expect, it } from 'vitest'

import {
  isMatrixGoogleToolAction,
  MATRIX_GOOGLE_TOOL_ACTIONS,
  MATRIX_GOOGLE_WRITE_ACTIONS,
  type MatrixGoogleAssistantAccess,
  matrixGoogleConnectOffered,
  matrixGoogleModelRoute,
  matrixGoogleServicesOf,
  matrixGoogleToolsUsable
} from './matrix-google-tools'

describe('Google for the default assistant (shared contract)', () => {
  it('keeps an agent that may hold Google data on the protected route, and waits when it is gone', () => {
    expect(matrixGoogleModelRoute({ latched: false, protectedRoute: false })).toBe('open')
    expect(matrixGoogleModelRoute({ latched: false, protectedRoute: true })).toBe('open')
    expect(matrixGoogleModelRoute({ latched: true, protectedRoute: true })).toBe('protected')
    expect(matrixGoogleModelRoute({ latched: true, protectedRoute: false })).toBe('refused')
  })

  it('sums what each account allowed, and counts only connected sources', () => {
    expect(
      matrixGoogleServicesOf([
        { kind: 'email', state: 'connected', writable: false },
        { kind: 'calendar', state: 'reconnect' },
        { kind: 'drive', state: 'connected' }
      ])
    ).toEqual({ gmail: true, send: false, calendar: false, drive: true })

    // Sending needs its own permission on a connected mailbox.
    expect(
      matrixGoogleServicesOf([
        { kind: 'email', state: 'connected', writable: false },
        { kind: 'email', state: 'connected', writable: true }
      ]).send
    ).toBe(true)
    expect(matrixGoogleServicesOf([])).toEqual({ gmail: false, send: false, calendar: false, drive: false })
  })

  it('turns the first-run Connect Google step on only when connecting would help the assistant at once', () => {
    const states: Array<[MatrixGoogleAssistantAccess | undefined, boolean, boolean]> = [
      [undefined, false, false],
      [{ state: 'unavailable', reason: 'route' }, false, false],
      [{ state: 'unavailable', reason: 'own_model' }, false, false],
      [{ state: 'unavailable', reason: 'not_configured' }, false, false],
      [{ state: 'paused', reason: 'route' }, false, false],
      [{ state: 'connect' }, true, false],
      [{ state: 'ready', services: { gmail: false, send: false, calendar: true, drive: false } }, false, true],
      // A ready state that names nothing usable is not usable.
      [{ state: 'ready', services: { gmail: false, send: false, calendar: false, drive: false } }, false, false],
      [{ state: 'ready' }, false, false]
    ]

    for (const [access, offered, usable] of states) {
      expect(matrixGoogleConnectOffered(access), JSON.stringify(access)).toBe(offered)
      expect(matrixGoogleToolsUsable(access), JSON.stringify(access)).toBe(usable)
    }
  })

  it('changes something in Google only through actions that wait for the owner', () => {
    for (const action of MATRIX_GOOGLE_WRITE_ACTIONS) {
      expect(MATRIX_GOOGLE_TOOL_ACTIONS).toContain(action)
    }

    expect([...MATRIX_GOOGLE_WRITE_ACTIONS].every(action => /^(send|create|update)_/.test(action))).toBe(true)
    expect(isMatrixGoogleToolAction('agenda')).toBe(true)
    expect(isMatrixGoogleToolAction('delete_email')).toBe(false)
    expect(isMatrixGoogleToolAction(undefined)).toBe(false)
  })
})

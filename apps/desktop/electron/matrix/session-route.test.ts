import { describe, expect, it, vi } from 'vitest'

import type { MatrixRefreshCause, MatrixRefreshResult, MatrixSnapshot } from '../../shared/matrix'

import {
  MATRIX_SESSION_RESTART_MS,
  matrixChatTokenRefused,
  matrixSessionAction,
  matrixSessionChecks,
  matrixSessionEndedSnapshot
} from './session-route'

const token: MatrixRefreshResult = { ok: true, accessToken: 'new', refreshToken: 'handle' }

const failed = (cause: MatrixRefreshCause, reauthenticate = false): MatrixRefreshResult => ({
  ok: false,
  reauthenticate,
  cause
})

const PASSING: MatrixRefreshCause[] = ['transport', 'discovery', '5xx', 'refused', 'vault', 'unexpected']

const chatting: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MINI' },
  rooms: [{ id: '!room:test', name: 'Atum', membership: 'join', encrypted: true }],
  roomId: '!room:test',
  messages: [],
  error: null,
  domainEnabled: true
}

describe('what the window shows after the sign-in server answers about the chat sign-in', () => {
  it('ends the session only when the server refused the grant, whoever asked', () => {
    expect(matrixSessionAction(failed('session_ended', true), 'engine')).toBe('session_ended')
    expect(matrixSessionAction(failed('session_ended', true), 'main')).toBe('session_ended')
  })

  it('shows an ended session as the compact sign-in with its notice, never the Try again screen', () => {
    const screen = matrixSessionEndedSnapshot(chatting)

    expect(screen).toMatchObject({ state: 'signed_out', identity: null, error: 'matrix_session_ended' })
    expect(screen.rooms).toEqual([])
    expect(screen.roomId).toBeNull()
    // Settings that are not about the account stay as they were.
    expect(screen.domainEnabled).toBe(true)
  })

  it('changes nothing for the engine’s own refresh unless the session ended', () => {
    expect(matrixSessionAction(token, 'engine')).toBe('none')

    for (const cause of PASSING) {
      expect(matrixSessionAction(failed(cause), 'engine')).toBe('none')
    }

    // An old engine, or a sign-out or replacement main is already handling.
    expect(matrixSessionAction(failed('stale', true), 'engine')).toBe('none')
    expect(matrixSessionAction(failed('signed_out', true), 'engine')).toBe('none')
  })

  it('restarts the engine after a refused token when the session is live or the server can’t be reached', () => {
    expect(matrixSessionAction(token, 'main')).toBe('restart')

    for (const cause of PASSING) {
      expect(matrixSessionAction(failed(cause), 'main')).toBe('restart')
    }

    expect(matrixSessionAction(failed('signed_out', true), 'main')).toBe('none')
    expect(matrixSessionAction(failed('stale', true), 'main')).toBe('none')
  })

  it('never restarts the engine for a token the disk is too full to save: the window says so', () => {
    const now = 1_000_000

    expect(matrixSessionAction(failed('disk_full'), 'main')).toBe('disk_full')
    expect(matrixSessionAction(failed('disk_full'), 'main', now - 10_000, now)).toBe('disk_full')
    // The engine's own refresh leaves it to main; the session ending still wins.
    expect(matrixSessionAction(failed('disk_full'), 'engine')).toBe('none')
    expect(matrixSessionAction(failed('session_ended', true), 'main')).toBe('session_ended')
  })

  it('stops after one automatic restart a minute, rather than looping on a refusing homeserver', () => {
    const now = 1_000_000

    expect(matrixSessionAction(token, 'main', now - 10_000, now)).toBe('stopped')
    expect(matrixSessionAction(failed('transport'), 'main', now - 10_000, now)).toBe('stopped')
    expect(matrixSessionAction(token, 'main', now - MATRIX_SESSION_RESTART_MS, now)).toBe('restart')
    // The session ending always wins.
    expect(matrixSessionAction(failed('session_ended', true), 'main', now - 10_000, now)).toBe('session_ended')
  })

  it('recognises the engine’s report of a refused token, and nothing else', () => {
    expect(matrixChatTokenRefused({ state: 'error', error: 'matrix_signed_out' })).toBe(true)
    expect(matrixChatTokenRefused({ state: 'error', error: 'matrix_sdk_start_failed' })).toBe(false)
    expect(matrixChatTokenRefused({ state: 'offline', error: 'matrix_signed_out' })).toBe(false)
    expect(matrixChatTokenRefused({ state: 'ready', error: null })).toBe(false)
  })
})

describe('a refused chat token while a command holds main (pass 4, MEDIUM 3)', () => {
  function checks(engine: { id: string } | undefined = { id: 'engine' }) {
    const state = { busy: false, engine }
    const check = vi.fn()
    const resume = vi.fn()

    const queue = matrixSessionChecks({
      busy: () => state.busy,
      current: () => state.engine,
      check,
      resume
    })

    return { state, check, resume, queue }
  }

  it('is checked at once when nothing holds main', () => {
    const { state, check, queue } = checks()
    queue.refused(state.engine!)
    expect(check).toHaveBeenCalledWith(state.engine)
  })

  it('is checked once the command ends, never dropped', () => {
    const { state, check, queue } = checks()
    state.busy = true
    queue.refused(state.engine!)
    expect(check).not.toHaveBeenCalled()

    state.busy = false
    queue.released()
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(state.engine)

    // Only once.
    queue.released()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("is forgotten when that engine is no longer the person's (signed out, replaced)", () => {
    const { state, check, queue } = checks()
    state.busy = true
    queue.refused(state.engine!)
    state.engine = { id: 'the next engine' }
    state.busy = false
    queue.released()
    expect(check).not.toHaveBeenCalled()

    state.busy = true
    queue.refused(state.engine)
    state.engine = undefined
    state.busy = false
    queue.released()
    expect(check).not.toHaveBeenCalled()
  })

  it('restarts a stopped engine after a saved rotation, once the command ends', () => {
    const { state, resume, queue } = checks()
    queue.renewed()
    expect(resume).toHaveBeenCalledTimes(1)

    state.busy = true
    queue.renewed()
    expect(resume).toHaveBeenCalledTimes(1)
    state.busy = false
    queue.released()
    expect(resume).toHaveBeenCalledTimes(2)
    queue.released()
    expect(resume).toHaveBeenCalledTimes(2)
  })
})

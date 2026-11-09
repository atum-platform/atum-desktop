import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixEndedSession, matrixHumanSnapshot, matrixSavedIdentity, matrixWindowChoice } from './window-launch'

const owner = { userId: '@owner:test', deviceId: 'DEVICE' }

afterEach(() => {
  vi.useRealTimers()
})

describe('the account a window opens with', () => {
  it('is the saved account, so a signed-in Mac never starts on the sign-in screen', () => {
    expect(matrixSavedIdentity({ identity: () => owner, signOutPending: () => false })).toEqual(owner)
  })

  it('is none on a Mac with no account, during an unfinished sign-out, or with an unreadable vault', () => {
    expect(matrixSavedIdentity({ identity: () => null, signOutPending: () => false })).toBeNull()
    expect(matrixSavedIdentity({ identity: () => owner, signOutPending: () => true })).toBeNull()
    expect(
      matrixSavedIdentity({
        identity: () => {
          throw new Error('matrix_vault_unavailable')
        },
        signOutPending: () => false
      })
    ).toBeNull()
  })
})

describe('a session the sign-in server ended', () => {
  it('opens on the compact sign-in, saying so, instead of the launch', () => {
    expect(matrixEndedSession({ sessionEnded: () => ({ cause: 'refresh_rejected:invalid_grant', at: 1 }) })).toBe(true)
    expect(matrixEndedSession({ sessionEnded: () => null })).toBe(false)
  })

  it('is not claimed when the vault cannot be read (the start reports that itself)', () => {
    expect(
      matrixEndedSession({
        sessionEnded: () => {
          throw new Error('matrix_vault_unavailable')
        }
      })
    ).toBe(false)
  })
})

describe("the person's SDK snapshot", () => {
  const failed: MatrixSnapshot = {
    state: 'error',
    identity: null,
    rooms: [],
    roomId: null,
    messages: [],
    error: 'matrix_sdk_start_failed'
  }

  it('keeps the account when its engine could not start, so the window never asks to sign in again', () => {
    expect(matrixHumanSnapshot(failed, owner)).toEqual({ ...failed, identity: owner })
  })

  it('passes a running engine’s own identity through untouched', () => {
    const running: MatrixSnapshot = { ...failed, state: 'ready', identity: owner, error: null }

    expect(matrixHumanSnapshot(running, { userId: '@other:test', deviceId: 'OTHER' })).toBe(running)
  })
})

describe('when the window is shown', () => {
  it('waits for the renderer to choose its size', async () => {
    vi.useFakeTimers()
    const choice = matrixWindowChoice()
    const shown = vi.fn()
    void choice.wait(1_500).then(shown)

    await vi.advanceTimersByTimeAsync(100)
    expect(shown).not.toHaveBeenCalled()
    choice.chosen()
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toHaveBeenCalledOnce()
    // Later choices (every window-mode change) change nothing.
    choice.chosen()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(shown).toHaveBeenCalledOnce()
  })

  it('does not wait at all when the renderer chose while the page was still loading', async () => {
    const choice = matrixWindowChoice()
    choice.chosen()

    await expect(choice.wait(60_000)).resolves.toBeUndefined()
  })

  it('shows it anyway when the renderer never asks', async () => {
    vi.useFakeTimers()
    const choice = matrixWindowChoice()
    const shown = vi.fn()
    void choice.wait(1_500).then(shown)

    await vi.advanceTimersByTimeAsync(1_499)
    expect(shown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(shown).toHaveBeenCalledOnce()
  })
})

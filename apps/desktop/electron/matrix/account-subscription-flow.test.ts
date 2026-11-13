import { describe, expect, it, vi } from 'vitest'

import {
  completeMatrixSubscriptionChatGptFollowUp,
  finishMatrixSubscriptionChatGptPoll,
  MatrixSubscriptionFollowUpRepair,
  matrixSubscriptionAccountAvailable,
  matrixSubscriptionHostHome,
  matrixSubscriptionPlanSignInGate,
  updateMatrixSubscriptionSignIn
} from './account-subscription-flow'
import { matrixHermesHome } from './hermes-runtime'

describe('the account ChatGPT connection state machine', () => {
  it('allows account management with zero assistant hosts or enrollments', () => {
    expect(
      matrixSubscriptionAccountAvailable({
        owner: true,
        runtime: true,
        identity: true,
        closing: false,
        accountReady: true
      })
    ).toBe(true)
  })

  it('starts the credential helper in an account home, not an assistant home', () => {
    const config = { profiles: '/tmp/atum-profiles' }
    const account = matrixSubscriptionHostHome(config, 'owner-principal', 'account-a')
    const anotherAccount = matrixSubscriptionHostHome(config, 'owner-principal', 'account-b')
    const assistant = matrixHermesHome(config, 'owner-principal', 'assistant-executor')

    expect(account).toMatch(/^\/tmp\/atum-profiles\/[a-f0-9]{64}$/u)
    expect(account).not.toBe(anotherAccount)
    expect(account).not.toBe(assistant)
  })

  it('keeps a real provider failure failed and does not run completion work', async () => {
    const complete = vi.fn(async () => ({ relay: 'ok' as const, refresh: 'ok' as const }))

    await expect(
      finishMatrixSubscriptionChatGptPoll(
        { status: 'error' },
        { complete }
      )
    ).resolves.toEqual({ status: 'failed' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('lets an active owner-plan sign-in outrank the signed-out check without consulting cloud access', () => {
    const host = { signIns: 0 }

    updateMatrixSubscriptionSignIn(host, true)
    expect(matrixSubscriptionPlanSignInGate({ ...host, planSignIn: true })).toBe('pending')
    expect(updateMatrixSubscriptionSignIn(host, false)).toBe(true)
    expect(matrixSubscriptionPlanSignInGate({ ...host, planSignIn: true })).toBe('required')
    expect(matrixSubscriptionPlanSignInGate({ ...host, planSignIn: false })).toBeUndefined()
  })
})


it('refreshes agents after OAuth without a relay publication step', async () => {
  const outcome = vi.fn()
  const refresh = vi.fn(async () => {})
  expect(await completeMatrixSubscriptionChatGptFollowUp({ refresh, outcome })).toEqual({ refresh: 'ok' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(outcome).toHaveBeenCalledExactlyOnceWith('agent_refresh', 'ok')
})

it('retries failed agent refresh and cancels its scheduled work on account close', async () => {
  let retry: (() => void) | undefined
  const cancel = vi.fn()
  const refresh = vi.fn(async () => { throw new Error('fixture transport failed') })
  const repair = new MatrixSubscriptionFollowUpRepair({ refresh, current: () => true,
    schedule: run => { retry = run; return cancel } })
  expect(await repair.run()).toEqual({ refresh: 'transport_error' })
  await Promise.resolve()
  expect(retry).toBeTypeOf('function')
  repair.stop()
  expect(cancel).toHaveBeenCalledOnce()
  expect(await repair.run()).toEqual({ refresh: 'cancelled' })
  expect(refresh).toHaveBeenCalledOnce()
})

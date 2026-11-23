import { describe, expect, it, vi } from 'vitest'

import {
  completeMatrixSubscriptionChatGptFollowUp,
  disconnectMatrixSubscriptionChatGpt,
  finishMatrixSubscriptionChatGptPoll,
  matrixSubscriptionAccountAvailable,
  MatrixSubscriptionFollowUpRepair,
  matrixSubscriptionHostHome,
  matrixSubscriptionPlanSignInGate,
  updateMatrixSubscriptionSignIn
} from './account-subscription-flow'
import { matrixHermesHome } from './hermes-runtime'

// The SSH ChatGPT relay is gone (self-work plan §12): the follow-up after a ChatGPT sign-in is the assistant refresh alone.

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

  it('keeps the saved account plan connected after the follow-up refresh runs', async () => {
    const refresh = vi.fn(async () => undefined)

    const result = await finishMatrixSubscriptionChatGptPoll(
      { status: 'approved' },
      { complete: () => completeMatrixSubscriptionChatGptFollowUp({ refresh }) }
    )

    expect(result).toEqual({ status: 'connected' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reports a saved account plan as connected when the follow-up refresh fails', async () => {
    const result = await finishMatrixSubscriptionChatGptPoll(
      { status: 'approved' },
      {
        complete: () =>
          completeMatrixSubscriptionChatGptFollowUp({
            refresh: async () => {
              throw new Error('private refresh detail')
            }
          })
      }
    )

    expect(result).toEqual({ status: 'connected' })
  })

  it('keeps a real provider failure failed and does not run completion work', async () => {
    const complete = vi.fn(async () => ({ refresh: 'ok' as const }))

    await expect(finishMatrixSubscriptionChatGptPoll({ status: 'error' }, { complete })).resolves.toEqual({ status: 'failed' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('records one closed status for the agent refresh', async () => {
    const outcomes: string[] = []

    await expect(
      completeMatrixSubscriptionChatGptFollowUp({
        refresh: async () => undefined,
        outcome: (stage, status) => outcomes.push(`${stage}:${status}`)
      })
    ).resolves.toEqual({ refresh: 'ok' })
    expect(outcomes).toEqual(['agent_refresh:ok'])
  })

  it('classifies a refresh transport failure without leaking error text', async () => {
    const outcomes: string[] = []

    await expect(
      completeMatrixSubscriptionChatGptFollowUp({
        refresh: async () => {
          throw new Error('private refresh detail')
        },
        outcome: (stage, status) => outcomes.push(`${stage}:${status}`)
      })
    ).resolves.toEqual({ refresh: 'transport_error' })
    expect(outcomes).toEqual(['agent_refresh:transport_error'])
    expect(outcomes.join(' ')).not.toContain('private refresh detail')
  })

  it('classifies a refresh timeout', async () => {
    const timeout = new Error('private timeout detail')

    timeout.name = 'TimeoutError'

    await expect(
      completeMatrixSubscriptionChatGptFollowUp({
        refresh: async () => {
          throw timeout
        }
      })
    ).resolves.toEqual({ refresh: 'timeout' })
  })

  it('retries a failed refresh in the background and stops after it succeeds', async () => {
    const scheduled: (() => void)[] = []
    const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)

    const repair = new MatrixSubscriptionFollowUpRepair({
      refresh,
      current: () => true,
      retryDelays: [10],
      schedule: run => {
        scheduled.push(run)

        return () => undefined
      }
    })

    await expect(repair.run()).resolves.toEqual({ refresh: 'transport_error' })
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    expect(scheduled).toHaveLength(1)
  })

  it('a stopped or no-longer-current repair does nothing', async () => {
    const refresh = vi.fn(async () => undefined)
    const stopped = new MatrixSubscriptionFollowUpRepair({ refresh, current: () => true })
    const stale = new MatrixSubscriptionFollowUpRepair({ refresh, current: () => false })

    stopped.stop()

    await expect(stopped.run()).resolves.toEqual({ refresh: 'cancelled' })
    await expect(stale.run()).resolves.toEqual({ refresh: 'cancelled' })
    expect(refresh).not.toHaveBeenCalled()
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

describe('ChatGPT sign-in and disconnect', () => {
  it('stops the repair, disconnects natively, then forgets the credential', async () => {
    const order: string[] = []

    await disconnectMatrixSubscriptionChatGpt({
      stopRepair: () => order.push('stop-repair'),
      disconnect: async () => void order.push('disconnect'),
      forget: async () => void order.push('forget')
    })

    expect(order).toEqual(['stop-repair', 'disconnect', 'forget'])
  })

  it('still forgets the credential when the native disconnect fails', async () => {
    const order: string[] = []

    await disconnectMatrixSubscriptionChatGpt({
      stopRepair: () => order.push('stop-repair'),
      disconnect: async () => {
        order.push('disconnect')
        throw new Error('offline')
      },
      forget: async () => void order.push('forget')
    })

    expect(order).toEqual(['stop-repair', 'disconnect', 'forget'])
  })

  it('a new sign-in refreshes assistants again, whatever an earlier flight settled', async () => {
    const refresh = vi.fn(async () => undefined)
    const repair = new MatrixSubscriptionFollowUpRepair({ refresh, current: () => true })

    expect(await repair.renew()).toEqual({ refresh: 'ok' })
    expect(await repair.renew()).toEqual({ refresh: 'ok' })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

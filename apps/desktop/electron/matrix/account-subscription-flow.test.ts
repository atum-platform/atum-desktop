import { describe, expect, it, vi } from 'vitest'

import type { MatrixSubscriptionsStatus } from '../../shared/matrix-subscriptions'

import {
  completeMatrixSubscriptionChatGptFollowUp,
  finishMatrixSubscriptionChatGptPoll,
  matrixSubscriptionAccountAvailable,
  MatrixSubscriptionFollowUpRepair,
  matrixSubscriptionHostHome,
  matrixSubscriptionPlanSignInGate,
  matrixSubscriptionsWithChatGptRelay,
  updateMatrixSubscriptionSignIn
} from './account-subscription-flow'
import { matrixHermesHome } from './hermes-runtime'

const localConnected: MatrixSubscriptionsStatus = {
  scope: 'account',
  providers: [
    { id: 'openai-codex', connected: true },
    { id: 'opencode-go', connected: false }
  ]
}

const disabledRelay = { revision: 0, state: 'disabled' as const, models: [] }
const enabledRelay = {
  revision: 1,
  state: 'enabled' as const,
  deviceServiceId: '00000000-0000-4000-8000-bd7662a5eeb4',
  selectedAt: 1,
  models: [
    {
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      efforts: ['low', 'medium', 'high'] as const,
      defaultEffort: 'medium' as const,
      contextBudget: 128_000,
      outputBudget: 16_384
    }
  ]
}

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

  it('keeps the saved account plan connected after optional relay registration, then lists relay models', async () => {
    let relay = disabledRelay as typeof disabledRelay | typeof enabledRelay
    const order: string[] = []

    const result = await finishMatrixSubscriptionChatGptPoll(
      { status: 'approved' },
      {
        complete: () => completeMatrixSubscriptionChatGptFollowUp({
          registerRelay: async () => {
            order.push('relay')
            relay = enabledRelay
            return true
          },
          refresh: async () => {
            order.push('refresh')
          }
        })
      }
    )

    const status = matrixSubscriptionsWithChatGptRelay(
      localConnected,
      relay,
      enabledRelay.deviceServiceId
    )

    expect(result).toEqual({ status: 'connected' })
    expect(order).toEqual(['relay', 'refresh'])
    expect(status.providers[0]).toMatchObject({
      id: 'openai-codex',
      connected: true,
      localConnected: true,
      models: ['gpt-5.6-luna'],
      relay: { state: 'enabled', thisMac: true, revision: 1 }
    })
  })

  it('reports a saved account plan as connected when optional relay registration fails', async () => {
    const refresh = vi.fn(async () => undefined)
    const result = await finishMatrixSubscriptionChatGptPoll(
      { status: 'approved' },
      { complete: () => completeMatrixSubscriptionChatGptFollowUp({ registerRelay: async () => false, refresh }) }
    )
    const status = matrixSubscriptionsWithChatGptRelay(localConnected, disabledRelay, undefined)

    expect(result).toEqual({ status: 'connected' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(status.providers[0]).toMatchObject({
      id: 'openai-codex',
      connected: true,
      localConnected: true,
      relay: { state: 'disabled' }
    })
    expect(status.providers[0]?.models).toBeUndefined()
  })

  it('reports this Mac’s last-read plan models while the relay is not up, without making it a cloud plan', () => {
    const status = matrixSubscriptionsWithChatGptRelay(localConnected, disabledRelay, undefined, true, enabledRelay.models)

    expect(status.providers[0]).toMatchObject({
      id: 'openai-codex',
      connected: true,
      localConnected: true,
      models: ['gpt-5.6-luna'],
      relay: { state: 'disabled', thisMac: false }
    })

    // A signed-out plan never borrows a stale model list.
    const signedOut = matrixSubscriptionsWithChatGptRelay(
      { scope: 'account', providers: [{ id: 'openai-codex', connected: false }, { id: 'opencode-go', connected: false }] },
      disabledRelay,
      undefined,
      true,
      enabledRelay.models
    )
    expect(signedOut.providers[0]?.models).toBeUndefined()
  })

  it('reads the saved account plan when optional relay status cannot be read', () => {
    expect(matrixSubscriptionsWithChatGptRelay(localConnected, undefined, undefined, true).providers[0]).toEqual({
      id: 'openai-codex',
      connected: true,
      localConnected: true,
      source: 'platform',
      models: undefined,
      modelDetails: undefined
    })
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

  it('records one closed status for successful relay publication and agent refresh', async () => {
    const outcomes: string[] = []

    await expect(completeMatrixSubscriptionChatGptFollowUp({
      registerRelay: async () => true,
      refresh: async () => undefined,
      outcome: (stage, status) => outcomes.push(`${stage}:${status}`)
    })).resolves.toEqual({ relay: 'ok', refresh: 'ok' })
    expect(outcomes).toEqual(['relay_publication:ok', 'agent_refresh:ok'])
  })

  it('classifies an unavailable relay and refresh transport failure without leaking error text', async () => {
    const outcomes: string[] = []

    await expect(completeMatrixSubscriptionChatGptFollowUp({
      registerRelay: async () => false,
      refresh: async () => { throw new Error('private refresh detail') },
      outcome: (stage, status) => outcomes.push(`${stage}:${status}`)
    })).resolves.toEqual({ relay: 'unavailable', refresh: 'transport_error' })
    expect(outcomes).toEqual(['relay_publication:unavailable', 'agent_refresh:transport_error'])
    expect(outcomes.join(' ')).not.toContain('private refresh detail')
  })

  it('classifies relay timeouts and still refreshes assistants', async () => {
    const refresh = vi.fn(async () => undefined)
    const timeout = new Error('private timeout detail')
    timeout.name = 'TimeoutError'

    await expect(completeMatrixSubscriptionChatGptFollowUp({
      registerRelay: async () => { throw timeout },
      refresh
    })).resolves.toEqual({ relay: 'timeout', refresh: 'ok' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('retries a failed relay in the background and stops after both follow-ups succeed', async () => {
    const scheduled: Array<() => void> = []
    const registerRelay = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const refresh = vi.fn(async () => undefined)
    const repair = new MatrixSubscriptionFollowUpRepair({
      registerRelay,
      refresh,
      current: () => true,
      retryDelays: [10],
      schedule: run => {
        scheduled.push(run)
        return () => undefined
      }
    })

    await expect(repair.run()).resolves.toEqual({ relay: 'unavailable', refresh: 'ok' })
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    await vi.waitFor(() => {
      expect(registerRelay).toHaveBeenCalledTimes(2)
      expect(refresh).toHaveBeenCalledOnce()
    })
    expect(scheduled).toHaveLength(1)
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

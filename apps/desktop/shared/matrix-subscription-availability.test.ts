import { describe, expect, it } from 'vitest'

import type { MatrixCloudModelChoiceView } from './matrix-models'
import {
  matrixAccountPlanAvailability,
  matrixCloudPlanAvailability,
  matrixCurrentPlanAvailability
} from './matrix-subscription-availability'
import type { MatrixSubscriptionProviderStatus } from './matrix-subscriptions'

const chatgpt = (relay?: MatrixSubscriptionProviderStatus['relay']): MatrixSubscriptionProviderStatus => ({
  id: 'openai-codex',
  connected: relay?.state === 'enabled',
  localConnected: false,
  models: ['gpt-6-sol'],
  ...(relay ? { relay } : {})
})

const enabled = { state: 'enabled' as const, thisMac: false, revision: 3 }
const disabled = { state: 'disabled' as const, thisMac: false, revision: 3 }

const plan = (
  source: 'chatgpt_plan' | 'opencode_go',
  extra: Partial<MatrixCloudModelChoiceView> = {}
): MatrixCloudModelChoiceView => ({
  offered: ['default'],
  subscription: { source, model: 'gpt-6-sol', effort: 'medium', displayName: 'GPT-6 Sol' },
  subscriptionState: 'connected',
  ...extra
})

describe('which plan can answer a cloud assistant now', () => {
  it('reads the relay Mac’s presence first, whatever the registration says', () => {
    expect(matrixAccountPlanAvailability(chatgpt({ ...enabled, presence: 'online' }))).toEqual({ available: true })
    expect(matrixAccountPlanAvailability(chatgpt({ ...enabled, presence: 'offline' }))).toEqual({
      available: false,
      reason: 'mac_offline'
    })
    expect(matrixAccountPlanAvailability(chatgpt({ ...disabled, presence: 'none' }))).toEqual({
      available: false,
      reason: 'no_mac'
    })
  })

  it('falls back to the relay registration while the platform sends no presence', () => {
    expect(matrixAccountPlanAvailability(chatgpt(enabled))).toEqual({ available: true })
    expect(matrixAccountPlanAvailability(chatgpt(disabled))).toEqual({ available: false, reason: 'no_mac' })
    // No relay registered at all.
    expect(matrixAccountPlanAvailability(chatgpt())).toEqual({ available: false, reason: 'no_mac' })
  })

  it('treats OpenCode Go as account-wide: only a lapsed key makes it unavailable', () => {
    expect(matrixAccountPlanAvailability({ id: 'opencode-go', connected: true })).toEqual({ available: true })
    expect(matrixAccountPlanAvailability({ id: 'opencode-go', connected: false })).toEqual({
      available: false,
      reason: 'reconnect'
    })
    expect(matrixAccountPlanAvailability(undefined)).toBeUndefined()
  })

  it('reads a saved cloud plan from the snapshot alone, and says nothing for an Atum pick', () => {
    expect(matrixCloudPlanAvailability({ offered: ['default'], current: 'default' })).toBeUndefined()
    expect(matrixCloudPlanAvailability(plan('chatgpt_plan'))).toEqual({ available: true })
    expect(matrixCloudPlanAvailability(plan('chatgpt_plan', { relayPresence: 'offline' }))).toEqual({
      available: false,
      reason: 'mac_offline'
    })
    expect(matrixCloudPlanAvailability(plan('chatgpt_plan', { subscriptionState: 'revoked' }))).toEqual({
      available: false,
      reason: 'no_mac'
    })
    expect(matrixCloudPlanAvailability(plan('opencode_go', { subscriptionState: 'revoked' }))).toEqual({
      available: false,
      reason: 'reconnect'
    })
  })

  it('prefers the fresher account read for the chip, and the snapshot when there is none', () => {
    const choice = plan('chatgpt_plan')
    expect(matrixCurrentPlanAvailability({ choice, account: null })).toEqual({ available: true })
    expect(
      matrixCurrentPlanAvailability({ choice, account: [chatgpt({ ...enabled, presence: 'offline' })] })
    ).toEqual({ available: false, reason: 'mac_offline' })
    // An account read without that provider leaves the snapshot's answer standing.
    expect(
      matrixCurrentPlanAvailability({ choice, account: [{ id: 'opencode-go', connected: true }] })
    ).toEqual({ available: true })
    expect(matrixCurrentPlanAvailability({ choice: undefined, account: [chatgpt(enabled)] })).toBeUndefined()
  })
})

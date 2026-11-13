import { describe, expect, it } from 'vitest'

import type { MatrixSubscriptionProviderStatus, MatrixSubscriptionsStatus } from '../../shared/matrix-subscriptions'

import { matrixSubscriptionView } from './subscription-view'

const status = (...providers: MatrixSubscriptionProviderStatus[]): MatrixSubscriptionsStatus => ({
  scope: 'account',
  providers: [
    ...providers,
    ...(['openai-codex', 'opencode-go'] as const)
      .filter(id => !providers.some(provider => provider.id === id))
      .map(id => ({ id, connected: false }))
  ]
})

const macOnly: MatrixSubscriptionProviderStatus = {
  id: 'openai-codex',
  connected: true,
  localConnected: true,
  relay: { state: 'disabled', thisMac: false, revision: 3 }
}

describe('one Settings state per subscription status', () => {
  it('maps every real state to exactly one state and at most one action', () => {
    const cases: [Parameters<typeof matrixSubscriptionView>[0], string, string | undefined][] = [
      [{ status: null }, 'loading', 'connect'],
      [{ status: null, readFailed: true }, 'unavailable', 'reload'],
      [{ status: status() }, 'not_connected', 'connect'],
      [{ status: status({ id: 'openai-codex', connected: false, needsSignIn: true }) }, 'needs_sign_in', 'sign_in'],
      [
        {
          status: status({
            id: 'openai-codex',
            connected: true,
            localConnected: true,
            relay: { state: 'enabled', thisMac: true, revision: 4 }
          })
        },
        'ready',
        'manage'
      ],
      [{ status: status(macOnly) }, 'ready', 'manage'],
      [{ status: status(macOnly) }, 'ready', 'manage'],
      [{ status: status(macOnly) }, 'ready', 'manage']
    ]

    for (const [input, state, action] of cases) {
      const view = matrixSubscriptionView(input)

      expect(view.state, state).toBe(state)
      expect(view.action, state).toBe(action)
    }
  })

  it('reads a plan served by another Mac as ready here, with nothing to set up', () => {
    const view = matrixSubscriptionView({
      status: status({
        id: 'openai-codex',
        connected: true,
        localConnected: false,
        relay: { state: 'enabled', thisMac: false, revision: 2 }
      }),
    })

    expect(view).toMatchObject({ state: 'ready', provider: 'openai-codex' })
  })

  it('names the connected plan, and puts a this-Mac ChatGPT first', () => {
    expect(matrixSubscriptionView({ status: status({ id: 'opencode-go', connected: true }) })).toMatchObject({
      state: 'ready',
      provider: 'opencode-go'
    })
    expect(
      matrixSubscriptionView({ status: status({ id: 'opencode-go', connected: true }, macOnly) })
    ).toMatchObject({ state: 'ready', provider: 'openai-codex' })
  })

  it('never reads a quarantined sign-in as connected or as never linked', () => {
    const view = matrixSubscriptionView({
      status: status({ id: 'openai-codex', connected: false, needsSignIn: true }),
    })

    expect(view.state).toBe('needs_sign_in')
  })
})

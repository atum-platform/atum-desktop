import { describe, expect, it } from 'vitest'

import { matrixSubscriptionCatalogFromSnapshot, matrixSubscriptionCatalogWithGrant } from './subscriptions'

const snapshot = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
  providers: [
    {
      id: 'openai-codex',
      name: 'Codex',
      ready: true,
      current: true,
      models: ['gpt-5.6-luna', 'gpt-6-sol'],
      keyAvailable: false,
      keySet: false,
      oauth: { flow: 'device_code' as const, connected: true, supported: true, disconnectable: true }
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      ready: true,
      current: false,
      models: ['kimi-k3', 'glm-5.3'],
      keyAvailable: true,
      keySet: true,
      oauth: null
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      ready: true,
      current: false,
      models: ['private/model'],
      keyAvailable: true,
      keySet: true,
      oauth: null
    }
  ]
}

describe('subscription catalog', () => {
  it('lists only the two account subscriptions and their safe model names', () => {
    expect(matrixSubscriptionCatalogFromSnapshot(snapshot)).toEqual({
      destination: 'this_mac',
      providers: [
        { id: 'openai-codex', connected: true, models: ['gpt-5.6-luna', 'gpt-6-sol'] },
        { id: 'opencode-go', connected: true, models: ['kimi-k3', 'glm-5.3'] }
      ]
    })
  })

  it('gives a signed-out subscription no models at all', () => {
    const signedOut = {
      ...snapshot,
      providers: snapshot.providers.map(row =>
        row.id === 'openai-codex'
          ? { ...row, ready: false, oauth: { ...row.oauth!, connected: false } }
          : row
      )
    }

    expect(matrixSubscriptionCatalogFromSnapshot(signedOut).providers[0]).toEqual({
      id: 'openai-codex',
      connected: false
    })
  })
})

describe('the account grant beside an assistant’s live view', () => {
  const signedOut = {
    destination: 'this_mac' as const,
    providers: [
      { id: 'openai-codex' as const, connected: false },
      { id: 'opencode-go' as const, connected: false }
    ]
  }

  it('marks a quarantined ChatGPT sign-in as needing sign-in, and nothing else', () => {
    expect(matrixSubscriptionCatalogWithGrant(signedOut, 'needs_sign_in').providers).toEqual([
      { id: 'openai-codex', connected: false, needsSignIn: true },
      { id: 'opencode-go', connected: false }
    ])
    expect(matrixSubscriptionCatalogWithGrant(signedOut, 'none')).toEqual(signedOut)
    expect(matrixSubscriptionCatalogWithGrant(signedOut, 'saved')).toEqual(signedOut)
  })

  it('never overrides an assistant that already answers on the plan', () => {
    const live = matrixSubscriptionCatalogFromSnapshot(snapshot)
    expect(matrixSubscriptionCatalogWithGrant(live, 'needs_sign_in')).toEqual(live)
  })
})

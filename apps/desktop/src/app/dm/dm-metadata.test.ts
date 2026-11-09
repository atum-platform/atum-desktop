import { describe, expect, it } from 'vitest'

import { isSpecialistPending, parseDmMetadata, parseMentionDispatch, parseSpecialistDispatch } from './dm-metadata'

const andySender = { type: 'agent', id: 'andy' }
const thirdProviderSender = { type: 'specialist', id: 'provider-memory' }

describe('parseDmMetadata', () => {
  it('renders nothing extra when the plane sends no metadata', () => {
    expect(parseDmMetadata(null)).toBeNull()
    expect(parseDmMetadata(undefined)).toBeNull()
    expect(parseDmMetadata({})).toBeNull()
  })

  it('keeps the legacy Andy receipt only on Andy messages', () => {
    for (const outcome of ['supplied', 'granted_empty', 'not_authorized', 'revoked'] as const) {
      expect(parseDmMetadata({ andy_memory: { v: 1, outcome, used: outcome === 'supplied' } }, andySender)?.providerMemory).toEqual({
        outcome,
        used: outcome === 'supplied',
        v: 1
      })
    }
  })

  it('tolerates a memory triple without `used` or `v`', () => {
    expect(parseDmMetadata({ andy_memory: { outcome: 'revoked' } }, andySender)?.providerMemory).toEqual({
      outcome: 'revoked',
      used: null,
      v: null
    })
  })

  it('ignores an outcome label it does not recognise rather than rendering it', () => {
    expect(parseDmMetadata({ andy_memory: { v: 2, outcome: 'partially_supplied' } }, andySender)).toBeNull()
  })

  it('uses the exact generic receipt for a third-party provider', () => {
    expect(parseDmMetadata({ provider_memory: { v: 1, outcome: 'supplied', used: true } }, thirdProviderSender)?.providerMemory).toEqual({
      outcome: 'supplied', used: true, v: 1
    })
  })

  it('keeps malformed or future generic receipts unknown and does not fall back to Andy', () => {
    expect(parseDmMetadata({ provider_memory: { v: 2, outcome: 'supplied', used: true }, andy_memory: { v: 1, outcome: 'supplied', used: true } }, andySender)).toBeNull()
    expect(parseDmMetadata({ provider_memory: { v: 1, outcome: 'supplied' } }, thirdProviderSender)).toBeNull()
  })

  it('never applies a provider receipt to a human or assistant spoof', () => {
    const metadata = { provider_memory: { v: 1, outcome: 'supplied', used: true }, andy_memory: { v: 1, outcome: 'supplied', used: true } }

    expect(parseDmMetadata(metadata, { type: 'account', id: 'andy' })).toBeNull()
    expect(parseDmMetadata(metadata, { type: 'assistant', id: 'andy' })).toBeNull()
  })

  it('reads specialist dispatch state, specialist, and error code', () => {
    expect(
      parseSpecialistDispatch({ specialist_dispatch: { state: 'failed', specialist: 'moon', error_code: 'x' } })
    ).toEqual({ errorCode: 'x', specialist: 'moon', state: 'failed' })
  })

  it('ignores an unrecognised dispatch state', () => {
    expect(parseSpecialistDispatch({ specialist_dispatch: { state: 'quantum' } })).toBeNull()
  })

  it('reads both groups on one message', () => {
    const metadata = parseDmMetadata({
      andy_memory: { v: 1, outcome: 'supplied', used: true },
      specialist_dispatch: { state: 'succeeded', specialist: 'andy' }
    }, andySender)

    expect(metadata?.providerMemory?.outcome).toBe('supplied')
    expect(metadata?.specialistDispatch?.state).toBe('succeeded')
  })

  it('reads mention state and its allowlisted terminal reason', () => {
    expect(parseMentionDispatch({ mention_dispatch: { state: 'dead_lettered', agent: 'binh-minh', revision: 0, error_code: 'allowance_exhausted' } })).toEqual({
      errorCode: 'allowance_exhausted', provenanceVerified: true, state: 'dead_lettered'
    })
  })

  it('keeps provider state visible without treating missing or forged identity as verified provenance', () => {
    expect(parseMentionDispatch({ mention_dispatch: { state: 'completed' } })?.provenanceVerified).toBe(false)
    expect(parseMentionDispatch({ mention_dispatch: { state: 'completed', agent: 'moon', revision: 0 } })?.provenanceVerified).toBe(false)
    expect(parseMentionDispatch({ mention_dispatch: { state: 'completed', agent: 'binh-minh', revision: 1 } })?.provenanceVerified).toBe(false)
  })

  it('never throws on a malformed payload', () => {
    for (const value of ['string', 42, [], { andy_memory: 'supplied' }, { specialist_dispatch: [] }, { a: { b: 1 } }]) {
      expect(parseDmMetadata(value)).toBeNull()
    }
  })
})

it('reads independently terminal per-target delivery states and reply identity snapshots', () => {
  expect(parseDmMetadata({
    target_dispatches: [
      { target_type: 'assistant', target_id: 'assistant-1', display_name: 'Mai', avatar: '🌸', revision: 1, state: 'completed' },
      { target_type: 'assistant', target_id: 'assistant-2', display_name: 'Minh', avatar: '🌅', revision: 1, state: 'dead_lettered', error_code: 'provider_unavailable' }
    ],
    assistant_identity: { id: 'assistant-1', owner_user_id: 'account-a', display_name: 'Mai', avatar: '🌸', revision: 1 }
  })).toMatchObject({
    assistantIdentity: { id: 'assistant-1', displayName: 'Mai', avatar: '🌸' },
    targetDispatches: [{ displayName: 'Mai', state: 'completed' }, { displayName: 'Minh', state: 'dead_lettered' }]
  })
})

it('keeps a complete participant snapshot separate from legacy identity groups', () => {
  const appId = '00000000-0000-4000-8000-bd7662a5eeb4'
  const ownerId = '00000000-0000-4000-8000-b454f82c5857'

  expect(parseDmMetadata({
    participant: {
      kind: 'app', id: appId, owner_user_id: ownerId, display_name: 'Moon at publication',
      owner_display_name: 'Alice at publication', avatar_url: 'https://cdn.atum.test/moon-before.png'
    },
    specialist_identity: { specialist: 'moon', display_name: 'Moon today', avatar: '☾', revision: 1 },
    assistant_identity: { id: ownerId, display_name: 'Unrelated assistant', avatar: '🌿', revision: 1 }
  })?.participant).toEqual({
    kind: 'app', id: appId, ownerUserId: ownerId, displayName: 'Moon at publication',
    ownerDisplayName: 'Alice at publication', avatarUrl: 'https://cdn.atum.test/moon-before.png'
  })
})

it('does not combine incomplete participant fields with a legacy identity group', () => {
  expect(parseDmMetadata({
    participant: { kind: 'app', id: '00000000-0000-4000-8000-bd7662a5eeb4', display_name: 'Moon' },
    specialist_identity: { specialist: 'moon', display_name: 'Moon legacy', avatar: '☾', revision: 1 }
  })).toBeNull()
})

describe('isSpecialistPending', () => {
  it('is true only while the specialist has not answered', () => {
    expect(isSpecialistPending({ errorCode: null, specialist: null, state: 'pending' })).toBe(true)
    expect(isSpecialistPending({ errorCode: null, specialist: null, state: 'dispatched' })).toBe(true)
    expect(isSpecialistPending({ errorCode: null, specialist: null, state: 'running' })).toBe(true)
    expect(isSpecialistPending({ errorCode: null, specialist: null, state: 'succeeded' })).toBe(false)
    expect(isSpecialistPending({ errorCode: null, specialist: null, state: 'failed' })).toBe(false)
    expect(isSpecialistPending(null)).toBe(false)
  })
})


it('keeps a historical assistant photo separate from its symbol and rejects unsafe locations', () => {
  const avatarUrl = 'https://storage.atum.test/avatars/' + 'a'.repeat(300) + '.png'
  const base = { id: 'assistant-1', display_name: 'Mai', avatar: '🌸' }
  expect(parseDmMetadata({ assistant_identity: { ...base, avatar_url: avatarUrl } })?.assistantIdentity)
    .toMatchObject({ id: 'assistant-1', avatar: '🌸', avatarUrl })

  for (const unsafe of ['file:///private/avatar.png', 'javascript:alert(1)', 'https://user:password@example.test/a', 'https://x/' + 'a'.repeat(2048)]) {
    expect(parseDmMetadata({ assistant_identity: { ...base, avatar_url: unsafe } })?.assistantIdentity).not.toHaveProperty('avatarUrl')
  }
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

import {
  $atumAgentArrangements,
  $atumAgentOrder,
  $atumAgentPins,
  $atumAgents,
  $atumNewChatAgent,
  agentIdForSession,
  ATUM_AGENT_ID,
  ATUM_MANAGED_BY,
  projectAtumAgents,
  reorderAtumAgents,
  resetAtumAgentArrangement,
  setAtumAgentArrangementForAccount,
  setAtumAgentPinned
} from './agents'

const profile = (overrides: Partial<ProfileInfo> = {}): ProfileInfo => ({
  has_env: true,
  is_default: false,
  model: 'binh-minh',
  name: 'mkt-taylor',
  path: '/home/.hermes/profiles/mkt-taylor',
  provider: null,
  skill_count: 3,
  ...overrides
})

describe('projectAtumAgents', () => {
  it('always leads with the master assistant, even before any profile has loaded', () => {
    const agents = projectAtumAgents([])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toEqual({
      id: ATUM_AGENT_ID,
      arrangementId: ATUM_AGENT_ID,
      localProfileId: ATUM_AGENT_ID,
      // Empty until the backend reports one: an identity is minted there,
      // never invented here.
      identityId: '',
      lifecycleRevision: 0,
      // Empty on purpose: the master's name is localized product copy the
      // roster supplies, not something this projection invents.
      title: '',
      avatar: '',
      hostedId: null,
      avatarUrl: null,
      description: '',
      isDefault: true,
      isManaged: true,
      pinned: false,
      definitionState: 'local_only',
      participant: undefined
    })
  })

  it('projects a named agent from its identity metadata and sorts by what the user reads', () => {
    const agents = projectAtumAgents([
      profile({ avatar: '📣', display_name: 'Trợ lý Marketing', managed_by: 'atum', name: 'mkt' }),
      profile({ display_name: 'Alfred', description: 'Household operations.', managed_by: 'ATUM', name: 'alfred' })
    ])

    expect(agents.map(agent => agent.title)).toEqual(['', 'Alfred', 'Trợ lý Marketing'])
    expect(agents[1]).toMatchObject({
      id: 'alfred',
      description: 'Household operations.',
      isManaged: true,
      pinned: false
    })
    expect(agents[2]).toMatchObject({ id: 'mkt', avatar: '📣', isDefault: false })
  })

  it('uses hosted display names and photo URLs for synchronized identities', () => {
    const agents = projectAtumAgents(
      [
        profile({ identity_id: 'master-id', is_default: true, name: 'default' }),
        profile({ display_name: 'Local Marketing', identity_id: 'named-id', managed_by: 'atum', name: 'marketing' })
      ],
      undefined,
      {
        accountId: 'account-a',
        state: 'ready',
        entries: [
          {
            avatarUrl: 'https://cdn.atum.test/master.webp',
            displayName: 'Hosted Atum',
            id: 'master-row',
            identityId: 'master-id',
            isDefault: true,
            lifecycleRevision: 8,
            status: 'active'
          },
          {
            avatarUrl: 'https://cdn.atum.test/named.webp',
            displayName: 'Old hosted name',
            id: 'named-row',
            identityId: 'named-id',
            isDefault: false,
            lifecycleRevision: 3,
            status: 'active'
          }
        ]
      }
    )

    expect(agents[0]).toMatchObject({
      avatarUrl: 'https://cdn.atum.test/master.webp',
      hostedId: 'master-row',
      title: 'Hosted Atum'
    })
    expect(agents[1]).toMatchObject({
      avatarUrl: 'https://cdn.atum.test/named.webp',
      hostedId: 'named-row',
      title: 'Old hosted name'
    })
    expect(agents[0]?.participant).toMatchObject({ kind: 'assistant', id: 'master-row', ownerUserId: 'account-a' })
    expect(agents[1]?.participant).toMatchObject({ kind: 'assistant', id: 'named-row', ownerUserId: 'account-a' })
  })

  it('keeps a legacy master mapped to its hosted default while an unmatched named clone has no master fallback', () => {
    const agents = projectAtumAgents(
      [
        profile({ is_default: true, name: 'default' }),
        profile({ display_name: 'Marketing clone', identity_id: 'clone-identity', name: 'marketing-clone' })
      ],
      undefined,
      {
        accountId: 'account-a',
        state: 'ready',
        entries: [
          {
            avatarUrl: null,
            displayName: 'Hosted Atum',
            id: 'master-row',
            identityId: null,
            isDefault: true,
            lifecycleRevision: 1,
            status: 'active'
          }
        ]
      }
    )

    expect(agents[0]).toMatchObject({
      hostedId: 'master-row',
      participant: { id: 'master-row', ownerUserId: 'account-a' }
    })
    expect(agents[1]).toMatchObject({ hostedId: null, participant: undefined })
  })

  it('keeps clones distinct by their backend identities rather than their profile labels', () => {
    const agents = projectAtumAgents(
      [
        profile({ display_name: 'Marketing', identity_id: 'identity-one', name: 'marketing' }),
        profile({ display_name: 'Marketing', identity_id: 'identity-two', name: 'marketing-copy' })
      ],
      undefined,
      {
        accountId: 'account-a',
        state: 'ready',
        entries: [
          {
            avatarUrl: null,
            displayName: 'Marketing',
            id: 'hosted-one',
            identityId: 'identity-one',
            isDefault: false,
            lifecycleRevision: 1,
            status: 'active'
          },
          {
            avatarUrl: null,
            displayName: 'Marketing',
            id: 'hosted-two',
            identityId: 'identity-two',
            isDefault: false,
            lifecycleRevision: 1,
            status: 'active'
          }
        ]
      }
    )

    expect(agents.slice(1).map(agent => agent.participant?.id)).toEqual(['hosted-one', 'hosted-two'])
  })

  it('projects a downloadable cloud identity as a setup row and hides a retired local identity', () => {
    const directory = {
      accountId: 'account-a',
      state: 'ready' as const,
      entries: [
        {
          avatar: '',
          avatarUrl: null,
          definitionRevision: 4,
          displayName: 'Marketing',
          id: 'cloud-marketing',
          identityId: 'marketing-id',
          identityRevision: 7,
          isDefault: false,
          lifecycleRevision: 1,
          status: 'active' as const
        },
        {
          avatar: '',
          avatarUrl: null,
          definitionRevision: 2,
          displayName: 'Retired',
          id: 'cloud-retired',
          identityId: 'retired-id',
          identityRevision: 3,
          isDefault: false,
          lifecycleRevision: 1,
          status: 'retired' as const
        }
      ]
    }

    const agents = projectAtumAgents(
      [profile({ identity_id: 'retired-id', managed_by: 'atum', name: 'retired' })],
      undefined,
      directory
    )

    expect(agents.map(agent => agent.id)).toEqual([ATUM_AGENT_ID, 'cloud:cloud-marketing'])
    expect(agents[1]).toMatchObject({
      arrangementId: 'marketing-id',
      definitionState: 'setup',
      localProfileId: null,
      title: 'Marketing'
    })
  })

  it('falls back to a readable form of the id when an agent has no display name', () => {
    const agents = projectAtumAgents([profile({ name: 'mkt-taylor' }), profile({ name: 'dev_ben' })])

    expect(agents.map(agent => agent.title)).toEqual(['', 'Dev Ben', 'Mkt Taylor'])
  })

  it('marks only Atum-created agents as managed, so a hand-made profile is never rewritten', () => {
    const agents = projectAtumAgents([
      profile({ managed_by: ATUM_MANAGED_BY, name: 'made-by-atum' }),
      profile({ managed_by: '', name: 'made-by-hand' }),
      profile({ name: 'no-metadata-at-all' })
    ])

    expect(agents.find(agent => agent.id === 'made-by-atum')?.isManaged).toBe(true)
    expect(agents.find(agent => agent.id === 'made-by-hand')?.isManaged).toBe(false)
    expect(agents.find(agent => agent.id === 'no-metadata-at-all')?.isManaged).toBe(false)
  })

  it('never lists the default profile twice, whichever way it is spelled', () => {
    const agents = projectAtumAgents([
      profile({ is_default: true, name: 'default' }),
      profile({ is_default: false, name: 'default' }),
      profile({ is_default: false, name: '  ' })
    ])

    expect(agents.filter(agent => agent.id === ATUM_AGENT_ID)).toHaveLength(1)
    expect(agents).toHaveLength(1)
  })
})

describe('identity', () => {
  it('carries the backend-minted identity and revision, and never derives one from the name', () => {
    const agents = projectAtumAgents([
      profile({
        display_name: 'Marketing',
        identity_id: '00000000-0000-4000-8000-4d8784e29a98',
        lifecycle_revision: 3,
        name: 'marketing'
      })
    ])

    expect(agents[1]).toMatchObject({
      id: 'marketing',
      identityId: '00000000-0000-4000-8000-4d8784e29a98',
      lifecycleRevision: 3
    })
  })

  it('reads as no identity, not an invented one, when the backend is older than the field', () => {
    const [master, named] = projectAtumAgents([profile({ name: 'mkt' })])

    expect(named!.identityId).toBe('')
    expect(named!.lifecycleRevision).toBe(0)
    expect(master!.identityId).toBe('')
  })

  it("gives the master the default profile's identity once the list has loaded", () => {
    const [master] = projectAtumAgents([
      profile({
        identity_id: '00000000-0000-4000-8000-53cc8fd729d5',
        is_default: true,
        lifecycle_revision: 1,
        name: 'default'
      })
    ])

    expect(master!.identityId).toBe('00000000-0000-4000-8000-53cc8fd729d5')
    expect(master!.lifecycleRevision).toBe(1)
  })
})

describe('arranging agents', () => {
  const profiles = [
    profile({ display_name: 'Alpha', name: 'alpha' }),
    profile({ display_name: 'Beta', name: 'beta' }),
    profile({ display_name: 'Gamma', name: 'gamma' })
  ]

  it('keeps pinned assistants first, then the manual order, then the unplaced by name', () => {
    const agents = projectAtumAgents(profiles, { order: ['gamma'], pins: ['beta'] })

    expect(agents.map(agent => agent.id)).toEqual([ATUM_AGENT_ID, 'beta', 'gamma', 'alpha'])
    expect(agents.map(agent => agent.pinned)).toEqual([false, true, false, false])
  })

  it('never lets an arrangement reach above the master', () => {
    const agents = projectAtumAgents(profiles, { order: ['alpha', ATUM_AGENT_ID], pins: [ATUM_AGENT_ID, 'alpha'] })

    expect(agents[0]!.id).toBe(ATUM_AGENT_ID)
    expect(agents[0]!.pinned).toBe(false)
  })

  it('pins to the very top and unpins in place, ignoring the master', async () => {
    resetAtumAgentArrangement()
    const { $profiles } = await import('@/store/profile')
    $profiles.set(profiles)

    reorderAtumAgents(['gamma', 'beta', 'alpha'])
    setAtumAgentPinned('alpha', true)

    expect($atumAgentPins.get()).toEqual(['local:alpha'])
    expect($atumAgentOrder.get()).toEqual(['local:alpha', 'local:gamma', 'local:beta'])
    expect($atumAgents.get().map(agent => agent.id)).toEqual([ATUM_AGENT_ID, 'alpha', 'gamma', 'beta'])

    setAtumAgentPinned('alpha', false)
    expect($atumAgentPins.get()).toEqual([])
    expect($atumAgents.get().map(agent => agent.id)).toEqual([ATUM_AGENT_ID, 'alpha', 'gamma', 'beta'])

    setAtumAgentPinned(ATUM_AGENT_ID, true)
    reorderAtumAgents([ATUM_AGENT_ID, 'beta', 'beta'])
    expect($atumAgentPins.get()).toEqual([])
    expect($atumAgentOrder.get()).toEqual(['local:beta'])

    resetAtumAgentArrangement()
    $profiles.set([])
  })

  it('does not let a stale remote account overwrite the foreground arrangement', async () => {
    const { $atumStatus } = await import('@/store/atum-messaging')
    const previousStatus = $atumStatus.get()
    const previousArrangements = $atumAgentArrangements.get()

    try {
      $atumStatus.set({ accountId: 'account-a' } as never)
      $atumAgentArrangements.set({})

      expect(setAtumAgentArrangementForAccount('account-b', { order: ['b'], pins: ['b'] })).toBe(false)
      expect($atumAgentArrangements.get()).toEqual({})

      expect(
        setAtumAgentArrangementForAccount('account-a', {
          order: ['00000000-0000-1000-8000-ac768db8b68e', 'not-a-uuid'],
          pins: ['00000000-0000-1000-8000-ac768db8b68e', 'also-not-a-uuid']
        })
      ).toBe(true)
      expect($atumAgentArrangements.get()).toEqual({
        'account-a': {
          order: ['00000000-0000-1000-8000-ac768db8b68e'],
          pins: ['00000000-0000-1000-8000-ac768db8b68e']
        }
      })
    } finally {
      $atumAgentArrangements.set(previousArrangements)
      $atumStatus.set(previousStatus)
    }
  })
})

describe('agentIdForSession', () => {
  it('treats a session with no profile as the master assistant', () => {
    // Legacy single-profile responses omit the field; the cross-profile
    // aggregator sets it. Both must resolve to a real agent.
    expect(agentIdForSession(undefined)).toBe(ATUM_AGENT_ID)
    expect(agentIdForSession(null)).toBe(ATUM_AGENT_ID)
    expect(agentIdForSession('  ')).toBe(ATUM_AGENT_ID)
    expect(agentIdForSession('alfred')).toBe('alfred')
  })
})

describe('$atumNewChatAgent', () => {
  it('answers with the agent a new chat would actually be created under', async () => {
    // It must agree with use-session-actions, which uses the chosen profile if
    // there is one and otherwise whichever agent the gateway is on. Answering
    // "the master" for an unset choice would highlight Atum in the roster while
    // the next message was created under someone else.
    const { $activeGatewayProfile, $newChatProfile } = await import('@/store/profile')

    $newChatProfile.set(null)
    $activeGatewayProfile.set('default')
    expect($atumNewChatAgent.get()).toBe(ATUM_AGENT_ID)

    // ⌘N clears the choice without moving the gateway.
    $activeGatewayProfile.set('marketing')
    expect($atumNewChatAgent.get()).toBe('marketing')

    // An explicit choice wins over the gateway.
    $newChatProfile.set('nha')
    expect($atumNewChatAgent.get()).toBe('nha')

    $newChatProfile.set(null)
    $activeGatewayProfile.set('default')
  })
})

describe('the agents crossing stays narrow', () => {
  // Comments legitimately NAME the nouns this module excludes, so the fence
  // reads the code, the way `design-contract.test.ts` does.
  const source = readFileSync(resolve(__dirname, 'agents.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')

  it('reads the profile store and nothing else from the Hermes organisation', () => {
    // This module is one of exactly two sanctioned crossings. It may know
    // about profiles; every other Hermes noun stays out of the product.
    expect(source).toContain('$profiles')

    for (const noun of ['$sessions', '$projects', '$cronSessions', '$pinnedSessionIds', 'worktree', 'cron']) {
      expect(source, `${noun} must not reach the agents projection`).not.toContain(noun)
    }
  })

  it('projects only what a person would recognise as theirs', () => {
    // Engine bookkeeping a profile carries must never reach a roster row.
    for (const field of ['skill_count', 'has_env', 'alias', 'distribution', 'gateway_running', 'path']) {
      expect(source, `${field} is Hermes organisation, not product`).not.toContain(`profile.${field}`)
    }
  })
})

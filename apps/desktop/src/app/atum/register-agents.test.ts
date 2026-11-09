import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesClient from '@/hermes'
import type * as ProfileStore from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

const registerAssistant = vi.fn()
const listAssistants = vi.fn()
const adoptDefaultProfileIdentity = vi.fn()
const refreshProfiles = vi.fn()

vi.mock('@/lib/atum-messaging-client', () => ({
  atumMessagingClient: vi.fn(() => ({ registerAssistant, listAssistants }))
}))
vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<typeof HermesClient>()), adoptDefaultProfileIdentity }))
vi.mock('@/store/profile', async importOriginal => ({ ...(await importOriginal<typeof ProfileStore>()), refreshProfiles }))

const { $profiles } = await import('@/store/profile')
const { $atumAccountStatus, $atumStatus } = await import('@/store/atum-messaging')
const { $atumAgentRegistration, registerAtumAgents, startAtumAgentRegistration } = await import('./register-agents')

const profile = (overrides: Partial<ProfileInfo>): ProfileInfo =>
  ({ has_env: true, is_default: false, model: 'm', name: 'x', path: '/h/x', provider: null, skill_count: 1, ...overrides }) as ProfileInfo

const DEFAULT_ID = '00000000-0000-4000-8000-303617b97302'
const MKT_ID = '00000000-0000-4000-8000-50d86b120e98'

function signedIn(on: boolean, accountId = 'acct') {
  $atumAccountStatus.set({
    state: on ? 'signed_in' : 'signed_out',
    configured: true,
    account: on ? { id: accountId, displayName: 'Minh' } : null,
    errorCode: null,
    providers: { google: true, password: true }
  })
  $atumStatus.set(on ? ({ accountId, connectivity: 'online' } as never) : null)
}

beforeEach(() => {
  registerAssistant.mockReset()
  listAssistants.mockReset()
  adoptDefaultProfileIdentity.mockReset()
  refreshProfiles.mockReset()
  listAssistants.mockResolvedValue([])
  registerAssistant.mockImplementation(async (input: { identityId: string }) => ({
    outcome: 'registered',
    assistant: { id: 'row', identityId: input.identityId, displayName: 'x', avatar: '', isDefault: false, lifecycleRevision: 1, status: 'active' }
  }))
  $profiles.set([])
  $atumAgentRegistration.set(null)
  signedIn(true)
})

afterEach(() => signedIn(false))

describe('registerAtumAgents', () => {
  it('registers each assistant Atum made under its identity, and skips the rest', async () => {
    $profiles.set([
      profile({ identity_id: DEFAULT_ID, is_default: true, lifecycle_revision: 1, name: 'default' }),
      profile({ avatar: '📣', display_name: 'Marketing', identity_id: MKT_ID, lifecycle_revision: 3, managed_by: 'atum', name: 'marketing' }),
      profile({ display_name: 'Hand-made', identity_id: '00000000-0000-4000-8000-0bb5de138389', name: 'coder' }),
      profile({ display_name: 'No identity yet', managed_by: 'atum', name: 'fresh' })
    ])

    const summary = await registerAtumAgents()

    expect(summary).toEqual({ registered: 2, stale: 0, adopted: 0, failed: 0, skipped: 2 })
    expect(registerAssistant).toHaveBeenCalledWith({
      identityId: MKT_ID, displayName: 'Marketing', avatar: '📣', isDefault: false, lifecycleRevision: 3
    })
    // A hand-made profile is Hermes organisation and never leaves the machine.
    expect(registerAssistant.mock.calls.map(call => call[0].identityId)).not.toContain('00000000-0000-4000-8000-0bb5de138389')
  })

  it("registers the default with the plane's metadata revision, never a newer local revision for an old hosted snapshot", async () => {
    listAssistants.mockResolvedValue([
      { id: 'row', identityId: null, displayName: 'Mai', avatar: '🙂', isDefault: true, lifecycleRevision: 1, status: 'active' }
    ])
    $profiles.set([profile({ identity_id: DEFAULT_ID, is_default: true, lifecycle_revision: 2, name: 'default' })])

    await registerAtumAgents()

    expect(registerAssistant).toHaveBeenCalledWith({
      identityId: DEFAULT_ID, displayName: 'Mai', avatar: '🙂', isDefault: true, lifecycleRevision: 1
    })
  })

  it('adopts the plane identity for the default when told to, then re-reads the agents', async () => {
    const planeIdentity = '00000000-0000-4000-8000-00f765af1c54'
    registerAssistant.mockResolvedValueOnce({
      outcome: 'adopt',
      assistant: { id: 'row', identityId: planeIdentity, displayName: 'Trợ lý', avatar: '', isDefault: true, lifecycleRevision: 1, status: 'active' }
    })
    $profiles.set([profile({ identity_id: DEFAULT_ID, is_default: true, lifecycle_revision: 1, name: 'default' })])

    const summary = await registerAtumAgents()

    expect(summary.adopted).toBe(1)
    expect(adoptDefaultProfileIdentity).toHaveBeenCalledWith(planeIdentity)
    expect(refreshProfiles).toHaveBeenCalled()
  })

  it('counts a stale answer and keeps going; one failure does not stop the others', async () => {
    registerAssistant
      .mockResolvedValueOnce({ outcome: 'stale', assistant: { id: 'r', identityId: MKT_ID, displayName: 'Newer', avatar: '', isDefault: false, lifecycleRevision: 9, status: 'active' } })
      .mockRejectedValueOnce(new Error('offline'))
    $profiles.set([
      profile({ display_name: 'A', identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' }),
      profile({ display_name: 'B', identity_id: '00000000-0000-4000-8000-6cc9b1298c8f', lifecycle_revision: 1, managed_by: 'atum', name: 'b' })
    ])

    const summary = await registerAtumAgents()

    expect(summary).toMatchObject({ stale: 1, failed: 1 })
    expect(registerAssistant).toHaveBeenCalledTimes(2)
  })

  it('leaves a legacy overlong Atum name unregistered for its Rename action', async () => {
    $profiles.set([profile({ display_name: 'x'.repeat(41), identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'marketing' })])

    await expect(registerAtumAgents()).resolves.toEqual({ registered: 0, stale: 0, adopted: 0, failed: 0, skipped: 2 })
    expect(registerAssistant).not.toHaveBeenCalled()
  })

  it('resolves, never rejects, when the desktop bridge is absent', async () => {
    // The subscription that starts registration awaits nothing, so a throw
    // here would surface as an unhandled rejection in every renderer test
    // that signs in without a bridge — which is exactly what CI saw.
    const { atumMessagingClient } = await import('@/lib/atum-messaging-client')
    vi.mocked(atumMessagingClient).mockImplementationOnce(() => {
      throw new Error('Atum messaging is unavailable in this desktop runtime')
    })
    $profiles.set([profile({ display_name: 'A', identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' })])

    await expect(registerAtumAgents()).resolves.toMatchObject({ failed: 1, registered: 0 })
    expect(registerAssistant).not.toHaveBeenCalled()
  })

  it('does nothing while signed out', async () => {
    signedIn(false)
    $profiles.set([profile({ display_name: 'A', identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' })])

    const summary = await registerAtumAgents()

    expect(summary.registered).toBe(0)
    expect(registerAssistant).not.toHaveBeenCalled()
  })
})

describe('startAtumAgentRegistration', () => {
  it('waits for a fresh profile reload after signing back in', async () => {
    const reloaded = [profile({ identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' })]
    $profiles.set(reloaded)
    const stop = startAtumAgentRegistration()

    try {
      await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(1))
      signedIn(false)
      signedIn(true)
      // Account re-home clears the prior account's cached profile list. A
      // second registration is unsafe until the new account root reloads it.
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(registerAssistant).toHaveBeenCalledTimes(1)
      $profiles.set(reloaded)
      await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(2))
    } finally {
      stop()
    }
  })

  it('drains a changed revision after the in-flight registration settles', async () => {
    let release!: () => void
    registerAssistant.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ outcome: 'registered', assistant: {} })
    }))
    $profiles.set([profile({ identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' })])
    const stop = startAtumAgentRegistration()

    try {
      await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(1))
      $profiles.set([profile({ identity_id: MKT_ID, lifecycle_revision: 2, managed_by: 'atum', name: 'a' })])
      release()
      await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(2))
      expect(registerAssistant.mock.calls[1]![0].lifecycleRevision).toBe(2)
    } finally {
      release?.()
      stop()
    }
  })

  it('ignores an adoption response from a previous account, including an A-B-A switch', async () => {
    let release!: () => void
    registerAssistant.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ outcome: 'adopt', assistant: { identityId: MKT_ID } })
    }))
    $profiles.set([profile({ identity_id: DEFAULT_ID, is_default: true, lifecycle_revision: 1, name: 'default' })])
    const pending = registerAtumAgents()
    await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(1))
    signedIn(false)
    signedIn(true, 'other')
    signedIn(true)
    release()
    await pending
    expect(adoptDefaultProfileIdentity).not.toHaveBeenCalled()
    expect(refreshProfiles).not.toHaveBeenCalled()
  })

  it('does not overwrite the default with a placeholder when reading the registry fails', async () => {
    listAssistants.mockRejectedValue(new Error('offline'))
    $profiles.set([profile({ identity_id: DEFAULT_ID, is_default: true, lifecycle_revision: 99, name: 'default' })])
    await registerAtumAgents()
    expect(registerAssistant).not.toHaveBeenCalled()
  })

  it('registers when signed in and the agents change, once per change', async () => {
    signedIn(false)
    const stop = startAtumAgentRegistration()

    signedIn(true)
    // Sign-in starts on an empty cache. A profile response is the only thing
    // that may make local metadata eligible for this account's registration.
    expect(registerAssistant).not.toHaveBeenCalled()
    $profiles.set([profile({ display_name: 'A', identity_id: MKT_ID, lifecycle_revision: 1, managed_by: 'atum', name: 'a' })])
    await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(1))

    // Same agents, same revisions: nothing to say again.
    $profiles.set([...$profiles.get()])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(registerAssistant).toHaveBeenCalledTimes(1)

    // A rename bumps the revision: register again.
    $profiles.set([profile({ display_name: 'A2', identity_id: MKT_ID, lifecycle_revision: 2, managed_by: 'atum', name: 'a' })])
    await vi.waitFor(() => expect(registerAssistant).toHaveBeenCalledTimes(2))
    stop()
  })
})

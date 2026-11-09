import { atom, computed } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listAssistants = vi.fn()
const registerAssistant = vi.fn()

vi.mock('@/lib/atum-messaging-client', () => ({
  atumMessagingClient: vi.fn(() => ({ listAssistants, registerAssistant }))
}))

interface DirectoryAccountStatus {
  account: { displayName: string; id: string } | null
  configured: boolean
  errorCode: string | null
  providers: { google: boolean; password: boolean }
  state: string
}

const $atumAccountStatus = atom<DirectoryAccountStatus>({
  account: { displayName: 'Minh', id: 'a' },
  configured: true,
  errorCode: null,
  providers: { google: true, password: true },
  state: 'signed_in'
})

vi.mock('@/store/atum-messaging', () => ({
  $atumAccountScopeId: computed($atumAccountStatus, status => status.account?.id ?? null),
  $atumAccountStatus,
  $atumIsAuthenticated: computed($atumAccountStatus, status => status.state === 'signed_in')
}))

const {
  $atumAssistantDirectory,
  atumAssistantDirectoryWriteEpoch,
  recordAtumAssistantDirectoryEntry,
  refreshAtumAssistantDirectory,
  renameAtumMasterAssistant,
  hostedAtumAssistant,
  displayAtumAssistant
} = await import('./assistant-directory')

const row = (id: string, avatarUrl: string | null = null, identityId: string | null = '00000000-0000-4000-8000-bd7662a5eeb4') => ({
  avatar: '',
  avatarUrl,
  displayName: 'Atum',
  id,
  identityId,
  isDefault: true,
  lifecycleRevision: 4,
  status: 'active' as const
})

function signedIn(accountId: string | null) {
  $atumAccountStatus.set({
    account: accountId ? { displayName: accountId, id: accountId } : null,
    configured: true,
    errorCode: null,
    providers: { google: true, password: true },
    state: accountId ? 'signed_in' : 'signed_out'
  })
}

beforeEach(() => {
  listAssistants.mockReset().mockResolvedValue([])
  registerAssistant.mockReset()
  signedIn('a')
})

afterEach(() => signedIn(null))

describe('assistant directory', () => {
  it('maps a local identity to its hosted assistant, with a default-only legacy fallback', () => {
    const directory = {
      accountId: 'account-a',
      state: 'ready' as const,
      entries: [row('hosted-master', 'https://cdn.atum.test/master.webp', null), row('hosted-agent', null, 'agent-identity')]
    }

    expect(hostedAtumAssistant(directory, '', true)?.id).toBe('hosted-master')
    expect(hostedAtumAssistant(directory, '', false)).toBeNull()
    expect(hostedAtumAssistant(directory, 'agent-identity', false)?.id).toBe('hosted-agent')
    expect(displayAtumAssistant(directory, '', true)).toEqual({
      kind: 'assistant',
      id: 'hosted-master',
      displayName: 'Atum',
      avatarUrl: 'https://cdn.atum.test/master.webp',
      ownerUserId: 'account-a'
    })
  })

  it('keeps hosted photo URLs only in the active account directory', async () => {
    listAssistants.mockResolvedValue([row('assistant-a', 'https://cdn.atum.test/a.webp')])

    await refreshAtumAssistantDirectory()

    expect($atumAssistantDirectory.get()).toEqual({
      accountId: 'a',
      entries: [expect.objectContaining({ avatarUrl: 'https://cdn.atum.test/a.webp', id: 'assistant-a' })],
      state: 'ready'
    })

    signedIn('b')
    expect($atumAssistantDirectory.get()).toEqual({ accountId: 'b', entries: [], state: 'empty' })
  })

  it('drops a late A result after an A → B → A handoff', async () => {
    let release!: (rows: ReturnType<typeof row>[]) => void
    listAssistants.mockImplementationOnce(() => new Promise(resolve => {
      release = resolve
    }))

    const pending = refreshAtumAssistantDirectory()
    signedIn('b')
    signedIn('a')
    release([row('stale-a', 'https://cdn.atum.test/stale.webp')])
    await pending

    expect($atumAssistantDirectory.get()).toEqual({ accountId: 'a', entries: [], state: 'empty' })
  })

  it('does not let a deferred list erase a completed photo', async () => {
    let release!: (rows: ReturnType<typeof row>[]) => void
    listAssistants.mockImplementationOnce(() => new Promise(resolve => {
      release = resolve
    }))

    const pending = refreshAtumAssistantDirectory()
    recordAtumAssistantDirectoryEntry(row('assistant-a', 'https://cdn.atum.test/new.webp'), undefined, undefined, {
      invalidateOlderReads: true
    })
    release([row('assistant-a')])
    await pending

    expect($atumAssistantDirectory.get().entries[0]).toMatchObject({ avatarUrl: 'https://cdn.atum.test/new.webp' })
  })

  it('does not let a deferred list restore a photo after it was cleared', async () => {
    recordAtumAssistantDirectoryEntry(row('assistant-a', 'https://cdn.atum.test/old.webp'))
    let release!: (rows: ReturnType<typeof row>[]) => void
    listAssistants.mockImplementationOnce(() => new Promise(resolve => {
      release = resolve
    }))

    const pending = refreshAtumAssistantDirectory()
    recordAtumAssistantDirectoryEntry(row('assistant-a'), undefined, undefined, { invalidateOlderReads: true })
    release([row('assistant-a', 'https://cdn.atum.test/old.webp')])
    await pending

    expect($atumAssistantDirectory.get().entries[0]).toMatchObject({ avatarUrl: null })
  })

  it('ignores a registration result that began before a photo write', () => {
    const registrationEpoch = atumAssistantDirectoryWriteEpoch()
    recordAtumAssistantDirectoryEntry(row('assistant-a', 'https://cdn.atum.test/new.webp'), undefined, undefined, {
      invalidateOlderReads: true
    })
    recordAtumAssistantDirectoryEntry(row('assistant-a'), undefined, undefined, { writeEpoch: registrationEpoch })

    expect($atumAssistantDirectory.get().entries[0]).toMatchObject({ avatarUrl: 'https://cdn.atum.test/new.webp' })
  })

  it('does not report a master rename as saved when the registry asks to adopt', async () => {
    const identityId = 'master-identity'
    recordAtumAssistantDirectoryEntry(row('master-row', null, identityId))
    registerAssistant.mockResolvedValue({ assistant: row('master-row', null, identityId), outcome: 'adopt' })

    await expect(renameAtumMasterAssistant({ avatar: '', identityId, name: 'Renamed' })).rejects.toThrow('assistant_profile_adopt')
  })

  it('requires the selected master identity rather than any default row', async () => {
    recordAtumAssistantDirectoryEntry(row('master-row', null, 'another-master'))

    await expect(renameAtumMasterAssistant({ avatar: '', identityId: 'selected-master', name: 'Renamed' })).rejects.toThrow(
      'assistant_profile_unavailable'
    )
    expect(registerAssistant).not.toHaveBeenCalled()
  })
})

import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAgent } from './agents'
import type { AtumAssistantDirectory } from './assistant-directory'

const getPortableProfileDefinition = vi.fn()
const getAssistantDefinition = vi.fn()
const putAssistantDefinition = vi.fn()
const applyAssistantDefinition = vi.fn()
const refreshProfiles = vi.fn()
const refreshAtumAssistantDirectory = vi.fn()

let accountId: string | null = 'account-a'
let generation = 0

const $atumAssistantDirectory = atom<AtumAssistantDirectory>({
  accountId,
  entries: [
    {
      avatar: '📣',
      avatarUrl: null,
      definitionRevision: 2,
      displayName: 'Marketing',
      id: 'hosted-marketing',
      identityId: 'marketing-identity',
      identityRevision: 3,
      isDefault: false,
      lifecycleRevision: 1,
      status: 'active' as const
    }
  ],
  state: 'ready' as const
})

vi.mock('@/hermes', () => ({ getPortableProfileDefinition }))
vi.mock('@/lib/atum-messaging-client', () => ({
  atumMessagingClient: vi.fn(() => ({ applyAssistantDefinition, getAssistantDefinition, putAssistantDefinition }))
}))
vi.mock('@/store/profile', () => ({ refreshProfiles }))
vi.mock('./assistant-directory', () => ({
  $atumAssistantDirectory,
  captureAtumAssistantDirectoryScope: () => ({ accountId, generation }),
  isAtumAssistantDirectoryScopeCurrent: (scope: { accountId: string | null; generation: number }) =>
    scope.accountId === accountId && scope.generation === generation,
  refreshAtumAssistantDirectory
}))

const {
  $atumDefinitionBases,
  $atumDefinitionDrafts,
  applyPortableAtumAgent,
  retryPortableAtumAgent,
  uploadPortableAtumAgent
} = await import('./portable-agent')

const agent: AtumAgent = {
  arrangementId: 'hosted-marketing',
  avatar: '📣',
  definitionState: 'available',
  description: '',
  hostedId: 'hosted-marketing',
  id: 'marketing',
  identityId: 'marketing-identity',
  isDefault: false,
  isManaged: true,
  lifecycleRevision: 1,
  localProfileId: 'marketing',
  pinned: false,
  title: 'Marketing'
}

const draft = (displayName: string) => ({
  avatar: '📣',
  baseDefinitionRevision: 2,
  baseIdentityRevision: 3,
  definition: { soul: displayName },
  displayName
})

function switchTo(account: string) {
  accountId = account
  generation += 1
  $atumAssistantDirectory.set({ accountId: account, entries: [], state: 'ready' })
}

beforeEach(() => {
  accountId = 'account-a'
  generation = 0
  $atumAssistantDirectory.set({
    accountId,
    entries: [
      {
        avatar: '📣',
        avatarUrl: null,
        definitionRevision: 2,
        displayName: 'Marketing',
        id: 'hosted-marketing',
        identityId: 'marketing-identity',
        identityRevision: 3,
        isDefault: false,
        lifecycleRevision: 1,
        status: 'active'
      }
    ],
    state: 'ready'
  })
  $atumDefinitionDrafts.set({})
  $atumDefinitionBases.set({ 'account-a': { 'hosted-marketing': { definitionRevision: 2, identityRevision: 3 } } })
  getPortableProfileDefinition.mockReset().mockResolvedValue({ definition: { soul: 'A definition' } })
  getAssistantDefinition.mockReset().mockResolvedValue({ definitionRevision: 5, identityRevision: 7 })
  putAssistantDefinition.mockReset().mockResolvedValue({ definitionRevision: 3, identityRevision: 4 })
  applyAssistantDefinition.mockReset().mockResolvedValue({
    ok: true,
    status: 'applied',
    profile: {
      name: 'marketing',
      identityId: 'marketing-identity',
      displayName: 'Marketing',
      avatar: '📣',
      managedBy: 'atum'
    }
  })
  refreshAtumAssistantDirectory.mockReset()
  refreshProfiles.mockReset()
})

afterEach(() => {
  $atumDefinitionDrafts.set({})
  $atumDefinitionBases.set({})
})

describe('portable assistant upload account fence', () => {
  it('drops an impossible retry after Electron wraps a protected-workspace rejection', async () => {
    putAssistantDefinition.mockRejectedValueOnce(new Error("Error invoking remote method 'atum:put': Error: google_workspace_local_only"))
    await expect(uploadPortableAtumAgent(agent)).rejects.toThrow('google_workspace_local_only')
    expect($atumDefinitionDrafts.get()['account-a']?.['hosted-marketing']).toBeUndefined()
    expect(getPortableProfileDefinition).toHaveBeenCalledOnce()
  })

  it('does not discard another account draft after a protected rejection', async () => {
    const retained = draft('B draft')
    putAssistantDefinition.mockImplementationOnce(async () => {
      switchTo('account-b')
      $atumDefinitionDrafts.set({ 'account-b': { 'hosted-marketing': retained } })
      throw new Error("Error invoking remote method 'atum:put': Error: google_workspace_local_only")
    })
    await expect(uploadPortableAtumAgent(agent)).rejects.toThrow('google_workspace_local_only')
    expect($atumDefinitionDrafts.get()['account-b']['hosted-marketing']).toEqual(retained)
  })

  it('uses the installed base when a refreshed directory has newer cloud settings', async () => {
    $atumDefinitionBases.set({ 'account-a': { 'hosted-marketing': { definitionRevision: 1, identityRevision: 2 } } })
    putAssistantDefinition.mockRejectedValueOnce(new Error('revision_conflict'))
    await expect(uploadPortableAtumAgent(agent)).rejects.toThrow('assistant_definition_conflict')
    expect(putAssistantDefinition.mock.calls[0][1]).toMatchObject({
      expectedDefinitionRevision: 1,
      expectedIdentityRevision: 2
    })
    expect($atumDefinitionDrafts.get()['account-a']['hosted-marketing']).toMatchObject({
      baseDefinitionRevision: 1,
      baseIdentityRevision: 2
    })
  })

  it('does not treat unknown local provenance as the newest cloud definition', async () => {
    $atumDefinitionBases.set({})
    putAssistantDefinition.mockRejectedValueOnce(new Error('revision_conflict'))
    await expect(uploadPortableAtumAgent(agent)).rejects.toThrow('assistant_definition_conflict')
    expect(putAssistantDefinition.mock.calls[0][1].expectedDefinitionRevision).toBe(0)
  })

  it('remembers an accepted upload separately from directory refreshes', async () => {
    await uploadPortableAtumAgent(agent)
    expect($atumDefinitionBases.get()['account-a']['hosted-marketing']).toEqual({
      definitionRevision: 3,
      identityRevision: 4
    })
    await uploadPortableAtumAgent(agent)
    expect(putAssistantDefinition.mock.calls[1][1]).toMatchObject({
      expectedDefinitionRevision: 3,
      expectedIdentityRevision: 4
    })
  })

  it('retries only the definition write contract using fresh cloud revisions', async () => {
    const retained = draft('Retained local draft')
    $atumDefinitionDrafts.set({ 'account-a': { 'hosted-marketing': retained } })

    await retryPortableAtumAgent(agent)

    expect(putAssistantDefinition).toHaveBeenCalledWith('hosted-marketing', {
      avatar: retained.avatar,
      definition: retained.definition,
      displayName: retained.displayName,
      expectedDefinitionRevision: 5,
      expectedIdentityRevision: 7
    })
    expect($atumDefinitionDrafts.get()['account-a']?.['hosted-marketing']).toBeUndefined()
  })

  it('applies the cloud definition only after main confirms it, then drops this account’s saved draft', async () => {
    const aDraft = draft('Local draft')
    $atumDefinitionDrafts.set({ 'account-a': { 'hosted-marketing': aDraft } })

    await expect(applyPortableAtumAgent(agent)).resolves.toBe('marketing')

    expect(applyAssistantDefinition).toHaveBeenCalledWith('hosted-marketing')
    expect($atumDefinitionDrafts.get()['account-a']?.['hosted-marketing']).toBeUndefined()
    expect(refreshProfiles).toHaveBeenCalledOnce()
  })

  it('does not advance either account base when cloud apply resolves after a switch', async () => {
    let resolveApply!: (value: unknown) => void
    applyAssistantDefinition.mockImplementationOnce(() => new Promise(resolve => { resolveApply = resolve }))
    const before = $atumDefinitionBases.get()
    const pending = applyPortableAtumAgent(agent)
    switchTo('account-b')
    resolveApply({ ok: true, status: 'applied', profile: {
      name: 'marketing', definitionRevision: 20, identityRevision: 21
    } })
    await expect(pending).rejects.toThrow('assistant_profile_account_changed')
    expect($atumDefinitionBases.get()).toEqual(before)
    expect(refreshProfiles).not.toHaveBeenCalled()
  })

  it('keeps B’s draft when A switches accounts while upload refreshes the directory', async () => {
    let release!: () => void
    refreshAtumAssistantDirectory.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const bDraft = draft('B draft')
    $atumDefinitionDrafts.set({ 'account-b': { 'hosted-marketing': bDraft } })

    const pending = uploadPortableAtumAgent(agent)
    await vi.waitFor(() => expect(refreshAtumAssistantDirectory).toHaveBeenCalledTimes(1))
    switchTo('account-b')
    release()

    await expect(pending).rejects.toThrow('assistant_profile_account_changed')
    expect($atumDefinitionDrafts.get()['account-b']?.['hosted-marketing']).toEqual(bDraft)
  })

  it('keeps B’s draft when a conflict retry refreshes after an account switch', async () => {
    let release!: () => void
    refreshAtumAssistantDirectory.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const aDraft = draft('A draft')
    const bDraft = draft('B draft')
    $atumDefinitionDrafts.set({
      'account-a': { 'hosted-marketing': aDraft },
      'account-b': { 'hosted-marketing': bDraft }
    })

    const pending = retryPortableAtumAgent(agent)
    await vi.waitFor(() => expect(refreshAtumAssistantDirectory).toHaveBeenCalledTimes(1))
    switchTo('account-b')
    release()

    await expect(pending).rejects.toThrow('assistant_profile_account_changed')
    expect($atumDefinitionDrafts.get()['account-b']?.['hosted-marketing']).toEqual(bDraft)
  })
})

import { atom, computed } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const accountId = '00000000-0000-4000-8000-576f18824476'
const assistantId = '00000000-0000-4000-8000-95eb2692c90e'
const identityId = '00000000-0000-4000-8000-b4b6412c243e'
const $account = atom<string | null>(accountId)
const $profiles = atom<any[]>([])

const $agents = computed($profiles, profiles => profiles.map(profile => ({
  id: profile.name, localProfileId: profile.name, identityId: profile.identity_id,
  isManaged: profile.managed_by === 'atum', isDefault: profile.is_default, lifecycleRevision: profile.lifecycle_revision ?? 0,
})))

const createProfile = vi.fn(async (input: any) => {
  $profiles.set([{ ...input, identity_id: identityId, is_default: false, lifecycle_revision: 1 }])

  return { name: input.name }
})

const updateProfileSoul = vi.fn(async (_profile: string, _soul: string) => ({}))
const registerAssistant = vi.fn(async () => ({ assistant: { id: assistantId, identityId, status: 'active' } }))
const hireAgent = vi.fn()
const agentHires = vi.fn(async () => [])
vi.mock('@/hermes', () => ({ createProfile, updateProfileSoul }))
vi.mock('@/store/profile', () => ({ $profiles, refreshProfiles: async () => {}, normalizeProfileKey: (v: string) => v }))
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId: $account }))
vi.mock('@/store/atum-store-catalog', () => ({ storeBridge: () => ({ hireAgent, agentHires }), refreshAtumStoreCatalog: async () => {} }))
vi.mock('@/lib/atum-messaging-client', () => ({ atumMessagingClient: () => ({ registerAssistant }) }))
vi.mock('./agents', () => ({ $atumAgents: $agents, ATUM_AGENT_ID: 'default', ATUM_MANAGED_BY: 'atum', talkToAtumAgent: vi.fn() }))
vi.mock('./assistant-directory', () => ({
  captureAtumAssistantDirectoryScope: () => ({ accountId: $account.get(), generation: 0 }),
  isAtumAssistantDirectoryScopeCurrent: (scope: any) => scope.accountId === $account.get(),
  recordAtumAssistantDirectoryEntry: vi.fn(), refreshAtumAssistantDirectory: async () => {},
}))
vi.mock('./portable-agent', () => ({ setupPortableAtumAgent: vi.fn(), uploadPortableAtumAgent: vi.fn() }))
const { confirmAtumHire, completeAtumHire } = await import('./hiring-actions')
const { $atumHireIntent, readHireIntent } = await import('@/store/atum-hiring')

const item: any = { kind: 'agent', id: 'test/employee', source: { type: 'cloud_agent' }, title: { en: 'Employee' }, glyph: 'E',
  offer: { id: '00000000-0000-4000-8000-676a3a34ff0f', version: 1, price_protons: 1000, billing_interval: 'month' } }

const success = { outcome: 'completed', subscription: { assistant_id: assistantId, offer_id: item.offer.id } }
let tails: Record<string, Promise<unknown>> = {}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); $profiles.set([]); $account.set(accountId); $atumHireIntent.set(null); tails = {}
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, callback: () => Promise<void>) => {
    const result = (tails[key] ?? Promise.resolve()).catch(() => {}).then(callback)
    tails[key] = result

    return result
  } } })
  hireAgent.mockResolvedValue(success)
})
describe('monthly checkout recovery', () => {
  it('retries a lost charge response with one employee and the identical consented intent', async () => {
    hireAgent.mockRejectedValueOnce(new Error('connection lost'))
    await expect(confirmAtumHire(item, 'Alex', 'en')).rejects.toThrow('connection lost')
    const intent = readHireIntent(accountId)!
    expect(intent.assistantId).toBe(assistantId)
    await completeAtumHire()
    expect(createProfile).toHaveBeenCalledTimes(1)
    expect(hireAgent.mock.calls[1]).toEqual(hireAgent.mock.calls[0])
    expect(hireAgent.mock.calls[0]).toEqual([assistantId, item.offer.id, 1, intent.requestId, true, accountId])
    expect(updateProfileSoul.mock.calls[0]?.[1]).toBe('# Alex\n')
    expect(readHireIntent(accountId)).toBeNull()
  })
  it('recovers a lost profile-create response by its saved key', async () => {
    createProfile.mockImplementationOnce(async input => {
      $profiles.set([{ ...input, identity_id: identityId, is_default: false, lifecycle_revision: 1 }])
      throw new Error('create response lost')
    })
    await expect(confirmAtumHire(item, 'Alex', 'en')).rejects.toThrow('create response lost')
    await completeAtumHire()
    expect(createProfile).toHaveBeenCalledTimes(1)
    expect(hireAgent).toHaveBeenCalledTimes(1)
  })
  it('keeps the employee on an offer change and requires fresh price consent', async () => {
    hireAgent.mockResolvedValueOnce({ outcome: 'offer_changed', offer: { ...item.offer, version: 2, price_protons: 1500 } })
    await expect(confirmAtumHire(item, 'Alex', 'en')).rejects.toThrow('offer_changed')
    const oldKey = hireAgent.mock.calls[0]![3]
    expect(readHireIntent(accountId)).toMatchObject({ assistantId, priceProtons: 1500, offerVersion: 2, needsConsent: true })
    await expect(completeAtumHire()).rejects.toThrow('offer_changed')
    expect(hireAgent).toHaveBeenCalledTimes(1)
    await completeAtumHire(true)
    expect(createProfile).toHaveBeenCalledTimes(1)
    expect(hireAgent.mock.calls[1]![3]).not.toBe(oldKey)
    expect(hireAgent.mock.calls[1]![2]).toBe(2)
  })
  it('stops after an account switch during identity creation', async () => {
    createProfile.mockImplementationOnce(async input => { $account.set('00000000-0000-4000-8000-4b2f94c54b02');

 return { name: input.name } })
    await expect(confirmAtumHire(item, 'Alex', 'en')).rejects.toThrow('hiring_account_changed')
    expect(registerAssistant).not.toHaveBeenCalled()
    expect(hireAgent).not.toHaveBeenCalled()
    expect(readHireIntent(accountId)).not.toBeNull()
  })
  it('serializes another window behind an uncertain checkout instead of overwriting it', async () => {
    hireAgent.mockRejectedValueOnce(new Error('unknown result'))
    const results = await Promise.allSettled([confirmAtumHire(item, 'Alex', 'en'), confirmAtumHire(item, 'Sam', 'en')])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(createProfile).toHaveBeenCalledTimes(1)
    expect(hireAgent).toHaveBeenCalledTimes(1)
    expect(readHireIntent(accountId)?.name).toBe('Alex')
  })
})

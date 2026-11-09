import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAssistantDirectory } from './assistant-directory'

const accountId = '00000000-0000-4000-8000-576f18824476'
const assistantId = '00000000-0000-4000-8000-95eb2692c90e'
const identityId = '00000000-0000-4000-8000-b4b6412c243e'
const $account = atom<string | null>(accountId)
const $agents = atom([{ id: 'employee', hostedId: assistantId, identityId, isDefault: false }])
const defaultEntry = { id: assistantId, identityId, isDefault: true, status: 'active' as const,
  displayName: 'Atum', avatarUrl: null, lifecycleRevision: 1 }
const $directory = atom<AtumAssistantDirectory>({ accountId, state: 'ready', entries: [] })
const agentHires = vi.fn()
const startAgentTask = vi.fn()
vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId: $account }))
vi.mock('@/store/atum-store-catalog', () => ({ storeBridge: () => ({ agentHires, startAgentTask }) }))
vi.mock('./agents', () => ({ $atumAgents: $agents }))
vi.mock('./assistant-directory', () => ({
  $atumAssistantDirectory: $directory,
  captureAtumAssistantDirectoryScope: () => ({ accountId: $account.get(), generation: 0 }),
  isAtumAssistantDirectoryScopeCurrent: (scope: { accountId: string }) => scope.accountId === $account.get(),
  refreshAtumAssistantDirectory: async () => {},
}))
const { $atumHiring } = await import('@/store/atum-hiring')
const { isAtumHiredProfile, bindAtumHiredTask } = await import('./hired-task')
const status = { managed: true, can_bind: true, agent_id: identityId, conversation_id: 'chat', task: null }
const hire = { assistant_id: assistantId } as never
beforeEach(() => {
  vi.clearAllMocks()
  $account.set(accountId)
  $agents.set([{ id: 'employee', hostedId: assistantId, identityId, isDefault: false }])
  $directory.set({ accountId, state: 'ready', entries: [] })
  $atumHiring.set({ accountId, state: 'idle', hires: [] })
  agentHires.mockRejectedValue(new Error('hiring service unavailable'))
  startAgentTask.mockRejectedValue(new Error('hire_paused'))
})
describe('hired execution availability boundary', () => {
  it('keeps ordinary provider selection available when the hiring API is down', async () => {
    await expect(isAtumHiredProfile('employee')).resolves.toBe(false)
    expect($atumHiring.get().state).toBe('error')
  })
  it('retains managed selection for a known hire during a roster outage', async () => {
    $atumHiring.set({ accountId, state: 'error', hires: [hire] })
    await expect(isAtumHiredProfile('employee')).resolves.toBe(true)
  })
  it('does not contact the hiring service for a known ordinary managed agent', async () => {
    $atumHiring.set({ accountId, state: 'ready', hires: [] })
    await bindAtumHiredTask('session', vi.fn().mockResolvedValue(status))
    expect(startAgentTask).not.toHaveBeenCalled()
  })
  it('sends with the server-confirmed default assistant when hiring routes are unavailable', async () => {
    $directory.set({ accountId, state: 'ready', entries: [defaultEntry] })
    $atumHiring.set({ accountId, state: 'error', hires: [] })
    await bindAtumHiredTask('session', vi.fn().mockResolvedValue(status))
    expect(startAgentTask).not.toHaveBeenCalled()
  })
  it.each(['wrong-account', 'wrong-identity', 'null-identity', 'wrong-assistant', 'retired', 'stale-directory', 'known-hire'])('does not trust a default directory row with %s', async kind => {
    $directory.set({ accountId: kind === 'wrong-account' ? 'other' : accountId,
      state: kind === 'stale-directory' ? 'error' : 'ready',
      entries: [{ ...defaultEntry, id: kind === 'wrong-assistant' ? 'other' : assistantId,
        identityId: kind === 'null-identity' ? null : kind === 'wrong-identity' ? 'other' : identityId,
        status: kind === 'retired' ? 'retired' : 'active' }] })
    $atumHiring.set({ accountId, state: 'error', hires: kind === 'known-hire' ? [hire] : [] })
    await expect(bindAtumHiredTask('session', vi.fn().mockResolvedValue(status))).rejects.toThrow('hire_paused')
    expect(startAgentTask).toHaveBeenCalledWith(assistantId, 'chat', null, accountId)
  })
  it('does not use a local default flag as hosted authorization', async () => {
    $agents.set([{ id: 'default', hostedId: assistantId, identityId, isDefault: true }])
    $directory.set({ accountId, state: 'ready', entries: [{ ...defaultEntry, isDefault: false }] })
    await expect(bindAtumHiredTask('session', vi.fn().mockResolvedValue(status))).rejects.toThrow('hire_paused')
  })
  it.each(['unknown', 'known'])('keeps hosted authorization for a %s hire and propagates denial', async kind => {
    $atumHiring.set({ accountId, state: kind === 'known' ? 'ready' : 'error', hires: kind === 'known' ? [hire] : [] })
    const request = vi.fn().mockResolvedValue(status)
    await expect(bindAtumHiredTask('session', request)).rejects.toThrow('hire_paused')
    expect(startAgentTask).toHaveBeenCalledWith(assistantId, 'chat', null, accountId)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

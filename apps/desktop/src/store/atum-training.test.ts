import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '00000000-0000-4000-8000-576f18824476'
const ASSISTANT = '00000000-0000-4000-8000-95eb2692c90e'
const IDENTITY = '00000000-0000-4000-8000-b4b6412c243e'
const TASK = '00000000-0000-4000-8000-676a3a34ff0f'
const $atumAccountScopeId = atom<string | null>(ACCOUNT)
const $freshSessionRequest = atom(0)
const $newChatProfile = atom<string | null>('employee')
const startTrainingTask = vi.fn()
vi.mock('./atum-messaging', () => ({ $atumAccountScopeId }))
vi.mock('./atum-store-catalog', () => ({ storeBridge: () => ({ startTrainingTask }) }))
vi.mock('./profile', () => ({ $freshSessionRequest, $newChatProfile, $activeGatewayProfile: atom('employee'), normalizeProfileKey: (value: string | null) => value || 'default' }))

const { $atumTrainingIntent, bindAtumTraining, completeAtumTrainingSubmit, prepareAtumTraining, trainingIntentForSubmit } = await import('./atum-training')
const descriptor = { task_id: TASK, assistant_id: ASSISTANT, assistant_identity_id: IDENTITY, conversation_id: 'conversation-root', skill_id: 'private-skill' }
const selection = { accountId: ACCOUNT, assistantId: ASSISTANT, assistantIdentityId: IDENTITY, profileId: 'employee', skillId: 'private-skill' }

beforeEach(() => {
  $atumAccountScopeId.set(ACCOUNT)
  $atumTrainingIntent.set(null)
  $newChatProfile.set('employee')
  startTrainingTask.mockReset().mockResolvedValue(descriptor)
})

describe('protected training before the first task prompt', () => {
  it('binds only public metadata to the exact created conversation before completion', async () => {
    prepareAtumTraining(selection)
    const intent = trainingIntentForSubmit(null)!
    const request = vi.fn().mockResolvedValueOnce({ agent_id: IDENTITY, conversation_id: 'conversation-root' }).mockResolvedValueOnce(descriptor)
    await bindAtumTraining(intent, 'live-id', request)
    expect(request.mock.calls).toEqual([
      ['context.capabilities', { session_id: 'live-id' }],
      ['training.bind', { session_id: 'live-id', task: descriptor }]
    ])
    expect(startTrainingTask).toHaveBeenCalledWith(ASSISTANT, 'conversation-root', 'private-skill', ACCOUNT)
    expect(JSON.stringify($atumTrainingIntent.get())).not.toMatch(/body|instruction|SKILL.md|file_path/i)
    completeAtumTrainingSubmit(intent)
    expect($atumTrainingIntent.get()).toBeNull()
  })

  it('retains the same task after a binding failure, then retries without a new task', async () => {
    prepareAtumTraining(selection)
    const request = vi.fn().mockResolvedValueOnce({ agent_id: IDENTITY, conversation_id: 'conversation-root' }).mockRejectedValueOnce(new Error('offline'))
    await expect(bindAtumTraining(trainingIntentForSubmit(null)!, 'live-id', request)).rejects.toThrow('offline')
    const retained = trainingIntentForSubmit('conversation-root')!
    expect(retained.task).toEqual(descriptor)
    expect(trainingIntentForSubmit('other-conversation')).toBeNull()
    request.mockResolvedValueOnce({ agent_id: IDENTITY, conversation_id: 'conversation-root' }).mockResolvedValueOnce(descriptor)
    await bindAtumTraining(retained, 'reconnected-live-id', request)
    expect(startTrainingTask).toHaveBeenCalledOnce()
  })

  it('drops unexpected source bytes before binding or persisting public metadata', async () => {
    prepareAtumTraining(selection)
    startTrainingTask.mockResolvedValue({ ...descriptor, body: 'PRIVATE-INSTRUCTIONS', file_path: '/private/SKILL.md' })
    const request = vi.fn().mockResolvedValueOnce({ agent_id: IDENTITY, conversation_id: 'conversation-root' }).mockResolvedValueOnce(descriptor)
    await bindAtumTraining(trainingIntentForSubmit(null)!, 'live-id', request)
    expect(request.mock.calls[1]).toEqual(['training.bind', { session_id: 'live-id', task: descriptor }])
    expect(JSON.stringify($atumTrainingIntent.get())).not.toContain('PRIVATE-INSTRUCTIONS')
    expect(JSON.stringify($atumTrainingIntent.get())).not.toContain('file_path')
  })

  it('requires binding confirmation for this same task before declaring preparation complete', async () => {
    prepareAtumTraining(selection)
    const request = vi.fn().mockResolvedValueOnce({ agent_id: IDENTITY, conversation_id: 'conversation-root' }).mockResolvedValueOnce({ ...descriptor, task_id: ASSISTANT })
    await expect(bindAtumTraining(trainingIntentForSubmit(null)!, 'live-id', request)).rejects.toThrow()
    expect($atumTrainingIntent.get()?.task).toEqual(descriptor)
  })

  it('refuses the wrong employee and preserves the original intent', async () => {
    prepareAtumTraining(selection)
    const intent = trainingIntentForSubmit(null)!
    const request = vi.fn().mockResolvedValue({ agent_id: ASSISTANT, conversation_id: 'conversation-root' })
    await expect(bindAtumTraining(intent, 'wrong-live-id', request)).rejects.toThrow()
    expect(startTrainingTask).not.toHaveBeenCalled()
    expect($atumTrainingIntent.get()).toEqual(intent)
  })

  it('fences a late result after the person starts another training draft for the same employee and skill', async () => {
    prepareAtumTraining(selection)
    const original = trainingIntentForSubmit(null)!
    let resolve!: (value: unknown) => void
    const request = vi.fn(() => new Promise(done => { resolve = done }))
    const binding = bindAtumTraining(original, 'old-live', request as never)
    $freshSessionRequest.set($freshSessionRequest.get() + 1)
    prepareAtumTraining(selection)
    const replacement = $atumTrainingIntent.get()
    resolve({ agent_id: IDENTITY, conversation_id: 'old-root' })
    await expect(binding).rejects.toThrow()
    expect(startTrainingTask).not.toHaveBeenCalled()
    expect($atumTrainingIntent.get()).toEqual(replacement)
  })

  it('clears cancelled draft training on profile and account changes', () => {
    prepareAtumTraining(selection)
    $newChatProfile.set('other')
    expect($atumTrainingIntent.get()).toBeNull()
    prepareAtumTraining(selection)
    $atumAccountScopeId.set('another-account')
    expect($atumTrainingIntent.get()).toBeNull()
  })
})

import { expect, it, vi } from 'vitest'

import type { MatrixStoreEntitlement } from '../../shared/matrix-store'

import { matrixConversationKey } from './invocation'
import { prepareMatrixStoreContext } from './store-context'
const taskId = '00000000-0000-4000-8000-80c38ff207ee'
const assistantId = '00000000-0000-4000-8000-8d704e120b50'

const entitlement: MatrixStoreEntitlement = {
  id: taskId,
  itemId: 'skill/writer',
  kind: 'skill',
  state: 'active',
  assistantId,
  delivery: 'cloud',
  grantedAt: new Date().toISOString(),
  subscription: null
}

function fixture(entitlements: MatrixStoreEntitlement[]) {
  return {
    entitlements,
    assistantId,
    executorId: taskId,
    conversationId: '!room:test',
    invocationId: taskId,
    signal: new AbortController().signal,
    current: () => true,
    request: vi.fn(async () => ({ taskId }))
  }
}

it('ordinary chats need no Store availability, including inactive or foreign grants', async () => {
  for (const entitlements of [
    [],
    [{ ...entitlement, state: 'revoked' as const }],
    [{ ...entitlement, assistantId: taskId }]
  ]) {
    const input = fixture(entitlements)
    input.request.mockRejectedValue(new Error('store_offline'))
    expect(await prepareMatrixStoreContext(input)).toBeUndefined()
    expect(input.request).not.toHaveBeenCalled()
  }
})
it('uses only the native execution proof and fails closed after account handoff', async () => {
  const input = fixture([entitlement])
  expect(await prepareMatrixStoreContext(input)).toMatchObject({ taskId, assistantId, invocationId: taskId })
  expect(input.request).toHaveBeenCalledWith({
    assistantId,
    executorId: taskId,
    conversationId: '!room:test',
    invocationId: taskId
  })
  input.current = () => false
  await expect(prepareMatrixStoreContext(input)).rejects.toThrow('matrix_store_execution_denied')
})
it('expires cancelled subscriptions without consulting Store', async () => {
  const input = fixture([
    {
      ...entitlement,
      subscription: { state: 'cancelled', renewAt: new Date(0).toISOString(), priceMicroProtons: 1, offerVersion: 1 }
    }
  ])

  expect(await prepareMatrixStoreContext(input)).toBeUndefined()
  expect(input.request).not.toHaveBeenCalled()
})
it('each paid context has a fresh session while unchanged contexts reuse their session', () => {
  const agent = {
    issuer: 'https://auth.test',
    principal: taskId,
    agentPrincipal: assistantId,
    executorId: taskId,
    deviceId: 'AGENT'
  }

  const human = { userId: '@owner:test', deviceId: 'HUMAN' }
  const free = matrixConversationKey(agent, human, '!room:test')
  const paid = matrixConversationKey(agent, human, '!room:test', taskId)
  expect(paid).not.toBe(free)
  expect(matrixConversationKey(agent, human, '!room:test', taskId)).toBe(paid)
  expect(matrixConversationKey(agent, human, '!room:test', assistantId)).not.toBe(paid)
  expect(matrixConversationKey(agent, human, '!room:test')).toBe(free)
})

it('lets the server resolve an active subscription after the cached renewal date', async () => {
  const input = fixture([
    {
      ...entitlement,
      subscription: { state: 'active', renewAt: new Date(0).toISOString(), priceMicroProtons: 1, offerVersion: 1 }
    }
  ])
  expect(await prepareMatrixStoreContext(input)).toMatchObject({ taskId })
  expect(input.request).toHaveBeenCalledOnce()
})

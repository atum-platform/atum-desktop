import type { MatrixStoreEntitlement } from '../../shared/matrix-store'

import type { MatrixTurnSlot } from './agent-runtime'

/** A paid context is a distinct Hermes session; the Matrix room stays unchanged. */
export async function prepareMatrixStoreContext(input: {
  entitlements: MatrixStoreEntitlement[]
  assistantId?: string
  executorId: string
  conversationId: string
  leaseToken?: string
  invocationId?: string
  signal: AbortSignal
  current(): boolean
  request(binding: object): Promise<unknown>
}): Promise<MatrixTurnSlot['storeTask']> {
  if (
    !input.assistantId ||
    !input.entitlements.some(
      e =>
        e.state === 'active' &&
        ['skill', 'agent'].includes(e.kind) &&
        (e.assistantId === null || e.assistantId === input.assistantId) &&
        (!e.subscription ||
          e.subscription.state === 'active' ||
          (e.subscription.state === 'cancelled' && Date.parse(e.subscription.renewAt) > Date.now()))
    )
  ) {
    return undefined
  }

  const binding: Omit<NonNullable<MatrixTurnSlot['storeTask']>, 'taskId'> = {
    assistantId: input.assistantId,
    executorId: input.executorId,
    conversationId: input.conversationId,
    ...(input.leaseToken ? { leaseToken: input.leaseToken } : { invocationId: input.invocationId })
  }

  if (!binding.leaseToken && !binding.invocationId) {
    throw new Error('matrix_store_execution_denied')
  }

  const value = (await input.request(binding)) as { taskId?: unknown }
  input.signal.throwIfAborted()

  if (
    !input.current() ||
    typeof value?.taskId !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.taskId)
  ) {
    throw new Error('matrix_store_execution_denied')
  }

  return { ...binding, taskId: value.taskId }
}

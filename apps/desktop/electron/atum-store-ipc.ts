// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import type { AtumStoreService } from './atum-store'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

export interface AtumStoreIpcAuthority {
  assertTrustedSender(event: unknown): void
}

export const ATUM_STORE_IPC_CHANNELS = [
  'atum:store:catalog',
  'atum:store:purchase',
  'atum:store:purchase:status',
  'atum:store:refresh',
  'atum:store:training:start',
  'atum:store:hiring:list',
  'atum:store:hiring:hire',
  'atum:store:hiring:cancel',
  'atum:store:agent:task'
] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label}_invalid`)
  }

  return value
}

function offerVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('offer_version_invalid')
  }

  return value
}

/**
 * The store's renderer surface. The renderer mints the idempotency key once per
 * confirmation and passes it in — main never generates one, so a retry of the
 * same confirmation is the platform's idempotent replay, not a second charge.
 */
export function registerAtumStoreIpc(
  ipc: IpcMainLike,
  service: AtumStoreService,
  authority: AtumStoreIpcAuthority
): () => void {
  ipc.handle('atum:store:catalog', event => {
    authority.assertTrustedSender(event)

    return service.catalog()
  })
  ipc.handle('atum:store:purchase', (event, offerId, version, idempotencyKey, accountId, assistantId) => {
    authority.assertTrustedSender(event)

    // The account the renderer confirmed for. Main compares it against its own
    // authoritative account before anything is charged.
    return service.purchase(
      id(offerId, 'offer_id'),
      offerVersion(version),
      id(idempotencyKey, 'idempotency_key'),
      accountId === undefined ? undefined : id(accountId, 'account_id'),
      assistantId == null ? null : id(assistantId, 'assistant_id')
    )
  })
  ipc.handle('atum:store:purchase:status', (event, purchaseId) => {
    authority.assertTrustedSender(event)

    return service.purchaseStatus(id(purchaseId, 'purchase_id'))
  })
  ipc.handle('atum:store:training:start', (event, assistantId, conversationId, skillId, accountId) => {
    authority.assertTrustedSender(event)

    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 256 ||
        typeof skillId !== 'string' || !skillId || skillId.length > 128) { throw new Error('training_input_invalid') }

    return service.startTrainingTask(id(assistantId, 'assistant_id'), conversationId, skillId, id(accountId, 'account_id'))
  })
  ipc.handle('atum:store:hiring:list', (event, accountId) => {
    authority.assertTrustedSender(event)
    return service.agentHires(id(accountId, 'account_id'))
  })
  ipc.handle('atum:store:hiring:hire', (event, assistantId, offerId, version, key, consent, accountId) => {
    authority.assertTrustedSender(event)
    if (consent !== true) { throw new Error('hiring_consent_required') }
    return service.hireAgent(id(assistantId, 'assistant_id'), id(offerId, 'offer_id'), offerVersion(version),
      id(key, 'idempotency_key'), consent, id(accountId, 'account_id'))
  })
  ipc.handle('atum:store:hiring:cancel', (event, hireId, accountId) => {
    authority.assertTrustedSender(event)
    return service.cancelAgentHire(id(hireId, 'hire_id'), id(accountId, 'account_id'))
  })
  ipc.handle('atum:store:agent:task', (event, assistantId, conversationId, skillId, accountId) => {
    authority.assertTrustedSender(event)
    if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(conversationId) ||
      (skillId !== null && (typeof skillId !== 'string' || !/^[a-z0-9][a-z0-9/_-]{0,127}$/u.test(skillId)))) { throw new Error('training_input_invalid') }
    return service.startAgentTask(id(assistantId, 'assistant_id'), conversationId, skillId as string | null, id(accountId, 'account_id'))
  })
  ipc.handle('atum:store:refresh', event => {
    authority.assertTrustedSender(event)

    return service.refresh()
  })

  return () => ATUM_STORE_IPC_CHANNELS.forEach(channel => ipc.removeHandler?.(channel))
}

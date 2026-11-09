import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import type { AtumStoreService } from './atum-store'
import { ATUM_STORE_IPC_CHANNELS, registerAtumStoreIpc } from './atum-store-ipc'

const OFFER_ID = '00000000-0000-4000-8000-50d86b120e98'
const PURCHASE_ID = '00000000-0000-4000-8000-0bb5de138389'
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-6cc9b1298c8f'
const ACCOUNT_ID = '00000000-0000-4000-8000-2dab195ed4f7'

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const service = {
    agentHires: vi.fn(async () => 'hiring-list'),
    hireAgent: vi.fn(async () => 'hired'),
    cancelAgentHire: vi.fn(async () => 'cancelled'),
    startAgentTask: vi.fn(async () => null),
    catalog: vi.fn(async () => 'catalog-result'),
    purchase: vi.fn(async () => 'purchase-result'),
    purchaseStatus: vi.fn(async () => 'status-result'),
    startTrainingTask: vi.fn(async () => 'training-result'),
    refresh: vi.fn(async () => 'refresh-result')
  }

  const unregister = registerAtumStoreIpc(
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: channel => {
        handlers.delete(channel)
      }
    },
    service as unknown as AtumStoreService,
    {
      assertTrustedSender: event => {
        if (event !== 'trusted') {
          throw new Error('not_trusted')
        }
      }
    }
  )

  return { handlers, service, unregister }
}

test('registers the store channels and removes them on dispose', () => {
  const { handlers, unregister } = harness()

  assert.deepEqual([...handlers.keys()].sort(), [...ATUM_STORE_IPC_CHANNELS].sort())
  unregister()
  assert.equal(handlers.size, 0)
})

test('trusted senders reach the service; the renderer-minted idempotency key passes through', async () => {
  const { handlers, service } = harness()

  assert.equal(await handlers.get('atum:store:catalog')!('trusted'), 'catalog-result')
  assert.equal(
    await handlers.get('atum:store:purchase')!('trusted', OFFER_ID, 3, IDEMPOTENCY_KEY),
    'purchase-result'
  )
  // Without the account the renderer confirmed for, main cannot tell A's
  // Preserve the recovery and user-visible behavior covered by this path.
  // none still works, and main falls back to its own fence alone.
  assert.deepEqual(service.purchase.mock.calls, [[OFFER_ID, 3, IDEMPOTENCY_KEY, undefined, null]])
  assert.equal(
    await handlers.get('atum:store:purchase')!('trusted', OFFER_ID, 3, IDEMPOTENCY_KEY, ACCOUNT_ID),
    'purchase-result'
  )
  assert.deepEqual(service.purchase.mock.calls[1], [OFFER_ID, 3, IDEMPOTENCY_KEY, ACCOUNT_ID, null])
  assert.equal(await handlers.get('atum:store:purchase:status')!('trusted', PURCHASE_ID), 'status-result')
  assert.deepEqual(service.purchaseStatus.mock.calls, [[PURCHASE_ID]])
  assert.equal(await handlers.get('atum:store:refresh')!('trusted'), 'refresh-result')
})

test('untrusted senders are refused on every channel before any service call', () => {
  const { handlers, service } = harness()

  for (const channel of ATUM_STORE_IPC_CHANNELS) {
    assert.throws(() => handlers.get(channel)!('forged', OFFER_ID, 3, IDEMPOTENCY_KEY), /not_trusted/)
  }

  assert.equal(service.catalog.mock.calls.length, 0)
  assert.equal(service.purchase.mock.calls.length, 0)
  assert.equal(service.purchaseStatus.mock.calls.length, 0)
  assert.equal(service.refresh.mock.calls.length, 0)
  assert.equal(service.startTrainingTask.mock.calls.length, 0)
})

test('training passes one validated employee and conversation within its confirmed account', async () => {
  const { handlers, service } = harness()
  const start = handlers.get('atum:store:training:start')!
  assert.equal(await start('trusted', OFFER_ID, 'conversation-1', 'scribe', ACCOUNT_ID), 'training-result')
  assert.deepEqual(service.startTrainingTask.mock.calls, [[OFFER_ID, 'conversation-1', 'scribe', ACCOUNT_ID]])
  assert.throws(() => start('trusted', 'invalid', 'conversation-1', 'scribe', ACCOUNT_ID), /assistant_id_invalid/)
  assert.throws(() => start('trusted', OFFER_ID, 'conversation-1', 'scribe', 'invalid'), /account_id_invalid/)
  assert.throws(() => start('trusted', OFFER_ID, '', 'scribe', ACCOUNT_ID), /training_input_invalid/)
  assert.throws(() => start('trusted', OFFER_ID, 'conversation-1', '', ACCOUNT_ID), /training_input_invalid/)
  assert.equal(service.startTrainingTask.mock.calls.length, 1)
})

test('purchase inputs are validated before the service is called', () => {
  const { handlers, service } = harness()
  const purchase = handlers.get('atum:store:purchase')!

  assert.throws(() => purchase('trusted', 'not-a-uuid', 3, IDEMPOTENCY_KEY), /offer_id_invalid/)
  assert.throws(() => purchase('trusted', OFFER_ID, 0, IDEMPOTENCY_KEY), /offer_version_invalid/)
  assert.throws(() => purchase('trusted', OFFER_ID, 1.5, IDEMPOTENCY_KEY), /offer_version_invalid/)
  assert.throws(() => purchase('trusted', OFFER_ID, 3, 'not-a-uuid'), /idempotency_key_invalid/)
  assert.throws(
    () => handlers.get('atum:store:purchase:status')!('trusted', 'not-a-uuid'),
    /purchase_id_invalid/
  )
  assert.equal(service.purchase.mock.calls.length, 0)
  assert.equal(service.purchaseStatus.mock.calls.length, 0)
})


test('monthly hiring requires explicit consent and the checkout account at IPC', async () => {
  const { handlers, service } = harness()
  const hire = handlers.get('atum:store:hiring:hire')!
  for (const consent of [false, null, undefined, 'true', 1]) {
    assert.throws(() => hire('trusted', PURCHASE_ID, OFFER_ID, 1, IDEMPOTENCY_KEY, consent, ACCOUNT_ID), /hiring_consent_required/)
  }
  assert.throws(() => hire('trusted', PURCHASE_ID, OFFER_ID, 1, IDEMPOTENCY_KEY, true, undefined), /account_id_invalid/)
  assert.equal(service.hireAgent.mock.calls.length, 0)
  assert.equal(await hire('trusted', PURCHASE_ID, OFFER_ID, 1, IDEMPOTENCY_KEY, true, ACCOUNT_ID), 'hired')
  assert.deepEqual(service.hireAgent.mock.calls[0], [PURCHASE_ID, OFFER_ID, 1, IDEMPOTENCY_KEY, true, ACCOUNT_ID])
  assert.equal(await handlers.get('atum:store:agent:task')!('trusted', PURCHASE_ID, 'conversation', null, ACCOUNT_ID), null)
  assert.deepEqual(service.startAgentTask.mock.calls[0], [PURCHASE_ID, 'conversation', null, ACCOUNT_ID])
})

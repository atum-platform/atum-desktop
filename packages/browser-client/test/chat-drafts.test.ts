import { IDBFactory, IDBDatabase } from 'fake-indexeddb'
import { expect, it, vi } from 'vitest'
import { ChatStorage, type ChatDraft, type ChatSend } from '../src/chat-storage'
import { ChatOutbox } from '../src/chat-outbox'

const identity = { userId: '@owner:test', deviceId: 'WEB_DEVICE' }
const draft: ChatDraft = { userId: identity.userId, principal: 'agent-1', body: 'Question', version: 'v1' }
const send: ChatSend = {
  ...identity,
  id: 'txn',
  roomId: '!room:test',
  body: draft.body,
  phase: 'uncertain',
  createdAt: 1,
  credentialEpoch: 'epoch'
}

it('upgrades version one without changing auth or outbox and restores only account-owned drafts', async () => {
  const factory = new IDBFactory()
  await new Promise<void>((resolve, reject) => {
    const opening = factory.open('atum-browser-chat-v1', 1)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('auth').put({ fixture: 'authentication' }, 'matrix')
      opening.result.createObjectStore('outbox', { keyPath: 'id' }).put(send)
    }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      opening.result.close()
      resolve()
    }
  })
  const store = await ChatStorage.open(factory)
  expect(await store.device.read()).toEqual({ fixture: 'authentication' })
  expect(await store.sends(identity.userId, identity.deviceId)).toEqual([send])
  await store.putDraft(draft)
  await store.putDraft({ ...draft, userId: '@other:test', body: 'Other account' })
  await store.putDraft({ ...draft, principal: 'agent-2', body: 'Second agent' })
  store.close()
  const reloaded = await ChatStorage.open(factory)
  expect(await reloaded.drafts(identity.userId)).toEqual([
    draft,
    { ...draft, principal: 'agent-2', body: 'Second agent' }
  ])
  expect(await reloaded.drafts('@other:test')).toEqual([{ ...draft, userId: '@other:test', body: 'Other account' }])
  await reloaded.putDraft({ ...draft, body: '' })
  expect(await reloaded.drafts(identity.userId)).toHaveLength(1)
  await reloaded.clearAuthentication()
  expect(await reloaded.device.read()).toBeUndefined()
  expect(await reloaded.drafts(identity.userId)).toEqual([])
  expect(await reloaded.drafts('@other:test')).toEqual([])
  expect(await reloaded.sends(identity.userId, identity.deviceId)).toEqual([])
  reloaded.close()
})

it('commits the outbox and draft removal together before network IO, including uncertain outcomes', async () => {
  const factory = new IDBFactory()
  const store = await ChatStorage.open(factory)
  await store.putDraft(draft)
  const persisted = vi.fn()
  const network = vi.fn(async () => {
    expect(await store.drafts(identity.userId)).toEqual([])
    expect(await store.sends(identity.userId, identity.deviceId)).toHaveLength(1)
    expect(persisted).toHaveBeenCalledOnce()
    throw new Error('lost_response')
  })
  const outbox = new ChatOutbox(store, identity, network, () => 'epoch')
  await expect(outbox.submit(send.roomId, draft.body, draft, persisted)).rejects.toThrow('send_uncertain')
  store.close()
  const reloaded = await ChatStorage.open(factory)
  expect(await reloaded.drafts(identity.userId)).toEqual([])
  expect(await reloaded.sends(identity.userId, identity.deviceId)).toHaveLength(1)
  expect(network).toHaveBeenCalledOnce()
  reloaded.close()
})

it('keeps a newer saved version, even with identical text, and refuses mismatched accounts or bodies', async () => {
  const store = await ChatStorage.open(new IDBFactory())
  const newer = { ...draft, version: 'v2' }
  await store.putDraft(newer)
  await store.putSend(send, draft)
  expect(await store.drafts(identity.userId)).toEqual([newer])
  await expect(store.putSend({ ...send, id: 'wrong-user', userId: '@other:test' }, draft)).rejects.toThrow(
    'operation_failed'
  )
  await expect(store.putSend({ ...send, id: 'wrong-body', body: 'Other' }, draft)).rejects.toThrow('operation_failed')
  expect(await store.sends(identity.userId, identity.deviceId)).toEqual([send])
  store.close()
})

it('an aborted reservation retains the draft, rolls back the outbox, and sends nothing', async () => {
  const store = await ChatStorage.open(new IDBFactory())
  await store.putDraft(draft)
  const original = IDBDatabase.prototype.transaction
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (
    this: IDBDatabase,
    ...args
  ) {
    const tx = original.apply(this, args)
    queueMicrotask(() => tx.abort())
    return tx
  })
  const network = vi.fn(async () => '$event')
  try {
    await expect(
      new ChatOutbox(store, identity, network, () => 'epoch').submit(send.roomId, draft.body, draft)
    ).rejects.toThrow('operation_failed')
  } finally {
    transaction.mockRestore()
  }
  expect(network).not.toHaveBeenCalled()
  expect(await store.drafts(identity.userId)).toEqual([draft])
  expect(await store.sends(identity.userId, identity.deviceId)).toEqual([])
  store.close()
})

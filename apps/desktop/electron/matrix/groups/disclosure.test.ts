import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../../encrypted-store'
import { parseMatrixCommand } from '../ipc-policy'

import { groupDisclosureEpoch, publishDisclosedGroupAnswer } from './disclosure'

const roots: string[] = []
const one = `matrix-conversation-${'a'.repeat(64)}`
const two = `matrix-conversation-${'b'.repeat(64)}`
const room = `matrix-conversation-${'c'.repeat(64)}`

it('refuses a valid native disclosure transaction at the renderer command boundary', () => {
  expect(() => parseMatrixCommand({ kind: 'publishGroupNotice', roomId: '!group:test',
    body: 'I’m an AI assistant.', transactionId: `atum-gd-${'a'.repeat(64)}` })).toThrow('matrix_command_invalid')
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'groups-disclosure-'))
  roots.push(root)

  const store = new EncryptedStore(join(root, 'vault.json'), {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`fixture:${text}`),
    decryptString: bytes => bytes.toString().slice(8)
  })

  store.setItem(one, JSON.stringify({ version: 2, storedSession: 'stored-one', sharedRoom: true, future: 'keep' }))
  store.setItem(two, JSON.stringify({ version: 2, storedSession: 'stored-two', sharedRoom: true }))
  const order: string[] = []

  const input = {
    mode: 'shared' as const,
    audience: ['@other:test'],
    conversationKey: one,
    roomConversationKey: room,
    invocationId: 'invocation-one',
    store,
    requireRoom: vi.fn(async (): Promise<string | undefined> => '1'.repeat(64)),
    publishDisclosure: vi.fn(async (_transaction: string) => {
      order.push('notice')

      return '$notice'
    }),
    publishAnswer: vi.fn(async () => {
      order.push('answer')

      return '$answer'
    })
  }

  return { store, input, order }
}

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

it('posts disclosure before the first shared answer, preserves the session link and skips repeat audience after restart', async () => {
  const f = fixture()
  expect(await publishDisclosedGroupAnswer(f.input)).toBe('$answer')
  expect(f.order).toEqual(['notice', 'answer'])
  expect(JSON.parse(f.store.getItem(one)!)).toEqual({
    version: 2,
    storedSession: 'stored-one',
    sharedRoom: true,
    future: 'keep',
    disclosedAudience: { members: ['@other:test'], epoch: '1'.repeat(64) }
  })

  const freshStore = new EncryptedStore(join(roots[0], 'vault.json'), {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`fixture:${text}`),
    decryptString: bytes => bytes.toString().slice(8)
  })

  await publishDisclosedGroupAnswer({ ...f.input, store: freshStore, invocationId: 'invocation-two' })
  expect(f.order).toEqual(['notice', 'answer', 'answer'])
  expect(f.input.publishDisclosure).toHaveBeenCalledTimes(1)
})

it('detects an offline audience change and A -> B -> A even though the old A session link still exists', async () => {
  const f = fixture()
  await publishDisclosedGroupAnswer(f.input)
  await publishDisclosedGroupAnswer({
    ...f.input,
    audience: ['@new:test', '@other:test'],
    conversationKey: two,
    invocationId: 'invocation-two'
  })
  await publishDisclosedGroupAnswer({ ...f.input, invocationId: 'invocation-three' })
  expect(f.order).toEqual(['notice', 'answer', 'notice', 'answer', 'notice', 'answer'])
  expect(new Set(f.input.publishDisclosure.mock.calls.map(([transaction]) => transaction)).size).toBe(3)
})

it('does not read, write or publish disclosure in a meeting room', async () => {
  const f = fixture()
  const read = vi.spyOn(f.store, 'getItem')
  const write = vi.spyOn(f.store, 'setItems')
  await publishDisclosedGroupAnswer({ ...f.input, mode: 'meeting', audience: [] })
  expect(f.order).toEqual(['answer'])
  expect(read).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('uses the same notice transaction on uncertain publication recovery and never publishes the answer first', async () => {
  const f = fixture()
  f.input.publishDisclosure.mockRejectedValueOnce(new Error('lost ACK'))
  await expect(publishDisclosedGroupAnswer(f.input)).rejects.toThrow('lost ACK')
  expect(f.input.publishAnswer).not.toHaveBeenCalled()
  await publishDisclosedGroupAnswer(f.input)
  expect(f.input.publishDisclosure.mock.calls[0][0]).toBe(f.input.publishDisclosure.mock.calls[1][0])
})

it('does not publish an answer or mark a disclosure when publication fails, membership changes or vault writes fail', async () => {
  for (const failure of ['notice', 'room', 'vault'] as const) {
    const f = fixture()

    if (failure === 'notice') {f.input.publishDisclosure.mockResolvedValueOnce('not-an-event')}

    if (failure === 'room') {f.input.requireRoom.mockRejectedValueOnce(new Error('matrix_group_changed'))}

    if (failure === 'vault')
      {vi.spyOn(f.store, 'setItems').mockImplementationOnce(() => {
        throw new Error('disk_full')
      })}

    await expect(publishDisclosedGroupAnswer(f.input)).rejects.toThrow()
    expect(f.input.publishAnswer).not.toHaveBeenCalled()
    expect(JSON.parse(f.store.getItem(one)!)).not.toHaveProperty('disclosedAudience')
    expect(f.store.getItem(`${room}:disclosure`)).toBeNull()
  }
})

it.each([
  { label: 'empty', audience: [] },
  { label: 'malformed', audience: ['not-a-matrix-user'] }
])('refuses a shared $label audience before notice or answer', async ({ audience }) => {
  const f = fixture()

  await expect(publishDisclosedGroupAnswer({ ...f.input, audience }))
    .rejects.toThrow('matrix_group_disclosure_unavailable')
  expect(f.input.publishDisclosure).not.toHaveBeenCalled()
  expect(f.input.publishAnswer).not.toHaveBeenCalled()
  expect(f.store.getItem(`${room}:disclosure`)).toBeNull()
})

it('preserves the acknowledged disclosure through answer retry, but refuses private or missing links', async () => {
  const f = fixture()
  f.input.publishAnswer.mockRejectedValueOnce(new Error('offline'))
  await expect(publishDisclosedGroupAnswer(f.input)).rejects.toThrow('offline')
  await publishDisclosedGroupAnswer(f.input)
  expect(f.input.publishDisclosure).toHaveBeenCalledTimes(1)
  f.store.setItem(one, JSON.stringify({ version: 2, storedSession: 'private' }))
  await expect(publishDisclosedGroupAnswer(f.input)).rejects.toThrow('matrix_group_disclosure_unavailable')
})

it('discloses again for a returning member even if their user ID and the audience set are unchanged', async () => {
  const f = fixture()
  const old = groupDisclosureEpoch([{ userId: '@other:test', membershipEventId: '$join-one' }], f.input.audience)
  const next = groupDisclosureEpoch([{ userId: '@other:test', membershipEventId: '$join-two' }], f.input.audience)
  f.input.requireRoom.mockResolvedValue(old)
  await publishDisclosedGroupAnswer(f.input)
  f.input.requireRoom.mockResolvedValue(next)
  await publishDisclosedGroupAnswer({ ...f.input, invocationId: 'invocation-two' })
  expect(f.order).toEqual(['notice', 'answer', 'notice', 'answer'])
  expect(old).not.toBe(next)
  expect(() => groupDisclosureEpoch([{ userId: '@other:test' }], f.input.audience)).toThrow()
})

it('refuses a new membership epoch after notice ACK and before answer publication', async () => {
  const f = fixture()
  f.input.requireRoom
    .mockResolvedValueOnce('1'.repeat(64))
    .mockResolvedValueOnce('1'.repeat(64))
    .mockResolvedValue('2'.repeat(64))
  await expect(publishDisclosedGroupAnswer(f.input)).rejects.toThrow('matrix_group_changed')
  expect(f.input.publishAnswer).not.toHaveBeenCalled()
  expect(f.store.getItem(`${room}:disclosure`)).toBeNull()
})

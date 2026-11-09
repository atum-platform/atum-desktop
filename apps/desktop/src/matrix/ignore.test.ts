import { createClient, EventType, MatrixEvent, Method, Room } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { changeIgnoredUser, ignoredInvitation } from './ignore'

afterEach(() => vi.restoreAllMocks())

it('does not hide an invitation whose inviter is missing; joined room state is not an invitation', () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
  const room = new Room('!room:test', client, '@alice:test')
  room.updateMyMembership('invite')
  expect(ignoredInvitation(client, room)).toBe(false)
  room.currentState.setStateEvents([
    new MatrixEvent({ type: EventType.RoomMember, state_key: '@alice:test', content: { membership: 'invite' } })
  ])
  expect(ignoredInvitation(client, room)).toBe(false)
  room.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomMember,
      state_key: '@alice:test',
      sender: '@bob:test',
      content: { membership: 'join' }
    })
  ])
  room.updateMyMembership('join')
  client.store.storeAccountDataEvents([
    new MatrixEvent({ type: EventType.IgnoredUserList, content: { ignored_users: { '@bob:test': {} } } })
  ])
  expect(ignoredInvitation(client, room)).toBe(false)
})

it('merges authoritative account data, not stale SDK cache; sends one SDK write without changing cache', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
  client.store.storeAccountDataEvents([
    new MatrixEvent({ type: EventType.IgnoredUserList, content: { ignored_users: { '@stale:test': {} } } })
  ])
  const read = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({ ignored_users: { '@carol:test': {} } })
  const write = vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  await changeIgnoredUser(client, '@bob:test', true, () => true)
  expect(read).toHaveBeenCalledWith(Method.Get, '/user/%40alice%3Atest/account_data/m.ignored_user_list')
  expect(write).toHaveBeenCalledExactlyOnceWith(EventType.IgnoredUserList, {
    ignored_users: { '@carol:test': {}, '@bob:test': {} }
  })
  expect(client.getIgnoredUsers()).toEqual(['@stale:test'])
  read.mockResolvedValue({ ignored_users: { '@carol:test': {}, '@bob:test': {} } })
  await changeIgnoredUser(client, '@bob:test', false, () => true)
  expect(write).toHaveBeenLastCalledWith(EventType.IgnoredUserList, { ignored_users: { '@carol:test': {} } })
})

it('handles only missing account data as empty and never writes after failure, account stop or self-ignore', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
  const read = vi.spyOn(client.http, 'authedRequest').mockRejectedValue({ errcode: 'M_NOT_FOUND' })
  const write = vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
  await changeIgnoredUser(client, '@bob:test', true, () => true)
  expect(write).toHaveBeenCalledTimes(1)
  read.mockRejectedValue(new Error('offline'))
  await expect(changeIgnoredUser(client, '@bob:test', true, () => true)).rejects.toThrow('offline')
  read.mockResolvedValue({ ignored_users: {} })
  await expect(changeIgnoredUser(client, '@bob:test', true, () => false)).rejects.toThrow('matrix_sdk_stopped')
  await expect(changeIgnoredUser(client, '@alice:test', true, () => true)).rejects.toThrow('matrix_ignore_self')
  expect(write).toHaveBeenCalledTimes(1)
})

it.each([null, {}, { ignored_users: [] }, { ignored_users: 'invalid' }])(
  'does not overwrite malformed account data: %j',
  async content => {
    const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
    vi.spyOn(client.http, 'authedRequest').mockResolvedValue(content)
    const write = vi.spyOn(client, 'setAccountDataRaw').mockResolvedValue({})
    await expect(changeIgnoredUser(client, '@bob:test', true, () => true)).rejects.toThrow(
      'matrix_ignore_invalid_account_data'
    )
    expect(write).not.toHaveBeenCalled()
  }
)

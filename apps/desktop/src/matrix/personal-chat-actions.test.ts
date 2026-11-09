import { expect, it } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { personalChatActions } from './roster-model'

const dm: MatrixRoom = {
  id: '!person:test',
  name: 'Person',
  membership: 'join',
  encrypted: false,
  direct: true,
  participants: [
    { userId: '@self:test', membership: 'join' },
    { userId: '@person:test', membership: 'join' }
  ]
}

const snapshot = (room: MatrixRoom): MatrixSnapshot => ({
  state: 'ready',
  roomId: room.id,
  rooms: [room],
  messages: [],
  error: null,
  identity: { userId: '@self:test', deviceId: 'SELF' }
})

it.each([
  ['person', {}, 'delete'],
  ['group', { direct: false }, 'leave'],
  ['assistant', { assistant: true }, null],
  ['agent history', { agentPrincipal: 'agent' }, null],
  ['bot', { appBot: { appId: 'moon', botUserId: '@moon:test' } }, null],
  ['company channel', { companyChannel: { companyId: 'company', channelId: 'channel' } }, null],
  ['company DM', { companyConversation: { companyId: 'company', conversationId: 'dm' } }, null],
  ['assistant home', { roomType: 'io.atum.assistant' }, null],
  ['manager', { companyPrivateCosBound: true }, null],
  ['left', { membership: 'leave' }, null],
  ['notes', { roomType: 'io.atum.notes_self' }, null]
] as const)('%s eligibility', (_name, patch, end) => {
  const room = { ...dm, ...patch } as MatrixRoom
  expect(personalChatActions(room, snapshot(room)).end).toBe(end)
})
it('blocks only the other person in a DM', () => {
  expect(personalChatActions(dm, snapshot(dm)).person).toBe('@person:test')
  const group = { ...dm, direct: false }
  expect(personalChatActions(group, snapshot(group)).person).toBeUndefined()
})
it('permits a normal user to delete their Founder chat, but protects founder self', () => {
  const s = { ...snapshot(dm), founder: { userId: '@person:test', roomId: dm.id } } as MatrixSnapshot
  expect(personalChatActions(dm, s).end).toBe('delete')
  s.officialAccounts = [{ userId: '@self:test', role: 'founder', tier: 'official' } as never]
  expect(personalChatActions(dm, s).end).toBeNull()
})

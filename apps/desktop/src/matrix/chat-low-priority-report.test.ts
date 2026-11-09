import { expect, it } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { sortConversations } from './room-navigation'
import { lowPriorityEligible, projectMatrixRoster, reportablePerson } from './roster-model'

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

const snapshot = (...rooms: MatrixRoom[]): MatrixSnapshot => ({
  state: 'ready',
  roomId: rooms[0]?.id ?? null,
  rooms,
  messages: [],
  error: null,
  identity: { userId: '@self:test', deviceId: 'SELF' }
})

const room = (id: string, patch: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name: id,
  membership: 'join',
  encrypted: false,
  ...patch
})

it.each([
  ['person', {}, true],
  ['group', { direct: false }, true],
  ['bot', { appBot: { appId: 'moon', botUserId: '@moon:test', hidden: true } }, false],
  ['company channel', { companyChannel: { companyId: 'company', channelId: 'channel' } }, false],
  ['notes', { roomType: 'io.atum.notes_self' }, true],
  ['invitation', { membership: 'invite' }, false],
  ['left', { membership: 'leave' }, false]
] as const)('low priority is offered on an ordinary chat in the list: %s', (_name, patch, offered) => {
  const value = { ...dm, ...patch } as MatrixRoom
  expect(lowPriorityEligible(value, snapshot(value))).toBe(offered)
})

it('an assistant chat drawn under its assistant is ordered there and does not offer it', () => {
  const assistant = {
    ...dm,
    id: '!assistant:test',
    assistant: true,
    roomType: 'io.atum.assistant',
    encrypted: true,
    participants: [
      { userId: '@self:test', membership: 'join' },
      { userId: '@agent:test', membership: 'join' }
    ]
  } as MatrixRoom

  const s = { ...snapshot(assistant), assistant: { userId: '@agent:test' } } as MatrixSnapshot

  expect(projectMatrixRoster(s).groups[0]?.rooms.map(value => value.id)).toEqual([assistant.id])
  expect(lowPriorityEligible(assistant, s)).toBe(false)
})

it('the Founder chat is pinned first and never offers low priority', () => {
  const s = {
    ...snapshot(dm),
    founder: { userId: '@person:test', roomId: dm.id },
    officialAccounts: [{ userId: '@person:test', role: 'founder', tier: 'official' }]
  } as MatrixSnapshot

  expect(projectMatrixRoster(s).founder?.id).toBe(dm.id)
  expect(lowPriorityEligible(dm, s)).toBe(false)
})

it('low priority chats sort below every other chat, pins stay first, recency within each', () => {
  const rooms = [
    room('!low-new', { lowPriority: true, lastActiveAt: 900 }),
    room('!plain-old', { lastActiveAt: 100 }),
    room('!pinned', { favourite: true, lastActiveAt: 1 }),
    room('!low-old', { lowPriority: true, lastActiveAt: 50 }),
    room('!plain-new', { lastActiveAt: 500 })
  ]

  expect(sortConversations(rooms).map(value => value.id)).toEqual([
    '!pinned',
    '!plain-new',
    '!plain-old',
    '!low-new',
    '!low-old'
  ])

  // The roster's own chat list is ordered the same way.
  expect(projectMatrixRoster(snapshot(...rooms)).rest.map(value => value.id)).toEqual([
    '!pinned',
    '!plain-new',
    '!plain-old',
    '!low-new',
    '!low-old'
  ])
})

it('a low priority chat still follows an assistant chat ordering rule only among the rest', () => {
  const rooms = [room('!low', { lowPriority: true, lastActiveAt: 9 }), room('!a', { assistant: true, lastActiveAt: 1 })]
  expect(sortConversations(rooms).map(value => value.id)).toEqual(['!a', '!low'])
})

it.each([
  ['the other person in a DM', dm, '@person:test', true],
  ['someone in a group', { ...dm, direct: false }, '@person:test', true],
  ['yourself', dm, '@self:test', false],
  ['nobody', dm, undefined, false],
  ['an assistant chat', { ...dm, assistant: true }, '@person:test', false],
  ['an agent history', { ...dm, agentPrincipal: 'agent' }, '@person:test', false],
  ['an app chat', { ...dm, appBot: { appId: 'moon', botUserId: '@person:test' } }, '@person:test', false],
  ['a Team Space room', { ...dm, companyChannel: { companyId: 'c', channelId: 'x' } }, '@person:test', false],
  ['an invitation', { ...dm, membership: 'invite' }, '@person:test', false]
] as const)('report is offered for %s as Block is', (_name, value, userId, offered) => {
  const target = value as MatrixRoom
  expect(reportablePerson(target, snapshot(target), userId)).toBe(offered)
})

it('never offers report on an assistant or an app bot who is in a group', () => {
  const group = { ...dm, direct: false }

  const s = {
    ...snapshot(group),
    agents: [{ principal: 'agent', userId: '@agent:test', isDefault: true, ready: true }],
    apps: { apps: [{ app_id: 'moon', bot: { user_id: '@moon:test' } }] }
  } as unknown as MatrixSnapshot

  expect(reportablePerson(group, s, '@agent:test')).toBe(false)
  expect(reportablePerson(group, s, '@moon:test')).toBe(false)
  expect(reportablePerson(group, s, '@person:test')).toBe(true)
})

it('the Founder never reports from the Founder chat; anyone else may', () => {
  const s = { ...snapshot(dm), founder: { userId: '@person:test', roomId: dm.id } } as MatrixSnapshot
  expect(reportablePerson(dm, s, '@person:test')).toBe(true)

  const founder = {
    ...s,
    founder: { userId: '@self:test', roomId: dm.id },
    officialAccounts: [{ userId: '@self:test', role: 'founder', tier: 'official' }]
  } as MatrixSnapshot

  expect(reportablePerson(dm, founder, '@person:test')).toBe(false)
})

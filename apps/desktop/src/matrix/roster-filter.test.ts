import { beforeEach, describe, expect, it } from 'vitest'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  $matrixRosterFilterByAccount,
  availableMatrixRosterFilters,
  effectiveMatrixRosterFilter,
  filterMatrixRosterByKind,
  matrixRememberedRosterFilter,
  rememberMatrixRosterFilter
} from './roster-filter'
import { projectMatrixRoster } from './roster-model'

const owner = '@owner:test'

function agent(principal: string, userId: string, isDefault = false): MatrixAgentView {
  return { principal, userId, isDefault, ready: true, hermes: 'ready', atumModel: true }
}

function room(id: string, members: string[], extra: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: true,
    participants: [owner, ...members].map(userId => ({ userId, membership: 'join' })),
    lastActiveAt: 1,
    ...extra
  }
}

const assistant = room('!atum:test', ['@atum:test'], { roomType: MATRIX_ASSISTANT_ROOM_TYPE })
const moon = room('!moon:test', ['@moon:test'], { roomType: MATRIX_ASSISTANT_ROOM_TYPE, agentPrincipal: 'moon', favourite: true })
const friend = room('!friend:test', ['@friend:test'], { direct: true, unreadNotifications: 2 })
const quiet = room('!quiet:test', ['@quiet:test'], { direct: true, lowPriority: true })
const team = room('!team:test', ['@a:test', '@b:test'], { favourite: true })

function snapshot(rooms: MatrixRoom[]): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [agent('default', '@atum:test', true), agent('moon', '@moon:test')],
    rooms,
    roomId: null,
    messages: [],
    error: null
  }
}

const projection = projectMatrixRoster(snapshot([assistant, moon, friend, quiet, team]))

function rows(filter: Parameters<typeof filterMatrixRosterByKind>[1]) {
  const view = filterMatrixRosterByKind(projection, filter, owner)

  return { agents: view.groups.map(group => group.agent.principal), chats: view.rest.map(entry => entry.id).sort() }
}

describe('Chat roster filter', () => {
  beforeEach(() => $matrixRosterFilterByAccount.set({}))

  it('All leaves the roster as it is', () => {
    expect(filterMatrixRosterByKind(projection, 'all', owner)).toBe(projection)
  })

  it('Unread keeps only chats waiting for the person', () => {
    expect(rows('unread')).toEqual({ agents: [], chats: ['!friend:test'] })
  })

  it('People keeps the one-to-one chats with people, never assistants or groups', () => {
    expect(rows('people')).toEqual({ agents: [], chats: ['!friend:test', '!quiet:test'] })
  })

  it('Groups keeps the chats with more than one other person', () => {
    expect(rows('groups')).toEqual({ agents: [], chats: ['!team:test'] })
  })

  it('Assistants keeps every assistant row and no chats', () => {
    expect(rows('assistants')).toEqual({ agents: ['default', 'moon'], chats: [] })
  })

  it('Favourites keeps what carries m.favourite, assistants included', () => {
    expect(rows('favourites')).toEqual({ agents: ['moon'], chats: ['!team:test'] })
  })

  it('Low priority keeps what carries m.lowpriority', () => {
    expect(rows('lowPriority')).toEqual({ agents: [], chats: ['!quiet:test'] })
  })

  it('offers only the filters that would show something', () => {
    const bare = projectMatrixRoster(snapshot([assistant, { ...team, favourite: false }]))

    expect(availableMatrixRosterFilters(projection, owner)).toEqual([
      'all',
      'unread',
      'people',
      'groups',
      'assistants',
      'favourites',
      'lowPriority'
    ])
    expect(availableMatrixRosterFilters(bare, owner)).toEqual(['all', 'groups', 'assistants'])
  })

  it('reads a saved filter with nothing left to show as All', () => {
    expect(effectiveMatrixRosterFilter('unread', ['all', 'groups'])).toBe('all')
    expect(effectiveMatrixRosterFilter('groups', ['all', 'groups'])).toBe('groups')
  })

  it('remembers the last choice per account', () => {
    rememberMatrixRosterFilter(owner, 'people')
    rememberMatrixRosterFilter('@other:test', 'groups')

    const saved = $matrixRosterFilterByAccount.get()

    expect(matrixRememberedRosterFilter(owner, saved)).toBe('people')
    expect(matrixRememberedRosterFilter('@other:test', saved)).toBe('groups')
    expect(matrixRememberedRosterFilter('@new:test', saved)).toBe('all')
    expect(matrixRememberedRosterFilter(owner, { [owner]: 'nonsense' })).toBe('all')
  })
})

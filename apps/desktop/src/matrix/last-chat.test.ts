import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

const KEY = 'atum.desktop.lastChatByAccount.v1'
const owner = { userId: '@owner:test', deviceId: 'DEVICE' }

const room = (id: string, fields: Partial<MatrixRoom> = {}) =>
  ({ id, name: id, membership: 'join', direct: true, encrypted: true, ...fields }) as MatrixRoom

const primaryRoom = room('!main:test', { agentPrincipal: 'agent-main' })
const friend = room('!friend:test', { favourite: true })

const snapshot = (fields: Partial<MatrixSnapshot> = {}) =>
  ({
    identity: owner,
    rooms: [friend, primaryRoom],
    agents: [{ principal: 'agent-main', userId: '@main:test', name: 'Main', isDefault: true, ready: true }],
    ...fields
  }) as MatrixSnapshot

/** A fresh window: the module, and so its atom, loads again from what the last run stored. */
async function relaunch() {
  vi.resetModules()

  return import('./last-chat')
}

afterEach(() => window.localStorage.removeItem(KEY))

describe('the last Chat', () => {
  it('survives a relaunch, per account', async () => {
    const first = await relaunch()
    first.rememberMatrixLastChat(owner.userId, friend.id)
    first.rememberMatrixLastChat('@other:test', '!elsewhere:test')

    const next = await relaunch()

    expect(next.matrixChatRoomToOpen(snapshot())).toBe(friend.id)
    const other = snapshot({ identity: { userId: '@other:test', deviceId: 'X' }, rooms: [friend, primaryRoom, room('!elsewhere:test')] })
    expect(next.matrixChatRoomToOpen(other)).toBe('!elsewhere:test')
  })

  it('opens the primary agent on a first launch, before any newer chat', async () => {
    const { matrixChatRoomToOpen } = await relaunch()

    expect(matrixChatRoomToOpen(snapshot())).toBe(primaryRoom.id)
  })

  it('falls back to the primary agent when the remembered chat was left or moved to Team space', async () => {
    const { matrixChatRoomToOpen, rememberMatrixLastChat } = await relaunch()
    rememberMatrixLastChat(owner.userId, friend.id)

    expect(matrixChatRoomToOpen(snapshot({ rooms: [{ ...friend, membership: 'leave' }, primaryRoom] }))).toBe(primaryRoom.id)
    expect(matrixChatRoomToOpen(snapshot({ rooms: [{ ...friend, companyChannel: { companyId: 'c1', channelId: 'general' } }, primaryRoom] }))).toBe(primaryRoom.id)
  })

  it('does not land in a former assistant\'s read-only chat', async () => {
    const { matrixChatRoomToOpen, rememberMatrixLastChat } = await relaunch()
    const former = room('!former:test', { assistant: true, agentPrincipal: 'agent-gone' })
    rememberMatrixLastChat(owner.userId, former.id)

    expect(matrixChatRoomToOpen(snapshot({ rooms: [former, primaryRoom] }))).toBe(primaryRoom.id)
  })

  it('opens the latest chat from Chats only when the account has no agent at all', async () => {
    const { matrixChatRoomToOpen } = await relaunch()
    const any = { anyConversation: true }

    expect(matrixChatRoomToOpen(snapshot({ agents: [], rooms: [friend] }), any)).toBe(friend.id)
    // A launch leaves that choice to the person.
    expect(matrixChatRoomToOpen(snapshot({ agents: [], rooms: [friend] }))).toBeUndefined()
    // While the roster is still loading, wait for the primary agent rather than guess.
    expect(matrixChatRoomToOpen(snapshot({ agents: [], rooms: [friend], agentRoster: { state: 'loading', since: 1 } }), any)).toBeUndefined()
  })

  it('reads a damaged store as empty', async () => {
    window.localStorage.setItem(KEY, '{not json')
    const { matrixChatRoomToOpen } = await relaunch()

    expect(matrixChatRoomToOpen(snapshot())).toBe(primaryRoom.id)
  })
})

import { describe, expect, it } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from './matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from './matrix-assistant-room'
import { matrixFirstRunEligibility } from './matrix-first-run-eligibility'

const owner = { userId: '@minh:test', deviceId: 'MAC' }
const atum = { userId: '@atum:test', deviceId: 'ATUM' }
const moon = { userId: '@moon:test', deviceId: 'MOON' }

const chat = (id: string, dialogue?: MatrixRoom['dialogue'], agent = atum.userId): MatrixRoom => ({
  id,
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: owner.userId, membership: 'join' },
    { userId: agent, membership: 'join' }
  ],
  ...(dialogue ? { dialogue } : {})
})

/** An account whose sync is complete, with no folder answer and no welcome record yet: the case to tell apart. */
const account: MatrixSnapshot = {
  state: 'ready',
  identity: owner,
  assistant: atum,
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  firstRunMarker: 'unseen',
  firstRunWelcome: 'unseen',
  agents: [
    { principal: 'p-atum', userId: atum.userId, name: 'Atum', isDefault: true, ready: true, hermes: 'ready', atumModel: true }
  ]
}

describe('whether an account is new, for its first run', () => {
  it('is new while its primary has no chat yet, or a chat whose history reaches its creation with no message', () => {
    expect(matrixFirstRunEligibility(account)).toBe('new')
    expect(matrixFirstRunEligibility({ ...account, rooms: [chat('!first:test', 'none')] })).toBe('new')
  })

  it('is an existing account once its primary has any dialogue, so the welcome never lands above history', () => {
    // A cloud-first account from before the welcome existed: no folder answer, a week of chat.
    expect(matrixFirstRunEligibility({ ...account, rooms: [chat('!first:test', 'started')] })).toBe('existing')
    // More than one chat is an account that has moved on, whatever the first one holds.
    expect(
      matrixFirstRunEligibility({ ...account, rooms: [chat('!first:test', 'none'), chat('!second:test', 'none')] })
    ).toBe('existing')
  })

  it('is an existing account once any device has answered the folder offer', () => {
    expect(matrixFirstRunEligibility({ ...account, firstRunMarker: 'answered' })).toBe('existing')
    expect(
      matrixFirstRunEligibility({ ...account, firstRunMarker: 'answered', rooms: [chat('!first:test', 'none')] })
    ).toBe('existing')
  })

  it('never calls an account new on what it cannot tell: unknown is not new', () => {
    // A chat whose loaded history cannot say whether anyone has spoken (a long history, not loaded).
    expect(matrixFirstRunEligibility({ ...account, rooms: [chat('!first:test')] })).toBe('unknown')
    // The folder marker is not known yet (not synced, or offline).
    expect(matrixFirstRunEligibility({ ...account, firstRunMarker: 'unknown' })).toBe('unknown')
    expect(matrixFirstRunEligibility({ ...account, firstRunMarker: undefined })).toBe('unknown')
    // Not ready, offline, degraded, or no primary known yet.
    expect(matrixFirstRunEligibility({ ...account, state: 'offline' })).toBe('unknown')
    expect(matrixFirstRunEligibility({ ...account, state: 'connecting' })).toBe('unknown')
    expect(matrixFirstRunEligibility({ ...account, degraded: true })).toBe('unknown')
    expect(matrixFirstRunEligibility({ ...account, assistant: undefined })).toBe('unknown')
    expect(matrixFirstRunEligibility({ ...account, identity: undefined })).toBe('unknown')
    // The assistant is not the roster's primary.
    expect(matrixFirstRunEligibility({ ...account, assistant: moon })).toBe('unknown')
  })

  it('reads only the primary assistant’s chats: another agent’s history says nothing about the account', () => {
    expect(
      matrixFirstRunEligibility({ ...account, rooms: [chat('!moon:test', 'started', moon.userId)] })
    ).toBe('new')
    // A chat that is not a joined private chat of the owner with the primary is not counted either.
    expect(
      matrixFirstRunEligibility({
        ...account,
        rooms: [{ ...chat('!left:test', 'started'), membership: 'leave' }]
      })
    ).toBe('new')
  })
})

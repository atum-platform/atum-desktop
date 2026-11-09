import { expect, it } from 'vitest'

import type { MatrixRoom } from './matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from './matrix-assistant-room'
import { isMatrixGroupRoom, matrixGroupAgents, matrixGroupAudience, matrixGroupMode } from './matrix-group-room'

const OWNER = '@owner:test'
const MINE = ['@atum:test', '@bea:test']
const at = (userId: string, membership = 'join') => ({ userId, membership })

it('is a private meeting only while everyone there is the owner or one of the owner’s assistants', () => {
  expect(matrixGroupMode([at(OWNER), at('@atum:test'), at('@bea:test')], OWNER, MINE)).toBe('meeting')
  // Anyone else, joined or merely invited, makes it shared: another person, someone else's
  // assistant, an app.
  expect(matrixGroupMode([at(OWNER), at('@atum:test'), at('@linh:test')], OWNER, MINE)).toBe('shared')
  expect(matrixGroupMode([at(OWNER), at('@atum:test'), at('@linh:test', 'invite')], OWNER, MINE)).toBe('shared')
  expect(matrixGroupMode([at(OWNER), at('@app-moon:test')], OWNER, MINE)).toBe('shared')
  // Someone who left no longer counts; an owner who isn't there has no meeting.
  expect(matrixGroupMode([at(OWNER), at('@atum:test'), at('@linh:test', 'leave')], OWNER, MINE)).toBe('meeting')
  expect(matrixGroupMode([at('@atum:test')], OWNER, MINE)).toBe('shared')
})

it('lists the owner’s own assistants in a room and recognises an ordinary group', () => {
  expect(matrixGroupAgents([at(OWNER), at('@bea:test', 'invite'), at('@atum:test', 'leave')], MINE)).toEqual(['@bea:test'])
  expect(isMatrixGroupRoom({ membership: 'join' })).toBe(true)
  expect(isMatrixGroupRoom({ membership: 'join', roomType: MATRIX_ASSISTANT_ROOM_TYPE })).toBe(false)
  expect(isMatrixGroupRoom({ membership: 'invite' })).toBe(false)
})

it('recognises a group without end-to-end encryption (every group since 0.20) as it does an encrypted one', () => {
  const group = (encrypted: boolean): MatrixRoom => ({ id: '!group:test', name: 'Nhóm', membership: 'join', encrypted })

  expect(isMatrixGroupRoom(group(false))).toBe(true)
  expect(isMatrixGroupRoom(group(true))).toBe(true)
  expect(isMatrixGroupRoom({ ...group(false), roomType: MATRIX_ASSISTANT_ROOM_TYPE })).toBe(false)
})

it('names the audience of a group: everyone present but the owner and the owner’s assistants', () => {
  expect(matrixGroupAudience([at(OWNER), at('@atum:test'), at('@bea:test', 'invite')], OWNER, MINE)).toEqual([])
  // Order and duplicates never matter; someone who left is not an audience.
  expect(
    matrixGroupAudience([at('@zed:test'), at(OWNER), at('@linh:test', 'invite'), at('@zed:test'), at('@an:test', 'leave')], OWNER, MINE)
  ).toEqual(['@linh:test', '@zed:test'])
})

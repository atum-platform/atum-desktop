import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { parseParticipantRef, parseParticipantSnapshot, participantDisplayKey, participantRefKey } from './atum-participants'

const fixtures = JSON.parse(readFileSync(new URL('../../../spec/participants/v1/fixtures.json', import.meta.url), 'utf8'))

test('existing references are closed, normalized and relationship-qualified', () => {
  const refs = fixtures.refs.map(parseParticipantRef)
  expect(new Set(refs.map(participantRefKey)).size).toBe(4)

  for (const ref of fixtures.invalid_refs) {expect(() => parseParticipantRef(ref)).toThrow()}
  expect(parseParticipantRef({ ...fixtures.refs[2], app_installation_id: fixtures.refs[2].app_installation_id.toUpperCase() })).toEqual(refs[2])
  expect(participantRefKey({ kind: 'user', id: refs[1].id })).not.toBe(participantRefKey(refs[1]))
})

test('two owners share an app identity, never a display cache key', () => {
  const alice = parseParticipantSnapshot(fixtures.snapshots.aliceMoon)!
  const bob = parseParticipantSnapshot(fixtures.snapshots.bobMoon)!
  expect(alice.id).toBe(bob.id)
  expect(participantDisplayKey(alice)).not.toBe(participantDisplayKey(bob))
  const { owner_user_id: _, ...missing } = fixtures.snapshots.aliceMoon
  expect(parseParticipantSnapshot(missing)).toBeNull()
  expect(parseParticipantSnapshot({ ...fixtures.snapshots.aliceMoon, avatar_url: 'https://user:secret@host.test/a.png' })).not.toHaveProperty('avatarUrl')
  expect(parseParticipantSnapshot({ ...fixtures.snapshots.aliceMoon, ref: fixtures.refs[2] })).not.toHaveProperty('ref')
})

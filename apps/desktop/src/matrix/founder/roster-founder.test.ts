import { expect, it } from 'vitest'

import type { MatrixRoom } from '../../../shared/matrix'

import { founderRoom, isFounderRoom } from './roster-founder'

const OWNER = '@owner:test'
const FOUNDER = '@founder:test'

const chat = (encrypted: boolean, id = '!founder:test', founder = FOUNDER): MatrixRoom => ({
  id,
  name: 'Founder',
  membership: 'join',
  encrypted,
  direct: true,
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: founder, membership: 'invite' }
  ]
})

const facts = (rooms: MatrixRoom[]) => ({
  identity: { userId: OWNER, deviceId: 'OWNER' },
  founder: { userId: FOUNDER, verification: 'official' as const, roomId: '!founder:test', handle: 'founder' },
  rooms
})

it('pins the recorded Founder chat whether it is plain (0.20) or encrypted (before)', () => {
  expect(founderRoom(facts([chat(false)]))?.id).toBe('!founder:test')
  expect(founderRoom(facts([chat(true)]))?.id).toBe('!founder:test')
})

it('never pins a room other than the recorded one, or one without the founder', () => {
  expect(isFounderRoom(facts([chat(false, '!other:test')]), '!other:test')).toBe(false)
  expect(founderRoom(facts([chat(false, '!founder:test', '@founder:elsewhere.test')]))).toBeUndefined()
})

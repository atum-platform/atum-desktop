import { expect, it } from 'vitest'

import { MatrixCompanyPrivateCosNotificationAuthority } from './company-private-cos-notification-authority'

const COMPANY = '00000000-0000-4000-8000-87c6455cae48'
const ROOM = '!private-cos:atum.example'
const scope = { accountKey: 'owner-account', generation: 1 }
const pair = {
  companyPrincipal: COMPANY,
  memberPrincipal: '00000000-0000-4000-8000-f6c6b8bb709f',
  membershipIncarnation: '00000000-0000-4000-8000-8a4e23bab81e'
}
const ready = {
  schemaVersion: 1 as const,
  state: 'ready' as const,
  pair,
  greetingState: 'published' as const,
  binding: {
    scope: { pair, authorityEpoch: 1, contextEpoch: 1, homeGeneration: 1 },
    agentPrincipal: '00000000-0000-4000-8000-f9ae298d66d3',
    agentUserId: '@private-cos:atum.example',
    executorId: '00000000-0000-4000-8000-31ba7dd260e2',
    homeId: '00000000-0000-4000-8000-7886f5c6d975',
    roomId: ROOM,
    storeGeneration: 1,
    profileDigest: 'a'.repeat(64)
  }
}

it('retains only authenticated bound rooms for the current native account scope', () => {
  const authority = new MatrixCompanyPrivateCosNotificationAuthority()

  expect(authority.observe(scope, ready)).toBe(true)
  expect(authority.roomIds(scope)).toEqual([ROOM])
  expect(authority.has(scope, ROOM)).toBe(true)
  expect(authority.observe(scope, { ...ready, state: 'forged' })).toBe(false)
  expect(authority.roomIds(scope)).toEqual([ROOM])

  expect(authority.observe(scope, {
    schemaVersion: 1,
    state: 'uncreated',
    pair,
    greetingState: 'pending'
  })).toBe(true)
  expect(authority.roomIds(scope)).toEqual([])

  authority.observe(scope, ready)
  expect(authority.roomIds({ ...scope, generation: 2 })).toEqual([])
})

import { afterEach, expect, it } from 'vitest'

import { $matrixPresence, bindMatrixPresenceSnapshot, clearMatrixPresence, resolveMatrixTeammatePresence } from './presence-store'

afterEach(clearMatrixPresence)

it('clears observed people on account switch and sign-out', () => {
  bindMatrixPresenceSnapshot({
    identity: { userId: '@one:test', deviceId: 'ONE' },
    presence: { users: [{ userId: '@linh:test', state: 'online', displayName: 'Linh' }] }
  })
  expect($matrixPresence.get().users['@linh:test']?.state).toBe('online')

  bindMatrixPresenceSnapshot({
    identity: { userId: '@two:test', deviceId: 'TWO' },
    presence: { users: [] }
  })
  expect($matrixPresence.get()).toEqual({ owner: '@two:test', users: {} })

  bindMatrixPresenceSnapshot({ identity: null, presence: undefined })
  expect($matrixPresence.get()).toEqual({ owner: '', users: {} })
})

it('resolves platform people only by a verified handle or unique display name', () => {
  const users = {
    '@linh:test': { userId: '@linh:test', state: 'away' as const, displayName: 'Linh' },
    '@other:test': { userId: '@other:test', state: 'online' as const, displayName: 'Same' },
    '@same:test': { userId: '@same:test', state: 'offline' as const, displayName: 'Same' }
  }

  expect(resolveMatrixTeammatePresence({ memberRef: 'one', handle: 'linh' }, users, { '@linh:test': 'linh' })?.userId).toBe('@linh:test')
  expect(resolveMatrixTeammatePresence({ memberRef: 'two', displayName: 'Linh' }, users, {})?.userId).toBe('@linh:test')
  expect(resolveMatrixTeammatePresence({ memberRef: 'three', displayName: 'Same' }, users, {})).toBeUndefined()
})

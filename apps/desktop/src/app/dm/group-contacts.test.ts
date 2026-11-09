import { describe, expect, it } from 'vitest'

import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'

import { groupContacts } from './group-contacts'

const person: AtumSocialProjection = {
  availability: 'available',
  profile: { profileId: 'public-profile', displayName: 'Minh', handle: 'minh', verified: false, avatar: null },
  state: 'connected', version: 1, canMessage: true, directThreadId: 'direct-thread'
}

const thread: AtumMessagingConversation = {
  id: 'direct-thread', kind: 'direct', title: null, participantIds: ['owner-account', 'peer-account'],
  updatedAt: '2026-09-09T00:00:00Z', lastMessageAt: null, unreadCount: 0, payload: {}
}

describe('groupContacts', () => {
  it('uses the account id from the social relationship’s direct thread, never the public profile id', () => {
    expect(groupContacts([person], [thread], 'owner-account')).toEqual([
      { userId: 'peer-account', displayName: 'Minh', handle: 'minh' }
    ])
  })

  it('does not infer membership from names, incomplete roster rows, another account, or non-direct rooms', () => {
    for (const row of [
      { ...thread, id: 'another-thread' },
      { ...thread, kind: 'group' },
      { ...thread, participantIds: ['other-account', 'peer-account'] },
      { ...thread, participantIds: ['owner-account'] },
      { ...thread, participantIds: ['owner-account', 'peer-account', 'third-account'] }
    ]) {
      expect(groupContacts([person], [row], 'owner-account')).toEqual([])
    }

    expect(groupContacts([person], [], 'owner-account')).toEqual([])
    expect(groupContacts([person], [thread], null)).toEqual([])
  })

  it('excludes unconnected or unavailable social relationships', () => {
    expect(groupContacts([{ ...person, state: 'outgoing_pending' }], [thread], 'owner-account')).toEqual([])
    expect(groupContacts([{ ...person, directThreadId: null }], [thread], 'owner-account')).toEqual([])
    expect(groupContacts([{
      availability: 'unavailable', profile: null, state: 'unavailable', version: 0, canMessage: false, directThreadId: null
    }], [thread], 'owner-account')).toEqual([])
  })
})

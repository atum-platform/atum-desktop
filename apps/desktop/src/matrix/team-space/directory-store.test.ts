import { beforeEach, expect, it } from 'vitest'

import { $companyChannels, clearCompanyChannels } from './channels-store'
import { $companyDirectories, activateTeamSpaceCacheAccount, companyDirectoryCache } from './directory-store'

beforeEach(() => {
  localStorage.clear()
  $companyDirectories.set({})
  clearCompanyChannels('a')
})

it('restores companies after memory is lost without reviving invitations', () => {
  companyDirectoryCache.set('a', {
    schemaVersion: 1,
    companies: [{ id: 'company', displayName: 'Kept company', role: 'member', authorityGeneration: 1 }],
    invitations: [{ id: 'invite', companyId: 'private', displayName: 'Invite', role: 'member' }]
  })
  $companyDirectories.set({})
  expect(companyDirectoryCache.get('a')).toMatchObject({ companies: [{ displayName: 'Kept company' }], invitations: [] })
  expect(companyDirectoryCache.get('b')).toBeUndefined()
})

it.each([null, 'b'])('discards outgoing account disk and memory on transition to %s', next => {
  activateTeamSpaceCacheAccount('a')
  companyDirectoryCache.set('a', { schemaVersion: 1, companies: [], invitations: [] })
  localStorage.setItem('atum.team-space.channels.v1:a', JSON.stringify({ company: { channels: [] } }))
  $companyChannels.setKey('a\ncompany', { channels: [], loading: false })
  activateTeamSpaceCacheAccount(next)
  expect(companyDirectoryCache.get('a')).toBeUndefined()
  expect(localStorage.getItem('atum.team-space.channels.v1:a')).toBeNull()
  expect($companyChannels.get()['a\ncompany']).toBeUndefined()
})

it('ignores corrupt or unavailable persisted data', () => {
  localStorage.setItem('atum.team-space.directory.v1:a', '{broken')
  expect(companyDirectoryCache.get('a')).toBeUndefined()
  localStorage.setItem('atum.team-space.directory.v1:a', JSON.stringify({ schemaVersion: 1, companies: [null] }))
  expect(companyDirectoryCache.get('a')).toBeUndefined()
})

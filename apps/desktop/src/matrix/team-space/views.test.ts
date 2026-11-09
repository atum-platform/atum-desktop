import { describe, expect, it } from 'vitest'

import type { MatrixCompanyChannelItem, MatrixCompanySnapshot11 } from '../../../shared/matrix-company'
import type {
  CompanyAdminSnapshot13Response,
  CompanyChannelAdmittedSnapshot14
} from '../../../shared/matrix-company-team-space'

import {
  channelViewFrom14,
  channelViewFromLegacy,
  invitationDaysLeft,
  pendingInvitations,
  rosterMembers,
  sortChannels
} from './views'

const companyId = '00000000-0000-4000-8000-72805976e3a7'
const ownerRef = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
const adminRef = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
const memberRef = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM'
const lateRef = 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ'

describe('channel views', () => {
  it('reads the 1.1 company-wide channel as a public one with no admission or actions', () => {
    const v1: MatrixCompanyChannelItem = {
      schemaVersion: 1,
      channel: { id: 'c1', companyId, displayName: 'general', visibility: 'company', state: 'active', projectId: 'p1',
        authorityGeneration: 1, channelGeneration: 3 },
      memberPrincipals: ['a', 'b', 'c'],
      room: { state: 'ready', roomId: '!r:x' }
    }

    expect(channelViewFromLegacy(v1)).toMatchObject({
      id: 'c1',
      visibility: 'public',
      memberCount: 3,
      projectId: 'p1',
      wire: '1.1',
      actions: null,
      topic: ''
    })
    expect(channelViewFromLegacy(v1)).not.toHaveProperty('admission')

    const v11: MatrixCompanyChannelItem = {
      schemaVersion: 2,
      channel: { id: 'c2', companyId, displayName: 'ops', visibility: 'company', state: 'archived', projectId: null,
        authorityGeneration: 1, channelGeneration: 1, systemKey: 'default' },
      memberCount: 9,
      room: { state: 'ready', roomId: '!o:x' }
    }

    expect(channelViewFromLegacy(v11)).toMatchObject({ memberCount: 9, systemKey: 'default', state: 'archived' })
  })

  it('keeps privacy, admission, topic and the server’s actions from the 1.4 wire', () => {
    const snapshot: CompanyChannelAdmittedSnapshot14 = {
      schemaVersion: 5,
      channel: { id: 'c3', companyId, displayName: 'leadership', visibility: 'private', topic: 'Q4', purpose: 'Plans',
        state: 'active', ownerMemberRef: ownerRef, authorityGeneration: 9, channelGeneration: 7, metadataRevision: 2 },
      selfAdmission: { memberRef: ownerRef, state: 'active', admissionEpoch: 2, admissionGeneration: 4 },
      memberCount: 3,
      room: { state: 'ready', roomId: '!l:x' },
      actions: ['leave', 'invite']
    }

    const view = channelViewFrom14(snapshot)

    expect(view).toMatchObject({
      visibility: 'private',
      topic: 'Q4',
      purpose: 'Plans',
      wire: '1.4',
      channelGeneration: 7,
      ownerMemberRef: ownerRef,
      admission: { memberRef: ownerRef, state: 'active', epoch: 2, generation: 4 },
      actions: ['leave', 'invite'],
      // The 1.4 channel carries no project link.
      projectId: null
    })
  })

  it('lists #general first, then by name in the person’s language, without reordering the input', () => {
    const input = [
      { displayName: 'zebra' },
      { displayName: 'Äpfel' },
      { displayName: 'alpha 10' },
      { displayName: 'alpha 2' },
      { displayName: 'chung', systemKey: 'default' as const }
    ]
    const before = JSON.stringify(input)

    expect(sortChannels(input, 'en').map(channel => channel.displayName)).toEqual([
      'chung',
      'alpha 2',
      'alpha 10',
      'Äpfel',
      'zebra'
    ])
    expect(JSON.stringify(input)).toBe(before)
  })
})

const snapshot11 = (members: MatrixCompanySnapshot11['members']): MatrixCompanySnapshot11 => ({
  schemaVersion: 2,
  company: { id: companyId, displayName: 'Atum', role: 'admin', authorityGeneration: 7 },
  members,
  projects: [],
  defaultChannelId: null
})

const live = (memberRef: string, over: Partial<MatrixCompanySnapshot11['members'][number]> = {}) => ({
  memberRef,
  role: 'member' as const,
  state: 'active' as const,
  self: false,
  handle: null,
  displayName: null,
  ...over
})

const admin13 = (
  members: CompanyAdminSnapshot13Response['members'],
  invitations: CompanyAdminSnapshot13Response['invitations'] = []
): CompanyAdminSnapshot13Response => ({
  schemaVersion: 4,
  company: { id: companyId, displayName: 'Atum', role: 'owner', ownerMemberRef: ownerRef, authorityGeneration: 7,
    policy: { channelCreation: 'members' } },
  members,
  invitations
})

describe('the roster', () => {
  const people = snapshot11([
    live(ownerRef, { role: 'admin', self: true, handle: 'minh', displayName: 'Minh' }),
    live(adminRef, { role: 'admin', handle: 'bao', displayName: 'Bảo' }),
    live(memberRef, { handle: 'lan_nguyen', displayName: 'Lan Nguyễn' }),
    live(lateRef, { state: 'invited', handle: 'tu', displayName: 'Tú' }),
    live('BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU', { state: 'removed', role: 'member', self: false })
  ])

  it('is the 1.1 roster before C1: two roles, no owner, invitees listed, the removed not', () => {
    const rows = rosterMembers(people, undefined, 'en')

    expect(rows.map(row => [row.displayName, row.role, row.state])).toEqual([
      ['Bảo', 'admin', 'active'],
      ['Minh', 'admin', 'active'],
      ['Lan Nguyễn', 'member', 'active'],
      ['Tú', 'member', 'invited']
    ])
  })

  it('takes roles and epochs from the administration snapshot, the owner first, and drops 1.1 invitees', () => {
    const rows = rosterMembers(
      people,
      admin13([
        { memberRef: ownerRef, role: 'owner', state: 'active', admissionEpoch: 1 },
        { memberRef: adminRef, role: 'admin', state: 'active', admissionEpoch: 1 },
        { memberRef: memberRef, role: 'member', state: 'revoking', admissionEpoch: 2 }
      ]),
      'en'
    )

    expect(rows.map(row => [row.displayName, row.role, row.state, row.admissionEpoch])).toEqual([
      ['Minh', 'owner', 'active', 1],
      ['Bảo', 'admin', 'active', 1],
      ['Lan Nguyễn', 'member', 'revoking', 2]
    ])
    expect(rows[0]!.self).toBe(true)
  })

  it('lists a person the authority knows but the profile read raced past, without a name', () => {
    const rows = rosterMembers(
      snapshot11([live(ownerRef, { role: 'admin', self: true, handle: 'minh', displayName: 'Minh' })]),
      admin13([
        { memberRef: ownerRef, role: 'owner', state: 'active', admissionEpoch: 1 },
        { memberRef: lateRef, role: 'member', state: 'active', admissionEpoch: 1 }
      ]),
      'en'
    )

    expect(rows.map(row => [row.memberRef, row.displayName, row.handle])).toEqual([
      [ownerRef, 'Minh', 'minh'],
      [lateRef, null, null]
    ])
  })
})

describe('pending invitations', () => {
  const invitation = (id: string, state: 'pending' | 'declined' | 'superseded', createdAt: number, expiresAt: number) => ({
    id,
    companyId,
    targetHandle: 'lan_nguyen',
    role: 'member' as const,
    state,
    createdAt,
    expiresAt,
    inviter: { handle: 'minh', displayName: 'Minh' },
    ...(state === 'superseded' ? { supersededByInvitationId: '00000000-0000-4000-8000-3d2ed3af722e' } : {})
  })

  it('lists only attempts still waiting, newest first, and notices the seven days running out', () => {
    const now = 1_800_000_000

    const rows = pendingInvitations(
      admin13(
        [{ memberRef: ownerRef, role: 'owner', state: 'active', admissionEpoch: 1 }],
        [
          invitation('00000000-0000-4000-8000-72805976e3a7', 'pending', now - 1000, now + 86_400 * 5),
          invitation('00000000-0000-4000-8000-4ddf7748f9cd', 'declined', now - 500, now + 86_400),
          invitation('00000000-0000-4000-8000-3570bef6c8ca', 'superseded', now - 400, now + 86_400),
          invitation('00000000-0000-4000-8000-933779c60f5b', 'pending', now - 100, now - 1)
        ]
      ),
      now
    )

    expect(rows.map(row => [row.id.slice(-1), row.expired])).toEqual([['b', true], ['7', false]])
    expect(pendingInvitations(undefined, now)).toEqual([])
  })

  it('counts whole days left and never goes negative', () => {
    expect(invitationDaysLeft(1000 + 86_400 * 7, 1000)).toBe(7)
    expect(invitationDaysLeft(1000 + 86_400 * 7 - 1, 1000)).toBe(7)
    expect(invitationDaysLeft(1000 + 3600, 1000)).toBe(1)
    expect(invitationDaysLeft(1000, 1000)).toBe(0)
    expect(invitationDaysLeft(500, 1000)).toBe(0)
  })
})

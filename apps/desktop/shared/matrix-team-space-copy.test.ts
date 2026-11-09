import { describe, expect, it } from 'vitest'

import { MATRIX_COMPANY_REFUSAL_REASONS } from './matrix-company-team-space'
import { matrixTeamSpaceCopy } from './matrix-team-space-copy'

const LOCALES = ['en', 'vi', 'ja', 'zh', 'zh-hant']
const english = matrixTeamSpaceCopy('en') as unknown as Record<string, unknown>

const reasons = Object.values(MATRIX_COMPANY_REFUSAL_REASONS).flatMap(family =>
  Object.values(family).flatMap(list => [...list] as string[])
)

describe('Team Space copy', () => {
  it.each(LOCALES.filter(locale => locale !== 'en'))('%s has every key English has and no empty string', locale => {
    const copy = matrixTeamSpaceCopy(locale) as unknown as Record<string, unknown>

    expect(Object.keys(copy).sort()).toEqual(Object.keys(english).sort())

    for (const [key, value] of Object.entries(copy)) {
      expect(typeof value, key).toBe(typeof english[key])

      if (typeof value === 'string') {
        expect(value.trim().length, key).toBeGreaterThan(0)
      }
    }
  })

  it.each(LOCALES)('%s words every typed refusal the platform can name, and every interpolation', locale => {
    const copy = matrixTeamSpaceCopy(locale)

    expect(Object.keys(copy.refusal).sort()).toEqual([...new Set(reasons)].sort())

    for (const text of Object.values(copy.refusal)) {
      expect(text.trim().length).toBeGreaterThan(5)
    }

    const spoken = [
      copy.memberActions('Lan'),
      copy.roleChanged('Lan', copy.admin),
      copy.transferTitle('Lan'),
      copy.transferBody('Lan', 'Atum'),
      copy.transferDone('Lan'),
      copy.invitationExpiresIn(0),
      copy.invitationExpiresIn(1),
      copy.invitationExpiresIn(6),
      copy.invitedBy('Minh'),
      copy.inviteLinkDuration(7),
      copy.inviteLinkCapacity(10),
      copy.inviteLinkCapacity(1),
      copy.inviteLinkUsage(2, 10),
      copy.inviteLinkExpires(0),
      copy.inviteLinkExpires(3),
      copy.channelInvitationRow('ops'),
      copy.channelMemberCount(1),
      copy.channelMemberCount(7),
      copy.leaveChannelTitle('ops'),
      copy.archiveChannelTitle('ops'),
      copy.personInvited('Lan'),
      copy.personRemoved('Lan'),
      copy.leaveCompanyLastMemberBody,
      copy.leaveCompanyWalletNotEmptyTooltip,
      copy.membershipJoined('Lan', false),
      copy.membershipJoined('Lan', true),
      copy.membershipDeparted('Lan', false),
      copy.membershipDeparted('Lan', true),
      copy.leaveCompanyTitle('Atum Studio')
    ]

    for (const text of spoken) {
      expect(text.trim().length).toBeGreaterThanOrEqual(2)
      expect(text).not.toMatch(/undefined|\[object|NaN/u)
    }
  })

  it('names the person on a join or departure line, and only says "you" when it is the viewer', () => {
    for (const locale of LOCALES) {
      const copy = matrixTeamSpaceCopy(locale)

      expect(copy.membershipJoined('Lan Nguyễn', false)).toContain('Lan Nguyễn')
      expect(copy.membershipDeparted('Lan Nguyễn', false)).toContain('Lan Nguyễn')
      expect(copy.membershipJoined('Lan Nguyễn', true)).not.toContain('Lan Nguyễn')
      expect(copy.membershipDeparted('Lan Nguyễn', true)).not.toContain('Lan Nguyễn')
      expect(copy.membershipJoined('Lan', false)).not.toBe(copy.membershipDeparted('Lan', false))
    }
  })

  it('names the company in the leave confirmation, in every locale', () => {
    for (const locale of LOCALES) {
      expect(matrixTeamSpaceCopy(locale).leaveCompanyTitle('Atum Studio')).toContain('Atum Studio')
    }
  })

  it('gives every link that does not work the one message, so a link never says which way it failed', () => {
    for (const locale of LOCALES) {
      const copy = matrixTeamSpaceCopy(locale)

      expect(copy.refusal.invite_link_unavailable).toBe(copy.inviteLinkInvalid)
    }

    expect(english.inviteLinkInvalid).toMatch(/^This invite link is invalid\./u)
    expect(String(english.inviteLinkInvalid)).not.toMatch(/expired|revoked|used up|no longer/iu)
  })

  it('names the person and the company in the ownership transfer, in every locale', () => {
    for (const locale of LOCALES) {
      const body = matrixTeamSpaceCopy(locale).transferBody('Lan Nguyễn', 'Atum Studio')

      expect(body).toContain('Lan Nguyễn')
      expect(body).toContain('Atum Studio')
    }
  })
})

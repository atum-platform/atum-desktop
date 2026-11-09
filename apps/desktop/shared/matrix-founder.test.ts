import { describe, expect, it } from 'vitest'

import {
  MATRIX_OFFICIAL_ACCOUNTS_MAX,
  MATRIX_OFFICIAL_ACCOUNTS_PROFILE,
  matrixFounderRoomMark,
  matrixFounderRoster,
  parseMatrixFounderChatRecord,
  parseOfficialAccounts
} from './matrix-founder'

const FOUNDER = '@synthetic-user-0017:atumplatform.com'

const founderRow = { user_id: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }

const answer = (extra: Record<string, unknown> = {}) => ({
  profile: MATRIX_OFFICIAL_ACCOUNTS_PROFILE,
  founder: { user_id: FOUNDER },
  accounts: [founderRow, { user_id: '@partner:atumplatform.com', tier: 'verified', role: null, handle: null }],
  ...extra
})

describe('official accounts', () => {
  it('reads the founder and every marked account, copying known fields only', () => {
    expect(parseOfficialAccounts(answer())).toEqual({
      founder: { userId: FOUNDER },
      accounts: [
        { userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' },
        { userId: '@partner:atumplatform.com', tier: 'verified' }
      ]
    })
  })

  it('ignores unknown optional fields, such as the updates channel coming later', () => {
    const parsed = parseOfficialAccounts(
      answer({
        founder: { user_id: FOUNDER, updates_room_id: '!updates:atumplatform.com' },
        accounts: [{ ...founderRow, principal: '00000000-0000-4000-8000-11e594f48195', badge: 'gold' }],
        generated_at: 1
      })
    )

    expect(parsed).toEqual({
      founder: { userId: FOUNDER },
      accounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }]
    })
    expect(JSON.stringify(parsed)).not.toContain('updates')
    expect(JSON.stringify(parsed)).not.toContain('00000000-0000')
  })

  it('retains the optional Founder roster presentation without moving identity or trust', () => {
    const parsed = parseOfficialAccounts(
      answer({
        accounts: [
          {
            ...founderRow,
            roster_default: true,
            roster_order: 0,
            roster_state: 'available',
            // A producer-private value beside the known fields is still stripped.
            private_email: 'founder@example.test'
          },
          { user_id: '@partner:atumplatform.com', tier: 'verified', role: null, handle: null }
        ]
      })
    )

    expect(parsed.founder).toEqual({ userId: FOUNDER })
    expect(parsed.accounts[0]).toEqual({
      userId: FOUNDER,
      tier: 'official',
      role: 'founder',
      handle: 'founder',
      rosterDefault: true,
      rosterOrder: 0,
      rosterState: 'available'
    })
    expect(JSON.stringify(parsed)).not.toContain('founder@example.test')
    expect(JSON.stringify(parsed)).not.toContain('principal')
    // An older producer omits all three: the row still parses and nothing is invented.
    expect(parseOfficialAccounts(answer()).accounts[0]).toEqual({
      userId: FOUNDER,
      tier: 'official',
      role: 'founder',
      handle: 'founder'
    })
  })

  it('refuses malformed roster presentation instead of answering a partial list', () => {
    for (const roster of [
      { roster_state: 'hidden' },
      { roster_state: 'Coming_Soon' },
      { roster_state: '' },
      { roster_state: true },
      { roster_default: 'yes' },
      { roster_default: null },
      { roster_order: -1 },
      { roster_order: 1.5 },
      { roster_order: 2_147_483_648 },
      { roster_order: '0' }
    ]) {
      expect(() => parseOfficialAccounts(answer({ accounts: [{ ...founderRow, ...roster }] }))).toThrow(
        'matrix_official_accounts_invalid'
      )
    }

    expect(
      parseOfficialAccounts(
        answer({ accounts: [{ ...founderRow, roster_default: false, roster_order: 42, roster_state: 'coming_soon' }] })
      ).accounts[0]
    ).toMatchObject({ rosterDefault: false, rosterOrder: 42, rosterState: 'coming_soon' })
  })

  it('accepts a platform that names no founder', () => {
    expect(parseOfficialAccounts({ profile: MATRIX_OFFICIAL_ACCOUNTS_PROFILE, founder: null, accounts: [] })).toEqual({
      founder: null,
      accounts: []
    })
  })

  it('refuses any other profile', () => {
    for (const profile of ['atum.official-accounts/2', 'atum.app-catalog/1', undefined]) {
      expect(() => parseOfficialAccounts(answer({ profile }))).toThrow('matrix_official_accounts_profile')
    }

    expect(() => parseOfficialAccounts(null)).toThrow('matrix_official_accounts_profile')
  })

  it("enforces the platform's promises about the founder", () => {
    const broken = [
      // Named but not listed, listed twice, or listed without the role or as merely verified.
      answer({ accounts: [] }),
      answer({ accounts: [founderRow, founderRow] }),
      answer({ accounts: [{ ...founderRow, role: null }] }),
      answer({ accounts: [{ ...founderRow, tier: 'verified' }] }),
      // Another account claiming the role, with or without a named founder.
      answer({ accounts: [founderRow, { user_id: '@other:atumplatform.com', tier: 'official', role: 'founder' }] }),
      answer({ founder: null, accounts: [founderRow] }),
      // A named founder that is not a Matrix id.
      answer({ founder: { user_id: 'founder' } }),
      answer({ founder: 'founder' })
    ]

    for (const value of broken) {
      expect(() => parseOfficialAccounts(value)).toThrow('matrix_official_accounts_invalid')
    }
  })

  it('refuses malformed rows and more rows than the platform lists', () => {
    const rows = [
      { user_id: 'partner', tier: 'verified' },
      { user_id: '@partner:atumplatform.com', tier: 'unverified' },
      { user_id: '@partner:atumplatform.com', tier: 'verified', role: 'support' },
      { user_id: '@partner:atumplatform.com', tier: 'verified', handle: 'No Spaces' },
      'partner'
    ]

    for (const row of rows) {
      expect(() => parseOfficialAccounts(answer({ accounts: [founderRow, row] }))).toThrow(
        'matrix_official_accounts_invalid'
      )
    }

    const many = Array.from({ length: MATRIX_OFFICIAL_ACCOUNTS_MAX }, (_, index) => ({
      user_id: `@partner${index}:atumplatform.com`,
      tier: 'verified'
    }))

    expect(() => parseOfficialAccounts(answer({ accounts: [founderRow, ...many] }))).toThrow(
      'matrix_official_accounts_invalid'
    )
    expect(() => parseOfficialAccounts(answer({ accounts: 'none' }))).toThrow('matrix_official_accounts_invalid')
  })
})

describe('the effective Founder roster presentation', () => {
  it('uses legacy default/available when the platform omits the optional row fields', () => {
    expect(matrixFounderRoster(parseOfficialAccounts(answer()))).toEqual({
      default: true,
      order: 0,
      state: 'available'
    })
    expect(matrixFounderRoster({ founder: null, accounts: [] })).toBeUndefined()
    expect(matrixFounderRoster(undefined)).toBeUndefined()
  })

  it('reads the parsed Founder row only, keeping false and coming_soon actual', () => {
    const official = parseOfficialAccounts(
      answer({
        accounts: [
          {
            ...founderRow,
            roster_default: false,
            roster_order: 9,
            roster_state: 'coming_soon'
          },
          {
            user_id: '@partner:atumplatform.com',
            tier: 'verified',
            role: null,
            handle: null,
            roster_default: true,
            roster_order: 0,
            roster_state: 'available'
          }
        ]
      })
    )

    expect(matrixFounderRoster(official)).toEqual({ default: false, order: 9, state: 'coming_soon' })
  })
})

describe('the Founder chat records', () => {
  it('reads the v1 account-data record and nothing else', () => {
    const record = { v: 1, founder: FOUNDER, room: '!chat:atumplatform.com', at: 1_759_000_000_000 }

    expect(parseMatrixFounderChatRecord(record)).toEqual(record)
    // Newer room ids carry no server name.
    expect(parseMatrixFounderChatRecord({ ...record, room: '!AbCdEf0123' })?.room).toBe('!AbCdEf0123')

    for (const value of [
      { ...record, v: 2 },
      { ...record, founder: 'founder' },
      { ...record, room: 'chat' },
      { ...record, at: -1 },
      { ...record, at: 1.5 },
      {},
      null,
      'record'
    ]) {
      expect(parseMatrixFounderChatRecord(value)).toBeNull()
    }
  })

  it("reads the room's own mark", () => {
    expect(matrixFounderRoomMark({ v: 1, founder: FOUNDER })).toBe(FOUNDER)
    expect(matrixFounderRoomMark({ v: 2, founder: FOUNDER })).toBeNull()
    expect(matrixFounderRoomMark({ v: 1, founder: 'Founder' })).toBeNull()
    expect(matrixFounderRoomMark(undefined)).toBeNull()
  })
})

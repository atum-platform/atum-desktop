import { afterEach, describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../../shared/matrix'

import {
  companyActivity,
  companyAtSlot,
  companyInitials,
  initialCompany,
  orderCompanies,
  readLastChannelId,
  readLastCompanyId,
  steppedCompany,
  writeLastChannelId,
  writeLastCompanyId
} from './company-switcher'

const company = (id: string, displayName: string) => ({ id, displayName })

const alpha = company('a', 'Alpha')
const beta = company('b', 'Beta')
const gamma = company('c', 'Gamma')

const channel = (companyId: string, lastActiveAt: number | undefined, over: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id: `!${companyId}-${lastActiveAt}:atum.example`,
  name: 'ops',
  membership: 'join',
  encrypted: false,
  companyChannel: { companyId, channelId: 'channel' },
  ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  ...over
})

describe('the order every switcher surface shares', () => {
  it('lists companies by name, numbers in numeric order, and never reorders a tie', () => {
    const ordered = orderCompanies(
      [company('9', 'team 10'), company('2', 'Beta'), company('8', 'team 2'), company('1', 'alpha'), company('3', 'Beta')],
      'en'
    )

    expect(ordered.map(item => item.displayName)).toEqual(['alpha', 'Beta', 'Beta', 'team 2', 'team 10'])
    expect(ordered.map(item => item.id).slice(1, 3)).toEqual(['2', '3'])
  })

  it('does not change the list it was given', () => {
    const given = [beta, alpha]

    orderCompanies(given, 'en')
    expect(given).toEqual([beta, alpha])
  })
})

describe('the two letters on a tile', () => {
  it.each([
    ['Atum Studio', 'AS'],
    ['Atum', 'AT'],
    ['A', 'A'],
    ['  công ty  mới  ', 'CT'],
    ['đông á', 'ĐÁ'],
    ['Atum Studio Vietnam', 'AS'],
    ['🚀 Rockets', '🚀R'],
    ['', '?'],
    ['   ', '?']
  ])('%j reads %j', (name, initials) => {
    expect(companyInitials(name, 'vi')).toBe(initials)
  })
})

describe('moving between companies', () => {
  const ordered = [alpha, beta, gamma]

  it('finds company N in the shown order, for one to nine only', () => {
    expect(companyAtSlot(ordered, 1)).toBe(alpha)
    expect(companyAtSlot(ordered, 3)).toBe(gamma)
    expect(companyAtSlot(ordered, 4)).toBeUndefined()
    expect(companyAtSlot(ordered, 0)).toBeUndefined()

    const many = Array.from({ length: 12 }, (_, index) => company(String(index), `Company ${index}`))

    expect(companyAtSlot(many, 9)).toBe(many[8])
    expect(companyAtSlot(many, 10)).toBeUndefined()
  })

  it('steps forward and back, wrapping at either end', () => {
    expect(steppedCompany(ordered, 'a', 1)).toBe(beta)
    expect(steppedCompany(ordered, 'c', 1)).toBe(alpha)
    expect(steppedCompany(ordered, 'a', -1)).toBe(gamma)
    expect(steppedCompany(ordered, 'b', -1)).toBe(alpha)
  })

  it('starts at the first (forward) or last (back) when none is selected or the selected one is gone', () => {
    expect(steppedCompany(ordered, undefined, 1)).toBe(alpha)
    expect(steppedCompany(ordered, undefined, -1)).toBe(gamma)
    expect(steppedCompany(ordered, 'left', 1)).toBe(alpha)
  })

  it('has nowhere to step to with no company, or with only the one it is already on', () => {
    expect(steppedCompany([], undefined, 1)).toBeUndefined()
    expect(steppedCompany([alpha], 'a', 1)).toBeUndefined()
    expect(steppedCompany([alpha], 'a', -1)).toBeUndefined()
    expect(steppedCompany([alpha], undefined, 1)).toBe(alpha)
  })
})

describe('which company opens first', () => {
  const ordered = [alpha, beta, gamma]
  const none = new Map<string, number>()

  it('opens the company last used, by id, when it is still there', () => {
    expect(initialCompany(ordered, { activity: new Map([['a', 900]]), lastUsedId: 'c' })).toBe(gamma)
  })

  it('falls back to the company with the newest activity when the remembered one is gone or never set', () => {
    const activity = new Map([['a', 100], ['b', 300], ['c', 200]])

    expect(initialCompany(ordered, { activity, lastUsedId: 'removed' })).toBe(beta)
    expect(initialCompany(ordered, { activity })).toBe(beta)
  })

  it('breaks an activity tie by the shown order, and then falls back to the first', () => {
    expect(initialCompany(ordered, { activity: new Map([['b', 5], ['c', 5]]) })).toBe(beta)
    expect(initialCompany(ordered, { activity: none })).toBe(alpha)
    expect(initialCompany(ordered, { activity: new Map([['a', 0]]) })).toBe(alpha)
  })

  it('never picks a company it was told to leave out, even when it is remembered or the newest', () => {
    const left = new Set(['c'])

    expect(initialCompany(ordered, { activity: new Map([['c', 999]]), excluded: left, lastUsedId: 'c' })).toBe(alpha)
    expect(initialCompany(ordered, { activity: none, excluded: new Set(['a', 'b', 'c']) })).toBeUndefined()
  })

  it('has no answer without companies', () => {
    expect(initialCompany([], { activity: none, lastUsedId: 'a' })).toBeUndefined()
  })
})

describe('the newest activity in each company', () => {
  it('takes the newest joined channel per company and ignores other rooms', () => {
    const activity = companyActivity([
      channel('a', 100),
      channel('a', 400),
      channel('b', 250),
      channel('b', undefined),
      channel('c', 900, { membership: 'invite' }),
      { id: '!dm:atum.example', name: 'dm', membership: 'join', encrypted: true, lastActiveAt: 5_000 }
    ])

    expect(activity.get('a')).toBe(400)
    expect(activity.get('b')).toBe(250)
    expect(activity.has('c')).toBe(false)
  })
})

describe('remembering the company on this device', () => {
  afterEach(() => window.localStorage.clear())

  it('is kept per account and read back by id', () => {
    expect(readLastCompanyId('account-a')).toBeUndefined()

    writeLastCompanyId('account-a', 'b')
    writeLastCompanyId('account-b', 'c')

    expect(readLastCompanyId('account-a')).toBe('b')
    expect(readLastCompanyId('account-b')).toBe('c')
    expect(readLastCompanyId('account-c')).toBeUndefined()
  })

  it('keeps the last channel separately for every account and company', () => {
    expect(readLastChannelId('account-a', 'company-a')).toBeUndefined()

    writeLastChannelId('account-a', 'company-a', 'channel-general')
    writeLastChannelId('account-a', 'company-b', 'channel-design')
    writeLastChannelId('account-b', 'company-a', 'channel-ops')

    expect(readLastChannelId('account-a', 'company-a')).toBe('channel-general')
    expect(readLastChannelId('account-a', 'company-b')).toBe('channel-design')
    expect(readLastChannelId('account-b', 'company-a')).toBe('channel-ops')
  })

  it('carries on without a store: reading finds nothing and writing does not throw', () => {
    const blocked = Object.getOwnPropertyDescriptor(window, 'localStorage')

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled')
      }
    })

    try {
      expect(readLastCompanyId('account-a')).toBeUndefined()
      expect(() => writeLastCompanyId('account-a', 'b')).not.toThrow()
      expect(readLastChannelId('account-a', 'company-a')).toBeUndefined()
      expect(() => writeLastChannelId('account-a', 'company-a', 'general')).not.toThrow()
    } finally {
      if (blocked) {
        Object.defineProperty(window, 'localStorage', blocked)
      }
    }
  })
})

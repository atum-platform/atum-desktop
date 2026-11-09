import { describe, expect, it } from 'vitest'

import { BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES, siteDomain } from './contract'
import { SKIP_LIST, skipCategory } from './skip-list'

describe('the default skip list', () => {
  const entries = BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES.flatMap(category =>
    SKIP_LIST[category].map(site => [category, site] as const)
  )

  it('names exactly the contract categories and fills each', () => {
    expect(Object.keys(SKIP_LIST).sort()).toEqual([...BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES].sort())

    for (const category of BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES) {
      expect(SKIP_LIST[category].length).toBeGreaterThan(15)
    }
  })

  it('holds only registrable domains: a typo or a public suffix cannot sit in the list unnoticed', () => {
    for (const [, site] of entries) {
      expect(() => siteDomain(site), site).not.toThrow()
    }
  })

  it('lists each domain once, in one category', () => {
    const sites = entries.map(([, site]) => site)

    expect(new Set(sites).size).toBe(sites.length)
  })

  it('classifies every entry as its own category', () => {
    for (const [category, site] of entries) {
      expect(skipCategory(site), site).toBe(category)
    }
  })
})

describe('skipCategory', () => {
  it.each([
    ['chase.com', 'banking'],
    ['vietcombank.com.vn', 'banking'],
    ['techcombank.com.vn', 'banking'],
    ['ssi.com.vn', 'banking'],
    ['momo.vn', 'wallet'],
    ['zalopay.vn', 'wallet'],
    ['paypal.com', 'wallet'],
    ['coinbase.com', 'wallet'],
    ['metamask.io', 'wallet'],
    ['1password.com', 'password_manager'],
    ['bitwarden.com', 'password_manager'],
    ['lastpass.com', 'password_manager']
  ] as const)('leaves %s behind as %s', (site, category) => {
    expect(skipCategory(site)).toBe(category)
  })

  it('catches a bank or wallet nobody listed by the name in its first label', () => {
    expect(skipCategory('bank.example')).toBe('banking')
    expect(skipCategory('wallet.example')).toBe('wallet')
    expect(skipCategory('acmebank.co.uk')).toBe('banking')
    expect(skipCategory('firstcreditunion.org')).toBe('banking')
    expect(skipCategory('mywallet.io')).toBe('wallet')
    expect(skipCategory('some-credit-union.com')).toBe('banking')
  })

  it('does not read a subdomain: only the registrable domain is judged', () => {
    // `bank.` in front of an ordinary site is the site's own subdomain, not the site.
    expect(skipCategory('example.com')).toBeNull()
    expect(skipCategory('github.com')).toBeNull()
  })

  it.each([
    'github.com',
    'google.com',
    'notion.so',
    'facebook.com',
    'linkedin.com',
    'amazon.com',
    'shopee.vn',
    'tiki.vn',
    'zalo.me',
    'youtube.com',
    'vnexpress.net',
    'openai.com',
    'atlassian.net',
    'slack.com'
  ])('imports %s by default', site => {
    expect(skipCategory(site)).toBeNull()
  })
})

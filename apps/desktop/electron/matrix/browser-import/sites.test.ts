import { describe, expect, it } from 'vitest'

import type { CookieHostRow } from './chrome-cookies'
import {
  BROWSER_IMPORT_MAX_COOKIES,
  BROWSER_IMPORT_MAX_SITES,
  browserImportSitesDigest,
  isBrowserCookieDomainAllowed
} from './contract'
import { pruneSelections, registrableSite, selectSites } from './sites'

const host = (name: string, cookies = 1, lastAccess = 1_000): CookieHostRow => ({ host: name, cookies, lastAccess })

describe('registrableSite', () => {
  it.each([
    ['.mail.google.com', 'google.com'],
    ['accounts.google.com', 'google.com'],
    ['.github.com', 'github.com'],
    ['.GitHub.COM', 'github.com'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['.vietcombank.com.vn', 'vietcombank.com.vn'],
    ['ebanking.vietcombank.com.vn', 'vietcombank.com.vn'],
    ['someone.github.io', 'someone.github.io'],
    ['xn--bcher-kva.de', 'xn--bcher-kva.de']
  ])('%s belongs to %s', (hostKey, site) => {
    expect(registrableSite(hostKey)).toBe(site)
  })

  it.each([
    'localhost',
    '.localhost',
    '.app.localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.7',
    'nas.local',
    'printer.corp',
    'com',
    '.co.uk',
    'co.uk',
    '',
    '.'
  ])('%s is not an importable site', hostKey => {
    expect(registrableSite(hostKey)).toBeNull()
  })
})

describe('selectSites', () => {
  it('groups hosts into registrable domains and marks what is left behind', () => {
    const { selections, ignoredHosts, verified } = selectSites([
      host('.mail.google.com', 2),
      host('.google.com', 3),
      host('.github.com', 3),
      host('.chase.com', 2),
      host('ebanking.vietcombank.com.vn', 1),
      host('.momo.vn', 1),
      host('.bitwarden.com', 1),
      host('localhost'),
      host('127.0.0.1'),
      host('nas.local')
    ])

    expect(selections).toEqual([
      { domain: 'bitwarden.com', category: 'password_manager', disposition: 'skipped_default', ownerOverride: false },
      { domain: 'chase.com', category: 'banking', disposition: 'skipped_default', ownerOverride: false },
      { domain: 'github.com', category: 'standard', disposition: 'included', ownerOverride: false },
      { domain: 'google.com', category: 'standard', disposition: 'included', ownerOverride: false },
      { domain: 'momo.vn', category: 'wallet', disposition: 'skipped_default', ownerOverride: false },
      { domain: 'vietcombank.com.vn', category: 'banking', disposition: 'skipped_default', ownerOverride: false }
    ])
    expect(ignoredHosts).toBe(3)
    expect(verified.includedSites).toEqual(['github.com', 'google.com'])
    expect(verified.skippedSites).toEqual(['bitwarden.com', 'chase.com', 'momo.vn', 'vietcombank.com.vn'])
    expect(verified.sitesDigest).toBe(browserImportSitesDigest(selections))
  })

  it('derives the same cookie gate the cloud applies: subdomains in, look-alikes and skipped sites out', () => {
    const { verified } = selectSites([host('.google.com'), host('.chase.com')])

    expect(isBrowserCookieDomainAllowed('.mail.google.com', verified)).toBe(true)
    expect(isBrowserCookieDomainAllowed('.evilgoogle.com', verified)).toBe(false)
    expect(isBrowserCookieDomainAllowed('.chase.com', verified)).toBe(false)
    expect(isBrowserCookieDomainAllowed('secure.chase.com', verified)).toBe(false)
  })

  it('has nothing included when only skipped or local hosts exist', () => {
    const { verified, selections } = selectSites([host('.chase.com'), host('localhost')])

    expect(selections).toHaveLength(1)
    expect(verified.includedSites).toEqual([])

    const none = selectSites([host('localhost')])
    expect(none.selections).toEqual([])
    expect(none.verified).toMatchObject({ siteCount: 0, includedSites: [] })
  })

  it('keeps the most recently used sites when a heavy profile passes the 1,000-site ceiling', () => {
    const hosts = Array.from({ length: 1_200 }, (_, index) =>
      host(`site${String(index).padStart(4, '0')}.com`, 1, index)
    )

    const { selections, truncatedSites } = selectSites(hosts)

    expect(selections).toHaveLength(BROWSER_IMPORT_MAX_SITES)
    expect(truncatedSites).toBe(200)
    // The 200 least recently used (the lowest indexes) are the ones left out.
    expect(selections.some(selection => selection.domain === 'site0000.com')).toBe(false)
    expect(selections.some(selection => selection.domain === 'site1199.com')).toBe(true)
  })

  it('stays inside the 20,000-cookie ceiling, fitting a smaller site where a large one does not', () => {
    const { selections, truncatedSites } = selectSites([
      host('.big-a.com', 8_000, 3_000),
      host('.big-b.com', 8_000, 2_000),
      host('.big-c.com', 8_000, 1_000),
      host('.small.com', 3_000, 500)
    ])

    expect(selections.map(selection => selection.domain)).toEqual(['big-a.com', 'big-b.com', 'small.com'])
    expect(truncatedSites).toBe(1)
    expect(8_000 + 8_000 + 3_000).toBeLessThanOrEqual(BROWSER_IMPORT_MAX_COOKIES)
  })

  it('charges skipped sites nothing: nothing from them is read', () => {
    const { selections } = selectSites([host('.chase.com', 19_000, 9_000), host('.fine.com', 20_000, 1_000)])

    expect(selections.map(selection => selection.disposition)).toEqual(['skipped_default', 'included'])
  })

  it('is deterministic when recency and size tie', () => {
    const a = selectSites([host('.b.com', 1, 5), host('.a.com', 1, 5)])
    const b = selectSites([host('.a.com', 1, 5), host('.b.com', 1, 5)])

    expect(a.selections).toEqual(b.selections)
  })
})

describe('pruneSelections', () => {
  it('drops an included site that produced no cookie and keeps every skipped site', () => {
    const { selections } = selectSites([host('.github.com'), host('.google.com'), host('.chase.com')])

    expect(
      pruneSelections(selections, ['.mail.google.com', 'github.com.evil.example']).map(({ domain }) => domain)
    ).toEqual(['chase.com', 'google.com'])
  })
})

/**
 * From the hosts that have cookies to the sites an import covers.
 *
 * A site is a Public Suffix List registrable domain (eTLD+1), the unit the contract selects, digests and audits:
 * `.mail.google.com` and `accounts.google.com` are both `google.com`. Everything here decides from host names alone,
 * before any cookie is decrypted, so the Mac knows what it will read before it asks for the Keychain.
 */
import { parse } from 'tldts'

import type { CookieHostRow } from './chrome-cookies'
import {
  BROWSER_IMPORT_MAX_COOKIES,
  BROWSER_IMPORT_MAX_SITES,
  type BrowserImportSiteSelection,
  type BrowserImportVerifiedSites,
  siteDomain,
  verifiedSitesOf
} from './contract'
import { skipCategory } from './skip-list'

/**
 * The registrable domain a Chrome `host_key` belongs to, or null when it is not an importable site: a bare
 * host, `localhost` and anything under it, an IP literal, an internal name (an unrecognised suffix such as
 * `.local` or `.corp`), or a public suffix itself.
 */
export function registrableSite(hostKey: string): string | null {
  const host = (hostKey.startsWith('.') ? hostKey.slice(1) : hostKey).toLowerCase()
  const parsed = parse(host, { allowPrivateDomains: true })

  // `isIcann` and `isPrivate` are both false for a suffix the Public Suffix List does not know.
  if (parsed.isIp || !parsed.domain || !(parsed.isIcann || parsed.isPrivate)) {
    return null
  }

  try {
    return siteDomain(parsed.domain)
  } catch {
    return null
  }
}

export interface SiteSelectionResult {
  /** Every selected site, in domain order: what the digest, the admission and the bundle carry. */
  selections: BrowserImportSiteSelection[]
  verified: BrowserImportVerifiedSites
  /** Hosts that are not importable sites (localhost, IPs, internal names). */
  ignoredHosts: number
  /** Sites left out because the contract caps the selection at 1,000 sites and 20,000 cookies. */
  truncatedSites: number
}

interface RankedSite {
  site: string
  cookies: number
  lastAccess: number
}

const byRecency = (a: RankedSite, b: RankedSite) =>
  b.lastAccess - a.lastAccess || b.cookies - a.cookies || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)

/**
 * Choose the sites. Most recently used first, so when a heavy profile exceeds the contract's ceilings the sites
 * a person actually uses are the ones kept. Skipped sites (banking, wallets, password managers) are recorded as
 * such and cost no cookie budget: nothing from them is read.
 */
export function selectSites(hosts: readonly CookieHostRow[]): SiteSelectionResult {
  const bySite = new Map<string, RankedSite>()
  let ignoredHosts = 0

  for (const row of hosts) {
    const site = registrableSite(row.host)

    if (!site) {
      ignoredHosts += 1

      continue
    }

    const ranked = bySite.get(site) ?? { site, cookies: 0, lastAccess: 0 }
    ranked.cookies += row.cookies
    ranked.lastAccess = Math.max(ranked.lastAccess, row.lastAccess)
    bySite.set(site, ranked)
  }

  const kept: BrowserImportSiteSelection[] = []
  let budget = BROWSER_IMPORT_MAX_COOKIES

  for (const ranked of [...bySite.values()].sort(byRecency)) {
    if (kept.length >= BROWSER_IMPORT_MAX_SITES) {
      break
    }

    const category = skipCategory(ranked.site)

    if (category) {
      kept.push({ domain: ranked.site, category, disposition: 'skipped_default', ownerOverride: false })
    } else if (ranked.cookies <= budget) {
      budget -= ranked.cookies
      kept.push({ domain: ranked.site, category: 'standard', disposition: 'included', ownerOverride: false })
    }
  }

  const selections = kept.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))

  return {
    selections,
    verified: selections.length ? verifiedSitesOf(selections) : emptyVerifiedSites(),
    ignoredHosts,
    truncatedSites: bySite.size - selections.length
  }
}

function emptyVerifiedSites(): BrowserImportVerifiedSites {
  return { sitesDigest: '', siteCount: 0, skippedSiteCount: 0, includedSites: [], skippedSites: [] }
}

/** Keep every skipped site and only the included sites that really contributed a cookie. */
export function pruneSelections(
  selections: readonly BrowserImportSiteSelection[],
  cookieDomains: readonly string[]
): BrowserImportSiteSelection[] {
  const withCookies = new Set(cookieDomains.flatMap(domain => registrableSite(domain) ?? []))

  return selections.filter(
    selection => selection.disposition === 'skipped_default' || withCookies.has(selection.domain)
  )
}

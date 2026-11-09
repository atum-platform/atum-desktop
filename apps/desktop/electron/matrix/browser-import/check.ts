/**
 * The owner-run check of the Chrome reader against a real profile (`scripts/browser-import-check.ts`), as a
 * function: it settles what fixtures cannot, that this Chrome's database version, `v10` prefix, key and 32-byte
 * domain-hash prefix behave as `chrome-cookies.ts` assumes. Its lines are counts and closed verdicts only: no host,
 * site, cookie name, value, key or password. It writes nothing and sends nothing.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import {
  chooseChromeProfile,
  type ChromeEnv,
  ChromeImportError,
  decryptCookieBytes,
  deriveCookieKey,
  discoverChromeProfiles,
  listCookieHosts,
  readChromeCookies,
  readSafeStoragePassword
} from './chrome-cookies'
import { isBrowserCookieDomainAllowed } from './contract'
import { selectSites } from './sites'

const SAMPLE = 3_000

export interface ChromeCheck {
  ok: boolean
  lines: string[]
}

export async function chromeCheck(env: ChromeEnv): Promise<ChromeCheck> {
  // The Keychain answer is never memoized: it carries the secret, which is zeroed as soon as the key is derived. So
  // macOS may ask twice (the diagnostic, then the real reader); this script is run by the owner, once, to see that.
  const lines: string[] = []

  try {
    const profiles = discoverChromeProfiles(env)
    const profile = chooseChromeProfile(profiles)

    if (!profile) {
      return { ok: false, lines: ['FAIL no Chrome profile with a cookie database was found'] }
    }

    const hosts = listCookieHosts(profile, env)
    const selection = selectSites(hosts)
    const left = selection.selections.filter(({ disposition }) => disposition === 'skipped_default').length

    lines.push(
      `profiles=${profiles.length} chosen_ordinal=${profile.ordinal} hosts=${hosts.length} sites_included=${selection.verified.includedSites.length} sites_left_behind=${left} hosts_not_sites=${selection.ignoredHosts} sites_truncated=${selection.truncatedSites}`
    )

    const password = await readSafeStoragePassword(env)
    let key: Buffer

    try {
      key = deriveCookieKey(password)
    } finally {
      password.fill(0)
    }

    const tally = {
      rows: 0,
      padding_ok: 0,
      hash_of_host_key: 0,
      hash_of_host_without_dot: 0,
      hash_none: 0,
      utf8_ok_after_strip: 0
    }

    let version = 'unknown'
    let db: DatabaseSync

    try {
      db = new DatabaseSync(profile.cookiesPath, { readOnly: true })
      db.prepare('SELECT 1 FROM cookies LIMIT 1').get()
    } catch {
      key.fill(0)

      return { ok: false, lines: [...lines, 'FAIL the cookie database is in use: quit Chrome and run this again'] }
    }

    try {
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined
        version = String(row?.value)
      } catch {
        version = 'no_meta_table'
      }

      const rows = db
        .prepare(`SELECT host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 3 LIMIT ${SAMPLE}`)
        .all() as unknown as { host_key: string; encrypted_value: Uint8Array }[]

      const sha = (text: string) => createHash('sha256').update(text).digest()

      for (const row of rows) {
        const bytes = Buffer.from(row.encrypted_value)

        if (bytes.subarray(0, 3).toString('utf8') !== 'v10') {
          continue
        }

        tally.rows += 1

        let plaintext: Buffer | undefined

        try {
          plaintext = decryptCookieBytes(bytes, key)
        } catch {
          // A padding failure is counted by its absence.
          continue
        }

        // Nothing of the plaintext outlives this row: it is zeroed whatever the verdict.
        try {
          tally.padding_ok += 1

          const prefix = plaintext.subarray(0, 32)

          if (prefix.equals(sha(row.host_key))) {
            tally.hash_of_host_key += 1
          } else if (prefix.equals(sha(row.host_key.replace(/^\./u, '')))) {
            tally.hash_of_host_without_dot += 1
          } else {
            tally.hash_none += 1
          }

          try {
            new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(32))
            tally.utf8_ok_after_strip += 1
          } catch {
            // Counted by its absence.
          }
        } finally {
          plaintext.fill(0)
        }
      }
    } finally {
      db.close()
      key.fill(0)
    }

    lines.push(
      `database_version=${version} ${Object.entries(tally)
        .map(([name, count]) => `${name}=${count}`)
        .join(' ')}`
    )

    const read = await readChromeCookies(profile, env, host => isBrowserCookieDomainAllowed(host, selection.verified))

    const drops =
      Object.entries(read.dropped)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(' ') || 'none'

    lines.push(`cookies_kept=${read.cookies.length} dropped: ${drops}`)

    // A few damaged rows are Chrome's own business; most of them not decrypting is the key or the format.
    const decryptedMostly = tally.rows > 0 && tally.padding_ok * 20 >= tally.rows * 19
    const prefixKnown = tally.hash_none === 0 && tally.padding_ok > 0
    const modern = Number(version) >= 24
    const ok = decryptedMostly && prefixKnown && modern

    lines.push(
      ok
        ? 'OK the key and the 32-byte domain-hash prefix behave as the importer assumes on this Chrome'
        : `CHECK ${decryptedMostly ? '' : 'fewer than 95% of values decrypt; '}${prefixKnown ? '' : 'the prefix is not the hash of host_key for some rows; '}${modern ? '' : 'database version is below 24; '}version=${version}`
    )

    return { ok, lines }
  } catch (error) {
    // A closed code only: the importer's errors never carry a path, a value or a key.
    return { ok: false, lines: [...lines, `FAIL ${error instanceof ChromeImportError ? error.code : 'unexpected'}`] }
  }
}

import { afterEach, describe, expect, it } from 'vitest'

import {
  chromeEnv,
  type ChromeFixture,
  chromeFixture,
  fakeSecurity,
  standardCookies
} from './__fixtures__/chrome-fixture'
import { chromeCheck } from './check'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const fixture = (...args: Parameters<typeof chromeFixture>): ChromeFixture => {
  const made = chromeFixture(...args)
  cleanups.push(made.cleanup)

  return made
}

describe('the owner-run Chrome check', () => {
  const healthy = () =>
    standardCookies().filter(cookie => !['.corrupt.com', '.mixed.com'].includes(cookie.host) || cookie.name === 'good')

  it('says OK for a Chrome 130+ profile and a right key, with counts only', async () => {
    const made = fixture([{ dir: 'Default', cookies: healthy() }], { lastUsed: 'Default' })
    const security = fakeSecurity()
    const result = await chromeCheck(chromeEnv(made, { runSecurity: security }))

    expect(result.ok).toBe(true)
    expect(result.lines.at(-1)).toMatch(/^OK /u)
    expect(result.lines.join('\n')).toMatch(/database_version=24 rows=\d+ padding_ok=\d+ hash_of_host_key=\d+/u)
    expect(result.lines.join('\n')).toMatch(/sites_included=7 sites_left_behind=4/u)
    // The Keychain answer is zeroed after use, never memoized: the diagnostic and the real reader each ask.
    expect(security.calls).toHaveLength(2)
  })

  it('tolerates a few damaged rows among many, as Chrome itself does', async () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      host: `.site${index}.com`,
      name: `n${index}`,
      value: `v${index}`
    }))

    const made = fixture([{ dir: 'Default', cookies: [...standardCookies(), ...many] }], { lastUsed: 'Default' })

    expect((await chromeCheck(chromeEnv(made))).ok).toBe(true)
  }, 30_000) // heavy (real SQLite / harness setup); a busy shared CI host exceeds the 5 s default

  it('prints nothing that names a site, a cookie or a value', async () => {
    const made = fixture([{ dir: 'Default', cookies: standardCookies() }], { lastUsed: 'Default' })
    const text = (await chromeCheck(chromeEnv(made))).lines.join('\n')

    for (const secret of [
      'github.com',
      'google.com',
      'chase.com',
      'vietcombank',
      'abc123',
      'bank-secret',
      'session_id',
      'test-keychain-password',
      'Default'
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('asks for a CHECK when the key is wrong, and when the database is older than the prefix', async () => {
    const wrongKey = fixture([{ dir: 'Default', cookies: standardCookies() }], { lastUsed: 'Default' })
    const wrong = await chromeCheck(chromeEnv(wrongKey, { runSecurity: fakeSecurity('not-chromes-secret') }))

    expect(wrong.ok).toBe(false)
    expect(wrong.lines.at(-1)).toMatch(/^CHECK fewer than 95% of values decrypt/u)

    const legacy = fixture([{ dir: 'Default', metaVersion: 23, cookies: standardCookies() }], { lastUsed: 'Default' })
    const old = await chromeCheck(chromeEnv(legacy))

    expect(old.ok).toBe(false)
    expect(old.lines.at(-1)).toMatch(/database version is below 24/u)
  })

  it('fails closed, in a closed word, when there is no Chrome or the Keychain refuses', async () => {
    const empty = fixture([])

    expect((await chromeCheck(chromeEnv(empty))).lines).toEqual([
      'FAIL no Chrome profile with a cookie database was found'
    ])

    const made = fixture([{ dir: 'Default', cookies: standardCookies() }], { lastUsed: 'Default' })

    const refused = await chromeCheck(
      chromeEnv(made, {
        runSecurity: async () => ({
          status: 128,
          stdout: Buffer.alloc(0),
          stderr: 'User canceled the operation.',
          timedOut: false
        })
      })
    )

    expect(refused.ok).toBe(false)
    expect(refused.lines.at(-1)).toBe('FAIL keychain_denied')
  })
})

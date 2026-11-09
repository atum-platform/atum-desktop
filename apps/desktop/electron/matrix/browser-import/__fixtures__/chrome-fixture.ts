/**
 * A fake Google Chrome profile tree for the importer's tests: the cookie databases, `Local State`, and the
 * Keychain secret that decrypts them. No test touches the real Chrome profile or the real Keychain.
 *
 * The cookie rows, the test secret and the encryption helper are ADAPTED from gstack's
 * `browse/test/cookie-import-browser.test.ts` (MIT, Copyright (c) 2026 Garry Tan, https://github.com/garrytan/gstack).
 * gstack builds them with `bun:sqlite` and writes them under the real home directory; here they are built with
 * `node:sqlite` in a private temp directory, and a value's 32-byte prefix is what Chrome 130+ writes (SHA-256 of
 * the host key) instead of random bytes. Atum's rows (host-only, `__Host-`, partitioned, banking, oversized, …)
 * are added below gstack's. Every value is synthetic.
 */
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ChromeEnv, SecurityRunner } from '../chrome-cookies'

export const NOW = Date.UTC(2026, 9, 24, 12, 0, 0)
export const TEST_PASSWORD = 'test-keychain-password'
export const TEST_KEY = pbkdf2Sync(TEST_PASSWORD, 'saltysalt', 1003, 16, 'sha1')

const IV = Buffer.alloc(16, 0x20)
const CHROMIUM_EPOCH_OFFSET = 11644473600000000n
const unixSeconds = (ms: number) => Math.floor(ms / 1000)
const chromiumEpoch = (seconds: number) => BigInt(seconds) * 1000000n + CHROMIUM_EPOCH_OFFSET

/** `v10` + AES-128-CBC over `[SHA-256(host_key)] || value`, as Chrome writes it on macOS. */
export function encryptCookieValue(
  value: string,
  options: { key?: Buffer; hostKey?: string; legacy?: boolean } = {}
): Buffer {
  const prefix = options.legacy
    ? Buffer.alloc(0)
    : createHash('sha256')
        .update(options.hostKey ?? '')
        .digest()

  const cipher = createCipheriv('aes-128-cbc', options.key ?? TEST_KEY, IV)

  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])),
    cipher.final()
  ])
}

export interface FixtureCookie {
  host: string
  name: string
  /** Plaintext to encrypt into `encrypted_value`. */
  value?: string
  /** An unencrypted `value` column, as old cookies have. */
  plain?: string
  /** `encrypted_value` bytes as they are, for a corrupt row. */
  raw?: Buffer
  path?: string
  /** Unix seconds, `'session'` (has_expires = 0), or a day offset from NOW by default (+365 days). */
  expires?: number | 'session'
  secure?: boolean
  httpOnly?: boolean
  /** Chrome's `samesite`: -1 unspecified, 0 None, 1 Lax, 2 Strict. */
  sameSite?: -1 | 0 | 1 | 2
  lastAccess?: number
  /** A non-empty `top_frame_site_key` makes this a partitioned (CHIPS) cookie. */
  partition?: string
}

export interface FixtureProfile {
  dir: string
  cookies: FixtureCookie[]
  /** `meta.version`; 24 (default) carries the domain hash, 23 does not. `null` omits the meta table. */
  metaVersion?: number | null
  /** Put the database in `Network/` instead of beside the profile. */
  network?: boolean
  /** Write the database in WAL mode, as a Chrome that keeps a write-ahead log does. */
  wal?: boolean
}

export interface ChromeFixture {
  appSupportDir: string
  cookiesPath(dir: string): string
  cleanup(): void
}

function writeDatabase(file: string, profile: FixtureProfile): void {
  const db = new DatabaseSync(file)

  if (profile.wal) {
    db.exec('PRAGMA journal_mode=WAL')
  }

  const legacy = profile.metaVersion !== undefined && profile.metaVersion !== null && profile.metaVersion < 24

  if (profile.metaVersion !== null) {
    db.exec('CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', String(profile.metaVersion ?? 24))
  }

  db.exec(`CREATE TABLE cookies (
    creation_utc INTEGER NOT NULL DEFAULT 0,
    host_key TEXT NOT NULL,
    top_frame_site_key TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    encrypted_value BLOB NOT NULL DEFAULT x'',
    path TEXT NOT NULL DEFAULT '/',
    expires_utc INTEGER NOT NULL DEFAULT 0,
    is_secure INTEGER NOT NULL DEFAULT 0,
    is_httponly INTEGER NOT NULL DEFAULT 0,
    last_access_utc INTEGER NOT NULL DEFAULT 0,
    has_expires INTEGER NOT NULL DEFAULT 1,
    is_persistent INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 1,
    samesite INTEGER NOT NULL DEFAULT -1,
    source_scheme INTEGER NOT NULL DEFAULT 0,
    source_port INTEGER NOT NULL DEFAULT -1,
    last_update_utc INTEGER NOT NULL DEFAULT 0,
    source_type INTEGER NOT NULL DEFAULT 0,
    has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
  )`)

  const insert = db.prepare(
    `INSERT INTO cookies (host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure,
       is_httponly, last_access_utc, has_expires, samesite)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  for (const cookie of profile.cookies) {
    const session = cookie.expires === 'session'
    const expires = typeof cookie.expires === 'number' ? cookie.expires : unixSeconds(NOW) + 365 * 86_400

    const encrypted =
      cookie.raw ??
      (cookie.value === undefined
        ? Buffer.alloc(0)
        : encryptCookieValue(cookie.value, { hostKey: cookie.host, legacy }))

    insert.run(
      cookie.host,
      cookie.partition ?? '',
      cookie.name,
      cookie.plain ?? '',
      encrypted,
      cookie.path ?? '/',
      session ? 0n : chromiumEpoch(expires),
      cookie.secure ? 1 : 0,
      cookie.httpOnly ? 1 : 0,
      chromiumEpoch(cookie.lastAccess ?? unixSeconds(NOW) - 3_600),
      session ? 0 : 1,
      cookie.sameSite ?? 1
    )
  }

  db.close()
}

export function chromeFixture(
  profiles: FixtureProfile[],
  options: { lastUsed?: string; mtimes?: Record<string, number> } = {}
): ChromeFixture {
  const appSupportDir = mkdtempSync(path.join(tmpdir(), 'atum-chrome-fixture-'))
  const chromeDir = path.join(appSupportDir, 'Google', 'Chrome')
  mkdirSync(chromeDir, { recursive: true })

  if (options.lastUsed) {
    writeFileSync(path.join(chromeDir, 'Local State'), JSON.stringify({ profile: { last_used: options.lastUsed } }))
  }

  const paths = new Map<string, string>()

  for (const profile of profiles) {
    const dir = path.join(chromeDir, profile.dir, profile.network ? 'Network' : '')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'Cookies')
    writeDatabase(file, profile)
    paths.set(profile.dir, file)

    const mtime = options.mtimes?.[profile.dir]

    if (mtime !== undefined) {
      utimesSync(file, mtime, mtime)
    }
  }

  return {
    appSupportDir,
    cookiesPath: dir => paths.get(dir) ?? '',
    cleanup: () => rmSync(appSupportDir, { recursive: true, force: true })
  }
}

/** A copy of a profile's database as a second location, for the newest-file rule. */
export function duplicateDatabase(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/** The Keychain as a test double: answers the one question the importer asks, and records it. */
export function fakeSecurity(
  password: string = TEST_PASSWORD
): SecurityRunner & { calls: { args: readonly string[]; timeoutMs: number }[] } {
  const calls: { args: readonly string[]; timeoutMs: number }[] = []

  const run = async (args: readonly string[], timeoutMs: number) => {
    calls.push({ args, timeoutMs })

    return { status: 0, stdout: Buffer.from(`${password}\n`), stderr: '', timedOut: false }
  }

  return Object.assign(run, { calls })
}

export function chromeEnv(fixture: ChromeFixture, overrides: Partial<ChromeEnv> = {}): ChromeEnv {
  return {
    appSupportDir: fixture.appSupportDir,
    platform: 'darwin',
    runSecurity: fakeSecurity(),
    now: () => NOW,
    tmpDir: () => tmpdir(),
    ...overrides
  }
}

/**
 * gstack's cookie rows (github, google, example, expired, session, corrupt, mixed) plus Atum's: every shape the
 * importer must keep, shape, or leave behind.
 */
export function standardCookies(): FixtureCookie[] {
  const future = unixSeconds(NOW) + 365 * 86_400

  return [
    // gstack: .github.com, three encrypted cookies (SameSite Lax, None, Strict)
    { host: '.github.com', name: 'session_id', value: 'abc123', secure: true, httpOnly: true, sameSite: 1 },
    { host: '.github.com', name: 'user_token', value: 'token-xyz', secure: true, sameSite: 0 },
    { host: '.github.com', name: 'theme', value: 'dark', sameSite: 2 },
    // gstack: .google.com
    { host: '.google.com', name: 'NID', value: 'google-nid-value', secure: true, httpOnly: true, sameSite: 0 },
    { host: '.google.com', name: 'SID', value: 'google-sid-value', secure: true, httpOnly: true, sameSite: 1 },
    // gstack: an unencrypted `value` column
    { host: '.example.com', name: 'plain_cookie', plain: 'hello-world', sameSite: 1 },
    // gstack: an expired cookie, a session cookie, a corrupt one, one good and one corrupt on a host
    { host: '.expired.com', name: 'old', value: 'expired-value', expires: unixSeconds(NOW) - 86_400 },
    { host: '.session.com', name: 'sess', value: 'session-value', expires: 'session', secure: true, httpOnly: true },
    { host: '.corrupt.com', name: 'bad', raw: Buffer.from('v10not-valid-ciphertext-at-all') },
    { host: '.mixed.com', name: 'good', value: 'mixed-good' },
    { host: '.mixed.com', name: 'bad', raw: Buffer.from('v10garbage-data-here!!!') },
    // Atum: shapes of real Chrome that the contract constrains
    { host: 'host-only.example.org', name: 'sid', value: 'host-only-value', secure: true, sameSite: 1 },
    {
      host: 'app.example.org',
      name: '__Host-session',
      value: 'host-prefix-value',
      secure: true,
      sameSite: 1,
      expires: future
    },
    { host: '.unspecified.example.org', name: 'u', value: 'unspecified', sameSite: -1 },
    { host: '.emoji.example.org', name: 'greeting', value: 'xin chào 🌏', sameSite: 1 },
    // Atum: partitioned (CHIPS) rows are not imported; the unpartitioned twin is
    { host: '.widget.example.net', name: 'twin', value: 'unpartitioned-twin' },
    { host: '.widget.example.net', name: 'twin', value: 'partitioned-twin', partition: 'https://top.example' },
    // Atum: left behind by default (banking, wallets, password managers)
    { host: '.chase.com', name: 'bank_session', value: 'bank-secret', secure: true, httpOnly: true },
    { host: 'ebanking.vietcombank.com.vn', name: 'vcb', value: 'bank-secret-2', secure: true },
    { host: '.momo.vn', name: 'wallet_session', value: 'wallet-secret', secure: true },
    { host: '.bitwarden.com', name: 'vault', value: 'vault-secret', secure: true },
    // Atum: never sites
    { host: 'localhost', name: 'dev', value: 'dev-value' },
    { host: '127.0.0.1', name: 'ip', value: 'ip-value' },
    { host: '[::1]', name: 'ip6', value: 'ip6-value' },
    { host: 'nas.local', name: 'internal', value: 'internal-value' },
    { host: '.app.localhost', name: 'dev2', value: 'dev2-value' },
    // Atum: cookies the contract would refuse, dropped one by one
    { host: '.huge.example.org', name: 'big', value: 'x'.repeat(5_000), sameSite: 1 },
    { host: '.insecure-none.example.org', name: 'none_no_secure', value: 'v', sameSite: 0, secure: false },
    { host: '.fine.example.org', name: 'fine', value: 'fine-value', sameSite: 1 }
  ]
}

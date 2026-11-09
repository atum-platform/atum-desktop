/**
 * Google Chrome on macOS: profile discovery, the Keychain "Chrome Safe Storage" key and `v10` cookie decryption,
 * producing Playwright `storageState` cookies.
 *
 * ADAPTED from gstack's `browse/src/cookie-import-browser.ts` (MIT, Copyright (c) 2026 Garry Tan,
 * https://github.com/garrytan/gstack, version 1.75.0.0, commit 07b59e39). The licence and the notice that ships
 * with the app are in `third-party/licenses/app/gstack-LICENSE.txt` and `third-party/app-components.json`.
 *
 * Kept from gstack: the Chromium profile layout and the `Default` / `Profile N` discovery, the domain listing
 * that never decrypts, the key derivation (PBKDF2-HMAC-SHA1, salt `saltysalt`, 1003 iterations, 16 bytes), AES-128-CBC
 * with an IV of sixteen spaces over the `v10` ciphertext, the unencrypted `value` fallback, the Chromium epoch
 * (microseconds since 1601) to Unix seconds, the SameSite mapping, and copying a locked database before reading it.
 *
 * Changed for Atum:
 * - Bun's `bun:sqlite` and `Bun.spawn` become `node:sqlite` and an injected `security` runner (Electron main has
 *   neither); the runner is absolute-pathed, its service name is a constant, and it waits long enough for a person
 *   to answer the macOS Keychain dialog (gstack gave up after 10 s).
 * - Chrome only, macOS only: the Linux, Windows (DPAPI, App-Bound v20) and other-Chromium branches are not carried.
 * - Chrome 130+ (cookie database version 24) prefixes every encrypted value with 32 bytes: SHA-256 of the host key.
 *   gstack skipped 32 bytes unconditionally; this reads `meta.version` and skips them only when they are there.
 * - Partitioned cookies (CHIPS, a non-empty `top_frame_site_key`) are not imported: the contract's cookie has no
 *   partition key, and an unpartitioned copy could overwrite the real session cookie of the same name.
 * - A cookie the contract would refuse (oversized value, a host the contract bans, SameSite=None without Secure) is
 *   dropped and counted rather than failing the whole import. Counts leave this module; values never do.
 * - The decrypted value must be valid UTF-8, so a wrong key that happens to pad correctly cannot import garbage.
 *
 * No cookie value, key or password is ever logged, thrown in an error message or kept after the call returns.
 *
 * Zeroization is best effort and honest about its limits. The Keychain secret arrives as a Buffer (never decoded to
 * a string), the derived key and every decrypted plaintext are Buffers, and each is overwritten with zeros in a
 * `finally` as soon as it has done its job. A cookie value that has become a JavaScript string cannot be wiped: V8
 * strings are immutable and copied by the engine, so those live until garbage collection. The README says so; a
 * native helper that never lets a value into V8 is a noted follow-up, not built.
 */
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type BrowserCookie, cookieViolation } from './contract'

export type ChromeImportErrorCode =
  | 'unsupported_platform'
  | 'chrome_not_found'
  | 'cookie_db_unreadable'
  | 'cookie_db_corrupt'
  | 'keychain_denied'
  | 'keychain_not_found'
  | 'keychain_timeout'
  | 'keychain_error'
  | 'decrypt_failed'
  /** A value's domain hash is for another host than its row's `host_key`: a transplanted ciphertext. */
  | 'domain_mismatch'

/** A closed code; never a path, cookie, key or password in the message. */
export class ChromeImportError extends Error {
  constructor(readonly code: ChromeImportErrorCode) {
    super(`chrome_import_${code}`)
    this.name = 'ChromeImportError'
  }
}

export const CHROME_KEYCHAIN_SERVICE = 'Chrome Safe Storage'
/** A person has to answer the macOS Keychain dialog (their login password or Touch ID). */
export const KEYCHAIN_PROMPT_TIMEOUT_MS = 120_000

const SECURITY_BINARY = '/usr/bin/security'
const CHROMIUM_EPOCH_OFFSET_MICROS = '11644473600000000'
/** `meta.version` from which Chrome prefixes the plaintext of every encrypted value with SHA-256(host_key). */
const DOMAIN_HASH_VERSION = 24
const DOMAIN_HASH_BYTES = 32

export interface SecurityResult {
  status: number | null
  /** The raw bytes, never decoded to a string: the secret is on this stream and the caller zeroes it. */
  stdout: Buffer
  stderr: string
  timedOut: boolean
}

export type SecurityRunner = (args: readonly string[], timeoutMs: number) => Promise<SecurityResult>

/** Runs `/usr/bin/security` with a minimal environment: no inherited secrets reach it. */
export const runSecurity: SecurityRunner = (args, timeoutMs) =>
  new Promise(resolve => {
    execFile(
      SECURITY_BINARY,
      [...args],
      {
        env: {
          HOME: process.env.HOME ?? '',
          LOGNAME: process.env.LOGNAME ?? '',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          USER: process.env.USER ?? ''
        },
        timeout: timeoutMs,
        // Bytes for stdout so the Keychain secret never becomes a string; stderr carries no secret.
        encoding: 'buffer',
        maxBuffer: 64 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : null) : 0
        const timedOut = Boolean(error?.killed) && status === null

        resolve({
          status,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '',
          timedOut
        })
      }
    )
  })

export interface ChromeEnv {
  /** `~/Library/Application Support`. */
  appSupportDir: string
  platform: NodeJS.Platform
  runSecurity: SecurityRunner
  /** Epoch milliseconds. */
  now(): number
  /** Where a locked cookie database is copied to be read. */
  tmpDir(): string
}

export function defaultChromeEnv(home: string): ChromeEnv {
  return {
    appSupportDir: path.join(home, 'Library', 'Application Support'),
    platform: process.platform,
    runSecurity,
    now: () => Date.now(),
    tmpDir: () => tmpdir()
  }
}

// ------------------------------------------------------------------ profile discovery

export interface ChromeProfile {
  /** The directory name: `Default` or `Profile N`. */
  dir: string
  /** 1-based position in the stable order (Default, then Profile 1, 2, …): the contract's opaque ordinal. */
  ordinal: number
  cookiesPath: string
  /** Chrome's own `profile.last_used`. */
  lastUsed: boolean
}

const PROFILE_DIR = /^(?:Default|Profile [0-9]{1,4})$/u

const profileNumber = (dir: string) => (dir === 'Default' ? 0 : Number(dir.slice('Profile '.length)))

function newestExisting(candidates: readonly string[]): string | null {
  let best: { file: string; mtime: number } | null = null

  for (const file of candidates) {
    try {
      const info = statSync(file)

      if (info.isFile() && (!best || info.mtimeMs > best.mtime)) {
        best = { file, mtime: info.mtimeMs }
      }
    } catch {
      // Not there: another candidate may be.
    }
  }

  return best?.file ?? null
}

function lastUsedProfile(chromeDir: string): string | null {
  try {
    const state = JSON.parse(readFileSync(path.join(chromeDir, 'Local State'), 'utf8')) as {
      profile?: { last_used?: unknown }
    }

    return typeof state.profile?.last_used === 'string' ? state.profile.last_used : null
  } catch {
    return null
  }
}

/** The Chrome profiles on this Mac that have a cookie database, in a stable order. */
export function discoverChromeProfiles(env: ChromeEnv): ChromeProfile[] {
  if (env.platform !== 'darwin') {
    throw new ChromeImportError('unsupported_platform')
  }

  const chromeDir = path.join(env.appSupportDir, 'Google', 'Chrome')
  let entries: string[]

  try {
    entries = readdirSync(chromeDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PROFILE_DIR.test(entry.name))
      .map(entry => entry.name)
  } catch {
    return []
  }

  const last = lastUsedProfile(chromeDir)

  return entries
    .sort((a, b) => profileNumber(a) - profileNumber(b))
    .flatMap(dir => {
      // Recent Chrome keeps the database in `Network/` on some platforms and beside the profile on macOS.
      const cookiesPath = newestExisting([
        path.join(chromeDir, dir, 'Network', 'Cookies'),
        path.join(chromeDir, dir, 'Cookies')
      ])

      return cookiesPath ? [{ dir, cookiesPath, lastUsed: dir === last }] : []
    })
    .map((profile, index) => ({ ...profile, ordinal: index + 1 }))
}

/** One profile, no choices: the one Chrome last used, else `Default`, else the first with cookies. */
export function chooseChromeProfile(profiles: readonly ChromeProfile[]): ChromeProfile | null {
  return (
    profiles.find(profile => profile.lastUsed) ??
    profiles.find(profile => profile.dir === 'Default') ??
    profiles[0] ??
    null
  )
}

// ------------------------------------------------------------------ cookie database

interface OpenDatabase {
  db: DatabaseSync
  close(): void
}

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

function sqliteCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode

  if (typeof code === 'number') {
    return code & 0xff
  }

  const message = String((error as { message?: unknown } | null)?.message ?? '')

  return /malformed|not a database|corrupt/iu.test(message) ? SQLITE_CORRUPT : null
}

/** A private copy of a database Chrome has locked: the cookie file, and its journal, WAL and shared memory. */
function openCopy(dbPath: string, env: ChromeEnv): OpenDatabase {
  const dir = mkdtempSync(path.join(env.tmpDir(), 'atum-chrome-'))
  const copy = path.join(dir, 'Cookies')
  const clean = () => rmSync(dir, { recursive: true, force: true })

  try {
    copyFileSync(dbPath, copy)

    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(dbPath + suffix)) {
        copyFileSync(dbPath + suffix, copy + suffix)
      }
    }

    // Opened read-write because it is ours: SQLite can then roll back a journal Chrome left hot.
    const db = new DatabaseSync(copy)

    return {
      db,
      close: () => {
        try {
          db.close()
        } finally {
          clean()
        }
      }
    }
  } catch {
    clean()
    throw new ChromeImportError('cookie_db_unreadable')
  }
}

/** Chrome's database read-only in place, or a private copy when Chrome holds it locked. */
function openCookieDb(dbPath: string, env: ChromeEnv): OpenDatabase {
  let db: DatabaseSync | undefined

  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // A lock shows on the first read, not on open.
    db.prepare('SELECT 1 FROM cookies LIMIT 1').get()

    const opened = db

    return { db: opened, close: () => opened.close() }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // Already closed.
    }

    const code = sqliteCode(error)

    if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) {
      throw new ChromeImportError('cookie_db_corrupt')
    }

    // Locked by Chrome (the usual reason), or anything else a plain read cannot get past: read a private copy.
    // If the copy cannot be made or opened either, that is the closed `cookie_db_unreadable`.
    return openCopy(dbPath, env)
  }
}

function withDatabase<T>(profile: ChromeProfile, env: ChromeEnv, read: (db: DatabaseSync) => T): T {
  const opened = openCookieDb(profile.cookiesPath, env)

  try {
    return read(opened.db)
  } catch (error) {
    if (error instanceof ChromeImportError) {
      throw error
    }

    throw new ChromeImportError(sqliteCode(error) === SQLITE_CORRUPT ? 'cookie_db_corrupt' : 'cookie_db_unreadable')
  } finally {
    opened.close()
  }
}

const chromiumNow = (env: ChromeEnv) => BigInt(Math.trunc(env.now())) * 1000n + BigInt(CHROMIUM_EPOCH_OFFSET_MICROS)

function columnsOf(db: DatabaseSync): ReadonlySet<string> {
  return new Set((db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]).map(({ name }) => name))
}

/** Partitioned (CHIPS) rows are not imported; databases from before Chrome had them have no such column. */
const unpartitioned = (columns: ReadonlySet<string>) =>
  columns.has('top_frame_site_key') ? "AND top_frame_site_key = ''" : ''

export interface CookieHostRow {
  /** Chrome's `host_key`: a leading dot for a domain cookie, none for host-only. */
  host: string
  cookies: number
  /** Unix seconds of the most recent use of any cookie of the host. */
  lastAccess: number
}

/** The hosts that have live cookies, with counts and recency. Never decrypts anything. */
export function listCookieHosts(profile: ChromeProfile, env: ChromeEnv): CookieHostRow[] {
  return withDatabase(profile, env, db => {
    const columns = columnsOf(db)

    const recency = columns.has('last_access_utc')
      ? `MAX((last_access_utc - ${CHROMIUM_EPOCH_OFFSET_MICROS}) / 1000000)`
      : '0'

    const rows = db
      .prepare(
        `SELECT host_key AS host, COUNT(*) AS cookies, ${recency} AS lastAccess
         FROM cookies
         WHERE (has_expires = 0 OR expires_utc > ?) ${unpartitioned(columns)}
         GROUP BY host_key`
      )
      .all(chromiumNow(env)) as unknown as { host: string; cookies: number; lastAccess: number }[]

    return rows.map(row => ({
      host: String(row.host),
      cookies: Number(row.cookies),
      lastAccess: Number(row.lastAccess)
    }))
  })
}

// ------------------------------------------------------------------ Keychain and decryption

/**
 * The browser's "Safe Storage" secret from the login Keychain, as bytes the caller must zero (`.fill(0)`) once the
 * key is derived. macOS asks the person to allow it.
 */
export async function readSafeStoragePassword(
  env: ChromeEnv,
  timeoutMs: number = KEYCHAIN_PROMPT_TIMEOUT_MS
): Promise<Buffer> {
  // The service name is a constant: nothing a person or a web page supplied reaches this command.
  const result = await env.runSecurity(['find-generic-password', '-s', CHROME_KEYCHAIN_SERVICE, '-w'], timeoutMs)

  if (result.timedOut) {
    throw new ChromeImportError('keychain_timeout')
  }

  if (result.status !== 0) {
    result.stdout.fill(0)

    const said = result.stderr.toLowerCase()

    if (/user canceled|denied|interaction (?:is )?not allowed/u.test(said)) {
      throw new ChromeImportError('keychain_denied')
    }

    throw new ChromeImportError(
      /could not be found|not found/u.test(said) || result.status === 44 ? 'keychain_not_found' : 'keychain_error'
    )
  }

  // `security -w` prints the secret and a newline; the secret is the bytes between the surrounding whitespace.
  const isSpace = (byte: number) => byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09
  let start = 0
  let end = result.stdout.length

  while (start < end && isSpace(result.stdout[start]!)) {
    start += 1
  }

  while (end > start && isSpace(result.stdout[end - 1]!)) {
    end -= 1
  }

  if (start === end) {
    result.stdout.fill(0)

    throw new ChromeImportError('keychain_error')
  }

  return result.stdout.subarray(start, end)
}

/** PBKDF2-HMAC-SHA1 over the Keychain secret, as Chrome derives its macOS cookie key. The caller zeroes the key. */
export const deriveCookieKey = (password: Buffer | string): Buffer =>
  pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The plaintext of one `v10` value, as a Buffer the caller owns and must zero: AES-128-CBC with an IV of sixteen
 * spaces. Every intermediate chunk is zeroed here; only the returned Buffer survives the call.
 */
export function decryptCookieBytes(encrypted: Uint8Array, key: Buffer): Buffer {
  const bytes = Buffer.from(encrypted)

  if (bytes.subarray(0, 3).toString('utf8') !== 'v10') {
    throw new ChromeImportError('decrypt_failed')
  }

  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const chunks: Buffer[] = []

  try {
    chunks.push(decipher.update(bytes.subarray(3)))
    chunks.push(decipher.final())

    return Buffer.concat(chunks)
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0)
    }
  }
}

/**
 * One `v10` value, decrypted. When the database carries the domain hash (version 24+), the first 32 bytes are
 * SHA-256(`hostKey`) and must be exactly that: Chrome binds each value to the host it was written for, so a
 * ciphertext copied into a row of another host fails here and is never imported (`domain_mismatch`).
 */
export function decryptCookieValue(encrypted: Uint8Array, key: Buffer, domainHash: boolean, hostKey: string): string {
  const plaintext = decryptCookieBytes(encrypted, key)

  try {
    if (!domainHash) {
      return UTF8.decode(plaintext)
    }

    if (plaintext.length < DOMAIN_HASH_BYTES) {
      throw new ChromeImportError('decrypt_failed')
    }

    const expected = createHash('sha256').update(hostKey, 'utf8').digest()

    try {
      if (!timingSafeEqual(plaintext.subarray(0, DOMAIN_HASH_BYTES), expected)) {
        throw new ChromeImportError('domain_mismatch')
      }
    } finally {
      expected.fill(0)
    }

    return UTF8.decode(plaintext.subarray(DOMAIN_HASH_BYTES))
  } finally {
    plaintext.fill(0)
  }
}

const SAME_SITE: Record<number, BrowserCookie['sameSite']> = { 0: 'None', 1: 'Lax', 2: 'Strict' }

export interface ChromeCookieRead {
  cookies: BrowserCookie[]
  /** Rows chosen but not importable, by reason. Counts only. */
  dropped: Record<string, number>
}

interface RawCookieRow {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array
  path: string
  expires_unix: number
  is_secure: number
  is_httponly: number
  samesite: number
}

/**
 * The live cookies of the hosts `accept` chooses, decrypted and shaped for Playwright's `storageState`. The caller
 * decides what to import from the host list alone; only those rows are decrypted.
 */
export async function readChromeCookies(
  profile: ChromeProfile,
  env: ChromeEnv,
  accept: (host: string) => boolean
): Promise<ChromeCookieRead> {
  const password = await readSafeStoragePassword(env)
  let key: Buffer

  try {
    key = deriveCookieKey(password)
  } finally {
    password.fill(0)
  }

  try {
    return withDatabase(profile, env, db => {
      const columns = columnsOf(db)
      const metaVersion = readMetaVersion(db)
      const hashed = metaVersion >= DOMAIN_HASH_VERSION

      const rows = db
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path,
                  CASE WHEN has_expires = 0 OR expires_utc = 0 THEN -1
                       ELSE (expires_utc - ${CHROMIUM_EPOCH_OFFSET_MICROS}) / 1000000 END AS expires_unix,
                  is_secure, is_httponly, samesite
           FROM cookies
           WHERE (has_expires = 0 OR expires_utc > ?) ${unpartitioned(columns)}
           ORDER BY host_key, name`
        )
        // `.all()`, not `.iterate()`: an iterator does not keep its statement alive, and a statement the garbage
        // collector finalises mid-loop ends the read with "statement has been finalized".
        .all(chromiumNow(env)) as unknown as RawCookieRow[]

      const cookies: BrowserCookie[] = []
      const dropped: Record<string, number> = {}
      const drop = (reason: string) => (dropped[reason] = (dropped[reason] ?? 0) + 1)

      for (const row of rows) {
        if (!accept(row.host_key)) {
          continue
        }

        let value: string

        try {
          // Prefer the unencrypted `value` column, as gstack does.
          value = row.value
            ? row.value
            : row.encrypted_value.length
              ? decryptCookieValue(row.encrypted_value, key, hashed, row.host_key)
              : ''
        } catch (error) {
          // A transplanted ciphertext is counted apart from damage: it is never imported either way.
          drop(error instanceof ChromeImportError && error.code === 'domain_mismatch' ? 'domain_mismatch' : 'decrypt')

          continue
        }

        const cookie: BrowserCookie = {
          name: row.name,
          value,
          domain: row.host_key,
          path: row.path || '/',
          expires: row.expires_unix,
          httpOnly: row.is_httponly === 1,
          secure: row.is_secure === 1,
          // Chrome's -1 is "unspecified", which Chrome itself treats as Lax.
          sameSite: SAME_SITE[row.samesite] ?? 'Lax'
        }

        const violation = cookieViolation(cookie)

        if (violation) {
          drop(violation)
        } else if (cookie.sameSite === 'None' && !cookie.secure) {
          // Chromium refuses this pair, and one refused cookie fails Playwright's whole addCookies.
          drop('samesite_none_insecure')
        } else {
          cookies.push(cookie)
        }
      }

      return { cookies, dropped }
    })
  } finally {
    key.fill(0)
  }
}

function readMetaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined
    const version = Number(row?.value)

    return Number.isFinite(version) ? version : DOMAIN_HASH_VERSION
  } catch {
    // No meta table: a database too new or too odd to know; Chrome 130+ is the common case.
    return DOMAIN_HASH_VERSION
  }
}

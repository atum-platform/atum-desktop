import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import type { AtumUpdateChannel, AtumUpdateNotes } from '../shared/atum-update-flow'

import type { DesktopUpdateNotes, DesktopUpdateSettings } from './desktop-updater'

const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
const STOCK_MIGRATION = 1
const EXTERNAL_COMMAND_TIMEOUT_MS = 1_000
const MIGRATION_DEADLINE_MS = 5_000
const QUARANTINE_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100
} as const

interface CommandRunner {
  (file: string, arguments_: readonly string[], options: { timeout: number }): Promise<{
    stderr: string
    stdout: string
  }>
}

interface QuarantineRemover {
  (directory: string, options: typeof QUARANTINE_REMOVE_OPTIONS): Promise<void>
}

interface MigrationDeadline {
  expired(): boolean
  remaining(): number
}

function runCommand(file: string, arguments_: readonly string[], options: { timeout: number }): Promise<{
  stderr: string
  stdout: string
}> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, arguments_, { encoding: 'utf8', timeout: options.timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr, stdout, timedOut: error.killed === true }))
        return
      }

      resolve({ stderr, stdout })
    })
  })
}

function migrationDeadline(timeout: number): MigrationDeadline {
  const expires = Date.now() + Math.max(1, timeout)

  return {
    expired: () => Date.now() >= expires,
    remaining: () => Math.max(0, expires - Date.now())
  }
}

function commandTimeout(deadline: MigrationDeadline): number {
  return Math.max(1, Math.min(EXTERNAL_COMMAND_TIMEOUT_MS, deadline.remaining()))
}

function progress(callback: ((step: string) => void) | undefined, step: string): void {
  try {callback?.(step)} catch { /* Diagnostics never own migration behavior. */ }
}

async function settleWithinDeadline(promise: Promise<void>, deadline: MigrationDeadline): Promise<boolean> {
  const remaining = deadline.remaining()

  if (remaining <= 0) {
    void promise.catch(() => undefined)
    return false
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), remaining)
    timer.unref()
  })

  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    if (timer) {clearTimeout(timer)}
  }
}

function commandError(error: unknown): {
  code?: number | string
  stderr?: string
  stdout?: string
  timedOut?: boolean
} {
  return error && typeof error === 'object'
    ? error as { code?: number | string; stderr?: string; stdout?: string; timedOut?: boolean }
    : {}
}

async function clearShipItInstallationAttempts(
  applicationIdentifier: string,
  runtime: { command: CommandRunner; deadline: MigrationDeadline; progress?: (step: string) => void }
): Promise<boolean> {
  if (runtime.deadline.expired()) {return false}
  progress(runtime.progress, 'attempts.delete.start')

  try {
    await runtime.command('/usr/bin/defaults', [
      '-currentHost', 'delete', applicationIdentifier, 'SQRLShipItInstallationAttempts'
    ], { timeout: commandTimeout(runtime.deadline) })
  } catch (error) {
    if (commandError(error).timedOut || runtime.deadline.expired()) {
      progress(runtime.progress, 'attempts.delete.timeout')
      return false
    }
    // Exit status alone is not proof of absence. Readback below owns the result.
  }

  if (runtime.deadline.expired()) {return false}
  progress(runtime.progress, 'attempts.readback.start')

  try {
    await runtime.command('/usr/bin/defaults', [
      '-currentHost', 'read', applicationIdentifier, 'SQRLShipItInstallationAttempts'
    ], { timeout: commandTimeout(runtime.deadline) })

    return false
  } catch (error) {
    const result = commandError(error)

    if (result.timedOut || runtime.deadline.expired()) {
      progress(runtime.progress, 'attempts.readback.timeout')
      return false
    }

    return /domain\/default pair .* does not exist/iu.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  }
}

async function shipItActive(
  applicationIdentifier: string,
  runtime: { command: CommandRunner; deadline: MigrationDeadline; progress?: (step: string) => void }
): Promise<boolean | null> {
  const uid = process.getuid?.()

  if (uid === undefined || runtime.deadline.expired()) {return null}

  let jobQuiet = false
  progress(runtime.progress, 'quiet.launchctl.start')

  try {
    const { stdout } = await runtime.command('/bin/launchctl', [
      'print', `gui/${uid}/${applicationIdentifier}`
    ], { timeout: commandTimeout(runtime.deadline) })

    if (/\bstate\s*=\s*running\b/iu.test(stdout) || /\bpid\s*=\s*[1-9]\d*\b/iu.test(stdout)) {return true}
    if (!/\bstate\s*=\s*[^\n]+/iu.test(stdout)) {return null}
    jobQuiet = true
  } catch (error) {
    const result = commandError(error)

    if (result.timedOut || runtime.deadline.expired()) {
      progress(runtime.progress, 'quiet.launchctl.timeout')
      return null
    }
    const detail = result.stderr ?? ''

    if (!/could not find service|service .* not found/iu.test(detail)) {return null}
    jobQuiet = true
  }

  if (!jobQuiet) {return null}
  if (runtime.deadline.expired()) {return null}
  progress(runtime.progress, 'quiet.processes.start')

  try {
    const { stdout } = await runtime.command('/bin/ps', ['-axo', 'command='], {
      timeout: commandTimeout(runtime.deadline)
    })

    return stdout.split('\n').some(command =>
      command.includes('/ShipIt') && command.trim().split(/\s+/u).includes(applicationIdentifier)
    )
  } catch (error) {
    if (commandError(error).timedOut || runtime.deadline.expired()) {
      progress(runtime.progress, 'quiet.processes.timeout')
    }

    return null
  }
}

async function requestFingerprint(file: string): Promise<string | null | undefined> {
  try {
    const metadata = await stat(file)

    if (!metadata.isFile() || metadata.size > 64 * 1024) {return undefined}

    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return false}
    throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquireMigrationLock(lockDirectory: string): Promise<boolean> {
  await mkdir(path.dirname(lockDirectory), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory)
      await writeFile(path.join(lockDirectory, 'owner'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 })

      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
      let owner = 0

      try {owner = Number.parseInt(await readFile(path.join(lockDirectory, 'owner'), 'utf8'), 10)} catch { /* Defer. */ }
      if (!Number.isSafeInteger(owner) || owner <= 0 || processAlive(owner)) {return false}
      await rm(lockDirectory, { recursive: true, force: true })
    }
  }

  return false
}

function shipItLockDirectory(applicationIdentifier: string, cacheDirectory: string): string {
  const shipItIdentifier = `${applicationIdentifier}.ShipIt`

  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,200}$/u.test(applicationIdentifier) ||
    path.basename(cacheDirectory) !== shipItIdentifier
  ) {
    throw new Error('Refusing ShipIt ownership outside the application identity')
  }

  return path.join(path.dirname(cacheDirectory), `.${shipItIdentifier}.stock-migration.lock`)
}

function committedQuarantineName(shipItIdentifier: string, entry: string): boolean {
  const prefix = `.${shipItIdentifier}.stock-migration-`

  return entry.startsWith(prefix) && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.retired$/u.test(
    entry.slice(prefix.length)
  )
}

/** Delete only quarantines whose verified retirement reached its commit rename.
 * Ambiguous pre-verification quarantines deliberately have no `.retired` suffix. */
export async function sweepLegacyShipItQuarantines(options: {
  applicationIdentifier: string
  cacheDirectory: string
  progress?: (step: string) => void
  removeQuarantine?: QuarantineRemover
}): Promise<void> {
  const shipItIdentifier = `${options.applicationIdentifier}.ShipIt`
  const lockDirectory = shipItLockDirectory(options.applicationIdentifier, options.cacheDirectory)
  progress(options.progress, 'sweep.lock.start')
  if (!(await acquireMigrationLock(lockDirectory))) {return}

  try {
    let entries

    try {
      entries = await readdir(path.dirname(options.cacheDirectory), { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !committedQuarantineName(shipItIdentifier, entry.name)) {continue}

      progress(options.progress, 'sweep.cleanup.start')
      void Promise.resolve()
        .then(() => (options.removeQuarantine ?? rm)(
          path.join(path.dirname(options.cacheDirectory), entry.name), QUARANTINE_REMOVE_OPTIONS
        ))
        .then(
          () => progress(options.progress, 'sweep.cleanup.complete'),
          () => progress(options.progress, 'sweep.cleanup.deferred')
        )
    }
  } finally {
    progress(options.progress, 'sweep.lock.release')
    await rm(lockDirectory, { recursive: true, force: true })
  }
}

/** The stock check/download and the one-time migration share this lease across
 * every user-data profile that maps to the same native ShipIt identity. */
export function createShipItOperationLease(options: {
  applicationIdentifier: string
  cacheDirectory: string
}): () => Promise<(() => Promise<void>) | null> {
  const lockDirectory = shipItLockDirectory(options.applicationIdentifier, options.cacheDirectory)

  return async () => {
    if (!(await acquireMigrationLock(lockDirectory))) {return null}
    let released = false

    return async () => {
      if (released) {return}
      released = true
      await rm(lockDirectory, { recursive: true, force: true })
    }
  }
}

/** One-time bridge from the custom updater into Squirrel-owned state. The
 * attempt key belongs to this exact ShipIt label. Destructive cleanup requires
 * an identity lock, a quiet exact launchd job and an unchanged request snapshot. */
export async function retireLegacyShipItState(options: {
  afterQuarantine?: (quarantine: string) => Promise<void>
  applicationIdentifier: string
  cacheDirectory: string
  clearInstallationAttempts?: (applicationIdentifier: string) => Promise<boolean>
  command?: CommandRunner
  complete: () => Promise<void>
  deadlineMs?: number
  isShipItActive?: (applicationIdentifier: string) => Promise<boolean | null>
  progress?: (step: string) => void
  removeQuarantine?: QuarantineRemover
}): Promise<boolean> {
  const shipItIdentifier = `${options.applicationIdentifier}.ShipIt`
  const lockDirectory = shipItLockDirectory(options.applicationIdentifier, options.cacheDirectory)
  const deadline = migrationDeadline(options.deadlineMs ?? MIGRATION_DEADLINE_MS)
  const runtime = { command: options.command ?? runCommand, deadline, progress: options.progress }
  progress(options.progress, 'lock.acquire.start')
  if (!(await acquireMigrationLock(lockDirectory))) {return false}

  let quarantine: string | null = null

  try {
    const active = options.isShipItActive
      ? options.isShipItActive
      : (applicationIdentifier: string) => shipItActive(applicationIdentifier, runtime)

    progress(options.progress, 'quiet.initial.start')
    if (await active(shipItIdentifier) !== false) {return false}
    if (deadline.expired()) {return false}
    progress(options.progress, 'request.snapshot.start')
    const request = await requestFingerprint(path.join(options.cacheDirectory, 'ShipItState.plist'))

    if (request === undefined || deadline.expired()) {return false}

    try {
      quarantine = path.join(
        path.dirname(options.cacheDirectory), `.${shipItIdentifier}.stock-migration-${randomUUID()}`
      )
      progress(options.progress, 'quarantine.rename.start')
      await rename(options.cacheDirectory, quarantine)
      await options.afterQuarantine?.(quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error}
      quarantine = null
    }

    if (quarantine) {
      if (deadline.expired()) {return false}
      progress(options.progress, 'quarantine.verify.start')
      const quarantinedRequest = await requestFingerprint(path.join(quarantine, 'ShipItState.plist'))
      const replacementRequest = await requestFingerprint(path.join(options.cacheDirectory, 'ShipItState.plist'))
      progress(options.progress, 'quiet.verification.start')
      const becameActive = await active(shipItIdentifier)

      if (
        deadline.expired() || becameActive !== false || quarantinedRequest !== request || replacementRequest !== null
      ) {
        try {
          if (replacementRequest === null) {
            await rename(quarantine, options.cacheDirectory)
            quarantine = null
          }
        } catch {
          // Preserve the uniquely named quarantine rather than overwrite new native state.
        }

        return false
      }

      const committedQuarantine = `${quarantine}.retired`

      // This rename is the commit point. Only the pre-verification name may be
      // restored; cleanup after a verified retirement is always best effort.
      progress(options.progress, 'retirement.commit.start')
      await rename(quarantine, committedQuarantine)
      quarantine = null

      progress(options.progress, 'retirement.cleanup.start')
      void Promise.resolve()
        .then(() => (options.removeQuarantine ?? rm)(committedQuarantine, QUARANTINE_REMOVE_OPTIONS))
        .then(
          () => progress(options.progress, 'retirement.cleanup.complete'),
          () => progress(options.progress, 'retirement.cleanup.deferred')
        )
    }

    if (deadline.expired()) {return false}
    progress(options.progress, 'quiet.post_cleanup.start')
    if (await active(shipItIdentifier) !== false) {return false}
    if (deadline.expired()) {return false}
    progress(options.progress, 'attempts.clear.start')
    const attemptsCleared = options.clearInstallationAttempts
      ? await options.clearInstallationAttempts(shipItIdentifier)
      : await clearShipItInstallationAttempts(shipItIdentifier, runtime)

    if (!attemptsCleared || deadline.expired()) {
      return false
    }
    progress(options.progress, 'quiet.final.start')
    if (await active(shipItIdentifier) !== false) {return false}
    if (deadline.expired()) {return false}
    progress(options.progress, 'request.final.start')
    if (await requestFingerprint(path.join(options.cacheDirectory, 'ShipItState.plist')) !== null) {return false}

    progress(options.progress, 'settings.complete.start')
    if (!(await settleWithinDeadline(options.complete(), deadline))) {
      progress(options.progress, 'settings.complete.timeout')
      return false
    }
    progress(options.progress, 'migration.complete')

    return true
  } finally {
    if (quarantine) {
      try {
        if (!(await pathExists(options.cacheDirectory))) {
          await rename(quarantine, options.cacheDirectory)
        }
      } catch {
        // Never overwrite state another same-identity process created.
      }
    }

    progress(options.progress, 'lock.release')
    await rm(lockDirectory, { recursive: true, force: true })
  }
}

function version(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value) ? value : null
}

function channel(value: unknown): AtumUpdateChannel {
  return value === 'beta' ? 'beta' : 'latest'
}

async function readRecord(file: string, maximumBytes = 8192): Promise<Record<string, unknown>> {
  try {
    if ((await stat(file)).size > maximumBytes) {return {}}
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown

    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function legacyApplied(record: Record<string, unknown>, currentVersion: string) {
  const previous = version(record.previous)
  const expected = version(record.expected)

  return previous && expected === currentVersion && previous !== currentVersion
    ? { from_version: previous, to_version: currentVersion }
    : null
}

/** The classic engine branch shares updates.json with the app updater. Merge
 * its root fields so app channel/version state cannot be erased. */
export function mergeDesktopUpdateConfig(file: string, patch: Record<string, unknown>): void {
  let record: Record<string, unknown> = {}

  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown

    if (value && typeof value === 'object' && !Array.isArray(value)) {record = value as Record<string, unknown>}
  } catch {
    // A missing or malformed legacy file is replaced by the caller's valid root settings.
  }

  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`

  try {
    writeFileSync(temporary, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Normal app settings own the channel and last-seen version. Legacy Atum
 * markers are read only for one applied event, then retired; they never cause
 * an install, cleanup, retry, or access to Squirrel-owned state. */
export function createDesktopUpdateSettings(options: {
  file: string
  legacyMarkers?: readonly string[]
  retireLegacyNativeState?: (complete: () => Promise<void>) => Promise<boolean>
  sweepLegacyNativeState?: () => Promise<void>
}): DesktopUpdateSettings {
  let writes = Promise.resolve()
  let sweepLegacyNativeState = options.sweepLegacyNativeState

  const read = async () => {
    await writes
    const record = await readRecord(options.file)
    const updates = record.updates && typeof record.updates === 'object' && !Array.isArray(record.updates)
      ? record.updates as Record<string, unknown>
      : {}

    return { record, updates }
  }
  const write = (change: (record: Record<string, unknown>, updates: Record<string, unknown>) => void) => {
    const pending = writes.then(async () => {
      const record = await readRecord(options.file)
      const updates = record.updates && typeof record.updates === 'object' && !Array.isArray(record.updates)
        ? { ...(record.updates as Record<string, unknown>) }
        : {}
      change(record, updates)
      delete record.channel
      delete record.failureDays
      delete record.lastVersion
      record.updates = updates
      await mkdir(path.dirname(options.file), { recursive: true })
      const temporary = `${options.file}.${randomUUID()}.tmp`

      try {
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await rename(temporary, options.file)
      } finally {
        await rm(temporary, { force: true })
      }
    })

    writes = pending.catch(() => undefined)

    return pending
  }

  return {
    async migrate(currentVersion) {
      const sweep = sweepLegacyNativeState
      sweepLegacyNativeState = undefined

      try {await sweep?.()} catch { /* Cleanup is best effort and must not defer stock updates. */ }

      const { record, updates } = await read()
      const selected = channel(updates.channel ?? record.channel)
      const lastVersion = version(updates.lastVersion ?? record.lastVersion)
      let applied = lastVersion && lastVersion !== currentVersion
        ? { from_version: lastVersion, to_version: currentVersion }
        : null

      for (const marker of options.legacyMarkers ?? []) {
        if (!applied) {applied = legacyApplied(await readRecord(marker, 1024), currentVersion)}
      }

      const complete = async () => {
        await write((_record, next) => {
          for (const key of Object.keys(next)) {delete next[key]}
          next.channel = selected
          next.lastVersion = currentVersion
          next.stockMigration = STOCK_MIGRATION
        })
        await Promise.all((options.legacyMarkers ?? []).map(marker => rm(marker, { force: true })))
      }

      if (updates.stockMigration !== STOCK_MIGRATION && options.retireLegacyNativeState) {
        if (!(await options.retireLegacyNativeState(complete))) {
          return { applied: null, channel: selected, deferred: true }
        }
      } else {
        await complete()
      }

      return { applied, channel: selected }
    },
    async getChannel() {
      const { record, updates } = await read()

      return channel(updates.channel ?? record.channel)
    },
    setChannel(next) {
      if (next !== 'latest' && next !== 'beta') {return Promise.reject(new Error('Invalid update channel'))}

      return write((_record, updates) => {
        updates.channel = next
        delete updates.failureDays
      })
    }
  }
}

/** Optional localized fallback. Standard manifest releaseNotes win. */
export function trustedUpdateNotes(feed: string, fetchImpl: typeof fetch = fetch): DesktopUpdateNotes {
  const base = new URL(feed)

  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('Invalid notes feed')
  }

  return {
    async read(nextVersion, locale) {
      if (!/^\d+\.\d+\.\d+$/.test(nextVersion) || !['vi', 'en', 'ja', 'zh', 'zh-hant'].includes(locale)) {return null}
      const response = await fetchImpl(new URL(`notes/${nextVersion}.${locale}.json`, base), {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000)
      })

      if (!response.ok || !response.body) {return null}
      const chunks: Uint8Array[] = []
      let bytes = 0

      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > 8192) {throw new Error('Release notes too large')}
        chunks.push(chunk)
      }

      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<AtumUpdateNotes>

      return value.v === 1 && value.version === nextVersion && value.locale === locale && Array.isArray(value.items)
        ? value.items
        : null
    }
  }
}

/** Read-only native recovery. Never manufacture a ShipIt request or reset its
 * attempt counter. Only a previously armed Restart may be resumed this way. */
export async function recoverPendingShipItInstall(options: {
  applicationIdentifier: string
  cacheDirectory: string
  bundlePath: string
  currentVersion: string
  command?: CommandRunner
}): Promise<{ version: string; install(): Promise<void> } | null> {
  const command = options.command ?? runCommand
  shipItLockDirectory(options.applicationIdentifier, options.cacheDirectory)
  const file = path.join(options.cacheDirectory, 'ShipItState.plist')
  const fingerprint = await requestFingerprint(file)

  if (!fingerprint) {return null}

  try {
    const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 1000 })
    const request = JSON.parse(stdout) as Record<string, unknown>
    const bundleURL = new URL(String(request.updateBundleURL))
    const targetURL = new URL(String(request.targetBundleURL))

    if (bundleURL.protocol !== 'file:' || bundleURL.host || targetURL.protocol !== 'file:' || targetURL.host) {return null}
    const bundle = fileURLToPath(bundleURL)
    const target = fileURLToPath(targetURL)

    if (
      request.bundleIdentifier !== options.applicationIdentifier || request.launchAfterInstallation !== true ||
      target !== await realpath(options.bundlePath) || !bundle.endsWith('.app') ||
      !bundle.startsWith(`${options.cacheDirectory}${path.sep}update.`) || await realpath(bundle) !== bundle
    ) {return null}

    const info = path.join(bundle, 'Contents', 'Info.plist')
    const { stdout: plist } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { timeout: 1000 })
    const metadata = JSON.parse(plist) as Record<string, unknown>
    const nextVersion = version(metadata.CFBundleShortVersionString)

    if (!nextVersion || metadata.CFBundleIdentifier !== options.applicationIdentifier ||
      !semver.gt(nextVersion, options.currentVersion)) {return null}

    // Preserve the running app's designated signing requirement. A copied or
    // modified staged bundle is never promoted just because a plist names it.
    const { stdout: requirement } = await command('/usr/bin/codesign', ['-d', '-r-', options.bundlePath], { timeout: 2000 })
    const designated = /^designated => (.+)$/mu.exec(requirement)?.[1]

    if (!designated) {return null}
    await command('/usr/bin/codesign', ['--verify', '--strict', '-R', designated, bundle], { timeout: 20_000 })

    if (await requestFingerprint(file) !== fingerprint) {return null}
    // A launchd definition is required. Do not invent a new installer command.
    const label = `gui/${process.getuid?.()}/${options.applicationIdentifier}.ShipIt`
    await command('/bin/launchctl', ['print', label], { timeout: 1000 })

    return {
      version: nextVersion,
      async install() {
        if (await requestFingerprint(file) !== fingerprint) {throw new Error('Native update request changed')}
        // No -k: never interrupt a native installation already in progress.
        const { stdout } = await command('/bin/launchctl', ['print', label], { timeout: 1000 })

        if (/\bstate\s*=\s*running\b/iu.test(stdout) || /\bpid\s*=\s*[1-9]\d*\b/iu.test(stdout)) {return}
        await command('/bin/launchctl', ['kickstart', label], { timeout: 1000 })
      }
    }
  } catch {return null}
}

/** Squirrel's backup directories live outside its cache on some releases.
 * Retire only exact-identity, unused directories while native installation is
 * quiet, with the same lease/request recheck as the r7 migration. */
export async function sweepOrphanedShipItTemporaryDirectories(options: {
  applicationIdentifier: string
  cacheDirectory: string
  temporaryPath: string
  command?: CommandRunner
}): Promise<void> {
  const command = options.command ?? runCommand
  const deadline = migrationDeadline(MIGRATION_DEADLINE_MS)
  const runtime = { command, deadline }
  const release = await createShipItOperationLease(options)()

  if (!release) {return}
  const file = path.join(options.cacheDirectory, 'ShipItState.plist')

  try {
    if (await shipItActive(`${options.applicationIdentifier}.ShipIt`, runtime) !== false) {return}
    const fingerprint = await requestFingerprint(file)

    if (fingerprint === undefined) {return}
    let request = ''

    if (fingerprint) {
      request = (await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {
        timeout: commandTimeout(deadline)
      })).stdout
      JSON.parse(request) // An unreadable request means nothing may be removed.
    }

    const root = await realpath(options.temporaryPath)
    const prefix = `${options.applicationIdentifier}.ShipIt.`
    const entries = await readdir(root, { withFileTypes: true })

    for (const entry of entries) {
      if (deadline.expired()) {break}

      if (!entry.isDirectory() || !entry.name.startsWith(prefix) ||
        !/^[a-zA-Z0-9]{6,12}$/u.test(entry.name.slice(prefix.length))) {continue}

      const candidate = path.join(root, entry.name)
      // Protect any path referenced anywhere in the native state, including
      // percent-encoded URLs. A malformed URL is handled by the outer defer.
      const values = JSON.stringify(JSON.parse(request || '{}'))

      if (decodeURIComponent(values).includes(candidate)) {continue}

      if (await realpath(candidate) !== candidate) {continue}

      const unused = async (directory: string) => {
        try {
          await command('/usr/sbin/lsof', ['-t', '+D', directory], { timeout: commandTimeout(deadline) })

          return false
        } catch (error) {
          const result = commandError(error)

          return result.code === 1 && !result.timedOut && !(result.stdout ?? '').trim() && !(result.stderr ?? '').trim()
        }
      }

      if (!(await unused(candidate)) || deadline.expired()) {continue}

      if (await requestFingerprint(file) !== fingerprint ||
        await shipItActive(`${options.applicationIdentifier}.ShipIt`, runtime) !== false || deadline.expired()) {return}

      const quarantine = `${candidate}.retired-${randomUUID()}`
      await rename(candidate, quarantine)

      // Close the rename race: an open file remains visible to lsof at its new path.
      if (await requestFingerprint(file) !== fingerprint || !(await unused(quarantine)) || deadline.expired() ||
        await shipItActive(`${options.applicationIdentifier}.ShipIt`, runtime) !== false) {
        await rename(quarantine, candidate)

        return
      }

      void rm(quarantine, QUARANTINE_REMOVE_OPTIONS).catch(() => undefined)
    }
  } catch { /* Ambiguous state or a timed out probe: leave all remaining copies. */ }
  finally {await release()}
}

/** Size the actual bundle, including the bundled runtime. Squirrel needs a ZIP,
 * its native copy, an expanded app and a replacement/backup, plus working room. */
export function createDesktopUpdateDiskPreflight(options: {
  bundlePath: string
  temporaryPath: string
  cachePath: string
  command?: CommandRunner
  freeBytes?: (directory: string) => Promise<number>
}): (info: { files?: unknown }) => Promise<void> {
  return async info => {
    const { stdout } = await (options.command ?? runCommand)('/usr/bin/du', ['-sk', options.bundlePath], { timeout: 5000 })
    const bundleBytes = Number(/^\s*(\d+)\s/u.exec(stdout)?.[1]) * 1024

    if (!Number.isFinite(bundleBytes) || bundleBytes <= 0) {throw new Error('Could not measure update disk space')}

    const zipBytes = Array.isArray(info.files) ? Math.max(0, ...info.files.map(file =>
      typeof file?.size === 'number' && Number.isFinite(file.size) ? file.size : 0
    )) : 0

    const requiredBytes = Math.ceil((2 * bundleBytes + 2 * (zipBytes || bundleBytes) + 512 * 1024 ** 2) / 1e8) * 1e8

    const free = options.freeBytes ?? (async directory => {
      const value = await statfs(directory)

      return Number(value.bavail) * Number(value.bsize)
    })

    for (const directory of [path.dirname(options.bundlePath), options.temporaryPath, options.cachePath]) {
      const available = await free(directory)

      if (!Number.isFinite(available) || available < 0) {throw new Error('Could not read update disk space')}

      if (available < requiredBytes) {
        throw Object.assign(new Error(`Insufficient free space: needs ${(requiredBytes / 1e9).toFixed(1)} GB free`), { requiredBytes })
      }
    }
  }
}

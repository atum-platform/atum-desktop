// macOS application inventory for the Kỹ năng launcher. It lists exactly what
// the Mac's own app launcher (Launchpad / Apps) lists: bundles that really live
// under the three Applications roots (a symlink out to elsewhere does not
// count; Safari's cryptex is the one system exception), wrapped iPhone/iPad
// apps included, by their localized Finder name. Spotlight is deliberately not
// a source — it surfaces every helper, uninstaller, input method and printer
// utility on the disk. This module keeps bundle paths and launch
// mechanics in Electron: callers receive presentation metadata plus opaque
// ids, never an executable path or a command to run.

import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { NativeAppEntry } from '../shared/skills-launcher'

const APPLICATION_SUFFIX = '.app'
const FRAMEWORK_SUFFIX = '.framework'
// A bundle's interior. A renamed copy (`Atum.app.rollback-…`) no longer ends
// in `.app`, but its `Contents/Frameworks/… Helper.app` are still helpers.
const BUNDLE_CONTENTS = 'Contents'
// iPhone/iPad apps on Apple Silicon: `X.app/WrappedBundle -> Wrapper/X.app`,
// whose flat Info.plist replaces `Contents/Info.plist`.
const WRAPPED_BUNDLE = 'WrappedBundle'
// Safari (and other cryptex-delivered system apps) sit behind a symlink here.
const SYSTEM_CRYPTEXES = '/System/Volumes/Preboot/Cryptexes/'
const MAX_SCAN_DEPTH = 4
const PROCESS_TIMEOUT_MS = 10_000
const TRUTHY_PLIST_STRING = /^(?:1|yes|true)$/iu
const PROCESS_MAX_BUFFER = 4 * 1024 * 1024

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: ExecFileCallback
) => unknown

interface FileStat {
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

interface DirectoryEntry {
  name: string
  isDirectory(): boolean
}

interface BundleMetadata {
  bundleId: string
  name: string
  backgroundOnly: boolean
}

interface BundleRecord {
  entry: NativeAppEntry
  path: string
  fingerprint: string
}

export type NativeAppInventoryErrorCode =
  | 'APP_NOT_FOUND'
  | 'APP_INVALID'
  | 'APP_CHANGED'
  | 'APP_LAUNCH_FAILED'

export class NativeAppInventoryError extends Error {
  readonly code: NativeAppInventoryErrorCode

  constructor(code: NativeAppInventoryErrorCode) {
    super(code)
    this.name = 'NativeAppInventoryError'
    this.code = code
  }
}

export interface NativeAppInventory {
  list(refresh?: boolean): Promise<NativeAppEntry[]>
  resolve(id: string): Promise<{ entry: NativeAppEntry; path: string }>
  launch(id: string, documentPath?: string): Promise<{ entry: NativeAppEntry; path: string }>
}

export interface NativeAppInventoryDependencies {
  /**
   * Finder presentation for bundles — artwork as data URLs and localized
   * display names — keyed by the requested path (the native helper on macOS).
   * Results are cached per bundle fingerprint, so a rescan only asks for new
   * or changed apps.
   */
  getAppPresentation?: (bundlePaths: string[]) => Promise<{ icons: Record<string, string>; names: Record<string, string> }>
  applicationRoots?: readonly string[]
  homeDirectory?: string
  platform?: NodeJS.Platform
  maxScanDepth?: number
  readDirectory?: (directory: string) => Promise<readonly DirectoryEntry[]>
  readFile?: (file: string) => Promise<string | Buffer>
  realpath?: (candidate: string) => Promise<string>
  lstat?: (candidate: string) => Promise<FileStat>
  execFile?: ExecFile
}

function appId(bundlePath: string): string {
  return `native-app:${createHash('sha256').update(bundlePath).digest('hex').slice(0, 32)}`
}

function hasSuffix(candidate: string, suffix: string): boolean {
  return candidate.toLocaleLowerCase('en-US').endsWith(suffix)
}

function hasNestedBundleAncestor(candidate: string): boolean {
  const segments = path.resolve(candidate).split(path.sep)

  return segments.slice(0, -1).some(segment =>
    hasSuffix(segment, APPLICATION_SUFFIX) || hasSuffix(segment, FRAMEWORK_SUFFIX) || segment === BUNDLE_CONTENTS)
}

function plistString(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([\\s\\S]*?)</string>`, 'u'))

  if (!match) {return undefined}

  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .trim()
}

function plistBoolean(xml: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = xml.match(new RegExp(`<key>${escaped}</key>\\s*(<true\\s*/>|<integer>\\s*1\\s*</integer>|<string>([\\s\\S]*?)</string>)`, 'u'))

  // Vendors write booleans loosely (`<string>1</string>` in Adobe helpers);
  // LaunchServices reads those as true, so the launcher must too.
  return Boolean(match && (match[2] === undefined || TRUTHY_PLIST_STRING.test(match[2].trim())))
}

function parsePlist(xml: string): BundleMetadata | null {
  const bundleId = plistString(xml, 'CFBundleIdentifier')
  const name = plistString(xml, 'CFBundleDisplayName') || plistString(xml, 'CFBundleName')

  if (!bundleId || !name) {return null}

  return { bundleId, name, backgroundOnly: plistBoolean(xml, 'LSBackgroundOnly') }
}

function parsePlutil(stdout: string | Buffer): BundleMetadata | null {
  try {
    const plist = JSON.parse(String(stdout)) as Record<string, unknown>
    const bundleId = typeof plist.CFBundleIdentifier === 'string' ? plist.CFBundleIdentifier.trim() : ''
    const displayName = typeof plist.CFBundleDisplayName === 'string' ? plist.CFBundleDisplayName.trim() : ''
    const bundleName = typeof plist.CFBundleName === 'string' ? plist.CFBundleName.trim() : ''

    if (!bundleId || !(displayName || bundleName)) {return null}

    const backgroundOnly = plist.LSBackgroundOnly === true || plist.LSBackgroundOnly === 1 ||
      (typeof plist.LSBackgroundOnly === 'string' && TRUTHY_PLIST_STRING.test(plist.LSBackgroundOnly.trim()))

    return { bundleId, name: displayName || bundleName, backgroundOnly }
  } catch {
    return null
  }
}

function processOutput(execFile: ExecFile, file: string, args: readonly string[]): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        ;(error as Error & { stderr?: string | Buffer }).stderr = stderr
        reject(error)

        return
      }

      resolve(stdout)
    })
  })
}

/** Creates the main-process-only inventory. It neither needs Accessibility nor launches while listing. */
export function createNativeAppInventory(dependencies: NativeAppInventoryDependencies = {}): NativeAppInventory {
  const readDirectory = dependencies.readDirectory ?? (async directory => fs.readdir(directory, { withFileTypes: true }) as unknown as DirectoryEntry[])
  const readFile = dependencies.readFile ?? (candidate => fs.readFile(candidate))
  const realpath = dependencies.realpath ?? (candidate => fs.realpath(candidate))
  const lstat = dependencies.lstat ?? (async candidate => fs.lstat(candidate) as unknown as FileStat)
  const execFile = dependencies.execFile ?? (nodeExecFile as unknown as ExecFile)
  const platform = dependencies.platform ?? process.platform
  const homeDirectory = dependencies.homeDirectory ?? os.homedir()

  // The launcher's roots, and only them. /System/Applications carries
  // Utilities; /System/Library/CoreServices/Applications is not shown there.
  const roots = dependencies.applicationRoots ?? [
    '/Applications',
    path.join(homeDirectory, 'Applications'),
    '/System/Applications'
  ]

  const maxScanDepth = dependencies.maxScanDepth ?? MAX_SCAN_DEPTH
  let records = new Map<string, BundleRecord>()
  let entries: NativeAppEntry[] | null = null
  let refreshing: Promise<NativeAppEntry[]> | null = null
  const presentation = new Map<string, { icon?: string; name?: string }>()

  const metadataFor = async (infoPath: string): Promise<BundleMetadata | null> => {
    let raw: string | Buffer

    try {
      raw = await readFile(infoPath)
    } catch {
      return null
    }

    const xml = String(raw)
    const xmlMetadata = parsePlist(xml)

    if (xmlMetadata) {return xmlMetadata}

    // Binary plists are normal in signed bundles. plutil is macOS-native and
    // receives the path as a distinct argv value, never through a shell.
    if (platform !== 'darwin') {return null}

    try {
      return parsePlutil(await processOutput(execFile, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', infoPath]))
    } catch {
      return null
    }
  }

  const describe = async (candidate: string): Promise<BundleRecord | null> => {
    if (!hasSuffix(candidate, APPLICATION_SUFFIX) || hasNestedBundleAncestor(candidate)) {return null}

    let canonical: string
    let bundleStat: FileStat
    let infoStat: FileStat

    try {
      canonical = await realpath(candidate)

      if (!hasSuffix(canonical, APPLICATION_SUFFIX) || hasNestedBundleAncestor(canonical)) {return null}
      bundleStat = await lstat(canonical)
    } catch {
      return null
    }

    let infoPath = path.join(canonical, BUNDLE_CONTENTS, 'Info.plist')

    try {
      infoStat = await lstat(infoPath)
    } catch {
      // A wrapped iPhone/iPad app: the metadata is the wrapped bundle's, the
      // launchable bundle is still the outer one.
      infoPath = path.join(canonical, WRAPPED_BUNDLE, 'Info.plist')

      try {
        infoStat = await lstat(infoPath)
      } catch {
        return null
      }
    }

    const metadata = await metadataFor(infoPath)

    if (!metadata || metadata.backgroundOnly) {return null}

    const fingerprint = JSON.stringify({
      bundle: [bundleStat.dev, bundleStat.ino, bundleStat.mtimeMs, bundleStat.size],
      info: [infoStat.dev, infoStat.ino, infoStat.mtimeMs, infoStat.size],
      bundleId: metadata.bundleId,
      name: metadata.name
    })

    return {
      entry: { id: appId(canonical), name: metadata.name, bundleId: metadata.bundleId },
      path: canonical,
      fingerprint
    }
  }

  const scanRoot = async (root: string): Promise<string[]> => {
    const found: string[] = []

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxScanDepth) {return}

      let children: readonly DirectoryEntry[]

      try {
        children = await readDirectory(directory)
      } catch {
        return
      }

      for (const child of children) {
        const candidate = path.join(directory, child.name)

        if (hasSuffix(child.name, APPLICATION_SUFFIX)) {
          found.push(candidate)
        } else if (child.isDirectory() && !hasSuffix(child.name, FRAMEWORK_SUFFIX) && child.name !== BUNDLE_CONTENTS) {
          await walk(candidate, depth + 1)
        }
      }
    }

    await walk(root, 0)

    return found
  }

  /** True when a resolved bundle really lives under a launcher root. */
  const insideRoots = async (): Promise<(canonical: string) => boolean> => {
    const resolvedRoots = (await Promise.all(roots.map(root => realpath(root).catch(() => null))))
      .filter((root): root is string => Boolean(root))

    return canonical => canonical.startsWith(SYSTEM_CRYPTEXES) ||
      resolvedRoots.some(root => canonical === root || canonical.startsWith(`${root}${path.sep}`))
  }

  const refresh = async (): Promise<NativeAppEntry[]> => {
    const candidates = (await Promise.all(roots.map(scanRoot))).flat()
    const allowed = await insideRoots()
    const discovered = new Map<string, BundleRecord>()

    for (const candidate of candidates) {
      // Resolve before loading metadata so a symlinked alias does not make the
      // same bundle appear twice. Launchpad lists every real install — two
      // copies with one bundle id (Xcode and Xcode-beta) are two tiles.
      let canonical: string

      try {
        canonical = await realpath(candidate)
      } catch {
        continue
      }

      if (discovered.has(canonical) || !allowed(canonical)) {continue}

      const record = await describe(canonical)

      if (record) {discovered.set(record.path, record)}
    }

    const found = [...discovered.values()]
    const presentationKey = (record: BundleRecord) => `${record.path}\0${record.fingerprint}`
    const missing = found.filter(record => !presentation.has(presentationKey(record)))

    if (dependencies.getAppPresentation && missing.length > 0) {
      try {
        const fetched = await dependencies.getAppPresentation(missing.map(record => record.path))

        for (const record of missing) {
          presentation.set(presentationKey(record), { icon: fetched.icons[record.path], name: fetched.names[record.path]?.replace(/\.app$/iu, '').trim() || undefined })
        }
      } catch {
        // Artwork and localized names are cosmetic; the Info.plist name stands
        // and the next open asks again.
      }
    }

    const live = new Set(found.map(presentationKey))

    for (const key of presentation.keys()) {
      if (!live.has(key)) {presentation.delete(key)}
    }

    for (const record of found) {
      const shown = presentation.get(presentationKey(record))

      if (shown?.name) {record.entry.name = shown.name}

      if (shown?.icon) {record.entry.icon = shown.icon}
    }

    const ordered = found.sort((left, right) =>
      left.entry.name.localeCompare(right.entry.name) || left.entry.bundleId.localeCompare(right.entry.bundleId) || left.path.localeCompare(right.path)
    )

    records = new Map(ordered.map(record => [record.entry.id, record]))
    entries = ordered.map(record => record.entry)

    return entries
  }

  const refreshOnce = () => {
    refreshing ??= refresh().finally(() => {refreshing = null})

    return refreshing
  }

  return {
    async list(refreshRequested = false): Promise<NativeAppEntry[]> {
      if (!entries || refreshRequested) {await refreshOnce()}

      return entries ?? []
    },

    async resolve(id: string): Promise<{ entry: NativeAppEntry; path: string }> {
      if (!records.has(id)) {await refreshOnce()}
      const existing = records.get(id)

      if (!existing) {throw new NativeAppInventoryError('APP_NOT_FOUND')}

      const current = await describe(existing.path)

      if (!current) {throw new NativeAppInventoryError('APP_NOT_FOUND')}

      if (current.path !== existing.path || current.entry.id !== existing.entry.id || current.entry.bundleId !== existing.entry.bundleId || current.fingerprint !== existing.fingerprint) {
        throw new NativeAppInventoryError('APP_CHANGED')
      }

      return { entry: existing.entry, path: existing.path }
    },

    async launch(id: string, documentPath?: string): Promise<{ entry: NativeAppEntry; path: string }> {
      const resolved = await this.resolve(id)
      const args = ['-a', resolved.path, ...(documentPath ? ['--', documentPath] : [])]

      try {
        await processOutput(execFile, '/usr/bin/open', args)
      } catch {
        throw new NativeAppInventoryError('APP_LAUNCH_FAILED')
      }

      return resolved
    }
  }
}

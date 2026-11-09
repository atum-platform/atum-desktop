import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import type { MatrixExecutionPolicyView } from '../../shared/execution-policy'

import { readDomainJson } from './domain'

/**
 * A Mac taking over a cloud agent reads the latest committed cloud home's memory, `USER.md` and
 * skills, one way (reliability plan R5: "the cloud stays the writer until H-H"). Without it a
 * standby Mac answers from the memory it held when it last ran the agent (the mini's was
 * 2026-10-01), and says nothing about it.
 *
 * The owner-facing route this reads is `atum.cloud-home-read/1` and DOES NOT EXIST YET: the cloud
 * home is sealed in the agent-home bucket under a key only the controller holds, and the
 * controller's routes are the executor's, not the owner's (`atum.agent-home/1.2`). The exact
 * request to the platform is in  Until it
 * ships the platform answers 404/405/501, the capability check says `unsupported`, and the Mac
 * says it is working without recent memory instead of pretending.
 *
 * Read-only means two things here. This Mac never writes the cloud home (there is no upload
 * path). And it writes locally only the paths below, only from a verified committed generation,
 * and never deletes anything. The cloud copy is authoritative (no merge): a file that differs is
 * replaced with it and never sent back. But the Mac may have learned something while it answered
 * (a failover lasting hours) that the cloud never saw, so every differing local file is first
 * copied to the backups folder (`<backups>/<agent>/<generation>/<path>`, private to the user), and
 * the read reports which paths it kept so the window can say so. A copy that cannot be made
 * stops the replacement of that file: nothing is overwritten without a copy.
 */
export const CLOUD_HOME_READ_PROFILE = 'atum.cloud-home-read/1'

/** What a takeover may take from the cloud home. SOUL.md, config, keys and plugins are not here. */
const ALLOWED_TREES = ['memories', 'skills'] as const
const ALLOWED_FILES = ['USER.md'] as const

export const CLOUD_HOME_LIMITS = {
  files: 4_000,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  pathBytes: 512,
  manifestBytes: 1024 * 1024,
  /** A file travels as base64 inside one JSON object. */
  responseBytes: Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4096,
  concurrency: 6
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u

export interface CloudHomeEntry {
  path: string
  size: number
  sha256: string
}

export interface CloudHomeManifest {
  agentPrincipal: string
  generation: number
  committedAt: number
  /** Only the files this Mac may take: never a dot-prefixed one. */
  files: CloudHomeEntry[]
  /** Dot-prefixed entries the manifest listed and this Mac left alone. */
  skipped: number
}

/**
 * The shape of a home-relative POSIX path inside the allowed trees: bounded, no escape, no empty or
 * `.`/`..` segment. A segment that starts with a dot is allowed here only when `dotSegments` is set.
 */
function cloudHomePathShape(candidate: unknown, dotSegments: boolean): candidate is string {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    Buffer.byteLength(candidate) > CLOUD_HOME_LIMITS.pathBytes ||
    /[\\\0]/u.test(candidate) ||
    candidate.startsWith('/')
  ) {
    return false
  }

  const segments = candidate.split('/')

  if (
    segments.some(
      segment => segment === '' || segment === '.' || segment === '..' || (!dotSegments && segment.startsWith('.'))
    )
  ) {
    return false
  }

  return (
    (ALLOWED_FILES as readonly string[]).includes(candidate) ||
    ((ALLOWED_TREES as readonly string[]).includes(segments[0]!) && segments.length >= 2)
  )
}

/** A home-relative POSIX path inside the allowed trees: no dot segments, no escape, bounded. */
export function cloudHomePathAllowed(candidate: unknown): candidate is string {
  return cloudHomePathShape(candidate, false)
}

/**
 * A path inside the allowed trees with a dot-prefixed segment (`skills/.usage.json`,
 * `skills/.bundled_manifest`, `skills/.hub/...`): Hermes's own bookkeeping, which a real `skills/`
 * tree is full of. It is never read or written here, and it does not make the manifest unusable:
 * the platform is asked to leave these out, and any it lists anyway are skipped and counted.
 */
export function cloudHomePathHidden(candidate: unknown): candidate is string {
  return cloudHomePathShape(candidate, true) && !cloudHomePathShape(candidate, false)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** The manifest exactly as the contract states it; anything else is refused, never repaired. */
export function parseCloudHomeManifest(value: unknown, agentPrincipal: string): CloudHomeManifest | null {
  const row = record(value)
  const keys = row ? Object.keys(row).sort().join(',') : ''

  if (
    !row ||
    keys !== 'agentPrincipal,committedAt,files,generation,profile' ||
    row.profile !== CLOUD_HOME_READ_PROFILE ||
    row.agentPrincipal !== agentPrincipal ||
    !count(row.generation) ||
    row.generation < 1 ||
    !count(row.committedAt) ||
    !Array.isArray(row.files) ||
    row.files.length > CLOUD_HOME_LIMITS.files
  ) {
    return null
  }

  const files: CloudHomeEntry[] = []
  const seen = new Set<string>()
  let total = 0
  let skipped = 0

  for (const raw of row.files) {
    const entry = record(raw)
    const entryPath = entry?.path

    // A dot-prefixed path inside an allowed tree is Hermes bookkeeping: skipped, not a reason to
    // refuse the whole manifest. Every other path outside the allowlist still refuses it.
    const hidden = cloudHomePathHidden(entryPath)

    if (
      !entry ||
      typeof entryPath !== 'string' ||
      Object.keys(entry).sort().join(',') !== 'path,sha256,size' ||
      !(hidden || cloudHomePathAllowed(entryPath)) ||
      seen.has(entryPath) ||
      !count(entry.size) ||
      // A skipped entry is never fetched, so its size is not counted against what this Mac takes.
      (!hidden && entry.size > CLOUD_HOME_LIMITS.fileBytes) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      return null
    }

    seen.add(entryPath)

    if (hidden) {
      skipped += 1

      continue
    }

    total += entry.size

    if (total > CLOUD_HOME_LIMITS.totalBytes) {
      return null
    }

    files.push({ path: entryPath, size: entry.size, sha256: entry.sha256 })
  }

  return { agentPrincipal, generation: row.generation, committedAt: row.committedAt, files, skipped }
}

/** Local/cloud placement follows the saved execution policy and current lease. */
export function cloudHomeReadApplies(view: MatrixExecutionPolicyView | undefined): boolean {
  return Boolean(
    view &&
    view.policy.source === 'saved' &&
    view.policy.order.includes('cloud') &&
    !view.policy.disabled.includes('cloud')
  )
}

export type CloudHomeAction = { kind: 'manifest' } | { kind: 'file'; generation: number; path: string }

export interface CloudHomeResponse {
  status: number
  value: unknown
}

/** The two fixed owner routes. The caller supplies the main-owned bearer, never the renderer. */
export async function requestCloudHome(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  action: CloudHomeAction,
  signal: AbortSignal
): Promise<CloudHomeResponse> {
  signal.throwIfAborted()

  if (!UUID.test(agentPrincipal)) {
    throw new Error('matrix_cloud_home_invalid')
  }

  const base = `${resource}/agents/${encodeURIComponent(agentPrincipal)}/cloud-home`
  const file = action.kind === 'file'

  const response = await fetch(file ? `${base}/file` : base, {
    method: file ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(file ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    },
    ...(file ? { body: JSON.stringify({ generation: action.generation, path: action.path }) } : {}),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    // A route that is not there answers with its framework's page, not JSON: that is the
    // capability check failing, not a broken home.
    return { status: response.status, value: null }
  }

  return {
    status: response.status,
    value: await readDomainJson(response, file ? CLOUD_HOME_LIMITS.responseBytes : CLOUD_HOME_LIMITS.manifestBytes)
  }
}

export type CloudHomeSync =
  /** The platform has no owner route for the cloud home yet (404/405/501): the capability check failed. */
  | { state: 'unsupported' }
  /** The route exists and the agent has no committed cloud home: nothing to read. */
  | { state: 'none' }
  /** The route exists but this read did not complete; nothing was changed. */
  | { state: 'unavailable' }
  | {
      state: 'fresh'
      generation: number
      committedAt: number
      files: number
      changed: number
      skipped: number
      /** Paths whose differing local copy was saved to the backups folder before the cloud's replaced it. */
      kept: string[]
    }

/**
 * What the window says about this Mac's memory after a takeover's read (MatrixAgentView.memoryNote),
 * never silently: it could not read the cloud's latest (`without_recent`), or the cloud's copy
 * replaced memory files this Mac had changed and the earlier versions are saved here (`local_saved`).
 * Nothing to say before the read ends, when there is no cloud home, or when the Mac simply matched it.
 */
export function cloudHomeMemoryNote(result: CloudHomeSync | undefined): 'local_saved' | 'without_recent' | undefined {
  if (!result) {
    return undefined
  }

  if (result.state === 'unsupported' || result.state === 'unavailable') {
    return 'without_recent'
  }

  return result.state === 'fresh' && result.kept.length > 0 ? 'local_saved' : undefined
}

export interface MatrixCloudHomeReaderOptions {
  /** Absolute folder (beside the app's device state, never inside an agent's home) where a local
   * file about to be replaced is saved first: `<backups>/<agent>/<generation>/<path>`. */
  backups: string
  request(agentPrincipal: string, action: CloudHomeAction, signal: AbortSignal): Promise<CloudHomeResponse>
  now?(): number
  /** How long a failed capability check is believed (the platform ships the route; a restart is not needed). */
  unsupportedForMs?: number
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Whether `target` is inside `home` with no symlink on the way (a link could aim a write elsewhere). */
function inside(home: string, target: string): boolean {
  const root = path.resolve(home)
  const resolved = path.resolve(target)

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return false
  }

  let current = root

  for (const segment of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, segment)

    try {
      if (lstatSync(current).isSymbolicLink()) {
        return false
      }
    } catch {
      break
    }
  }

  return true
}

function local(home: string, relative: string): Buffer | undefined {
  try {
    const target = path.join(home, relative)

    return inside(home, target) && existsSync(target) ? readFileSync(target) : undefined
  } catch {
    return undefined
  }
}

export class MatrixCloudHomeReader {
  private unsupportedUntil = 0

  constructor(private readonly options: MatrixCloudHomeReaderOptions) {
    if (!path.isAbsolute(options.backups)) {
      throw new Error('matrix_cloud_home_invalid')
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Brings the allowed paths of `home` up to the latest committed cloud generation. Every changed
   * file is fetched and verified against the manifest's digest before the first one is replaced, so
   * an aborted, refused or corrupted read changes nothing. Only a local disk error while replacing
   * (full disk, a permission change) can leave some of the files replaced, and says `unavailable`.
   */
  async sync(input: { agentPrincipal: string; home: string; signal: AbortSignal }): Promise<CloudHomeSync> {
    if (this.now() < this.unsupportedUntil) {
      return { state: 'unsupported' }
    }

    try {
      const manifestResponse = await this.options.request(input.agentPrincipal, { kind: 'manifest' }, input.signal)

      if ([404, 405, 501].includes(manifestResponse.status)) {
        this.unsupportedUntil = this.now() + (this.options.unsupportedForMs ?? 10 * 60_000)

        return { state: 'unsupported' }
      }

      if (manifestResponse.status === 204 || (manifestResponse.status === 200 && manifestResponse.value === null)) {
        return { state: 'none' }
      }

      const manifest =
        manifestResponse.status === 200 ? parseCloudHomeManifest(manifestResponse.value, input.agentPrincipal) : null

      if (!manifest) {
        return { state: 'unavailable' }
      }

      const stale = manifest.files.filter(entry => {
        const existing = local(input.home, entry.path)

        return !existing || existing.byteLength !== entry.size || sha256(existing) !== entry.sha256
      })

      const staged = await this.fetchAll(input.agentPrincipal, manifest, stale, input.signal)

      if (!staged) {
        return { state: 'unavailable' }
      }

      input.signal.throwIfAborted()

      const committed = this.commit(input.home, staged, {
        agentPrincipal: input.agentPrincipal,
        generation: manifest.generation
      })

      if (!committed) {
        return { state: 'unavailable' }
      }

      return {
        state: 'fresh',
        generation: manifest.generation,
        committedAt: manifest.committedAt,
        files: manifest.files.length,
        changed: staged.length,
        skipped: manifest.skipped,
        kept: committed.kept
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_s1_authentication') {
        throw error
      }

      return { state: 'unavailable' }
    }
  }

  private async fetchAll(
    agentPrincipal: string,
    manifest: CloudHomeManifest,
    entries: readonly CloudHomeEntry[],
    signal: AbortSignal
  ): Promise<Array<{ path: string; bytes: Buffer }> | null> {
    const staged: Array<{ path: string; bytes: Buffer }> = []
    let next = 0
    let failed = false

    const worker = async () => {
      while (!failed && next < entries.length) {
        const entry = entries[next++]!

        const response = await this.options.request(
          agentPrincipal,
          { kind: 'file', generation: manifest.generation, path: entry.path },
          signal
        )

        const row = record(response.value)

        const bytes =
          typeof row?.content === 'string' && /^[A-Za-z0-9+/]*={0,2}$/u.test(row.content)
            ? Buffer.from(row.content, 'base64')
            : undefined

        if (
          response.status !== 200 ||
          !row ||
          Object.keys(row).sort().join(',') !== 'content,generation,path,sha256' ||
          row.generation !== manifest.generation ||
          row.path !== entry.path ||
          row.sha256 !== entry.sha256 ||
          !bytes ||
          bytes.byteLength !== entry.size ||
          sha256(bytes) !== entry.sha256
        ) {
          failed = true

          return
        }

        staged.push({ path: entry.path, bytes })
      }
    }

    await Promise.all(Array.from({ length: Math.min(CLOUD_HOME_LIMITS.concurrency, entries.length) }, worker))

    return failed ? null : staged
  }

  /**
   * Saves a local file's content before the cloud's replaces it. Content-addressed, so a retry after
   * a partial commit never loses a version: the same bytes already kept are left alone, and a
   * different version goes beside the first, named by its digest. Private to the user (0700 folders,
   * 0600 files). Throws when the copy cannot be made, which stops the replacement.
   */
  private keep(agentPrincipal: string, generation: number, relative: string, bytes: Buffer): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(agentPrincipal) || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('matrix_cloud_home_invalid')
    }

    const target = path.join(this.options.backups, agentPrincipal, String(generation), ...relative.split('/'))
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    let name = target

    if (existsSync(name)) {
      if (readFileSync(name).equals(bytes)) {
        return
      }

      name = `${target}.${sha256(bytes).slice(0, 12)}`

      if (existsSync(name)) {
        return
      }
    }

    writeFileSync(name, bytes, { mode: 0o600, flag: 'wx' })
  }

  /**
   * Replaces each staged file atomically (a temp file beside it, then a rename). A local file whose
   * content differs is saved first, read again just before its own replacement so what Hermes wrote
   * while the cloud's copy was being fetched is kept too. Returns the paths kept, or false when
   * something could not be done (nothing further is replaced).
   */
  private commit(
    home: string,
    staged: ReadonlyArray<{ path: string; bytes: Buffer }>,
    backup: { agentPrincipal: string; generation: number }
  ): { kept: string[] } | false {
    for (const file of staged) {
      const target = path.join(home, file.path)

      if (!inside(home, target)) {
        return false
      }
    }

    const kept: string[] = []

    try {
      for (const file of staged) {
        const target = path.join(home, file.path)
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })

        if (
          !inside(home, path.dirname(target)) ||
          realpathSync(path.dirname(target)) !== path.join(realpathSync(home), path.dirname(file.path))
        ) {
          return false
        }

        const current = local(home, file.path)

        if (current && !current.equals(file.bytes)) {
          this.keep(backup.agentPrincipal, backup.generation, file.path, current)
          kept.push(file.path)
        }

        const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`

        try {
          // Private to the user, like the rest of the agent's home.
          writeFileSync(temporary, file.bytes, { mode: 0o600, flag: 'wx' })
          renameSync(temporary, target)
        } finally {
          rmSync(temporary, { force: true })
        }
      }
    } catch {
      return false
    }

    return { kept }
  }
}

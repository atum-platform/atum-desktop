/**
 * The Python half of a checkpoint, as the desktop runs it: `python -m hermes_cli.atum_home portable-snapshot |
 * portable-capture | portable-restore` from the bundled runtime (standard library only, no network), the same
 * invocation as the existing home export (`device/migration.ts` `exportAgentHome`, which also gives the quarantine
 * copy its full, database-consistent export).
 *
 * The tool prints one JSON line of digests; the manifest and the skipped paths are the archive's own header
 * line, which this module reads and runs through the contract's parsers again, so a capture that does not
 * follow the 2.1 grammar is refused here even if the Python side were wrong.
 *
 * `snapshot` is the one call that is a conversation instead of a command: the tool walks the home, says `ready`, waits for
 * the desktop to hold the agent's writers still and say `go`, stages the home (an APFS clone of each file, a database
 * through SQLite's backup API), and says `staged` the moment it is done, so that the writers are let go then and not when
 * the process exits. The window the writers are held for is exactly that.
 */
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'

import { exportAgentHome } from '../device/migration'

import {
  type CheckpointSkippedPath,
  isSha256,
  isUuid,
  parsePortableManifest,
  parseSkippedPaths,
  type PortableManifest,
  portableManifestDigest
} from './contract'

export interface PortableCaptureSummary {
  manifestSha256: string
  contentSha256: string
  /** The cheap change check of the home as the capture saw it (absent from a tool that predates it). */
  fingerprintSha256?: string
  /**
   * How the files the archive carries were obtained, as the archive's own header says it: `snapshot_apfs_clone` or
   * `snapshot_copy` (read from a snapshot staged while the writers were held), `stable_read` (read from a home whose
   * writers the caller had stopped).
   */
  stagedBy?: string
  includedFiles: number
  bytes: number
  archiveSha256: string
  archiveBytes: number
  skippedRows: number
  skippedPaths: number
}

export interface PortableRestoreSummary {
  homeId: string
  generation: number
  manifestSha256: string
  written: number
  unchanged: number
  removed: number
  backedUp: number
  rebound: number
}

/** The cheap answer to "has the home changed?": a digest of what a capture would read, taken without reading it. */
export interface PortableFingerprint {
  fingerprintSha256: string
  files: number
}

/** What a snapshot of the home staged: exactly what a capture of it would carry, as it was while the writers were held still. */
export interface PortableSnapshotSummary {
  /** The home's fingerprint as the snapshot's walk found it, and, because the window ended with the home still so, as it was. */
  fingerprintSha256: string
  files: number
  bytes: number
  /** `apfs_clone`: every file that is not a database was cloned (copy-on-write); `copy`: the bytes were copied. */
  method: 'apfs_clone' | 'copy'
  /** Databases staged through SQLite's backup API (a database is never copied as bytes). */
  sqliteDatabases: number
  /** How long the writers were held still, as the tool measured it. */
  heldMs: number
  /** 1 when the home was walked once; 2 when it had moved by the time the writers were held and was walked again under the hold. */
  attempts: number
}

/**
 * Hold the agent's writers still, or null when that cannot be done now (`HomeRuntimeOps.holdWrites`). Called once, when the tool
 * is ready to stage; the function returned is called the moment the tool says the window is over, or when anything goes wrong.
 */
export type HoldWrites = () => Promise<(() => void) | null>

export type HomeToolFailure = 'home_tool_failed' | 'home_tool_invalid' | 'home_tool_timeout'

/** A closed code. A tool failure carries the tool's own closed `error` when it gave one (`home_file_changed`...). */
export class HomeToolError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'HomeToolError'
  }
}

export interface HomeTool {
  /**
   * Write the portable checkpoint archive. With `snapshot` (a folder `snapshot` staged) the home is not read at all: the walk,
   * the skipped paths and every byte come from that folder, and the archive says it was made from a barrier-held snapshot.
   * Without it the home is read as it is, which is only right when the caller has stopped every writer of it.
   */
  capture(
    input: { home: string; out: string; homeId: string; generation: number; parentGeneration: number; homeEpoch: number; snapshot?: string },
    signal: AbortSignal
  ): Promise<PortableCaptureSummary>
  /**
   * Stage exactly what a capture of the home would carry into the new folder `dest`, while the agent's writers are held still.
   * The tool does all the work that does not need them held first (the walk, the grammar), asks `hold`, stages (cloning each
   * file, a database through SQLite's backup API), looks at the home once more, and tells the caller the window is over, which
   * lets the writers go. Throws `HomeToolError('home_writers_busy')` when `hold` answers null (or the home's own cron tick is
   * mid-dispatch), and `'home_changed_during_snapshot'` when a carried file was written, made, removed or replaced inside the
   * window by something the barrier could not see; nothing is left in `dest` in either case.
   */
  snapshot(input: { home: string; dest: string; hold: HoldWrites }, signal: AbortSignal): Promise<PortableSnapshotSummary>
  /** Paths, sizes and modification times of exactly what a capture would carry, as one digest: no file is opened. */
  fingerprint(input: { home: string }, signal: AbortSignal): Promise<PortableFingerprint>
  /** The whole home, `state.db` included, as one database-consistent v1.5 archive: the quarantine copy. */
  exportAll(input: { home: string; out: string }, signal: AbortSignal): Promise<{ files: number; bytes: number }>
  /** With `verifyOnly` nothing is written: the archive is read and checked, and its summary returned. */
  restore(
    input: { home: string; archive: string; backups: string; expectManifestSha256?: string; expectHomeId?: string; verifyOnly?: boolean },
    signal: AbortSignal
  ): Promise<PortableRestoreSummary>
}

export interface PythonRuntime {
  python: string
  source: string
}

const CLOSED = /^[a-z][a-z0-9_]{0,63}$/u

/** The interpreter's flags and the module the tool is: isolated from the user's site, no bytecode written. */
const TOOL_ARGS = ['-s', '-P', '-B', '-m', 'hermes_cli.atum_home'] as const

const toolEnv = (runtime: PythonRuntime) => ({
  PYTHONPATH: runtime.source,
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  LANG: 'en_US.UTF-8'
})

/** The tool prints its closed reason to stderr as {"error": code}: the last line says it. */
function toolErrorCode(stderr: string): string | undefined {
  try {
    const said = JSON.parse(stderr.trim().split('\n').pop() ?? '') as { error?: unknown }

    return typeof said.error === 'string' && CLOSED.test(said.error) ? said.error : undefined
  } catch {
    return undefined
  }
}

function runTool(runtime: PythonRuntime, args: string[], signal: AbortSignal, run: typeof execFile): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()

    const child = run(
      runtime.python,
      [...TOOL_ARGS, ...args],
      {
        cwd: runtime.source,
        env: toolEnv(runtime),
        timeout: 10 * 60_000,
        maxBuffer: 1_048_576,
        encoding: 'utf8',
        signal
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new HomeToolError(toolErrorCode(String(stderr)) ?? ((error as { killed?: boolean }).killed ? 'home_tool_timeout' : 'home_tool_failed')))

          return
        }

        try {
          const value = JSON.parse(String(stdout).trim().split('\n').pop() ?? '') as Record<string, unknown>

          if (!value || typeof value !== 'object' || value.ok !== true) {
            throw new Error('shape')
          }

          resolve(value)
        } catch {
          reject(new HomeToolError('home_tool_invalid'))
        }
      }
    )

    void child
  })
}

/** How long each stage of a snapshot may take before the tool is killed (and the writers, if they are held, let go). */
export interface SnapshotTiming {
  /** From the start of the process until it says `ready`: Python starts and walks the home. */
  readyMs: number
  /** From `ready` until `go` is sent: the desktop takes the lock and asks Hermes whether its review is over. */
  holdMs: number
  /** From `go` until the window ends: the longest the writers are ever held still. */
  windowMs: number
  /** From the window's end until the process has written its record and exited. */
  finishMs: number
}

export const SNAPSHOT_TIMING: SnapshotTiming = { readyMs: 2 * 60_000, holdMs: 20_000, windowMs: 30_000, finishMs: 60_000 }

/**
 * `portable-snapshot --hold`, as a conversation over the process's pipes. The tool prints `ready`, waits for a line on stdin
 * (`go`, or anything else to cancel), stages, prints `staged` the moment the window ends, then prints its summary and exits.
 * The writers are held from `ready` (when `hold` is called) to `staged`, and are let go on every other way out as well: the
 * process dying, the signal aborting, a stage taking too long, `hold` failing.
 */
function runSnapshot(
  runtime: PythonRuntime,
  input: { home: string; dest: string; hold: HoldWrites },
  signal: AbortSignal,
  start: typeof spawn,
  timing: SnapshotTiming
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()

    const child = start(runtime.python, [...TOOL_ARGS, 'portable-snapshot', '--home', input.home, '--dest', input.dest, '--hold'], {
      cwd: runtime.source,
      env: toolEnv(runtime),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let settled = false
    let phase: 'starting' | 'asking' | 'staging' | 'finishing' = 'starting'
    let cancelled = false
    let release: (() => void) | undefined
    let summary: Record<string, unknown> | undefined
    let said = ''
    let complained = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const letGo = () => {
      const held = release
      release = undefined
      held?.()
    }

    const settle = (finish: () => void) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      // Whatever ended it, the writers are never left held.
      letGo()
      finish()
    }

    const fail = (error: Error) => {
      if (!settled) {
        // Stopped before the writers are let go: a tool that is cloning must not outlive the hold.
        child.kill('SIGKILL')
      }

      settle(() => reject(error))
    }

    const arm = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new HomeToolError('home_tool_timeout')), ms)
      timer.unref?.()
    }

    function onAbort() {
      fail(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }

    const ask = async () => {
      let held: (() => void) | null

      try {
        held = await input.hold()
      } catch {
        fail(new HomeToolError('home_hold_failed'))

        return
      }

      if (settled) {
        held?.()

        return
      }

      if (!held) {
        // Anything but `go` cancels: the tool removes what it made and exits, and the caller is told the writers were busy.
        cancelled = true
        arm(timing.finishMs)
        child.stdin.end('stop\n')

        return
      }

      release = held
      phase = 'staging'
      arm(timing.windowMs)
      child.stdin.write('go\n')
    }

    const onLine = (line: string) => {
      if (settled || line.trim() === '') {
        return
      }

      let value: Record<string, unknown>

      try {
        value = JSON.parse(line) as Record<string, unknown>
      } catch {
        fail(new HomeToolError('home_tool_invalid'))

        return
      }

      if (value.ok !== true) {
        fail(new HomeToolError('home_tool_invalid'))
      } else if (value.phase === 'ready' && phase === 'starting') {
        phase = 'asking'
        arm(timing.holdMs)
        void ask()
      } else if (value.phase === 'staged' && phase === 'staging') {
        // The window is over: the writers go now, not when the process has finished writing its record.
        phase = 'finishing'
        letGo()
        arm(timing.finishMs)
      } else if (value.phase === undefined && phase === 'finishing') {
        summary = value
      } else {
        fail(new HomeToolError('home_tool_invalid'))
      }
    }

    signal.addEventListener('abort', onAbort, { once: true })
    arm(timing.readyMs)

    child.stdin.on('error', () => undefined)
    child.stdout.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      said += chunk

      for (let newline = said.indexOf('\n'); newline >= 0; newline = said.indexOf('\n')) {
        const line = said.slice(0, newline)
        said = said.slice(newline + 1)
        onLine(line)
      }
    })

    child.stderr.setEncoding('utf8')

    child.stderr.on('data', (chunk: string) => {
      complained = (complained + chunk).slice(-8192)
    })

    child.on('error', () => fail(new HomeToolError('home_tool_failed')))

    child.on('close', code => {
      settle(() => {
        if (cancelled) {
          reject(new HomeToolError('home_writers_busy'))
        } else if (code === 0 && phase === 'finishing' && summary) {
          resolve(summary)
        } else {
          reject(new HomeToolError(toolErrorCode(complained) ?? 'home_tool_failed'))
        }
      })
    })
  })
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const STAGED_BY = /^(snapshot_apfs_clone|snapshot_copy|stable_read)$/u

export class PythonHomeTool implements HomeTool {
  constructor(
    private readonly runtime: PythonRuntime,
    private readonly run: typeof execFile = execFile,
    private readonly start: typeof spawn = spawn,
    private readonly timing: SnapshotTiming = SNAPSHOT_TIMING
  ) {}

  async capture(
    input: { home: string; out: string; homeId: string; generation: number; parentGeneration: number; homeEpoch: number; snapshot?: string },
    signal: AbortSignal
  ): Promise<PortableCaptureSummary> {
    const value = await runTool(
      this.runtime,
      [
        'portable-capture',
        '--home',
        input.home,
        '--out',
        input.out,
        '--home-id',
        input.homeId,
        '--generation',
        String(input.generation),
        '--parent-generation',
        String(input.parentGeneration),
        '--home-epoch',
        String(input.homeEpoch),
        ...(input.snapshot ? ['--snapshot', input.snapshot] : [])
      ],
      signal,
      this.run
    )

    if (
      !isSha256(value.manifestSha256) ||
      !isSha256(value.contentSha256) ||
      (value.fingerprintSha256 !== undefined && !isSha256(value.fingerprintSha256)) ||
      (value.stagedBy !== undefined && !(typeof value.stagedBy === 'string' && STAGED_BY.test(value.stagedBy))) ||
      !isSha256(value.archiveSha256) ||
      !count(value.includedFiles) ||
      !count(value.bytes) ||
      !count(value.archiveBytes) ||
      !count(value.skippedRows) ||
      !count(value.skippedPaths)
    ) {
      throw new HomeToolError('home_tool_invalid')
    }

    return value as unknown as PortableCaptureSummary
  }

  async snapshot(input: { home: string; dest: string; hold: HoldWrites }, signal: AbortSignal): Promise<PortableSnapshotSummary> {
    const value = await runSnapshot(this.runtime, input, signal, this.start, this.timing)

    if (
      !isSha256(value.fingerprintSha256) ||
      !count(value.files) ||
      !count(value.bytes) ||
      (value.method !== 'apfs_clone' && value.method !== 'copy') ||
      !count(value.sqliteDatabases) ||
      !count(value.heldMs) ||
      !count(value.attempts) ||
      value.attempts < 1
    ) {
      throw new HomeToolError('home_tool_invalid')
    }

    return {
      fingerprintSha256: value.fingerprintSha256,
      files: value.files,
      bytes: value.bytes,
      method: value.method,
      sqliteDatabases: value.sqliteDatabases,
      heldMs: value.heldMs,
      attempts: value.attempts
    }
  }

  async fingerprint(input: { home: string }, signal: AbortSignal): Promise<PortableFingerprint> {
    const value = await runTool(this.runtime, ['portable-fingerprint', '--home', input.home], signal, this.run)

    if (!isSha256(value.fingerprintSha256) || !count(value.files)) {
      throw new HomeToolError('home_tool_invalid')
    }

    return { fingerprintSha256: value.fingerprintSha256, files: value.files }
  }

  exportAll(input: { home: string; out: string }, signal: AbortSignal): Promise<{ files: number; bytes: number }> {
    signal.throwIfAborted()

    return exportAgentHome(this.runtime, input.home, input.out, this.run)
  }

  async restore(
    input: { home: string; archive: string; backups: string; expectManifestSha256?: string; expectHomeId?: string; verifyOnly?: boolean },
    signal: AbortSignal
  ): Promise<PortableRestoreSummary> {
    const value = await runTool(
      this.runtime,
      [
        'portable-restore',
        '--home',
        input.home,
        '--archive',
        input.archive,
        '--backups',
        input.backups,
        ...(input.expectManifestSha256 ? ['--expect-manifest-sha256', input.expectManifestSha256] : []),
        ...(input.expectHomeId ? ['--expect-home-id', input.expectHomeId] : []),
        ...(input.verifyOnly ? ['--verify-only'] : [])
      ],
      signal,
      this.run
    )

    if (
      !isUuid(value.homeId) ||
      !count(value.generation) ||
      !isSha256(value.manifestSha256) ||
      !count(value.written) ||
      !count(value.unchanged) ||
      !count(value.removed) ||
      !count(value.backedUp) ||
      !count(value.rebound)
    ) {
      throw new HomeToolError('home_tool_invalid')
    }

    return value as unknown as PortableRestoreSummary
  }
}

export interface ArchiveHeader {
  manifest: PortableManifest
  skipped: CheckpointSkippedPath[]
  capturedAt: number
}

const MAX_HEADER_BYTES = 8 * 1024 * 1024

/** The first line of a plaintext portable archive, read and checked by the contract's own parsers. */
export async function readArchiveHeader(file: string): Promise<ArchiveHeader> {
  const chunks: Buffer[] = []
  let length = 0
  let line: Buffer | undefined

  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const buffer = chunk as Buffer
    const newline = buffer.indexOf(0x0a)

    if (newline >= 0) {
      chunks.push(buffer.subarray(0, newline))
      line = Buffer.concat(chunks)

      break
    }

    length += buffer.length

    if (length > MAX_HEADER_BYTES) {
      throw new HomeToolError('home_archive_invalid')
    }

    chunks.push(buffer)
  }

  if (!line) {
    throw new HomeToolError('home_archive_invalid')
  }

  let header: Record<string, unknown>

  try {
    header = JSON.parse(line.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HomeToolError('home_archive_invalid')
  }

  const manifest = parsePortableManifest(header.manifest)
  const capture = header.capture as Record<string, unknown> | undefined
  const skipped = parseSkippedPaths(capture?.skipped)

  if (header.v !== 2 || header.profile !== 'atum.agent-home/2.1' || !manifest || !skipped || !count(capture?.capturedAt)) {
    throw new HomeToolError('home_archive_invalid')
  }

  // The digest the Python side computed must be the one this side computes: both canonicalize alike.
  if (portableManifestDigest(manifest) !== manifest.manifestSha256) {
    throw new HomeToolError('home_manifest_digest_mismatch')
  }

  return { manifest, skipped, capturedAt: capture!.capturedAt as number }
}

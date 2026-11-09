import { type ChildProcess, execFile, spawn as spawnChild } from 'node:child_process'
/**
 * A single, account-scoped supervisor for the packaged local-brain provider.
 *
 * The provider is deliberately reached only over this stdio JSON-RPC boundary:
 * neither account credentials nor arbitrary executable paths cross into it.
 */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export interface MatrixLocalBrainOwner {
  accountKey: string
  /** A live Matrix-session fence. It deliberately does not name a directory. */
  generation: number
}

export const MATRIX_LOCAL_BRAIN_METHODS = [
  'brain.info',
  'brain.ingest',
  'brain.fence',
  'brain.withdraw',
  'brain.correct',
  'brain.retrieve',
  'brain.reportCoverage',
  'brain.coverage'
] as const

export interface MatrixLocalBrainOptions {
  userData: string
  resources: string
  nodePath?: string
  /** Electron's executable must opt into Node mode when it launches the provider. */
  runAsNode?: boolean
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  /** Test seam; production uses node:child_process.spawn. */
  spawn?: typeof spawnChild
  /** Code-only operational signal. Never receives child output or request data. */
  log?: (code: string) => void
}

interface ResourceContract {
  binary: string
  binarySha256: string
  cli: string
  root: string
}

interface PendingRequest {
  reject(error: Error): void
  resolve(value: unknown): void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  child: ChildProcess
  id: number
  owner: MatrixLocalBrainOwner
  pending: Map<string, PendingRequest>
  processGroup?: number
  ready: boolean
  rejectStartup(error: Error): void
  resolveStartup(): void
  startup: Promise<void>
  stopped: boolean
  stopping?: Promise<void>
  stdout: string
}

const ACCOUNT_KEY = /^[a-f0-9]{64}$/i
// Match the provider's bounded JSON-RPC transport. A valid awareness envelope
// can contain 65,536 Unicode characters, exceeding 64 KiB before JSON escaping.
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const execFileAsync = promisify(execFile)
const MAX_PENDING_REQUESTS = 128
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_STOP_TIMEOUT_MS = 2_000
// `ps -ax` must enumerate the host process table. A saturated runner can take
// longer than the one-second test stop budget even though the probe is healthy.
// Keep this bounded and fail closed, but do not turn scheduler pressure into a
// false stop failure.
const PROCESS_GROUP_PROBE_TIMEOUT_MS = 5_000

function codedError(code: string): Error {
  return new Error(code)
}

function sameOwner(left: MatrixLocalBrainOwner, right: MatrixLocalBrainOwner): boolean {
  return left.accountKey.toLowerCase() === right.accountKey.toLowerCase() && left.generation === right.generation
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback

  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) {
    throw codedError('matrix_local_brain_timeout_invalid')
  }

  return resolved
}

function assertAbsolute(value: string, code: string): string {
  if (!path.isAbsolute(value)) {
    throw codedError(code)
  }

  return path.resolve(value)
}

/** Reject symlinks rather than allowing a signed bundle path to escape its resource root. */
function assertPlainFile(file: string, code: string): void {
  let stat

  try {
    stat = lstatSync(file)
  } catch {
    throw codedError(code)
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedError(code)
  }
}

function assertPlainDirectory(directory: string, code: string): void {
  let stat

  try {
    stat = lstatSync(directory)
  } catch {
    throw codedError(code)
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError(code)
  }
}

function platformKey(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') {return 'darwin-arm64'}

  if (process.platform === 'linux' && process.arch === 'x64') {return 'linux-x64'}

  throw codedError('matrix_local_brain_platform_unsupported')
}

function readManifest(manifest: string): { bytes: number; sha256: string } {
  assertPlainFile(manifest, 'matrix_local_brain_manifest_invalid')

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    throw codedError('matrix_local_brain_manifest_invalid')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw codedError('matrix_local_brain_manifest_invalid')
  }

  const record = parsed as Record<string, unknown>

  const gbrain = record.gbrain && typeof record.gbrain === 'object'
    ? record.gbrain as Record<string, unknown>
    : undefined

  const sha256 = gbrain?.sha256
  const bytes = gbrain?.bytes

  if (record.format !== 'atum.local-brain.package/1' || record.platform !== platformKey() || record.entry !== 'src/cli.mjs'
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw codedError('matrix_local_brain_manifest_invalid')
  }

  return { bytes, sha256: sha256.toLowerCase() }
}

function pinnedBinary(pin: string): { bytes: number; sha256: string } {
  assertPlainFile(pin, 'matrix_local_brain_pin_invalid')

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(pin, 'utf8'))
  } catch {
    throw codedError('matrix_local_brain_pin_invalid')
  }

  const asset = parsed && typeof parsed === 'object'
    ? (parsed as { gbrain?: { assets?: Record<string, unknown> } }).gbrain?.assets?.[platformKey()]
    : undefined

  if (!asset || typeof asset !== 'object') {
    throw codedError('matrix_local_brain_platform_unsupported')
  }

  const { sha256, size } = asset as { sha256?: unknown; size?: unknown }

  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
    throw codedError('matrix_local_brain_pin_invalid')
  }

  return { bytes: size, sha256: sha256.toLowerCase() }
}

function validDigest(value: unknown): value is { bytes: number; sha256: string } {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as { bytes?: unknown }).bytes === 'number'
    && Number.isSafeInteger((value as { bytes: number }).bytes) && (value as { bytes: number }).bytes > 0
    && typeof (value as { sha256?: unknown }).sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test((value as { sha256: string }).sha256)
}

/** Read a final-byte receipt bound to the installed immutable pin/raw digest.
 * Source repository/commit/archive are build provenance recorded by the verified
 * staging writer and protected by the outer app seal; runtime checks their shape,
 * not correspondence to a separately embedded source lock. */
function signedBinary(receipt: string, pin: string, expected: { bytes: number; sha256: string }, pinned: { bytes: number; sha256: string }): { bytes: number; sha256: string } {
  assertPlainFile(receipt, 'matrix_local_brain_receipt_invalid')

  let parsed: unknown

  try {
    parsed = JSON.parse(readFileSync(receipt, 'utf8'))
  } catch {
    throw codedError('matrix_local_brain_receipt_invalid')
  }

  if (!parsed || typeof parsed !== 'object') {throw codedError('matrix_local_brain_receipt_invalid')}
  const record = parsed as Record<string, unknown>
  const sourceLock = record.sourceLock
  const source = sourceLock && typeof sourceLock === 'object' ? sourceLock as Record<string, unknown> : undefined
  const original = record.original
  const signed = record.signed
  const sourcePin = source?.pin
  const archive = source?.archive
  const platform = platformKey()

  if (record.format !== 'atum.local-brain.signed-binary/1' || record.platform !== platform
    || source?.schema !== 'atum.local-brain.source/1' || typeof source.repository !== 'string' || !source.repository
    || typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(source.commit)
    || typeof source.path !== 'string' || !source.path || !validDigest(sourcePin)
    || !archive || typeof archive !== 'object' || typeof (archive as { name?: unknown }).name !== 'string'
    || !(archive as { name: string }).name || !validDigest(archive)
    || !validDigest(original) || !validDigest(signed)) {
    throw codedError('matrix_local_brain_receipt_invalid')
  }

  let pinDigest: string
  let pinBytes: number

  try {
    const bytes = readFileSync(pin)
    pinBytes = bytes.length
    pinDigest = createHash('sha256').update(bytes).digest('hex')
  } catch {
    throw codedError('matrix_local_brain_receipt_invalid')
  }

  if (pinBytes !== sourcePin.bytes || pinDigest !== sourcePin.sha256.toLowerCase()
    || original.bytes !== expected.bytes || original.sha256.toLowerCase() !== expected.sha256
    || original.bytes !== pinned.bytes || original.sha256.toLowerCase() !== pinned.sha256) {
    throw codedError('matrix_local_brain_receipt_invalid')
  }

  return { bytes: signed.bytes, sha256: signed.sha256.toLowerCase() }
}

function safeEnvironment(runAsNode: boolean): NodeJS.ProcessEnv {
  // Keep only process-runtime necessities. In particular this never inherits a
  // Matrix token, provider credential, domain configuration, NODE_OPTIONS, or PATH.
  const env: NodeJS.ProcessEnv = {}

  for (const key of ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR'] as const) {
    if (process.env[key]) {
      env[key] = process.env[key]
    }
  }

  if (runAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  return env
}

function assertUnlinkedDirectoryPath(base: string, segments: string[]): void {
  let current = base

  for (const segment of ['', ...segments]) {
    if (segment) {
      current = path.join(current, segment)
    }

    try {
      const stat = lstatSync(current)

      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw codedError('matrix_local_brain_root_invalid')
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_local_brain_root_invalid') {
        throw error
      }

      return
    }
  }
}

/**
 * Supervise one local provider at a time. Calls and readiness are accepted only
 * while the exact account/session generation that started the process remains current.
 */
export class MatrixLocalBrain {
  private readonly log: (code: string) => void
  private readonly nodePath: string
  private readonly requestTimeoutMs: number
  private readonly resources: string
  private readonly runAsNode: boolean
  private readonly spawn: typeof spawnChild
  private readonly startupTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly userData: string
  private current?: Session
  /** Every provider whose process group has not yet been seen gone. */
  private readonly live = new Set<Session>()
  private intent = 0
  private nextRequestId = 0
  private nextSessionId = 0
  private pendingActivation?: { owner: MatrixLocalBrainOwner; promise: Promise<void> }
  private transitions: Promise<void> = Promise.resolve()

  constructor(options: MatrixLocalBrainOptions) {
    this.userData = assertAbsolute(options.userData, 'matrix_local_brain_user_data_invalid')
    this.resources = assertAbsolute(options.resources, 'matrix_local_brain_resources_invalid')
    this.nodePath = assertAbsolute(options.nodePath ?? process.execPath, 'matrix_local_brain_node_invalid')
    assertPlainFile(this.nodePath, 'matrix_local_brain_node_invalid')
    this.runAsNode = options.runAsNode ?? true
    this.startupTimeoutMs = boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS)
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this.stopTimeoutMs = boundedTimeout(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS)
    this.spawn = options.spawn ?? spawnChild
    this.log = options.log ?? (() => {})
  }

  /** Starts the owner-scoped provider, or stops it when Matrix has no active owner. */
  activate(owner: MatrixLocalBrainOwner | null): Promise<void> {
    if (!owner) {
      return this.stop()
    }

    this.validateOwner(owner)
    owner = { ...owner, accountKey: owner.accountKey.toLowerCase() }

    if (this.current && sameOwner(this.current.owner, owner) && !this.current.stopped) {
      return this.current.startup
    }

    if (this.pendingActivation && sameOwner(this.pendingActivation.owner, owner)) {
      return this.pendingActivation.promise
    }

    const intent = ++this.intent
    // Fence an in-flight start immediately; its queued successor still waits for
    // process cleanup, so two accounts never overlap.
    const outgoingStop = this.current ? this.stopSession(this.current) : undefined
    void outgoingStop?.catch(() => this.log('matrix_local_brain_stop_failed'))

    const promise = this.queue(async () => {
      // A successor never starts before the old account's provider and any
      // gbrain grandchild have actually left their process group.
      await outgoingStop

      if (intent !== this.intent) {
        throw codedError('matrix_local_brain_activation_superseded')
      }

      const contract = await this.resourcesFor(owner)

      if (intent !== this.intent) {
        throw codedError('matrix_local_brain_activation_superseded')
      }

      const session = this.start(owner, contract)
      this.current = session

      try {
        await session.startup
      } catch (error) {
        try {
          await this.stopSession(session)
        } catch {
          this.log('matrix_local_brain_cleanup_failed')
          throw error
        }

        if (this.current === session) {
          this.current = undefined
        }

        throw error
      }

      if (intent !== this.intent || session.stopped || this.current !== session) {
        throw codedError('matrix_local_brain_activation_superseded')
      }
    })

    this.pendingActivation = { owner: { ...owner }, promise }
    void promise.finally(() => {
      if (this.pendingActivation?.promise === promise) {
        this.pendingActivation = undefined
      }
    }).catch(() => {})

    return promise
  }

  /** True only for the exact live account/session pair. */
  ready(owner: MatrixLocalBrainOwner): boolean {
    return Boolean(this.current && !this.current.stopped && this.current.ready && sameOwner(this.current.owner, owner))
  }

  /**
   * Sends one bounded JSON-RPC call to the exact active owner. A dispatched
   * timeout has an unknown outcome: retire the provider before admitting more
   * work. An explicit activation awaits cleanup and the provider's replay gate;
   * mutating callers must retain the original operation identity for retry.
   */
  call(owner: MatrixLocalBrainOwner, method: string, params?: unknown): Promise<unknown> {
    this.validateOwner(owner)

    if (!(MATRIX_LOCAL_BRAIN_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(codedError('matrix_local_brain_method_denied'))
    }

    const session = this.current

    if (!session || session.stopped || !session.ready || !sameOwner(session.owner, owner)) {
      return Promise.reject(codedError('matrix_local_brain_unavailable'))
    }

    if (session.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(codedError('matrix_local_brain_request_limit'))
    }

    const id = String(++this.nextRequestId)
    let frame: string

    try {
      frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`
    } catch {
      return Promise.reject(codedError('matrix_local_brain_request_invalid'))
    }

    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(codedError('matrix_local_brain_request_too_large'))
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending.has(id)) {
          // The provider cannot cancel an individual request and may already
          // have fsynced its mutation. Dropping correlation while leaving it
          // usable would allow unknown work to overlap a new operation.
          this.fail(session, codedError('matrix_local_brain_request_outcome_unknown'))
        }
      }, this.requestTimeoutMs)

      const pending: PendingRequest = { resolve, reject, timer }
      session.pending.set(id, pending)

      try {
        session.child.stdin?.write(frame, error => {
          if (error) {
            this.fail(session, codedError('matrix_local_brain_write_failed'))
          }
        })
      } catch {
        this.settlePending(session, id, codedError('matrix_local_brain_write_failed'))
      }
    })
  }

  /** Stops the current provider. Late ready/RPC messages are fenced before waiting. */
  async stop(): Promise<void> {
    ++this.intent
    this.pendingActivation = undefined
    const session = this.current

    if (!session) {
      return
    }

    await this.stopSession(session)

    if (this.current === session) {
      this.current = undefined
    }
  }

  /**
   * The last line of defence at process exit: SIGKILL every provider process group
   * still alive, synchronously. The provider runs this app's own executable
   * (ELECTRON_RUN_AS_NODE) in a detached group, so nothing else would end it when the
   * main process goes, and an update installer must not find a copy still running.
   * Returns how many groups were signalled.
   */
  killNow(): number {
    let signalled = 0
    ++this.intent
    this.pendingActivation = undefined

    for (const session of this.live) {
      session.stopped = true

      try {
        if (process.platform !== 'win32' && session.processGroup) {
          process.kill(-session.processGroup, 'SIGKILL')
        } else {
          session.child.kill('SIGKILL')
        }

        signalled += 1
      } catch {
        // Already gone (ESRCH) or not ours to signal: nothing left to stop.
      }
    }

    this.live.clear()

    return signalled
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const pending = this.transitions.then(work)
    this.transitions = pending.catch(() => {})

    return pending
  }

  private async resourcesFor(owner: MatrixLocalBrainOwner): Promise<ResourceContract> {
    assertPlainDirectory(this.resources, 'matrix_local_brain_resources_invalid')
    const cli = path.join(this.resources, 'src', 'cli.mjs')
    const pin = path.join(this.resources, 'pin.json')
    const source = path.join(this.resources, 'src')
    const contractRoot = path.join(this.resources, 'contract')
    const contract = path.join(contractRoot, 'awareness-v1')
    const licenses = path.join(this.resources, 'licenses')
    const binary = path.join(this.resources, 'bin', 'gbrain')
    const binaryDirectory = path.join(this.resources, 'bin')
    const manifest = path.join(this.resources, 'MANIFEST.json')
    const receipt = path.join(this.resources, 'SIGNED-BINARY.json')
    assertPlainDirectory(source, 'matrix_local_brain_resources_invalid')
    assertPlainDirectory(contractRoot, 'matrix_local_brain_resources_invalid')
    assertPlainFile(cli, 'matrix_local_brain_resources_invalid')
    assertPlainFile(pin, 'matrix_local_brain_resources_invalid')
    assertPlainDirectory(contract, 'matrix_local_brain_resources_invalid')

    assertPlainDirectory(licenses, 'matrix_local_brain_resources_invalid')

    assertPlainDirectory(binaryDirectory, 'matrix_local_brain_resources_invalid')
    assertPlainFile(binary, 'matrix_local_brain_resources_invalid')

    // A packaged gbrain is a native executable. A regular, executable file
    // catches a wrong-platform bundle before the provider has a chance to spawn it.
    if ((statSync(binary).mode & 0o111) === 0) {
      throw codedError('matrix_local_brain_binary_invalid')
    }

    const expected = readManifest(manifest)
    const pinned = pinnedBinary(pin)
    const signed = signedBinary(receipt, pin, expected, pinned)
    let actual: string
    let bytes = 0

    try {
      const hasher = createHash('sha256')

      for await (const chunk of createReadStream(binary)) {
        bytes += chunk.length
        hasher.update(chunk)
      }

      actual = hasher.digest('hex')
    } catch {
      throw codedError('matrix_local_brain_binary_invalid')
    }

    if (bytes !== signed.bytes || actual !== signed.sha256) {
      throw codedError('matrix_local_brain_binary_invalid')
    }

    const root = path.join(this.userData, 'accounts', owner.accountKey.toLowerCase(), 'local-brain')
    assertUnlinkedDirectoryPath(this.userData, ['accounts', owner.accountKey.toLowerCase(), 'local-brain'])
    mkdirSync(root, { recursive: true, mode: 0o700 })
    assertUnlinkedDirectoryPath(this.userData, ['accounts', owner.accountKey.toLowerCase(), 'local-brain'])

    return { cli, binary, binarySha256: signed.sha256, root }
  }

  private start(owner: MatrixLocalBrainOwner, contract: ResourceContract): Session {
    let child: ChildProcess

    try {
      child = this.spawn(this.nodePath, [
        contract.cli,
        'serve',
        '--root', contract.root,
        '--binary', contract.binary,
        '--binary-sha256', contract.binarySha256
      ], {
        cwd: contract.root,
        detached: process.platform !== 'win32',
        env: safeEnvironment(this.runAsNode),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      throw codedError('matrix_local_brain_spawn_failed')
    }

    let resolveStartup!: () => void
    let rejectStartup!: (error: Error) => void

    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve
      rejectStartup = reject
    })

    let startupSettled = false
    let startupTimer!: ReturnType<typeof setTimeout>

    const settleStartup = (error?: Error) => {
      if (startupSettled) {
        return
      }

      startupSettled = true
      clearTimeout(startupTimer)

      if (error) {
        rejectStartup(error)
      } else {
        resolveStartup()
      }
    }

    const session: Session = {
      child,
      id: ++this.nextSessionId,
      owner: { ...owner },
      pending: new Map(),
      processGroup: process.platform !== 'win32' ? child.pid : undefined,
      ready: false,
      rejectStartup: error => settleStartup(error),
      resolveStartup: () => settleStartup(),
      startup,
      stopped: false,
      stdout: ''
    }

    this.live.add(session)
    startupTimer = setTimeout(() => this.fail(session, codedError('matrix_local_brain_start_timeout')), this.startupTimeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(session, chunk))
    // Drain stderr so a noisy provider cannot block itself. Its content can
    // contain user data, so it intentionally never reaches a log or error.
    child.stderr?.resume()
    child.stdin?.on('error', () => this.fail(session, codedError('matrix_local_brain_write_failed')))
    child.stdout?.on('error', () => this.fail(session, codedError('matrix_local_brain_protocol_invalid')))
    child.once('error', () => {
      // `spawn()` can emit error without an `exit` event (for example ENOENT).
      this.fail(session, codedError('matrix_local_brain_spawn_failed'))
    })
    child.once('exit', () => {
      if (!session.stopped) {
        this.fail(session, codedError('matrix_local_brain_exited'))
      }
    })

    return session
  }

  private onStdout(session: Session, text: string): void {
    if (session.stopped) {
      return
    }

    session.stdout += text

    if (Buffer.byteLength(session.stdout) > MAX_FRAME_BYTES && !session.stdout.includes('\n')) {
      this.fail(session, codedError('matrix_local_brain_frame_too_large'))

      return
    }

    let newline

    while ((newline = session.stdout.indexOf('\n')) !== -1) {
      const frame = session.stdout.slice(0, newline)
      session.stdout = session.stdout.slice(newline + 1)

      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || frame.length === 0) {
        this.fail(session, codedError('matrix_local_brain_protocol_invalid'))

        return
      }

      let message: unknown

      try {
        message = JSON.parse(frame)
      } catch {
        this.fail(session, codedError('matrix_local_brain_protocol_invalid'))

        return
      }

      this.onMessage(session, message)

      if (session.stopped) {
        return
      }
    }

    if (Buffer.byteLength(session.stdout) > MAX_FRAME_BYTES) {
      this.fail(session, codedError('matrix_local_brain_frame_too_large'))
    }
  }

  private onMessage(session: Session, message: unknown): void {
    if (!message || typeof message !== 'object') {
      this.fail(session, codedError('matrix_local_brain_protocol_invalid'))

      return
    }

    const record = message as Record<string, unknown>

    if (record.jsonrpc !== '2.0') {
      this.fail(session, codedError('matrix_local_brain_protocol_invalid'))

      return
    }

    if (record.method === 'brain.ready') {
      if (session.ready || typeof record.id !== 'undefined') {
        this.fail(session, codedError('matrix_local_brain_protocol_invalid'))
      } else {
        session.ready = true
        session.resolveStartup()
      }

      return
    }

    if (record.method === 'brain.failed') {
      this.fail(session, codedError('matrix_local_brain_failed'))

      return
    }

    if (typeof record.id !== 'string' || typeof record.method !== 'undefined') {
      this.fail(session, codedError('matrix_local_brain_protocol_invalid'))

      return
    }

    const pending = session.pending.get(record.id)

    if (!pending) {
      // A response to a timed-out/stale call cannot influence a newer owner.
      return
    }

    clearTimeout(pending.timer)
    session.pending.delete(record.id)

    if (record.error !== undefined) {
      pending.reject(codedError('matrix_local_brain_rpc_failed'))
    } else if (Object.hasOwn(record, 'result')) {
      pending.resolve(record.result)
    } else {
      pending.reject(codedError('matrix_local_brain_protocol_invalid'))
    }
  }

  private fail(session: Session, error: Error): void {
    if (session.stopped) {
      return
    }

    session.rejectStartup(error)

    for (const [id] of session.pending) {
      this.settlePending(session, id, error)
    }

    void this.stopSession(session).catch(() => this.log('matrix_local_brain_cleanup_failed'))
  }

  private settlePending(session: Session, id: string, error: Error): void {
    const pending = session.pending.get(id)

    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    session.pending.delete(id)
    pending.reject(error)
  }

  private async stopSession(session: Session): Promise<void> {
    if (session.stopping) {
      return session.stopping
    }

    session.stopped = true
    session.rejectStartup(codedError('matrix_local_brain_stopped'))

    for (const [id] of session.pending) {
      this.settlePending(session, id, codedError('matrix_local_brain_stopped'))
    }

    session.stopping = (async () => {
      try {
        session.child.stdin?.end()
      } catch {
        // The escalation below handles a process whose stdin has already gone.
      }

      if (await this.waitForGroupGone(session, this.stopTimeoutMs)) {
        this.live.delete(session)

        return
      }

      this.signal(session, 'SIGTERM')

      if (await this.waitForGroupGone(session, this.stopTimeoutMs)) {
        this.live.delete(session)

        return
      }

      this.signal(session, 'SIGKILL')

      if (!(await this.waitForGroupGone(session, this.stopTimeoutMs))) {
        throw codedError('matrix_local_brain_stop_timeout')
      }

      this.live.delete(session)
    })()

    return session.stopping
  }

  private async waitForGroupGone(session: Session, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (await this.groupAlive(session)) {
      if (Date.now() >= deadline) {
        return false
      }

      await new Promise(resolve => setTimeout(resolve, 20))
    }

    return true
  }

  private signal(session: Session, signal: NodeJS.Signals): void {
    try {
      // Detached Unix children form their own process group. This also reaps a
      // gbrain grandchild if the provider dies before it can close it itself.
      if (process.platform !== 'win32' && session.processGroup) {
        process.kill(-session.processGroup, signal)
      } else {
        session.child.kill(signal)
      }
    } catch (error) {
      if (this.isMissingProcess(error)) {
        return
      }

      throw codedError('matrix_local_brain_stop_failed')
    }
  }

  private async groupAlive(session: Session): Promise<boolean> {
    if (process.platform === 'win32' || !session.processGroup) {
      return session.child.pid !== undefined && session.child.exitCode === null
    }

    try {
      process.kill(-session.processGroup, 0)

      return true
    } catch (error) {
      if (this.isMissingProcess(error)) {
        return false
      }

      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        // An exited macOS group can deny signal-zero probes, including after
        // owner-lock refusal. Permission denial alone never proves cleanup.
        // Inspect group/state metadata only, without command lines or secrets.
        try {
          const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pgid=,stat='], {
            encoding: 'utf8', env: { LC_ALL: 'C' }, maxBuffer: 1024 * 1024, timeout: PROCESS_GROUP_PROBE_TIMEOUT_MS
          })

          const rows = stdout.trim().split('\n')

          if (!stdout.trim() || rows.some(row => !/^\s*\d+\s+\S+\s*$/.test(row))) {
            throw codedError('matrix_local_brain_stop_failed')
          }

          return rows.some(row => {
            const [group, state] = row.trim().split(/\s+/)

            return Number(group) === session.processGroup && !state.startsWith('Z')
          })
        } catch {
          throw codedError('matrix_local_brain_stop_failed')
        }
      }

      throw codedError('matrix_local_brain_stop_failed')
    }
  }

  private isMissingProcess(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ESRCH')
  }

  private validateOwner(owner: MatrixLocalBrainOwner): void {
    if (!ACCOUNT_KEY.test(owner.accountKey) || !Number.isSafeInteger(owner.generation) || owner.generation < 0) {
      throw codedError('matrix_local_brain_owner_invalid')
    }
  }
}

/**
 * Where a checkpoint's sealed bytes go, and where the data key comes from.
 *
 * Two implementations of each seam:
 *
 *  - `DirectoryArchiveStore`: real file I/O into a folder. The test home of the whole slice, and a complete store in
 *    its own right for two Macs that share a folder.
 *  - `ShellArchiveStore` / `ShellSealKeySource`: the Mac's client for the platform's owner routes, as atum-platform
 *    PR #664 builds them (branch `feat/agent-home-slice1-completion` at `cc433d9a`: `apps/shell/src/lib/agent-home-archive.ts`,
 *    `matrix-agent-home.ts`, migration 0284; the handoff is , from
 *    "Desktop handoff" item 10, and  there). The archive
 *    bytes never pass through the Shell:
 *
 *      Every call is a JSON POST with the MAS bearer, `Atum-Agent-Home-Wire: 2.1`, `Content-Type: application/json` and a
 *      body that carries a signed `meta` and a `fence` (`archive-custody.ts` signs them: the routes admit a DEVICE, the
 *      placement's Mac or the target of its one active move, and read no lease).
 *
 *      POST …/home/key                                   action HomeKeyRead, body {meta, fence}
 *           200 {v: 1, rootVersion: 1, homeId, keyId, key}: `key` is 32 bytes in unpadded base64url (43 characters) and
 *           `keyId` the 43-character unpadded base64url name of (root version, owner, agent, home), not the key's digest. This
 *           Mac recomputes that name (`agentHomeSealKeyId`, from the owner principal it is signed in as) and takes no key
 *           whose name is not exactly it. The scope is owner + agent + home, never device.
 *      POST …/home/checkpoints/{generation}/archive      the same route, three operations:
 *           begin     action CheckpointArchiveBegin     {operation: "begin", meta, fence, checkpointId, generation, byteSize}
 *                     200 {outcome: "upload", checkpointId, generation, rootVersion: 1, upload: {protocol: "tus", endpoint,
 *                     bucket, path, token, attemptId, expiresAt, chunkBytes: 6291456, headers: {x-signature, x-upsert}}}, a
 *                     90-second attempt with a server-built object path, or {outcome: "stored", …} for an upload already final.
 *           (TUS)     the sealed bytes go straight to Supabase Storage in `chunkBytes` chunks (`tus.ts`), with the returned
 *                     headers and no credential of this Mac's.
 *           finalize  action CheckpointArchiveFinalize  {operation: "finalize", meta, fence, checkpointId, generation,
 *                     byteSize, uploadToken: attemptId, archiveSha256}
 *                     200 {outcome: "stored", bytes, sha256, rootVersion: 1}: Storage's own metadata showed `byteSize`; the
 *                     digest is the one this Mac declared in its signed frame (the platform keeps no streaming digest).
 *           download  action CheckpointArchiveDownload  {operation: "download", meta, fence, generation}
 *                     200 {url, expiresAt, bytes, sha256, manifestSha256, rootVersion: 1}: a signed URL good for 90 seconds.
 *                     The Mac GETs it (no bearer), checks the byte count and the SHA-256 of what arrived against the answer,
 *                     and only then does the caller open the AEAD (home, generation) and compare the embedded manifest.
 *
 *    Refusals the platform names (`{error, details: {reason}}`; every archive 409 carries `Retry-After`):
 *      409 agent_home_archive_upload_busy         another attempt of this generation is live (its remaining seconds): wait, begin again
 *      409 agent_home_archive_conflict            the generation is not open for writing, or the attempt ended: begin again, or stop
 *      409 agent_home_archive_changed_replay      this generation holds other bytes already: this attempt is over
 *      409 agent_home_archive_upload_incomplete   Storage does not show the object yet (Retry-After 2): finalize again
 *      409 agent_home_archive_size_mismatch       Storage shows another size than declared: the bytes that arrived are not the bytes that left
 *      409 agent_home_archive_replayed            the frame was seen already (never, because every attempt signs afresh)
 *      403                                         not this Mac's to ask: neither the home nor the move's target, or a fence for another home
 *      503 not_configured                          the platform has no sealing root (key) or Storage client (archive): moves cannot finish yet
 *      503 archive_store_unavailable | binding_invalid
 *      404 (JSON)                                  no committed archive for that generation
 *    A platform that has not shipped #664 answers 404/405/501 with its framework's page (not JSON): `unsupported`.
 *
 * VERIFY when the platform half changes: this module, `archive-custody.ts`, `tus.ts`, `stub-platform.fixture.ts` and
 * `stub-storage.fixture.ts` (the fake Shell and the fake object store, which answer the same routes the same way) and
 * `archive-http.test.ts` (which runs this client over real HTTP against them) move together. The platform's tests for the
 * routes are `apps/shell/src/lib/__tests__/agent-home-archive.test.ts` and `matrix-agent-home.test.ts`.
 *
 * The archive is sealed on this Mac before it leaves (`archive-seal.ts`), so Storage holds ciphertext only. What
 * `uploadVerified` rests on is therefore: every chunk was acknowledged by Storage up to the full length, Storage's metadata
 * showed the declared size at finalize, and the platform recorded this Mac's declared digest. The digest is *checked* on
 * the way out: whoever downloads compares the byte count and SHA-256 before opening the AEAD, and the AEAD tag binds the
 * bytes to the home and generation.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { readDomainJson } from '../domain'

import { agentHomeSealKeyId, SEALING_ROOT_VERSION, type SealKey } from './archive-seal'
import { AGENT_HOME_WIRE_HEADER, AGENT_HOME_WIRE_VERSION, type HomeOperation, isSha256, isUuid } from './contract'
import { abortableSleep, trustedTusUrl, type TusOptions, tusUpload } from './tus'

export type ArchiveFailure =
  | { ok: false; kind: 'unsupported' }
  | { ok: false; kind: 'unauthorized' }
  | { ok: false; kind: 'forbidden' }
  | { ok: false; kind: 'not_found' }
  /** The generation is not open for writing (it is committed, or was never reserved), or holds other bytes already. */
  | { ok: false; kind: 'conflict' }
  /** Another upload of this generation is live on the platform: not final, try again. */
  | { ok: false; kind: 'busy' }
  /** The bytes that arrived are not the bytes that left. */
  | { ok: false; kind: 'corrupt' }
  /** The store refused the archive's size (the deployment's object limit is below it): trying again will not help. */
  | { ok: false; kind: 'too_large' }
  | { ok: false; kind: 'unavailable' }

export type ArchiveResult<T> = { ok: true; value: T } | ArchiveFailure

export interface ArchiveTarget {
  agent: string
  homeId: string
  generation: number
}

export interface HomeArchiveStore {
  /** Store the sealed file; the answer is the count and digest of the bytes the platform holds for the checkpoint. */
  put(
    input: ArchiveTarget & { checkpointId: string; file: string; manifestSha256?: string; operation?: HomeOperation },
    signal: AbortSignal
  ): Promise<ArchiveResult<{ bytes: number; sha256: string }>>
  /** Fetch the sealed bytes of a generation into `file` (new, mode 0600), checked against the platform's count and digest as they arrive. */
  get(
    input: ArchiveTarget & { file: string; operation?: HomeOperation },
    signal: AbortSignal
  ): Promise<ArchiveResult<{ bytes: number; sha256: string; manifestSha256: string | null }>>
}

export interface HomeSealKeySource {
  key(input: { agent: string; homeId: string; operation?: HomeOperation }, signal: AbortSignal): Promise<ArchiveResult<SealKey>>
}

/** What each route's signature is made under. */
export type ArchiveAction = 'HomeKeyRead' | 'CheckpointArchiveBegin' | 'CheckpointArchiveFinalize' | 'CheckpointArchiveDownload'

/**
 * The signed envelope of one call (`archive-custody.ts`): `fields` plus a `meta` and a `fence`, signed under `action`, or
 * why this Mac may not ask (it is neither the home nor the move's target, the platform cannot be read, it cannot sign).
 */
export interface ArchiveSigner {
  sign(
    call: { agent: string; homeId: string; action: ArchiveAction; operation?: HomeOperation },
    fields: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ ok: true; body: Record<string, unknown> } | ArchiveFailure>
}

const MAX_ARCHIVE_BYTES = 2_147_483_648

const sha256File = async (file: string): Promise<{ bytes: number; sha256: string }> => {
  const hash = createHash('sha256')
  let bytes = 0

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }

  return { bytes, sha256: hash.digest('hex') }
}

// ------------------------------------------------------------------------------------ a folder

/** Objects are `<root>/<homeId>/<generation>.sealed` with their manifest digest beside them, written
 * atomically. A folder cannot know a generation is committed, so it replaces what is there: the checkpoint
 * flow only writes a generation it has just reserved, and a retry of that reservation re-seals it. */
export class DirectoryArchiveStore implements HomeArchiveStore {
  constructor(private readonly root: string) {}

  private paths(target: ArchiveTarget) {
    if (!isUuid(target.homeId) || !Number.isSafeInteger(target.generation) || target.generation < 1) {
      throw new Error('agent_home_archive_invalid')
    }

    const base = path.join(this.root, target.homeId, String(target.generation))

    return { dir: path.dirname(base), object: `${base}.sealed`, meta: `${base}.meta.json` }
  }

  async put(
    input: ArchiveTarget & { checkpointId?: string; file: string; manifestSha256?: string },
    _signal?: AbortSignal
  ): Promise<ArchiveResult<{ bytes: number; sha256: string }>> {
    const { dir, object, meta } = this.paths(input)

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temporary = `${object}.${process.pid}.${Date.now()}.part`
      await copyFile(input.file, temporary)
      await rename(temporary, object)

      if (input.manifestSha256) {
        await writeFile(meta, JSON.stringify({ manifestSha256: input.manifestSha256 }), { mode: 0o600 })
      }

      return { ok: true, value: await sha256File(object) }
    } catch {
      return { ok: false, kind: 'unavailable' }
    }
  }

  async get(
    input: ArchiveTarget & { file: string },
    _signal?: AbortSignal
  ): Promise<ArchiveResult<{ bytes: number; sha256: string; manifestSha256: string | null }>> {
    const { object, meta } = this.paths(input)

    try {
      await link(object, input.file).catch(async () => copyFile(object, input.file))
      const { bytes, sha256 } = await sha256File(input.file)

      const recorded = await readFile(meta, 'utf8').then(
        text => (JSON.parse(text) as { manifestSha256?: unknown }).manifestSha256,
        () => undefined
      )

      return { ok: true, value: { bytes, sha256, manifestSha256: isSha256(recorded) ? recorded : null } }
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { ok: false, kind: 'not_found' } : { ok: false, kind: 'unavailable' }
    }
  }
}

// ------------------------------------------------------------------------------- the Shell routes

export interface ShellArchiveOptions {
  /** `account.s1Request`. */
  request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  /** Signs every call (`archive-custody.ts`). */
  signer: ArchiveSigner
  /**
   * Who the signed-in owner is: their platform principal, as the platform's own answer for this sign-in says it (null when it
   * cannot be had). The key's name is derived from it (`agentHomeSealKeyId`), so a Mac that cannot say takes no key.
   */
  ownerPrincipal(signal: AbortSignal): Promise<string | null>
  /** Test seam: the fake Shell's and the fake object store's `fetch`. */
  fetch?: typeof fetch
  now?(): number
  /** How a wait is made (tests: the fake clock moves on instead of anyone waiting). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  /** The longest an upload or a download may take in all. */
  timeoutMs?: number
  /** The TUS client's own knobs (tests: no waits between the tries at a chunk). */
  tus?: Pick<TusOptions, 'retryDelaysMs' | 'requestTimeoutMs'>
}

const ARCHIVE_TIMEOUT_MS = 10 * 60_000
const CALL_TIMEOUT_MS = 20_000
const RESPONSE_LIMIT_BYTES = 64 * 1024
/** An upload attempt lives 90 s on the platform; this Mac stops using it a little before. */
const ATTEMPT_MS = 90_000
const ATTEMPT_MARGIN_MS = 3_000
/** Attempts at begin → upload → finalize, and tries at finalize within one attempt (Storage may need a moment to show the object). */
const ATTEMPTS = 3
const FINALIZE_TRIES = 4
const DEFAULT_RETRY_WAIT_MS = 5_000
const MAX_RETRY_WAIT_MS = 120_000
const TUS_MIN_CHUNK_BYTES = 1024 * 1024
const TUS_MAX_CHUNK_BYTES = 64 * 1024 * 1024
const OBJECT_BUCKET = 'atum-messaging-v1'
const SHA256_HEX = /^[0-9a-f]{64}$/u
const B64U_43 = /^[A-Za-z0-9_-]{43}$/u

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The row has exactly these keys: the platform's schemas are all `.strict`, and so is this reading of them. */
function exactly(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(row).sort()

  return have.length === keys.length && [...keys].sort().every((key, index) => have[index] === key)
}

const wholeNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max

/** The closed reason a Shell error body names (`{error, details: {reason}}`), or null. */
function reasonOf(body: unknown): string | null {
  const details = body && typeof body === 'object' ? (body as { details?: unknown }).details : undefined
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined

  return typeof reason === 'string' ? reason : null
}

/** The platform's `Retry-After` in milliseconds when it is a sensible number of seconds. */
function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^[0-9]{1,5}$/u.test(header.trim())) {
    return null
  }

  return Math.min(Math.max(Number(header.trim()), 1), MAX_RETRY_WAIT_MS / 1000) * 1000
}

/** What an HTTP answer to one of these calls means. Pure, so the status table is tested without a network. */
export function failureOf(status: number, json: boolean, reason: string | null = null): ArchiveFailure {
  if (status === 401) {return { ok: false, kind: 'unauthorized' }}

  if (status === 403) {return { ok: false, kind: 'forbidden' }}

  // A route that is not there answers with its framework's page; an object that is not there, with JSON.
  if (status === 404) {return json ? { ok: false, kind: 'not_found' } : { ok: false, kind: 'unsupported' }}

  if (status === 405 || status === 501) {return { ok: false, kind: 'unsupported' }}

  if (status === 409) {
    // Another attempt of this generation is live: it ends (90 seconds at most) or lands; asking again is right.
    if (reason === 'agent_home_archive_upload_busy') {return { ok: false, kind: 'busy' }}

    // Storage shows another size than the one declared: the bytes that arrived are not the bytes that left.
    if (reason === 'agent_home_archive_size_mismatch') {return { ok: false, kind: 'corrupt' }}

    return { ok: false, kind: 'conflict' }
  }

  // The route exists but the platform has no sealing root or Storage client configured: a move cannot finish there yet.
  if (status === 503 && reason === 'not_configured') {return { ok: false, kind: 'unsupported' }}

  return { ok: false, kind: 'unavailable' }
}

type Call =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; failure: ArchiveFailure; reason: string | null; retryAfterMs: number | null }

/** One signed call to the Shell, shared by the store and the key source. */
class ShellCalls {
  constructor(protected readonly options: ShellArchiveOptions) {}

  protected now(): number {
    return this.options.now?.() ?? Date.now()
  }

  protected sleep(ms: number, signal: AbortSignal): Promise<void> {
    return (this.options.sleep ?? abortableSleep)(ms, signal)
  }

  protected async call(
    input: {
      agent: string
      homeId: string
      action: ArchiveAction
      operation?: HomeOperation
      route: 'key' | `checkpoints/${number}/archive`
      fields: Record<string, unknown>
    },
    signal: AbortSignal
  ): Promise<Call> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)])

    // Signed afresh for every call: the platform refuses a frame it has seen, so a retry is never a resend.
    const signed = await this.options.signer.sign(
      { agent: input.agent, homeId: input.homeId, action: input.action, ...(input.operation ? { operation: input.operation } : {}) },
      input.fields,
      bounded
    )

    if (signed.ok === false) {
      return { ok: false, failure: signed, reason: null, retryAfterMs: null }
    }

    let status = 0
    let value: unknown
    let json = false
    let retry: string | null = null

    try {
      const response = await this.options.request(
        (accessToken, resource) =>
          (this.options.fetch ?? fetch)(`${resource}/agents/${encodeURIComponent(input.agent)}/home/${input.route}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
              [AGENT_HOME_WIRE_HEADER]: AGENT_HOME_WIRE_VERSION
            },
            body: JSON.stringify(signed.body),
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: bounded
          }),
        bounded
      )

      status = response.status
      retry = response.headers.get('retry-after')
      json = Boolean(response.headers.get('content-type')?.startsWith('application/json'))

      if (json) {
        try {
          value = await readDomainJson(response, RESPONSE_LIMIT_BYTES)
        } catch {
          return { ok: false, failure: { ok: false, kind: 'unavailable' }, reason: null, retryAfterMs: null }
        }
      } else {
        // A route that is not there answers with its framework's page, not JSON.
        await response.body?.cancel().catch(() => {})
      }
    } catch (error) {
      return {
        ok: false,
        failure: { ok: false, kind: error instanceof Error && error.message === 'matrix_s1_authentication' ? 'unauthorized' : 'unavailable' },
        reason: null,
        retryAfterMs: null
      }
    }

    if (status === 200) {
      const row = record(value)

      return row ? { ok: true, value: row } : { ok: false, failure: { ok: false, kind: 'unavailable' }, reason: null, retryAfterMs: null }
    }

    const reason = reasonOf(value)

    return { ok: false, failure: failureOf(status, json, reason), reason, retryAfterMs: retryAfterMs(retry) }
  }
}

interface BeginUpload {
  kind: 'upload'
  endpoint: string
  bucket: string
  path: string
  token: string
  attemptId: string
  chunkBytes: number
  headers: Record<string, string>
}

type Begun = BeginUpload | { kind: 'stored'; bytes: number; sha256: string }

/** The answer to `begin`, read as strictly as the platform writes it, and for the checkpoint that was asked about. */
function parseBegin(value: Record<string, unknown>, expect: ArchiveTarget & { checkpointId: string }): Begun | null {
  if (value.checkpointId !== expect.checkpointId || value.generation !== expect.generation || value.rootVersion !== 1) {
    return null
  }

  if (value.outcome === 'stored') {
    return exactly(value, ['outcome', 'checkpointId', 'generation', 'bytes', 'sha256', 'rootVersion']) &&
      wholeNumber(value.bytes, MAX_ARCHIVE_BYTES) &&
      typeof value.sha256 === 'string' &&
      SHA256_HEX.test(value.sha256)
      ? { kind: 'stored', bytes: value.bytes, sha256: value.sha256 }
      : null
  }

  const upload = record(value.upload)

  if (value.outcome !== 'upload' || !exactly(value, ['outcome', 'checkpointId', 'generation', 'rootVersion', 'upload']) || !upload) {
    return null
  }

  const headers = record(upload.headers)
  // The object path is the server's, built from this very home, generation and checkpoint: anything else is not an upload for this checkpoint.
  const folder = `agent-home/v2.1/`
  const tail = `/${expect.agent}/${expect.homeId}/generations/${expect.generation}/${expect.checkpointId}.`

  if (
    !exactly(upload, ['protocol', 'endpoint', 'bucket', 'path', 'token', 'attemptId', 'expiresAt', 'chunkBytes', 'headers']) ||
    upload.protocol !== 'tus' ||
    typeof upload.endpoint !== 'string' ||
    upload.bucket !== OBJECT_BUCKET ||
    typeof upload.path !== 'string' ||
    !upload.path.startsWith(folder) ||
    !upload.path.includes(tail) ||
    !/^agent-home\/v2[.]1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/generations\/[1-9][0-9]{0,15}\/[0-9a-f-]{36}[.][0-9a-f-]{36}[.]sealed$/u.test(upload.path) ||
    typeof upload.token !== 'string' ||
    !/^[A-Za-z0-9._-]{8,4096}$/u.test(upload.token) ||
    !isUuid(upload.attemptId) ||
    !wholeNumber(upload.expiresAt) ||
    !wholeNumber(upload.chunkBytes, TUS_MAX_CHUNK_BYTES) ||
    upload.chunkBytes < TUS_MIN_CHUNK_BYTES ||
    !headers ||
    !exactly(headers, ['x-signature', 'x-upsert']) ||
    headers['x-signature'] !== upload.token ||
    headers['x-upsert'] !== 'false'
  ) {
    return null
  }

  return {
    kind: 'upload',
    endpoint: upload.endpoint,
    bucket: upload.bucket,
    path: upload.path,
    token: upload.token,
    attemptId: upload.attemptId,
    chunkBytes: upload.chunkBytes,
    headers: { 'x-signature': upload.token, 'x-upsert': 'false' }
  }
}

/** The answer to `finalize`. */
function parseStored(value: Record<string, unknown>): { bytes: number; sha256: string } | null {
  return value.outcome === 'stored' &&
    exactly(value, ['outcome', 'bytes', 'sha256', 'rootVersion']) &&
    value.rootVersion === 1 &&
    wholeNumber(value.bytes, MAX_ARCHIVE_BYTES) &&
    typeof value.sha256 === 'string' &&
    SHA256_HEX.test(value.sha256)
    ? { bytes: value.bytes, sha256: value.sha256 }
    : null
}

interface Download {
  url: string
  bytes: number
  sha256: string
  manifestSha256: string
}

/** The answer to `download`: a link this Mac will follow, and what must arrive through it. */
function parseDownload(value: Record<string, unknown>): Download | null {
  if (
    !exactly(value, ['url', 'expiresAt', 'bytes', 'sha256', 'manifestSha256', 'rootVersion']) ||
    value.rootVersion !== 1 ||
    typeof value.url !== 'string' ||
    !trustedTusUrl(value.url) ||
    !wholeNumber(value.expiresAt) ||
    !wholeNumber(value.bytes, MAX_ARCHIVE_BYTES) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_HEX.test(value.sha256) ||
    typeof value.manifestSha256 !== 'string' ||
    !SHA256_HEX.test(value.manifestSha256)
  ) {
    return null
  }

  return { url: value.url, bytes: value.bytes, sha256: value.sha256, manifestSha256: value.manifestSha256 }
}

export class ShellArchiveStore extends ShellCalls implements HomeArchiveStore {
  private signalFor(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? ARCHIVE_TIMEOUT_MS)])
  }

  private route(generation: number): `checkpoints/${number}/archive` {
    return `checkpoints/${generation}/archive`
  }

  async put(
    input: ArchiveTarget & { checkpointId: string; file: string; operation?: HomeOperation },
    signal: AbortSignal
  ): Promise<ArchiveResult<{ bytes: number; sha256: string }>> {
    if (!isUuid(input.agent) || !isUuid(input.homeId) || !isUuid(input.checkpointId) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
      return { ok: false, kind: 'forbidden' }
    }

    const bounded = this.signalFor(signal)
    let local: { bytes: number; sha256: string }

    try {
      local = await sha256File(input.file)
    } catch {
      return { ok: false, kind: 'unavailable' }
    }

    if (local.bytes < 1) {
      return { ok: false, kind: 'unavailable' }
    }

    if (local.bytes > MAX_ARCHIVE_BYTES) {
      return { ok: false, kind: 'too_large' }
    }

    const common = { agent: input.agent, homeId: input.homeId, route: this.route(input.generation), ...(input.operation ? { operation: input.operation } : {}) }
    const declared = { checkpointId: input.checkpointId, generation: input.generation, byteSize: local.bytes }

    /** What the platform says it holds, against what this Mac sealed: only the same bytes are the same checkpoint. */
    const compare = (held: { bytes: number; sha256: string }): ArchiveResult<{ bytes: number; sha256: string }> =>
      held.bytes === local.bytes && held.sha256 === local.sha256 ? { ok: true, value: held } : { ok: false, kind: 'conflict' }

    /** Why the last attempt did not end the upload; what is reported if none of them does. */
    let last: ArchiveFailure = { ok: false, kind: 'unavailable' }

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (bounded.aborted) {
        return { ok: false, kind: 'unavailable' }
      }

      // The attempt's 90 seconds are counted from before it is asked for, so the platform's clock can only be later.
      const deadline = this.now() + ATTEMPT_MS - ATTEMPT_MARGIN_MS
      const began = await this.call({ ...common, action: 'CheckpointArchiveBegin', fields: { operation: 'begin', ...declared } }, bounded)

      if (began.ok === false) {
        if (began.failure.kind === 'busy') {
          // Another attempt (an earlier try of this very upload, say) is live: it ends by itself, and then this one begins.
          last = began.failure

          if (attempt < ATTEMPTS - 1) {
            await this.sleep(began.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, bounded)
          }

          continue
        }

        return began.failure
      }

      const begun = parseBegin(began.value, input)

      if (!begun) {
        return { ok: false, kind: 'unavailable' }
      }

      // An upload already final (this Mac asked again after a crash): the same bytes are done, other bytes are another checkpoint's.
      if (begun.kind === 'stored') {
        return compare({ bytes: begun.bytes, sha256: begun.sha256 })
      }

      const uploaded = await tusUpload(
        {
          endpoint: begun.endpoint,
          headers: begun.headers,
          metadata: { bucketName: begun.bucket, objectName: begun.path, contentType: 'application/octet-stream', cacheControl: '3600' },
          file: input.file,
          size: local.bytes,
          chunkBytes: begun.chunkBytes,
          deadline,
          signal: bounded
        },
        { fetch: this.options.fetch, now: this.options.now, sleep: this.options.sleep, ...this.options.tus }
      )

      if (uploaded.ok === false) {
        if (uploaded.kind === 'too_large') {
          return { ok: false, kind: 'too_large' }
        }

        if (uploaded.kind === 'corrupt') {
          return { ok: false, kind: 'corrupt' }
        }

        if (uploaded.kind === 'aborted' || uploaded.kind === 'refused') {
          return { ok: false, kind: 'unavailable' }
        }

        // The attempt ran out of time, or the store kept failing: begin again (after the platform's attempt has ended).
        last = { ok: false, kind: 'unavailable' }

        continue
      }

      for (let tries = 0; tries < FINALIZE_TRIES; tries += 1) {
        const done = await this.call(
          {
            ...common,
            action: 'CheckpointArchiveFinalize',
            fields: { operation: 'finalize', ...declared, uploadToken: begun.attemptId, archiveSha256: local.sha256 }
          },
          bounded
        )

        if (done.ok === true) {
          const stored = parseStored(done.value)

          return stored ? compare(stored) : { ok: false, kind: 'unavailable' }
        }

        // Storage does not show the object yet: look again shortly while the attempt is alive; one that has run out is begun again.
        if (done.reason === 'agent_home_archive_upload_incomplete') {
          last = { ok: false, kind: 'unavailable' }

          if (this.now() >= deadline) {
            break
          }

          await this.sleep(done.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, bounded)

          continue
        }

        // The attempt ended under this Mac (or was replaced): begin again. Every other answer is final.
        if (done.failure.kind === 'conflict' && done.reason === 'agent_home_archive_conflict') {
          last = done.failure

          break
        }

        return done.failure
      }
    }

    return last
  }

  async get(input: ArchiveTarget & { file: string; operation?: HomeOperation }, signal: AbortSignal) {
    if (!isUuid(input.agent) || !isUuid(input.homeId) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
      return { ok: false, kind: 'forbidden' } as const
    }

    const bounded = this.signalFor(signal)

    try {
      const asked = await this.call(
        {
          agent: input.agent,
          homeId: input.homeId,
          action: 'CheckpointArchiveDownload',
          route: this.route(input.generation),
          ...(input.operation ? { operation: input.operation } : {}),
          fields: { operation: 'download', generation: input.generation }
        },
        bounded
      )

      if (asked.ok === false) {
        return asked.failure
      }

      const link = parseDownload(asked.value)

      if (!link) {
        return { ok: false, kind: 'unavailable' } as const
      }

      // The link is its own authorization: the bearer of this Mac is not for Storage, and a redirect is not followed.
      const response = await (this.options.fetch ?? fetch)(link.url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: bounded
      })

      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {})

        // The object is gone, or the link ended before it was used (ask again): neither is bytes that arrived damaged.
        return response.status === 404 ? ({ ok: false, kind: 'not_found' } as const) : ({ ok: false, kind: 'unavailable' } as const)
      }

      const declared = response.headers.get('content-length')

      if (declared !== null && Number(declared) !== link.bytes) {
        await response.body.cancel().catch(() => {})

        return { ok: false, kind: 'corrupt' } as const
      }

      // Created here or not at all: a file that is already there is not this call's to write, and not this call's to remove.
      const handle = await open(input.file, 'wx', 0o600).catch(() => null)

      if (!handle) {
        await response.body.cancel().catch(() => {})

        return { ok: false, kind: 'unavailable' } as const
      }

      const hash = createHash('sha256')
      let bytes = 0
      const sink = handle.createWriteStream()

      try {
        await pipeline(
          Readable.fromWeb(response.body as never),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              bytes += chunk.length

              // More than the platform said there is: stop reading it.
              if (bytes > link.bytes) {
                throw new Error('archive_longer_than_declared')
              }

              hash.update(chunk)
              yield chunk
            }
          },
          sink
        )
      } catch (error) {
        await rm(input.file, { force: true })

        if (error instanceof Error && error.message === 'archive_longer_than_declared') {
          return { ok: false, kind: 'corrupt' } as const
        }

        throw error
      }

      // What arrived is what the platform says it holds, to the byte and to the digest, or it is not kept.
      if (bytes !== link.bytes || hash.digest('hex') !== link.sha256) {
        await rm(input.file, { force: true })

        return { ok: false, kind: 'corrupt' } as const
      }

      return { ok: true, value: { bytes, sha256: link.sha256, manifestSha256: link.manifestSha256 } } as const
    } catch {
      return { ok: false, kind: 'unavailable' } as const
    }
  }
}

export class ShellSealKeySource extends ShellCalls implements HomeSealKeySource {
  async key(input: { agent: string; homeId: string; operation?: HomeOperation }, signal: AbortSignal): Promise<ArchiveResult<SealKey>> {
    if (!isUuid(input.agent) || !isUuid(input.homeId)) {
      return { ok: false, kind: 'forbidden' }
    }

    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS)])

    try {
      // The name the platform must give this key is worked out here, from who the owner is, before it is asked: a Mac that
      // cannot say who the owner is has nothing to check an answer against, and takes no key.
      const owner = await this.options.ownerPrincipal(bounded)

      if (!owner) {
        return { ok: false, kind: 'unavailable' }
      }

      const expected = agentHomeSealKeyId(SEALING_ROOT_VERSION, owner, input.agent, input.homeId)

      const asked = await this.call(
        {
          agent: input.agent,
          homeId: input.homeId,
          action: 'HomeKeyRead',
          route: 'key',
          ...(input.operation ? { operation: input.operation } : {}),
          fields: {}
        },
        bounded
      )

      if (asked.ok === false) {
        return asked.failure
      }

      const body = asked.value
      // 32 bytes as the platform writes them: 43 characters of unpadded base64url, nothing looser.
      const key = typeof body.key === 'string' && B64U_43.test(body.key) ? Buffer.from(body.key, 'base64url') : null

      // `keyId` names (root version, owner, agent, home) and is not the key's digest, so it cannot be checked against the
      // key. It is recomputed from the tuple and must be exactly that: a key the platform named for another owner, agent,
      // home or root version is not this home's key, whatever else is right about the answer. The seal then writes it into
      // every archive's header and opens only an archive that carries it; the AEAD tag binds the home and the generation.
      if (
        !exactly(body, ['v', 'rootVersion', 'homeId', 'keyId', 'key']) ||
        body.v !== 1 ||
        body.rootVersion !== SEALING_ROOT_VERSION ||
        body.homeId !== input.homeId ||
        body.keyId !== expected ||
        !key ||
        key.length !== 32
      ) {
        return { ok: false, kind: 'unavailable' }
      }

      return { ok: true, value: { keyId: body.keyId, key } }
    } catch {
      return { ok: false, kind: 'unavailable' }
    }
  }
}

/** A key source for tests and for a folder-shared pair: the same key for every home it is asked about. */
export class FixedSealKeySource implements HomeSealKeySource {
  constructor(private readonly sealKey: SealKey) {}

  async key(): Promise<ArchiveResult<SealKey>> {
    return { ok: true, value: this.sealKey }
  }
}

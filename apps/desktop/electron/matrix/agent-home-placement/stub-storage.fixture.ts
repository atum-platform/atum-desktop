/**
 * Test support only: the object store behind the Shell's archive routes (atum-platform #664), as the Mac talks to it
 * directly. Supabase Storage with the two uses the Shell makes of it:
 *
 *   - a resumable upload (TUS 1.0.0, creation + PATCH + HEAD) authorized by the signed upload token the Shell minted for
 *     one object path (`x-signature`, `x-upsert: false`), with the store's rule that every chunk but the last is exactly
 *     `chunkBytes` (6 MiB);
 *   - a signed download URL (`/object/sign/{bucket}/{path}?token=`) that the Shell minted for 90 seconds.
 *
 * Neither takes the Mac's bearer, so a request that carries one (or a cookie) is refused and remembered in `leaked`: the
 * tests assert it stayed empty. Nothing here knows about checkpoints, homes or signatures; the Shell stub
 * (`stub-platform.fixture.ts`) mints the tokens and asks what is stored.
 *
 * It is a `fetch`-shaped handler, so the same object answers the in-memory tests and, through a small Node adapter
 * (`http-fetch.fixture.ts`), a real socket.
 */
import { randomUUID } from 'node:crypto'

export const STORAGE_BUCKET = 'atum-messaging-v1'
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024
const UPLOAD_PATH = '/storage/v1/upload/resumable'
const SIGNED_PATH = `/storage/v1/object/sign/${STORAGE_BUCKET}/`

export interface StorageRequestLog {
  method: string
  path: string
  /** Lower-cased request headers. */
  headers: Record<string, string>
  /** Body bytes received. */
  bytes: number
  status: number
}

/** What the next PATCH does instead of storing its chunk (consumed in order). */
export type PatchFault =
  /** A status, nothing stored: a 5xx before the chunk was taken. */
  | number
  /** The connection dies and nothing is stored (the caller's fetch rejects). */
  | 'drop'
  /** The first `stored` bytes are kept, then the answer is `status`: a chunk the store took in part. */
  | { stored: number; status: number }
  /** The chunk is stored, then the connection dies before the answer: it was taken but never acknowledged. */
  | 'drop-after-store'

interface Upload {
  id: string
  path: string
  length: number
  offset: number
  chunks: Buffer[]
  token: string
}

interface Token {
  path: string
  expiresAt: number
}

export interface StubStorageOptions {
  /** `https://storage.test` or, for a real socket, `http://127.0.0.1:PORT`: read when asked, so a test can move it. */
  origin(): string
  now(): number
  /** The bytes a signed download serves for a path (a test may have damaged them); the stored object by default. */
  read?(path: string): Buffer | undefined
}

export class StubStorage {
  /** Complete objects, by path. */
  readonly objects = new Map<string, Buffer>()
  readonly log: StorageRequestLog[] = []
  /** A request that carried the Mac's bearer or a cookie. */
  readonly leaked: string[] = []
  /** The deployment's object size limit (Supabase's global one): a larger declared length is a 413. */
  maxObjectBytes = 2_147_483_648
  /** The chunk size the store insists on for every PATCH but the last. */
  chunkBytes = TUS_CHUNK_BYTES
  readonly patchFaults: PatchFault[] = []
  /** The store is down: every request answers 503. */
  down = false

  private readonly uploads = new Map<string, Upload>()
  private readonly uploadTokens = new Map<string, Token>()
  private readonly downloadTokens = new Map<string, Token>()

  constructor(private readonly options: StubStorageOptions) {}

  /** A signed upload token for one object path (the Shell's `createSignedUploadUrl`; valid for two hours). */
  mintUploadToken(path: string, ttlMs = 2 * 60 * 60_000): string {
    const token = `up.${randomUUID().replaceAll('-', '')}`
    this.uploadTokens.set(token, { path, expiresAt: this.options.now() + ttlMs })

    return token
  }

  /** A signed download token for one object path (the Shell's `createSignedUrl`, 90 seconds). */
  mintDownloadToken(path: string, ttlMs = 90_000): string {
    const token = `dl.${randomUUID().replaceAll('-', '')}`
    this.downloadTokens.set(token, { path, expiresAt: this.options.now() + ttlMs })

    return token
  }

  sizeOf(path: string): number | null {
    return this.objects.get(path)?.byteLength ?? null
  }

  /** How many resumable uploads were created. */
  get created(): number {
    return this.log.filter(entry => entry.method === 'POST' && entry.status === 201).length
  }

  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const headers = Object.fromEntries(request.headers.entries())
    const entry: StorageRequestLog = { method: request.method, path: url.pathname, headers, bytes: 0, status: 0 }
    this.log.push(entry)

    const answer = (status: number, extra: Record<string, string> = {}, body: BodyInit | null = null): Response => {
      entry.status = status

      return new Response(body, { status, headers: { 'cache-control': 'no-store', 'tus-resumable': '1.0.0', ...extra } })
    }

    // The store is not the Shell: the Mac's credentials do not belong here.
    if (headers.authorization !== undefined || headers.cookie !== undefined) {
      this.leaked.push(`${request.method} ${url.pathname}`)

      return answer(400)
    }

    if (this.down) {
      return answer(503)
    }

    if (request.method === 'GET' && url.pathname.startsWith(SIGNED_PATH)) {
      return this.download(url, answer)
    }

    if (url.pathname === UPLOAD_PATH && request.method === 'POST') {
      return this.create(request, headers, answer)
    }

    if (url.pathname.startsWith(`${UPLOAD_PATH}/`)) {
      const id = url.pathname.slice(UPLOAD_PATH.length + 1)

      if (request.method === 'HEAD') {
        return this.head(id, headers, answer)
      }

      if (request.method === 'PATCH') {
        const bytes = Buffer.from(await request.arrayBuffer())
        entry.bytes = bytes.byteLength

        return this.patch(id, headers, bytes, answer)
      }
    }

    return answer(404)
  }

  // ------------------------------------------------------------------------------------------- upload

  private create(request: Request, headers: Record<string, string>, answer: (status: number, extra?: Record<string, string>) => Response): Response {
    if (headers['tus-resumable'] !== '1.0.0') {
      return answer(412)
    }

    const token = headers['x-signature']
    const minted = token ? this.uploadTokens.get(token) : undefined

    if (!minted || minted.expiresAt <= this.options.now()) {
      return answer(401)
    }

    if (headers['x-upsert'] !== 'false') {
      return answer(400)
    }

    const length = headers['upload-length']

    if (!length || !/^[1-9][0-9]{0,15}$/u.test(length)) {
      return answer(400)
    }

    if (Number(length) > this.maxObjectBytes) {
      return answer(413)
    }

    const metadata = parseMetadata(headers['upload-metadata'] ?? '')

    // The signed token is for one object: the metadata must name it, in the bucket the Shell named.
    if (metadata.bucketName !== STORAGE_BUCKET || metadata.objectName !== minted.path || !metadata.contentType) {
      return answer(403)
    }

    const id = randomUUID()
    this.uploads.set(id, { id, path: minted.path, length: Number(length), offset: 0, chunks: [], token: token! })

    return answer(201, { location: `${this.options.origin()}${UPLOAD_PATH}/${id}`, 'upload-offset': '0' })
  }

  private head(id: string, headers: Record<string, string>, answer: (status: number, extra?: Record<string, string>) => Response): Response {
    const upload = this.uploads.get(id)

    if (!upload) {
      return answer(404)
    }

    if (headers['x-signature'] !== upload.token) {
      return answer(401)
    }

    return answer(200, { 'upload-offset': String(upload.offset), 'upload-length': String(upload.length) })
  }

  private patch(id: string, headers: Record<string, string>, bytes: Buffer, answer: (status: number, extra?: Record<string, string>) => Response): Response {
    const upload = this.uploads.get(id)

    if (!upload) {
      return answer(404)
    }

    if (headers['x-signature'] !== upload.token) {
      return answer(401)
    }

    if (headers['tus-resumable'] !== '1.0.0') {
      return answer(412)
    }

    if (headers['content-type'] !== 'application/offset+octet-stream') {
      return answer(415)
    }

    if (headers['upload-offset'] !== String(upload.offset)) {
      return answer(409)
    }

    const fault = this.patchFaults.shift()

    if (fault === 'drop') {
      throw new TypeError('fetch failed')
    }

    if (typeof fault === 'number') {
      return answer(fault)
    }

    if (fault && typeof fault === 'object') {
      this.take(upload, bytes.subarray(0, fault.stored))

      return answer(fault.status)
    }

    const remaining = upload.length - upload.offset

    // Every chunk but the last is exactly the size the store insists on; none may run past the declared length.
    if (bytes.byteLength > remaining || bytes.byteLength !== Math.min(this.chunkBytes, remaining) || bytes.byteLength < 1) {
      return answer(400)
    }

    this.take(upload, bytes)

    if (fault === 'drop-after-store') {
      throw new TypeError('fetch failed')
    }

    return answer(204, { 'upload-offset': String(upload.offset) })
  }

  private take(upload: Upload, bytes: Buffer): void {
    if (bytes.byteLength === 0) {
      return
    }

    upload.chunks.push(Buffer.from(bytes))
    upload.offset += bytes.byteLength

    if (upload.offset === upload.length) {
      this.objects.set(upload.path, Buffer.concat(upload.chunks))
    }
  }

  // ----------------------------------------------------------------------------------------- download

  private download(url: URL, answer: (status: number, extra?: Record<string, string>, body?: BodyInit | null) => Response): Response {
    const path = decodeURIComponent(url.pathname.slice(SIGNED_PATH.length))
    const token = url.searchParams.get('token')
    const minted = token ? this.downloadTokens.get(token) : undefined

    if (!minted || minted.path !== path || minted.expiresAt <= this.options.now()) {
      return answer(400)
    }

    const served = this.options.read?.(path) ?? this.objects.get(path)

    if (!served) {
      return answer(404)
    }

    return answer(200, { 'content-type': 'application/octet-stream', 'content-length': String(served.byteLength) }, new Uint8Array(served))
  }
}

/** `Upload-Metadata`: `key base64(value)` pairs, comma separated. */
function parseMetadata(header: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ')

    if (key && value !== undefined) {
      out[key] = Buffer.from(value, 'base64').toString('utf8')
    }
  }

  return out
}

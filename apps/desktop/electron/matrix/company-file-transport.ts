import { createHash } from 'node:crypto'

import { MATRIX_COMPANY_FILE_MAX_BYTES, type MatrixCompanyFileRef } from '../../shared/matrix-company-files'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const TRANSFER_TIMEOUT_MS = 120_000

export class MatrixCompanyFileTransportError extends Error {
  constructor(readonly code: 'invalid' | 'denied' | 'unavailable' | 'version_conflict' | 'cancelled') {
    super(`matrix_company_file_${code}`)
  }
}

function fail(code: MatrixCompanyFileTransportError['code']): never {
  throw new MatrixCompanyFileTransportError(code)
}

function endpoint(serverUrl: string, fileId: string, download = false): URL {
  let origin: URL
  try {
    origin = new URL(serverUrl)
  } catch {
    return fail('invalid')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !UUID.test(fileId)
  ) {
    return fail('invalid')
  }
  return new URL(`/atum/company-files/${fileId}${download ? '/revisions/1' : ''}`, origin)
}

function endpointV2(serverUrl: string, fileId: string, download = false): URL {
  let configured: URL

  try {
    configured = new URL(serverUrl)
  } catch {
    return fail('invalid')
  }

  const local = configured.hostname === '127.0.0.1' || configured.hostname === 'localhost'

  if ((configured.protocol !== 'https:' && !(local && configured.protocol === 'http:')) ||
      configured.username || configured.password || configured.search || configured.hash || !UUID.test(fileId)) {
    return fail('invalid')
  }

  return new URL(`/atum/company-files/v2/${fileId}${download ? '/revisions/1' : ''}`, configured.origin)
}

function grant(value: string, expiresAtMs: number): void {
  if (!TOKEN.test(value) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
    fail('denied')
  }
}

function mediaType(value: string | null): string | undefined {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase()

  return type && /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,63}$/u.test(type) ? type : undefined
}

async function bytes(response: Response, maximum: number, exact?: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum ||
      (exact !== undefined && Number(declared) !== exact))) {
    await response.body?.cancel()
    return fail('version_conflict')
  }
  if (!response.body) {
    return exact === 0 ? new Uint8Array() : fail('unavailable')
  }
  const output = exact === undefined ? [] as Uint8Array[] : [new Uint8Array(exact)]
  let size = 0
  try {
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += part.byteLength
      if (size > maximum || (exact !== undefined && size > exact)) {
        await response.body.cancel()
        return fail('version_conflict')
      }
      if (exact === undefined) {
        output.push(part)
      } else {
        output[0]!.set(part, size - part.byteLength)
      }
    }
  } catch (error) {
    if (error instanceof MatrixCompanyFileTransportError) {
      throw error
    }
    return fail('unavailable')
  }
  if (exact !== undefined) {
    return size === exact ? output[0]! : fail('version_conflict')
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const part of output) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

async function status(response: Response): Promise<never> {
  await response.body?.cancel()
  return fail(response.status === 400 ? 'invalid'
    : response.status === 401 || response.status === 403 ? 'denied'
      : response.status === 409 ? 'version_conflict' : 'unavailable')
}

export async function uploadCompanyFile(
  input: {
    serverUrl: string
    file: MatrixCompanyFileRef
    nativeGrant: string
    expiresAtMs: number
    bytes: Uint8Array
  },
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<void> {
  grant(input.nativeGrant, input.expiresAtMs)
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.file.size ||
      input.bytes.byteLength > MATRIX_COMPANY_FILE_MAX_BYTES || !SHA256.test(input.file.sha256) ||
      createHash('sha256').update(input.bytes).digest('hex') !== input.file.sha256) {
    fail('invalid')
  }
  signal.throwIfAborted()
  const body = input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength
  ) as ArrayBuffer
  let response: Response
  try {
    response = await request(endpoint(input.serverUrl, input.file.file_id), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${input.nativeGrant}`,
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(input.bytes.byteLength)
      },
      body,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)])
    })
  } catch {
    return fail(signal.aborted ? 'cancelled' : 'unavailable')
  }
  if (response.status !== 200) {
    return status(response)
  }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    return fail('unavailable')
  }
  const payload = await bytes(response, 4_096)
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload).toString('utf8'))
  } catch {
    return fail('unavailable')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).join(',') !== 'state' || Reflect.get(value, 'state') !== 'ready') {
    fail('unavailable')
  }
}

export async function downloadCompanyFile(
  input: {
    serverUrl: string
    file: MatrixCompanyFileRef
    nativeGrant: string
    expiresAtMs: number
  },
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<Uint8Array> {
  grant(input.nativeGrant, input.expiresAtMs)
  signal.throwIfAborted()
  let response: Response
  try {
    response = await request(endpoint(input.serverUrl, input.file.file_id, true), {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.nativeGrant}`, Accept: input.file.content_type },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)])
    })
  } catch {
    return fail(signal.aborted ? 'cancelled' : 'unavailable')
  }
  if (response.status !== 200) {
    return status(response)
  }
  if (mediaType(response.headers.get('content-type')) !== input.file.content_type.toLowerCase() ||
      response.headers.get('x-atum-company-file-sha256') !== input.file.sha256) {
    await response.body?.cancel()
    return fail('version_conflict')
  }
  const result = await bytes(response, input.file.size, input.file.size)
  if (createHash('sha256').update(result).digest('hex') !== input.file.sha256) {
    fail('version_conflict')
  }
  return result
}

function opaqueGrantV2(value: string, expiresAtMs?: number): void {
  if (!UUID.test(value) || expiresAtMs !== undefined &&
      (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())) {
    fail('denied')
  }
}

/** 1.2 ingress upload: the opaque upload session is rechecked against the live audience before bytes are accepted. */
export async function uploadCompanyFileV2(
  input: { serverUrl: string; file: MatrixCompanyFileRef; uploadSessionId: string; bytes: Uint8Array },
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<void> {
  opaqueGrantV2(input.uploadSessionId)
  if (input.file.v !== 2 || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.file.size ||
      input.bytes.byteLength > MATRIX_COMPANY_FILE_MAX_BYTES || !SHA256.test(input.file.sha256) ||
      createHash('sha256').update(input.bytes).digest('hex') !== input.file.sha256) {
    fail('invalid')
  }
  signal.throwIfAborted()
  let response: Response
  try {
    response = await request(endpointV2(input.serverUrl, input.file.file_id), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${input.uploadSessionId}`, Accept: 'application/json',
        'Content-Type': 'application/octet-stream', 'Content-Length': String(input.bytes.byteLength) },
      body: input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer,
      redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)])
    })
  } catch {
    return fail(signal.aborted ? 'cancelled' : 'unavailable')
  }
  if (response.status !== 200) {
    return status(response)
  }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    return fail('unavailable')
  }
  const payload = await bytes(response, 4_096)
  try {
    const value = JSON.parse(Buffer.from(payload).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'schemaVersion,state' || value.schemaVersion !== 2 ||
        value.state !== 'uploaded') {
      fail('unavailable')
    }
  } catch (error) {
    if (error instanceof MatrixCompanyFileTransportError) {
      throw error
    }
    fail('unavailable')
  }
}

/** 1.2 ingress download: every call presents a newly minted audience-scoped grant. */
export async function downloadCompanyFileV2(
  input: { serverUrl: string; file: MatrixCompanyFileRef; downloadGrantId: string; expiresAtMs: number },
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<Uint8Array> {
  opaqueGrantV2(input.downloadGrantId, input.expiresAtMs)
  if (input.file.v !== 2) {
    fail('invalid')
  }
  signal.throwIfAborted()
  let response: Response
  try {
    response = await request(endpointV2(input.serverUrl, input.file.file_id, true), {
      method: 'GET', headers: { Authorization: `Bearer ${input.downloadGrantId}`, Accept: input.file.content_type },
      redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)])
    })
  } catch {
    return fail(signal.aborted ? 'cancelled' : 'unavailable')
  }
  if (response.status !== 200) {
    return status(response)
  }
  if (mediaType(response.headers.get('content-type')) !== input.file.content_type.toLowerCase() ||
      response.headers.get('x-atum-company-file-sha256') !== input.file.sha256) {
    await response.body?.cancel()
    return fail('version_conflict')
  }
  const result = await bytes(response, input.file.size, input.file.size)
  if (createHash('sha256').update(result).digest('hex') !== input.file.sha256) {
    fail('version_conflict')
  }
  return result
}

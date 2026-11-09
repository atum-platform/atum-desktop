/**
 * A minimal TUS 1.0.0 client, for one job: put a sealed archive into Supabase Storage with the credentials the Shell
 * minted for it (atum-platform #664, `apps/shell/src/lib/agent-home-archive.ts` `begin`). `tus-js-client` is not in this
 * workspace and the part of the protocol this needs is three verbs, so there is no dependency:
 *
 *   POST  endpoint   Upload-Length, Upload-Metadata (bucketName, objectName, contentType, cacheControl)   -> 201 Location
 *   PATCH location   Upload-Offset, one chunk of exactly `chunkBytes` (the last may be shorter)           -> 204 Upload-Offset
 *   HEAD  location   what the server holds, after a failure or an answer that does not add up              -> 200 Upload-Offset
 *
 * Only what the Shell returned is sent: its two headers (`x-signature`, `x-upsert`) on every request and the TUS protocol's
 * own. Never this Mac's bearer, never a cookie. Redirects are refused, and the endpoint must be https (or plain http on
 * this very machine, which is what a test's server is): the upload credential is not given to anyone else. The server's
 * `Location` must be on the endpoint's own origin.
 *
 * It does not decide anything about the checkpoint. It uploads a file or says why it could not, in closed words:
 *
 *   expired      the attempt's deadline passed (the Shell's upload attempt lives 90 s): start over from `begin`
 *   too_large    the store refused the size (413): the deployment's object limit is below this archive
 *   refused      the store said no to the credential, the request or the protocol: not worth repeating
 *   unavailable  the store could not be reached, or kept failing: another attempt may do
 *   corrupt      the file is not the size it was declared to be, or the store holds another length than was sent
 *   aborted      the caller stopped it
 */
import { open } from 'node:fs/promises'

export const TUS_VERSION = '1.0.0'

/** What an upload needs; `deadline` is in the caller's clock (`options.now`). */
export interface TusUpload {
  endpoint: string
  /** Sent on every request, exactly as the Shell returned them. */
  headers: Readonly<Record<string, string>>
  metadata: Readonly<Record<string, string>>
  file: string
  size: number
  chunkBytes: number
  deadline: number
  signal: AbortSignal
}

export interface TusOptions {
  fetch?: typeof fetch
  now?(): number
  /** Waits between the tries at one chunk (ends early when the signal does). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  /** Tries at one chunk are `retryDelaysMs.length`, each after its delay. */
  retryDelaysMs?: readonly number[]
  /** The longest one request may take, within the deadline. */
  requestTimeoutMs?: number
}

export type TusFailure = 'expired' | 'too_large' | 'refused' | 'unavailable' | 'corrupt' | 'aborted'

export type TusResult = { ok: true; chunks: number; requests: number } | { ok: false; kind: TusFailure; status?: number }

const DEFAULT_RETRY_DELAYS_MS = [0, 500, 2_000] as const
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** The credential goes only to https, or to http on this machine. */
export function trustedTusUrl(value: string): URL | null {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.username || url.password || url.hash) {
    return null
  }

  const here = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'

  return url.protocol === 'https:' || (url.protocol === 'http:' && here) ? url : null
}

/** `Upload-Metadata`: `key base64(value)` pairs, comma separated. */
export function encodeTusMetadata(metadata: Readonly<Record<string, string>>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',')
}

/** A wait that a signal ends early, and that never rejects: the caller looks at the signal itself. */
export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal.aborted || ms <= 0) {
      resolve()

      return
    }

    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done, { once: true })
    timer.unref?.()
  })

/** A non-negative whole number from a header, or null. */
function headerNumber(response: Response, name: string): number | null {
  const raw = response.headers.get(name)

  return raw !== null && /^[0-9]{1,16}$/u.test(raw.trim()) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}

class Stop extends Error {
  constructor(readonly result: Extract<TusResult, { ok: false }>) {
    super(result.kind)
  }
}

export async function tusUpload(input: TusUpload, options: TusOptions = {}): Promise<TusResult> {
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const endpoint = trustedTusUrl(input.endpoint)

  if (
    !endpoint ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    !Number.isSafeInteger(input.chunkBytes) ||
    input.chunkBytes < 1
  ) {
    return { ok: false, kind: 'refused' }
  }

  let requests = 0

  /** One request, bounded by the caller's signal and by what is left of the deadline. A failure to get an answer throws `Stop` or returns null. */
  const request = async (
    method: 'POST' | 'PATCH' | 'HEAD',
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array<ArrayBuffer>
  ): Promise<Response | null> => {
    if (input.signal.aborted) {
      throw new Stop({ ok: false, kind: 'aborted' })
    }

    const left = input.deadline - now()

    if (left <= 0) {
      throw new Stop({ ok: false, kind: 'expired' })
    }

    requests += 1

    try {
      return await send(url, {
        method,
        headers: { ...input.headers, 'Tus-Resumable': TUS_VERSION, ...headers },
        ...(body ? { body } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(Math.min(requestTimeout, left))])
      })
    } catch {
      if (input.signal.aborted) {
        throw new Stop({ ok: false, kind: 'aborted' })
      }

      if (now() >= input.deadline) {
        throw new Stop({ ok: false, kind: 'expired' })
      }

      // The network, a timeout or a refused redirect: no answer.
      return null
    }
  }

  const drop = async (response: Response) => {
    await response.body?.cancel().catch(() => undefined)
  }

  /** What a status that is not a success means for the upload. */
  const refusal = (status: number): Stop => {
    if (status === 413) {
      return new Stop({ ok: false, kind: 'too_large', status })
    }

    if (status >= 500 || status === 408 || status === 429) {
      return new Stop({ ok: false, kind: 'unavailable', status })
    }

    return new Stop({ ok: false, kind: 'refused', status })
  }

  const transient = (status: number | null): boolean => status === null || status >= 500 || status === 408 || status === 429

  try {
    // ---------------------------------------------------------------------------------------- creation
    const created = await request('POST', endpoint.toString(), {
      'Upload-Length': String(input.size),
      'Upload-Metadata': encodeTusMetadata(input.metadata)
    })

    if (!created) {
      return { ok: false, kind: 'unavailable' }
    }

    if (created.status !== 201) {
      await drop(created)

      throw refusal(created.status)
    }

    await drop(created)

    let location: URL

    try {
      location = new URL(created.headers.get('location') ?? '', endpoint)
    } catch {
      return { ok: false, kind: 'refused' }
    }

    // The credential follows the Location only if it stays where the Shell sent it.
    if (location.origin !== endpoint.origin || !trustedTusUrl(location.toString())) {
      return { ok: false, kind: 'refused' }
    }

    // ------------------------------------------------------------------------------------- what the store holds
    /** The offset the store holds, or null when it cannot say. */
    const held = async (): Promise<number | null> => {
      const head = await request('HEAD', location.toString(), {})

      if (!head) {
        return null
      }

      await drop(head)

      if (head.status === 404 || head.status === 410) {
        throw new Stop({ ok: false, kind: 'unavailable', status: head.status })
      }

      const length = headerNumber(head, 'upload-length')
      const offset = headerNumber(head, 'upload-offset')

      if (head.status !== 200 || offset === null || offset > input.size || (length !== null && length !== input.size)) {
        return null
      }

      return offset
    }

    // ------------------------------------------------------------------------------------------- the chunks
    const handle = await open(input.file, 'r')

    try {
      let offset = 0
      let chunks = 0

      while (offset < input.size) {
        const length = Math.min(input.chunkBytes, input.size - offset)
        const chunk = new Uint8Array(length)
        const { bytesRead } = await handle.read(chunk, 0, length, offset)

        // The file is not the size it was declared to be.
        if (bytesRead !== length) {
          return { ok: false, kind: 'corrupt' }
        }

        let landed = false

        for (let attempt = 0; attempt < Math.max(1, delays.length) && !landed; attempt += 1) {
          if (attempt > 0) {
            await sleep(delays[attempt] ?? 0, input.signal)

            // Where does the store think we are? A chunk that was taken but not acknowledged is not sent twice.
            const actual = await held()

            if (actual === null) {
              continue
            }

            if (actual !== offset) {
              if (actual > offset && actual < offset + length) {
                // A part of it landed: carry on from there, in the next round of the loop.
                offset = actual
                landed = true

                break
              }

              if (actual === offset + length) {
                offset = actual
                chunks += 1
                landed = true

                break
              }

              // The store is somewhere this file cannot account for.
              return { ok: false, kind: 'corrupt' }
            }
          }

          const response = await request('PATCH', location.toString(), {
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream'
          }, chunk)

          if (!response) {
            continue
          }

          const status = response.status
          await drop(response)

          if (status === 204 || status === 200) {
            const next = headerNumber(response, 'upload-offset')

            if (next === null || next <= offset || next > offset + length) {
              // An acknowledgement that does not add up: ask the store where it is.
              continue
            }

            chunks += next === offset + length ? 1 : 0
            offset = next
            landed = true

            break
          }

          if (status === 409) {
            // Offset mismatch: the store is not where this Mac thought. The next try asks.
            continue
          }

          if (!transient(status)) {
            throw refusal(status)
          }
        }

        if (!landed) {
          return { ok: false, kind: 'unavailable' }
        }
      }

      return { ok: true, chunks, requests }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Stop) {
      return error.result
    }

    return { ok: false, kind: 'unavailable' }
  }
}

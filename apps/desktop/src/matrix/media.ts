import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-wasm'
import { type IContent, type MatrixClient, Method } from 'matrix-js-sdk'

import { MATRIX_MAX_FILE_BYTES, MATRIX_MEDIA_TIMEOUT_MS, matrixAttachmentMsgtype } from '../../shared/matrix'
import { MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES } from '../../shared/matrix-room-shared'

/**
 * One download/decrypt path for Save and the trusted invocation reader. An encrypted file
 * (`file`) is decrypted. A plain one (`url`) is taken as downloaded, and only when the caller
 * says the event arrived as plaintext in a room without encryption (`plain`): in an encrypted
 * room a file must be an encrypted one (no downgrade).
 */
export async function downloadMatrixAttachment(
  client: MatrixClient,
  content: IContent,
  options: { plain?: boolean } = {}
) {
  const file = content.file
  const url: unknown = file ? file.url : options.plain ? content.url : undefined

  if (!matrixAttachmentMsgtype(content.msgtype) || typeof url !== 'string') {
    throw new Error('matrix_file_unavailable')
  }

  const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(url)

  if (!match) {
    throw new Error('matrix_file_unavailable')
  }

  const blob = await client.http.authedRequest<Blob>(
    Method.Get,
    `/media/download/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`,
    undefined,
    undefined,
    { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: MATRIX_MEDIA_TIMEOUT_MS }
  )

  const bytes = new Uint8Array(await blob.arrayBuffer())

  if (bytes.byteLength > MATRIX_MAX_FILE_BYTES) {
    throw new Error('matrix_file_invalid')
  }

  const name =
    typeof content.filename === 'string'
      ? content.filename
      : typeof content.body === 'string'
        ? content.body
        : 'attachment'

  if (!file) {
    return { name, bytes }
  }

  const encrypted = new EncryptedAttachment(bytes, JSON.stringify(file))

  try {
    return { name, bytes: Attachment.decrypt(encrypted) }
  } finally {
    encrypted.free()
  }
}

/** Keep SDK auth/refresh; bound media and explicit read/moderation requests, not sync. */
export function boundedMatrixFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    // A homeserver may be mounted below a configured path prefix. Thumbnails (the info panel's
    // pictures) get the smaller thumbnail cap; downloads the file cap.
    const thumbnail = url.pathname.includes('/_matrix/client/v1/media/thumbnail/')
    const media = thumbnail || url.pathname.includes('/_matrix/client/v1/media/download/')
    const maxBytes = thumbnail ? MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES : MATRIX_MAX_FILE_BYTES
    // read_markers consults /versions first. Bound both, including response body
    // consumption, without shortening the SDK's long-poll /sync requests.
    const read = url.pathname.endsWith('/read_markers') || url.pathname.endsWith('/_matrix/client/versions')

    const moderation =
      url.pathname.endsWith('/account_data/m.ignored_user_list') ||
      /\/rooms\/[^/]+\/(ban|unban|report\/[^/]+)$/.test(url.pathname)

    const response = await fetcher(input, {
      ...init,
      redirect: 'error',
      ...(media || read || moderation
        ? {
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(media ? MATRIX_MEDIA_TIMEOUT_MS : 10000)
            ])
          }
        : {})
    })

    if (!media || !response.ok || !response.body) {
      return response
    }

    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel()
      throw new Error('matrix_file_invalid')
    }

    const reader = response.body.getReader()
    let size = 0

    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read()

            if (part.done) {
              controller.close()

              return
            }

            size += part.value.byteLength

            if (size > maxBytes) {
              await reader.cancel()
              throw new Error('matrix_file_invalid')
            }

            controller.enqueue(part.value)
          } catch (error) {
            controller.error(error)
          }
        },
        cancel: reason => reader.cancel(reason)
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers }
    )
  }
}

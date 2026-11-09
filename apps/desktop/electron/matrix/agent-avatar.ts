import { MATRIX_PROFILE_PHOTO_MAX_BYTES, matrixProfilePhotoType, type MatrixProfilePhotoType } from '../../shared/matrix-profile'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const UUID_VALUE = new RegExp(`^${UUID}$`, 'iu')
const PRODUCTION_ORIGIN = 'https://public-config.example.invalid'
const LOCAL_ORIGINS = new Set(['http://127.0.0.1:54321', 'http://localhost:54321'])
const CONTENT_TYPE = new Set<MatrixProfilePhotoType>(['image/jpeg', 'image/png', 'image/webp'])
const EXTENSION: Record<MatrixProfilePhotoType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export interface MatrixAgentAvatarReference {
  assistantId: string
  url: string
}

export interface MatrixAgentAvatarFetchOptions {
  allowLocal?: boolean
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface MatrixAgentAvatarTarget {
  avatarUrl: string | null
  closed: boolean
}

type AvatarReader = (
  reference: MatrixAgentAvatarReference,
  options?: MatrixAgentAvatarFetchOptions
) => Promise<string | null>

export function matrixAgentAvatarDataUrl(type: MatrixProfilePhotoType, bytes: Uint8Array): string {
  if (bytes.byteLength < 1 || bytes.byteLength > MATRIX_PROFILE_PHOTO_MAX_BYTES || matrixProfilePhotoType(bytes) !== type) {
    throw new Error('matrix_agent_avatar_invalid')
  }

  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Project canonical public avatar bytes into the local/data-only renderer CSP. The renderer never
 * supplies this URL: main reads it from the owner-fenced assistant roster, then pins the canonical
 * bucket/path shape and expected assistant segment before making a credential-free request.
 */
export async function readMatrixAgentAvatar(
  reference: MatrixAgentAvatarReference,
  options: MatrixAgentAvatarFetchOptions = {}
): Promise<string | null> {
  try {
    if (!UUID_VALUE.test(reference.assistantId)) {return null}

    const url = new URL(reference.url)
    const local = options.allowLocal === true && LOCAL_ORIGINS.has(url.origin)

    const suffix = new RegExp(
      `^/storage/v1/object/public/atum-avatars-v1/assistants/principals/${UUID}/${reference.assistantId}/${UUID}\\.(?:jpg|png|webp)$`,
      'iu'
    )

    if (
      (url.origin !== PRODUCTION_ORIGIN && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !suffix.test(url.pathname)
    ) {
      return null
    }

    const response = await (options.fetch ?? fetch)(url, {
      credentials: 'omit',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000)
    })

    const rawType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const type = CONTENT_TYPE.has(rawType as MatrixProfilePhotoType) ? rawType as MatrixProfilePhotoType : undefined
    const announced = Number(response.headers.get('content-length'))

    if (
      !response.ok ||
      !type ||
      !url.pathname.endsWith(`.${EXTENSION[type]}`) ||
      (Number.isFinite(announced) && announced > MATRIX_PROFILE_PHOTO_MAX_BYTES)
    ) {
      await response.body?.cancel().catch(() => {})

      return null
    }

    const reader = response.body?.getReader()

    if (!reader) {return null}

    const chunks: Uint8Array[] = []
    let length = 0

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {break}

        length += value.byteLength

        if (length > MATRIX_PROFILE_PHOTO_MAX_BYTES) {return null}

        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    return matrixAgentAvatarDataUrl(type, Buffer.concat(chunks))
  } catch {
    return null
  }
}

/** One runtime's canonical source and CSP-safe projection. Source replacement aborts the old
 * request, and its identity is checked again when the promise settles before anything publishes. */
export class MatrixAgentAvatarProjection<T extends MatrixAgentAvatarTarget> {
  private readonly reads = new WeakMap<T, {
    source: string
    controller?: AbortController
    pending?: Promise<string | null>
  }>()

  constructor(private readonly options: {
    allowLocal?: boolean
    changed(target: T): void
    read?: AvatarReader
  }) {}

  project(
    target: T,
    assistantId: string,
    source: string | null,
    uploaded?: { type: MatrixProfilePhotoType; bytes: Uint8Array }
  ): void {
    const previous = this.reads.get(target)

    if (!source) {
      previous?.controller?.abort()
      this.reads.delete(target)
      target.avatarUrl = null

      return
    }

    if (uploaded) {
      previous?.controller?.abort()

      try {
        target.avatarUrl = matrixAgentAvatarDataUrl(uploaded.type, uploaded.bytes)
        this.reads.set(target, { source })

        return
      } catch {
        // The platform write already succeeded. Re-read its canonical immutable object instead
        // of reporting a failed save whose next roster reconciliation would then appear to fix.
      }
    }

    if (previous?.source === source && (previous.pending || target.avatarUrl?.startsWith('data:image/'))) {return}

    previous?.controller?.abort()
    target.avatarUrl = null
    const controller = new AbortController()
    const read = this.options.read ?? readMatrixAgentAvatar
    const pending = read(
      { assistantId, url: source },
      { allowLocal: this.options.allowLocal, signal: controller.signal }
    ).catch(() => null)

    this.reads.set(target, { source, controller, pending })
    void pending.then(photo => {
      const active = this.reads.get(target)

      if (target.closed || active?.source !== source || active.pending !== pending) {return}
      if (photo) {
        this.reads.set(target, { source })
        target.avatarUrl = photo
        this.options.changed(target)
      } else {
        // A transient download failure retries on the next roster reconciliation.
        this.reads.delete(target)
      }
    })
  }

  forget(target: T): void {
    this.reads.get(target)?.controller?.abort()
    this.reads.delete(target)
  }
}

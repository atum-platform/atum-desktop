import type { AppDescriptor } from '../../shared/app-catalog'

import { assetDigest, type DigestAssetCache, DigestAssetDiskCache } from './digest-asset-cache'

const MIME_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const

type IconMime = keyof typeof MIME_EXTENSIONS

const MAX_ICON_BYTES = 131072
const DIGEST = /^[a-f0-9]{64}$/u

export const APP_ICON_FETCH = {
  /** One attempt, headers and body; a slow, lossy link needs far more than a fast one. */
  timeoutMs: 20_000,
  /** Waits before the second, third and fourth attempts. */
  backoffMs: [1_000, 3_000, 9_000]
} as const

export const APP_ICON_CACHE_LIMITS = { maxEntries: 256, maxBytes: 8 * 1024 * 1024 } as const

/** Digest-checked icon bytes this account already fetched once, keyed by the catalog's SHA-256. */
export interface AppIconCache {
  read(sha256: string): Promise<{ mime: string; bytes: Buffer } | null>
  write(sha256: string, mime: string, bytes: Buffer): Promise<void>
}

export interface AppIconOptions {
  cache?: AppIconCache | null
  /** False once nobody needs this icon any more (catalog changed, signed out): stop retrying. */
  wanted?(): boolean
  sleep?(ms: number): Promise<void>
}

const isIconMime = (value: string | undefined): value is IconMime =>
  Boolean(value && Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, value))

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

const pause = (ms: number) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

type Attempt = { outcome: 'ok'; mime: IconMime; bytes: Buffer } | { outcome: 'retry' } | { outcome: 'refused' }

/** A server or link that may answer next time; anything else (4xx, wrong type, digest) is final. */
const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500

/** One attempt's deadline (headers and body both count), on the ordinary timer clock. */
function deadline(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()

  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms
  )

  timer.unref?.()

  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function fetchOnce(url: string, sha256: string): Promise<Attempt> {
  const limit = deadline(APP_ICON_FETCH.timeoutMs)

  try {
    return await fetchWithin(url, sha256, limit.signal)
  } finally {
    limit.clear()
  }
}

async function fetchWithin(url: string, sha256: string, signal: AbortSignal): Promise<Attempt> {
  let response: Response

  try {
    response = await fetch(url, { redirect: 'error', credentials: 'omit', signal })
  } catch {
    return { outcome: 'retry' }
  }

  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()

  if (!response.ok || !isIconMime(mime)) {
    await response.body?.cancel().catch(() => {})

    return { outcome: !response.ok && retryableStatus(response.status) ? 'retry' : 'refused' }
  }

  const reader = response.body?.getReader()

  if (!reader) {
    return { outcome: 'refused' }
  }

  const chunks: Uint8Array[] = []
  let length = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      length += value.byteLength

      if (length > MAX_ICON_BYTES) {
        return { outcome: 'refused' }
      }

      chunks.push(value)
    }
  } catch {
    // The link dropped or the attempt timed out mid-body.
    return { outcome: 'retry' }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const bytes = Buffer.concat(chunks)

  return assetDigest(bytes) === sha256 ? { outcome: 'ok', mime, bytes } : { outcome: 'refused' }
}

/** Reuse the registry's bundled-asset URL/digest. Renderer CSP stays local/data
 * only. Never send a domain bearer/cookie, follow redirects or fetch provider URLs.
 * An icon this account fetched once is served from its disk cache with no network;
 * otherwise a slow link gets a long timeout and a few retries. Failures are never cached. */
export async function appIcon(
  icon: AppDescriptor['icon'],
  resource: string,
  options: AppIconOptions = {}
): Promise<string | null> {
  try {
    if (!icon) {
      return null
    }

    const asset = new URL(icon.url)
    const origin = new URL(resource).origin

    // The production launch issuer supplies bundled assets on this stable
    // alias of the same Shell project. No other cross-origin asset is admitted.
    const productionAlias =
      origin === 'https://api.atumplatform.com' && asset.origin === 'https://deployment.example.invalid'

    if (
      asset.protocol !== 'https:' ||
      asset.username ||
      asset.password ||
      asset.hash ||
      (asset.origin !== origin && !productionAlias) ||
      !DIGEST.test(icon.sha256)
    ) {
      return null
    }

    const cached = await options.cache?.read(icon.sha256).catch(() => null)

    if (cached) {
      return dataUrl(cached.mime, cached.bytes)
    }

    const sleep = options.sleep ?? pause

    for (let attempt = 0; ; attempt++) {
      const result = await fetchOnce(icon.url, icon.sha256)

      if (result.outcome === 'ok') {
        await options.cache?.write(icon.sha256, result.mime, result.bytes).catch(() => {})

        return dataUrl(result.mime, result.bytes)
      }

      const wait = APP_ICON_FETCH.backoffMs[attempt]

      if (result.outcome === 'refused' || wait === undefined || options.wanted?.() === false) {
        return null
      }

      await sleep(wait)

      if (options.wanted?.() === false) {
        return null
      }
    }
  } catch {
    return null
  }
}

/**
 * Icons on disk under `root/<accountKey>/<sha256>.<ext>`: content-addressed, re-verified against
 * the digest on every read (a damaged file is removed and fetched again), written atomically, and
 * kept to the most recently used `maxEntries` / `maxBytes` per account. Only successes are written.
 */
export class AppIconDiskCache {
  private readonly cache: DigestAssetDiskCache

  constructor(root: string, limits: { maxEntries: number; maxBytes: number } = APP_ICON_CACHE_LIMITS) {
    this.cache = new DigestAssetDiskCache(root, {
      mimeExtensions: MIME_EXTENSIONS,
      maxAssetBytes: MAX_ICON_BYTES,
      ...limits
    })
  }

  /** This account's cache, or null for a key that is not a SHA-256 hex digest. */
  forAccount(accountKey: string): AppIconCache | null {
    return this.cache.forAccount(accountKey) as DigestAssetCache | null
  }
}

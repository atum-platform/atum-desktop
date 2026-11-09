import type { LookPackAssetVariant, LookPackPublished } from '../../shared/look-pack'
import { lookPackAssets, preferredLookVariant } from '../../shared/look-pack'

import { assetDigest, type DigestAssetCache, DigestAssetDiskCache } from './digest-asset-cache'

const MIME_EXTENSIONS = { 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/png': 'png' } as const
const DIGEST = /^[a-f0-9]{64}$/u
const MAX_LOOK_ASSET_BYTES = 1_500_000

export const LOOK_ASSET_CACHE_LIMITS = { maxEntries: 512, maxBytes: 64 * 1024 * 1024 } as const

export class LookAssetDiskCache {
  private readonly cache: DigestAssetDiskCache

  constructor(root: string, limits: { maxEntries: number; maxBytes: number } = LOOK_ASSET_CACHE_LIMITS) {
    this.cache = new DigestAssetDiskCache(root, {
      mimeExtensions: MIME_EXTENSIONS,
      maxAssetBytes: MAX_LOOK_ASSET_BYTES,
      ...limits
    })
  }

  forAccount(accountKey: string): DigestAssetCache | null {
    return this.cache.forAccount(accountKey)
  }
}

const coordinateAttributes = new Set([
  'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'offset', 'fx', 'fy', 'fr'
])
const allowedElements = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'title', 'desc', 'defs',
  'linearGradient', 'radialGradient', 'stop', 'clipPath'
])
const allowedAttributes = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  'points', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'id',
  'clip-path', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity', 'fx', 'fy',
  'fr'
])

function roundedCoordinates(value: string): string {
  return value.replace(/-?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?/gu, token => {
    const number = Number(token)

    if (!Number.isFinite(number)) {
      return token
    }

    const rounded = Math.round(number * 10) / 10

    if (Object.is(rounded, -0)) {
      return '0'
    }

    const decimals = token.toLowerCase().split('e')[0]!.split('.')[1]?.length ?? 0

    return decimals <= 1 && !/[eE]/u.test(token)
      ? token.replace(/^\./u, '0.').replace(/^-\./u, '-0.')
      : String(rounded)
  })
}

function xmlEscape(value: string) {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function xmlDecode(value: string): string | null {
  if (/&(?!amp;|quot;|apos;|lt;|gt;|#\d+;|#x[0-9a-fA-F]+;)/u.test(value)) {
    return null
  }

  return value.replace(/&(amp|quot|apos|lt|gt);|&#(\d+);|&#x([0-9a-fA-F]+);/gu, (_all, named, decimal, hex) => {
    if (named) {
      return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[named]!
    }

    const scalar = Number.parseInt(decimal ?? hex, hex ? 16 : 10)

    return scalar <= 0x10ffff && !(scalar >= 0xd800 && scalar <= 0xdfff)
      ? String.fromCodePoint(scalar)
      : '\uFFFD'
  })
}

function findTagEnd(source: string, start: number): number {
  let quote = ''

  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]!

    if (quote) {
      if (character === quote) {
        quote = ''
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }

  return -1
}

/** The frozen L0 re-serialising SVG allowlist, repeated defensively in main. */
export function sanitiseLookSvg(input: Uint8Array): Buffer | null {
  let source: string

  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/u, '')
  } catch {
    return null
  }

  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    return null
  }

  const output: string[] = []
  const stack: string[] = []
  let metadataDepth = 0
  let offset = 0
  let rootWidth: number | null = null
  let rootHeight: number | null = null
  let rootViewBox: number[] | null = null
  let pathCommands = 0

  while (offset < source.length) {
    const opening = source.indexOf('<', offset)

    if (opening < 0) {
      if (metadataDepth === 0 && source.slice(offset).trim() !== '') {
        return null
      }

      break
    }

    const content = source.slice(offset, opening)

    if (metadataDepth === 0 && content !== '') {
      const parent = stack.at(-1)

      if (parent === 'title' || parent === 'desc') {
        output.push(xmlEscape(xmlDecode(content) ?? content))
      } else if (content.trim() !== '') {
        return null
      }
    }

    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4)

      if (end < 0) {
        return null
      }

      offset = end + 3
      continue
    }

    if (source.startsWith('<?', opening)) {
      const end = source.indexOf('?>', opening + 2)

      if (end < 0 || opening !== 0 || !/^<\?xml\s/iu.test(source.slice(opening, end + 2))) {
        return null
      }

      offset = end + 2
      continue
    }

    if (source.startsWith('<!', opening)) {
      return null
    }

    const end = findTagEnd(source, opening)

    if (end < 0) {
      return null
    }

    const raw = source.slice(opening + 1, end)
    const closing = raw.startsWith('/')
    const selfClosing = !closing && /\/\s*$/u.test(raw)
    const body = (closing ? raw.slice(1) : raw.replace(/\/\s*$/u, '')).trim()
    const nameMatch = /^([A-Za-z][A-Za-z0-9]*)/u.exec(body)

    if (!nameMatch) {
      return null
    }

    const name = nameMatch[1]!

    if (closing) {
      if (metadataDepth > 0) {
        metadataDepth--
      } else {
        if (stack.pop() !== name) {
          return null
        }

        output.push(`</${name}>`)
      }

      offset = end + 1
      continue
    }

    if (metadataDepth > 0 || name === 'metadata') {
      if (!selfClosing) {
        metadataDepth++
      }

      offset = end + 1
      continue
    }

    if (
      !allowedElements.has(name) ||
      (stack.length === 0 && name !== 'svg') ||
      (stack.length > 0 && name === 'svg')
    ) {
      return null
    }

    let rest = body.slice(name.length)
    const attributes: Array<[string, string]> = []
    const seen = new Set<string>()

    while (rest.trim() !== '') {
      rest = rest.trimStart()
      const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])/u.exec(rest)

      if (!match) {
        return null
      }

      const attribute = match[1]!
      const quote = match[2]!
      const valueStart = match[0]!.length
      const valueEnd = rest.indexOf(quote, valueStart)

      if (valueEnd < 0 || seen.has(attribute)) {
        return null
      }

      const encoded = rest.slice(valueStart, valueEnd)
      rest = rest.slice(valueEnd + 1)
      seen.add(attribute)

      if (attribute.startsWith('xmlns:')) {
        continue
      }

      if (
        /^on/iu.test(attribute) ||
        attribute === 'href' ||
        attribute === 'xlink:href' ||
        attribute.includes(':') ||
        !allowedAttributes.has(attribute)
      ) {
        return null
      }

      const decoded = xmlDecode(encoded)

      if (decoded === null || decoded.includes('<')) {
        return null
      }

      if (attribute === 'xmlns' && (name !== 'svg' || decoded !== 'http://www.w3.org/2000/svg')) {
        return null
      }

      for (const reference of decoded.matchAll(/url\(([^)]+)\)/giu)) {
        if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(reference[1]!.trim())) {
          return null
        }
      }

      const value = coordinateAttributes.has(attribute) ? roundedCoordinates(decoded) : decoded

      if (
        ['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(attribute) &&
        (!/^\d+(?:\.\d+)?$/u.test(value) || Number(value) < 0 || Number(value) > 1)
      ) {
        return null
      }

      if (attribute === 'id' && !/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value)) {
        return null
      }

      if (attribute === 'd') {
        pathCommands += (value.match(/[AaCcHhLlMmQqSsTtVvZz]/gu) ?? []).length
      }

      if (name === 'svg' && attribute === 'width' && /^\d+(?:\.\d+)?$/u.test(value)) {
        rootWidth = Number(value)
      }

      if (name === 'svg' && attribute === 'height' && /^\d+(?:\.\d+)?$/u.test(value)) {
        rootHeight = Number(value)
      }

      if (name === 'svg' && attribute === 'viewBox') {
        const parts = value.trim().split(/[ ,]+/u).map(Number)

        if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
          rootViewBox = parts
        }
      }

      attributes.push([attribute, value])
    }

    output.push(
      `<${name}${attributes.map(([attribute, value]) => ` ${attribute}="${xmlEscape(value)}"`).join('')}${selfClosing ? '/>' : '>'}`
    )

    if (!selfClosing) {
      stack.push(name)
    }

    offset = end + 1
  }

  const width = rootWidth ?? rootViewBox?.[2] ?? 0
  const height = rootHeight ?? rootViewBox?.[3] ?? 0
  const bytes = Buffer.from(output.join(''), 'utf8')

  return metadataDepth === 0 &&
    stack.length === 0 &&
    output.length > 0 &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= 4096 &&
    height <= 4096 &&
    bytes.byteLength <= 192 * 1024 &&
    pathCommands <= 20_000
    ? bytes
    : null
}

async function responseBytes(response: Response, maximum: number): Promise<Buffer | null> {
  const reader = response.body?.getReader()

  if (!reader) {
    return null
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

      if (length > maximum) {
        return null
      }

      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => {})
  }

  return Buffer.concat(chunks)
}

/** One immutable, descriptor-pinned fetch. A mismatch or unsafe SVG is final. */
export async function fetchLookAsset(
  resource: string,
  variant: LookPackAssetVariant,
  cache?: DigestAssetCache | null
): Promise<{ mime: string; bytes: Buffer } | null> {
  try {
    if (!DIGEST.test(variant.sha256) || variant.bytes > MAX_LOOK_ASSET_BYTES) {
      return null
    }

    const cached = await cache?.read(variant.sha256).catch(() => null)

    if (cached?.mime === variant.mime && cached.bytes.byteLength === variant.bytes) {
      if (variant.mime !== 'image/svg+xml' || sanitiseLookSvg(cached.bytes)?.equals(cached.bytes)) {
        return cached
      }
    }

    const response = await fetch(`${resource.replace(/\/$/u, '')}/look-assets/${variant.sha256}`, {
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000)
    })
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()

    if (!response.ok || mime !== variant.mime) {
      await response.body?.cancel().catch(() => {})

      return null
    }

    const bytes = await responseBytes(response, Math.min(MAX_LOOK_ASSET_BYTES, variant.bytes))

    if (!bytes || bytes.byteLength !== variant.bytes || assetDigest(bytes) !== variant.sha256) {
      return null
    }

    if (variant.mime === 'image/svg+xml') {
      const sanitised = sanitiseLookSvg(bytes)

      if (!sanitised?.equals(bytes) || assetDigest(sanitised) !== variant.sha256) {
        return null
      }
    }

    await cache?.write(variant.sha256, variant.mime, bytes).catch(() => {})

    return { mime: variant.mime, bytes }
  } catch {
    return null
  }
}

/** Active-account allowlist and lazy protocol source. */
export class MatrixLookAssets {
  private accountKey: string | null = null
  private revision = 0
  private readonly variants = new Map<string, LookPackAssetVariant>()
  private readonly reads = new Map<string, Promise<{ mime: string; bytes: Buffer } | null>>()

  constructor(
    private readonly resource: string,
    private readonly cache: LookAssetDiskCache
  ) {}

  adopt(accountKey: string, packs: readonly LookPackPublished[]): void {
    this.accountKey = accountKey
    this.revision++
    this.variants.clear()
    this.reads.clear()

    for (const pack of packs) {
      for (const asset of lookPackAssets(pack)) {
        for (const variant of asset.variants) {
          const previous = this.variants.get(variant.sha256)

          if (!previous || (previous.mime === variant.mime && previous.bytes === variant.bytes)) {
            this.variants.set(variant.sha256, variant)
          } else {
            // One digest cannot describe two byte contracts.
            this.variants.delete(variant.sha256)
          }
        }
      }
    }
  }

  reset(): void {
    this.accountKey = null
    this.revision++
    this.variants.clear()
    this.reads.clear()
  }

  read(sha256: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const accountKey = this.accountKey
    const variant = this.variants.get(sha256)

    if (!accountKey || !variant || !DIGEST.test(sha256)) {
      return Promise.resolve(null)
    }

    const joined = this.reads.get(sha256)

    if (joined) {
      return joined
    }

    const revision = this.revision
    const read = fetchLookAsset(this.resource, variant, this.cache.forAccount(accountKey)).then(result =>
      this.accountKey === accountKey && this.revision === revision ? result : null
    )
    this.reads.set(sha256, read)

    void read.finally(() => {
      if (this.reads.get(sha256) === read) {
        this.reads.delete(sha256)
      }
    })

    return read
  }

  /** Roster packs warm their desktop full variant; gallery thumbs remain lazy until the sheet paints them. */
  prefetchFull(packs: readonly LookPackPublished[]): void {
    const digests = new Set<string>()

    for (const pack of packs) {
      for (const asset of lookPackAssets(pack)) {
        const variant = preferredLookVariant(asset)

        if (variant) {
          digests.add(variant.sha256)
        }
      }
    }

    void Promise.all([...digests].map(sha256 => this.read(sha256)))
  }
}

import { parseDiscoveryLink } from './discovery-links'
import { parseMatrixInviteLinkPaste } from './matrix-invite-link'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */

export const MATRIX_LINK_PREVIEW_IPC = { read: 'matrix:link-previews:read' } as const

/** What one card shows. Every field is display text from the linked page, bounded here. */
export interface MatrixLinkPreview {
  url: string
  /** The page's host without `www.`, for when it names no site. */
  host: string
  siteName?: string
  title?: string
  description?: string
  /** The page's picture, downloaded through authenticated media, as a `data:image/…` URL. */
  image?: string
}

export interface MatrixLinkPreviewBridge {
  /** One message's preview; null when it has none, the room is encrypted, or the read failed. */
  read(roomId: string, eventId: string): Promise<MatrixLinkPreview | null>
}

export const MATRIX_LINK_PREVIEW_URL_MAX = 2048
export const MATRIX_LINK_PREVIEW_IMAGE_MAX = 4_000_000
const TITLE_MAX = 300
const DESCRIPTION_MAX = 600
const SITE_MAX = 100
const DAY_MS = 86_400_000

/** The cache's day: a preview is asked for at most once per link per UTC day. */
export function matrixLinkPreviewDay(now: number): number {
  return Math.floor(now / DAY_MS)
}

export function matrixLinkPreviewKey(url: string, now: number): string {
  return `${url}\n${matrixLinkPreviewDay(now)}`
}

/** Code (fenced or inline) and Markdown images are not links to preview: blank them out, keeping offsets. */
function withoutCodeAndImages(body: string): string {
  const blank = (value: string) => value.replace(/[^\n]/gu, ' ')

  return body
    .replace(/```[\s\S]*?(?:```|$)/gu, blank)
    .replace(/~~~[\s\S]*?(?:~~~|$)/gu, blank)
    .replace(/`[^`\n]*`/gu, blank)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, blank)
}

const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/giu
const TRAILING = /[.,;:!?*_~'">]+$/u

/** A link as typed, without the sentence punctuation after it or a closing bracket it does not open. */
function trimmed(raw: string): string {
  let value = raw

  for (;;) {
    const before = value
    value = value.replace(TRAILING, '')

    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      if (value.endsWith(close) && value.split(open).length < value.split(close).length) {
        value = value.slice(0, -1)
      }
    }

    if (value === before) {
      return value
    }
  }
}

/** A web address a server may be asked to preview: plain http(s), no credentials, a real host. */
function previewable(value: string): string | null {
  if (value.length > MATRIX_LINK_PREVIEW_URL_MAX) {
    return null
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname.includes('.')) {
    return null
  }

  // Atum's own links: an invite carries a bearer token that must never reach a fetcher, and a
  // discovery link already opens its own place in the app.
  if (parseMatrixInviteLinkPaste(value) || parseDiscoveryLink(value)) {
    return null
  }

  url.hash = ''

  return url.href
}

/** The first web link in a message's text worth a preview card, or null. */
export function matrixFirstPreviewLink(body: unknown): string | null {
  if (typeof body !== 'string' || !body) {
    return null
  }

  for (const match of withoutCodeAndImages(body).matchAll(CANDIDATE)) {
    const url = previewable(trimmed(match[0]))

    if (url) {
      return url
    }
  }

  return null
}

/** Visible text only: no control characters, whitespace collapsed, bounded. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim()

  if (!clean) {
    return undefined
  }

  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

export function matrixLinkPreviewHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return ''
  }
}

/** The page's picture as the server stored it (`og:image`, an `mxc://` URI), or null. */
export function matrixLinkPreviewImageMxc(og: unknown): string | null {
  const value = og && typeof og === 'object' ? (og as Record<string, unknown>)['og:image'] : undefined

  return typeof value === 'string' && /^mxc:\/\/[^/\s?#]+\/[^/\s?#]+$/u.test(value) ? value : null
}

/**
 * A card from the server's Open Graph answer. Null when there is nothing a card can say: neither a
 * title nor a picture (a bare host line is not worth the space).
 */
export function matrixLinkPreviewFromOpenGraph(
  url: string,
  og: unknown,
  image?: string | null
): MatrixLinkPreview | null {
  const record = og && typeof og === 'object' ? (og as Record<string, unknown>) : {}
  const host = matrixLinkPreviewHost(url)
  const siteName = text(record['og:site_name'], SITE_MAX)
  const title = text(record['og:title'], TITLE_MAX)
  const description = text(record['og:description'], DESCRIPTION_MAX)
  const picture = typeof image === 'string' && validImage(image) ? image : undefined

  if (!host || (!title && !picture)) {
    return null
  }

  return {
    url,
    host,
    ...(siteName && siteName.toLowerCase() !== host.toLowerCase() ? { siteName } : {}),
    ...(title ? { title } : {}),
    ...(description && description !== title ? { description } : {}),
    ...(picture ? { image: picture } : {})
  }
}

function validImage(value: string): boolean {
  return /^data:image\/(?:png|jpeg|webp|gif);base64,/u.test(value) && value.length <= MATRIX_LINK_PREVIEW_IMAGE_MAX
}

/** Native's check of what its SDK answered, before the window sees it. */
export function matrixLinkPreviewResult(value: unknown): MatrixLinkPreview | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const url = typeof record.url === 'string' ? previewable(record.url) : null

  if (!url || url !== record.url) {
    return null
  }

  return matrixLinkPreviewFromOpenGraph(
    url,
    { 'og:site_name': record.siteName, 'og:title': record.title, 'og:description': record.description },
    typeof record.image === 'string' ? record.image : null
  )
}

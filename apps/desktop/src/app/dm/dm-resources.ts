/**
 * Hosted-DM attachments → openable resources.
 *
 * A DM attachment is untrusted, third-party data: it arrives from the hosted
 * plane, authored by a specialist (Moon, Andy) or another account. This module
 * is the only place that decides what an attachment *is* and whether the app
 * will host it, so both questions have one tested answer.
 *
 * Two rules define the security posture:
 *
 * 1. **https only.** A DM can never point the app at `file:`, `data:`,
 *    `javascript:`, or a local path. Nothing here can be turned into a local
 *    file read.
 * 2. **Origin-restricted panel hosting.** Only hosts on `PANEL_ORIGIN_ALLOWLIST`
 *    are rendered inside the app's preview webview (which itself already runs
 *    sandboxed, context-isolated, no-node, on the `persist:hermes-preview`
 *    partition). Every other https resource stays openable — but in the user's
 *    own browser, outside the app's window and session partition.
 */

export type DmResourceKind = 'document' | 'image' | 'page' | 'file'

export interface DmResource {
  /** Stable key for React and for de-duplication within one message. */
  id: string
  kind: DmResourceKind
  mimeType: null | string
  name: string
  sizeBytes: null | number
  /** The https URL the card opens. */
  url: string
}

/**
 * Hosts whose content may render inside the app's own panel.
 *
 * Deliberately short and explicit. Adding a specialist's embed host is a
 * reviewed, one-line change; forgetting to add one degrades gracefully to the
 * external browser rather than failing closed on the user.
 */
export const PANEL_ORIGIN_ALLOWLIST: readonly string[] = [
  // The prod hosted plane (both hostnames, plus the historical vercel.app one
  // older builds still bake) and its Supabase storage — where desktop-path
  // attachments are served from today.
  'api.atumplatform.com',
  'account.atumplatform.com',
  'deployment.example.invalid',
  '*.supabase.co',
  '*.supabase.in'
]

const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

const DOCUMENT_EXTENSIONS = new Set([
  '.csv',
  '.doc',
  '.docx',
  '.htm',
  '.html',
  '.md',
  '.markdown',
  '.pdf',
  '.txt',
  '.xls',
  '.xlsx'
])

function readString(source: Record<string, unknown>, keys: readonly string[]): null | string {
  for (const key of keys) {
    const value = source[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function readSize(source: Record<string, unknown>, keys: readonly string[]): null | number {
  for (const key of keys) {
    const value = source[key]
    const parsed = typeof value === 'string' ? Number(value) : value

    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed)
    }
  }

  return null
}

function extensionOf(value: string): string {
  const clean = value.split(/[?#]/, 1)[0] || value
  const tail = clean.split(/[\\/]/).filter(Boolean).pop() || clean
  const index = tail.lastIndexOf('.')

  return index > 0 ? tail.slice(index).toLowerCase() : ''
}

function fileNameFromUrl(url: string): null | string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname.split('/').filter(Boolean).pop()

    return tail ? decodeURIComponent(tail) : parsed.host
  } catch {
    return null
  }
}

function resourceKind(declared: null | string, mimeType: null | string, name: string, url: string): DmResourceKind {
  const hint = (declared ?? '').toLowerCase()

  if (hint === 'image' || hint === 'document' || hint === 'page' || hint === 'file') {
    return hint
  }

  if (mimeType?.startsWith('image/')) {
    return 'image'
  }

  if (mimeType === 'text/html' || hint === 'embed' || hint === 'link' || hint === 'url') {
    return 'page'
  }

  if (mimeType && (mimeType.startsWith('text/') || mimeType.includes('pdf') || mimeType.includes('officedocument'))) {
    return 'document'
  }

  const extension = extensionOf(name) || extensionOf(url)

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return 'document'
  }

  // No extension at all on an https path reads as a hosted page (a Moon embed
  // URL), not as an unknown blob.
  return extension ? 'file' : 'page'
}

/** https-only. Anything else is not a resource this app will open, at all. */
function safeResourceUrl(value: null | string): null | string {
  if (!value) {
    return null
  }

  try {
    const parsed = new URL(value)

    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)

    return host.endsWith(suffix) && host.length > suffix.length
  }

  return host === pattern
}

/**
 * Whether this resource may render inside the app's panel, or must be handed to
 * the OS browser instead. Never throws; an unparseable URL is not hostable.
 */
export function canHostInPanel(url: string, allowlist: readonly string[] = PANEL_ORIGIN_ALLOWLIST): boolean {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'https:') {
      return false
    }

    return allowlist.some(pattern => hostMatches(parsed.host.toLowerCase(), pattern.toLowerCase()))
  } catch {
    return false
  }
}

/**
 * Normalizes one wire attachment. Returns null for anything that is not a
 * usable https resource — a malformed entry is dropped, never rendered.
 */
export function parseDmResource(value: unknown, index: number): DmResource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const url = safeResourceUrl(readString(row, ['url', 'href', 'download_url', 'downloadUrl', 'uri', 'src']))

  if (!url) {
    return null
  }

  const mimeType = readString(row, ['mime_type', 'mimeType', 'content_type', 'contentType'])

  const name =
    readString(row, ['name', 'file_name', 'fileName', 'filename', 'title', 'label']) || fileNameFromUrl(url) || url

  return {
    id: readString(row, ['id', 'attachment_id', 'attachmentId']) || `${index}:${url}`,
    kind: resourceKind(readString(row, ['kind', 'type', 'resource_type', 'resourceType']), mimeType, name, url),
    mimeType,
    name,
    sizeBytes: readSize(row, ['size_bytes', 'sizeBytes', 'size', 'byte_size', 'byteSize', 'bytes']),
    url
  }
}

/** Normalizes a message's whole attachment list, dropping malformed entries. */
export function parseDmResources(attachments: unknown): DmResource[] {
  if (!Array.isArray(attachments)) {
    return []
  }

  const seen = new Set<string>()
  const resources: DmResource[] = []

  for (const [index, entry] of attachments.entries()) {
    const resource = parseDmResource(entry, index)

    if (resource && !seen.has(resource.id)) {
      seen.add(resource.id)
      resources.push(resource)
    }
  }

  return resources
}

/** Compact, locale-formatted size for the card's meta line. */
export function formatResourceSize(bytes: null | number, locale?: string): null | string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1
  }).format(value)

  return `${formatted} ${units[unit]}`
}

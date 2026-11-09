/**
 * docx-preview.ts
 *
 * The route decision for Word documents in the preview rail, kept separate from
 * the renderer so it can be tested without a DOM and reused by the normalizer.
 *
 * There is exactly one route today — `markdown`: unzip the OOXML in-process and
 * hand the result to the rail's existing Markdown renderer (see
 * `docx-markdown.ts` for why that beats a LibreOffice PDF/HTML conversion).
 * `soffice` is deliberately NOT a route: it is not bundled with the packaged
 * app, so depending on it would make the preview work on the dev machine and
 * fail on the demo machine.
 */

import type { PreviewTarget } from '@/store/preview'

/** Word document extensions we render. `.doc` (binary, pre-2007) is not one —
 *  it is not an OOXML package and still falls to the binary refusal screen. */
export const DOCX_EXTENSIONS = new Set(['.docm', '.docx', '.dotm', '.dotx'])

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export type PreviewFileRoute = 'docx' | null

export function fileExtension(value: string): string {
  const clean = value.split(/[?#]/, 1)[0] || value
  const name = clean.split(/[\\/]/).pop() || clean
  const index = name.lastIndexOf('.')

  return index > 0 ? name.slice(index).toLowerCase() : ''
}

export function isDocxPath(value: string): boolean {
  return DOCX_EXTENSIONS.has(fileExtension(value))
}

/**
 * Which specialised renderer a local file takes, or `null` for the existing
 * text/image/binary handling. Extension-driven: the rail resolves a path before
 * it has any bytes, and OOXML packages have no sniffable text header.
 */
export function previewFileRoute(input: { mimeType?: string; path?: string; url?: string }): PreviewFileRoute {
  if (input.mimeType === DOCX_MIME_TYPE) {
    return 'docx'
  }

  const candidate = input.path || input.url || ''

  return candidate && isDocxPath(candidate) ? 'docx' : null
}

/** True when this preview target should render as a document, not as bytes. */
export function isDocxPreviewTarget(target: null | PreviewTarget): boolean {
  if (!target || target.kind !== 'file') {
    return false
  }

  if (target.previewKind === 'docx') {
    return true
  }

  return previewFileRoute({ mimeType: target.mimeType, path: target.path, url: target.url }) === 'docx'
}

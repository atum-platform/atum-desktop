/**
 * docx-extract.ts
 *
 * Main-process OOXML extraction for the preview rail.
 *
 * THE BUG THIS FIXES: the docx preview used to read the whole package into the
 * renderer through `hermes:readFileDataUrl`. That handler base64-encodes the
 * entire file into a string and is hard-capped at 16 MB (DATA_URL_READ_MAX_BYTES
 * in electron/hardening.ts), so opening a real 101 MB `Data Zota.docx` failed
 * with "file is too large (101790328 bytes; limit 16777216 bytes)". Even with
 * the cap lifted the route was wrong: a 101 MB file becomes ~136 MB of base64
 * plus a decoded copy plus the parsed XML, all inside the renderer, on the UI
 * thread, mid-demo.
 *
 * THE ROUTE NOW: the renderer asks the main process for the *finished Markdown*
 * (`hermes:docx:preview`). The main process reads the file, inflates ONLY
 * `word/document.xml` and `word/numbering.xml` — a 100 MB package is almost
 * always 100 MB of embedded media, which is never touched — converts, and
 * returns a bounded string. The generic 16 MB cap on `readFileDataUrl` is
 * deliberately left in place for every other file type; this path is separate
 * and carries its own, format-aware limits.
 *
 * Why not reuse the bytes the revision store already retained at open
 * (electron/docx-revision.ts): the retained copy is the last state the store
 * ACCEPTED, which by design lags a fresh write until `sync` runs. The preview
 * must show what is on disk right now, so it reads the file itself. The two
 * stay independent on purpose — a preview refresh must never mutate the undo
 * ledger.
 *
 * Memory: the compressed file is read once into a Buffer and dropped as soon as
 * the two XML parts are inflated; only the parts and the resulting Markdown are
 * retained. Both are bounded (DOCX_MAX_XML_BYTES / the Markdown caps in
 * src/lib/docx-markdown.ts), so a hostile or merely enormous document cannot
 * make either process grow without limit.
 */

import fs from 'node:fs'
import path from 'node:path'

// `fflate/browser` on purpose: the node ESM build opens with
// `import { createRequire } from 'module'` for its worker pool, which collides
// with the createRequire banner the main bundle already carries (see
// scripts/bundle-electron-main.test.mjs). Nothing here uses the async/worker
// APIs, so the worker-free build is the right one in both processes.
import { strFromU8, unzipSync } from 'fflate/browser'

import type { DocxConvertLimits } from '../src/lib/docx-markdown'
import { DOCX_DOCUMENT_PART, DOCX_NUMBERING_PART, DocxConvertError, docxXmlToMarkdown } from '../src/lib/docx-markdown'

/** Word packages we render. `.doc` is not one — it is not an OOXML package. */
export const DOCX_EXTENSIONS = new Set(['.docm', '.docx', '.dotm', '.dotx'])

/**
 * Ceiling on the whole package. Well past the 101 MB document that exposed the
 * bug, and low enough that a mis-targeted multi-gigabyte file is refused before
 * it is read rather than after.
 */
export const DOCX_MAX_FILE_BYTES = 512 * 1024 * 1024

/**
 * Ceiling on the INFLATED `word/document.xml`. This is the zip-bomb fence: a
 * few hundred KB of deflate can claim to expand to gigabytes, and the size is
 * known from the central directory before a single byte is inflated.
 */
export const DOCX_MAX_XML_BYTES = 96 * 1024 * 1024

export interface DocxPreviewResult {
  /** Paragraph/table blocks rendered. */
  blockCount: number
  /** Size of the package on disk, for the UI's own reporting. */
  byteSize: number
  markdown: string
  path: string
  /** True when the document was longer than the preview caps allow. */
  truncated: boolean
}

export type DocxSnapshotPreviewResult = Omit<DocxPreviewResult, 'path'>

export function isDocxPath(filePath: string): boolean {
  return DOCX_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())
}

function inflateParts(bytes: Uint8Array, maxXmlBytes = DOCX_MAX_XML_BYTES): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: file => {
        if (file.name !== DOCX_DOCUMENT_PART && file.name !== DOCX_NUMBERING_PART) {
          return false
        }

        if (file.originalSize > maxXmlBytes) {
          throw new DocxConvertError(
            'not-a-docx',
            `${file.name} expands to ${file.originalSize} bytes; limit ${maxXmlBytes} bytes`
          )
        }

        return true
      }
    })
  } catch (error) {
    if (error instanceof DocxConvertError) {
      throw error
    }

    throw new DocxConvertError('not-a-docx', error instanceof Error ? error.message : String(error))
  }
}

/** Convert one exact package snapshot. The Tools adapter uses this seam so
 * hashing and rendering describe the same bytes rather than two file reads. */
export function extractDocxMarkdownSnapshot(
  bytes: Uint8Array,
  options: { limits?: DocxConvertLimits; maxFileBytes?: number; maxXmlBytes?: number } = {}
): DocxSnapshotPreviewResult {
  const maxFileBytes =
    Number.isFinite(options.maxFileBytes) && Number(options.maxFileBytes) > 0
      ? Number(options.maxFileBytes)
      : DOCX_MAX_FILE_BYTES

  if (bytes.byteLength > maxFileBytes) {
    throw new DocxConvertError(
      'not-a-docx',
      `document is too large (${bytes.byteLength} bytes; limit ${maxFileBytes} bytes)`
    )
  }

  let entries = inflateParts(bytes, options.maxXmlBytes)
  const document = entries[DOCX_DOCUMENT_PART]

  if (!document) {
    throw new DocxConvertError('no-document-part', `archive has no ${DOCX_DOCUMENT_PART}`)
  }

  const numberingPart = entries[DOCX_NUMBERING_PART]
  const documentXml = strFromU8(document)
  const numberingXml = numberingPart ? strFromU8(numberingPart) : undefined

  entries = {}
  const render = docxXmlToMarkdown(documentXml, numberingXml, options.limits)

  return {
    blockCount: render.blockCount,
    byteSize: bytes.byteLength,
    markdown: render.markdown,
    truncated: render.truncated
  }
}

/**
 * Read a `.docx` from disk and return its Markdown render.
 *
 * @param filePath absolute path — callers must have run it through the IPC path
 *   hardening (`resolveReadableFileForIpc`) first.
 */
export async function extractDocxMarkdown(
  filePath: string,
  options: { fs?: typeof fs; limits?: DocxConvertLimits; maxFileBytes?: number; maxXmlBytes?: number } = {}
): Promise<DocxPreviewResult> {
  const fsImpl = options.fs || fs
  const resolved = path.resolve(String(filePath || ''))

  const maxFileBytes =
    Number.isFinite(options.maxFileBytes) && Number(options.maxFileBytes) > 0
      ? Number(options.maxFileBytes)
      : DOCX_MAX_FILE_BYTES

  if (!isDocxPath(resolved)) {
    throw new DocxConvertError('not-a-docx', `${path.basename(resolved)} is not an OOXML word package`)
  }

  const stat = await fsImpl.promises.stat(resolved)

  if (stat.size > maxFileBytes) {
    throw new DocxConvertError('not-a-docx', `document is too large (${stat.size} bytes; limit ${maxFileBytes} bytes)`)
  }

  const render = extractDocxMarkdownSnapshot(await fsImpl.promises.readFile(resolved), {
    limits: options.limits,
    maxFileBytes,
    maxXmlBytes: options.maxXmlBytes
  })

  return {
    ...render,
    path: resolved
  }
}

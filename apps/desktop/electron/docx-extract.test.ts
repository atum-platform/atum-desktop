/**
 * docx-extract.test.ts
 *
 * The regression this file exists for: a 101 MB `Data Zota.docx` could not be
 * opened in the preview rail at all, because the renderer pulled the package
 * across IPC as a base64 data URL behind a 16 MB cap. The large-document test
 * below builds a real multi-tens-of-MB package on disk and renders it through
 * the main-process path that replaced it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DocxConvertError } from '../src/lib/docx-markdown'

import { DOCX_MAX_XML_BYTES, extractDocxMarkdown, isDocxPath } from './docx-extract'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

let root = ''

function write(name: string, parts: Record<string, string | Uint8Array>): string {
  const target = path.join(root, name)

  fs.writeFileSync(
    target,
    zipSync(
      Object.fromEntries(
        Object.entries(parts).map(([entry, value]) => [entry, typeof value === 'string' ? strToU8(value) : value])
      )
    )
  )

  return target
}

function document(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`
}

function paragraph(text: string, properties = '') {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-docx-extract-'))
})

afterAll(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

describe('extractDocxMarkdown', () => {
  it('renders a small document from disk', async () => {
    const file = write('hop-dong.docx', {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': document(
        paragraph('Hợp đồng dịch vụ', '<w:pStyle w:val="Heading1"/>') + paragraph('Bên A thanh toán 500.000.000 VND.')
      )
    })

    const result = await extractDocxMarkdown(file)

    expect(result.markdown).toBe('# Hợp đồng dịch vụ\n\nBên A thanh toán 500.000.000 VND.')
    expect(result.blockCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.path).toBe(file)
    expect(result.byteSize).toBe(fs.statSync(file).size)
  })

  it('uses numbering.xml when the package carries one', async () => {
    const file = write('danh-sach.docx', {
      'word/document.xml': document(paragraph('Đợt 1', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')),
      'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`
    })

    expect((await extractDocxMarkdown(file)).markdown).toBe('1. Đợt 1')
  })

  it('renders a 100 MB-class package without reading it through the data-URL cap', { timeout: 180_000 }, async () => {
    // 300k paragraphs of real text plus incompressible "media", i.e. the
    // shape of the document that broke the preview: a huge ZIP whose bulk is
    // embedded images, with a document.xml far past any renderer-side budget.
    const body: string[] = []

    for (let index = 0; index < 300_000; index += 1) {
      if (index % 500 === 0) {
        body.push(paragraph(`Phần ${index / 500 + 1}`, '<w:pStyle w:val="Heading1"/>'))
      }

      body.push(paragraph(`Điều ${index + 1}. Bên A thanh toán cho Bên B theo tiến độ nghiệm thu &amp; phụ lục.`))
    }

    const parts: Record<string, string | Uint8Array> = {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': document(body.join(''))
    }

    for (let index = 0; index < 24; index += 1) {
      parts[`word/media/image${index}.bin`] = crypto.randomBytes(1024 * 1024)
    }

    const file = write('data-zota.docx', parts)
    const size = fs.statSync(file).size

    expect(size).toBeGreaterThan(20 * 1024 * 1024)

    const started = Date.now()
    const result = await extractDocxMarkdown(file)
    const elapsed = Date.now() - started

    expect(result.byteSize).toBe(size)
    // The head of the document is real, and the tail is honestly reported as
    // missing rather than silently dropped.
    expect(result.markdown.startsWith('# Phần 1\n\nĐiều 1.')).toBe(true)
    expect(result.truncated).toBe(true)
    // Bounded output — this is what crosses IPC and what the Markdown
    // renderer has to mount.
    expect(result.markdown.length).toBeLessThan(260_000)
    // Bounded time: the conversion stops at the caps instead of walking the
    // whole document, so the panel is not frozen behind it.
    expect(elapsed).toBeLessThan(20_000)
  })

  it('refuses a package whose document part claims an absurd expanded size', async () => {
    // A zip bomb: the entry's uncompressed size is read from the archive
    // metadata, so this is refused BEFORE anything is inflated.
    const file = path.join(root, 'bomb.docx')
    const zeros = new Uint8Array(1024 * 1024)
    fs.writeFileSync(file, zipSync({ 'word/document.xml': zeros }, { level: 9 }))

    // Rewrite the recorded uncompressed size to a value past the fence.
    const bytes = fs.readFileSync(file)
    const claimed = DOCX_MAX_XML_BYTES + 1

    for (let index = 0; index + 4 <= bytes.length; index += 1) {
      if (bytes.readUInt32LE(index) === zeros.length) {
        bytes.writeUInt32LE(claimed, index)
      }
    }

    fs.writeFileSync(file, bytes)

    await expect(extractDocxMarkdown(file)).rejects.toThrow(/expands to/)
  })

  it('refuses a file that is not a word package by extension', async () => {
    const file = path.join(root, 'notes.txt')
    fs.writeFileSync(file, 'hello')

    await expect(extractDocxMarkdown(file)).rejects.toThrow(DocxConvertError)
  })

  it('refuses a package larger than the file ceiling before reading it', async () => {
    const file = write('over.docx', { 'word/document.xml': document(paragraph('x')) })

    await expect(extractDocxMarkdown(file, { maxFileBytes: 8 })).rejects.toThrow(/too large/)
  })

  it('reports a package with no document part', async () => {
    const file = write('styles-only.docx', { 'word/styles.xml': '<x/>' })

    await expect(extractDocxMarkdown(file)).rejects.toThrow(/word\/document\.xml/)
  })

  it('reports bytes that are not a zip at all', async () => {
    const file = path.join(root, 'plain.docx')
    fs.writeFileSync(file, 'this is a plain text file')

    await expect(extractDocxMarkdown(file)).rejects.toThrow(DocxConvertError)
  })
})

describe('isDocxPath', () => {
  it('accepts the OOXML word extensions and rejects legacy .doc', () => {
    expect(isDocxPath('/tmp/a.docx')).toBe(true)
    expect(isDocxPath('/tmp/a.DOTM')).toBe(true)
    expect(isDocxPath('/tmp/a.doc')).toBe(false)
    expect(isDocxPath('/tmp/a.pdf')).toBe(false)
  })
})

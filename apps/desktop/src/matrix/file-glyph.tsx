import type { ComponentProps, ComponentType } from 'react'

import { File, FileImage, FileMusic, FileSpreadsheet, FileText, FileZip, Movie, Presentation } from '@/lib/icons'

type Glyph = ComponentType<ComponentProps<typeof File>>

/** What a file is to the person who owns it — a document, a sheet, a photo — never the
 * code-editor vocabulary the old engine's file icons speak (launch night, 2026-10-04). */
const GLYPHS: ReadonlyArray<readonly [RegExp, Glyph]> = [
  // Shapes, not lettering: a "DOCX" stamp is a smudge at 16px.
  [/^(docx?|odt|rtf|pages|pdf|txt|md|markdown|text)$/u, FileText],
  [/^(xlsx?|ods|numbers|csv|tsv)$/u, FileSpreadsheet],
  [/^(pptx?|odp|key)$/u, Presentation],
  [/^(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|svg)$/u, FileImage],
  [/^(mp3|m4a|wav|aac|flac|ogg|aiff?)$/u, FileMusic],
  [/^(mp4|mov|m4v|avi|mkv|webm)$/u, Movie],
  [/^(zip|rar|7z|tar|gz|tgz)$/u, FileZip]
]

export function matrixFileGlyph(name: string): Glyph {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

  return GLYPHS.find(([pattern]) => pattern.test(extension))?.[1] ?? File
}

export function MatrixFileGlyph({ className, name }: { className?: string; name: string }) {
  const Glyph = matrixFileGlyph(name)

  return <Glyph aria-hidden className={className} strokeWidth={1.6} />
}

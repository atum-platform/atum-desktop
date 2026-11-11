import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { phosphorIcon } from '@/lib/phosphor-icon'

import type { DesktopLocale } from '../../shared/desktop-locale'
import { matrixFileChipText } from '../../shared/matrix-file-chip-copy'
import { type FileChip, type MatrixFileGlyph, matrixFileGlyph } from '../../shared/matrix-file-chips'

const GLYPHS = Object.fromEntries(
  (
    [
      'file',
      'file-doc',
      'file-xls',
      'file-csv',
      'file-pdf',
      'file-ppt',
      'file-zip',
      'image',
      'file-audio',
      'file-text',
      'file-code'
    ] as const satisfies readonly MatrixFileGlyph[]
  ).map(name => [name, phosphorIcon(name)])
) as Record<MatrixFileGlyph, ReturnType<typeof phosphorIcon>>

const InfoIcon = phosphorIcon('info')

/** The kit's modifier for each state: a save Atum can't confirm is muted, an expired one inert. */
const STATE_CLASS: Record<FileChip['state'], string> = {
  saving: 'ak-file',
  saved: 'ak-file',
  saved_as_copy: 'ak-file',
  not_confirmed: 'ak-file ak-file--muted',
  expired: 'ak-file ak-file--inert'
}

/**
 * One file an answer made, as the kit's file card (STYLE.md "Files"): its shape glyph, its real
 * name and one line. The line is where it is, or "Not confirmed"; the trailing slot shows a save
 * still settling or why a copy sits beside the original. Its state changes by itself, never by
 * new text. It has no actions yet: open, preview and Finder need the server's resolver.
 */
export function MatrixFileChip({ file, locale }: { file: FileChip; locale: DesktopLocale }) {
  const copy = matrixFileChipText(locale)
  const Glyph = GLYPHS[matrixFileGlyph(file.name)]
  const unconfirmed = file.state === 'not_confirmed' || file.state === 'expired'

  return (
    <div
      className={STATE_CLASS[file.state]}
      data-matrix-file-chip={file.state}
      role="listitem"
    >
      <span aria-hidden className="ak-file-tile">
        <Glyph className="ak-icon" />
      </span>
      <span className="ak-file-main">
        <span className="ak-file-name">{file.name}</span>
        <span className="ak-file-meta">{unconfirmed ? copy.notConfirmed : file.place}</span>
      </span>
      {file.state === 'saving' && (
        <span className="ak-file-end">
          <Tip label={copy.saving}>
            <span aria-label={copy.saving} className="ak-spinner" role="status" tabIndex={0} />
          </Tip>
        </span>
      )}
      {file.state === 'saved_as_copy' && (
        <span className="ak-file-end">
          <Tip label={copy.copyReason}>
            <button aria-label={copy.copyLabel} className="ak-iconbtn ak-iconbtn--sm" type="button">
              <InfoIcon aria-hidden className="ak-icon ak-icon--sm" />
            </button>
          </Tip>
        </span>
      )}
    </div>
  )
}

/** Every file an answer made, one card each, under its words. */
export function MatrixFileChips({ files }: { files: readonly FileChip[] }) {
  const { locale } = useI18n()

  return (
    <div
      aria-label={matrixFileChipText(locale).files}
      className="mt-(--ak-s2) flex flex-col items-start gap-(--ak-s2)"
      data-matrix-file-chips
      role="list"
    >
      {files.map(file => (
        <MatrixFileChip file={file} key={file.fileKey} locale={locale} />
      ))}
    </div>
  )
}

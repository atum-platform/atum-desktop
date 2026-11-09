import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { codeSizePt, type ResolvedDocumentTheme } from '../../../shared/atum-office/document-theme'
import { PAGE_DIMENSIONS_MM } from '../../../shared/atum-office/units'

/**
 * The document canvas: what makes the live-Markdown surface read as a
 * document rather than a text file.
 *
 * Deliberately NOT a page. It is one continuous paper-coloured sheet on a muted
 * backdrop, because simulated page breaks would imply a page count the app
 * cannot compute. Width is applied to `.cm-content`, never to lines, so
 * wrapping and CodeMirror's height measurement keep working; margins are the
 * theme's real page margins, capped so a narrow pane still shows text.
 *
 * Every value comes from the same resolved theme the export writers consume,
 * so what the person reads on the canvas is what the Word and PDF files carry.
 * Points and millimetres are used directly: CSS maps them to the screen at
 * 96 dpi, which is also how the PDF renderer lays the same stylesheet out.
 *
 * Nothing here is a replacement decoration or a block widget. The canvas only
 * styles; it never changes source offsets, so the context chip stays exact.
 */

export const DOCUMENT_CANVAS_CLASS = 'cm-document-canvas'

type StyleSpec = Record<string, Record<string, string> | Record<string, Record<string, string>>>

function pt(value: number): string {
  return `${Number(value.toFixed(2))}pt`
}

/** The style spec, kept separate from the extension so it can be asserted without a DOM. */
export function documentPageStyle(theme: ResolvedDocumentTheme, zoom: number | 'fit' = 'fit'): Record<string, string> {
  const scale = zoom === 'fit' ? 1 : zoom / 100
  const page = PAGE_DIMENSIONS_MM[theme.pageSize]
  const margin = (mm: number) => (zoom === 'fit' ? `min(${mm}mm, 12%)` : `${mm * scale}mm`)

  return {
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12), 0 8px 24px rgba(0, 0, 0, 0.08)',
    boxSizing: 'border-box',
    caretColor: '#171717',
    color: '#171717',
    fontFamily: theme.bodyFont.css,
    fontSize: pt(theme.bodySizePt * scale),
    lineHeight: String(theme.lineHeight),
    margin: '0 auto',
    maxWidth: `${page.widthMm * scale}mm`,
    minHeight: '60vh',
    padding: `${margin(theme.marginMm.topMm)} ${margin(theme.marginMm.rightMm)} ${margin(theme.marginMm.bottomMm)} ${margin(theme.marginMm.leftMm)}`,
    width: zoom === 'fit' ? '100%' : `${page.widthMm * scale}mm`,
    flexShrink: '0'
  }
}

export function documentCanvasStyles(theme: ResolvedDocumentTheme, zoom: number | 'fit' = 'fit'): StyleSpec {
  const root = `&.${DOCUMENT_CANVAS_CLASS}`
  const [h1, h2, h3, h4, h5, h6] = theme.headingSizesPt
  const scale = zoom === 'fit' ? 1 : zoom / 100
  const heading = (size: number | undefined) => pt((size ?? theme.bodySizePt) * scale)

  return {
    // The sheet is a print surface, so its ink, caret, selection and the
    // colours markdown-live reads through the app's CSS variables are all
    // pinned to light-on-paper here, whatever the application theme is. Without
    // this a dark-mode caret is a light bar on white paper, and revealed
    // syntax or **strong** text inherits the app's light ink and vanishes.
    [root]: {
      '--atum-accent': `#${theme.accentHex}`,
      '--atum-ink': '#171717',
      '--atum-ink-muted': '#555555',
      backgroundColor: 'var(--atum-canvas-backdrop, #e9e8e4)'
    },
    [`${root} .cm-cursor, ${root} .cm-dropCursor`]: { borderLeftColor: '#171717' },
    [`${root}.cm-focused .cm-selectionBackground, ${root} .cm-selectionBackground, ${root} .cm-content ::selection`]: {
      backgroundColor: '#b9d4f7'
    },
    // Revealed syntax on the active line is painted by the app's highlighter;
    // on paper it must read as ink, not as the dark theme's pale punctuation.
    [`${root} .cm-content span:not(.cm-markdown-link):not(.cm-markdown-heading):not(.cm-markdown-quote):not(.cm-markdown-list-marker)`]:
      { color: 'inherit' },
    [`${root} .cm-scroller`]: { padding: '1.25rem 0.75rem 2.5rem' },
    // Paper stays paper in dark mode: the sheet mirrors the printed page, and
    // the exported file does not have a dark mode either.
    [`${root} .cm-content`]: documentPageStyle(theme, zoom),
    // CodeEditor has explicit declarations on each line; inheriting only on
    // the content parent leaves prose monospaced. Scope this override to paper.
    [`${root} .cm-line`]: { padding: '0', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' },
    [`${root} .cm-markdown-heading`]: {
      color: `#${theme.accentHex}`,
      fontFamily: theme.headingFont.css,
      lineHeight: '1.2'
    },
    [`${root} .cm-markdown-heading-1`]: { fontSize: heading(h1) },
    [`${root} .cm-markdown-heading-2`]: { fontSize: heading(h2) },
    [`${root} .cm-markdown-heading-3`]: { fontSize: heading(h3) },
    [`${root} .cm-markdown-heading-4`]: { fontSize: heading(h4) },
    [`${root} .cm-markdown-heading-5`]: { fontSize: heading(h5) },
    [`${root} .cm-markdown-heading-6`]: { fontSize: heading(h6) },
    [`${root} .cm-markdown-inline-code`]: { fontSize: pt(codeSizePt(theme) * scale) },
    [`${root} .cm-markdown-quote`]: { color: '#444444' },
    // Under a forced-colour (high contrast) scheme the sheet must not pin its
    // own ink and paper: the system's colours are the accessibility contract.
    '@media (forced-colors: active)': {
      [root]: { '--atum-accent': 'CanvasText', '--atum-ink': 'CanvasText', '--atum-ink-muted': 'GrayText' },
      [`${root} .cm-content`]: {
        backgroundColor: 'Canvas',
        boxShadow: 'none',
        caretColor: 'CanvasText',
        color: 'CanvasText'
      },
      [`${root} .cm-cursor, ${root} .cm-dropCursor`]: { borderLeftColor: 'CanvasText' },
      [`${root}.cm-focused .cm-selectionBackground, ${root} .cm-selectionBackground, ${root} .cm-content ::selection`]:
        {
          backgroundColor: 'Highlight',
          color: 'HighlightText'
        },
      [`${root} .cm-markdown-heading`]: { color: 'CanvasText' },
      [`${root} .cm-markdown-link`]: { color: 'LinkText' },
      [`${root} .cm-markdown-quote`]: { color: 'GrayText' }
    }
  }
}

/**
 * One extension per resolved theme. The pane swaps it through the presentation
 * compartment, so a theme change restyles the mounted editor without a remount
 * and without touching the buffer.
 */
export function documentCanvas(theme: ResolvedDocumentTheme, zoom: number | 'fit' = 'fit'): Extension {
  return [
    EditorView.editorAttributes.of({ class: DOCUMENT_CANVAS_CLASS }),
    EditorView.theme(documentCanvasStyles(theme, zoom))
  ]
}

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { resolveDocumentTheme } from '../../../shared/atum-office/document-theme'

import { DOCUMENT_CANVAS_CLASS, documentCanvas, documentCanvasStyles } from './document-canvas'

describe('documentCanvas', () => {
  it('derives every value from the resolved theme the export pins', () => {
    const theme = resolveDocumentTheme({ overrides: { bodySizePt: 12, pageSize: 'letter' }, themeId: 'report' }, 3)
    const styles = documentCanvasStyles(theme)
    const content = styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-content`]!

    expect(content.fontSize).toBe('12pt')
    expect(content.fontFamily).toBe(theme.bodyFont.css)
    expect(content.lineHeight).toBe(String(theme.lineHeight))
    // Letter is 215.9 mm wide; the sheet is one continuous width, never pages.
    expect(content.maxWidth).toBe('215.9mm')
    // Exactly the theme's margins, never a percentage substitute.
    expect(content.padding).toBe('min(25.4mm, 12%) min(25.4mm, 12%) min(25.4mm, 12%) min(25.4mm, 12%)')
    // Headings carry the theme's own face, colour and (scaled) sizes.
    const heading = styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-markdown-heading`]!
    expect(heading.fontFamily).toBe(theme.headingFont.css)
    expect(heading.color).toBe(`#${theme.accentHex}`)
    theme.headingSizesPt.forEach((size, index) => {
      expect(styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-markdown-heading-${index + 1}`]!.fontSize).toBe(`${size}pt`)
    })
  })

  it('pins ink, caret and selection to paper colours so dark mode stays legible', () => {
    const styles = documentCanvasStyles(resolveDocumentTheme({ themeId: 'modern' }, 1))
    const root = styles[`&.${DOCUMENT_CANVAS_CLASS}`]!

    expect(root['--atum-ink']).toBe('#171717')
    expect(root['--atum-accent']).toBe('#0F6FC6')
    expect(styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-content`]!.caretColor).toBe('#171717')
    expect(
      styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-cursor, &.${DOCUMENT_CANVAS_CLASS} .cm-dropCursor`]!.borderLeftColor
    ).toBe('#171717')
    const selection = Object.entries(styles).find(([selector]) => selector.includes('.cm-selectionBackground'))!
    expect(selection[1].backgroundColor).toBe('#b9d4f7')
  })

  it('hands ink and paper to the system under forced colours', () => {
    const styles = documentCanvasStyles(resolveDocumentTheme(null))
    const forced = styles['@media (forced-colors: active)'] as Record<string, Record<string, string>>

    expect(forced[`&.${DOCUMENT_CANVAS_CLASS} .cm-content`]!.backgroundColor).toBe('Canvas')
    expect(forced[`&.${DOCUMENT_CANVAS_CLASS} .cm-content`]!.color).toBe('CanvasText')
    expect(forced[`&.${DOCUMENT_CANVAS_CLASS}`]!['--atum-ink']).toBe('CanvasText')
    expect(forced[`&.${DOCUMENT_CANVAS_CLASS} .cm-markdown-link`]!.color).toBe('LinkText')
  })

  it('is a page-less sheet: no page rule, and width lives on the content, not on lines', () => {
    const styles = documentCanvasStyles(resolveDocumentTheme(null))
    const serialised = JSON.stringify(styles)

    expect(serialised).not.toContain('@page')
    expect(serialised).not.toContain('page-break')
    expect(styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-line`]).toMatchObject({
      padding: '0',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit'
    })
    expect(styles[`&.${DOCUMENT_CANVAS_CLASS} .cm-content`]!.width).toBe('100%')
  })

  it('mounts as a theme extension, marks the editor root, and never touches the buffer', () => {
    const parent = document.createElement('div')
    document.body.append(parent)

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '# Tiêu đề\n\nMột đoạn.',
        extensions: [documentCanvas(resolveDocumentTheme(null))]
      })
    })

    expect(view.dom.classList.contains(DOCUMENT_CANVAS_CLASS)).toBe(true)
    expect(view.state.doc.toString()).toBe('# Tiêu đề\n\nMột đoạn.')

    const css = Array.from(document.querySelectorAll('style'))
      .map(node => node.textContent ?? '')
      .join('\n')

    expect(css).toContain('max-width: 210mm')
    expect(css).toContain('font-size: 11pt')
    view.destroy()
    parent.remove()
  })
})

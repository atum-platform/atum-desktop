import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { strFromU8, unzipSync } from 'fflate/browser'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeEditor, type CodeEditorApi } from '@/components/chat/code-editor'
import { markdownToDocx } from '@/lib/markdown-export'

import { resolveDocumentTheme } from '../../../../shared/atum-office/document-theme'

import { codeEditorDocumentController } from './code-editor-document-controller'
import type { RichDocumentEditorApi } from './document-editor-controller'
import { documentNavigationController } from './document-navigation-controller'
import { RichDocumentEditor } from './rich-document-editor'

// JSDOM omits ClipboardEvent; PM creates an empty one for its public text API.
beforeEach(() => vi.stubGlobal('ClipboardEvent', class extends Event {}))
afterEach(() => vi.unstubAllGlobals())

vi.mock('@/themes/context', () => ({
  useTheme: () => ({ resolvedMode: 'light' })
}))

const rect = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }
Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })

interface MountedDocument {
  code: React.RefObject<CodeEditorApi | null>
  controller: ReturnType<typeof codeEditorDocumentController>
  refused: ReturnType<typeof vi.fn>
  pasteFeedback: ReturnType<typeof vi.fn>
  rich: React.RefObject<RichDocumentEditorApi | null>
  rerender: (richActive: boolean) => void
  root: ReturnType<typeof render>
}

function proseMirror(container: HTMLElement): HTMLElement {
  const editor = container.querySelector<HTMLElement>('.ProseMirror')

  if (!editor) {
    throw new Error('ProseMirror did not mount')
  }

  return editor
}

function mountDocument(source: string, richActive = true): MountedDocument {
  const code = createRef<CodeEditorApi | null>()
  const rich = createRef<RichDocumentEditorApi | null>()
  const controller = codeEditorDocumentController(() => code.current)
  const refused = vi.fn()
  const pasteFeedback = vi.fn()

  const Document = ({ active }: { active: boolean }) => (
    <>
      <CodeEditor
        apiRef={code}
        filePath="note.md"
        initialValue={source}
        inputDisabled={active}
        liveMarkdown
        onChange={() => undefined}
        onSelectionChange={selection => rich.current?.syncSource(selection.documentText, selection)}
        preserveLineEndings
      />
      <RichDocumentEditor
        apiRef={rich}
        controller={controller}
        enabled={active}
        initialValue={source}
        labels={{ editor: 'Rich editor', refused: 'Source editor required' }}
        onPasteFeedback={pasteFeedback}
        onRefused={refused}
        theme={resolveDocumentTheme(null)}
        zoom="fit"
      />
    </>
  )

  const root = render(<Document active={richActive} />)

  return {
    code,
    controller,
    refused,
    pasteFeedback,
    rich,
    rerender: active => root.rerender(<Document active={active} />),
    root
  }
}

describe('rich document source integration', () => {
  afterEach(cleanup)

  it('routes rich formatting through the CodeMirror controller without normalizing CRLF or untouched bytes', async () => {
    const source = '# Tiêu đề\r\n\r\nBefore **bold** 👩🏽‍💻.  \r\nNext.\r\n'
    const mounted = mountDocument(source)

    expect(mounted.rich.current?.command('heading', 2)).toBe(true)

    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source.replace('# Tiêu đề', '## Tiêu đề')))
    expect(mounted.code.current?.getDoc()).toContain('\r\n\r\n')
    expect(mounted.code.current?.getDoc()).toContain('👩🏽‍💻.  \r\nNext.\r\n')
    expect(proseMirror(mounted.root.container).textContent).toContain('bold')
  })

  it('uses ordinary EditorView DOM input through the canonical CodeMirror history owner', async () => {
    const mounted = mountDocument('Alpha')
    const editor = proseMirror(mounted.root.container)

    editor.focus()
    editor.textContent = 'Alphax'
    fireEvent.input(editor, { data: 'x', inputType: 'insertText' })

    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alphax'))
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alpha'))
    expect(mounted.controller.redo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alphax'))
  })

  it('allows ordinary typing to end a paragraph with a space', async () => {
    const mounted = mountDocument('Alpha')
    const editor = proseMirror(mounted.root.container)
    editor.focus()
    editor.querySelector('p')!.textContent = 'Alpha '
    fireEvent.input(editor, { data: ' ', inputType: 'insertText' })
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alpha&#32;'))
    expect(mounted.refused).not.toHaveBeenCalled()
    expect(editor.textContent).toBe('Alpha ')
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alpha'))
  })

  it('keeps source and rich projections synchronized through source mode edits and mode switches', async () => {
    const mounted = mountDocument('# One')

    mounted.rerender(false)
    act(() => {
      mounted.code.current?.dispatchCommand(view => {
        view.dispatch({ changes: { from: 2, insert: 'Source ' } })

        return true
      })
    })
    await waitFor(() => expect(proseMirror(mounted.root.container).textContent).toBe('Source One'))

    mounted.rerender(true)
    expect(mounted.rich.current?.command('heading', 2)).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('## Source One'))

    mounted.rerender(false)
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('# Source One'))
    mounted.rerender(true)
    expect(proseMirror(mounted.root.container).textContent).toBe('Source One')
  })

  it('creates a real table and accepts Enter through the mounted ProseMirror keymap', async () => {
    const table = mountDocument('Alpha')

    expect(table.rich.current?.command('table')).toBe(true)
    await waitFor(() => expect(table.code.current?.getDoc()).toContain('| --- | --- |'))
    expect(proseMirror(table.root.container).querySelectorAll('table td')).toHaveLength(2)
    const cell = proseMirror(table.root.container).querySelector<HTMLParagraphElement>('table td p')!
    cell.textContent = 'cell'
    fireEvent.input(cell, { data: 'cell', inputType: 'insertText' })
    await waitFor(() => expect(table.code.current?.getDoc()).toContain('cell'))

    const paragraphs = mountDocument('Hello')
    const editor = proseMirror(paragraphs.root.container)
    const text = editor.querySelector('p')?.firstChild
    const selection = window.getSelection()
    const range = window.document.createRange()
    range.setStart(text!, text?.textContent?.length ?? 0)
    range.collapse(true)
    editor.focus()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent(window.document, new Event('selectionchange', { bubbles: true }))
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(paragraphs.code.current?.getDoc()).toBe('Hello\n\n'))
    expect(paragraphs.rich.current).toBeTruthy()
  })

  it('refuses stale compare-and-swap and unsafe rich commands without publishing either projection', async () => {
    const mounted = mountDocument('Alpha')
    const before = mounted.code.current?.getDoc()

    expect(
      mounted.controller.commit({
        expectedSource: 'stale',
        kind: 'typing',
        patch: { from: 0, insert: 'x', to: 0 },
        selection: { from: 1, to: 1 }
      })
    ).toBe(false)
    expect(mounted.code.current?.getDoc()).toBe(before)
    expect(mounted.rich.current?.command('link', 'javascript:alert(1)')).toBe(false)
    expect(mounted.code.current?.getDoc()).toBe(before)
    expect(mounted.refused).not.toHaveBeenCalled()
  })

  it('keeps composition tentative until compositionend commits to CodeMirror', async () => {
    const mounted = mountDocument('Alpha')
    const editor = proseMirror(mounted.root.container)
    act(() => { mounted.rich.current?.setSearchQuery('Alpha') })
    expect(editor.querySelector('.document-search-match')).toBeTruthy()

    editor.focus()
    fireEvent.compositionStart(editor)
    expect(editor.querySelector('.document-search-match')).toBeNull()
    editor.querySelector('p')!.firstChild!.textContent = 'Alphaế'
    fireEvent.input(editor, { data: 'ế', inputType: 'insertCompositionText', isComposing: true })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(editor.textContent).toBe('Alphaế')
    expect(mounted.code.current?.getDoc()).toBe('Alpha')
    fireEvent.compositionEnd(editor)

    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alphaế'))
    expect(editor.querySelector('.document-search-match')).toBeTruthy()
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Alpha'))
  })
})

function paste(editor: HTMLElement, html: string, text = '', files: File[] = []): void {
  fireEvent.paste(editor, { clipboardData: {
    files,
    getData: (format: string) => format === 'text/html' ? html : format === 'text/plain' ? text : ''
  } })
}

describe('rich clipboard source integration', () => {
  afterEach(cleanup)

  it('pastes Word-styled text as one undo unit while preserving untouched CRLF source', async () => {
    const source = '# Before\r\n\r\nTarget\r\n\r\nAfter **unchanged**.\r\n'
    const mounted = mountDocument(source)
    const from = source.indexOf('Target')
    act(() => mounted.rich.current?.syncSource(source, { from, to: from + 6 }))
    paste(proseMirror(mounted.root.container),
      '<p class="MsoNormal"><span style="font-family:Calibri;color:#123456;font-weight:700">Xin chào</span> <i>Việt Nam</i></p>',
      'Xin chào Việt Nam')

    await waitFor(() => expect(mounted.code.current?.getDoc()).toContain('**Xin chào** *Việt Nam*'))
    const pasted = mounted.code.current!.getDoc()
    expect(pasted).toMatch(/^# Before\r\n\r\n/u)
    expect(pasted).toMatch(/\r\n\r\nAfter \*\*unchanged\*\*\.\r\n$/u)
    expect(mounted.pasteFeedback).toHaveBeenLastCalledWith('simplified')
    expect(mounted.refused).not.toHaveBeenCalled()

    mounted.rerender(false)
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source))
    mounted.rerender(true)
    expect(mounted.controller.redo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(pasted))
    expect(proseMirror(mounted.root.container).querySelector('strong')?.textContent).toBe('Xin chào')
  })

  it('pastes a heading, list and rectangular table that survive reparse and real DOCX generation', async () => {
    const mounted = mountDocument('Target')
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    paste(proseMirror(mounted.root.container), '<h2>Kế hoạch</h2><ul><li><p>Họp nhóm</p></li></ul>' +
      '<table><tr><th>Hạng mục</th><th>Trạng thái</th></tr><tr><td><b>Họp</b></td><td>Đã xong</td></tr></table>')
    await waitFor(() => expect(mounted.code.current?.getDoc()).toContain('Đã xong'))
    expect(mounted.refused).not.toHaveBeenCalled()
    const source = mounted.code.current!.getDoc()
    expect(source).toContain('## Kế hoạch')
    expect(source).toContain('- Họp nhóm')
    expect(source).toContain('| **Họp** | Đã xong |')
    mounted.rerender(false)
    act(() => mounted.rich.current?.syncSource(source, { from: 0, to: 0 }))
    mounted.rerender(true)
    expect(proseMirror(mounted.root.container).querySelectorAll('table tr')).toHaveLength(2)

    const parts = unzipSync(markdownToDocx(source, { title: 'Clipboard report' }))
    const xml = strFromU8(parts['word/document.xml']!)
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('Đã xong')
    expect(xml).toContain('Heading2')
    expect(xml).toContain('<w:b/>')
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Target'))
  })

  it('uses Paste without formatting even when the clipboard includes refused HTML', async () => {
    const mounted = mountDocument('Target')
    const editor = proseMirror(mounted.root.container)
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    fireEvent.keyDown(editor, { ctrlKey: true, shiftKey: true, key: 'V' })
    paste(editor, '<img src="https://example.invalid/private.png"><b>Plain</b>', 'Plain **literal**')
    fireEvent.keyUp(editor, { key: 'V' })
    await waitFor(() => expect(editor.textContent).toBe('Plain **literal**'))
    expect(editor.querySelector('strong')).toBeNull()
    expect(editor.querySelector('img')).toBeNull()
    expect(mounted.pasteFeedback).not.toHaveBeenCalledWith('refused')
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Target'))
  })

  it.each([
    '<p>Keep</p><img src="https://example.invalid/image.png">',
    '<table><tr><td colspan="2">Merged</td></tr></table>',
    '<a href="javascript:alert(1)">Unsafe</a>'
  ])('refuses unrepresentable HTML atomically: %s', html => {
    const mounted = mountDocument('Original')
    paste(proseMirror(mounted.root.container), html, 'Clipboard')
    expect(mounted.code.current?.getDoc()).toBe('Original')
    expect(proseMirror(mounted.root.container).textContent).toBe('Original')
    expect(mounted.pasteFeedback).toHaveBeenLastCalledWith('refused', true)
    expect(mounted.controller.undo()).toBe(false)
  })

  it('does not paste into hidden/read-only rich input or an active composition', async () => {
    const mounted = mountDocument('Original', false)
    const editor = proseMirror(mounted.root.container)
    paste(editor, '<b>Hidden</b>', 'Hidden')
    expect(mounted.code.current?.getDoc()).toBe('Original')
    mounted.rerender(true)
    fireEvent.compositionStart(editor)
    paste(editor, '<b>During composition</b>', 'During composition')
    expect(editor.textContent).toBe('Original')
    fireEvent.compositionEnd(editor)
    await act(async () => { await Promise.resolve() })
    expect(mounted.code.current?.getDoc()).toBe('Original')
    expect(mounted.controller.undo()).toBe(false)
  })

  it('accepts Word HTML accompanied by its native clipboard preview file', async () => {
    const mounted = mountDocument('Target')
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    paste(proseMirror(mounted.root.container), '<html><head>\r\n<meta charset="utf-8">\r\n<link rel="File-List" href="file:///unread.xml">\r\n<style>p.MsoNormal{font-family:Arial}</style>\r\n' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View></w:WordDocument></xml><![endif]-->' +
      '<!--[if gte mso 10]><style>table.MsoNormalTable{font-family:Arial}</style><![endif]-->' +
      '</head><body><!--StartFragment--><h1><span lang="vi">Báo cáo<o:p></o:p></span></h1>' +
      '<p class="MsoNormal"><b style="mso-bidi-font-weight:normal">Important details</b></p>' +
      '<table><thead><tr><td><p>Milestone</p></td><td><p align="center" style="text-align:center">Status</p></td></tr></thead>' +
      '<tr><td><p>Empty\r\n  cell</p></td><td><p align="center" style="text-align:center"><span><o:p>&nbsp;</o:p></span></p></td></tr></table>' +
      '<p><span><o:p>&nbsp;</o:p></span></p><!--EndFragment--></body></html>',
      'Báo cáo\r\nImportant details\r\nMilestone\tStatus\r\nEmpty cell\t',
      [new File(['preview'], 'clipboard.png', { type: 'image/png' })])
    await waitFor(() => expect(mounted.code.current?.getDoc()).toContain('**Important details**'))
    expect(mounted.refused).not.toHaveBeenCalled()
    expect(proseMirror(mounted.root.container).querySelectorAll('table tr')).toHaveLength(2)
    expect(proseMirror(mounted.root.container).querySelectorAll('img')).toHaveLength(0)
  })

  it('inserts an inline rich fragment into the current paragraph', async () => {
    const mounted = mountDocument('Before after')
    act(() => mounted.rich.current?.syncSource('Before after', { from: 7, to: 7 }))
    paste(proseMirror(mounted.root.container), '<b>bold</b> ', 'bold ')
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Before **bold** after'))
    expect(proseMirror(mounted.root.container).querySelectorAll('p')).toHaveLength(1)
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Before after'))
  })

  it('pastes Word plain text containing CRLF, table tabs and trailing blank lines', () => {
    const mounted = mountDocument('Target')
    const editor = proseMirror(mounted.root.container)
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    fireEvent.keyDown(editor, { ctrlKey: true, shiftKey: true, key: 'V' })
    paste(editor, '<p>Word HTML</p>', 'Báo cáo hoạt động\r\nThis document checks the rich editor export. Important details keep their emphasis.\r\nMilestone\tStatus\r\nDocument controls\tReady for review\r\nSave and recovery\tVerified\r\nEmpty cell\t\r\n\r\n')
    expect(mounted.refused.mock.calls).toEqual([])
    expect(editor.textContent).toContain('Empty cell')
    expect(editor.querySelectorAll('table')).toHaveLength(0)
  })

  it('does not delete the selection for a metadata-only clipboard', () => {
    const mounted = mountDocument('Original')
    act(() => mounted.rich.current?.syncSource('Original', { from: 0, to: 8 }))
    paste(proseMirror(mounted.root.container), '<meta charset="utf-8"><script>ignored()</script>')
    expect(mounted.code.current?.getDoc()).toBe('Original')
    expect(mounted.controller.undo()).toBe(false)
  })

  it('refuses clipboard files without inserting accompanying text', () => {
    const mounted = mountDocument('Original')
    paste(proseMirror(mounted.root.container), '', 'image.png', [new File(['bytes'], 'image.png')])
    expect(mounted.code.current?.getDoc()).toBe('Original')
    expect(mounted.pasteFeedback).toHaveBeenLastCalledWith('refused')
  })
  it('preserves ordinary ampersands through formatting and rich paste without rewriting their source', async () => {
    const source = 'Research & Development'
    const mounted = mountDocument(source)
    act(() => mounted.rich.current?.syncSource(source, { from: 0, to: source.length }))
    act(() => { expect(mounted.rich.current?.command('bold')).toBe(true) })
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('**Research & Development**'))
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source))
    act(() => mounted.rich.current?.syncSource(source, { from: 0, to: source.length }))
    paste(proseMirror(mounted.root.container), '<p>AT&amp;T</p>', 'AT&T')
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('AT&T'))
  })

  it('offers text from a refused paste without reading the clipboard again, as one Undo unit', async () => {
    const mounted = mountDocument('Target')
    const editor = proseMirror(mounted.root.container)
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    paste(editor, '<p><img src="https://example.invalid/image">Plain</p>', 'Plain **literal**')
    expect(mounted.pasteFeedback).toHaveBeenLastCalledWith('refused', true)
    expect(mounted.code.current?.getDoc()).toBe('Target')
    act(() => expect(mounted.rich.current?.pasteWithoutFormatting()).toBe(true))
    await waitFor(() => expect(editor.textContent).toBe('Plain **literal**'))
    expect(editor.querySelector('strong')).toBeNull()
    expect(mounted.rich.current?.pasteWithoutFormatting()).toBe(false)
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('Target'))
  })

  it('expires the text-only fallback when selection, source, or enabled state changes', () => {
    const mounted = mountDocument('Target')
    const editor = proseMirror(mounted.root.container)

    for (const change of [
      () => mounted.rich.current?.syncSource('Target', { from: 1, to: 1 }),
      () => mounted.rich.current?.command('heading', 2),
      () => mounted.rerender(false)
    ]) {
      paste(editor, '<img src="unread.png">', 'Plain')
      act(() => { change() })
      const unchanged = mounted.code.current?.getDoc()
      act(() => expect(mounted.rich.current?.pasteWithoutFormatting()).toBe(false))
      expect(mounted.code.current?.getDoc()).toBe(unchanged)
    }
  })

  it('reports transaction-gate paste refusals with paste feedback, without changing the source', () => {
    const mounted = mountDocument('Target')
    act(() => mounted.rich.current?.syncSource('Target', { from: 0, to: 6 }))
    paste(proseMirror(mounted.root.container), '<p>1. First</p>', '1. First')
    expect(mounted.code.current?.getDoc()).toBe('Target')
    expect(mounted.pasteFeedback).toHaveBeenLastCalledWith('refused', true)
    expect(mounted.refused).toHaveBeenCalled()
  })

  it('blocks external HTML drops before the live DOM parser', () => {
    const mounted = mountDocument('Target')
    const editor = proseMirror(mounted.root.container)

    const prevented = !fireEvent.drop(editor, { dataTransfer: {
      getData: (type: string) => type === 'text/html' ? '<img src="https://example.invalid/pixel">' : ''
    } })

    expect(prevented).toBe(true)
    expect(mounted.code.current?.getDoc()).toBe('Target')
    expect(editor.querySelector('img')).toBeNull()
  })

})


describe('rich document navigation integration', () => {
  afterEach(cleanup)

  it('finds visible text across marks and replaces it as literal text with canonical Undo', async () => {
    const source = '# Before\r\n\r\nfoo **bar** and foo **bar**\r\n\r\nTail unchanged.\r\n'
    const mounted = mountDocument(source)
    act(() => { expect(mounted.rich.current?.search('foo bar', 1)).toEqual({ current: 1, total: 2 }) })
    expect(mounted.code.current?.getDoc()).toBe(source)
    expect(proseMirror(mounted.root.container).querySelectorAll('.document-search-current').length).toBeGreaterThan(0)
    act(() => { expect(mounted.rich.current?.replaceSearchMatch('foo bar', 'new **literal**')).toBe(true) })
    await waitFor(() => expect(proseMirror(mounted.root.container).textContent).toContain('new **literal**'))
    expect(mounted.code.current?.getDoc()).toContain('Tail unchanged.\r\n')
    expect(mounted.code.current?.getDoc()).toContain('foo **bar**')
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source))
    expect(mounted.controller.undo()).toBe(false)
  })

  it('finds decoded entity text and table cells, and replaces without losing cell structure', async () => {
    const source = '| Name | Value |\n| --- | --- |\n| &amp;copy; | foo **bar** |'
    const mounted = mountDocument(source)
    act(() => { expect(mounted.rich.current?.search('&copy;', 1)).toEqual({ current: 1, total: 1 }) })
    act(() => { expect(mounted.rich.current?.replaceSearchMatch('&copy;', 'AT&T')).toBe(true) })
    await waitFor(() => expect(mounted.code.current?.getDoc()).toContain('| AT&T |'))
    act(() => { expect(mounted.rich.current?.search('foo bar', -1)).toEqual({ current: 1, total: 1 }) })
    expect(proseMirror(mounted.root.container).querySelectorAll('td')).toHaveLength(2)
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source))
  })

  it('uses literal source search only when source is active, including canonical replacement Undo', async () => {
    const source = 'foo **bar**'
    const mounted = mountDocument(source, false)
    let richActive = false
    const nav = documentNavigationController(() => mounted.code.current, () => mounted.rich.current, () => richActive, () => true)
    act(() => { expect(nav.search('**bar**', 1)).toEqual({ current: 1, total: 1 }) })
    act(() => { expect(nav.replaceSearchMatch('**bar**', '*baz*')).toBe(true) })
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe('foo *baz*'))
    expect(mounted.controller.undo()).toBe(true)
    await waitFor(() => expect(mounted.code.current?.getDoc()).toBe(source))
    richActive = true
    mounted.rerender(true)
    act(() => { expect(nav.search('**bar**', 1)).toEqual({ current: 0, total: 0 }) })
  })

  it('navigates decoded and nested headings in the rich projection without rewriting source', () => {
    const source = '# &amp;copy; **Title**\n\n> ## Nested\n\nLast'
    const mounted = mountDocument(source)
    const headings = mounted.rich.current!.getOutline()
    expect(headings.map(heading => heading.title)).toEqual(['&copy; Title', 'Nested'])
    act(() => { expect(mounted.rich.current?.navigateToHeading(headings[1]!.from)).toBe(true) })
    act(() => { expect(mounted.rich.current?.navigateToHeading(headings[0]!.from)).toBe(true) })
    expect(mounted.code.current?.getDoc()).toBe(source)
    expect(mounted.controller.undo()).toBe(false)
  })

  it('refuses navigation, replacement, commands and history changes during composition', () => {
    const source = '# Heading\n\nfoo bar'
    const mounted = mountDocument(source)
    act(() => { mounted.rich.current?.search('foo bar', 1) })
    const editor = proseMirror(mounted.root.container)
    fireEvent.compositionStart(editor)
    act(() => {
      expect(mounted.rich.current?.search('Heading', 1)).toEqual({ current: 0, total: 0 })
      expect(mounted.rich.current?.replaceSearchMatch('foo bar', 'lost')).toBe(false)
      expect(mounted.rich.current?.navigateToHeading(0)).toBe(false)
      expect(mounted.rich.current?.command('bold')).toBe(false)
    })
    expect(fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(editor, { key: 'b', code: 'KeyB', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(editor, { key: 'i', code: 'KeyI', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(mounted.code.current?.getDoc()).toBe(source)
    expect(editor.textContent).toContain('foo bar')
  })
})

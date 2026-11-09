import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MARKDOWN_LIVE_LIMITS, markdownLive, type MarkdownLiveGuard, markdownLiveTheme } from './markdown-live'

const views: EditorView[] = []

function editor(doc: string, cursor = 0, onGuard?: (guard: MarkdownLiveGuard) => void): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc,
      extensions: [markdown(), markdownLive({ onGuard }), markdownLiveTheme],
      selection: EditorSelection.cursor(cursor)
    })
  })

  views.push(view)

  return view
}

function atomic(view: EditorView): [number, number][] {
  const ranges: [number, number][] = []

  for (const source of view.state.facet(EditorView.atomicRanges)) {
    source(view).between(0, view.state.doc.length, (from, to) => {
      ranges.push([from, to])
    })
  }

  return ranges
}

function hiddenText(view: EditorView): string[] {
  return atomic(view).map(([from, to]) => view.state.sliceDoc(from, to))
}

afterEach(() => {
  views.splice(0).forEach(view => view.destroy())
  document.body.replaceChildren()
})

describe('live Markdown decorations', () => {
  it('keeps fenced code monospaced without decorating its literal Markdown', () => {
    const source = 'cursor\n```md\n# literal\n```'
    const view = editor(source)
    expect(view.dom.querySelector('.cm-markdown-code-block')).not.toBeNull()
    expect(hiddenText(view)).not.toContain('#')
    expect(view.state.doc.toString()).toBe(source)
  })
  it('hides complete syntax off-cursor and reveals the whole cursor line', () => {
    const doc = 'cursor\n# Heading\n**strong** and *em* and `code`\n> quote'
    const view = editor(doc)

    expect(hiddenText(view)).toEqual(expect.arrayContaining(['#', '**', '*', '`', '>']))
    expect(view.dom.querySelector('.cm-markdown-heading-1')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-strong')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-emphasis')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-inline-code')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-quote')).not.toBeNull()

    view.dispatch({ selection: { anchor: doc.indexOf('#') + 2 } })
    expect(hiddenText(view)).not.toContain('#')
  })

  it('styles each heading level and replaces unordered markers only', () => {
    const view = editor('cursor\n# H1\n## H2\n### H3\n- bullet\n1. ordered')
    expect(view.dom.querySelector('.cm-markdown-heading-1')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-heading-2')).not.toBeNull()
    expect(view.dom.querySelector('.cm-markdown-heading-3')).not.toBeNull()
    expect(hiddenText(view)).toContain('-')
    expect(view.dom.querySelector('.cm-markdown-list-marker')?.textContent).toBe('•')
    expect(view.state.doc.toString()).toContain('- bullet')
    expect(hiddenText(view)).not.toContain('1.')
    expect(view.dom.textContent).toContain('1. ordered')
  })

  it('hides explicit link syntax, keeps URL title, and leaves autolinks visible', () => {
    const view = editor('cursor\n[label](https://atum.vn)\n<https://example.test>')
    const link = view.dom.querySelector<HTMLElement>('.cm-markdown-link')
    expect(link?.title).toBe('https://atum.vn')
    expect(hiddenText(view).join('')).toContain('https://atum.vn')
    expect(view.dom.textContent).toContain('https://example.test')
  })

  it('does not hide fenced, indented, table, HTML, escaped, or incomplete syntax', () => {
    const doc = [
      'cursor',
      '```md',
      '**fenced**',
      '```',
      '    *indented*',
      '| a | b |',
      '| - | - |',
      '| *x* | **y** |',
      '<div>**html**</div>',
      '\\*escaped*',
      '**incomplete'
    ].join('\n')

    const view = editor(doc)
    const hiddenSyntax = hiddenText(view).join('')
    expect(hiddenSyntax).not.toContain('fenced')
    expect(hiddenSyntax).not.toContain('indented')
    expect(hiddenSyntax).not.toContain('html')
    expect(view.dom.textContent).toContain('**incomplete')
    expect(view.dom.textContent).toContain('\\*escaped*')
  })

  it('makes exactly replace-decorated ranges atomic', () => {
    const doc = 'cursor\n# H\n**bold**\n- item'
    const view = editor(doc)
    const atomicText = hiddenText(view)
    expect(atomicText.sort()).toEqual(['#', '**', '**', '-'].sort())
    expect(atomicText).not.toContain('H')
    expect(atomicText).not.toContain('bold')
    expect(atomicText).not.toContain('item')
  })

  it('freezes structural replacements during composition, reveals, then recomputes', () => {
    const doc = '# active\n**other**'
    const view = editor(doc, 2)
    const before = Number(view.dom.dataset.markdownLiveBuilds)

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(hiddenText(view)).not.toContain('#')
    view.dispatch({ changes: { from: 3, insert: '*' } })
    expect(Number(view.dom.dataset.markdownLiveBuilds)).toBe(before + 1)

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    expect(Number(view.dom.dataset.markdownLiveBuilds)).toBe(before + 2)
  })

  it('does not rebuild for cursor moves within the same revealed line', () => {
    const view = editor('same line\n**hidden**', 1)
    const builds = view.dom.dataset.markdownLiveBuilds
    view.dispatch({ selection: { anchor: 5 } })
    expect(view.dom.dataset.markdownLiveBuilds).toBe(builds)
  })

  it('reports guard verdict flips and skips decoration work for large fixtures', () => {
    const onGuard = vi.fn()
    const twoHundredKb = `${'# heading\n'.repeat(20 * 1024)}x`
    const started = performance.now()
    const view = editor(twoHundredKb, 0, onGuard)
    const elapsed = performance.now() - started
    expect(twoHundredKb.length).toBeGreaterThan(200 * 1024)
    expect(onGuard).toHaveBeenCalledWith(expect.objectContaining({ tooLarge: true }))
    expect(view.dom.querySelector('[class*="cm-markdown-"]')).toBeNull()
    // Smoke bound only: the guard path builds nothing; a tight budget flakes under CI load.
    expect(Number(view.dom.dataset.markdownLiveBuildMs)).toBeLessThan(250)
    expect(elapsed).toBeGreaterThan(0)

    const small = '# ok'
    view.dispatch({ changes: { from: 0, insert: small, to: view.state.doc.length } })
    expect(onGuard).toHaveBeenLastCalledWith({ docLength: small.length, longestLine: small.length, tooLarge: false })
  })

  it('guards a 50 KB single line within the smoke bound', () => {
    const onGuard = vi.fn()
    const longLine = 'x'.repeat(50 * 1024)
    const started = performance.now()
    editor(longLine, 0, onGuard)
    const elapsed = performance.now() - started
    expect(longLine.length).toBeGreaterThan(MARKDOWN_LIVE_LIMITS.maxLineLength)
    expect(onGuard).toHaveBeenCalledWith({ docLength: longLine.length, longestLine: longLine.length, tooLarge: true })
    expect(Number(views.at(-1)?.dom.dataset.markdownLiveBuildMs)).toBeLessThan(250)
    expect(elapsed).toBeGreaterThan(0)
  })
})

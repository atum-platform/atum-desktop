import { history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import {
  activeFormats,
  cycleHeading,
  insertLink,
  insertTable,
  markdownKeymap,
  setHeading,
  toggleBulletList,
  toggleCodeBlock,
  toggleEmphasis,
  toggleInlineCode,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleStrong
} from './markdown-commands'

const views: EditorView[] = []

function editor(doc: string, from = 0, to = from, extensions: Extension = []) {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), history(), extensions],
      selection: EditorSelection.single(from, to)
    })
  })

  views.push(view)

  return view
}

afterEach(() => {
  views.splice(0).forEach(view => view.destroy())
  document.body.replaceChildren()
})

describe('Markdown formatting commands', () => {
  it('applies Normal and Heading 1–6 without disturbing inline text, and undoes exactly', () => {
    const original = '> ## **Tiếng Việt**\n\nkeep'
    const view = editor(original, 8)
    setHeading(6)(view)
    expect(view.state.doc.toString()).toBe('> ###### **Tiếng Việt**\n\nkeep')
    expect(activeFormats(view.state).heading).toBe(6)
    setHeading(0)(view)
    expect(view.state.doc.toString()).toBe('> **Tiếng Việt**\n\nkeep')
    undo(view)
    expect(view.state.doc.toString()).toBe('> ###### **Tiếng Việt**\n\nkeep')
    undo(view)
    expect(view.state.doc.toString()).toBe(original)
  })

  it('refuses paragraph styles within fenced code', () => {
    const source = '```md\n## literal\n```'
    const view = editor(source, 10)
    expect(setHeading(2)(view)).toBe(false)
    expect(activeFormats(view.state).heading).toBe(0)
    expect(view.state.doc.toString()).toBe(source)
  })
  it('cycles headings on every touched line and preserves structural prefixes', () => {
    const original = '> - # Một\n  > ## Hai\n### Ba'
    const view = editor(original, 0, original.length)

    cycleHeading(view)
    expect(view.state.doc.toString()).toBe('> - ## Một\n  > ### Hai\nBa')
    cycleHeading(view)
    expect(view.state.doc.toString()).toBe('> - ### Một\n  > Hai\n# Ba')
  })

  it('wraps Vietnamese words using Unicode boundaries and is byte-exact', () => {
    const precomposed = editor('Tiếng Việt', 2)
    toggleStrong(precomposed)
    expect(precomposed.state.doc.toString()).toBe('**Tiếng** Việt')

    const combiningText = `Tie\u0302\u0301ng Vie\u0323\u0302t`
    const combining = editor(combiningText, 3)
    toggleEmphasis(combining)
    expect(combining.state.doc.toString()).toBe(`*Tie\u0302\u0301ng* Vie\u0323\u0302t`)
  })

  it('inserts paired marks in whitespace with the cursor between them', () => {
    const view = editor('a  b', 2)
    toggleStrong(view)
    expect(view.state.doc.toString()).toBe('a **** b')
    expect(view.state.selection.main.head).toBe(4)
  })

  it('unwraps a containing mark for exact, partial, and nested selections', () => {
    const exact = editor('**Tiếng Việt**', 2, 12)
    toggleStrong(exact)
    expect(exact.state.doc.toString()).toBe('Tiếng Việt')

    const partial = editor('**Tiếng Việt**', 4, 7)
    toggleStrong(partial)
    expect(partial.state.doc.toString()).toBe('Tiếng Việt')

    const nested = editor('***đậm nghiêng***', 4, 7)
    toggleEmphasis(nested)
    expect(nested.state.doc.toString()).toBe('**đậm nghiêng**')
  })

  it('toggles bullets line-wise while preserving quotes and text', () => {
    const view = editor('> một\n  > hai', 0, 13)
    toggleBulletList(view)
    expect(view.state.doc.toString()).toBe('> - một\n  > - hai')
    toggleBulletList(view)
    expect(view.state.doc.toString()).toBe('> một\n  > hai')
  })

  it('creates links and selects the intended placeholder', () => {
    const selected = editor('Tiếng Việt', 0, 5)
    insertLink(selected)
    expect(selected.state.doc.toString()).toBe('[Tiếng](url) Việt')
    expect(selected.state.sliceDoc(selected.state.selection.main.from, selected.state.selection.main.to)).toBe('url')

    const empty = editor('', 0)
    insertLink(empty)
    expect(empty.state.doc.toString()).toBe('[văn bản](url)')
    expect(empty.state.sliceDoc(empty.state.selection.main.from, empty.state.selection.main.to)).toBe('văn bản')
  })

  it('selects an existing link URL instead of nesting', () => {
    const view = editor('[nhãn](https://atum.vn)', 3)
    insertLink(view)
    expect(view.state.doc.toString()).toBe('[nhãn](https://atum.vn)')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('https://atum.vn')
  })

  it.each([
    ['strong', toggleStrong, 'Tiếng Việt', 2, '**Tiếng** Việt'],
    ['emphasis', toggleEmphasis, 'Tiếng Việt', 2, '*Tiếng* Việt'],
    ['heading', cycleHeading, 'Tiếng Việt', 0, '# Tiếng Việt'],
    ['list', toggleBulletList, 'Tiếng Việt', 0, '- Tiếng Việt'],
    ['link', insertLink, 'Tiếng Việt', 0, '[văn bản](url)Tiếng Việt']
  ])('records %s as one undo step', (_name, command, doc, cursor, formatted) => {
    const view = editor(doc, cursor)
    command(view)
    expect(view.state.doc.toString()).toBe(formatted)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
    expect(undo(view)).toBe(false)
  })

  it('runs editor-owned key bindings', () => {
    const cases = [
      ['b', 'x', '**x**'],
      ['i', 'x', '*x*'],
      ['8', 'x', '- x', { shiftKey: true }],
      ['k', '', '[văn bản](url)']
    ] as const

    for (const [key, doc, result, modifiers = {}] of cases) {
      const view = editor(doc, 0, 0, keymap.of(markdownKeymap))

      const prevented = !view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key, ...modifiers })
      )

      expect(prevented).toBe(true)
      expect(view.state.doc.toString()).toBe(result)
    }
  })

  it('reports formats at the primary selection head', () => {
    const doc = '# **đậm** và *nghiêng* [link](url)\n- mục'
    const view = editor(doc, doc.indexOf('đậm') + 1)
    expect(activeFormats(view.state)).toEqual({
      code: false,
      codeBlock: false,
      emphasis: false,
      heading: 1,
      link: false,
      list: false,
      strong: true,
      orderedList: false,
      quote: false,
      strikethrough: false
    })

    view.dispatch({ selection: { anchor: doc.indexOf('nghiêng') + 1 } })
    expect(activeFormats(view.state).emphasis).toBe(true)
    view.dispatch({ selection: { anchor: doc.indexOf('link') + 1 } })
    expect(activeFormats(view.state).link).toBe(true)
    view.dispatch({ selection: { anchor: doc.indexOf('mục') } })
    expect(activeFormats(view.state).list).toBe(true)
  })

  it('treats the trailing word boundary as whitespace and the leading boundary as the word', () => {
    const afterWord = editor('một hai', 3)
    toggleStrong(afterWord)
    expect(afterWord.state.doc.toString()).toBe('một**** hai')
    expect(afterWord.state.selection.main.head).toBe(5)

    const leading = editor('một hai', 4)
    toggleStrong(leading)
    expect(leading.state.doc.toString()).toBe('một **hai**')

    const combining = editor('tiê\u0301ng Việt', 0)
    toggleEmphasis(combining)
    expect(combining.state.doc.toString()).toBe('*tiê\u0301ng* Việt')

    const endOfLine = editor('xin chào', 8)
    toggleEmphasis(endOfLine)
    expect(endOfLine.state.doc.toString()).toBe('xin chào**')
  })
})

describe('the constructs A4 completes', () => {
  it('toggles strikethrough and inline code like the other inline marks', () => {
    const view = editor('xin chào', 0, 3)
    toggleStrikethrough(view)
    expect(view.state.doc.toString()).toBe('~~xin~~ chào')
    expect(activeFormats(view.state).strikethrough).toBe(true)
    toggleStrikethrough(view)
    expect(view.state.doc.toString()).toBe('xin chào')

    const code = editor('gọi hàm', 4, 7)
    toggleInlineCode(code)
    expect(code.state.doc.toString()).toBe('gọi `hàm`')
    expect(activeFormats(code.state).code).toBe(true)
    toggleInlineCode(code)
    expect(code.state.doc.toString()).toBe('gọi hàm')
  })

  it('numbers and quotes line-wise, and unwraps when every touched line already has it', () => {
    const view = editor('một\nhai', 0, 7)
    toggleOrderedList(view)
    expect(view.state.doc.toString()).toBe('1. một\n1. hai')
    expect(activeFormats(view.state).orderedList).toBe(true)
    toggleOrderedList(view)
    expect(view.state.doc.toString()).toBe('một\nhai')

    const quote = editor('- mục', 0)
    toggleQuote(quote)
    expect(quote.state.doc.toString()).toBe('> - mục')
    expect(activeFormats(quote.state).quote).toBe(true)
    expect(activeFormats(quote.state).list).toBe(true)
    toggleQuote(quote)
    expect(quote.state.doc.toString()).toBe('- mục')
  })

  it('fences the touched lines and removes only the fence lines on the way back', () => {
    const view = editor('a\nb', 0, 3)
    toggleCodeBlock(view)
    expect(view.state.doc.toString()).toBe('```\na\nb\n```')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('a\nb')
    expect(activeFormats(view.state).codeBlock).toBe(true)
    toggleCodeBlock(view)
    expect(view.state.doc.toString()).toBe('a\nb')
  })

  it('inserts a table as its own block and selects the first header cell', () => {
    const view = editor('văn bản', 7)
    insertTable({ column: 'Cột' })(view)
    expect(view.state.doc.toString()).toBe('văn bản\n\n| Cột 1 | Cột 2 |\n| --- | --- |\n|  |  |')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('Cột 1')
  })

  it('binds the new shortcuts', () => {
    const keys = markdownKeymap.map(binding => binding.key)
    expect(keys).toEqual(expect.arrayContaining(['Mod-Shift-x', 'Mod-e', 'Mod-Shift-7', 'Mod-Shift-9']))
  })
})

describe('the constructs produce real nodes, not just text', () => {
  const hasNode = (view: EditorView, name: string) => {
    let found = false
    syntaxTree(view.state).iterate({
      enter: node => {
        if (node.name === name) {
          found = true
        }
      }
    })

    return found
  }

  it('picks a code-span delimiter longer than any backtick run in the content', () => {
    const view = editor('call(`x`)', 0, 9)
    toggleInlineCode(view)
    expect(view.state.doc.toString()).toBe('``call(`x`)``')
    expect(hasNode(view, 'InlineCode')).toBe(true)
    toggleInlineCode(view)
    expect(view.state.doc.toString()).toBe('call(`x`)')

    const edge = editor('`a', 0, 2)
    toggleInlineCode(edge)
    expect(edge.state.doc.toString()).toBe('`` `a ``')
    expect(hasNode(edge, 'InlineCode')).toBe(true)
  })

  it('fences with a longer run when the body already contains a fence line', () => {
    const view = editor('a\n```\nb', 0, 7)
    toggleCodeBlock(view)
    expect(view.state.doc.toString()).toBe('````\na\n```\nb\n````')
    expect(hasNode(view, 'FencedCode')).toBe(true)
  })

  it('inserts a table after the enclosing block, never inside a fence or a list item', () => {
    const fenced = editor('```\ncode\n```', 5)
    insertTable({ column: 'Column' })(fenced)
    expect(fenced.state.doc.toString()).toBe('```\ncode\n```\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |')
    expect(hasNode(fenced, 'Table')).toBe(true)

    const listed = editor('- one\n- two', 8)
    insertTable({ column: 'Column' })(listed)
    expect(hasNode(listed, 'Table')).toBe(true)
    expect(listed.state.doc.toString().startsWith('- one\n- two\n\n|')).toBe(true)
  })
})

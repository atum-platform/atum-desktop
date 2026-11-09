import { undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { comboOwnedByLocalScope } from '@/lib/keybinds/combo'

import { CodeEditor, type CodeEditorApi } from './code-editor'

vi.mock('@/themes/context', () => ({
  useTheme: () => ({ resolvedMode: 'light' })
}))

describe('CodeEditor', () => {
  it('keeps CRLF source offsets and Undo while a rich projection owns input', () => {
    const source = '# Title\r\n\r\nBefore **bold** text.  \r\n'
    const apiRef = createRef<CodeEditorApi | null>()
    const onChange = vi.fn()

    const { container } = render(
      <CodeEditor
        apiRef={apiRef}
        filePath="document.md"
        initialValue={source}
        inputDisabled
        onChange={onChange}
        preserveLineEndings
      />
    )

    expect(apiRef.current?.getDoc()).toBe(source)
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    const from = source.indexOf('bold')
    apiRef.current?.dispatchCommand(view => {
      view.dispatch({ changes: { from, to: from + 4, insert: 'stronger' }, selection: { anchor: from + 8 } })

      return true
    })
    expect(onChange).toHaveBeenLastCalledWith(source.replace('bold', 'stronger'))
    expect(apiRef.current?.dispatchCommand(undo)).toBe(true)
    expect(apiRef.current?.getDoc()).toBe(source)
  })
  it('publishes the mapped selection and current document after a changing transaction', () => {
    const apiRef = createRef<CodeEditorApi | null>()
    const onSelectionChange = vi.fn()

    render(
      <CodeEditor
        apiRef={apiRef}
        filePath="note.txt"
        initialValue="abc"
        onChange={() => undefined}
        onSelectionChange={onSelectionChange}
      />
    )

    expect(
      apiRef.current?.dispatchCommand(view => {
        view.dispatch({ changes: { from: 0, insert: 'x' }, selection: { anchor: 2, head: 3 } })

        return true
      })
    ).toBe(true)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ documentText: 'xabc', from: 2, to: 3 })
    expect(apiRef.current?.getDoc()).toBe('xabc')
    expect(apiRef.current?.getSelection()).toEqual({ from: 2, to: 3 })
  })

  it('installs the Markdown parser synchronously in live mode', () => {
    const apiRef = createRef<CodeEditorApi | null>()

    render(
      <CodeEditor apiRef={apiRef} filePath="note.md" initialValue="# Tiêu đề" liveMarkdown onChange={() => undefined} />
    )

    let tree = ''
    apiRef.current?.dispatchCommand(view => {
      tree = syntaxTree(view.state).toString()

      return true
    })
    expect(tree).toContain('ATXHeading1')
  })

  it('claims exact local chords only while focus is inside the editor', () => {
    const shellAction = vi.fn()

    const { container } = render(
      <div>
        <CodeEditor filePath="note.md" initialValue="text" localKeybinds={['mod+b']} onChange={() => undefined} />
        <button type="button">outside</button>
      </div>
    )

    const content = container.querySelector<HTMLElement>('.cm-content')!
    const host = content.parentElement?.parentElement?.parentElement as HTMLElement
    const outside = container.querySelector('button')!

    const dispatchShellAction = (target: EventTarget) => {
      if (!comboOwnedByLocalScope(target, 'mod+b')) {
        shellAction()
      }
    }

    expect(host.dataset.localKeybinds).toBe('mod+b')

    dispatchShellAction(content)
    expect(shellAction).not.toHaveBeenCalled()

    outside.focus()
    expect(host.hasAttribute('data-local-keybinds')).toBe(false)
    dispatchShellAction(outside)
    expect(shellAction).toHaveBeenCalledTimes(1)
  })

  it('publishes the initial selection on mount', () => {
    const onSelectionChange = vi.fn()
    render(
      <CodeEditor
        filePath="note.md"
        initialValue="# a"
        liveMarkdown
        onChange={() => undefined}
        onSelectionChange={onSelectionChange}
      />
    )
    expect(onSelectionChange).toHaveBeenCalledWith({ documentText: '# a', from: 0, to: 0 })
  })

  it('keeps one CodeMirror instance, buffer, selection and history while presentation and keymap change', () => {
    const apiRef = createRef<CodeEditorApi | null>()
    const wrap = [EditorView.lineWrapping, EditorView.theme({ '.cm-gutters': { display: 'none' } })]

    const view = render(
      <CodeEditor
        apiRef={apiRef}
        filePath="note.md"
        initialValue="# Tiêu đề"
        liveMarkdown
        onChange={() => undefined}
        presentation={wrap}
      />
    )

    const editorNode = view.container.querySelector('.cm-editor')
    expect(editorNode).toBeTruthy()
    apiRef.current?.dispatchCommand(v => {
      v.dispatch({ changes: { from: v.state.doc.length, insert: ' mới' }, selection: { anchor: 2, head: 6 } })

      return true
    })

    view.rerender(
      <CodeEditor
        apiRef={apiRef}
        extraKeymap={[{ key: 'Mod-b', run: () => true }]}
        filePath="note.md"
        initialValue="# Tiêu đề"
        liveMarkdown
        onChange={() => undefined}
        presentation={[]}
      />
    )
    expect(view.container.querySelector('.cm-editor')).toBe(editorNode)
    expect(apiRef.current?.getDoc()).toBe('# Tiêu đề mới')
    expect(apiRef.current?.getSelection()).toEqual({ from: 2, to: 6 })
    expect(apiRef.current?.dispatchCommand(undo)).toBe(true)
    expect(apiRef.current?.getDoc()).toBe('# Tiêu đề')
  })
})

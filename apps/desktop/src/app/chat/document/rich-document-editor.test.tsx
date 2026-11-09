import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveDocumentTheme } from '../../../../shared/atum-office/document-theme'

import type { DocumentEditorController, RichDocumentEditorApi } from './document-editor-controller'
import { RichDocumentEditor } from './rich-document-editor'

const rect = { bottom: 1, height: 1, left: 0, right: 1, top: 0, width: 1, x: 0, y: 0, toJSON: () => ({}) }
Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(Node.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(window, 'scrollBy', { configurable: true, value: () => undefined })

interface TestController {
  controller: DocumentEditorController
  source: () => string
}

function testController(source = 'Alpha'): TestController {
  let current = source

  const controller: DocumentEditorController = {
    commit: request => {
      if (request.expectedSource !== current) {
        return false
      }

      current = current.slice(0, request.patch.from) + request.patch.insert + current.slice(request.patch.to)

      return true
    },
    getSource: () => current,
    redo: vi.fn(() => true),
    select: vi.fn(),
    undo: vi.fn(() => true)
  }

  return { controller, source: () => current }
}

function props(overrides: Partial<React.ComponentProps<typeof RichDocumentEditor>> = {}) {
  const test = testController()

  return {
    apiRef: createRef<RichDocumentEditorApi | null>(),
    controller: test.controller,
    enabled: true,
    initialValue: 'Alpha',
    labels: { editor: 'Rich editor', refused: 'Use source editor' },
    theme: resolveDocumentTheme(null),
    zoom: 'fit' as const,
    ...overrides,
    test
  }
}

function content(container: HTMLElement): HTMLElement {
  const editor = container.querySelector<HTMLElement>('.ProseMirror')

  if (!editor) {
    throw new Error('ProseMirror view did not mount')
  }

  return editor
}

describe('RichDocumentEditor', () => {
  afterEach(cleanup)

  it('mounts a real EditorView and atomically commits a rich formatting transaction to the source controller', () => {
    const setup = props()
    const formats = vi.fn()
    const result = render(<RichDocumentEditor {...setup} onFormatsChange={formats} />)

    expect(content(result.container).textContent).toBe('Alpha')
    expect(setup.apiRef.current?.command('heading', 2)).toBe(true)
    expect(setup.test.source()).toBe('## Alpha')
    expect(setup.controller.select).toHaveBeenCalled()
    expect(formats).toHaveBeenCalled()
  })

  it('uses normal EditorView DOM input and publishes the mapped canonical patch before updating the view', async () => {
    const setup = props()
    const result = render(<RichDocumentEditor {...setup} />)
    const editor = content(result.container)
    editor.focus()
    editor.textContent = 'Alphax'
    fireEvent.input(editor, { data: 'x', inputType: 'insertText' })

    await waitFor(() => expect(setup.test.source()).toBe('Alphax'))
    expect(editor.textContent).toBe('Alphax')
  })

  it('routes source-history chords to the controller without installing ProseMirror history', () => {
    const setup = props()
    const result = render(<RichDocumentEditor {...setup} />)
    const editor = content(result.container)

    fireEvent.keyDown(editor, { ctrlKey: true, key: 'z' })
    fireEvent.keyDown(editor, { ctrlKey: true, key: 'z', shiftKey: true })
    fireEvent.keyDown(editor, { ctrlKey: true, key: 'y' })

    expect(setup.controller.undo).toHaveBeenCalledTimes(1)
    expect(setup.controller.redo).toHaveBeenCalledTimes(2)
  })

  it('replaces from external source without writing it back, and makes unsupported replacement unavailable', () => {
    const setup = props()
    const eligibility = vi.fn()
    const result = render(<RichDocumentEditor {...setup} onEligibility={eligibility} />)

    act(() => setup.apiRef.current?.syncSource('# Replaced', { from: 2, to: 2 }))
    expect(content(result.container).textContent).toBe('Replaced')
    expect(setup.test.source()).toBe('Alpha')

    act(() => setup.apiRef.current?.syncSource('<script>bad()</script>', { from: 0, to: 0 }))
    expect(screen.getByRole('status').textContent).toBe('Use source editor')
    expect(eligibility).toHaveBeenLastCalledWith(false)
    expect(setup.apiRef.current?.command('bold')).toBe(false)
  })

  it('reports a rejected source commit as a failed command without changing the visible document', () => {
    const setup = props()
    setup.controller.commit = vi.fn(() => false)
    const refused = vi.fn()
    const result = render(<RichDocumentEditor {...setup} onRefused={refused} />)

    expect(setup.apiRef.current?.command('heading', 1)).toBe(false)
    expect(content(result.container).querySelector('h1')).toBeNull()
    expect(content(result.container).textContent).toBe('Alpha')
    expect(setup.test.source()).toBe('Alpha')
    expect(refused).toHaveBeenCalledOnce()
  })

  it('shows the marks inside a nonempty selection, including its opening boundary', () => {
    const source = '**Bold** and plain'
    const formats = vi.fn()
    const setup = props({ initialValue: source, onFormatsChange: formats })
    render(<RichDocumentEditor {...setup} />)

    act(() => setup.apiRef.current?.syncSource(source, { from: 2, to: 6 }))
    expect(formats).toHaveBeenLastCalledWith(expect.objectContaining({ strong: true, emphasis: false }))
  })

  it('restores browser DOM input when source authority refuses its transaction', async () => {
    const setup = props()
    setup.controller.commit = vi.fn(() => false)
    const refused = vi.fn()
    const result = render(<RichDocumentEditor {...setup} onRefused={refused} />)
    const editor = content(result.container)
    editor.focus()
    editor.querySelector('p')!.firstChild!.textContent = 'Alphax'
    fireEvent.input(editor, { data: 'x', inputType: 'insertText' })

    await waitFor(() => expect(refused).toHaveBeenCalled())
    expect(editor.textContent).toBe('Alpha')
    expect(setup.test.source()).toBe('Alpha')
  })

  it('holds composition changes outside source history until composition ends', async () => {
    const setup = props()
    const composition = vi.fn()
    const refused = vi.fn()
    const result = render(<RichDocumentEditor {...setup} onCompositionChange={composition} onRefused={refused} />)
    const editor = content(result.container)

    editor.focus()
    fireEvent.compositionStart(editor)
    editor.querySelector('p')!.firstChild!.textContent = 'Alphaế'
    fireEvent.input(editor, { data: 'ế', inputType: 'insertCompositionText', isComposing: true })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(editor.textContent).toBe('Alphaế')
    expect(setup.test.source()).toBe('Alpha')
    fireEvent.compositionEnd(editor)

    await act(async () => {
      await Promise.resolve()
    })
    expect(refused).not.toHaveBeenCalled()
    await waitFor(() => expect(setup.test.source()).toBe('Alphaế'))
    expect(composition).toHaveBeenCalledWith(true)
    expect(composition).toHaveBeenLastCalledWith(false)
  })

  it('reveals a search match in its own viewport while focus stays in Find', () => {
    const setup = props()
    const result = render(<><input aria-label="Find" /><RichDocumentEditor {...setup} /></>)
    const viewport = result.container.querySelector<HTMLElement>('.atum-rich-document-editor')!
    const bounds = vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ ...rect, top: 0, bottom: 100, height: 100 })
    const target = { ...rect, top: 240, bottom: 256, height: 16 }
    const rangeRects = vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([target] as unknown as DOMRectList)
    const rangeBounds = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(target)
    const find = screen.getByRole('textbox', { name: 'Find' })
    find.focus()

    try {
      expect(setup.apiRef.current?.search('Alpha', 1)).toEqual({ current: 1, total: 1 })
      expect(viewport.scrollTop).toBeGreaterThan(0)
      expect(globalThis.document.activeElement).toBe(find)
      expect(setup.test.source()).toBe('Alpha')
    } finally {
      bounds.mockRestore()
      rangeRects.mockRestore()
      rangeBounds.mockRestore()
    }
  })

  it('refuses commands and HTML clipboard content while disabled or unsafe', () => {
    const setup = props({ enabled: false })
    const result = render(<RichDocumentEditor {...setup} />)
    const editor = content(result.container)

    expect(setup.apiRef.current?.command('heading', 1)).toBe(false)
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (kind: string) => (kind === 'text/html' ? '<img src="https://example.test/x">' : 'plain')
      }
    })
    expect(setup.test.source()).toBe('Alpha')
  })
})

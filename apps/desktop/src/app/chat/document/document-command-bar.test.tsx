import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentCommandBar } from './document-command-bar'
import type { DocumentCommandBarProps } from './document-command-types'

const observers = new Set<TestResizeObserver>()

class TestResizeObserver {
  private node: Element | null = null

  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }

  disconnect() {
    observers.delete(this)
  }

  observe(node: Element) {
    this.node = node
  }

  unobserve() {}

  resize(width: number) {
    if (!this.node) {
      return
    }

    this.callback(
      [{ contentRect: { width }, target: this.node } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)

function resizeDocumentToolbar(width: number) {
  act(() => {
    for (const observer of observers) {
      observer.resize(width)
    }
  })
}

const labels = {
  insert: 'Insert',
  more: 'More',
  page: 'Page',
  style: 'Style',
  toolbar: 'Document commands',
  view: 'View',
  write: 'Write'
}

function command(id: string, label: string, run = vi.fn()) {
  return { icon: <span aria-hidden>{label.slice(0, 1)}</span>, id, label, run }
}

function props(overrides: Partial<DocumentCommandBarProps> = {}): DocumentCommandBarProps {
  return {
    commands: {
      insert: [command('link', 'Link')],
      page: [command('theme', 'Theme')],
      view: [command('find', 'Find')],
      write: [
        command('undo', 'Undo'),
        command('redo', 'Redo'),
        command('bold', 'Bold'),
        command('italic', 'Italic'),
        command('bullets', 'Bullets'),
        command('numbered-list', 'Numbered list'),
        command('quote', 'Quote')
      ]
    },
    documentMenu: <button aria-label="Document menu">Menu</button>,
    heading: 0,
    labels,
    onHeading: vi.fn(),
    pageControls: <button>Page control</button>,
    status: 'Saved',
    styles: [
      { label: 'Normal', value: 0 },
      { label: 'Heading 1', value: 1 }
    ],
    viewControls: <button>View control</button>,
    ...overrides
  }
}

describe('DocumentCommandBar', () => {
  afterEach(() => {
    cleanup()
    observers.clear()
  })

  it('uses active, keyboard-navigable categories to show one wide command group at a time', () => {
    const onHeading = vi.fn()
    render(<DocumentCommandBar {...props({ onHeading })} />)
    resizeDocumentToolbar(800)

    const toolbar = screen.getByRole('toolbar', { name: 'Document commands' })
    expect(toolbar.dataset.documentCommandLayout).toBe('wide')
    expect(screen.getByText('Write')).toBeTruthy()
    expect(screen.getByText('Insert')).toBeTruthy()
    expect(screen.getByText('Page')).toBeTruthy()
    expect(screen.getByText('View')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Link' })).toBeNull()
    expect(screen.queryByText('Page control')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Saved')

    const insert = screen.getByRole('button', { name: 'Insert' })
    fireEvent.keyDown(insert, { key: 'ArrowRight' })
    expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: 'Page' }))
    expect(screen.getByRole('button', { name: 'Page' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Page control')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByText('View control')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Write' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Style' }))
    fireEvent.click(screen.getByRole('option', { name: 'Heading 1' }))
    expect(onHeading).toHaveBeenCalledWith(1)
  })

  it('uses roving focus for command buttons without taking select arrow keys', () => {
    render(<DocumentCommandBar {...props()} />)
    resizeDocumentToolbar(900)

    const toolbar = screen.getByRole('toolbar', { name: 'Document commands' })
    const commandButtons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('[data-document-command-button]'))
    expect(commandButtons.map(button => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])

    commandButtons[0]?.focus()
    fireEvent.keyDown(commandButtons[0]!, { key: 'ArrowRight' })
    expect(globalThis.document.activeElement).toBe(commandButtons[1])

    const style = screen.getByRole('combobox', { name: 'Style' })
    style.focus()
    fireEvent.keyDown(style, { key: 'ArrowDown' })
    expect(globalThis.document.activeElement).toBe(style)
  })

  it('moves non-frequent groups into More at compact panel widths', () => {
    const insert = command('link', 'Link')
    render(<DocumentCommandBar {...props({ commands: { ...props().commands, insert: [insert] } })} />)
    resizeDocumentToolbar(640)

    const toolbar = screen.getByRole('toolbar', { name: 'Document commands' })
    expect(toolbar.dataset.documentCommandLayout).toBe('compact')
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Link' })).toBeNull()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
    expect(screen.getByText('Page control')).toBeTruthy()
    expect(screen.getByText('View control')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link' }))
    expect(insert.run).toHaveBeenCalledTimes(1)
  })

  it('keeps style, undo/redo, More, and the save status at minimal widths', () => {
    render(<DocumentCommandBar {...props()} />)
    resizeDocumentToolbar(479)

    const toolbar = screen.getByRole('toolbar', { name: 'Document commands' })
    expect(toolbar.dataset.documentCommandLayout).toBe('minimal')
    expect(screen.getByRole('combobox', { name: 'Style' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'More' }).textContent).toContain('More')
    expect(screen.getByRole('status').textContent).toContain('Saved')
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
  })

  it('keeps More and View controls usable when formatting is disabled', () => {
    const commands = props().commands
    commands.write[0] = { ...commands.write[0]!, disabled: true }
    render(<DocumentCommandBar {...props({ commands, disabled: true })} />)
    resizeDocumentToolbar(640)

    const more = screen.getByRole('button', { name: 'More' })
    expect((more as HTMLButtonElement).disabled).toBe(false)
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false })
    expect(screen.getByText('View control')).toBeTruthy()
  })

  it('skips disabled commands while roving and keeps exactly one enabled command tab entry', () => {
    const commands = props().commands
    commands.write[0] = { ...commands.write[0]!, disabled: true }
    render(<DocumentCommandBar {...props({ commands })} />)
    resizeDocumentToolbar(900)

    const toolbar = screen.getByRole('toolbar', { name: 'Document commands' })
    const commandButtons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('[data-document-command-button]'))
    expect(commandButtons[0]?.disabled).toBe(true)
    expect(commandButtons.filter(button => !button.disabled).filter(button => button.tabIndex === 0)).toHaveLength(1)
    expect(commandButtons[1]?.tabIndex).toBe(0)
    commandButtons[1]?.focus()
    fireEvent.keyDown(commandButtons[1]!, { key: 'ArrowLeft' })
    expect(globalThis.document.activeElement).toBe(commandButtons.at(-1))
  })
})

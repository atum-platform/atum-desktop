import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, LOCALE_OPTIONS, TRANSLATIONS } from '@/i18n'
import { comboTokens } from '@/lib/keybinds/combo'
import { $appViewOverlayCount, resetAppViewOverlayForTests } from '@/store/app-view-overlay'
import { $bindings } from '@/store/keybinds'

import { MatrixCommandPalette, type MatrixPaletteAction } from './command-palette'

const originalBindings = $bindings.get()
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

function PaletteHarness({
  actions,
  onCloseAutoFocus
}: {
  actions: MatrixPaletteAction[]
  onCloseAutoFocus?: React.ComponentProps<typeof MatrixCommandPalette>['onCloseAutoFocus']
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open
      </button>
      <MatrixCommandPalette actions={actions} onCloseAutoFocus={onCloseAutoFocus} onOpenChange={setOpen} open={open} />
    </>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  $bindings.set(originalBindings)
  resetAppViewOverlayForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()

  if (scrollDescriptor) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
})

describe('MatrixCommandPalette', () => {
  it('filters the caller-provided actions and reports an honest empty result', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <PaletteHarness
          actions={[
            { id: 'matrix.compose', label: 'Compose', keywords: ['message'], run: vi.fn() },
            { id: 'matrix.settings', label: 'Settings', run: vi.fn() }
          ]}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const search = screen.getByRole('combobox')

    fireEvent.change(search, { target: { value: 'message' } })
    expect(screen.getByRole('option', { name: 'Compose' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Settings' })).toBeNull()

    fireEvent.change(search, { target: { value: 'xqzv' } })
    expect(await screen.findByText(TRANSLATIONS.en.commandCenter.noResults)).toBeTruthy()
  })

  it('searches what each entry shows, never the id it carries, and finds words typed without accents', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <PaletteHarness
          actions={[
            { id: 'room:!family:example.invalid', group: 'chats', label: 'Gia đình', run: vi.fn() },
            { id: 'room:!trip:example.invalid', group: 'chats', label: 'Trip plan', keywords: ['Plan a trip in autumn', 'Atum'], run: vi.fn() },
            { id: 'room:!linh:example.invalid', group: 'people', label: 'Linh', run: vi.fn() }
          ]}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const search = screen.getByRole('combobox')
    const shown = () => screen.queryAllByRole('option').map(option => option.textContent)

    fireEvent.change(search, { target: { value: 'gia dinh' } })
    expect(shown()).toEqual(['Gia đình'])

    // Words, not letters scattered through a title: "plan a trip in" spells l…i…n, but no word holds "lin".
    fireEvent.change(search, { target: { value: 'lin' } })
    expect(shown()).toEqual(['Linh'])

    // An assistant's history answers to the assistant's name, its keyword…
    fireEvent.change(search, { target: { value: 'atum' } })
    expect(shown()).toEqual(['Trip plan'])

    // …but no entry matches the server name inside every id.
    fireEvent.change(search, { target: { value: 'atum.chat' } })
    expect(await screen.findByText(TRANSLATIONS.en.commandCenter.noResults)).toBeTruthy()
    expect(shown()).toEqual([])
  })

  it('supports arrow-key selection and Enter', () => {
    const compose = vi.fn()
    const settings = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <PaletteHarness
          actions={[
            { id: 'matrix.compose', label: 'Compose', run: compose },
            { id: 'matrix.settings', label: 'Settings', run: settings }
          ]}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(compose).not.toHaveBeenCalled()
    expect(settings).toHaveBeenCalledTimes(1)
  })

  it('closes before running a selected action and never invokes it twice', () => {
    const run = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette
          actions={[{ id: 'matrix.compose', label: 'Compose', run }]}
          onOpenChange={onOpenChange}
          open
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('option', { name: 'Compose' }))
    fireEvent.click(screen.getByRole('option', { name: 'Compose' }))

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
  })

  it('does not rearm selection until the controlled open prop closes and opens again', () => {
    const run = vi.fn()
    const onOpenChange = vi.fn()
    const action = { id: 'matrix.compose', label: 'Compose', run }

    const { rerender } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette actions={[action]} onOpenChange={onOpenChange} open />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('option', { name: 'Compose' }))
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette actions={[action]} onOpenChange={onOpenChange} open />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('option', { name: 'Compose' }))

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets Escape dismiss only the palette layer', () => {
    const onOpenChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette actions={[]} onOpenChange={onOpenChange} open />
      </I18nProvider>
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('updates each action hint from the live saved binding', async () => {
    $bindings.set({ ...originalBindings, 'matrix.compose': ['mod+q'] })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette
          actions={[{ id: 'matrix.compose', label: 'Compose', run: vi.fn() }]}
          onOpenChange={vi.fn()}
          open
        />
      </I18nProvider>
    )

    expect(screen.getByLabelText(comboTokens('mod+q').join(' '))).toBeTruthy()

    $bindings.set({ ...$bindings.get(), 'matrix.compose': ['mod+shift+q'] })

    await waitFor(() => expect(screen.getByLabelText(comboTokens('mod+shift+q').join(' '))).toBeTruthy())
  })

  it('marks the controlled dialog for the shell blocker fence and lets its caller restore focus', async () => {
    const onCloseAutoFocus = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <PaletteHarness
          actions={[]}
          onCloseAutoFocus={event => {
            event.preventDefault()
            onCloseAutoFocus()
            window.document.querySelector<HTMLButtonElement>('button')?.focus()
          }}
        />
      </I18nProvider>
    )

    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    expect(window.document.querySelector('[data-matrix-command-palette]')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(window.document.activeElement).toBe(opener))
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1)
  })

  it('holds the native app-view overlay for the dialog lifetime and releases it after close', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <PaletteHarness actions={[]} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect($appViewOverlayCount.get()).toBeGreaterThan(0)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect($appViewOverlayCount.get()).toBe(0))
  })

  it.each(LOCALE_OPTIONS.map(({ id }) => id))('uses existing localized palette copy for %s', async locale => {
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixCommandPalette actions={[]} onOpenChange={vi.fn()} open />
      </I18nProvider>
    )

    expect(screen.getByRole('dialog', { name: TRANSLATIONS[locale].commandCenter.paletteTitle })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: TRANSLATIONS[locale].commandCenter.commands })).toBeTruthy()
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe(
      TRANSLATIONS[locale].commandCenter.paletteTitle
    )
    expect(screen.getByPlaceholderText(TRANSLATIONS[locale].commandCenter.searchPlaceholder)).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('listbox', { name: TRANSLATIONS[locale].commandCenter.commands })).toBeTruthy()
    )
  })
})

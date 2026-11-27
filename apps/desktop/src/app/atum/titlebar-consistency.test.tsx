import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { Tip } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { MatrixPanelSearch } from '@/matrix/panel-search'

import { AtumMainHeaderSurface, AtumWindowControlsSurface } from './shell-surface'

afterEach(() => cleanup())

const sideOf = async (name: string) => {
  fireEvent.pointerMove(screen.getByRole('button', { name }), { pointerType: 'mouse' })
  await screen.findByRole('tooltip')

  return window.document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')?.getAttribute('data-side')
}

// Owner 2026-11-27 (consistency audit rows 1, 2, 5–7): one title bar and one search field on every screen.
describe('the shared title bar', () => {
  it('wears the bare mark and the name "Atum", with no dark tile', () => {
    render(<AtumWindowControlsSurface onToggleSidebar={() => {}} reserveLights={false} sidebarLabel="Hide sidebar" />)

    const lockup = window.document.querySelector<HTMLElement>('[data-atum-titlebar-mark]')!
    expect(lockup.textContent).toBe('Atum')
    expect(lockup.querySelector('svg[data-atum-glyph]')).toBeTruthy()
    // The tile was BrandMark's `bg-[#141311]` image; the bare mark paints in currentColor.
    expect(lockup.querySelector('img')).toBeNull()
    expect(lockup.innerHTML).toContain('currentColor')
  })

  it('opens the tips of its right cluster to the left, so they stay in the band above a native view', async () => {
    render(
      <AtumMainHeaderSurface
        actions={
          <Tip label="Show right panel">
            <button aria-label="Show right panel" type="button" />
          </Tip>
        }
        leadsRow={false}
        reserveOverlay={false}
      >
        <Tip label="Atum info">
          <button aria-label="Atum info" type="button" />
        </Tip>
      </AtumMainHeaderSurface>
    )

    expect(await sideOf('Show right panel')).toBe('left')
  })

  it('opens the tips of its leading side to the right, and an explicit side still wins', async () => {
    render(
      <AtumMainHeaderSurface leadsRow={false} reserveOverlay={false}>
        <Tip label="Atum info">
          <button aria-label="Atum info" type="button" />
        </Tip>
      </AtumMainHeaderSurface>
    )

    expect(await sideOf('Atum info')).toBe('right')
    cleanup()

    render(
      <AtumMainHeaderSurface leadsRow={false} reserveOverlay={false}>
        <Tip label="Below" side="bottom">
          <button aria-label="Below" type="button" />
        </Tip>
      </AtumMainHeaderSurface>
    )

    expect(await sideOf('Below')).toBe('bottom')
  })
})

describe('the left panel search', () => {
  function Field() {
    const [value, setValue] = useState('')

    return <MatrixPanelSearch label="Search Drive" onValueChange={setValue} value={value} />
  }

  it('is the Kit search field, clears on Escape and on its ×', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <Field />
      </I18nProvider>
    )

    const box = window.document.querySelector<HTMLElement>('[data-atum-panel-search]')!
    expect(box.className).toContain('ak-field--search')
    expect(box.className).toContain('h-8')
    const input = within(box).getByRole('textbox', { name: 'Search Drive' }) as HTMLInputElement
    expect(input.placeholder).toBe('Search Drive')

    fireEvent.change(input, { target: { value: 'q4' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: 'q4' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Clear search' }))
    expect(input.value).toBe('')
  })
})

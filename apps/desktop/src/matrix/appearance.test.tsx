import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { atumTheme, DEFAULT_TYPOGRAPHY } from '@/themes/presets'

import { applyMatrixMaterial, MatrixAppearance } from './appearance'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.document.documentElement.dataset.atumVibrancy
})

describe('Matrix shell native appearance', () => {
  it("pins the window's native appearance to the shell's choice, so the glass matches the palette on it", async () => {
    const setWindowAppearance = vi.fn(async () => {})
    vi.stubGlobal('atumMatrix', { setWindowAppearance })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))

    const { rerender } = render(<MatrixAppearance preference="dark" />)
    rerender(<MatrixAppearance preference="dark" />)
    rerender(<MatrixAppearance preference="light" />)
    rerender(<MatrixAppearance preference="system" />)
    rerender(<MatrixAppearance />)

    // Once per change; `system` hands both the palette and the glass back to the OS.
    expect(setWindowAppearance.mock.calls).toEqual([['dark'], ['light'], ['system']])
  })

  it('does not fail where the bridge is absent or rejects', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    expect(() => render(<MatrixAppearance preference="dark" />)).not.toThrow()
    cleanup()

    vi.stubGlobal('atumMatrix', {
      setWindowAppearance: vi.fn(async () => {
        throw new Error('matrix_window_not_authorized')
      })
    })
    render(<MatrixAppearance preference="dark" />)
    await Promise.resolve()
    expect(window.document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('Matrix shell material startup', () => {
  it('follows OS changes only in system mode, while an explicit account choice overrides the OS', () => {
    let changed = () => {}

    const media = {
      matches: true,
      addEventListener: (_: string, callback: () => void) => (changed = callback),
      removeEventListener: vi.fn()
    }

    vi.stubGlobal('matchMedia', () => media)
    const { rerender } = render(<MatrixAppearance preference="light" />)
    expect(window.document.documentElement.classList.contains('dark')).toBe(false)
    rerender(<MatrixAppearance preference="system" />)
    expect(window.document.documentElement.classList.contains('dark')).toBe(true)
    act(() => {
      media.matches = false
      changed()
    })
    expect(window.document.documentElement.classList.contains('dark')).toBe(false)
  })
  it('applies explicit account choices and returns to the system mode, without an external font', () => {
    const { rerender } = render(<MatrixAppearance preference="dark" />)
    expect(window.document.documentElement.classList.contains('dark')).toBe(true)
    rerender(<MatrixAppearance preference="light" />)
    expect(window.document.documentElement.classList.contains('dark')).toBe(false)
    rerender(<MatrixAppearance preference="system" />)
    expect(window.document.documentElement.classList.contains('dark')).toBe(false)
    expect(window.document.querySelector('link[data-hermes-theme-font]')).toBeNull()
  })
  it('uses bundled/system typefaces without injecting an external font request', () => {
    render(<MatrixAppearance />)
    expect(window.document.querySelector('link[data-hermes-theme-font]')).toBeNull()
    expect(window.document.documentElement.style.getPropertyValue('--dt-font-mono')).toBe(DEFAULT_TYPOGRAPHY.fontMono)
  })
  it("mixes nothing warm into the palette: the old chain's neutrals are Atum's own seeds", () => {
    const style = window.document.documentElement.style
    const { rerender } = render(<MatrixAppearance preference="light" />)

    expect(style.getPropertyValue('--theme-neutral-card')).toBe(atumTheme.colors.card)
    expect(style.getPropertyValue('--theme-neutral-chrome')).toBe(atumTheme.colors.background)

    rerender(<MatrixAppearance preference="dark" />)
    expect(style.getPropertyValue('--theme-neutral-card')).toBe(atumTheme.darkColors!.card)
    expect(style.getPropertyValue('--theme-neutral-sidebar')).toBe(atumTheme.darkColors!.sidebarBackground)
  })

  it('marks macOS from the bundled module without an inline script', () => {
    applyMatrixMaterial('MacIntel')
    expect(window.document.documentElement.dataset.atumVibrancy).toBe('sidebar')
  })

  it('does not request macOS vibrancy on other platforms', () => {
    applyMatrixMaterial('Linux x86_64')
    expect(window.document.documentElement.dataset.atumVibrancy).toBeUndefined()
  })
})

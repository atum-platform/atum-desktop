import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../shell/titlebar-controls', () => ({
  TitlebarControls: () => <div data-testid="legacy-titlebar-controls" />
}))

const { ProductTitlebarControls } = await import('./product-titlebar-controls')

afterEach(cleanup)

describe('ProductTitlebarControls', () => {
  it('does not render Hermes titlebar controls over the Atum shell', () => {
    render(<ProductTitlebarControls atumShellEnabled onOpenSettings={vi.fn()} />)

    expect(screen.queryByTestId('legacy-titlebar-controls')).toBeNull()
  })

  it('preserves the complete legacy titlebar fallback', () => {
    render(<ProductTitlebarControls atumShellEnabled={false} onOpenSettings={vi.fn()} />)

    expect(screen.getByTestId('legacy-titlebar-controls')).toBeTruthy()
  })
})

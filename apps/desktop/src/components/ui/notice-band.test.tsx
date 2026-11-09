import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrorBanner, NoticeBand } from './error-state'

afterEach(cleanup)

// Three treatments of the same fact had grown side by side before this: the
// gate's band, bare `--atum-danger` paragraphs across the Atum shell, and this
// file's Hermes-tinted box — which reached the Atum shell anyway through the
// group-room dialogs the roster opens. One band now, one class, and the palette
// is chosen by where it renders rather than by a prop.
describe('NoticeBand', () => {
  it('is a contained band with a decorative glyph, not loose coloured text', () => {
    const { container } = render(<NoticeBand role="alert">Could not save that.</NoticeBand>)
    const band = screen.getByRole('alert')

    expect(band.classList.contains('notice-band')).toBe(true)
    expect(band.getAttribute('data-tone')).toBe('failure')
    // The glyph must not reach the accessible name: the copy carries it.
    expect(band.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(band.textContent).toBe('Could not save that.')
    expect(container.querySelector('[class*="text-destructive"]')).toBeNull()
  })

  it('does not announce unless the call site asks it to', () => {
    render(<NoticeBand>Quietly rendered.</NoticeBand>)

    // `role` is deliberately undefaulted — whether a band is worth interrupting
    // for is the call site's judgement, and ErrorBanner's existing consumers
    // never announced.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Quietly rendered.')).toBeTruthy()
  })

  it('drops alarm colour for a condition nobody asked about', () => {
    render(
      <NoticeBand role="status" tone="notice">
        Imported.
      </NoticeBand>
    )

    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('notice')
  })

  // A role="alert" that unmounts between failures is announced unreliably, so
  // the DM connect card parks an empty one and hides it instead.
  it('stays mounted and unpainted when quiet, so the live region survives', () => {
    const { rerender } = render(
      <NoticeBand quiet role="alert">
        {''}
      </NoticeBand>
    )

    const parked = screen.getByRole('alert')

    expect(parked.classList.contains('sr-only')).toBe(true)
    expect(parked.classList.contains('notice-band')).toBe(false)

    rerender(
      <NoticeBand quiet={false} role="alert">
        That could not be opened.
      </NoticeBand>
    )

    expect(screen.getByRole('alert').classList.contains('notice-band')).toBe(true)
  })

  it('keeps ErrorBanner as the same band under its older name', () => {
    const { container } = render(<ErrorBanner className="max-w-sm">Platform error.</ErrorBanner>)
    const band = container.querySelector('.notice-band')!

    expect(band.getAttribute('data-tone')).toBe('failure')
    expect(band.classList.contains('max-w-sm')).toBe(true)
    // Its consumers never announced; adopting the shared band must not start.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

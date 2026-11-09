import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentStatusBar } from './document-status-bar'

describe('DocumentStatusBar', () => {
  afterEach(cleanup)

  it('shows the supplied word count and document-only zoom choices', () => {
    const onZoom = vi.fn()
    render(
      <DocumentStatusBar
        fitWidthLabel="Fit width"
        onZoom={onZoom}
        status="Saved"
        wordCountLabel="182 words"
        zoom={100}
        zoomLabel="Zoom"
      />
    )

    expect(screen.getByText('182 words')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Saved')
    fireEvent.click(screen.getByRole('combobox', { name: 'Zoom' }))
    expect(screen.getByRole('option', { name: 'Fit width' })).toBeTruthy()

    for (const level of [75, 100, 125, 150, 200]) {
      expect(screen.getByRole('option', { name: `${level}%` })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('option', { name: '150%' }))
    expect(onZoom).toHaveBeenCalledWith(150)
  })

  it('returns fit-width as a stable view value', () => {
    const onZoom = vi.fn()
    render(
      <DocumentStatusBar
        fitWidthLabel="Fit width"
        onZoom={onZoom}
        wordCountLabel="0 words"
        zoom={100}
        zoomLabel="Zoom"
      />
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Zoom' }))
    fireEvent.click(screen.getByRole('option', { name: 'Fit width' }))
    expect(onZoom).toHaveBeenCalledWith('fit')
  })
})

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AtumAtom } from '@/components/brand/atum-atom'

import { Loader } from './loader'

afterEach(cleanup)

describe('Loader', () => {
  it('is the Kit spinner, never the atom, and is announced as a status', () => {
    render(<Loader label="Loading chats" />)

    const status = screen.getByRole('status', { name: 'Loading chats' })
    expect(status.querySelector('[data-atum-atom]')).toBeNull()
    expect(status.querySelector('.ak-spinner.ak-spinner--lg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws the small Kit spinner in a row and keeps silent when its words say it', () => {
    const { container } = render(<Loader aria-hidden="true" role="presentation" size="sm" />)

    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('.ak-spinner')).toBeTruthy()
    expect(container.querySelector('.ak-spinner--lg')).toBeNull()
  })

  it('keeps an old curve only where a surface asks for it by name', () => {
    const { container } = render(<Loader type="lemniscate-bloom" />)

    expect(container.querySelector('.ak-spinner')).toBeNull()
    expect(container.querySelector('svg path')).toBeTruthy()
  })
})

describe('AtumAtom', () => {
  it('draws the Kit ring, nucleus and one electron while preserving its status API', () => {
    const { container, rerender } = render(<AtumAtom data-working />)

    const atom = container.querySelector('[data-atum-atom]')
    expect(atom?.getAttribute('aria-hidden')).toBe('true')
    expect(atom?.hasAttribute('data-working')).toBe(true)
    expect(atom?.querySelectorAll('.atum-atom-orbit circle')).toHaveLength(1)
    expect(atom?.querySelectorAll('.atum-atom-nucleus')).toHaveLength(1)
    expect(atom?.querySelectorAll('.atum-atom-track > .atum-atom-electron')).toHaveLength(1)
    expect(atom?.querySelector('ellipse')).toBeNull()

    rerender(<AtumAtom label="Atum is working" />)
    expect(screen.getByRole('status', { name: 'Atum is working' })).toBeTruthy()
  })
})

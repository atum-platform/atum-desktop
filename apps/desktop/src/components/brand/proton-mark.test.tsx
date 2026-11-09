import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PriceTag } from '@/app/atum/price-tag'
import { FREE, UNAVAILABLE } from '@/lib/atum-price'

import { ProtonAmount, ProtonMark } from './proton-mark'

afterEach(cleanup)

const copy = { free: 'Free', protons: (amount: string) => `${amount} Protons`, unavailable: 'Unavailable' }
const format = (amount: number) => new Intl.NumberFormat('en').format(amount)

describe('ProtonMark', () => {
  it('draws in currentColor with no mask ids, so many marks can share a page', () => {
    const { container } = render(<><ProtonMark /><ProtonMark variant="regular" /></>)
    const svgs = Array.from(container.querySelectorAll('svg'))

    expect(svgs.map(svg => svg.getAttribute('data-proton-mark'))).toEqual(['small', 'regular'])
    expect(svgs.every(svg => svg.getAttribute('fill') === 'currentColor')).toBe(true)
    expect(container.querySelector('[id], mask')).toBeNull()
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/iu)
  })

  it('keeps the designed geometries: the 16 px cut and the 64 px cut', () => {
    const { container } = render(<><ProtonMark /><ProtonMark variant="regular" /></>)
    const [small, regular] = Array.from(container.querySelectorAll('rect'))

    expect([small?.getAttribute('width'), small?.getAttribute('rx')]).toEqual(['8', '0'])
    expect([regular?.getAttribute('width'), regular?.getAttribute('rx')]).toEqual(['5.2', '2.6'])
  })

  it('is decorative by default and an image when titled', () => {
    render(<><ProtonMark /><ProtonMark title="Proton" /></>)

    expect(screen.getAllByRole('img', { hidden: false })).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Proton' })).toBeTruthy()
  })
})

describe('ProtonAmount', () => {
  it('reads and copies as the exact phrase: mark, number, hidden word', () => {
    const { container } = render(<ProtonAmount amount="12,400" spoken="12,400 Protons" />)
    const amount = container.querySelector('[data-proton-amount]')!

    expect(amount.textContent).toBe('12,400 Protons')
    expect(amount.querySelector('svg[data-proton-mark]')?.getAttribute('aria-hidden')).toBe('true')
    // The space stays outside the hidden span, so the accessible name keeps it.
    expect(amount.querySelector('.sr-only')?.textContent).toBe('Protons')
  })

  it('falls back to the whole phrase for screen readers when it does not lead with the number', () => {
    const { container } = render(<ProtonAmount amount="4,000" spoken="Protons: 4,000" />)

    expect(container.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe('4,000')
    expect(container.querySelector('.sr-only')?.textContent).toBe('Protons: 4,000')
  })
})

describe('PriceTag', () => {
  it('shows a Protons price with the mark and keeps free and unavailable as words', () => {
    const { container, rerender } = render(<PriceTag copy={copy} formatAmount={format} price={{ amount: 4000, kind: 'protons' }} />)

    expect(container.querySelector('[data-proton-amount]')?.textContent).toBe('4,000 Protons')

    rerender(<PriceTag copy={copy} formatAmount={format} price={FREE} />)
    expect(container.textContent).toBe('Free')
    expect(container.querySelector('svg')).toBeNull()

    rerender(<PriceTag copy={copy} formatAmount={format} price={UNAVAILABLE} />)
    expect(container.textContent).toBe('Unavailable')
  })

  it('fails closed without a Protons formatter, as priceLabel does', () => {
    const { container } = render(<PriceTag copy={{ free: 'Free', unavailable: 'Unavailable' }} formatAmount={format} price={{ amount: 4000, kind: 'protons' }} />)

    expect(container.textContent).toBe('Unavailable')
    expect(container.querySelector('svg')).toBeNull()
  })
})

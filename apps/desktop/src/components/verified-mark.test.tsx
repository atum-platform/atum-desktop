import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { VerifiedMark } from './verified-mark'

function inLocale(locale: 'en' | 'vi', node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

describe('VerifiedMark', () => {
  it('draws a filled check in full ink for an official account, labelled', () => {
    const { container } = inLocale('en', <VerifiedMark tier="official" />)
    const mark = screen.getByRole('img', { name: 'Official Atum account' })

    expect(mark.getAttribute('data-verified-mark')).toBe('official')
    expect(mark.className).toContain('text-(--atum-ink)')
    expect(mark.className).not.toContain('accent')
    const solid = container.querySelector('svg')?.getAttribute('class') ?? ''
    expect(solid).toContain('atum-icon-seal-check')
    expect(solid).toContain('atum-icon-fill')
    // 14 px by default: the roster's and the header's size.
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('size-3.5')
  })

  it('draws a hollow check in muted ink for a verified account or app', () => {
    const { container } = inLocale('en', <VerifiedMark size="md" subject="app" tier="verified" />)
    const mark = screen.getByRole('img', { name: 'Verified' })

    expect(mark.getAttribute('data-verified-mark')).toBe('verified')
    expect(mark.className).toContain('text-(--atum-ink-muted)')
    const glyph = container.querySelector('svg')?.getAttribute('class') ?? ''
    expect(glyph).toContain('atum-icon-seal-check')
    expect(glyph).not.toContain('atum-icon-fill')
    expect(glyph).toContain('size-4')
  })

  it('names an official app as an app, in the window language', () => {
    inLocale('vi', <VerifiedMark subject="app" tier="official" />)
    expect(screen.getByRole('img', { name: 'Ứng dụng chính thức của Atum' })).toBeTruthy()
  })

  it('draws nothing for anything else', () => {
    for (const tier of [null, undefined, 'unverified', 'gold'] as never[]) {
      const { container } = inLocale('en', <VerifiedMark tier={tier} />)
      expect(container.querySelector('[data-verified-mark]')).toBeNull()
      expect(container.textContent).toBe('')
    }
  })

  it('can go without its tip, at 12 px', () => {
    const { container } = inLocale('en', <VerifiedMark size="xs" tier="official" tip={false} />)

    expect(container.querySelector('svg')?.getAttribute('class')).toContain('size-3')
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { AppDescriptor } from '../../../shared/app-catalog'
import { matrixAppCopy } from '../../matrix/app-copy'

import { AppCatalogIdentity, AppCatalogList } from './app-catalog-presentation'

const river: AppDescriptor = {
  app: 'river',
  app_id: '00000000-0000-4000-8000-11e594f48195',
  app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
  name: { en: 'River', vi: 'Sông', ja: 'リバー' },
  subtitle: { en: 'Third provider', vi: 'Nhà cung cấp thứ ba' },
  description: { en: 'Explore the current.', vi: 'Khám phá dòng chảy.' },
  icon: { url: 'https://cdn.atum.test/river.png', sha256: 'a'.repeat(64) },
  accent: '#12A4DE',
  affiliation: 'partner',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 0,
  supported_modes: ['direct'],
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' }
}

describe('AppCatalogIdentity', () => {
  it('draws app and bot art in the shared squircle frame', () => {
    const { container } = render(<AppCatalogIdentity app={river} context="roster" locale="en" />)
    const avatar = container.querySelector('[data-app-catalog-avatar]')!

    expect(avatar.classList.contains('atum-avatar')).toBe(true)
    expect([...avatar.classList].some(name => name.startsWith('ring'))).toBe(false)
  })

  it("keeps a verified partner a partner, and draws its tier in the roster and in detail", () => {
    const partner = { ...river, verification: 'verified' as const }
    const { container, rerender } = render(<AppCatalogIdentity app={partner} context="roster" locale="en" />)

    expect(screen.getByText('River')).toBeTruthy()
    expect(screen.getByText('Explore the current. · Partner')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Verified' }).getAttribute('data-verified-mark')).toBe('verified')

    rerender(<AppCatalogIdentity app={partner} context="detail" locale="en" />)
    expect(screen.getByText('Third provider')).toBeTruthy()
    expect(screen.getByText('Partner')).toBeTruthy()
    expect(container.querySelector('[data-app-catalog-verified="verified"]')).toBeTruthy()
  })

  it("marks Atum's own apps with the filled check and an unverified app with nothing", () => {
    const moon = { ...river, app: 'moon', name: { en: 'Moon' }, affiliation: 'first_party', verification: 'official' as const }
    const andy = { ...moon, app: 'andy', name: { en: 'Andy' } }
    const { container, rerender } = render(<AppCatalogIdentity app={moon} context="roster" locale="en" />)

    expect(screen.getByRole('img', { name: 'Official Atum app' }).getAttribute('data-verified-mark')).toBe('official')

    rerender(<AppCatalogIdentity app={andy} context="detail" locale="en" />)
    expect(container.querySelector('[data-verified-mark="official"]')).toBeTruthy()

    // The legacy flag alone (an older platform) draws no mark, nor does an unverified app.
    for (const app of [river, { ...river, verification: null }]) {
      rerender(<AppCatalogIdentity app={app} context="detail" locale="en" />)
      expect(container.querySelector('[data-verified-mark]')).toBeNull()
    }
  })

  it("labels the mark in the window's language", () => {
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <AppCatalogIdentity app={{ ...river, verification: 'official' }} context="detail" locale="vi" />
      </I18nProvider>
    )
    expect(screen.getByLabelText('Ứng dụng chính thức của Atum')).toBeTruthy()
  })

  it('uses locale copy, falls back to an initial when an image breaks, and does not label unknown affiliation', () => {
    const unknown = { ...river, icon: null, affiliation: 'community' }
    const { container } = render(<AppCatalogIdentity app={unknown} context="detail" locale="vi" />)

    expect(screen.getByText('Sông')).toBeTruthy()
    expect(screen.getByText('Nhà cung cấp thứ ba')).toBeTruthy()
    expect(container.querySelector('[data-app-catalog-affiliation]')).toBeNull()
    expect(container.querySelector('[data-app-catalog-avatar]')?.textContent).toBe('S')
    expect(container.querySelector('[data-app-catalog-avatar]')?.getAttribute('style')).not.toContain(
      'background-color'
    )

    const broken = render(<AppCatalogIdentity app={river} context="detail" locale="en" />)
    fireEvent.error(broken.container.querySelector('img')!)
    expect(broken.container.querySelector('img')).toBeNull()
    expect(broken.container.querySelector('[data-app-catalog-avatar]')?.textContent).toBe('R')
  })
})

describe('AppCatalogList', () => {
  it('keeps selection behavior injected by its caller', () => {
    const onSelect = vi.fn()
    render(<AppCatalogList apps={[river]} locale="en" onSelect={onSelect} selectedAppId={river.app_id} />)

    fireEvent.click(screen.getByRole('button', { name: /river/i }))
    expect(onSelect).toHaveBeenCalledWith(river)
    expect(screen.getByRole('button', { name: /river/i }).getAttribute('aria-current')).toBe('true')
  })
})

describe('matrix app copy', () => {
  it('supplies catalog actions and honest state for every supported locale', () => {
    expect(Object.keys(matrixAppCopy).sort()).toEqual(['en', 'ja', 'vi', 'zh', 'zh-hant'])

    for (const copy of Object.values(matrixAppCopy)) {
      expect(copy.discover).not.toBe('')
      expect(copy.connect).not.toBe('')
      expect(copy.catalogUnavailable).not.toBe('')
      expect(copy.saveUnconfirmed).not.toBe('')
      expect(copy.returnToHost).not.toBe('')
    }
  })
})

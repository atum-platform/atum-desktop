import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import type { MatrixRosterPlaceholder } from './coming-soon-roster'
import { MatrixComingSoonRow } from './roster-coming-soon'
import { MatrixRosterConversations } from './roster-conversations'

const owner = '@owner:test'
const sha = '154c855bc0d19febb5ab42eb883443ce0f51c5c8b6d3f09e75a3af831385b643'

const placeholder: MatrixRosterPlaceholder = {
  app: 'vneid',
  icon: 'https://cdn.atum.test/specialists/vneid.png',
  name: { en: 'VNeID', vi: 'VNeID' }
}

function catalogApp(slug: string, order: number): AppDescriptor {
  return {
    app: slug,
    app_id: `6f1e2a10-9c3d-4a51-8b7e-0d5c2f9a${String(1000 + order)}`,
    app_version_id: `6f1e2a10-9c3d-4a51-8b7e-0d5c2f9a${String(1100 + order)}`,
    name: { en: slug === 'that-space' ? 'Thật Space' : slug, vi: slug },
    subtitle: null,
    description: null,
    icon: { url: `https://cdn.atum.test/specialists/${slug}.png`, sha256: sha },
    accent: null,
    affiliation: null,
    verified: false,
    verification: null,
    availability: 'unavailable',
    roster_default: true,
    roster_order: order,
    roster_state: 'coming_soon',
    supported_modes: [],
    matrix_room_context: null,
    bot: null,
    has_surface: false,
    has_history: false,
    link: { mode: 'none', state: 'never_linked' }
  }
}

function snapshot(): MatrixSnapshot {
  const apps = [
    catalogApp('vneid', 1),
    catalogApp('vssid', 2),
    catalogApp('etax-mobile', 3),
    catalogApp('that-space', 4)
  ]

  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [
      { principal: 'default', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true }
    ],
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    apps: { state: 'ready', apps, connections: {} },
    appShortcuts: Object.fromEntries(
      apps.map(app => [app.app_id, { visibility: 'default' as const, status: 'ready' as const }])
    )
  }
}

describe('coming-soon roster rows', () => {
  it('draws localized catalog copy as disabled text with a grayscale brand tile', () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixComingSoonRow placeholder={placeholder} />
      </I18nProvider>
    )

    const row = container.querySelector('[data-matrix-coming-soon="vneid"]') as HTMLElement
    const image = row.querySelector('img') as HTMLImageElement

    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('VNeID')
    expect(row.textContent).toContain('Coming soon')
    expect(row.querySelector('button')).toBeNull()
    expect(image.className).toContain('grayscale')
    expect(image.getAttribute('src')).toBe(placeholder.icon)

    const vietnamese = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixComingSoonRow placeholder={placeholder} />
      </I18nProvider>
    )

    expect(vietnamese.container.querySelector('[data-matrix-coming-soon="vneid"]')?.textContent).toContain('Sắp ra mắt')
  })

  it('ignores pointer and keyboard activation', () => {
    const onClick = vi.fn()

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixComingSoonRow placeholder={placeholder} />
      </I18nProvider>
    )

    container.addEventListener('click', onClick)

    const row = container.querySelector('[data-matrix-coming-soon="vneid"]') as HTMLElement
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })

    // The click reaches only the inert wrapper; no handler turns it into an action.
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(row.tabIndex).toBe(-1)
    container.removeEventListener('click', onClick)
  })

  it('shows the catalog rows in Vietnamese and never opens, launches or asks for consent', () => {
    const openAssistant = vi.fn()
    const openAgentChat = vi.fn()
    const onOpen = vi.fn()
    const onOpenApp = vi.fn()
    const fail = vi.fn()
    const command = vi.fn()
    window.atumMatrix = { command } as unknown as MatrixUiBridge

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixRosterConversations
          assistantOpening={false}
          fail={fail}
          onOpen={onOpen}
          onOpenApp={onOpenApp}
          openAgentChat={openAgentChat}
          openAssistant={openAssistant}
          snapshot={snapshot()}
        />
      </I18nProvider>
    )

    expect(screen.getAllByText('Sắp ra mắt')).toHaveLength(4)
    expect(container.querySelectorAll('[data-matrix-coming-soon-row]')).toHaveLength(4)

    fireEvent.click(container.querySelector('[data-matrix-coming-soon="vneid"]') as HTMLElement)
    fireEvent.keyDown(container.querySelector('[data-matrix-coming-soon="vneid"]') as HTMLElement, { key: 'Enter' })

    expect(openAssistant).not.toHaveBeenCalled()
    expect(openAgentChat).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onOpenApp).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
  })
})

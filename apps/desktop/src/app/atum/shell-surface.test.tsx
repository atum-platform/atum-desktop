import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { DEFAULT_SURFACES, parseSurfaceSet, type SurfaceState } from '@/store/surfaces'

import type { MatrixDesktopServicesStatus } from '../../../shared/matrix-desktop-services'
import { $matrixDesktopServices } from '../../matrix/desktop-services'
import { MatrixUpdateFooter } from '../../matrix/desktop-settings'

import { AtumNavSwitchSurface } from './shell-surface'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  $matrixDesktopServices.set(null)
  Reflect.deleteProperty(window, 'atumDesktopServices')
})

describe('AtumNavSwitchSurface', () => {
  it.each(['on', 'needs_setup', 'coming_soon', 'needs_update', 'hidden'] as SurfaceState[])(
    'renders the projected %s state with working focus and the appropriate action',
    async state => {
      const onDestinationChange = vi.fn()

      const places = parseSurfaceSet(
        Object.values(DEFAULT_SURFACES).map(row =>
          row.id === 'drive' ? { ...row, state, ...(state === 'hidden' ? { reason: 'retired' } : {}) } : row
        )
      )!

      render(
        <AtumNavSwitchSurface
          ariaLabel="Navigation"
          destination="chat"
          discoverLabel="Discover"
          driveLabel="Drive"
          homeLabel="Home"
          onDestinationChange={onDestinationChange}
          surfaces={places}
          workplaceLabel="Team space"
        />
      )
      const button = screen.queryByRole('button', { name: /^Drive/u })

      if (state === 'hidden') {
        expect(button).toBeNull()

        return
      }

      expect(button!.tabIndex).toBe(0)
      expect((button as HTMLButtonElement).disabled).toBe(false)
      act(() => button!.focus())
      expect(window.document.activeElement).toBe(button)
      fireEvent.click(button!)

      if (state === 'coming_soon' || state === 'needs_update') {
        expect(onDestinationChange).not.toHaveBeenCalled()
        expect(await screen.findByRole('dialog')).toBeTruthy()
        expect(screen.getByText(state === 'coming_soon' ? 'Coming soon' : 'Update required')).toBeTruthy()
        await waitFor(() => expect(window.document.activeElement).toBe(button))
      } else {
        expect(onDestinationChange).toHaveBeenCalledWith('drive')
      }
    }
  )

  it('never adds a second attention mark across surface and updater states', () => {
    window.atumDesktopServices = {
      status: vi.fn(async () => $matrixDesktopServices.get()!),
      setEnabled: vi.fn(async () => $matrixDesktopServices.get()!),
      feedback: vi.fn(async () => ({ sent: true })),
      active: vi.fn(),
      ready: vi.fn(),
      error: vi.fn(),
      setUpdateChannel: vi.fn(async () => true),
      checkUpdates: vi.fn(async () => true),
      restart: vi.fn(async () => true),
      onChanged: vi.fn(() => () => {})
    }

    for (const state of ['on', 'needs_setup', 'coming_soon', 'needs_update', 'hidden'] as SurfaceState[]) {
      for (const update of ['unavailable', 'idle', 'checking', 'downloading', 'downloaded', 'restarting', 'error'] as const) {
        const places = parseSurfaceSet(
          Object.values(DEFAULT_SURFACES).map(row =>
            row.id === 'drive' ? { ...row, state, ...(state === 'hidden' ? { reason: 'retired' } : {}) } : row
          )
        )!

        $matrixDesktopServices.set({
          reporting: { configured: true, diagnosticId: 'surface-test', enabled: false },
          busy: false,
          version: '0.18.3',
          update: { channel: 'latest', progress: null, notes: [], error: null, requiredBelow: null, armed: true, checkedAt: null, packaged: true, state: update, version: '0.18.4' }
        } satisfies MatrixDesktopServicesStatus)

        const rendered = render(
          <I18nProvider configClient={null} initialLocale="en">
            <AtumNavSwitchSurface
              ariaLabel="Navigation"
              destination="chat"
              discoverLabel="Discover"
              driveLabel="Drive"
              homeLabel="Home"
              onDestinationChange={vi.fn()}
              surfaces={places}
            />
            <MatrixUpdateFooter onOpenUpdates={() => {}} />
          </I18nProvider>
        )

        expect(rendered.container.querySelectorAll('.atum-rail-update').length).toBe(['downloaded', 'restarting'].includes(update) ? 1 : 0)
        expect(rendered.container.querySelectorAll('[data-update-attention]').length).toBeLessThanOrEqual(1)
        rendered.unmount()
      }
    }
  })

  it('keeps an unavailable Discover destination visible without dispatching it', () => {
    const onDestinationChange = vi.fn()

    render(
      <AtumNavSwitchSurface
        ariaLabel="Candidate navigation"
        destination="chat"
        disabledDiscoverLabel="Discover is unavailable"
        discoverLabel="Discover"
        homeLabel="Assistant"
        onDestinationChange={onDestinationChange}
        workplaceSoonLabel="Workplace soon"
      />
    )

    const discover = screen.getByRole('button', { name: 'Discover is unavailable' })
    // aria-disabled, never the native attribute: it keeps focus and the hover its tip needs.
    expect((discover as HTMLButtonElement).disabled).toBe(false)
    expect(discover.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(discover)
    expect(onDestinationChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))
    expect(onDestinationChange).toHaveBeenCalledWith('chat')
  })

  it('keeps Workplace disabled unless the owning shell explicitly enables it', () => {
    const onDestinationChange = vi.fn()

    const { rerender } = render(
      <AtumNavSwitchSurface
        ariaLabel="Candidate navigation"
        destination="chat"
        discoverLabel="Discover"
        homeLabel="Assistant"
        onDestinationChange={onDestinationChange}
        workplaceSoonLabel="Workplace soon"
      />
    )

    const unavailable = screen.getByRole('button', { name: 'Workplace soon' })
    expect((unavailable as HTMLButtonElement).disabled).toBe(false)
    expect(unavailable.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(unavailable)
    fireEvent.keyDown(unavailable, { key: 'Enter' })
    expect(onDestinationChange).not.toHaveBeenCalled()

    rerender(
      <AtumNavSwitchSurface
        ariaLabel="Candidate navigation"
        destination="chat"
        discoverLabel="Discover"
        homeLabel="Assistant"
        onDestinationChange={onDestinationChange}
        workplaceAvailable
        workplaceLabel="Workplace"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Workplace' }))
    expect(onDestinationChange).toHaveBeenCalledWith('workplace')
  })

  it('orders the rail Home, Discover, Drive, then Workplace on its own below the divider', () => {
    const { container } = render(
      <AtumNavSwitchSurface
        ariaLabel="Navigation"
        destination="chat"
        discoverLabel="Discover"
        driveLabel="Atum Drive"
        homeLabel="Assistant"
        onDestinationChange={vi.fn()}
        workplaceAvailable
        workplaceLabel="Workplace"
      />
    )

    const nav = container.querySelector('nav')!

    const sequence = Array.from(nav.querySelectorAll('button, .atum-nav-divider')).map(node =>
      node.classList.contains('atum-nav-divider') ? '|' : node.getAttribute('aria-label')
    )

    expect(sequence).toEqual(['Assistant', 'Discover', 'Atum Drive', '|', 'Workplace'])
  })

  it('draws no dead end: an unavailable Workplace without a coming-soon label is not on the rail', () => {
    const { container } = render(
      <AtumNavSwitchSurface
        ariaLabel="Navigation"
        destination="chat"
        discoverLabel="Discover"
        driveLabel="Atum Drive"
        homeLabel="Assistant"
        onDestinationChange={vi.fn()}
        workplaceLabel="Workplace"
      />
    )

    expect(screen.queryByRole('button', { name: 'Workplace' })).toBeNull()
    // The divider only separates Workplace; without it there is nothing to divide.
    expect(container.querySelector('.atum-nav-divider')).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Assistant',
      'Discover',
      'Atum Drive'
    ])
  })

  it('keeps a coming-soon place in the tab order with its tip, and never marks it current', async () => {
    render(
      <AtumNavSwitchSurface
        ariaLabel="Navigation"
        destination="workplace"
        disabledDiscoverLabel="Store unavailable"
        discoverLabel="Store"
        homeLabel="Assistant"
        onDestinationChange={vi.fn()}
        workplaceLabel="Workplace"
        workplaceSoonLabel="Team space · Coming soon"
      />
    )

    const soon = screen.getByRole('button', { name: 'Team space · Coming soon' })
    expect(soon.getAttribute('aria-current')).toBeNull()
    expect(soon.tabIndex).toBe(0)
    act(() => soon.focus())
    expect(window.document.activeElement).toBe(soon)
    // The pointer reaches it (a native `disabled` button gets no pointer events), so its tip shows.
    fireEvent.pointerMove(soon, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toBe('Team space · Coming soon')

    expect(screen.getByRole('button', { name: 'Store unavailable' }).tabIndex).toBe(0)
  })
})

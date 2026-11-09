import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWalletState } from '../../shared/matrix-wallet'

import { scenarioSnapshot } from './playground/fixtures'
import { MatrixRailAccount } from './rail-account'
import { type MatrixSettingsPane, MatrixSettingsSheet } from './settings-sheet'

afterEach(cleanup)

const wallet: MatrixWalletState = {
  state: 'ready',
  wallet: {
    unit: 'micro_proton',
    balances: { available: 1_200_000_000, paid: 1_200_000_000, earned: 0, promo: 0, held: 0 },
    allowance: null,
    checkoutOpen: false
  }
}

function wrap(node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )
}

describe('the account menu', () => {
  it("offers the phone feature's entry, and a Protons row without a balance once a wallet exists", () => {
    const onOpen = vi.fn()
    const onOpenSettings = vi.fn()
    const onOpenProtons = vi.fn()

    wrap(
      <MatrixRailAccount
        balance={wallet}
        fail={() => {}}
        onOpenChange={() => {}}
        onOpenProtons={onOpenProtons}
        onOpenSettings={onOpenSettings}
        open
        phone={{ icon: <span />, label: 'Use on phone', onOpen }}
        snapshot={scenarioSnapshot('chat')}
      />
    )

    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Use on phone' }))
    expect(onOpen).toHaveBeenCalledOnce()
    const protons = within(menu).getByRole('menuitem', { name: /Protons/ })
    expect(protons.textContent).not.toContain('1,200')
    expect(menu.querySelector('[data-matrix-balance]')).toBeNull()
    fireEvent.click(protons)
    expect(onOpenProtons).toHaveBeenCalledOnce()
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it('puts the top-up beside the Protons row', () => {
    const onTopUp = vi.fn()
    const onOpenProtons = vi.fn()

    wrap(
      <MatrixRailAccount
        balance={wallet}
        fail={() => {}}
        onOpenChange={() => {}}
        onOpenProtons={onOpenProtons}
        onOpenSettings={() => {}}
        onTopUp={onTopUp}
        open
        snapshot={scenarioSnapshot('chat')}
      />
    )

    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Top up' }))
    expect(onTopUp).toHaveBeenCalledOnce()
    expect(onOpenProtons).not.toHaveBeenCalled()
  })

  it('has neither while their providers are missing', () => {
    wrap(
      <MatrixRailAccount
        fail={() => {}}
        onOpenChange={() => {}}
        onOpenSettings={() => {}}
        open
        snapshot={scenarioSnapshot('chat')}
      />
    )

    const menu = screen.getByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: 'Use on phone' })).toBeNull()
    expect(menu.querySelector('[data-matrix-balance]')).toBeNull()
  })

  it('keeps your rail face free of status dots and says trouble with the button', () => {
    const closed = (snapshot: ReturnType<typeof scenarioSnapshot>) =>
      wrap(
        <MatrixRailAccount fail={() => {}} onOpenChange={() => {}} onOpenSettings={() => {}} open={false} snapshot={snapshot} />
      )

    const healthy = closed(scenarioSnapshot('chat'))
    const quiet = screen.getByRole('button', { name: /^Account: / })
    expect(healthy.container.querySelector('.atum-rail-account-dot')).toBeNull()
    expect(quiet.getAttribute('aria-describedby')).toBeNull()
    healthy.unmount()

    const offline = closed({ ...scenarioSnapshot('chat'), state: 'offline' })
    expect(offline.container.querySelector('.atum-rail-account-dot')).toBeNull()
    expect(screen.getByRole('button', { name: /^Account: /, description: 'Offline · reconnecting' })).toBeTruthy()
  })
})

describe('Settings', () => {
  function sheet(pane: MatrixSettingsPane, extra: Partial<React.ComponentProps<typeof MatrixSettingsSheet>> = {}) {
    const onClose = vi.fn()
    const onPaneChange = vi.fn()

    wrap(
      <MatrixSettingsSheet
        fail={() => {}}
        onClose={onClose}
        onPaneChange={onPaneChange}
        open
        pane={pane}
        // No identity: this is about the slots, not the security panes.
        snapshot={{ ...scenarioSnapshot('chat'), identity: null }}
        {...extra}
      />
    )

    return { onClose, onPaneChange }
  }

  it('keeps Protons in How Atum answers with honest provider and empty states', () => {
    const { onPaneChange } = sheet('protons', { protons: { data: wallet, onLoadMore: () => {} } })

    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy()
    expect(screen.getByText('1,200 left · used for Atum’s built-in models and the Store')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /General/ }))
    expect(onPaneChange).toHaveBeenCalledWith('general')
    cleanup()

    sheet('protons')
    // The destination is stable; without a provider it says why no balance is shown.
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Account' }).getAttribute('aria-current')).toBe('page')
    expect(window.document.querySelector('[data-matrix-settings-section="protons"]')).toBeNull()
    expect(screen.getByText('Proton balance and activity will appear here when the wallet is available.')).toBeTruthy()
    expect(screen.queryByText('Available to spend')).toBeNull()
    expect(window.document.querySelector('[data-matrix-balance]')).toBeNull()
  })

  it('keeps the phone out of Privacy & Security: it has one home, in the account menu', () => {
    sheet('privacy')
    expect(screen.queryByRole('button', { name: 'Use on phone' })).toBeNull()
  })

  it('does not mount the removed local-permissions checklist in Settings', () => {
    const status = vi.fn(async () => ({
      platform: 'unsupported' as const,
      permissions: {
        accessibility: 'unknown' as const,
        screen: 'unknown' as const,
        microphone: 'unknown' as const,
        automation: 'unknown' as const,
        files: 'unknown' as const,
        fullDisk: 'unknown' as const,
        location: 'unknown' as const
      }
    }))

    const previous = window.atumMatrix
    window.atumMatrix = { ...previous, permissions: { status, openSettings: vi.fn() } }

    try {
      sheet('account')
      expect(status).not.toHaveBeenCalled()
      cleanup()
      sheet('devices', { open: false })
      expect(status).not.toHaveBeenCalled()
      cleanup()
      sheet('devices')
      expect(status).not.toHaveBeenCalled()
      cleanup()
      fireEvent.focus(window)
      expect(status).not.toHaveBeenCalled()
    } finally {
      window.atumMatrix = previous
    }
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { I18nProvider } from '@/i18n'
import type { AtumAccountStatus } from '@/lib/atum-account-client'
import { reconcileApprovalModeForProfile } from '@/store/approval-mode'
import { $atumAccountStatus } from '@/store/atum-messaging'
import { $gateway } from '@/store/gateway'

import { AccountInteractionPermissions } from './account-interaction-permissions'

const PREFIX_A = 'plugin_rule:atum:aaaaaaaaaaaaaaaa:'
const PREFIX_B = 'plugin_rule:atum:bbbbbbbbbbbbbbbb:'
const initialStatus = $atumAccountStatus.get()

function accountStatus(accountId: string, consentRulePrefix: string | undefined): AtumAccountStatus {
  return {
    state: 'signed_in',
    configured: true,
    account: { id: accountId },
    current: consentRulePrefix
      ? { authority: 'supabase', accountId, sessionGeneration: 3, expiresAt: null, consentRulePrefix }
      : { authority: 'supabase', accountId, sessionGeneration: 3, expiresAt: null },
    errorCode: null,
    providers: { google: true, password: false }
  } as AtumAccountStatus
}

function mockGateway(entriesByPrefix: Record<string, unknown[]>) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'approval.allowlist.list') {
      return { entries: entriesByPrefix[String(params?.prefix)] ?? [] }
    }

    return { removed: true }
  })

  $gateway.set({ request } as unknown as HermesGateway)

  return request
}

function renderPage() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AccountInteractionPermissions />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $gateway.set(null)
  $atumAccountStatus.set(initialStatus)
})

describe('AccountInteractionPermissions', () => {
  it("lists the current account's durable Hermes consents and revokes one through the gateway", async () => {
    $atumAccountStatus.set(accountStatus('user-a', PREFIX_A))

    const request = mockGateway({
      [PREFIX_A]: [
        `${PREFIX_A}browser`,
        `${PREFIX_A}computer.control`,
        // Another account's consent and malformed entries are never shown.
        `${PREFIX_B}browser`,
        `${PREFIX_A}not-a-consent`,
        'recursive delete',
        42
      ]
    })

    renderPage()

    expect(await screen.findByText('Browse and search the web')).toBeTruthy()
    expect(screen.getByText('Control your apps')).toBeTruthy()
    expect(screen.queryByText('See your screen')).toBeNull()
    expect(screen.getAllByText('Always allowed')).toHaveLength(2)
    expect(document.body.textContent?.includes('bbbbbbbbbbbbbbbb')).toBe(false)
    expect(document.body.textContent?.includes('recursive delete')).toBe(false)
    expect(request).toHaveBeenCalledWith('approval.allowlist.list', { prefix: PREFIX_A })

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('approval.allowlist.remove', { pattern_key: `${PREFIX_A}browser` })
    )
    await waitFor(() => expect(screen.queryByText('Browse and search the web')).toBeNull())
    expect(screen.getByText('Control your apps')).toBeTruthy()
  })

  it('rebinds to the new account on a live A→B switch and never revokes under the old prefix', async () => {
    $atumAccountStatus.set(accountStatus('user-a', PREFIX_A))
    const request = mockGateway({ [PREFIX_A]: [`${PREFIX_A}browser`], [PREFIX_B]: [`${PREFIX_B}computer.observe`] })

    renderPage()
    expect(await screen.findByText('Browse and search the web')).toBeTruthy()

    $atumAccountStatus.set(accountStatus('user-b', PREFIX_B))

    expect(await screen.findByText('See your screen')).toBeTruthy()
    expect(screen.queryByText('Browse and search the web')).toBeNull()
    expect(request).toHaveBeenCalledWith('approval.allowlist.list', { prefix: PREFIX_B })

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('approval.allowlist.remove', { pattern_key: `${PREFIX_B}computer.observe` })
    )
    expect(request).not.toHaveBeenCalledWith('approval.allowlist.remove', expect.objectContaining({ pattern_key: `${PREFIX_A}browser` }))
  })

  it('says so when approvals are off for the active profile, and hides the note otherwise', async () => {
    $atumAccountStatus.set(accountStatus('user-a', PREFIX_A))
    mockGateway({ [PREFIX_A]: [] })
    reconcileApprovalModeForProfile('default', 'off')

    renderPage()

    expect(await screen.findByText(/Approvals are off: Atum acts without asking/)).toBeTruthy()
    cleanup()

    reconcileApprovalModeForProfile('default', 'smart')
    renderPage()
    expect(await screen.findByText('No saved permissions yet. Atum asks the first time it needs one.')).toBeTruthy()
    expect(screen.queryByText(/Approvals are off/)).toBeNull()
  })

  it('shows the empty state when nothing has been allowed yet', async () => {
    $atumAccountStatus.set(accountStatus('user-a', PREFIX_A))
    mockGateway({ [PREFIX_A]: [] })

    renderPage()

    expect(await screen.findByText('No saved permissions yet. Atum asks the first time it needs one.')).toBeTruthy()
  })

  it('shows the empty state without a signed-in account and never queries the gateway', async () => {
    $atumAccountStatus.set(accountStatus('user-a', undefined))
    const request = mockGateway({ [PREFIX_A]: [`${PREFIX_A}browser`] })

    renderPage()

    expect(await screen.findByText('No saved permissions yet. Atum asks the first time it needs one.')).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a failure when the gateway is unavailable or the query fails', async () => {
    $atumAccountStatus.set(accountStatus('user-a', PREFIX_A))
    $gateway.set(null)

    renderPage()

    expect(await screen.findByRole('alert')).toBeTruthy()
    cleanup()

    const request = vi.fn(async () => {
      throw new Error('offline')
    })

    $gateway.set({ request } as unknown as HermesGateway)

    renderPage()

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

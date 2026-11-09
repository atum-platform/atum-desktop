import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { CompanyDesktopAdapter } from './company-desktop-adapter'
import { CompanyWalletDrawer } from './company-wallet'
import { companyFundProtons } from './company-wallet-fund'
import { playgroundCompanyDesktopAdapter } from './playground/company-ai-fixtures'
import { TEAM_COMPANY_ID } from './playground/team-space-fixtures'

function install(adapter: CompanyDesktopAdapter) {
  ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop: adapter }

  return adapter
}

function open(locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <CompanyWalletDrawer companyId={TEAM_COMPANY_ID} onClose={vi.fn()} />
    </I18nProvider>
  )
}

async function enter(amount: string, cta = 'Continue') {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Protons to move' }), { target: { value: amount } })
  fireEvent.click(screen.getByRole('button', { name: cta }))
}

afterEach(() => {
  delete (window as unknown as { atumMatrix?: unknown }).atumMatrix
})

describe('companyFundProtons', () => {
  it('takes whole Protons from 1 to 1,000,000 only', () => {
    expect(companyFundProtons(' 40 ')).toBe(40)
    expect(companyFundProtons('1000000')).toBe(1_000_000)

    for (const text of ['', '0', '-5', '1.5', '1e3', '1,000', '1000001', '040', 'abc']) {
      expect(companyFundProtons(text), text).toBeNull()
    }
  })
})

describe('Nạp từ ví của bạn', () => {
  it('confirms the exact debit, then moves it once and shows the new company balance', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    const fund = vi.spyOn(adapter, 'fundFromMember')
    open()

    await enter('40')
    expect(screen.getByText('40 Protons will leave your wallet for the company.')).toBeTruthy()
    expect(fund).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Moved 40 Protons to the company.')).toBeTruthy()
    expect(fund).toHaveBeenCalledTimes(1)
    expect(fund.mock.calls[0]![0]).toBe(TEAM_COMPANY_ID)
    expect(fund.mock.calls[0]![1]).toEqual({ schemaVersion: 2, requestId: expect.any(String), protons: 40 })
    expect(screen.getByText('Available').parentElement?.textContent).toContain('485,040')
  })

  it('refuses an invalid amount inline without calling the platform', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    const fund = vi.spyOn(adapter, 'fundFromMember')
    open()

    await enter('1.5')
    expect((await screen.findByRole('alert')).textContent).toBe('Enter whole Protons, from 1 to 1,000,000.')
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(fund).not.toHaveBeenCalled()
  })

  it('shows a short wallet inline and returns to editing', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    vi.spyOn(adapter, 'fundFromMember').mockRejectedValueOnce(new Error('insufficient_protons'))
    open()

    await enter('500')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Your wallet doesn’t have enough Protons.')
    expect(screen.getByRole('textbox', { name: 'Protons to move' })).toBeTruthy()
    expect(screen.getByText('Available').parentElement?.textContent).toContain('485,000')
  })

  it('retries an unconfirmed transfer with the same request ID and offers no Cancel', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    const fund = vi.spyOn(adapter, 'fundFromMember').mockRejectedValueOnce(new Error('unavailable'))
    open()

    await enter('7')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The transfer wasn’t confirmed. Try again.')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Protons to move' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText('Moved 7 Protons to the company.')
    expect(fund).toHaveBeenCalledTimes(2)
    expect(fund.mock.calls[1]![1].requestId).toBe(fund.mock.calls[0]![1].requestId)
  })

  it('an answer it cannot check is an unknown outcome: the request ID is kept', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    const real = adapter.fundFromMember.bind(adapter)

    const fund = vi
      .spyOn(adapter, 'fundFromMember')
      .mockImplementationOnce(async (companyId, request) => ({ ...(await real(companyId, request)), protons: 8 }))

    open()

    await enter('7')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The transfer wasn’t confirmed. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(fund).toHaveBeenCalledTimes(2))
    expect(fund.mock.calls[1]![1].requestId).toBe(fund.mock.calls[0]![1].requestId)
  })

  it('closing and reopening the wallet recovers the unresolved transfer from native', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    let journal: { requestId: string; protons: number } | null = null

    const fund = vi.spyOn(adapter, 'fundFromMember').mockImplementationOnce(async (_companyId, request) => {
      journal = { requestId: request.requestId, protons: request.protons }
      throw new Error('unavailable')
    })

    vi.spyOn(adapter, 'readPendingFund').mockImplementation(async () => ({ pending: journal }))
    const first = open()

    await enter('9')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByRole('alert')
    first.unmount()

    open()
    expect(await screen.findByText('Your 9-Proton transfer isn’t confirmed yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText('Moved 9 Protons to the company.')
    expect(fund).toHaveBeenCalledTimes(2)
    expect(fund.mock.calls[1]![1]).toEqual({ schemaVersion: 2, requestId: journal!.requestId, protons: 9 })
  })

  it('a new transfer after cancelling gets a new request ID', async () => {
    const adapter = install(playgroundCompanyDesktopAdapter())
    const fund = vi.spyOn(adapter, 'fundFromMember')
    open()

    await enter('3')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fund).not.toHaveBeenCalled()
    await enter('3')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Moved 3 Protons to the company.')
    await enter('3')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fund).toHaveBeenCalledTimes(2))
    expect(fund.mock.calls[1]![1].requestId).not.toBe(fund.mock.calls[0]![1].requestId)
  })

  it('speaks Vietnamese in the Vietnamese app', async () => {
    install(playgroundCompanyDesktopAdapter())
    open('vi')

    expect(await screen.findByText('Nạp từ ví của bạn')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Số Proton chuyển' }), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }))
    expect(screen.getByText('Trừ 40 Proton từ ví của bạn để nạp cho công ty.')).toBeTruthy()
  })
})
